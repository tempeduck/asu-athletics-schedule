const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { queryEvents, getSports, getLocations } = require('./db');
const { fetchAndStore } = require('./fetcher');
const { geocodeAllMissing } = require('./geocoder');
const { fetchLiveGames } = require('./scores');
const { startScheduler } = require('./scheduler');

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
    const games = await fetchLiveGames();
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
    } : null;
    res.json({ games, tournaments: [], nextGame });
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

app.post('/api/geocode', adminLimit, async (req, res) => {
  try {
    const result = await geocodeAllMissing();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[api] /api/geocode error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

startScheduler();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] ASU Athletics Calendar running at http://0.0.0.0:${PORT}`);
});
