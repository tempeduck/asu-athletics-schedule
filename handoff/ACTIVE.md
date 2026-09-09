# Active Handoff

**Completed-game stats [2026-09-08 (GPT-5 Codex)]:** Approved implementation
is committed locally as `6c917e3` and remains undeployed. The `events` migration now
adds `espn_event_id`; every final-score reconciliation records it, including
games whose score was already correct, so the nightly season sync backfills
matched historical feed events. Calendar, list, and map event details now use
that retained ID (or an existing `espn_<id>` row) to open the ESPN final-game
modal after the game leaves the 24-hour live feed. The modal retains its
linescore, player-stat tabs, scoring/play data, and final status. Frontend
assets were cache-busted (`filters.js` v25, SW cache v26). Passed syntax and
diff checks, `scripts/verify-game-summary.cjs`, the fixture-backed
`scripts/verify-gamecast.cjs`, and a Chromium check against a real completed
baseball summary confirming final-event Batting and Pitching tabs. The local
temporary server was stopped. The unrelated untracked Docker-transition note
remains untouched.

**v1.5.0 SHIPPED [2026-09-06 (GPT-6)]:** Committed Gamecast as `d0070fd`, merged
the deployed v1.4.1 hotfix ancestry in `f349366`, and atomically pushed main and
the annotated v1.5.0 tag. Production deployed that tag with `npm ci`, passed
syntax/cache/concurrency checks, and restarted successfully. Both application and
tunnel services are active; production checkout is clean at `f349366`. Public
verification confirms version 1.5.0, SW cache v25, modal asset v7, summary HTTP 200,
`no-store`, and the 60/min live rate limit. A mobile production browser rendered
24 drives for the now-final football game without JavaScript errors. Five-second
polling was verified using a recorded live summary in the production browser.
Evidence: `handoff/gamecast/production-verification.json` and
`handoff/gamecast/football-prod-mobile.png`. Startup logged one venue geocode miss;
Gamecast verification passed. The existing untracked Docker-transition note was
left untouched and excluded from commits.

**v1.5.0 release preparation [2026-09-06 (GPT-6)]:** Robert explicitly approved
commit, push, and production deployment. Preparing main and the v1.5.0 release
tag with Gamecast, 5-second live updates, and the existing committed TV-alert and
mobile-layout changes. The deployed v1.4.1 hotfix is retained in release ancestry.
Backend cache/concurrency and eight-sport browser checks passed. Production was
clean and active on v1.4.1 at preflight; deployment verification follows below.
The unrelated untracked `handoff/DOCKER_TRANSITION.md` is excluded.

**Faster Gamecast updates [2026-09-06 (GPT-6)]:** Robert requested faster updates.
Live modal polling is now 5 seconds; upcoming games and error retries use 30
seconds, with final/closed/hidden behavior preserved. ESPN's summary response
advertised `Cache-Control: max-age=4` during inspection; this supports a practical
5-second target, not a guaranteed upstream publication latency or documented
maximum supported request rate. New `lib/game-summary.js` provides shared
in-flight requests and bounded caches (live 5s, upcoming 30s, final 5min).
The game route now uses the live rate limiter (60/min instead of the general
100/15min) and returns `Cache-Control: no-store`. Backend concurrency/cache/error
tests and the eight-sport browser suite passed. Dev service restarted; no new
commit, tag, push, or production deployment. Modal asset v7; SW cache v25.

**Gamecast implementation [2026-09-05 (GPT-6)]:** Robert approved building the
Gamecast-style view. Implemented locally as v1.5.0 with football field/drive/play
detail, shared play-by-play for basketball/baseball/softball, available ASU
win-probability charts, and 30-second modal refresh with cancellation, error
recovery, visibility pause, and reading-position preservation. Eight real ESPN
game samples passed Chromium validation, including 320/390px layouts and dark
theme screenshots. Syntax and diff checks passed. Development service restarted
with `DISABLE_SCHEDULER=1`; production remains v1.4.1. Feature changes are
uncommitted and have not been deployed. Full coverage, evidence links, validation,
screenshots, and release notes: `handoff/gamecast/REVIEW.md`. Regression runner:
`scripts/verify-gamecast.cjs` (shared screenshot-tool Playwright, no DB access).

**Gamecast API investigation [2026-09-05 (GPT-6)]:** Read-only inspection of
ESPN's college-football summary endpoint for event `401856774` returned HTTP 200
without credentials. Payload includes team/player box scores, scoring plays,
current and previous drives with individual plays and start/end field positions,
win-probability history, and video entries. Existing `/api/game/:espnEventId`
already proxies the full summary (30-second cache for active games); the modal
renders box scores and scoring plays but fetches only when opened. A Gamecast-style
view could use existing data for drive/play lists, field position, win probability,
and periodic refresh. No feature implementation requested or performed.

**Missing live football diagnosis [2026-09-05 (GPT-6)]:** Production `/api/live`
omits the in-progress Morgan State–ASU football game (ESPN event `401856774`).
`scores.js:153` requests ESPN's bare football `/scoreboard`, whose current response
does not include ASU. Read-only comparisons confirmed that `?limit=1000` alone
still omits ASU, while `?groups=80` includes the game with status `in`.
The team schedule also confirms the game is in progress. Proposed fix: explicitly
request the broader football group in `fetchLiveScoreboard`, validate inclusion
through the live and background-score paths, then promote to production with
approval. No application code or production configuration changed; implementation
and deployment were subsequently approved by Robert (see follow-up below).

**Football hotfix [2026-09-05 (GPT-6)]:** Robert approved implementation and
deployment. `fetchLiveScoreboard` now requests `?groups=80` for college football;
other sports retain their existing URLs. Syntax and diff checks passed. An isolated
validation using real ESPN data and stubbed database writes confirmed the game
appears as live and the background poller records its score. A separate request
check confirmed the soccer URL is unchanged. Release `v1.4.1` (`912f216`) was built
from production's `v1.4.0`, containing only the football fix and release metadata,
and pushed. Deployed on production with `npm ci` and service restart; service is
active. Public `/api/version` confirms `1.4.1`, and `/api/live` returns event
`401856774`, matched to database event `347146`, as live (ASU 21–0, 6:15 first
quarter at verification). Local main contains the same
changes uncommitted; the release commit is on the hotfix tag, not main. Existing
untracked `handoff/DOCKER_TRANSITION.md` was left untouched.

> Full dated history (roadmap phases 1–4, the big refactor, the Oracle migration) archived in `CHANGELOG-handoff.md`.

**Current state (2026-07-01, Claude Code):** Full codebase audit complete — findings and the
6-group fix plan live in `docs/audit-2026-07-01.md` (tick items there as they land).
**Groups 1–2 applied on dev and verified, not yet committed.**
Group 1 (security/config): trust proxy via TRUST_PROXY_HOPS (per-IP rate limiting now works),
ADMIN_TOKEN auth on `/api/admin/*` (fail-closed, admin page prompts for token), feedback `page`
whitelist + escaping (stored-XSS fix), push endpoint validation, generic error bodies, from/to
NaN clamp, sw.js v14 (`/api/admin` network-only).
Group 2 (live path): soccer fully fixed (dead ESPN slugs → `usa.ncaa.w.1`, and dbSport key now
matches the feed's bare `'Soccer'` tag; men's entry removed — no ASU program); `fetchLiveGames`
15s cache + single-flight + parallel sweep (cold 1.2s→0.28s, cached 5ms); tournament summary/pool
fetches cached 60s + parallel; `findDBMatch` hardened (espn_id first, opponent-verified lone
match, doubleheader nearest-time) with a passing 7-case synthetic test.
Group 3 (SW + frontend caching): all `/api/` GETs network-first by default (frozen-API bug
fixed; behavioral stub-test of routing passed), `/admin/`+`/stats` network-only, offline
fallback shapes fixed, feedback.js/css versioned, `typeof Notification` guards (iOS Safari
tab crash), live.js→v30 pwa.js→v6, CACHE_NAME v14. Headless smoke render OK; still needs a
real-device pass (iPhone Safari tab + installed-PWA v13→v14 update flow).
Group 4 (push lifecycle): 30-day subscription purge removed (410-at-send is the only cleanup),
client re-registers on every load + recovers from 409s, dead sport-prefs sidebar UI removed
(never wired server-side), M3 shipped as re-scoped — payload carries raw `startTime` epoch and
sw.js renders it in the *device's local timezone* ("Starts in N min (H:MM)"), per-game
notification tags, push crons now run 0-1,8-23 CT for late Phoenix games. pwa.js→v7,
CACHE_NAME→v15. Open: real-device push test.
Group 5 (data integrity): SQLite now WAL + foreign_keys + busy_timeout (FK cascade real,
two-instance access safe — use :3200 for the second instance, :3100 is hotel-search);
nightly fetch prunes canceled games (horizon + hiccup guards); geocoder serialized with
city/state fallback (backlog cleared to 0 — also fixed getEventsNeedingGeocode not selecting
city/state); DC naming fixed; REGIONS deduped via new `/api/regions`; NCAA bracket year
derived instead of hardcoded 2026. filters.js→v22.
Group 6 (polish): esc() sweep through filters.js/calendar.js (+ http(s)-only link guards),
countdown timer guards, loadFilterOptions error handling + `/api/seasons/default` (no more
full-events fetch at load), lib/env.js deleted, TtlCache capped, computed seasonLabel,
hashed sportColor, modal focus/ARIA, KNOWN_VENUES pins → geocode backlog 0, dead status-bar
removed, service-file template synced. CACHE_NAME→v16.
Mobile addendum (Robert-reported): filter sidebar → fixed bottom sheet (was rendering below
a 100vh main = unreachable); header now fits 320–430px off-Live (wordmark + 📅 hidden ≤767px,
📅 lives in the sheet, clamp() sizing, overflow-x clip guard). Playwright-verified across
widths + desktop regression. style.css→v12, filters.js→v24, CACHE_NAME→v17.
**v1.3.0 SHIPPED TO PROD 2026-07-02** — tag pushed, deployed on Oracle (`git checkout
v1.3.0 && npm ci && restart`), verified from the public edge: /api/version 1.3.0, admin
401 (ADMIN_TOKEN was already in Oracle secrets.env), VAPID present, no TRUST_PROXY_HOPS
(default 1 correct), /api/live 0.23s, SW v18 serving, per-IP rate-limit headers live.
Startup geocode pass healed prod's own backlog (KNOWN_VENUES pins ran on boot).

**Open after ship:** real-device pass on Robert's phone against PROD (drawer feel,
installed-PWA v13→v18 update, push test via test-push.js); watch the first live-game day
(Soccer opens Aug 5) for the new live-cache path; consider audit "Feature ideas" pool in
docs/audit-2026-07-01.md for the next cycle.

**Infra incident (2026-07-02, resolved):** Robert saw the new UI on the *prod* URL but not
asu-dev — root cause was the split-DNS leftover documented in `## Environment` above (LAN →
dev box on the prod hostname). Pi-hole records removed + verified (LAN now gets Oracle 1.2.1).
asu-dev's stale look was the phone PWA's old SW cache; it self-updates on a fresh load.
Home-WiFi push subscriptions created during the split-brain sit in dev's DB (scheduler off →
no pushes); once v1.3.0 deploys to prod, the Group-4 self-healing re-register recreates them
in Oracle's DB on each user's next visit.

**Open / not yet verified (needs a real device):** authenticated `asu-dev` page render; PWA
install + push on prod from a phone; full reboot-recovery test of the Oracle box.

**TV broadcast notification option (2026-08-25, GPT-5):** Added a per-event `TV broadcast`
notification option for events with a feed-provided `tv_network`. The scheduler sends it in
the existing 0–20 minute pre-game window, only to subscribers selecting `tv_alert`; the push
includes the opponent, local-device start time, channel, and venue. Added an independent
`tv_push_sent` flag, API type validation, cache bumps, and `test-push.js tv <eventId>`.
Added TV Media's free-plan integration: users can save ZIP/provider preferences, lineups are
cached, each subscriber gets an independent channel lookup, and unmatched channels fall back
to the network name. The configured key is `TVMEDIA_API_KEY` in the shared secrets file.
Validated with JavaScript syntax checks, `git diff --check`, a real TV Media lookup (85281 / Cox
ESPN2 → channel 32), an app API lookup, payload/DB checks, and a local headless render.
Real-device push delivery remains unverified.

**Oracle Tailscale access completed (2026-08-25, GPT-5):** Direct Oracle SSH can be
rate-limited by sshd `MaxStartups`; Oracle is now the dedicated Tailscale access and exit
node, named `oracle-vps` in Tailscale. It advertises and has approval for IPv4/IPv6 default
routes, has IPv4/IPv6 forwarding enabled, subnet-route SNAT enabled, stateful filtering
enabled, and Tailscale SSH enabled. The local development VM's temporary Tailscale node was
removed; it is not part of the tailnet. Exit-node traffic was tested and exited through
Oracle's public IP `170.9.227.11`. NetOpt, the Oracle speed-test endpoint, ASU production
v1.4.0, `asu-cal.service`, and `cloudflared.service` remained healthy after the change.

**TV provider mobile layout fix (2026-08-25, GPT-5):** Fixed the ZIP/provider lookup row
on narrow screens. The full-width notification button had collapsed the adjacent ZIP input;
the row now gives the input flexible space and the button only its content width. Bumped the
stylesheet and service-worker cache versions; `pwa.js` and `sw.js` syntax checks plus
`git diff --check` passed.

**Global televised-game alerts (2026-08-25, GPT-5):** Added a Notifications-section option
to automatically receive `tv_alert` pushes for every future event with a TV network. The
preference is stored with the push subscription, deduplicates against per-event TV selections,
preserves provider/channel preferences, and does not enable game-start, score-update, or
final-score alerts. Bumped the frontend/service-worker cache versions and passed syntax and
diff checks.
