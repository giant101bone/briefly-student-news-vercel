'use strict';

const express = require('express');
const Parser = require('rss-parser');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// Vercel Functions have a read-only deployment filesystem; /tmp is writable but ephemeral.
const DATA_DIR = process.env.VERCEL ? path.join('/tmp', 'briefly-student-news') : path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'articles.json');
const parser = new Parser({
  timeout: 18000,
  headers: { 'User-Agent': 'BrieflyStudentNews/2.0 (student-focused multi-publisher RSS reader)' }
});

// Google News RSS search is used as a no-key discovery source. Each result links out to its publisher.
// Google News RSS and publisher metadata availability can vary; the UI reports failures transparently.
const FEED_DEFS = [
  { key: 'economics', label: 'Economics & commerce', locale: 'en-IN', country: 'IN', query: '(economy OR inflation OR GDP OR central bank OR RBI OR budget OR trade OR business OR commerce) when:30d' },
  { key: 'india', label: 'India & public policy', locale: 'en-IN', country: 'IN', query: '(India OR Indian) (policy OR government OR Parliament OR Supreme Court OR RBI OR Union Budget OR economy OR education) when:30d' },
  { key: 'science', label: 'Science & research', locale: 'en-IN', country: 'IN', query: '(science OR scientific research OR research paper OR discovery OR space OR ISRO OR climate OR energy) when:30d' },
  { key: 'technology', label: 'Technology & AI', locale: 'en-US', country: 'US', query: '(artificial intelligence OR semiconductor OR cybersecurity OR robotics OR technology policy) when:30d' },
  { key: 'world', label: 'World affairs', locale: 'en-US', country: 'US', query: '(international relations OR global economy OR conflict OR election OR climate policy OR public health) when:30d' }
];
const FEEDS = Object.fromEntries(FEED_DEFS.map(d => [d.key, makeFeedUrl(d.query, d.locale, d.country)]));

let articleCache = [];
let lastSuccess = null;
let lastAttempt = null;
let refreshInProgress = false;
let lastRefreshError = null;
let feedStatus = {};
let cacheLoaded = false;

function makeFeedUrl(query, locale = 'en-IN', country = 'IN') {
  const u = new URL('https://news.google.com/rss/search');
  u.searchParams.set('q', query);
  u.searchParams.set('hl', locale);
  u.searchParams.set('gl', country);
  u.searchParams.set('ceid', `${country}:${locale.endsWith('-IN') ? 'en' : 'en'}`);
  return u.toString();
}
function stripHtml(input = '') {
  return String(input)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
}
function cleanPublisherName(value = '') {
  const name = stripHtml(value).replace(/\s+/g, ' ').trim();
  return name && !/^google news$/i.test(name) ? name : (name || 'Publisher not identified');
}
function makeArticle(item, category) {
  const url = String(item.link || item.guid || '').trim();
  let title = stripHtml(item.title || '');
  if (!url || !title) return null;
  const sourceField = item.source;
  const rawSource = sourceField && typeof sourceField === 'object' ? (sourceField._ || sourceField['#text'] || '') :
    (typeof sourceField === 'string' ? sourceField : '');
  let sourceName = rawSource ? cleanPublisherName(rawSource) : '';
  let sourceUrl = sourceField && typeof sourceField === 'object' ? (sourceField.$?.url || sourceField.url || '') : '';
  if (!sourceUrl) {
    // Google News often appends the publisher name to the end of a title.
    const dash = title.match(/\s[-–|]\s([^|–-]{2,70})$/);
    if (dash) {
      if (!sourceName) sourceName = cleanPublisherName(dash[1]);
      title = title.slice(0, dash.index).trim();
    }
  } else if (sourceName) {
    const escaped = sourceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    title = title.replace(new RegExp(`\\s[-–|]\\s${escaped}$`, 'i'), '').trim();
  }
  if (!sourceName) sourceName = 'Publisher not identified';
  const digest = crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);
  const dateMs = Date.parse(item.isoDate || item.pubDate || '') || Date.now();
  const cleanSummary = stripHtml(item.contentSnippet || item.summary || item.content || '');
  let domain = '';
  try { domain = new URL(sourceUrl).hostname.replace(/^www\./, '').toLowerCase(); } catch { /* keep domain empty */ }
  return {
    id: `article-${digest}`, cat: category, title, source: sourceName, sourceUrl,
    sourceDomain: domain, date: dateMs,
    summary: cleanSummary.slice(0, 600),
    url, provider: 'Google News RSS'
  };
}
async function saveCache() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload = { articles: articleCache, lastSuccess, feedStatus, savedAt: new Date().toISOString() };
  const tmpFile = `${CACHE_FILE}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tmpFile, CACHE_FILE);
}
async function loadCache() {
  try {
    const data = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
    articleCache = Array.isArray(data.articles) ? data.articles : [];
    lastSuccess = data.lastSuccess || null;
    feedStatus = data.feedStatus || {};
    console.log(`Loaded ${articleCache.length} cached publisher articles.`);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not read article cache:', error.message);
  }
  cacheLoaded = true;
}
async function ensureFreshData() {
  if (!cacheLoaded) await loadCache();
  const successMs = lastSuccess ? Date.parse(lastSuccess) : 0;
  if (!articleCache.length || !successMs || Date.now() - successMs >= REFRESH_INTERVAL_MS) {
    await refreshFeeds();
  }
}
async function refreshFeeds({ force = false } = {}) {
  if (refreshInProgress) return { alreadyRunning: true };
  const lastSuccessMs = lastSuccess ? Date.parse(lastSuccess) : 0;
  if (!force && lastSuccessMs && Date.now() - lastSuccessMs < REFRESH_INTERVAL_MS) {
    return { skipped: true, reason: 'The cache is still fresh.' };
  }
  refreshInProgress = true;
  lastAttempt = new Date().toISOString();
  console.log(`[${lastAttempt}] Refreshing Google News RSS searches…`);
  try {
    const results = await Promise.allSettled(Object.entries(FEEDS).map(async ([category, url]) => {
      const response = await fetch(url, { headers: { 'User-Agent': 'BrieflyStudentNews/2.0 RSS reader' }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = await parser.parseString(await response.text());
      const items = (parsed.items || []).slice(0, 60).map(item => makeArticle(item, category)).filter(Boolean);
      return { category, items };
    }));
    const successes = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const failures = results.map((r, i) => ({ r, category: Object.keys(FEEDS)[i] })).filter(x => x.r.status === 'rejected');
    feedStatus = { ...feedStatus };
    successes.forEach(s => { feedStatus[s.category] = { ok: true, count: s.items.length, checkedAt: lastAttempt, error: null }; });
    failures.forEach(f => { feedStatus[f.category] = { ok: false, checkedAt: lastAttempt, error: String(f.r.reason?.message || 'Feed request failed') }; });
    if (!successes.length) throw new Error('Every RSS feed failed. Existing cached stories were kept.');

    // Refresh only categories that succeeded, retaining previous cached stories for failed categories.
    const successfulCategories = new Set(successes.map(s => s.category));
    const kept = articleCache.filter(a => !successfulCategories.has(a.cat));
    const fresh = successes.flatMap(s => s.items);
    const byUrl = new Map();
    for (const item of [...kept, ...fresh]) {
      const prior = byUrl.get(item.url);
      if (!prior) byUrl.set(item.url, { ...item, categories: [...new Set([...(item.categories || []), item.cat])] });
      else {
        prior.categories = [...new Set([...(prior.categories || [prior.cat]), ...(item.categories || []), item.cat])];
        if (Number(item.date) > Number(prior.date)) { prior.date = item.date; prior.title = item.title || prior.title; prior.summary = item.summary || prior.summary; }
        if ((!prior.sourceUrl || !prior.sourceDomain) && item.sourceUrl) { prior.sourceUrl = item.sourceUrl; prior.sourceDomain = item.sourceDomain; prior.source = item.source || prior.source; }
      }
    }
    articleCache = [...byUrl.values()].sort((a, b) => Number(b.date) - Number(a.date)).slice(0, 350);
    lastSuccess = new Date().toISOString();
    lastRefreshError = failures.length ? `Some feeds could not refresh: ${failures.map(f => f.category).join(', ')}` : null;
    await saveCache();
    console.log(`Feed refresh: ${articleCache.length} articles; ${successes.length}/${Object.keys(FEEDS).length} searches succeeded.`);
    return { articles: articleCache.length, successfulFeeds: successes.length, failedFeeds: failures.length };
  } catch (error) {
    lastRefreshError = error.message || String(error);
    console.error('RSS refresh failed:', lastRefreshError);
    return { error: lastRefreshError };
  } finally { refreshInProgress = false; }
}

const STOP_WORDS = new Set(('a an and are as at be been being by for from had has have he her hers him his how i in into is it its of on or our out she that the their them then there these they this to was we were what when where which who will with would you your after before over under about says said new latest more than says today yesterday report reports according amid amid one two three').split(' '));
const ALIASES = [
  [/\breserve bank of india\b/g, 'rbi'], [/\bartificial intelligence\b/g, 'ai'], [/\bunited states\b/g, 'us'], [/\bunited kingdom\b/g, 'uk'],
  [/\bgovernment\b/g, 'govt'], [/\bminister\b/g, 'ministry'], [/\bministerial\b/g, 'ministry'], [/\bcentre\b/g, 'central'], [/\bcenter\b/g, 'central'],
  [/\b(?:keeps|leaves|holds|maintains|held|unchanged)\b/g, 'holdsteady'],
  [/\b(?:hikes|raises|increases|raised|increased|increase)\b/g, 'increase'],
  [/\b(?:cuts|reduces|lowers|reduced|decreased|falls|drops|declines|fell|dropped)\b/g, 'decrease']
];
function titleTokens(value = '') {
  let text = stripHtml(value).toLowerCase();
  ALIASES.forEach(([re, replacement]) => { text = text.replace(re, replacement); });
  return new Set(text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t.length > 2 && !STOP_WORDS.has(t)));
}
function tokenSimilarity(a, b) {
  const contradictory = [['increase', 'decrease'], ['increase', 'holdsteady'], ['decrease', 'holdsteady']];
  if (contradictory.some(([x, y]) => (a.has(x) && b.has(y)) || (a.has(y) && b.has(x)))) return null;
  const intersection = [...a].filter(t => b.has(t)).length;
  if (!intersection) return 0;
  const jaccard = intersection / (a.size + b.size - intersection);
  const overlap = intersection / Math.min(a.size, b.size);
  return { intersection, jaccard, overlap };
}
function categoryForGroup(group) {
  const count = new Map();
  group.forEach(a => { for (const cat of (Array.isArray(a.categories) && a.categories.length ? a.categories : [a.cat])) count.set(cat, (count.get(cat) || 0) + 1); });
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || 'world';
}
function whyItMatters(title, cat) {
  const t = title.toLowerCase();
  if (/inflation|interest rate|rbi|central bank|gdp|budget|tax|trade|tariff|market|bank|econom|jobs|employment|business/.test(t)) return 'Economic decisions can affect prices, jobs, businesses, investment or household finances. Check the linked reporting for the specific effects.';
  if (/election|parliament|government|policy|court|law|regulation|minister|bill|supreme court/.test(t)) return 'This may affect public policy, rights, institutions or how government decisions are made. Read the original announcement or ruling where available.';
  if (/research|study|scientist|discovery|journal|paper|experiment|clinical|university/.test(t)) return 'This may help students understand new evidence or scientific debate. Check the original paper and its limitations before treating a finding as settled.';
  if (/climate|energy|carbon|emission|heat|renewable|environment/.test(t)) return 'This connects to climate, energy or environmental decisions with potential scientific, social or economic implications.';
  if (/artificial intelligence|\bai\b|semiconductor|cyber|robot|software|technology|chip/.test(t)) return 'This may be relevant to technology, innovation, education or the future of work. Look for technical details and independent confirmation.';
  if (cat === 'economics') return 'Follow this development to better understand markets, businesses, public finances or the wider economy.';
  if (cat === 'science') return 'Follow the evidence, the source study, and whether the result has been independently confirmed.';
  if (cat === 'india') return 'This relates to India’s institutions, society, economy or public policy. Check primary documents where available.';
  if (cat === 'technology') return 'This may affect how technology is developed, used or governed. Look for concrete evidence beyond announcements.';
  return 'This may help students understand a wider political, social, scientific or economic development. Compare the linked reports for context.';
}
function impactSignals(title, cat) {
  const t = title.toLowerCase();
  const sets = [
    { score: 15, re: /war|invasion|ceasefire|conflict|disaster|earthquake|cyclone|flood|pandemic|outbreak|emergency|crash|major ruling|historic/ },
    { score: 12, re: /budget|rbi|central bank|interest rate|inflation|gdp|election|supreme court|parliament|law|policy|regulation|trade deal|tariff|sanction|treaty|government|minister/ },
    { score: 10, re: /research|study|scientist|discovery|clinical trial|space|isro|climate|energy|artificial intelligence|semiconductor|cybersecurity|education|employment/ },
    { score: 5, re: /report|data|forecast|launch|investigation|agreement|university|company|industry/ }
  ];
  let score = 0;
  for (const set of sets) if (set.re.test(t)) score += set.score;
  if (cat === 'science' && /research|study|scientist|discovery|paper/.test(t)) score += 5;
  return Math.min(40, score);
}
function buildStories(input) {
  const articles = (input || []).filter(a => a && a.title && a.url).map(a => ({
    ...a,
    date: typeof a.date === 'number' ? a.date : (Date.parse(a.date) || Date.now()),
    source: cleanPublisherName(a.source || ''),
    sourceDomain: a.sourceDomain || (() => { try { return a.sourceUrl ? new URL(a.sourceUrl).hostname.replace(/^www\./, '').toLowerCase() : ''; } catch { return ''; } })()
  }));
  const tokens = articles.map(a => titleTokens(a.title));
  const parent = articles.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  // Headline similarity grouping is intentionally transparent/local; it can miss semantically related headlines with very different wording.
  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      if (articles[i].url === articles[j].url) { union(i, j); continue; }
      if (Math.abs(Number(articles[i].date) - Number(articles[j].date)) > 8 * 86400000) continue;
      const sim = tokenSimilarity(tokens[i], tokens[j]);
      if (sim && sim.intersection >= 3 && (sim.jaccard >= 0.34 || sim.overlap >= 0.60)) union(i, j);
    }
  }
  const groups = new Map();
  articles.forEach((a, i) => { const root = find(i); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(a); });
  const stories = [];
  for (const group of groups.values()) {
    const deduped = [...new Map(group.map(a => [a.url, a])).values()].sort((a, b) => b.date - a.date);
    const titleArticle = [...deduped].sort((a, b) => (b.title?.length || 0) - (a.title?.length || 0))[0];
    const cat = categoryForGroup(deduped);
    const uniquePublishers = new Map();
    for (const a of deduped) {
      const key = a.sourceDomain || a.source.toLowerCase();
      if (!uniquePublishers.has(key)) uniquePublishers.set(key, a);
    }
    const publisherArticles = [...uniquePublishers.values()].sort((a, b) => b.date - a.date);
    const ageDays = Math.max(0, (Date.now() - Math.max(...deduped.map(a => a.date))) / 86400000);
    const freshness = Math.max(0, 25 - ageDays * 4);
    const coverage = Math.min(30, 6 + Math.max(0, uniquePublishers.size - 1) * 9);
    const impact = impactSignals(deduped.map(a => a.title).join(' '), cat);
    const priority = Math.min(100, Math.round(impact + freshness + coverage + (uniquePublishers.size >= 3 ? 5 : 0)));
    const stableId = crypto.createHash('sha256').update([...deduped.map(a => a.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).sort()].join('|')).digest('hex').slice(0, 18);
    const summaries = deduped.map(a => a.summary || '').filter(s => s.length > 45).sort((a, b) => b.length - a.length);
    stories.push({
      id: `story-${stableId}`, title: titleArticle.title, cat, date: Math.max(...deduped.map(a => a.date)),
      sourceCount: uniquePublishers.size, articleCount: deduped.length, priority, impactScore: impact,
      whyItMatters: whyItMatters(titleArticle.title, cat),
      summary: summaries[0] || '',
      sources: publisherArticles.slice(0, 8).map(a => ({ id: a.id, title: a.title, source: a.source, domain: a.sourceDomain, sourceUrl: a.sourceUrl, url: a.url, date: a.date, summary: a.summary })),
      categories: [...new Set(deduped.flatMap(a => Array.isArray(a.categories) && a.categories.length ? a.categories : [a.cat]))]
    });
  }
  return stories.sort((a, b) => b.priority - a.priority || b.date - a.date);
}

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.get('/api/health', async (_req, res) => {
  await ensureFreshData();
  res.set('Cache-Control', 'no-store');
  res.json({
  ok: true, provider: 'Google News RSS', mode: 'multi-publisher RSS discovery + local headline grouping and heuristic ranking',
  articleCount: articleCache.length, storyCount: buildStories(articleCache).length,
  lastSuccess, lastAttempt, refreshing: refreshInProgress, lastRefreshError, feedStatus
  });
});
app.get('/api/articles', async (_req, res) => {
  await ensureFreshData();
  res.set('Cache-Control', 'no-store');
  res.json({ articles: articleCache, lastSuccess, lastAttempt, refreshing: refreshInProgress, lastRefreshError, feedStatus });
});
app.get('/api/stories', async (req, res) => {
  await ensureFreshData();
  const sort = String(req.query.sort || 'important');
  const category = String(req.query.category || 'all');
  const days = Number(req.query.days || 0);
  const since = days > 0 ? Date.now() - days * 86400000 : 0;
  let stories = buildStories(articleCache);
  if (category !== 'all') stories = stories.filter(s => s.cat === category || s.categories.includes(category));
  if (since) stories = stories.filter(s => s.date >= since);
  if (sort === 'newest') stories.sort((a, b) => b.date - a.date);
  else if (sort === 'trending') stories.sort((a, b) => b.sourceCount - a.sourceCount || b.priority - a.priority || b.date - a.date);
  // Engagement sort is not available unless sources provide verifiable metrics; no invented counts are returned.
  res.set('Cache-Control', 'no-store');
  res.json({ stories, articleCount: articleCache.length, lastSuccess, lastAttempt, refreshing: refreshInProgress, lastRefreshError, feedStatus, provider: 'Google News RSS' });
});
function makeDateFilter(selectedDate) {
  if (!selectedDate) return 'when:7d';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) throw new Error('Date must use YYYY-MM-DD format.');
  const start = new Date(`${selectedDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== selectedDate) throw new Error('Choose a valid calendar date.');
  const next = new Date(start); next.setUTCDate(next.getUTCDate() + 1);
  return `after:${selectedDate} before:${next.toISOString().slice(0, 10)}`;
}
app.get('/api/search', async (req, res) => {
  const term = typeof req.query.q === 'string' ? req.query.q.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  if (!term) return res.status(400).json({ error: 'Enter a topic to search.' });
  const selectedDate = typeof req.query.date === 'string' ? req.query.date : '';
  let dateFilter;
  try { dateFilter = makeDateFilter(selectedDate); } catch (error) { return res.status(400).json({ error: error.message }); }
  const url = makeFeedUrl(`${term} ${dateFilter}`, 'en-IN', 'IN');
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'BrieflyStudentNews/2.0 topic search' }, signal: AbortSignal.timeout(18000) });
    if (!response.ok) throw new Error(`Google News RSS returned HTTP ${response.status}`);
    const parsed = await parser.parseString(await response.text());
    const articles = (parsed.items || []).slice(0, 60).map(item => makeArticle(item, 'search')).filter(Boolean);
    res.set('Cache-Control', 'no-store');
    res.json({ query: term, date: selectedDate || null, provider: 'Google News RSS', articles, stories: buildStories(articles) });
  } catch (error) {
    console.warn(`Topic search failed for "${term}":`, error.message);
    res.status(502).json({ error: 'Could not retrieve live topic-search results. No demo stories were substituted.' });
  }
});
app.post('/api/refresh', async (_req, res) => {
  const lastAttemptMs = lastAttempt ? Date.parse(lastAttempt) : 0;
  if (refreshInProgress) return res.status(202).json({ ok: true, refreshing: true, articles: articleCache.length, lastSuccess });
  if (lastAttemptMs && Date.now() - lastAttemptMs < 60 * 1000) return res.status(429).json({ ok: false, message: 'Please wait a minute before requesting another manual refresh.', lastSuccess });
  const result = await refreshFeeds({ force: true });
  if (result.error && articleCache.length === 0) return res.status(502).json({ ok: false, ...result, articles: 0 });
  res.json({ ok: !result.error, ...result, articles: articleCache.length, lastSuccess });
});
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('*', (req, res, next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

async function start() {
  await loadCache();
  const server = app.listen(PORT, HOST, () => console.log(`Briefly running at http://localhost:${PORT}`));
  refreshFeeds().catch(error => console.error('Initial refresh error:', error));
  setInterval(() => refreshFeeds().catch(error => console.error('Scheduled refresh error:', error)), REFRESH_INTERVAL_MS).unref();
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

// Vercel imports the Express app as a serverless function. Locally, `npm start`
// still runs the persistent server and its 15-minute refresh timer.
module.exports = app;
if (require.main === module) {
  start().catch(error => { console.error('Could not start Briefly:', error); process.exit(1); });
}
