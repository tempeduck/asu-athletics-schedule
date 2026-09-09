const fetch = require('node-fetch');
const { TtlCache } = require('./cache');
const { USER_AGENT } = require('./constants');
const { ESPN_SPORT_SLUGS } = require('./sports-config');

const teamsCache = new TtlCache();
const summaryCache = new TtlCache();
const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 10000 });
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  return res.json();
}
async function resolveTeam(slug, name) {
  const key = `teams:${slug}`;
  let teams = teamsCache.get(key);
  if (teams === undefined) {
    const data = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${slug}/teams?limit=1000`);
    teams = (data.sports || []).flatMap(s => s.leagues || []).flatMap(l => l.teams || []).map(x => x.team).filter(Boolean);
    teamsCache.set(key, teams, 24 * 60 * 60 * 1000);
  }
  const wanted = norm(name);
  return teams.find(t => [t.displayName, t.shortDisplayName, t.location, `${t.location} ${t.name}`].some(v => norm(v) === wanted)) || null;
}
function eventRow(event, teamId) {
  const comp = event.competitions?.[0];
  const teams = comp?.competitors || [];
  const mine = teams.find(c => String(c.team?.id) === String(teamId));
  const opp = teams.find(c => c !== mine);
  return { date: event.date || null, opponent: opp?.team?.displayName || '', opponentLogo: opp?.team?.logo || null,
    score: mine?.score?.displayValue ?? mine?.score ?? null, opponentScore: opp?.score?.displayValue ?? opp?.score ?? null,
    state: comp?.status?.type?.state || 'pre', detail: comp?.status?.type?.shortDetail || '' };
}
async function getTeamSummary(sport, teamId, name) {
  const slug = ESPN_SPORT_SLUGS[sport] || (sport === 'Ice Hockey' ? 'hockey/mens-college-hockey' : null);
  if (!slug) return { available: false, reason: 'Season summaries are not available for this sport.' };
  let id = /^\d{1,20}$/.test(String(teamId || '')) ? String(teamId) : null;
  if (!id) id = (await resolveTeam(slug, name))?.id;
  if (!id) return { available: false, reason: 'This school was not found in the current ESPN season.' };
  const key = `${slug}:${id}`; const hit = summaryCache.get(key); if (hit !== undefined) return hit;
  const base = `https://site.api.espn.com/apis/site/v2/sports/${slug}/teams/${id}`;
  const [info, schedule] = await Promise.all([getJson(base), getJson(`${base}/schedule`)]);
  const team = info.team || schedule.team || {};
  const result = { available: true, sport, id, name: team.displayName || name || 'Team', logo: team.logos?.[0]?.href || team.logo || null,
    record: team.record?.items?.find(r => r.type === 'total')?.summary || team.record?.items?.[0]?.summary || 'Record unavailable',
    season: schedule.season?.displayName || '', games: (schedule.events || []).slice(-8).map(e => eventRow(e, id)) };
  summaryCache.set(key, result, 5 * 60 * 1000); return result;
}
module.exports = { getTeamSummary };
