const Database = require('better-sqlite3');
const path = require('path');

const REGIONS = {
  'Southwest':         ['Arizona', 'New Mexico', 'Texas', 'Oklahoma'],
  'West':              ['California', 'Nevada', 'Utah', 'Colorado'],
  'Pacific Northwest': ['Washington', 'Oregon', 'Idaho'],
  'Midwest':           ['Illinois', 'Ohio', 'Indiana', 'Michigan', 'Wisconsin', 'Minnesota', 'Iowa', 'Missouri', 'Kansas', 'Nebraska', 'North Dakota', 'South Dakota'],
  'Southeast':         ['Florida', 'Georgia', 'Alabama', 'Mississippi', 'Tennessee', 'South Carolina', 'North Carolina', 'Virginia', 'Kentucky', 'Arkansas', 'Louisiana'],
  'Northeast':         ['New York', 'Pennsylvania', 'New Jersey', 'Connecticut', 'Massachusetts', 'Rhode Island', 'Vermont', 'New Hampshire', 'Maine', 'Maryland', 'Delaware', 'District of Columbia', 'West Virginia'],
  'Mountain':          ['Montana', 'Wyoming', 'Idaho'],
  'Hawaii/Alaska':     ['Hawaii', 'Alaska'],
};

const db = new Database(path.join(__dirname, 'events.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS feedback (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_at INTEGER NOT NULL,
    page         TEXT,
    rating       INTEGER,
    message      TEXT,
    user_agent   TEXT,
    read         INTEGER NOT NULL DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    title TEXT,
    sport TEXT,
    season TEXT,
    start_date INTEGER,
    end_date INTEGER,
    location_name TEXT,
    venue_address TEXT,
    city TEXT,
    state TEXT,
    country TEXT,
    game_type TEXT,
    event_type TEXT,
    tv_network TEXT,
    ticket_url TEXT,
    ticket_label TEXT,
    opponent_logo TEXT,
    badges TEXT,
    image_url TEXT,
    node_url TEXT,
    updated_at INTEGER
  )
`);

// Migrate: add columns if they don't exist yet
const existingCols = db.prepare('PRAGMA table_info(events)').all().map(c => c.name);
if (!existingCols.includes('asu_score'))  db.exec('ALTER TABLE events ADD COLUMN asu_score TEXT');
if (!existingCols.includes('opp_score'))  db.exec('ALTER TABLE events ADD COLUMN opp_score TEXT');
if (!existingCols.includes('result'))     db.exec('ALTER TABLE events ADD COLUMN result TEXT');
if (!existingCols.includes('lat'))        db.exec('ALTER TABLE events ADD COLUMN lat REAL');
if (!existingCols.includes('lng'))        db.exec('ALTER TABLE events ADD COLUMN lng REAL');
if (!existingCols.includes('push_sent'))       db.exec('ALTER TABLE events ADD COLUMN push_sent INTEGER NOT NULL DEFAULT 0');
if (!existingCols.includes('final_push_sent')) db.exec('ALTER TABLE events ADD COLUMN final_push_sent INTEGER NOT NULL DEFAULT 0');
if (!existingCols.includes('game_status'))     db.exec('ALTER TABLE events ADD COLUMN game_status TEXT');

// ── Push subscription tables ──────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint    TEXT UNIQUE NOT NULL,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    sport_prefs TEXT,
    created_at  INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS game_subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
    event_id        TEXT NOT NULL REFERENCES events(id),
    created_at      INTEGER NOT NULL,
    UNIQUE(subscription_id, event_id)
  )
`);

const upsertEvent = db.prepare(`
  INSERT INTO events (
    id, title, sport, season, start_date, end_date,
    location_name, venue_address, city, state, country,
    game_type, event_type, tv_network, ticket_url, ticket_label,
    opponent_logo, badges, image_url, node_url, updated_at
  ) VALUES (
    @id, @title, @sport, @season, @start_date, @end_date,
    @location_name, @venue_address, @city, @state, @country,
    @game_type, @event_type, @tv_network, @ticket_url, @ticket_label,
    @opponent_logo, @badges, @image_url, @node_url, @updated_at
  )
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    sport = excluded.sport,
    season = excluded.season,
    start_date = excluded.start_date,
    end_date = excluded.end_date,
    location_name = excluded.location_name,
    venue_address = excluded.venue_address,
    city = excluded.city,
    state = excluded.state,
    country = excluded.country,
    game_type = excluded.game_type,
    event_type = excluded.event_type,
    tv_network = excluded.tv_network,
    ticket_url = excluded.ticket_url,
    ticket_label = excluded.ticket_label,
    opponent_logo = excluded.opponent_logo,
    badges = excluded.badges,
    image_url = excluded.image_url,
    node_url = excluded.node_url,
    updated_at = excluded.updated_at
`);

const upsertMany = db.transaction((events) => {
  for (const event of events) upsertEvent.run(event);
});

function queryEvents({ sport, game_type, city, state, region, from, to, season } = {}) {
  const conditions = [];
  const params = {};

  if (sport) {
    conditions.push('sport = @sport');
    params.sport = sport;
  }
  if (game_type) {
    conditions.push('game_type = @game_type');
    params.game_type = game_type;
  }
  if (season) {
    conditions.push('season = @season');
    params.season = season;
  }
  if (city) {
    conditions.push('city = @city');
    params.city = city;
  }
  if (state) {
    conditions.push('state = @state');
    params.state = state;
  } else if (region && REGIONS[region]) {
    const regionStates = REGIONS[region];
    const placeholders = regionStates.map((_, i) => `@rs${i}`).join(', ');
    conditions.push(`state IN (${placeholders})`);
    regionStates.forEach((s, i) => { params[`rs${i}`] = s; });
  }
  if (from) {
    conditions.push('start_date >= @from');
    params.from = Number(from);
  }
  if (to) {
    conditions.push('start_date <= @to');
    params.to = Number(to);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM events ${where} ORDER BY start_date ASC`).all(params);
}

function getSeasons() {
  // Exclude cross-year compound seasons (e.g. '2025_26', '2026_27') — they have no
  // completed results and are confusing; individual year seasons already cover them.
  return db.prepare(
    "SELECT DISTINCT season FROM events WHERE season IS NOT NULL AND instr(season, '_') = 0 ORDER BY season DESC"
  ).all().map(r => r.season);
}

function getRecordsBySeason() {
  // For each sport, use the most recent season that has completed results.
  // This handles sports whose seasons straddle the calendar year boundary
  // (e.g. Football ends in '2025', Baseball is in '2026').
  const rows = db.prepare(`
    WITH best_season AS (
      SELECT sport, MAX(season) as season
      FROM events
      WHERE result IS NOT NULL AND season IS NOT NULL
      GROUP BY sport
    )
    SELECT e.sport,
      SUM(CASE WHEN e.result = 'W' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN e.result = 'L' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN e.result = 'T' THEN 1 ELSE 0 END) as ties,
      bs.season as season
    FROM events e
    JOIN best_season bs ON e.sport = bs.sport AND e.season = bs.season
    WHERE e.result IS NOT NULL
    GROUP BY e.sport
    ORDER BY e.sport
  `).all();

  const overall = rows.reduce(
    (acc, r) => ({ w: acc.w + r.wins, l: acc.l + r.losses, t: acc.t + r.ties }),
    { w: 0, l: 0, t: 0 }
  );

  // Pick the most common season across sports to derive the display label.
  const seasonCounts = {};
  for (const r of rows) seasonCounts[r.season] = (seasonCounts[r.season] || 0) + 1;
  const dominantSeason = Object.entries(seasonCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  function seasonDisplayLabel(s) {
    if (!s) return 'Current Season';
    const yr = parseInt(s.split('_')[0]);
    if (isNaN(yr)) return s;
    return `${yr - 1}–${String(yr).slice(2)} Season Record`;
  }
  const label = seasonDisplayLabel(dominantSeason);

  return { overall, bySport: rows, label };
}

function getSports() {
  return db.prepare('SELECT DISTINCT sport FROM events WHERE sport IS NOT NULL ORDER BY sport').all().map(r => r.sport);
}

function getLocations() {
  const rows = db.prepare('SELECT DISTINCT city, state FROM events WHERE city IS NOT NULL ORDER BY state, city').all();
  return rows;
}

function getEventCount() {
  return db.prepare('SELECT COUNT(*) as count FROM events').get().count;
}

const updateScoreStmt = db.prepare(`
  UPDATE events SET asu_score = @asu_score, opp_score = @opp_score, result = @result
  WHERE id = @id
`);

function updateScore(id, asu_score, opp_score, result) {
  updateScoreStmt.run({ id, asu_score, opp_score, result });
}

const upsertESPNEventStmt = db.prepare(`
  INSERT INTO events (
    id, title, sport, season, start_date, end_date,
    location_name, venue_address, city, state, country,
    game_type, event_type, tv_network, ticket_url, ticket_label,
    opponent_logo, badges, image_url, node_url, updated_at,
    asu_score, opp_score, result
  ) VALUES (
    @id, @title, @sport, @season, @start_date, @end_date,
    @location_name, @venue_address, @city, @state, @country,
    @game_type, @event_type, @tv_network, @ticket_url, @ticket_label,
    @opponent_logo, @badges, @image_url, @node_url, @updated_at,
    @asu_score, @opp_score, @result
  )
  ON CONFLICT(id) DO UPDATE SET
    title      = excluded.title,
    asu_score  = excluded.asu_score,
    opp_score  = excluded.opp_score,
    result     = excluded.result,
    updated_at = excluded.updated_at
`);

function upsertESPNEvent(event) {
  upsertESPNEventStmt.run(event);
}

function getEventsNeedingGeocode() {
  return db.prepare(
    'SELECT id, venue_address, location_name, game_type FROM events WHERE lat IS NULL AND (venue_address IS NOT NULL OR (city IS NOT NULL AND state IS NOT NULL))'
  ).all();
}

const updateCoordinatesStmt = db.prepare('UPDATE events SET lat = @lat, lng = @lng WHERE id = @id');
function updateCoordinates(id, lat, lng) {
  updateCoordinatesStmt.run({ id, lat, lng });
}

const insertFeedbackStmt = db.prepare(`
  INSERT INTO feedback (submitted_at, page, rating, message, user_agent)
  VALUES (@submitted_at, @page, @rating, @message, @user_agent)
`);

function insertFeedback({ page, rating, message, user_agent }) {
  const result = insertFeedbackStmt.run({ submitted_at: Date.now(), page: page ?? null, rating: rating ?? null, message: message ?? null, user_agent: user_agent ?? null });
  return result.lastInsertRowid;
}

function getUnreadCount() {
  return db.prepare('SELECT COUNT(*) as count FROM feedback WHERE read=0').get().count;
}

function getAllFeedback(limit = 50, offset = 0) {
  const total = db.prepare('SELECT COUNT(*) as count FROM feedback').get().count;
  const unread = db.prepare('SELECT COUNT(*) as count FROM feedback WHERE read=0').get().count;
  const items = db.prepare('SELECT * FROM feedback ORDER BY submitted_at DESC LIMIT @limit OFFSET @offset').all({ limit, offset });
  return { total, unread, items };
}

function markRead(id) {
  return db.prepare('UPDATE feedback SET read=1 WHERE id=@id').run({ id }).changes;
}

function markAllRead() {
  return db.prepare('UPDATE feedback SET read=1 WHERE read=0').run().changes;
}

function deleteFeedback(id) {
  return db.prepare('DELETE FROM feedback WHERE id=@id').run({ id }).changes;
}

// ── Push subscription helpers ─────────────────────────────────────────────────

const _upsertPushSubStmt = db.prepare(`
  INSERT INTO push_subscriptions (endpoint, p256dh, auth, sport_prefs, created_at)
  VALUES (@endpoint, @p256dh, @auth, @sport_prefs, @created_at)
  ON CONFLICT(endpoint) DO UPDATE SET
    p256dh      = CASE WHEN excluded.p256dh != '' THEN excluded.p256dh ELSE p256dh END,
    auth        = CASE WHEN excluded.auth   != '' THEN excluded.auth   ELSE auth   END,
    sport_prefs = excluded.sport_prefs
`);

function upsertPushSubscription(endpoint, p256dh, auth, sportPrefs) {
  _upsertPushSubStmt.run({
    endpoint,
    p256dh: p256dh || '',
    auth:   auth   || '',
    sport_prefs: sportPrefs != null ? JSON.stringify(sportPrefs) : null,
    created_at: Math.floor(Date.now() / 1000),
  });
}

function deletePushSubscription(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = @endpoint').run({ endpoint });
}

const _addGameSubStmt = db.prepare(`
  INSERT OR IGNORE INTO game_subscriptions (subscription_id, event_id, created_at)
  SELECT id, @event_id, @created_at FROM push_subscriptions WHERE endpoint = @endpoint
`);

function addGameSubscription(endpoint, eventId) {
  _addGameSubStmt.run({ endpoint, event_id: eventId, created_at: Math.floor(Date.now() / 1000) });
}

function removeGameSubscription(endpoint, eventId) {
  db.prepare(`
    DELETE FROM game_subscriptions WHERE event_id = @event_id
    AND subscription_id = (SELECT id FROM push_subscriptions WHERE endpoint = @endpoint)
  `).run({ event_id: eventId, endpoint });
}

function getGameSubscribers(eventId) {
  return db.prepare(`
    SELECT ps.endpoint, ps.p256dh, ps.auth
    FROM push_subscriptions ps
    JOIN game_subscriptions gs ON gs.subscription_id = ps.id
    WHERE gs.event_id = @event_id
  `).all({ event_id: eventId });
}

function cleanupExpiredSubscriptions() {
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const deleted = db.prepare(`
    DELETE FROM game_subscriptions
    WHERE event_id IN (SELECT id FROM events WHERE start_date < @cutoff)
  `).run({ cutoff }).changes;

  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
  const orphans = db.prepare(`
    DELETE FROM push_subscriptions
    WHERE created_at < @cutoff
    AND id NOT IN (SELECT DISTINCT subscription_id FROM game_subscriptions)
  `).run({ cutoff: thirtyDaysAgo }).changes;

  return { deleted, orphans };
}

function getEventsPendingPush() {
  const now = Math.floor(Date.now() / 1000);
  const windowEnd = now + 20 * 60;
  return db.prepare(`
    SELECT * FROM events
    WHERE start_date >= @now AND start_date <= @windowEnd AND push_sent = 0
  `).all({ now, windowEnd });
}

function markPushSent(eventId) {
  db.prepare('UPDATE events SET push_sent = 1 WHERE id = @id').run({ id: eventId });
}

function getEventById(id) {
  return db.prepare('SELECT * FROM events WHERE id = @id').get({ id });
}

function updateGameStatus(id, status) {
  db.prepare('UPDATE events SET game_status = @status WHERE id = @id').run({ id, status });
}

function markFinalPushSent(eventId) {
  db.prepare('UPDATE events SET final_push_sent = 1 WHERE id = @id').run({ id: eventId });
}

function getEndedGamesWithSubscribers() {
  return db.prepare(`
    SELECT e.id, e.title, e.sport, e.asu_score, e.opp_score, e.result, e.game_type
    FROM events e
    WHERE e.result IS NOT NULL
      AND e.final_push_sent = 0
      AND EXISTS (SELECT 1 FROM game_subscriptions gs WHERE gs.event_id = e.id)
  `).all();
}

module.exports = { upsertMany, queryEvents, getSports, getSeasons, getRecordsBySeason, getLocations, getEventCount, updateScore, upsertESPNEvent, getEventsNeedingGeocode, updateCoordinates, REGIONS, insertFeedback, getUnreadCount, getAllFeedback, markRead, markAllRead, deleteFeedback, upsertPushSubscription, deletePushSubscription, addGameSubscription, removeGameSubscription, getGameSubscribers, cleanupExpiredSubscriptions, getEventsPendingPush, markPushSent, getEventById, updateGameStatus, markFinalPushSent, getEndedGamesWithSubscribers };
