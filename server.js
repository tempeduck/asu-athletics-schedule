const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');
const { queryEvents, getSports, getSeasons, getRecordsBySeason, getLocations, insertFeedback, getUnreadCount, getAllFeedback, markRead, markAllRead, deleteFeedback, upsertPushSubscription, deletePushSubscription, addGameSubscription, removeGameSubscription, hasPushSubscription } = require('./db');
const { fetchAndStore } = require('./fetcher');
const { geocodeAllMissing } = require('./geocoder');
const { fetchLiveGames, TOURNAMENT_RE } = require('./scores');
const { startScheduler } = require('./scheduler');
const { loadSecretsFallback } = require('./lib/env');
const { USER_AGENT, NCAA_USER_AGENT, SITE_HOST } = require('./lib/constants');

loadSecretsFallback();

const { version: APP_VERSION } = require('./package.json');
const _releasesData = require('./releases.json');

// ── In-memory caches ──────────────────────────────────────────────────────────
const _espnGameCache       = new Map(); // espnEventId → {data, expiresAt}
const _espnScoreboardCache = new Map(); // yyyymmdd    → {data, expiresAt}
const _ncaaConfigCache     = { data: null, expiresAt: 0 };
const _ncaaSectionCache    = { data: null, expiresAt: 0 };
const _ncaaBracketCache    = new Map(); // sectionId  → {data, expiresAt}
const _cfStatsCache        = new Map(); // `${days}`  → {data, expiresAt}

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
    headers: { 'User-Agent': NCAA_USER_AGENT },
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

// Fetch the full ESPN college-baseball scoreboard for a given date (YYYYMMDD).
// Past dates cached 24 h; today cached 60 s (games may still be live).
async function _fetchEspnScoreboard(yyyymmdd) {
  const now = Date.now();
  const cached = _espnScoreboardCache.get(yyyymmdd);
  if (cached && cached.expiresAt > now) return cached.data;

  const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball/scoreboard?dates=${yyyymmdd}`;
  const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 10000 });
  if (!r.ok) throw new Error(`ESPN scoreboard HTTP ${r.status}`);
  const events = (await r.json()).events || [];

  const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const ttl = yyyymmdd === todayStr ? 60_000 : 24 * 60 * 60 * 1000;
  _espnScoreboardCache.set(yyyymmdd, { data: events, expiresAt: now + ttl });
  return events;
}

// Match an NCAA bracket game to an ESPN event using the full scoreboard.
// Uses section title (e.g., "Lincoln") from the ESPN game's notes field
// to narrow to the right regional before doing time + team name matching.
function _matchNcaaToEspnFull(ncaaGame, espnEvents, sectionTitle) {
  if (!ncaaGame.startTimeEpoch) return null;
  for (const event of espnEvents) {
    const notes = (event.competitions?.[0]?.notes || []).map(n => n.headline || '').join(' ');
    if (sectionTitle && !notes.toLowerCase().includes(sectionTitle.toLowerCase())) continue;
    const eventTs = Math.floor(new Date(event.date).getTime() / 1000);
    // Use 2-hour window: ESPN and NCAA may disagree on scheduled time (delays, rescheduling).
    // The section-title filter keeps false positives negligible even with a wide window.
    if (Math.abs(eventTs - ncaaGame.startTimeEpoch) >= 7200) continue;
    const teams = (event.competitions?.[0]?.competitors || [])
      .map(c => c.team?.displayName || '').join(' ').toLowerCase();
    const words = (ncaaGame.teams || []).flatMap(t => _ncaaNameWords(t.nameShort));
    if (words.length > 0 && words.some(w => teams.includes(w.toLowerCase()))) return event.id;
  }
  return null;
}

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
      headers: { 'User-Agent': USER_AGENT },
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
      headers: { 'User-Agent': NCAA_USER_AGENT },
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
    const r = await fetch(url, { headers: { 'User-Agent': NCAA_USER_AGENT }, timeout: 15000 });
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
      headers: { 'User-Agent': NCAA_USER_AGENT },
      timeout: 15000,
    });
    if (!r.ok) throw new Error(`NCAA GraphQL HTTP ${r.status}`);
    const data = await r.json();
    const games = data?.data?.championshipGames || [];

    // Determine which dates are represented in this bracket (NCAA startDate: "MM/DD/YYYY")
    const dateSet = new Set();
    for (const g of games) {
      if (g.startDate) {
        const [m, d, y] = g.startDate.split('/');
        if (y && m && d) dateSet.add(`${y}${m.padStart(2, '0')}${d.padStart(2, '0')}`);
      }
    }
    // Also always include today so live games are found
    dateSet.add(new Date().toISOString().slice(0, 10).replace(/-/g, ''));

    // Fetch full ESPN scoreboards for those dates
    const scoreboardEvents = [];
    for (const yyyymmdd of dateSet) {
      try { scoreboardEvents.push(...await _fetchEspnScoreboard(yyyymmdd)); } catch {}
    }

    const sectionTitle = games[0]?.section?.title || '';

    // Live-games cross-ref (fast, real-time ASU games) + full scoreboard (all regional games)
    let liveGames = [];
    try { liveGames = (await fetchLiveGames()).games || []; } catch {}

    const augmented = games.map(g => ({
      ...g,
      espnEventId: matchNcaaToEspn(g, liveGames) ?? _matchNcaaToEspnFull(g, scoreboardEvents, sectionTitle),
    }));
    _ncaaBracketCache.set(sectionId, { data: augmented, expiresAt: now + 60 * 1000 });
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

    const escIcs = s => (s || '').replace(/[\\;,]/g, c => '\\' + c).replace(/\n/g, '\\n');

    const foldLine = line => {
      const bytes = Buffer.from(line, 'utf8');
      if (bytes.length <= 75) return line;
      const parts = [line.slice(0, 75)];
      let pos = 75;
      while (pos < line.length) {
        parts.push(' ' + line.slice(pos, pos + 74));
        pos += 74;
      }
      return parts.join('\r\n');
    };

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ASU Sun Devil Athletics//Schedule//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:ASU Sun Devil Athletics',
      'X-WR-TIMEZONE:America/Phoenix',
      'X-WR-CALDESC:Arizona State University athletics schedule',
    ];

    for (const e of events) {
      if (!e.start_date) continue;

      const dtStart = new Date(e.start_date * 1000);
      const dtEnd   = e.end_date
        ? new Date(e.end_date * 1000)
        : new Date(e.start_date * 1000 + 3 * 60 * 60 * 1000);

      const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

      const uid = `${e.id}@${SITE_HOST}`;
      const summary = e.title || 'ASU Athletics';
      const location = [e.location_name, e.venue_address, e.city, e.state]
        .filter(Boolean).join(', ');
      const description = [
        e.sport      ? `Sport: ${e.sport}`                    : null,
        e.game_type  ? `Type: ${e.game_type}`                  : null,
        e.tv_network ? `TV: ${e.tv_network}`                   : null,
        e.result     ? `Result: ${e.result} ${e.asu_score}-${e.opp_score}` : null,
        e.ticket_url ? `Tickets: ${e.ticket_url}`              : null,
      ].filter(Boolean).join('\n');

      lines.push('BEGIN:VEVENT');
      lines.push(foldLine(`UID:${uid}`));
      lines.push(foldLine(`DTSTART:${fmt(dtStart)}`));
      lines.push(foldLine(`DTEND:${fmt(dtEnd)}`));
      lines.push(foldLine(`SUMMARY:${escIcs(summary)}`));
      if (location)    lines.push(foldLine(`LOCATION:${escIcs(location)}`));
      if (description) lines.push(foldLine(`DESCRIPTION:${escIcs(description)}`));
      if (e.sport)     lines.push(foldLine(`CATEGORIES:${escIcs(e.sport)}`));
      lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');

    const body = lines.join('\r\n') + '\r\n';
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
  const now      = Date.now();
  const cached   = _cfStatsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return res.json(cached.data);

  const endDate   = new Date().toISOString().slice(0, 10);
  const startDate = new Date(now - (days - 1) * 86400000).toISOString().slice(0, 10);

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
    _cfStatsCache.set(cacheKey, { data, expiresAt: now + 10 * 60 * 1000 }); // 10-min TTL
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
