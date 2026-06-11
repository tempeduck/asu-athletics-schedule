const fetch = require('node-fetch');
const { upsertMany } = require('./db');
const { USER_AGENT } = require('./lib/constants');

const FEED_URL = 'https://sundevils.com/feeds/json/node/wmt_events';

const STATE_MAP = {
  AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California',
  CO:'Colorado', CT:'Connecticut', DE:'Delaware', FL:'Florida', GA:'Georgia',
  HI:'Hawaii', ID:'Idaho', IL:'Illinois', IN:'Indiana', IA:'Iowa',
  KS:'Kansas', KY:'Kentucky', LA:'Louisiana', ME:'Maine', MD:'Maryland',
  MA:'Massachusetts', MI:'Michigan', MN:'Minnesota', MS:'Mississippi', MO:'Missouri',
  MT:'Montana', NE:'Nebraska', NV:'Nevada', NH:'New Hampshire', NJ:'New Jersey',
  NM:'New Mexico', NY:'New York', NC:'North Carolina', ND:'North Dakota', OH:'Ohio',
  OK:'Oklahoma', OR:'Oregon', PA:'Pennsylvania', RI:'Rhode Island', SC:'South Carolina',
  SD:'South Dakota', TN:'Tennessee', TX:'Texas', UT:'Utah', VT:'Vermont',
  VA:'Virginia', WA:'Washington', WV:'West Virginia', WI:'Wisconsin', WY:'Wyoming',
  DC:'Washington D.C.'
};

function parseAddress(address) {
  if (!address) return { city: null, state: null, country: 'USA' };

  const parts = address.split(',').map(s => s.trim());
  if (parts.length < 3) return { city: null, state: null, country: 'USA' };

  const city = parts[parts.length - 2];
  const lastPart = parts[parts.length - 1].trim();
  const stateAbbr = lastPart.split(' ')[0].toUpperCase();
  const state = STATE_MAP[stateAbbr] || stateAbbr || null;

  return { city, state, country: 'USA' };
}

function parseEvent(raw) {
  const { city, state, country } = parseAddress(raw.venue_address);

  const locations = Array.isArray(raw.locations) && raw.locations.length > 0
    ? raw.locations[0]
    : (typeof raw.locations === 'string' ? raw.locations : null);

  return {
    id: String(raw.id),
    title: raw.title || null,
    sport: raw.sport_tag || null,
    season: raw.season ? String(raw.season) : null,
    start_date: raw.start_date ? Number(raw.start_date) : null,
    end_date: raw.end_date ? Number(raw.end_date) : null,
    location_name: locations,
    venue_address: raw.venue_address || null,
    city,
    state,
    country,
    game_type: raw.game_type || null,
    event_type: raw.field_event_type || null,
    tv_network: raw.tv_network || null,
    ticket_url: raw.ticketing_rsvp_url || null,
    ticket_label: raw.ticketing_rsvp_txt || null,
    opponent_logo: raw.opponent_logo || null,
    badges: raw.badges_event || null,
    image_url: raw.image_url || null,
    node_url: raw.node_url || null,
    updated_at: Date.now(),
  };
}

async function fetchAndStore() {
  console.log(`[fetcher] Fetching from ${FEED_URL}`);
  const res = await fetch(FEED_URL, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 30000,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} from ASU feed`);

  const data = await res.json();
  const raw = Array.isArray(data) ? data : (data.data || data.events || Object.values(data));

  if (!Array.isArray(raw) || raw.length === 0) throw new Error('No events found in feed response');

  const events = raw.map(parseEvent).filter(e => e.id && e.start_date);
  upsertMany(events);

  console.log(`[fetcher] Upserted ${events.length} events`);
  return events.length;
}

module.exports = { fetchAndStore };
