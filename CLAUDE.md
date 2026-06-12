# asu-athletics-schedule — Claude Code Context

## Project Summary

Self-hosted ASU Sun Devil Athletics schedule web app running at **asu.dikaiaserver.com** on the Ubuntu VM (10.10.1.19, port 3000). Pulls event data nightly from the official ASU feed and auto-inserts postseason/NCAA tournament games from ESPN. Serves a filterable calendar, list view, geocoded map, and live score feed. Node.js + Express backend with SQLite event cache and vanilla JS frontend.

## Environment

- **Host**: Ubuntu VM at 10.10.1.19, port 3000
- **Project root**: `~/projects/asu-athletics-schedule/`
- **Secrets** (two files, both load-bearing — do not consolidate without an ops change):
  - `~/projects/secrets.env` — CF_API_TOKEN / CF_ACCOUNT_ID; loaded by systemd (`EnvironmentFile=` in asu-cal.service)
  - `~/projects/unifi-scripts/secrets.env` — VAPID_* push keys; loaded as a fallback by `lib/env.js`
- **DB**: `events.db` (SQLite, gitignored)
- **Service**: `asu-cal.service` systemd unit
- **Live URL**: https://asu.dikaiaserver.com
- **Verification knobs**: `PORT=3100 DISABLE_SCHEDULER=1 node server.js` runs a second instance against the live DB without cron jobs / double-pushes (never hit `/api/refresh` or `/api/geocode` on it)

## Project Structure

```
asu-athletics-schedule/
├── server.js          ← Express server, thin API routes
├── fetcher.js         ← Nightly data fetch from sundevils.com feed
├── geocoder.js        ← Venue geocoding (GeoLite2 mmdb, gitignored)
├── scheduler.js       ← Cron jobs (eager-requires push: broken push = boot failure)
├── scores.js          ← ESPN scoreboard polling + schedule/score sync
├── db.js              ← SQLite helpers
├── push.js            ← Web push notifications
├── lib/
│   ├── env.js           ← secrets fallback loader (documents the two-file system)
│   ├── constants.js     ← USER_AGENT, NCAA_USER_AGENT, SITE_HOST/ORIGIN
│   ├── sports-config.js ← single source for sport slugs/configs/emoji/TOURNAMENT_RE
│   ├── opponent.js      ← opponentFromTitle(title, {lowercase, fallback})
│   ├── cache.js         ← TtlCache (evict-on-read TTL cache)
│   ├── ical.js          ← buildIcsCalendar for /api/events.ics
│   ├── ncaa.js          ← NCAA bracket scraping/GraphQL + ESPN matching + caches
│   └── tournaments.js   ← bracket/series/pool tournament builders
├── scripts/           ← Utility scripts
└── public/            ← Frontend (FullCalendar, Leaflet, vanilla JS — no build step)
    ├── shared.js        ← loaded FIRST: esc/shortTitle/sportColor/logo maps + `store` localStorage wrapper
    ├── filters.js       ← filter sidebar state, view switching, event modal
    ├── game-modal.js    ← ESPN box-score modal (lazy-invoked via window.openGameDetailModal)
    ├── calendar.js / live.js / map.js / pwa.js / whats-new.js / feedback.js
    └── sw.js            ← service worker; bump CACHE_NAME whenever index.html changes
```

**Frontend cache busting**: scripts load via `?v=N` query params in index.html. When you
change a frontend file, bump its `?v=` AND bump `CACHE_NAME` in sw.js if index.html changed
(`/` is precached cache-first; the controllerchange handler auto-reloads clients).

## Rules

- Always use the secrets.env files for credentials — never hardcode (see Environment for which file holds what)
- `GeoLite2-City.mmdb` is gitignored (64MB binary) — lives only on the server
- `events.db` is gitignored — do not commit
- Restart service after code changes: `sudo systemctl restart asu-cal`
- Check logs: `journalctl -u asu-cal -n 50`

## Agent Collaboration Rules

- **Read History First**: At the start of every session, the agent MUST run `git status` and `git log -n 5` to understand recent changes, and read the `## Active Handoff` section in this file.
- **Commit with Context**: Every commit message must explain the *why* behind a change, not just the *what*.
- **The Handoff Journal**: Before concluding a session or completing a major task, the active agent MUST update the `## Active Handoff` section at the bottom of this file.
- **Interactive Dry Runs**: The agent must always perform a dry run and list planned changes for user approval before modifying code, databases, or configuration files.
- **Explicit Task Tracking**: Maintain a shared checklist of tasks in `task.md` or `CLAUDE.md`. Mark tasks as `[x]` for complete, `[/]` for in-progress, and `[ ]` for pending.

## Active Handoff

- [2026-06-06 (Claude Code)]: Added agent collaboration rules and initialized handoff log.
- [2026-06-11 (Claude Code)]: Full-sweep behavior-preserving refactor, 8 commits (0da1fc1..HEAD).
  Backend: new `lib/` modules (env, constants, opponent, sports-config, cache, ical, ncaa,
  tournaments); server.js 787→~490 lines, scores.js 880→~550, fetchLiveGames decomposed with
  side-effect order preserved; scheduler now fails fast if push module is broken; dead
  getNextGame() removed. Frontend: new public/shared.js (dedup of esc/shortTitle/sportColor/
  ESPN_LOGO_MAP + `store` localStorage wrapper) and public/game-modal.js (box score modal out
  of filters.js, 905→~500 lines); live.js renders decomposed (output verified byte-identical
  via vm harness); duplicate spin keyframes removed. Bumps: shared v1, filters v17, game-modal
  v1, live v25, map v3, pwa v5, style v5, SW cache asu-cal-v6. Verified per phase on
  PORT=3100 DISABLE_SCHEDULER=1 against /tmp/asu-refactor-baseline (events/ics byte-identical).
  Browser smoke test on a real device (esp. iOS PWA) still recommended: all tabs, both
  modals, bell menu persistence, SW update to asu-cal-v6.
- [2026-06-11 (Claude Code)]: VAPID keys copied into ~/projects/secrets.env (systemd now
  provides them directly; verified served public key matches). lib/env.js fallback to
  ~/projects/unifi-scripts/secrets.env is now a pure safety net. Backup at
  ~/projects/secrets.env.bak-2026-06-11.
- [2026-06-12 (Claude Code)]: Feature roadmap phase 1 shipped: conference standings +
  poll rank badges. New lib/standings.js (ESPN standings/rankings fetch, 1h/6h TtlCaches
  with 5-min negative cache, non-blocking getRankIndexSync so cold caches never stall
  /api/live or /api/events) and public/standings.js (collapsible Live-tab widget, sport
  pills persisted in store). STANDINGS_CONFIG/RANKINGS_SLUGS in lib/sports-config.js —
  group IDs are per-league; baseball/volleyball conference tables live on a child group
  (group=26 child 44, group=90 child 51); softball/soccer have no ESPN standings; women's
  soccer rankings use soccer/usa.ncaa.w.1 (NOT the summary slug). Rank badges merged
  server-side: game.oppRank/asuRank in /api/live, event.opp_rank in /api/events (future
  events only, 24h lookback). Fixed latent SW bug: /api/game was cache-first-forever, now
  NETWORK_ONLY. Bumps: shared v2, standings v1 (new), filters v18, game-modal v2,
  calendar v13, live v26, style v6, SW asu-cal-v7. Verified via curl + headless-chromium
  smoke test on :3100 and on prod after restart. Approved roadmap for later phases:
  phase 2 = play-by-play tab in game modal (ESPN summary already ships plays/scoringPlays,
  currently ignored) + head-to-head from local DB; phase 3 = My Sports favorites, dark
  mode, TV/ticket links on list cards; phase 4 = ESPN team news strip + rosters. Full plan:
  ~/.claude/plans/review-the-dashboard-and-typed-otter.md. Pre-existing harmless 404 noticed:
  fullcalendar index.global.min.css doesn't exist on jsdelivr (v6 injects styles via JS).
