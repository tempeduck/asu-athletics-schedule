// Conference standings + poll rankings from ESPN, with rank annotation for
// /api/live games and /api/events rows. Rankings have no public endpoint of
// their own: the server merges oppRank/opp_rank fields in so the frontend
// never joins polls client-side. Annotation must never add ESPN latency to
// the hot 30s live-poll path, hence getRankIndexSync(): it returns a cached
// index or kicks off a background refresh and returns null — the first
// request after expiry simply goes out un-annotated.
const fetch = require('node-fetch');
const { TtlCache } = require('./cache');
const { USER_AGENT } = require('./constants');
const { STANDINGS_CONFIG, RANKINGS_SLUGS } = require('./sports-config');
const { opponentFromTitle } = require('./opponent');

const STANDINGS_TTL = 60 * 60 * 1000;      // games move tables at most daily
const RANKINGS_TTL = 6 * 60 * 60 * 1000;   // polls update weekly
const ERROR_TTL = 5 * 60 * 1000;           // transient ESPN failures retry sooner

const standingsCache = new TtlCache();   // dbSport -> result object
const rankingsCache = new TtlCache();    // dbSport -> {poll, occurrence, teams} | null
const rankIndexCache = new TtlCache();   // dbSport -> Map(normName -> rank) | null
const _inflight = new Set();

async function _fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 10000,
  });
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  return res.json();
}

function _stat(entry, type) {
  return (entry.stats || []).find(s => s.type === type);
}

function _statDisp(entry, type) {
  return _stat(entry, type)?.displayValue ?? null;
}

function _statVal(entry, type) {
  return _stat(entry, type)?.value ?? null;
}

function _mapEntry(entry) {
  const team = entry.team || {};
  return {
    teamId: team.id ?? null,
    name: team.shortDisplayName || team.displayName || team.location || '?',
    logo: team.logos?.[0]?.href || null,
    overall: _statDisp(entry, 'total'),
    conf: _stat(entry, 'vsconf')?.summary ?? null,
    confPct: _statDisp(entry, 'leaguewinpercent'),
    streak: _statDisp(entry, 'streak'),
    gamesBehind: _statDisp(entry, 'gamesbehind'),
    isASU: team.location === 'Arizona State',
  };
}

async function _fetchStandings(dbSport, cfg) {
  const url = `https://site.api.espn.com/apis/v2/sports/${cfg.espnPath}/standings?group=${cfg.groupId}`;
  const data = await _fetchJson(url);

  let entries;
  if (cfg.childId) {
    const child = (data.children || []).find(c => String(c.id) === String(cfg.childId));
    entries = child?.standings?.entries || [];
  } else {
    entries = data.standings?.entries || [];
  }
  // Seed when ESPN provides it (basketball/football), else conference win pct.
  const seeded = entries.some(e => _statVal(e, 'playoffseed') != null);
  entries = entries.slice().sort(seeded
    ? (a, b) => (_statVal(a, 'playoffseed') ?? 99) - (_statVal(b, 'playoffseed') ?? 99)
    : (a, b) => (_statVal(b, 'leaguewinpercent') ?? -1) - (_statVal(a, 'leaguewinpercent') ?? -1));

  return {
    sport: dbSport,
    available: true,
    conference: cfg.conference,
    season: data.season?.year ?? null,
    seasonDisplayName: data.season?.displayName ?? null,
    isFinal: data.seasonType === 3,
    entries: entries.map(_mapEntry),
    fetchedAt: Date.now(),
  };
}

// Returns null only for sports unknown to STANDINGS_CONFIG (caller 400s);
// configured-but-unavailable sports get { available: false }.
async function getStandings(dbSport) {
  const cfg = STANDINGS_CONFIG[dbSport];
  if (cfg === undefined) return null;
  if (cfg === null) return { sport: dbSport, available: false, entries: [] };

  const hit = standingsCache.get(dbSport);
  if (hit !== undefined) return hit;

  try {
    const result = await _fetchStandings(dbSport, cfg);
    standingsCache.set(dbSport, result, STANDINGS_TTL);
    return result;
  } catch (err) {
    console.error(`[standings] ${dbSport}:`, err.message);
    const result = { sport: dbSport, available: false, entries: [], error: true };
    standingsCache.set(dbSport, result, ERROR_TTL);
    return result;
  }
}

async function getRankings(dbSport) {
  const slug = RANKINGS_SLUGS[dbSport];
  if (!slug) return null;

  const hit = rankingsCache.get(dbSport);
  if (hit !== undefined) return hit;

  try {
    const data = await _fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${slug}/rankings`);
    // First poll is the AP-equivalent (AP Top 25 / D1Baseball / AVCA);
    // later entries are coaches and lower-division polls we skip.
    const poll = data.rankings?.[0];
    let result = null;
    if (poll?.ranks?.length) {
      result = {
        poll: poll.shortName || poll.name,
        occurrence: poll.occurrence?.displayValue || null,
        teams: poll.ranks.map(r => ({
          id: r.team?.id ?? null,
          rank: r.current,
          location: r.team?.location || '',
          name: r.team?.name || '',
          nickname: r.team?.nickname || '',
          abbreviation: r.team?.abbreviation || '',
          recordSummary: r.recordSummary || '',
        })),
      };
    }
    rankingsCache.set(dbSport, result, RANKINGS_TTL);
    return result;
  } catch (err) {
    console.error(`[rankings] ${dbSport}:`, err.message);
    rankingsCache.set(dbSport, null, ERROR_TTL);
    return null;
  }
}

function _normName(s) {
  return String(s || '').toLowerCase()
    .replace(/[.'’&()]/g, '')
    .replace(/\bst\b/g, 'state')
    .replace(/\s+/g, ' ')
    .trim();
}

function _buildIndex(rankings) {
  const index = new Map();
  for (const t of rankings.teams) {
    for (const key of [
      _normName(t.location),
      _normName(`${t.location} ${t.name}`),
      _normName(t.nickname),
      _normName(t.abbreviation),
    ]) {
      if (key && !index.has(key)) index.set(key, t.rank);
    }
  }
  return index;
}

// "X State"/"X Tech" are never the same school as "X": shortening across
// these words is how "Kansas State" would falsely inherit Kansas's rank.
const _SHORTEN_STOP_WORDS = new Set(['state', 'tech', 'am']);

function lookupRank(index, name) {
  if (!index || !name) return null;
  let key = _normName(name);
  if (!key) return null;
  if (index.has(key)) return index.get(key);
  // Progressively drop trailing words (mascot suffixes etc.), same strategy
  // as espnLogoUrl in public/shared.js. Short keys only match exactly above.
  for (;;) {
    const i = key.lastIndexOf(' ');
    if (i === -1) return null;
    if (_SHORTEN_STOP_WORDS.has(key.slice(i + 1))) return null;
    key = key.slice(0, i);
    if (key.length > 3 && index.has(key)) return index.get(key);
  }
}

// Non-blocking: cached index or null. A miss fires one background refresh
// (deduped) so a later request gets annotated.
function getRankIndexSync(dbSport) {
  if (!RANKINGS_SLUGS[dbSport]) return null;
  const hit = rankIndexCache.get(dbSport);
  if (hit !== undefined) return hit;
  if (!_inflight.has(dbSport)) {
    _inflight.add(dbSport);
    getRankings(dbSport)
      .then(r => rankIndexCache.set(dbSport, r ? _buildIndex(r) : null, r ? RANKINGS_TTL : ERROR_TTL))
      .catch(err => console.error(`[rankings] index ${dbSport}:`, err.message))
      .finally(() => _inflight.delete(dbSport));
  }
  return null;
}

// Mutates /api/live game objects in place (oppRank/asuRank).
function annotateGames(games) {
  for (const game of games || []) {
    const index = getRankIndexSync(game.sport);
    if (!index) continue;
    game.oppRank = lookupRank(index, game.oppAbbr) ?? lookupRank(index, game.oppName);
    game.asuRank = lookupRank(index, 'Arizona State');
  }
  return games;
}

// Mutates /api/events rows in place (opp_rank). Only rows starting after
// sinceTs get annotated — current polls are meaningless on last season's rows.
function annotateEvents(events, { sinceTs = 0 } = {}) {
  for (const e of events || []) {
    if (!e || !e.start_date || e.start_date < sinceTs) continue;
    const index = getRankIndexSync(e.sport);
    if (!index) continue;
    const rank = lookupRank(index, opponentFromTitle(e.title));
    if (rank) e.opp_rank = rank;
  }
  return events;
}

module.exports = {
  getStandings,
  getRankings,
  getRankIndexSync,
  lookupRank,
  annotateGames,
  annotateEvents,
};
