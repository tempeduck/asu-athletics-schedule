# Active Handoff
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

**Oracle access path completed (2026-08-25, GPT-5):** Direct Oracle SSH can be rate-limited
by sshd `MaxStartups`; the documented Tailscale path is now usable from this dev VM. Installed
Tailscale 1.102.3 and enrolled the VM as `asu-dev-codex` with route/DNS/exit-node behavior
disabled. Oracle is reachable directly at its Tailscale address. Verified Oracle's
`asu-cal.service` and `cloudflared.service` active, commit `4dcd633` / v1.4.0 running, the
TV Media key present, and the public edge serving v1.4.0 plus `/api/tv/lineups` successfully.
