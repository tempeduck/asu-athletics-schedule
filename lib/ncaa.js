// NCAA bracket integration: scrapes the ncaa.com bracket page for its
// GraphQL config (persisted-query SHAs, championshipId), finds ASU's
// regional section, and augments section games with matching ESPN event
// ids for box-score links. All TTLs match the previous in-route caches.
const fetch = require('node-fetch');
const { USER_AGENT, NCAA_USER_AGENT } = require('./constants');
const { TtlCache } = require('./cache');

const configCache     = new TtlCache(); // 'config'      → bracket config, 6 h
const sectionCache    = new TtlCache(); // 'asu-section' → {sectionId, sectionTitle}, 30 min
const bracketCache    = new TtlCache(); // sectionId     → augmented games, 60 s
const scoreboardCache = new TtlCache(); // yyyymmdd      → ESPN events, 60 s today / 24 h past

async function getNcaaConfig() {
  return configCache.getOrFetch('config', 6 * 60 * 60 * 1000, async () => {
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
    console.log(`[ncaa] Config loaded: championshipId=${championshipId}, gqlHost=${gqlHost}, sections=${regionalSections.length}`);
    return config;
  });
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
async function fetchEspnScoreboard(yyyymmdd) {
  const cached = scoreboardCache.get(yyyymmdd);
  if (cached !== undefined) return cached;

  const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball/scoreboard?dates=${yyyymmdd}`;
  const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 10000 });
  if (!r.ok) throw new Error(`ESPN scoreboard HTTP ${r.status}`);
  const events = (await r.json()).events || [];

  const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const ttl = yyyymmdd === todayStr ? 60_000 : 24 * 60 * 60 * 1000;
  scoreboardCache.set(yyyymmdd, events, ttl);
  return events;
}

// Match an NCAA bracket game to an ESPN event using the full scoreboard.
// Uses section title (e.g., "Lincoln") from the ESPN game's notes field
// to narrow to the right regional before doing time + team name matching.
function matchNcaaToEspnFull(ncaaGame, espnEvents, sectionTitle) {
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

async function _findAsuSection(config) {
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

async function getAsuSection() {
  return sectionCache.getOrFetch('asu-section', 30 * 60 * 1000, async () => {
    const config = await getNcaaConfig();
    return _findAsuSection(config);
  });
}

// Fetch a bracket section's games and augment each with a matching ESPN
// event id. getLiveGames is a lazy async provider (returns the games array)
// so the expensive live-scoreboard sweep only runs on cache miss.
async function getBracketSection(sectionId, getLiveGames) {
  const hit = bracketCache.get(sectionId);
  if (hit !== undefined) return hit;

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
    try { scoreboardEvents.push(...await fetchEspnScoreboard(yyyymmdd)); } catch {}
  }

  const sectionTitle = games[0]?.section?.title || '';

  // Live-games cross-ref (fast, real-time ASU games) + full scoreboard (all regional games)
  let liveGames = [];
  try { liveGames = (await getLiveGames()) || []; } catch {}

  const augmented = games.map(g => ({
    ...g,
    espnEventId: matchNcaaToEspn(g, liveGames) ?? matchNcaaToEspnFull(g, scoreboardEvents, sectionTitle),
  }));
  bracketCache.set(sectionId, augmented, 60 * 1000);
  return augmented;
}

module.exports = { getNcaaConfig, getAsuSection, getBracketSection };
