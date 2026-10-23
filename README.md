# Briefly — Student News Briefing

Briefly is a student-focused news briefing prototype. Its goal is to show a manageable number of important developments, group related headlines together, and link out to coverage from different publishers.

## What this version does

- Fetches multi-publisher search results using Google News RSS feeds for economics/commerce, India/public policy, science/research, technology/AI, and world affairs.
- Groups headlines by local word-overlap similarity so similar article results appear under one story card.
- Shows available article links and publisher names inside the grouped story card.
- Ranks stories using three visible signals: headline impact keywords, freshness, and distinct publisher count.
- Shows a short rules-based "why it may matter" note, alongside the linked reporting.
- Supports topic search, a selected publication date, subject filters, date filtering for loaded stories, sorting, bookmarks, and read/unread state in the current browser.
- Local mode uses an on-disk JSON cache and refreshes feeds on start and every 15 minutes while the Node.js server is running. On Vercel, cache files are placed under `/tmp` (ephemeral), and the API refreshes feeds on demand if the cache is missing or older than 15 minutes.
- Does not substitute fake/sample stories if feeds fail. It displays an unavailable/empty state instead.

## Important limitations

- **This is a transparent prototype, not a human-edited news desk or AI fact-checker.** Ranking is a deterministic heuristic based on headline keywords, freshness, and how many distinct publisher domains are available. It can rank a story incorrectly or miss an event whose headlines use very different wording.
- **Story grouping is lexical, not semantic.** Two reports about the same event can be missed; two similarly worded reports about different events can occasionally be grouped incorrectly. Review the output before using this as a public editorial product.
- Google News RSS is used as a no-key discovery feed. Feed contents, publisher metadata, redirects, historical indexing, request limits, and access may change or fail. This is not a guaranteed commercial news API or complete archive.
- The main topic feeds currently query the most recent 30 days (with a capped number of returned results per feed). Use topic search with a selected date to try finding a past date; historical availability depends on Google News indexing. A custom date range filters stories currently loaded and cached; it does not guarantee that missing historical articles will be fetched.
- Engagement counts (views, likes, comments) are not available reliably in the feeds. The interface explicitly falls back to the importance sort rather than inventing metrics.
- The rules-based "why it may matter" copy is a general study-context prompt, not a verified summary of the specific article.
- Browser bookmarks and read/unread status are stored in local browser storage; they are not synced between devices/users.
- The background refresh runs only while the server process is running. The host must support Node.js and must not sleep/stop the process if you need regular polling.
- The standalone HTML tries browser-side feed access through a public CORS proxy. That proxy is best-effort and can fail. Use the Node.js project for the preferred setup.

## Requirements

- Node.js 20 or later
- Internet access from your server to Google News RSS

## Run locally

From this folder:

```bash
npm install
npm start
```

Open <http://localhost:3000>.

Useful endpoints:

- `/api/health` — feed health and last-refresh status
- `/api/stories` — grouped and ranked story cards
- `/api/articles` — cached publisher articles
- `/api/search?q=RBI` — grouped topic search
- `/api/search?q=RBI&date=2026-10-20` — attempt a historical one-day search
- `POST /api/refresh` — request a manual feed refresh (throttled to reduce feed load)

## Files

- `server.js` — RSS collection, cache, story grouping/ranking, API
- `public/index.html` — responsive UI; it also attempts best-effort browser-side RSS access when no Node backend is available
- `data/articles.json` — created automatically after a successful feed refresh

## Deploy to Vercel

This project includes a Vercel-compatible Express entrypoint (`index.js`). To publish:

1. Put the contents of this folder in a GitHub repository.
2. In Vercel, select **Add New → Project** and import that repository.
3. Keep the project root set to this folder. Vercel should detect the Express/Node.js app automatically; no build command is needed. If prompted, use `npm install` as the install command.
4. Deploy, then open the generated URL and check `/api/health` to see whether the live RSS feeds can be retrieved.

**Vercel-specific limitations:** Vercel Functions have a read-only deployment filesystem except for temporary `/tmp` storage. The `/tmp` cache can disappear or differ between instances, so it is not a durable database. The app therefore fetches feeds on demand when its in-memory/temporary cache is empty or older than 15 minutes. It cannot guarantee a background refresh every 15 minutes when nobody visits. Vercel Hobby Cron Jobs are limited to once per day, so a true 15-minute scheduled updater would require a suitable paid schedule and/or persistent database. For durable shared caching, add a hosted database/cache such as Vercel Postgres or a Redis-compatible store.

The app still depends on Google News RSS availability. Deployment success does not guarantee every source feed will respond; check `/api/health` after deploying. No demo stories are substituted if live feeds fail.
# briefly-student-news-vercel
