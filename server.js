const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');
const { queryEvents, getSports, getSeasons, getDefaultSeason, getRecordsBySeason, getLocations, insertFeedback, getUnreadCount, getAllFeedback, markRead, markAllRead, deleteFeedback, upsertPushSubscription, deletePushSubscription, addGameSubscription, removeGameSubscription, hasPushSubscription, getEventById, REGIONS } = require('./db');
const { fetchAndStore } = require('./fetcher');
const { geocodeAllMissing } = require('./geocoder');
const { fetchLiveGames } = require('./scores');
const { startScheduler } = require('./scheduler');
const { USER_AGENT, SITE_HOST } = require('./lib/constants');
const { ESPN_SPORT_SLUGS, TOURNAMENT_RE } = require('./lib/sports-config');
const { TtlCache } = require('./lib/cache');
const { buildIcsCalendar } = require('./lib/ical');
const ncaa = require('./lib/ncaa');
const standings = require('./lib/standings');
const { getHeadToHead } = require('./lib/h2h');
const team = require('./lib/team');
const { getTeamSummary } = require('./lib/team-summary');
const tvmedia = require('./lib/tvmedia');
const { fetchGameSummary } = require('./lib/game-summary');

// All secrets (CF_*, ADMIN_TOKEN, VAPID_*) come from the systemd
// EnvironmentFile (~/projects/secrets.env on both boxes). The old
// unifi-scripts/secrets.env fallback was removed 2026-07 — that file no
// longer exists anywhere.
const { version: APP_VERSION } = require('./package.json');
const _releasesData = require('./releases.json');

// ── In-memory caches ──────────────────────────────────────────────────────────
const cfStatsCache  = new TtlCache(); // `${days}`   → Cloudflare stats JSON

const app = express();
const PORT = process.env.PORT || 3000;

// Behind a reverse proxy the client IP arrives in X-Forwarded-For; without
// trust proxy, req.ip is always the tunnel/NPM origin and every rate limiter
// below shares ONE bucket across all visitors (and express-rate-limit logs
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR). Hops: prod = 1 (cloudflared on-box),
// dev = 2 (HA tunnel → NPM) — set TRUST_PROXY_HOPS=2 in the dev drop-in.
app.set('trust proxy', parseInt(process.env.TRUST_PROXY_HOPS, 10) || 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,      // allow CDN scripts/styles without a custom policy
  crossOriginEmbedderPolicy: false,
}));
// Helmet sets many headers; explicitly ensure these three are on:
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Rate limiters
const generalLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

const liveLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const adminLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin auth — shared secret from secrets.env (ADMIN_TOKEN, name only; value
// lives in ~/projects/secrets.env on each box). Locked (503) when unset so a
// missing secret fails closed rather than leaving the endpoints open.
function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return res.status(503).json({ error: 'Admin not configured' });
  if (req.get('x-admin-token') !== token) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.use(express.json());

// Service worker — must never be cached
app.get('/sw.js', (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Static files — no rate limiting
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

app.get('/api/events', generalLimit, (req, res) => {
  try {
    const { sport, game_type, city, state, region, from, to, season } = req.query;
    const events = queryEvents({ sport, game_type, city, state, region, from, to, season });
    // Rank annotation is non-blocking: a cold poll cache leaves this response
    // un-annotated rather than stalling on ESPN (index warms in background).
    standings.annotateEvents(events, { sinceTs: Math.floor(Date.now() / 1000) - 86400 });
    res.json(events);
  } catch (err) {
    console.error('[api] /api/events error:', err.message);
    res.status(500).json({ error: 'Failed to query events' });
  }
});

app.get('/api/sports', generalLimit, (req, res) => {
  try {
    res.json(getSports());
  } catch (err) {
    res.status(500).json({ error: 'Failed to query sports' });
  }
});

app.get('/api/locations', generalLimit, (req, res) => {
  try {
    res.json(getLocations());
  } catch (err) {
    res.status(500).json({ error: 'Failed to query locations' });
  }
});

// Single source for the region→states table (db.js) — the frontend used to
// carry its own copy, which had already drifted (DC naming).
app.get('/api/regions', generalLimit, (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(REGIONS);
});

app.get('/api/seasons', generalLimit, (req, res) => {
  try {
    res.json(getSeasons());
  } catch (err) {
    res.status(500).json({ error: 'Failed to query seasons' });
  }
});

app.get('/api/seasons/default', generalLimit, (req, res) => {
  try {
    res.json({ season: getDefaultSeason() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to query default season' });
  }
});

app.post('/api/refresh', adminLimit, async (req, res) => {
  try {
    const count = await fetchAndStore();
    res.json({ success: true, count });
    // Geocode new events as a separate async pass so Nominatim latency doesn't block the response
    geocodeAllMissing().catch(err => console.error('[api] Geocode pass failed:', err.message));
  } catch (err) {
    console.error('[api] /api/refresh error:', err.message);
    res.status(500).json({ error: 'Refresh failed' });
  }
});

app.get('/api/live', liveLimit, async (req, res) => {
  try {
    const { games, tournaments } = await fetchLiveGames();
    standings.annotateGames(games);
    const nowTs = Math.floor(Date.now() / 1000);
    const nextRow = queryEvents({ from: nowTs })[0] ?? null;
    if (nextRow) standings.annotateEvents([nextRow]);
    const nextGame = nextRow ? {
      id: nextRow.id,
      title: nextRow.title,
      sport: nextRow.sport,
      startTime: nextRow.start_date,
      location: nextRow.location_name,
      tvNetwork: nextRow.tv_network,
      gameType: nextRow.game_type,
      opponent_logo: nextRow.opponent_logo,
      oppRank: nextRow.opp_rank ?? null,
      isTournament: TOURNAMENT_RE.test(nextRow.title || '') ||
                    TOURNAMENT_RE.test(nextRow.badges || '') ||
                    TOURNAMENT_RE.test(nextRow.location_name || ''),
    } : null;
    const records = getRecordsBySeason();
    res.json({ games, tournaments, nextGame, records });
  } catch (err) {
    console.error('[api] /api/live error:', err.message);
    res.status(500).json({ error: 'Failed to load live data' });
  }
});

app.get('/api/bracket', liveLimit, async (req, res) => {
  try {
    const { sport, tournamentId } = req.query;
    // FALLBACK: NCAA bracket — data.ncaa.com/casablanca/bracket/{sport}/d1/{year}/bracket.json
    // Returns ASU's pod once the national bracket JSON is parsed for ASU's region.
    // TODO: wire in NCAA bracket parsing to extract ASU's regional/sub-regional.
    res.json({ rounds: [], source: 'not-implemented', sport, tournamentId });
  } catch (err) {
    console.error('[api] /api/bracket error:', err.message);
    res.status(500).json({ error: 'Failed to load bracket' });
  }
});

const VALID_FEEDBACK_PAGES = new Set(['calendar', 'list', 'map', 'live']);

app.post('/api/feedback', generalLimit, (req, res) => {
  try {
    const { page, rating, message } = req.body ?? {};
    if (!message && rating == null) {
      return res.status(400).json({ error: 'At least one of message or rating is required' });
    }
    if (message != null && message.length > 1000) {
      return res.status(400).json({ error: 'Message exceeds 1000 characters' });
    }
    if (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      return res.status(400).json({ error: 'Rating must be an integer between 1 and 5' });
    }
    // page is attacker-controlled and rendered in the admin portal — whitelist it.
    const safePage = VALID_FEEDBACK_PAGES.has(page) ? page : null;
    const user_agent = (req.headers['user-agent'] ?? '').slice(0, 400) || null;
    const id = insertFeedback({ page: safePage, rating: rating ?? null, message: message ?? null, user_agent });
    res.json({ success: true, id });
  } catch (err) {
    console.error('[api] /api/feedback error:', err.message);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

app.get('/api/feedback/unread-count', generalLimit, (req, res) => {
  try {
    res.json({ unread: getUnreadCount() });
  } catch (err) {
    console.error('[api] /api/feedback/unread-count error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/feedback', generalLimit, requireAdmin, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    res.json(getAllFeedback(limit, offset));
  } catch (err) {
    console.error('[api] /api/admin/feedback error:', err.message);
    res.status(500).json({ error: 'Failed to load feedback' });
  }
});

app.post('/api/admin/feedback/:id/read', generalLimit, requireAdmin, (req, res) => {
  try {
    const changes = markRead(req.params.id);
    if (changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[api] /api/admin/feedback/:id/read error:', err.message);
    res.status(500).json({ error: 'Failed to update feedback' });
  }
});

app.delete('/api/admin/feedback/:id', generalLimit, requireAdmin, (req, res) => {
  try {
    const changes = deleteFeedback(req.params.id);
    if (changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[api] /api/admin/feedback/:id delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete feedback' });
  }
});

app.post('/api/admin/feedback/read-all', generalLimit, requireAdmin, (req, res) => {
  try {
    const count = markAllRead();
    res.json({ success: true, count });
  } catch (err) {
    console.error('[api] /api/admin/feedback/read-all error:', err.message);
    res.status(500).json({ error: 'Failed to update feedback' });
  }
});

app.post('/api/geocode', adminLimit, async (req, res) => {
  try {
    const result = await geocodeAllMissing();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[api] /api/geocode error:', err.message);
    res.status(500).json({ error: 'Geocode failed' });
  }
});

// ── Conference standings ──────────────────────────────────────────────────────

app.get('/api/standings', generalLimit, async (req, res) => {
  try {
    const result = await standings.getStandings(req.query.sport);
    if (!result) return res.status(400).json({ error: 'Unknown sport' });
    res.json(result);
  } catch (err) {
    console.error('[api] /api/standings error:', err.message);
    res.status(502).json({ error: 'ESPN unavailable' });
  }
});

// ── Team news & roster (ESPN) ─────────────────────────────────────────────────

app.get('/api/news', generalLimit, async (req, res) => {
  try {
    res.json(await team.getNews());
  } catch (err) {
    console.error('[api] /api/news error:', err.message);
    res.status(502).json({ error: 'ESPN unavailable' });
  }
});

app.get('/api/roster', generalLimit, async (req, res) => {
  try {
    const result = await team.getRoster(req.query.sport);
    if (!result) return res.status(400).json({ error: 'Unknown sport' });
    res.json(result);
  } catch (err) {
    console.error('[api] /api/roster error:', err.message);
    res.status(502).json({ error: 'ESPN unavailable' });
  }
});

app.get('/api/team-summary', generalLimit, async (req, res) => {
  const { sport, teamId, name } = req.query;
  if (!sport || (!name && !teamId)) return res.status(400).json({ error: 'sport and team are required' });
  if (teamId && !/^\d{1,20}$/.test(teamId)) return res.status(400).json({ error: 'Invalid team id' });
  try { res.set('Cache-Control', 'no-store'); res.json(await getTeamSummary(sport, teamId, name)); }
  catch (err) { console.error('[api] /api/team-summary error:', err.message); res.status(502).json({ error: 'ESPN unavailable' }); }
});

// ── Head-to-head vs opponent (local DB) ───────────────────────────────────────

app.get('/api/h2h', generalLimit, (req, res) => {
  try {
    const { sport, opponent } = req.query;
    if (!sport || !opponent) {
      return res.status(400).json({ error: 'sport and opponent are required' });
    }
    const result = getHeadToHead(sport, opponent);
    if (!result) return res.status(400).json({ error: 'Could not parse opponent' });
    res.json(result);
  } catch (err) {
    console.error('[api] /api/h2h error:', err.message);
    res.status(500).json({ error: 'Failed to compute head-to-head' });
  }
});

// ── ESPN game summary proxy ───────────────────────────────────────────────────

app.get('/api/game/:espnEventId', liveLimit, async (req, res) => {
  const { espnEventId } = req.params;
  const { sport } = req.query;

  // Numeric only: reject invalid IDs before they reach ESPN or the shared cache.
  if (!/^\d{1,20}$/.test(espnEventId)) {
    return res.status(400).json({ error: 'Invalid event id' });
  }
  if (!sport || !(sport in ESPN_SPORT_SLUGS)) {
    return res.status(400).json({ error: 'Unknown sport' });
  }
  const slug = ESPN_SPORT_SLUGS[sport];
  if (slug === null) {
    return res.status(400).json({ error: 'No ESPN box score for this sport' });
  }

  try {
    const data = await fetchGameSummary(slug, espnEventId);
    res.set('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    console.error('[api] /api/game error:', err.message);
    res.status(502).json({ error: 'ESPN unavailable' });
  }
});

// ── NCAA bracket config ───────────────────────────────────────────────────────

app.get('/api/ncaa/config', generalLimit, async (req, res) => {
  try {
    const config = await ncaa.getNcaaConfig();
    res.json({ gqlHost: config.gqlHost, shas: config.shas, championshipId: config.championshipId });
  } catch (err) {
    console.error('[api] /api/ncaa/config error:', err.message);
    res.status(502).json({ error: 'NCAA config unavailable' });
  }
});

// ── NCAA ASU section lookup ───────────────────────────────────────────────────

app.get('/api/ncaa/asu-section', generalLimit, async (req, res) => {
  try {
    res.json(await ncaa.getAsuSection());
  } catch (err) {
    console.error('[api] /api/ncaa/asu-section error:', err.message);
    res.status(502).json({ error: 'NCAA API unavailable' });
  }
});

// ── NCAA section bracket ──────────────────────────────────────────────────────

app.get('/api/ncaa/bracket/:sectionId', liveLimit, async (req, res) => {
  const sectionId = parseInt(req.params.sectionId, 10);
  if (isNaN(sectionId)) return res.status(400).json({ error: 'Invalid sectionId' });

  try {
    const augmented = await ncaa.getBracketSection(
      sectionId,
      async () => (await fetchLiveGames()).games || [],
    );
    res.json(augmented);
  } catch (err) {
    console.error('[api] /api/ncaa/bracket error:', err.message);
    res.status(502).json({ error: 'NCAA API unavailable' });
  }
});

// ── iCalendar export ──────────────────────────────────────────────────────────
app.get('/api/events.ics', generalLimit, (req, res) => {
  try {
    const { sport, season, game_type } = req.query;
    const events = queryEvents({ sport, season, game_type });

    const body = buildIcsCalendar(events);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="asu-athletics.ics"');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(body);
  } catch (err) {
    console.error('[api] /api/events.ics error:', err.message);
    res.status(500).json({ error: 'Failed to build calendar' });
  }
});

// ── Cloudflare Analytics proxy ────────────────────────────────────────────────

app.get('/api/cf-stats', generalLimit, async (req, res) => {
  const token     = process.env.CF_ANALYTICS_TOKEN;
  const accountId = process.env.CF_ACCOUNT_ID;
  if (!token || !accountId) {
    return res.status(503).json({
      error: 'Stats not configured',
      missing: [!token && 'CF_ANALYTICS_TOKEN', !accountId && 'CF_ACCOUNT_ID'].filter(Boolean),
    });
  }

  const days     = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
  const cacheKey = String(days);
  const cached   = cfStatsCache.get(cacheKey);
  if (cached) return res.json(cached);

  const endDate   = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

  // Cloudflare Web Analytics beacon data (rumPageloadEventsAdaptiveGroups).
  // Scoped to asu.dikaiaserver.com via requestHost filter — excludes all other
  // subdomains that also have beacons (jarvis, radar, etc.).
  // Counts only real browser page loads, not CDN requests or API calls.
  const host = SITE_HOST;
  const f    = `date_geq: "${startDate}", date_leq: "${endDate}", requestHost: "${host}"`;
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        byDate:    rumPageloadEventsAdaptiveGroups(filter: { ${f} } limit: 93  orderBy: [date_ASC]) { count dimensions { date } }
        byCountry: rumPageloadEventsAdaptiveGroups(filter: { ${f} } limit: 100) { count dimensions { countryName } }
        byDevice:  rumPageloadEventsAdaptiveGroups(filter: { ${f} } limit: 10)  { count dimensions { deviceType } }
        byPath:    rumPageloadEventsAdaptiveGroups(filter: { ${f} } limit: 30)  { count dimensions { requestPath } }
        byReferrer:rumPageloadEventsAdaptiveGroups(filter: { ${f} } limit: 20)  { count dimensions { refererHost } }
        byBrowser: rumPageloadEventsAdaptiveGroups(filter: { ${f} } limit: 15)  { count dimensions { userAgentBrowser } }
      }
    }
  }`;

  try {
    const cfRes = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
      timeout: 15000,
    });
    if (!cfRes.ok) return res.status(502).json({ error: `Cloudflare HTTP ${cfRes.status}` });
    const data = await cfRes.json();
    cfStatsCache.set(cacheKey, data, 10 * 60 * 1000); // 10-min TTL
    res.json(data);
  } catch (err) {
    console.error('[api] /api/cf-stats error:', err.message);
    res.status(502).json({ error: 'Cloudflare API unavailable' });
  }
});

app.get('/stats', generalLimit, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stats.html'));
});

// ── Push notification API ─────────────────────────────────────────────────────

app.get('/api/vapid-public-key', (req, res) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey });
});

app.get('/api/tv/lineups', generalLimit, async (req, res) => {
  try {
    if (!process.env.TVMEDIA_API_KEY) return res.status(503).json({ error: 'TV lookup is not configured' });
    res.json(await tvmedia.getLineups(req.query.postalCode));
  } catch (err) {
    console.error('[api] /api/tv/lineups error:', err.message);
    res.status(400).json({ error: err.message.includes('required') ? err.message : 'TV lineup lookup failed' });
  }
});

// Push endpoints are URLs this server will later POST to (via web-push) —
// require https and a sane length so junk/internal URLs can't be registered.
function isValidPushEndpoint(endpoint) {
  return typeof endpoint === 'string'
    && endpoint.length <= 1024
    && endpoint.startsWith('https://');
}

app.post('/api/subscribe', generalLimit, (req, res) => {
  try {
    const { endpoint, p256dh, auth, sportPrefs, tvPrefs } = req.body ?? {};
    if (!isValidPushEndpoint(endpoint)) return res.status(400).json({ error: 'valid https endpoint required' });
    // A brand-new subscription must carry its crypto keys; empty keys are only
    // allowed as a "keep existing" update (the prefs-only path from pwa.js).
    if (!hasPushSubscription(endpoint) && (!p256dh || !auth)) {
      return res.status(400).json({ error: 'p256dh and auth required for new subscriptions' });
    }
    const hasValidTvLineup = tvPrefs && typeof tvPrefs === 'object' &&
      tvmedia.validPostalCode(tvPrefs.postalCode) && tvmedia.validLineupId(tvPrefs.lineupId);
    const hasTvAllPreference = tvPrefs && typeof tvPrefs === 'object' && typeof tvPrefs.allTelevised === 'boolean';
    const safeTvPrefs = hasValidTvLineup || hasTvAllPreference
      ? { postalCode: hasValidTvLineup ? tvPrefs.postalCode.trim() : '', lineupId: hasValidTvLineup ? tvPrefs.lineupId : '', providerName: hasValidTvLineup ? String(tvPrefs.providerName || '').slice(0, 120) : '', allTelevised: tvPrefs.allTelevised === true }
      : (tvPrefs === null ? null : undefined);
    upsertPushSubscription(endpoint, p256dh, auth, Array.isArray(sportPrefs) ? sportPrefs : null, safeTvPrefs);
    res.json({ success: true });
  } catch (err) {
    console.error('[api] /api/subscribe error:', err.message);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

app.post('/api/unsubscribe', generalLimit, (req, res) => {
  try {
    const { endpoint } = req.body ?? {};
    if (!isValidPushEndpoint(endpoint)) return res.status(400).json({ error: 'valid https endpoint required' });
    deletePushSubscription(endpoint);
    res.json({ success: true });
  } catch (err) {
    console.error('[api] /api/unsubscribe error:', err.message);
    res.status(500).json({ error: 'Failed to remove subscription' });
  }
});

app.post('/api/subscribe/game', generalLimit, (req, res) => {
  try {
    const { endpoint, eventId, types } = req.body ?? {};
    if (!isValidPushEndpoint(endpoint) || !eventId) return res.status(400).json({ error: 'endpoint and eventId required' });
    if (!hasPushSubscription(endpoint)) return res.status(409).json({ error: 'push subscription not found — register device first' });
    const validTypes = ['game_start', 'score_update', 'final_score', 'tv_alert'];
    const safeTypes = Array.isArray(types) ? types.filter(t => validTypes.includes(t)) : null;
    if (!safeTypes || !safeTypes.length) {
      removeGameSubscription(endpoint, eventId);
      return res.json({ success: true, action: 'unsubscribed' });
    }
    // FKs are enforced now — reject unknown events cleanly instead of letting
    // the insert die on the constraint. (Removals above stay allowed so a
    // client can clean up after an event was pruned.)
    if (!getEventById(eventId)) return res.status(400).json({ error: 'unknown eventId' });
    addGameSubscription(endpoint, eventId, safeTypes);
    res.json({ success: true, action: 'subscribed' });
  } catch (err) {
    console.error('[api] /api/subscribe/game error:', err.message);
    res.status(500).json({ error: 'Failed to update game subscription' });
  }
});

app.delete('/api/subscribe/game', generalLimit, (req, res) => {
  try {
    const { endpoint, eventId } = req.body ?? {};
    if (!isValidPushEndpoint(endpoint) || !eventId) return res.status(400).json({ error: 'endpoint and eventId required' });
    removeGameSubscription(endpoint, eventId);
    res.json({ success: true });
  } catch (err) {
    console.error('[api] /api/subscribe/game error:', err.message);
    res.status(500).json({ error: 'Failed to update game subscription' });
  }
});

app.get('/api/version', generalLimit, (req, res) => {
  res.json({ version: APP_VERSION });
});

app.get('/api/releases', generalLimit, (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(_releasesData);
});

// DISABLE_SCHEDULER=1 lets a second verification instance run on an alternate
// port without double-polling ESPN or double-sending push notifications.
if (process.env.DISABLE_SCHEDULER !== '1') {
  startScheduler();
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] ASU Athletics Calendar running at http://0.0.0.0:${PORT}`);
});
