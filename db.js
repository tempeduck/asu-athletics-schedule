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
if (!existingCols.includes('asu_score')) db.exec('ALTER TABLE events ADD COLUMN asu_score TEXT');
if (!existingCols.includes('opp_score')) db.exec('ALTER TABLE events ADD COLUMN opp_score TEXT');
if (!existingCols.includes('result'))    db.exec('ALTER TABLE events ADD COLUMN result TEXT');
if (!existingCols.includes('lat'))       db.exec('ALTER TABLE events ADD COLUMN lat REAL');
if (!existingCols.includes('lng'))       db.exec('ALTER TABLE events ADD COLUMN lng REAL');

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

function queryEvents({ sport, game_type, city, state, region, from, to } = {}) {
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
    'SELECT id, venue_address, location_name, game_type FROM events WHERE venue_address IS NOT NULL AND lat IS NULL'
  ).all();
}

const updateCoordinatesStmt = db.prepare('UPDATE events SET lat = @lat, lng = @lng WHERE id = @id');
function updateCoordinates(id, lat, lng) {
  updateCoordinatesStmt.run({ id, lat, lng });
}

module.exports = { upsertMany, queryEvents, getSports, getLocations, getEventCount, updateScore, upsertESPNEvent, getEventsNeedingGeocode, updateCoordinates, REGIONS };
