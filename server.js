const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');
const { queryEvents, getSports, getSeasons, getRecordsBySeason, getLocations, insertFeedback, getUnreadCount, getAllFeedback, markRead, markAllRead, deleteFeedback, upsertPushSubscription, deletePushSubscription, addGameSubscription, removeGameSubscription, hasPushSubscription } = require('./db');
const { fetchAndStore } = require('./fetcher');
const { geocodeAllMissing } = require('./geocoder');
const { fetchLiveGames } = require('./scores');
const { startScheduler } = require('./scheduler');
const { loadSecretsFallback } = require('./lib/env');
const { USER_AGENT, SITE_HOST } = require('./lib/constants');
const { ESPN_SPORT_SLUGS, TOURNAMENT_RE } = require('./lib/sports-config');
const { TtlCache } = require('./lib/cache');
const { buildIcsCalendar } = require('./lib/ical');
const ncaa = require('./lib/ncaa');
const standings = require('./lib/standings');

loadSecretsFallback();

const { version: APP_VERSION } = require('./package.json');
const _releasesData = require('./releases.json');

// ── In-memory caches ──────────────────────────────────────────────────────────
const espnGameCache = new TtlCache(); // espnEventId → ESPN summary JSON
const cfStatsCache  = new TtlCache(); // `${days}`   → Cloudflare stats JSON

const app = express();
const PORT = process.env.PORT || 3000;

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

app.get('/api/seasons', generalLimit, (req, res) => {
  try {
    res.json(getSeasons());
  } catch (err) {
    res.status(500).json({ error: 'Failed to query seasons' });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

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
    const user_agent = req.headers['user-agent'] ?? null;
    const id = insertFeedback({ page: page ?? null, rating: rating ?? null, message: message ?? null, user_agent });
    res.json({ success: true, id });
  } catch (err) {
    console.error('[api] /api/feedback error:', err.message);
    res.status(500).json({ error: err.message });
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

app.get('/api/admin/feedback', adminLimit, (req, res) => {
  try {
    const origin = req.headers['origin'] || req.headers['referer'] || '';
    if (!origin.includes(SITE_HOST)) {
      console.warn('[api] /api/admin/feedback accessed from unexpected origin:', origin);
    }
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    res.json(getAllFeedback(limit, offset));
  } catch (err) {
    console.error('[api] /api/admin/feedback error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/feedback/:id/read', adminLimit, (req, res) => {
  try {
    const changes = markRead(req.params.id);
    if (changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[api] /api/admin/feedback/:id/read error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/feedback/:id', adminLimit, (req, res) => {
  try {
    const changes = deleteFeedback(req.params.id);
    if (changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[api] /api/admin/feedback/:id delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/feedback/read-all', adminLimit, (req, res) => {
  try {
    const count = markAllRead();
    res.json({ success: true, count });
  } catch (err) {
    console.error('[api] /api/admin/feedback/read-all error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/geocode', adminLimit, async (req, res) => {
  try {
    const result = await geocodeAllMissing();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[api] /api/geocode error:', err.message);
    res.status(500).json({ error: err.message });
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

// ── ESPN game summary proxy ───────────────────────────────────────────────────

app.get('/api/game/:espnEventId', generalLimit, async (req, res) => {
  const { espnEventId } = req.params;
  const { sport } = req.query;

  if (!sport || !(sport in ESPN_SPORT_SLUGS)) {
    return res.status(400).json({ error: 'Unknown sport' });
  }
  const slug = ESPN_SPORT_SLUGS[sport];
  if (slug === null) {
    return res.status(400).json({ error: 'No ESPN box score for this sport' });
  }

  const cached = espnGameCache.get(espnEventId);
  if (cached) return res.json(cached);

  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${slug}/summary?event=${espnEventId}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000,
    });
    if (!r.ok) return res.status(502).json({ error: 'ESPN unavailable' });
    const data = await r.json();
    const completed = data?.header?.competitions?.[0]?.status?.type?.completed === true;
    const ttl = completed ? 5 * 60 * 1000 : 30 * 1000;
    espnGameCache.set(espnEventId, data, ttl);
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
    res.status(500).json({ error: err.message });
  }
});

// ── Cloudflare Analytics proxy ────────────────────────────────────────────────

app.get('/api/cf-stats', generalLimit, async (req, res) => {
  const token     = process.env.CF_API_TOKEN || process.env.CF_TOKEN;
  const accountId = process.env.CF_ACCOUNT_ID;
  if (!token || !accountId) {
    return res.status(503).json({
      error: 'Stats not configured',
      missing: [!token && 'CF_API_TOKEN', !accountId && 'CF_ACCOUNT_ID'].filter(Boolean),
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

app.post('/api/subscribe', generalLimit, (req, res) => {
  try {
    const { endpoint, p256dh, auth, sportPrefs } = req.body ?? {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    upsertPushSubscription(endpoint, p256dh, auth, Array.isArray(sportPrefs) ? sportPrefs : null);
    res.json({ success: true });
  } catch (err) {
    console.error('[api] /api/subscribe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/unsubscribe', generalLimit, (req, res) => {
  try {
    const { endpoint } = req.body ?? {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    deletePushSubscription(endpoint);
    res.json({ success: true });
  } catch (err) {
    console.error('[api] /api/unsubscribe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/subscribe/game', generalLimit, (req, res) => {
  try {
    const { endpoint, eventId, types } = req.body ?? {};
    if (!endpoint || !eventId) return res.status(400).json({ error: 'endpoint and eventId required' });
    if (!hasPushSubscription(endpoint)) return res.status(409).json({ error: 'push subscription not found — register device first' });
    const validTypes = ['game_start', 'score_update', 'final_score'];
    const safeTypes = Array.isArray(types) ? types.filter(t => validTypes.includes(t)) : null;
    if (!safeTypes || !safeTypes.length) {
      removeGameSubscription(endpoint, eventId);
      return res.json({ success: true, action: 'unsubscribed' });
    }
    addGameSubscription(endpoint, eventId, safeTypes);
    res.json({ success: true, action: 'subscribed' });
  } catch (err) {
    console.error('[api] /api/subscribe/game error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/subscribe/game', generalLimit, (req, res) => {
  try {
    const { endpoint, eventId } = req.body ?? {};
    if (!endpoint || !eventId) return res.status(400).json({ error: 'endpoint and eventId required' });
    removeGameSubscription(endpoint, eventId);
    res.json({ success: true });
  } catch (err) {
    console.error('[api] /api/subscribe/game error:', err.message);
    res.status(500).json({ error: err.message });
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
