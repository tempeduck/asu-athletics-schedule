// ESPN team news (merged across sports) and per-sport rosters.
// News: one fetch per TEAM_CONFIG sport, merged and deduped — the same
// league-wide story is tagged to ASU in several sports' feeds. Sports whose
// feeds error or return nothing just contribute zero articles.
// Rosters: ESPN returns two shapes — grouped position buckets with items[]
// (football) or a flat athletes[] (basketball/hockey).
const fetch = require('node-fetch');
const { TtlCache } = require('./cache');
const { USER_AGENT } = require('./constants');
const { TEAM_CONFIG, SPORT_EMOJI } = require('./sports-config');

const NEWS_TTL = 15 * 60 * 1000;
const ROSTER_TTL = 24 * 60 * 60 * 1000;
const ERROR_TTL = 5 * 60 * 1000;

const newsCache = new TtlCache();
const rosterCache = new TtlCache();

async function _fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 10000,
  });
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  return res.json();
}

async function getNews() {
  const hit = newsCache.get('all');
  if (hit !== undefined) return hit;

  const perSport = await Promise.allSettled(
    Object.entries(TEAM_CONFIG).map(async ([sport, cfg]) => {
      const data = await _fetchJson(
        `https://site.api.espn.com/apis/site/v2/sports/${cfg.espnPath}/news?team=${cfg.teamId}&limit=6`);
      return (data.articles || []).map(a => ({
        sport,
        emoji: SPORT_EMOJI[sport] || '🔱',
        headline: a.headline || '',
        description: a.description || '',
        published: a.published || null,
        link: a.links?.web?.href || null,
        type: a.type || '',
      }));
    }),
  );

  const seen = new Set();
  const articles = perSport
    .flatMap(r => (r.status === 'fulfilled' ? r.value : []))
    .filter(a => {
      const key = a.link || a.headline;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0))
    .slice(0, 10);

  const result = { articles, fetchedAt: Date.now() };
  newsCache.set('all', result, articles.length ? NEWS_TTL : ERROR_TTL);
  return result;
}

function _mapAthlete(a) {
  return {
    name: a.fullName || a.displayName || '',
    jersey: a.jersey ?? null,
    position: a.position?.abbreviation || null,
    classYear: a.experience?.displayName || null,
    height: a.displayHeight || null,
    weight: a.displayWeight || null,
  };
}

const _GROUP_LABELS = {
  offense: 'Offense',
  defense: 'Defense',
  specialTeam: 'Special Teams',
};

// Returns null only for sports unknown to TEAM_CONFIG (caller 400s).
async function getRoster(dbSport) {
  const cfg = TEAM_CONFIG[dbSport];
  if (!cfg) return null;
  if (!cfg.roster) return { sport: dbSport, available: false, groups: [] };

  const hit = rosterCache.get(dbSport);
  if (hit !== undefined) return hit;

  try {
    const data = await _fetchJson(
      `https://site.api.espn.com/apis/site/v2/sports/${cfg.espnPath}/teams/${cfg.teamId}/roster`);
    let groups;
    if (data.athletes?.[0]?.items) {
      groups = data.athletes
        .map(g => ({
          label: _GROUP_LABELS[g.position] || g.position || null,
          players: (g.items || []).map(_mapAthlete),
        }))
        .filter(g => g.players.length);
    } else {
      groups = [{ label: null, players: (data.athletes || []).map(_mapAthlete) }];
    }
    groups.forEach(g => g.players.sort((a, b) => (parseInt(a.jersey, 10) || 999) - (parseInt(b.jersey, 10) || 999)));
    const available = groups.some(g => g.players.length);
    const result = {
      sport: dbSport,
      available,
      team: data.team?.displayName || 'Arizona State Sun Devils',
      groups: available ? groups : [],
      fetchedAt: Date.now(),
    };
    rosterCache.set(dbSport, result, available ? ROSTER_TTL : ERROR_TTL);
    return result;
  } catch (err) {
    console.error(`[roster] ${dbSport}:`, err.message);
    const result = { sport: dbSport, available: false, groups: [], error: true };
    rosterCache.set(dbSport, result, ERROR_TTL);
    return result;
  }
}

module.exports = { getNews, getRoster };
