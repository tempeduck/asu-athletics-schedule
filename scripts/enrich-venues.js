// scripts/enrich-venues.js
// One-time script to backfill venue_address, city, state, lat, lng
// for the 75 away events missing coordinates.
// Run with: node scripts/enrich-venues.js

const fetch = require('node-fetch');
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../events.db'));
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const UA = 'ASU-Athletics-Calendar/1.0';

const SPORT_ESPN_PATH = {
  'Baseball':   'baseball/college-baseball',
  'Softball':   'baseball/college-softball',
  'Football':   'football/college-football',
  'Ice Hockey': 'hockey/mens-college-hockey',
  'Volleyball': 'volleyball/womens-college-volleyball',
};

// Hardcoded for the 5 non-ESPN softball events (Texas & Texas A&M)
const HARDCODED = {
  // Sun Devil Softball: Arizona State at Texas (McCombs Field, Austin TX)
  '353521': { lat: 30.2808552, lng: -97.7247851, city: 'Austin', state: 'Texas', venue: 'Red and Charline McCombs Field' },
  '353526': { lat: 30.2808552, lng: -97.7247851, city: 'Austin', state: 'Texas', venue: 'Red and Charline McCombs Field' },
  '353701': { lat: 30.2808552, lng: -97.7247851, city: 'Austin', state: 'Texas', venue: 'Red and Charline McCombs Field' },
  // Sun Devil Softball: Arizona State at Texas A&M (Davis Diamond, College Station TX)
  '353456': { lat: 30.6027809, lng: -96.3460585, city: 'College Station', state: 'Texas', venue: 'Davis Diamond Softball Stadium' },
  '353506': { lat: 30.6027809, lng: -96.3460585, city: 'College Station', state: 'Texas', venue: 'Davis Diamond Softball Stadium' },
};

const updateFull = db.prepare(
  'UPDATE events SET venue_address=@venue_address, city=@city, state=@state, lat=@lat, lng=@lng WHERE id=@id'
);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function nominatim(query) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, timeout: 10000 });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = await res.json();
  return data.length ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) } : null;
}

async function espnVenue(espnId, sport) {
  const espnPath = SPORT_ESPN_PATH[sport];
  if (!espnPath) return null;
  const url = `${ESPN_BASE}/${espnPath}/summary?event=${espnId}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, timeout: 10000 });
    if (!res.ok) return null;
    const data = await res.json();
    const venue = data?.gameInfo?.venue;
    if (!venue) return null;
    const name = venue.fullName || null;
    const city = venue.address?.city || null;
    const state = venue.address?.state || null;
    return { name, city, state };
  } catch { return null; }
}

// STATE_MAP for full state name lookup (ESPN sometimes returns abbreviations)
const STATE_MAP = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',
  CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',
  HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',
  KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',
  MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',
  MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
  NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',
  OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
  SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',
  VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
  DC:'Washington D.C.'
};

function fullState(s) {
  if (!s) return null;
  if (s.length === 2) return STATE_MAP[s.toUpperCase()] || s;
  return s; // already full name
}

async function main() {
  // Get all away events missing lat
  const events = db.prepare(
    `SELECT id, sport, venue_address, city, state, lat FROM events
     WHERE game_type = 'away' AND lat IS NULL`
  ).all();

  console.log(`[enrich] ${events.length} away events missing lat/lng`);
  let ok = 0, fail = 0;
  let nominatimCallCount = 0;

  for (const ev of events) {
    // --- Hardcoded (non-ESPN softball) ---
    if (HARDCODED[ev.id]) {
      const h = HARDCODED[ev.id];
      updateFull.run({
        id: ev.id,
        venue_address: `${h.venue}, ${h.city}, ${h.state}`,
        city: h.city,
        state: h.state,
        lat: h.lat,
        lng: h.lng,
      });
      console.log(`[enrich] HARDCODED ${ev.id} → ${h.venue}, ${h.city}`);
      ok++;
      continue;
    }

    // --- ESPN-ID events ---
    if (ev.id.startsWith('espn_')) {
      const espnId = ev.id.replace('espn_', '');
      const venue = await espnVenue(espnId, ev.sport);
      await sleep(300); // be polite to ESPN

      if (!venue || !venue.city) {
        console.warn(`[enrich] No ESPN venue for ${ev.id} (${ev.sport})`);
        fail++;
        continue;
      }

      const stateFullName = fullState(venue.state);
      const geoQuery = venue.name
        ? `${venue.name}, ${venue.city}, ${venue.state}`
        : `${venue.city}, ${venue.state}`;

      if (nominatimCallCount > 0) await sleep(1100); // 1 req/sec Nominatim policy
      nominatimCallCount++;

      const coords = await nominatim(geoQuery);

      if (!coords) {
        // Fallback: try city+state only
        await sleep(1100);
        nominatimCallCount++;
        const fallback = await nominatim(`${venue.city}, ${venue.state}`);
        if (fallback) {
          updateFull.run({
            id: ev.id,
            venue_address: geoQuery,
            city: venue.city,
            state: stateFullName,
            lat: fallback.lat,
            lng: fallback.lng,
          });
          console.log(`[enrich] OK (city fallback) ${ev.id} → ${venue.city}, ${venue.state}`);
          ok++;
        } else {
          console.warn(`[enrich] FAILED ${ev.id} — ${geoQuery}`);
          fail++;
        }
        continue;
      }

      updateFull.run({
        id: ev.id,
        venue_address: geoQuery,
        city: venue.city,
        state: stateFullName,
        lat: coords.lat,
        lng: coords.lng,
      });
      console.log(`[enrich] OK ${ev.id} → ${geoQuery} (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`);
      ok++;
      continue;
    }

    console.warn(`[enrich] Unknown ID format, skipping: ${ev.id}`);
    fail++;
  }

  console.log(`\n[enrich] Done — ${ok} enriched, ${fail} failed`);
  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
