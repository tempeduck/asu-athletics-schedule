# ASU Sun Devil Athletics Schedule

A self-hosted web app that pulls ASU athletics event data nightly and serves a filterable calendar, list view, map, and live score feed. Postseason and NCAA tournament games are auto-inserted from ESPN when they aren't in the official feed.

**Live site:** https://asu.dikaiaserver.com

---

## Features

### Views
- **Month calendar** (FullCalendar) with per-sport color coding and live score overlays
- **List view** — grouped by date, scrolls to today, shows scores for completed games
- **Map view** — Leaflet map of away and neutral-site venues with geocoded coordinates
- **Live view** — real-time score cards for in-progress games, countdown to next game, season W/L record, NCAA tournament bracket

### Filters
- Sport, game type (home / away / neutral), region, state, date range (collapsible)
- All filters persist across view changes; clear-all button

### Live Scores
- ESPN scoreboard polled every 30 s during active games
- Sport-specific detail: baseball inning/outs/base runners, football down/distance/possession, basketball half/clock
- Auto-updates completed game scores and results in SQLite
- Postseason / NCAA games not in the sundevils.com feed are **auto-inserted** from the ESPN live scoreboard with full venue data (city, state, location name)

### NCAA Tournament Bracket
- Detects active ASU postseason tournaments from the live scoreboard
- Fetches round/series structure from NCAA and ESPN summary APIs
- Renders bracket or series view in the live panel with real-time scores

### Calendar & Scheduling
- **ICS export** — subscribe to the schedule in Apple Calendar, Google Calendar, or Outlook via `/api/events.ics`; Subscribe button in the header copies the URL
- Nightly data refresh at 2 AM via built-in node-cron scheduler
- Manual refresh button triggers an immediate fetch + geocode pass

### Analytics (`/stats`)
- Dark-themed dashboard backed by the **Cloudflare Web Analytics beacon** (RUM)
- Scoped to `asu.dikaiaserver.com` only — excludes API calls, assets, and other subdomains
- Page views over time (SVG bar chart), 7 / 30 / 90-day selector
- Devices donut, top pages, countries with auto-generated flag emoji, browsers, referrers
- 10-minute server-side cache; data from Cloudflare GraphQL `rumPageloadEventsAdaptiveGroups`

### UX Details
- Times displayed in the **browser's local timezone** (not hardcoded MST/Phoenix)
- TBD games show "TBD" instead of a wrong converted time
- Opponent logos from ESPN CDN as fallback when the feed doesn't provide one
- Feedback widget (thumbs + text) with admin review page
- Toast notifications for load events and refresh

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 18+ |
| Web framework | Express 4 |
| Database | SQLite via better-sqlite3 |
| Scheduling | node-cron |
| HTTP client | node-fetch |
| Security | helmet, express-rate-limit |
| Frontend | Vanilla JS + FullCalendar 6 + Leaflet |
| Data sources | sundevils.com feed · ESPN scoreboard & summary APIs · NCAA bracket API |
| Analytics | Cloudflare Web Analytics (RUM beacon + GraphQL API) |

---

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/events` | All events. Params: `sport`, `game_type`, `city`, `state`, `region`, `from`, `to`, `season` |
| GET | `/api/events.ics` | iCalendar feed. Params: `sport`, `season`, `game_type` |
| GET | `/api/sports` | Distinct sport list |
| GET | `/api/seasons` | Distinct season list |
| GET | `/api/locations` | Distinct city/state pairs |
| GET | `/api/live` | Live scores, next game, season records, tournament brackets |
| GET | `/api/game/:id` | ESPN game summary proxy (box score, play-by-play) |
| GET | `/api/ncaa/config` | NCAA bracket persisted query SHAs |
| GET | `/api/ncaa/asu-section` | ASU's regional section ID in the active tournament |
| GET | `/api/ncaa/bracket/:sectionId` | Section bracket with ESPN event IDs cross-referenced |
| GET | `/api/cf-stats?days=N` | Cloudflare RUM analytics (7 / 30 / 90 days) |
| POST | `/api/refresh` | Trigger a data fetch (rate-limited: 5/hr) |
| POST | `/api/geocode` | Geocode events missing lat/lng via Nominatim |
| POST | `/api/feedback` | Submit feedback |

---

## Self-Hosting

### Prerequisites

- Node.js 18 or later
- npm

### Install

```bash
git clone https://github.com/robertscheib/asu-athletics-schedule.git
cd asu-athletics-schedule
npm install
node server.js
# → http://0.0.0.0:3000
```

`events.db` is created automatically. Events are fetched on startup if the DB is empty, then nightly at 2 AM.

### Environment variables

Required only for the `/stats` analytics dashboard:

```env
CF_API_TOKEN=<Cloudflare token: Zone:Analytics:Read + Account:Analytics:Read>
CF_ACCOUNT_ID=<Cloudflare account ID>
```

### systemd

```ini
[Unit]
Description=ASU Sun Devil Athletics Calendar
After=network.target

[Service]
EnvironmentFile=/path/to/secrets.env
Type=simple
User=youruser
WorkingDirectory=/path/to/asu-athletics-schedule
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now asu-cal
```

### Reverse proxy

The app listens on port 3000 over HTTP. Terminate TLS upstream (Nginx Proxy Manager, Caddy, nginx).

### Analytics setup

1. In the Cloudflare dashboard, add the site to **Web Analytics** and paste the `<script>` beacon tag into `public/index.html` (already done for the reference deployment).
2. Create an API token with **Zone → Analytics → Read** and **Account → Analytics → Read**. Set `CF_API_TOKEN` and `CF_ACCOUNT_ID` in `secrets.env` and restart the service.
3. Optionally protect `/stats` with **Cloudflare Zero Trust → Access → Applications → Self-hosted** (path: `/stats`). No auth code needed in the app.

---

## Project Structure

```
server.js          Express app, thin API routes
db.js              SQLite schema, queries, upsert helpers, migrations
fetcher.js         sundevils.com feed parser and DB writer
scores.js          ESPN scoreboard polling, score sync, postseason auto-insert
push.js            Web push notification senders
geocoder.js        Nominatim geocoder for away/neutral venues
scheduler.js       node-cron nightly fetch + score sync jobs
lib/
  env.js           Secrets fallback loader
  constants.js     User-agent strings, site host/origin
  sports-config.js Sport slugs, team configs, emoji map, tournament regex
  opponent.js      Opponent-name extraction from event titles
  cache.js         TTL cache used by server/ncaa modules
  ical.js          iCalendar (.ics) feed builder
  ncaa.js          NCAA bracket scraping + ESPN event matching
  tournaments.js   Bracket/series/pool tournament builders
public/
  index.html       Single-page shell + Cloudflare Web Analytics beacon
  shared.js        Shared utils/constants + localStorage wrapper (loaded first)
  calendar.js      FullCalendar integration, list view
  filters.js       Filter sidebar state, view switching, event modal
  game-modal.js    ESPN box-score modal
  live.js          Live score polling, game cards, bracket renderer
  map.js           Leaflet map view
  pwa.js           Install banner, push subscription, bell menus
  stats.html       Self-contained analytics dashboard (Cloudflare RUM)
  style.css        Styles (Barlow Condensed + DM Sans, ASU palette)
  feedback.css     Feedback widget styles
  feedback.js      Feedback submission widget
asu-cal.service    systemd unit file reference
```

---

## License

MIT
