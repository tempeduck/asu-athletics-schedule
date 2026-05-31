const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');
const { queryEvents, getSports, getLocations, insertFeedback, getUnreadCount, getAllFeedback, markRead, markAllRead, deleteFeedback } = require('./db');
const { fetchAndStore } = require('./fetcher');
const { geocodeAllMissing } = require('./geocoder');
const { fetchLiveGames, TOURNAMENT_RE } = require('./scores');
const { startScheduler } = require('./scheduler');

// ── In-memory caches ──────────────────────────────────────────────────────────
const _espnGameCache    = new Map();                    // espnEventId → {data, expiresAt}
const _ncaaConfigCache  = { data: null, expiresAt: 0 }; // scraped SHA config
const _ncaaSectionCache = { data: null, expiresAt: 0 }; // ASU's regional sectionId
const _ncaaBracketCache = new Map();                    // sectionId → {data, expiresAt}

// Sport slug mapping for ESPN summary endpoint
const ESPN_SPORT_SLUGS = {
  'Baseball':             'baseball/college-baseball',
  'Softball':             'softball/college-softball',
  "Men's Basketball":     'basketball/mens-college-basketball',
  "Women's Basketball":   'basketball/womens-college-basketball',
  'Basketball':           'basketball/mens-college-basketball',
  'Football':             'football/college-football',
  "Women's Soccer":       'soccer/college-soccer-women',
  "Men's Soccer":         'soccer/college-soccer-men',
  'Soccer':               'soccer/college-soccer-men',
  "Women's Volleyball":   'volleyball/womens-college-volleyball',
  'Volleyball':           'volleyball/womens-college-volleyball',
  "Golf (Men's)":         'golf/college-golf-men',
  "Golf (Women's)":       'golf/college-golf-women',
  "Tennis (Men's)":       'tennis/college-tennis-men',
  "Tennis (Women's)":     'tennis/college-tennis-women',
  'Swimming':             'swimming-and-diving/college-swimming-diving',
  'Swimming & Diving':    'swimming-and-diving/college-swimming-diving',
  'Track and Field':      null,
  'Cross Country':        null,
};

// ── NCAA config scraper ───────────────────────────────────────────────────────

async function getNcaaConfig() {
  const now = Date.now();
  if (_ncaaConfigCache.data && _ncaaConfigCache.expiresAt > now) return _ncaaConfigCache.data;

  const r = await fetch('https://www.ncaa.com/brackets/baseball/d1/2026', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ASU-Athletics-Calendar/1.0)' },
    timeout: 15000,
  });
  if (!r.ok) throw new Error(`NCAA bracket page HTTP ${r.status}`);
  const html = await r.text();

  // Find the bare-JSON <script> tag that contains drupalSettings with a "bracket" key
  const scriptTagRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let settings = null;
  while ((m = scriptTagRe.exec(html)) !== null) {
    const content = m[1].trim();
    if (!content || !content.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(content);
      if (parsed?.bracket) { settings = parsed; break; }
    } catch {}
  }
  if (!settings?.bracket) throw new Error('drupalSettings bracket not found in NCAA page');

  const { bracket } = settings;
  const shas = bracket.querySHAs;
  const variables = typeof bracket.variables === 'string' ? JSON.parse(bracket.variables) : bracket.variables;
  const gqlEnv = bracket.gqlEnv || 'prod';
  const gqlHost = `https://sdata${gqlEnv}.ncaa.com`;
  const championshipId = variables.championshipId;
  // Only keep Regional sections (sectionId < 200) for ASU search fallback
  const regionalSections = (bracket.sections || []).filter(s => s.sectionId < 200).map(s => s.sectionId);

  const config = { gqlHost, shas, variables, championshipId, regionalSections };
  _ncaaConfigCache.data = config;
  _ncaaConfigCache.expiresAt = now + 6 * 60 * 60 * 1000;
  console.log(`[ncaa] Config loaded: championshipId=${championshipId}, gqlHost=${gqlHost}, sections=${regionalSections.length}`);
  return config;
}

function _ncaaNameWords(name) {
  // Extract first 1-2 significant words from an NCAA team nameShort
  // "Arizona St." → ["Arizona"], "South Dakota St." → ["South", "Dakota"], "Ole Miss" → ["Ole", "Miss"]
  return (name || '').replace(/\./g, '').split(/\s+/).filter(w => w.length > 1).slice(0, 2);
}

function matchNcaaToEspn(ncaaGame, liveGames) {
  if (!ncaaGame.startTimeEpoch) return null;
  return liveGames.find(g => {
    if (!g.espnEventId) return false;
    if (Math.abs((g.startTime || 0) - ncaaGame.startTimeEpoch) >= 300) return false;
    const haystack = `${g.title || ''} ${g.oppName || ''}`.toLowerCase();
    return (ncaaGame.teams || []).some(t => {
      const words = _ncaaNameWords(t.nameShort);
      return words.length > 0 && words.every(w => haystack.includes(w.toLowerCase()));
    });
  })?.espnEventId ?? null;
}

const app = express();
const PORT = 3000;

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
    const { sport, game_type, city, state, region, from, to } = req.query;
    const events = queryEvents({ sport, game_type, city, state, region, from, to });
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
    const nowTs = Math.floor(Date.now() / 1000);
    const nextRow = queryEvents({ from: nowTs })[0] ?? null;
    const nextGame = nextRow ? {
      id: nextRow.id,
      title: nextRow.title,
      sport: nextRow.sport,
      startTime: nextRow.start_date,
      location: nextRow.location_name,
      tvNetwork: nextRow.tv_network,
      gameType: nextRow.game_type,
      opponent_logo: nextRow.opponent_logo,
      isTournament: TOURNAMENT_RE.test(nextRow.title || '') ||
                    TOURNAMENT_RE.test(nextRow.badges || '') ||
                    TOURNAMENT_RE.test(nextRow.location_name || ''),
    } : null;
    res.json({ games, tournaments, nextGame });
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
    if (!origin.includes('asu.dikaiaserver.com')) {
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

  const now = Date.now();
  const cached = _espnGameCache.get(espnEventId);
  if (cached && cached.expiresAt > now) return res.json(cached.data);

  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${slug}/summary?event=${espnEventId}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'ASU-Athletics-Calendar/1.0' },
      timeout: 10000,
    });
    if (!r.ok) return res.status(502).json({ error: 'ESPN unavailable' });
    const data = await r.json();
    const completed = data?.header?.competitions?.[0]?.status?.type?.completed === true;
    const ttl = completed ? 5 * 60 * 1000 : 30 * 1000;
    _espnGameCache.set(espnEventId, { data, expiresAt: now + ttl });
    res.json(data);
  } catch (err) {
    console.error('[api] /api/game error:', err.message);
    res.status(502).json({ error: 'ESPN unavailable' });
  }
});

// ── NCAA bracket config ───────────────────────────────────────────────────────

app.get('/api/ncaa/config', generalLimit, async (req, res) => {
  try {
    const config = await getNcaaConfig();
    res.json({ gqlHost: config.gqlHost, shas: config.shas, championshipId: config.championshipId });
  } catch (err) {
    console.error('[api] /api/ncaa/config error:', err.message);
    res.status(502).json({ error: 'NCAA config unavailable' });
  }
});

// ── NCAA ASU section lookup ───────────────────────────────────────────────────

async function _ncaaFindAsuSection(config) {
  // Helper: search a section's games for ASU
  async function searchSection(sectionId) {
    const sha = config.shas.GetBracketSectionById_ncaa;
    const ext = encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: sha } }));
    const vars = encodeURIComponent(JSON.stringify({ championshipId: config.championshipId, sectionId }));
    const url = `${config.gqlHost}/?operationName=GetBracketSectionById_ncaa&extensions=${ext}&variables=${vars}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ASU-Athletics-Calendar/1.0)' },
      timeout: 10000,
    });
    if (!r.ok) return null;
    const data = await r.json();
    const games = data?.data?.championshipGames || [];
    for (const g of games) {
      for (const t of g.teams || []) {
        if (t.seoname === 'arizona-st') {
          return { sectionId: g.section?.sectionId ?? sectionId, sectionTitle: g.section?.title ?? 'Regional' };
        }
      }
    }
    return null;
  }

  // 1. Try GetBracketChampionship_ncaa first (works once full bracket is set)
  try {
    const sha = config.shas.GetBracketChampionship_ncaa;
    const ext = encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: sha } }));
    const vars = encodeURIComponent(JSON.stringify(config.variables));
    const url = `${config.gqlHost}/?operationName=GetBracketChampionship_ncaa&extensions=${ext}&variables=${vars}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ASU-Athletics-Calendar/1.0)' }, timeout: 15000 });
    if (r.ok) {
      const data = await r.json();
      const games = data?.data?.championshipGames || [];
      for (const g of games) {
        for (const t of g.teams || []) {
          if (t.seoname === 'arizona-st') {
            return { sectionId: g.section?.sectionId, sectionTitle: g.section?.title };
          }
        }
      }
    }
  } catch {}

  // 2. Fallback: scan regional sections sequentially
  console.log('[ncaa] Championship bracket empty — scanning regional sections for ASU');
  for (const sid of (config.regionalSections || [])) {
    try {
      const found = await searchSection(sid);
      if (found) { console.log(`[ncaa] ASU found in sectionId=${found.sectionId}`); return found; }
    } catch {}
  }
  throw new Error('ASU not found in any regional section');
}

app.get('/api/ncaa/asu-section', generalLimit, async (req, res) => {
  const now = Date.now();
  if (_ncaaSectionCache.data && _ncaaSectionCache.expiresAt > now) {
    return res.json(_ncaaSectionCache.data);
  }
  try {
    const config = await getNcaaConfig();
    const result = await _ncaaFindAsuSection(config);
    _ncaaSectionCache.data = result;
    _ncaaSectionCache.expiresAt = now + 30 * 60 * 1000;
    res.json(result);
  } catch (err) {
    console.error('[api] /api/ncaa/asu-section error:', err.message);
    res.status(502).json({ error: 'NCAA API unavailable' });
  }
});

// ── NCAA section bracket ──────────────────────────────────────────────────────

app.get('/api/ncaa/bracket/:sectionId', liveLimit, async (req, res) => {
  const sectionId = parseInt(req.params.sectionId, 10);
  if (isNaN(sectionId)) return res.status(400).json({ error: 'Invalid sectionId' });

  const now = Date.now();
  const cached = _ncaaBracketCache.get(sectionId);
  if (cached && cached.expiresAt > now) return res.json(cached.data);

  try {
    const config = await getNcaaConfig();
    const sha = config.shas.GetBracketSectionById_ncaa;
    const ext = encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: sha } }));
    const vars = encodeURIComponent(JSON.stringify({ championshipId: config.championshipId, sectionId }));
    const url = `${config.gqlHost}/?operationName=GetBracketSectionById_ncaa&extensions=${ext}&variables=${vars}`;

    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ASU-Athletics-Calendar/1.0)' },
      timeout: 15000,
    });
    if (!r.ok) throw new Error(`NCAA GraphQL HTTP ${r.status}`);
    const data = await r.json();
    const games = data?.data?.championshipGames || [];

    // Cross-reference with live data to attach espnEventIds
    let liveGames = [];
    try {
      const liveData = await fetchLiveGames();
      liveGames = liveData.games || [];
    } catch {}

    const augmented = games.map(g => ({ ...g, espnEventId: matchNcaaToEspn(g, liveGames) }));
    _ncaaBracketCache.set(sectionId, { data: augmented, expiresAt: now + 60 * 1000 });
    res.json(augmented);
  } catch (err) {
    console.error('[api] /api/ncaa/bracket error:', err.message);
    res.status(502).json({ error: 'NCAA API unavailable' });
  }
});

startScheduler();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] ASU Athletics Calendar running at http://0.0.0.0:${PORT}`);
});
