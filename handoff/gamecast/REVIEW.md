# Gamecast implementation review

[2026-09-06 (GPT-6)]

Shipped to production as v1.5.0 (`f349366`) on September 6 after Robert approved
commit, push, and deployment. Main and the annotated release tag were pushed;
production installed the release and restarted successfully. Development retains
its existing scheduler-disable configuration.

## Sport coverage

These are observed capabilities of sampled ASU games, not guarantees for every
game in a sport. The interface decides what to display from each response.

| Sport | Implemented detail | Sample ESPN summary |
| --- | --- | --- |
| Football | Field position and line to gain when reported, collapsible drives, individual plays, ASU win-probability history | [Morgan State at ASU](https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=401856774) |
| Men's basketball | Full play-by-play and available ASU win-probability history | [ASU at Iowa State](https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=401851289) |
| Women's basketball | Full play-by-play and available ASU win-probability history | [ASU at Virginia](https://site.api.espn.com/apis/site/v2/sports/basketball/womens-college-basketball/summary?event=401859472) |
| Baseball | Play/pitch descriptions, inning labels, score after each play | [ASU at Ole Miss](https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball/summary?event=401873831) |
| Softball | Play/pitch descriptions, inning labels, score after each play | [Texas A&M at ASU](https://site.api.espn.com/apis/site/v2/sports/baseball/college-softball/summary?event=401872541) |
| Ice hockey | Existing scores and player stats; sampled play array was empty | [ASU at Denver](https://site.api.espn.com/apis/site/v2/sports/hockey/mens-college-hockey/summary?event=401821372) |
| Volleyball | Existing scores and player stats; no rally log in sample | [ASU at Villanova](https://site.api.espn.com/apis/site/v2/sports/volleyball/womens-college-volleyball/summary?event=401886988) |
| Soccer | Basic match details; sample lacked play-by-play and boxscore | [Dartmouth at ASU](https://site.api.espn.com/apis/site/v2/sports/soccer/usa.ncaa.w.1/summary?event=401886272) |

Other ASU sports are outside the current live-summary integration. Hockey,
volleyball, or soccer summaries that later supply a `plays` array automatically
get the shared Gamecast timeline. Basketball shot charts, baseball diamonds,
video playback, and soccer/hockey field graphics are outside this implementation.

## Behavior and changes

- `public/gamecast.js` builds a Gamecast tab from the existing summary proxy.
  Football drives and other play lists show latest entries first. The field is
  explicitly the latest reported position, normalized to offense moving right;
  it does not extrapolate player movement or invent missing coordinates.
- Available probability history is expressed from ASU's perspective, including
  away games, and labeled as ESPN estimates by play.
- `public/game-modal.js` refreshes live games every 5 seconds and upcoming games
  every 30 seconds. Polling stops
  on close/final, pauses while the page is hidden, and resumes when visible.
  Requests time out after 15 seconds. Failed refreshes retain the previous
  display and show an interrupted-update message. Failures retry after 30 seconds.
- Updates preserve the active tab, expanded drives, tab/drive keyboard focus,
  scroll position, and the visible play when new plays appear above it.
  Old game requests cannot replace a subsequently opened game. Head-to-head
  responses are tied to their original DOM target to avoid stale replacements.
- Styles support narrow screens and both themes. Asset versions are
  `gamecast.js?v=1`, `game-modal.js?v=7`, `style.css?v=17`, and SW cache v25.
- `lib/game-summary.js` shares simultaneous upstream requests by sport/event,
  caches live summaries for 5 seconds, upcoming for 30 seconds, and finals for
  5 minutes. Errors clear the in-flight entry and are not cached. The existing
  game route uses the live limiter (60 requests/minute) and sends `no-store`.
- Release metadata updated to v1.5.0. No new dependencies or backend routes.

## Refresh speed

On September 6, the sampled ESPN summary response advertised `max-age=4` and its
football scoreboard advertised `max-age=1`. These cache headers are observations,
not promises of data publication frequency or approved polling rates. Five-second
summary polling is a practical target; polling every second could repeatedly
return the same cached data. ESPN's own publication delay and our cache/poll
timing still affect end-to-end latency. No guaranteed fastest Gamecast update
interval has been established.

## Verification

`scripts/verify-gamecast.cjs` runs against a local fixture server with actual ESPN
summary payloads. It never opens the application database. Set
`PLAYWRIGHT_MODULE` to the shared screenshot tool's installed Playwright module;
optionally set `GAMECAST_FIXTURES` to a directory containing cached sample JSON.
Without cached fixtures it downloads the eight sample summaries above.

Passed Chromium checks: eight sport renders; 5-second live refresh and 30-second
error backoff; preservation of
tab, keyboard focus, scroll, expanded drives, and reading position after new
plays; network failure/recovery; hidden-tab pause/resume; stale-request isolation;
stopping after close/final; 320/390px overflow checks; safe feed-text escaping;
missing data; and away-team probability conversion. JavaScript syntax checks and
`git diff --check` also passed.

`node scripts/verify-game-summary.cjs` additionally passed deterministic checks
for 20 simultaneous requests sharing one upstream fetch, live/upcoming/final
cache expiry, sport/event cache isolation, and recovery after HTTP/malformed
response failures.

An additional browser smoke test opened the actual development app and its real
`/api/game` response: version 1.5.0, ten football drives rendered, and no browser
JavaScript errors. The mobile field diagram displayed the current drive's down,
distance, ball position, and line to gain.

Visual artifacts from the shared screenshot tool's Playwright installation:

- [Desktop football](football-desktop.png)
- [Mobile football](football-mobile.png)
- [Mobile dark theme](football-mobile-dark.png)
- [Actual development app, mobile](football-dev-mobile.png)
- [Actual production app, mobile](football-prod-mobile.png)

Production verification: public version 1.5.0; SW cache v25; summary HTTP 200,
`Cache-Control: no-store`, and 60/min rate limit. The now-final football game
rendered 24 drives with no browser JavaScript errors. A recorded live summary
served to that same production browser confirmed one refresh after five seconds.
Both production services are active and the checkout is clean at the release tag.
Machine-readable results: [production-verification.json](production-verification.json).

The release retains the existing v1.4.1 football fix in its ancestry. Main also
contains the previously committed global televised-game alerts and mobile TV
provider layout fix; these ship in this promotion. The unrelated untracked
Docker-transition note is excluded.
