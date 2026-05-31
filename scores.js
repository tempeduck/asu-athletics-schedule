const fetch = require('node-fetch');
const { updateScore, upsertESPNEvent, queryEvents } = require('./db');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// Sports for schedule sync (teamId required for team-schedule endpoint)
const SPORT_CONFIG = [
  { dbSport: 'Baseball',   espnPath: 'baseball/college-baseball',            teamId: '59',  fallSport: false },
  { dbSport: 'Softball',   espnPath: 'baseball/college-softball',            teamId: '471', fallSport: false },
  { dbSport: 'Football',   espnPath: 'football/college-football',            teamId: '9',   fallSport: true  },
  { dbSport: 'Ice Hockey', espnPath: 'hockey/mens-college-hockey',           teamId: '9',   fallSport: false },
  { dbSport: 'Volleyball', espnPath: 'volleyball/womens-college-volleyball', teamId: '9',   fallSport: true  },
];

// Additional sports polled for live data only (scoreboard doesn't need teamId)
const LIVE_EXTRA_SPORTS = [
  { dbSport: "Men's Basketball",   espnPath: 'basketball/mens-college-basketball',  fallSport: false },
  { dbSport: "Women's Basketball", espnPath: 'basketball/womens-college-basketball', fallSport: false },
  { dbSport: "Women's Soccer",     espnPath: 'soccer/womens-college-soccer',         fallSport: true  },
  { dbSport: "Men's Soccer",       espnPath: 'soccer/mens-college-soccer',           fallSport: true  },
];

const ALL_LIVE_CONFIGS = [...SPORT_CONFIG, ...LIVE_EXTRA_SPORTS];

const TOURNAMENT_RE = /regional|super\s*regional|tournament|playoff|championship|ncaa|bracket|semifinal|final\s*four|postseason/i;

function getSeason(fallSport) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  return (fallSport && month < 7) ? year - 1 : year;
}

async function fetchESPNSchedule(espnPath, teamId, season) {
  const url = `${ESPN_BASE}/${espnPath}/teams/${teamId}/schedule?season=${season}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ASU-Athletics-Calendar/1.0' },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  const data = await res.json();
  return data.events || [];
}

function extractScore(espnEvent) {
  const comp = espnEvent.competitions?.[0];
  if (!comp?.status?.type?.completed) return null;

  const asuComp = comp.competitors?.find(c =>
    c.team?.displayName?.toLowerCase().includes('arizona state')
  );
  const oppComp = comp.competitors?.find(c =>
    !c.team?.displayName?.toLowerCase().includes('arizona state')
  );
  if (!asuComp || !oppComp) return null;

  const asuScore = asuComp.score?.displayValue ?? String(asuComp.score ?? '');
  const oppScore = oppComp.score?.displayValue ?? String(oppComp.score ?? '');
  if (!asuScore || !oppScore) return null;

  const result = asuComp.winner === true ? 'W' : oppComp.winner === true ? 'L' : 'T';
  return {
    asu_score: asuScore,
    opp_score: oppScore,
    result,
    espnOppName: oppComp.team?.displayName || '',
    espnOppDisplay: (oppComp.team?.displayName || '').toLowerCase(),
    espnOppAbbr: (oppComp.team?.abbreviation || '').toLowerCase(),
    espnOppLogo: oppComp.team?.logo || null,
    homeAway: asuComp.homeAway || 'home',
    neutralSite: comp.neutralSite === true,
  };
}

function opponentFromTitle(title) {
  const clean = title.replace(/^[^:]+:\s*/i, '');
  const vsM = clean.match(/arizona\s+state\s+vs\.?\s+(.+)/i);
  if (vsM) return vsM[1].trim().toLowerCase();
  const asuAtM = clean.match(/arizona\s+state\s+at\s+(.+)/i);
  if (asuAtM) return asuAtM[1].trim().toLowerCase();
  const oppAtM = clean.match(/^(.+?)\s+at\s+arizona\s+state/i);
  if (oppAtM) return oppAtM[1].trim().toLowerCase();
  return null;
}

function opponentMatches(dbOpp, espnDisplay, espnAbbr) {
  if (!dbOpp) return false;
  if (espnAbbr && dbOpp.includes(espnAbbr)) return true;
  const words = espnDisplay.split(/\s+/).filter(w => w.length > 3);
  return words.some(w => dbOpp.includes(w));
}

function findDBMatch(scoreData, dbEvents, espnDate) {
  const espnDay = espnDate.toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });

  const sameDay = dbEvents.filter(db => {
    const dbDay = new Date(db.start_date * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
    return dbDay === espnDay;
  });

  if (sameDay.length === 0) return null;
  if (sameDay.length === 1) return sameDay[0];

  const withOpp = sameDay.filter(db => {
    const dbOpp = opponentFromTitle(db.title || '');
    return opponentMatches(dbOpp, scoreData.espnOppDisplay, scoreData.espnOppAbbr);
  });
  if (withOpp.length === 1) return withOpp[0];

  // Fallback: match by espn_{id} record created from a previous scoreboard sync
  if (scoreData.espnEventId) {
    const byEspnId = dbEvents.find(db => db.id === `espn_${scoreData.espnEventId}`);
    if (byEspnId) return byEspnId;
  }

  return null;
}

function buildESPNEvent(espnEvent, sport, scoreData) {
  const oppName = scoreData.espnOppName;
  const gameType = scoreData.neutralSite ? 'neutral'
    : scoreData.homeAway === 'home' ? 'home' : 'away';
  const title = scoreData.homeAway === 'away'
    ? `Arizona State at ${oppName}`
    : `Arizona State vs. ${oppName}`;
  const startDate = Math.floor(new Date(espnEvent.date).getTime() / 1000);

  return {
    id: `espn_${espnEvent.id}`,
    title,
    sport,
    season: String(new Date(espnEvent.date).getFullYear()),
    start_date: startDate,
    end_date: null,
    location_name: null,
    venue_address: null,
    city: null,
    state: null,
    country: null,
    game_type: gameType,
    event_type: 'Game',
    tv_network: null,
    ticket_url: null,
    ticket_label: null,
    opponent_logo: scoreData.espnOppLogo,
    badges: null,
    image_url: null,
    node_url: null,
    updated_at: Date.now(),
    asu_score: scoreData.asu_score,
    opp_score: scoreData.opp_score,
    result: scoreData.result,
  };
}

async function fetchLiveScoreboard(espnPath) {
  const url = `${ESPN_BASE}/${espnPath}/scoreboard`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ASU-Athletics-Calendar/1.0' },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  const data = await res.json();
  return data.events || [];
}

// Extract sport-specific situational details from ESPN competition object.
function extractSportDetails(comp, sport) {
  const status = comp.status || {};
  const situation = comp.situation || {};
  const base = {
    period: status.period || 0,
    clock: status.displayClock || '',
    shortDetail: status.type?.shortDetail || '',
  };

  if (sport === 'Football') {
    return {
      ...base,
      quarter: status.period,
      gameClock: status.displayClock,
      down: situation.down ?? null,
      distance: situation.distance ?? null,
      yardLine: situation.yardsToEndzone ?? null,
      possession: situation.possession ?? null,
      isRedZone: situation.isRedZone ?? false,
      homeTimeouts: situation.homeTimeouts ?? null,
      awayTimeouts: situation.awayTimeouts ?? null,
      downDistanceText: situation.shortDownDistanceText || null,
      possessionText: situation.possessionText || null,
      // FALLBACK: ESPN summary endpoint /summary?event={id} for additional detail
    };
  }

  if (sport === 'Baseball' || sport === 'Softball') {
    return {
      ...base,
      inning: status.period,
      isTop: (status.type?.shortDetail || '').toLowerCase().startsWith('top'),
      balls: situation.balls ?? null,
      strikes: situation.strikes ?? null,
      outs: situation.outs ?? null,
      onFirst: !!situation.onFirst,
      onSecond: !!situation.onSecond,
      onThird: !!situation.onThird,
      // FALLBACK: NCAA casablanca /scoreboard/baseball/d1/{year}/{week}/scoreboard.json
    };
  }

  if (sport === "Men's Basketball" || sport === "Women's Basketball") {
    return {
      ...base,
      half: status.period,
      gameClock: status.displayClock,
      // FALLBACK: shot clock not in ESPN scoreboard; wire in ESPN summary endpoint for shot clock
      shotClock: null,
    };
  }

  if (sport === "Women's Soccer" || sport === "Men's Soccer" || sport === 'Soccer') {
    return {
      ...base,
      minute: status.displayClock,
      half: status.period,
    };
  }

  // Generic fallback for all other sports (volleyball, hockey, etc.)
  return base;
}

function getNextGame() {
  const nowTs = Math.floor(Date.now() / 1000);
  const upcoming = queryEvents({ from: nowTs });
  if (!upcoming.length) return null;
  const next = upcoming[0];
  return {
    id: next.id,
    title: next.title,
    sport: next.sport,
    startTime: next.start_date,
    location: [next.city, next.state].filter(Boolean).join(', ') || next.location_name || null,
    tvNetwork: next.tv_network || null,
    gameType: next.game_type || null,
    opponent_logo: next.opponent_logo || null,
  };
}

// ── Tournament bracket helpers ────────────────────────────────────────────────

function extractRoundName(summaryData, game) {
  const notes = summaryData?.header?.competitions?.[0]?.notes || [];
  for (const note of notes) {
    const text = note.headline || note.text || '';
    if (text) return text;
  }
  return game.espnNotes || 'Tournament';
}

function buildBracketTeam(compData, fallbackGame, isASU) {
  if (compData) {
    return {
      name: compData.team?.displayName || (isASU ? 'Arizona State' : 'TBD'),
      abbr: compData.team?.abbreviation || (isASU ? 'ASU' : 'TBD'),
      logo: compData.team?.logos?.[0]?.href || compData.team?.logo || null,
      seed: compData.curatedRank?.current ?? null,
      score: compData.score?.displayValue ?? (compData.score != null ? String(compData.score) : null),
      winner: compData.winner === true ? true : compData.winner === false ? false : null,
      isASU,
    };
  }
  if (isASU) {
    return {
      name: 'Arizona State', abbr: 'ASU', logo: null, seed: null,
      score: fallbackGame?.asuScore ?? null,
      winner: fallbackGame?.state === 'final' ? (fallbackGame?.asuWinner === true) : null,
      isASU: true,
    };
  }
  return {
    name: fallbackGame?.oppName || 'TBD',
    abbr: fallbackGame?.oppAbbr || 'TBD',
    logo: fallbackGame?.oppLogo || null,
    seed: null,
    score: fallbackGame?.oppScore ?? null,
    winner: fallbackGame?.state === 'final' ? (fallbackGame?.asuWinner === false) : null,
    isASU: false,
  };
}

function inferRounds(games) {
  const matchups = games.map(g => ({
    id: g.espnEventId || `m-${Date.now()}-${Math.random()}`,
    teamA: buildBracketTeam(null, g, true),
    teamB: buildBracketTeam(null, g, false),
    state: g.state === 'live' ? 'in' : g.state === 'upcoming' ? 'pre' : 'post',
    startTime: g.startTime,
    situation: g.situation || '',
  }));
  return [{ name: 'Tournament', matchups }];
}

function buildBracketRoundsFromSummaries(group, summaries) {
  const summaryMap = {};
  for (const s of summaries) summaryMap[s.gameId] = s.data;

  const ROUND_ORDER = ['regional', 'super regional', 'college world series', 'semifinal', 'final', 'championship'];
  const roundMap = {};

  for (const g of group.games) {
    const summary = summaryMap[g.espnEventId];
    const roundName = extractRoundName(summary, g);
    if (!roundMap[roundName]) roundMap[roundName] = { name: roundName, matchups: [] };

    const comp = summary?.header?.competitions?.[0];
    const competitors = comp?.competitors || [];
    const asuComp = competitors.find(c => c.team?.displayName?.toLowerCase().includes('arizona state'));
    const oppComp = competitors.find(c => !c.team?.displayName?.toLowerCase().includes('arizona state'));

    const rawState = comp?.status?.type?.state;
    const state = rawState === 'in' ? 'in' : rawState === 'pre' ? 'pre' : rawState === 'post' ? 'post'
      : (g.state === 'live' ? 'in' : g.state === 'upcoming' ? 'pre' : 'post');

    roundMap[roundName].matchups.push({
      id: g.espnEventId || `m-${Date.now()}`,
      teamA: buildBracketTeam(asuComp, g, true),
      teamB: buildBracketTeam(oppComp, g, false),
      state,
      startTime: g.startTime,
      situation: g.situation || '',
    });
  }

  return Object.values(roundMap).sort((a, b) => {
    const ai = ROUND_ORDER.findIndex(r => a.name.toLowerCase().includes(r));
    const bi = ROUND_ORDER.findIndex(r => b.name.toLowerCase().includes(r));
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

function buildSeriesTournament(group, summaries) {
  const summaryMap = {};
  for (const s of summaries) summaryMap[s.gameId] = s.data;

  const seriesGames = group.games.map(g => {
    const series = summaryMap[g.espnEventId]?.header?.competitions?.[0]?.series;
    return { ...g, gameNumber: series?.gameNumber ?? null, maxGames: series?.maxGames ?? null };
  }).sort((a, b) => (a.gameNumber ?? 999) - (b.gameNumber ?? 999) || a.startTime - b.startTime);

  return { ...group, format: 'series', rounds: [], standings: [], seriesGames, bracketReady: true };
}

async function fetchPoolStandings(espnPath) {
  const url = `${ESPN_BASE}/${espnPath}/scoreboard?groups=50`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ASU-Athletics-Calendar/1.0' },
    timeout: 10000,
  });
  if (!res.ok) return null;
  const data = await res.json();
  const entries = data.standings?.entries || data.standings?.groups?.[0]?.entries || [];
  if (!entries.length) return null;

  return entries.map((entry, i) => {
    const stats = entry.stats || [];
    const getStat = name => stats.find(s => s.name === name)?.displayValue ?? '-';
    return {
      rank: entry.team?.rank ?? i + 1,
      name: entry.team?.displayName || 'Unknown',
      abbr: entry.team?.abbreviation || '',
      logo: entry.team?.logos?.[0]?.href || null,
      w: getStat('wins'),
      l: getStat('losses'),
      pct: getStat('winPercent'),
      gb: getStat('gamesBehind'),
      isASU: (entry.team?.displayName || '').toLowerCase().includes('arizona state'),
    };
  });
}

async function buildTournaments(games) {
  const tournamentGames = games.filter(g => g.isTournament);
  if (!tournamentGames.length) return [];

  const groups = {};
  for (const g of tournamentGames) {
    const key = g.espnNotes ? `${g.sport}:${g.espnNotes}` : `${g.sport}:tournament`;
    if (!groups[key]) {
      groups[key] = { id: key, sport: g.sport, name: g.espnNotes || `${g.sport} Tournament`, games: [] };
    }
    groups[key].games.push(g);
  }

  const results = [];

  for (const group of Object.values(groups)) {
    group.games.sort((a, b) => a.startTime - b.startTime);

    const cfg = ALL_LIVE_CONFIGS.find(c => c.dbSport === group.sport);
    if (!cfg) {
      console.warn(`[live] No ESPN config for sport ${group.sport}, using inferred bracket`);
      results.push({ ...group, format: 'bracket', rounds: inferRounds(group.games), standings: [], seriesGames: [], bracketReady: true });
      continue;
    }

    // Fetch ESPN summaries for each tournament game to get round/series context
    const summaries = [];
    for (const g of group.games) {
      if (!g.espnEventId) continue;
      try {
        const url = `${ESPN_BASE}/${cfg.espnPath}/summary?event=${g.espnEventId}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'ASU-Athletics-Calendar/1.0' },
          timeout: 10000,
        });
        if (res.ok) summaries.push({ gameId: g.espnEventId, data: await res.json() });
      } catch (err) {
        console.error(`[live] Summary fetch failed for event ${g.espnEventId}:`, err.message);
      }
    }

    // Series format: ESPN reports maxGames > 1 on the competition
    const hasSeries = summaries.some(s => {
      const series = s.data?.header?.competitions?.[0]?.series;
      return series?.maxGames > 1;
    });
    if (hasSeries) {
      results.push(buildSeriesTournament(group, summaries));
      continue;
    }

    // Pool format: try groups endpoint for standings
    let standings = null;
    try {
      standings = await fetchPoolStandings(cfg.espnPath);
    } catch (err) {
      console.error(`[live] Pool standings fetch failed for ${group.sport}:`, err.message);
    }
    if (standings && standings.length > 0) {
      results.push({ ...group, format: 'pool', rounds: [], standings, seriesGames: [], bracketReady: true });
      continue;
    }

    // Bracket format: build rounds from summaries (or infer from game list if all fetches failed)
    const rounds = summaries.length
      ? buildBracketRoundsFromSummaries(group, summaries)
      : inferRounds(group.games);

    results.push({ ...group, format: 'bracket', rounds, standings: [], seriesGames: [], bracketReady: true });
  }

  return results;
}

async function detectActiveTournaments() {
  const nowTs = Math.floor(Date.now() / 1000);
  const candidates = queryEvents({ from: nowTs - 86400, to: nowTs + 14 * 86400 })
    .filter(e =>
      TOURNAMENT_RE.test(e.title || '') ||
      TOURNAMENT_RE.test(e.badges || '') ||
      TOURNAMENT_RE.test(e.location_name || '')
    );

  if (!candidates.length) return [];

  function deriveTournamentName(sport, event) {
    const text = `${event.title || ''} ${event.badges || ''} ${event.location_name || ''}`;
    const m = text.match(/ncaa\s+(?:super\s+regional|regional|tournament|championship)|super\s+regional|college\s+world\s+series|regional|championship|tournament/i);
    return m ? m[0].replace(/\s+/g, ' ').trim() : `${sport} Tournament`;
  }

  function oppNameFromTitle(title) {
    if (!title) return 'Opponent';
    const clean = title.replace(/^[^:]+:\s*/i, '');
    const vsM = clean.match(/arizona\s+state\s+vs\.?\s+(.+)/i);
    if (vsM) return vsM[1].trim();
    const asuAtM = clean.match(/arizona\s+state\s+at\s+(.+)/i);
    if (asuAtM) return asuAtM[1].trim();
    const oppAtM = clean.match(/^(.+?)\s+at\s+arizona\s+state/i);
    if (oppAtM) return oppAtM[1].trim();
    return 'Opponent';
  }

  const groups = {};
  for (const event of candidates) {
    const name = deriveTournamentName(event.sport, event);
    const key = `${event.sport}:${name}`;
    if (!groups[key]) {
      groups[key] = { id: `db:${key}`, sport: event.sport, name, events: [] };
    }
    groups[key].events.push(event);
  }

  const results = [];

  for (const group of Object.values(groups)) {
    group.events.sort((a, b) => a.start_date - b.start_date);

    const games = group.events.map(event => ({
      espnEventId: null,
      dbEventId: event.id,
      sport: event.sport,
      title: event.title,
      state: event.start_date < nowTs ? 'final' : 'upcoming',
      asuScore: event.asu_score || null,
      oppScore: event.opp_score || null,
      asuWinner: event.result === 'W',
      oppName: oppNameFromTitle(event.title),
      oppLogo: event.opponent_logo || null,
      oppAbbr: '',
      situation: event.result ? `Final: ${event.asu_score}–${event.opp_score}` : '',
      sportDetails: {},
      location: event.location_name || null,
      city: event.city || null,
      stateAbbr: event.state || null,
      tvNetwork: event.tv_network || null,
      startTime: event.start_date,
      isTournament: true,
      espnNotes: '',
      source: 'DB',
    }));

    const cfg = ALL_LIVE_CONFIGS.find(c => c.dbSport === group.sport);
    if (!cfg) {
      results.push({ id: group.id, sport: group.sport, name: group.name, format: 'bracket', rounds: inferRounds(games), standings: [], seriesGames: [], games, bracketReady: false });
      continue;
    }

    let standings = null;
    try {
      standings = await fetchPoolStandings(cfg.espnPath);
    } catch (err) {
      console.error(`[live] DB-detected pool fetch failed for ${group.sport}:`, err.message);
    }
    if (standings && standings.length > 0) {
      results.push({ id: group.id, sport: group.sport, name: group.name, format: 'pool', rounds: [], standings, seriesGames: [], games, bracketReady: false });
      continue;
    }

    results.push({ id: group.id, sport: group.sport, name: group.name, format: 'bracket', rounds: inferRounds(games), standings: [], seriesGames: [], games, bracketReady: false });
  }

  return results;
}

async function fetchLiveGames() {
  const games = [];

  for (const cfg of ALL_LIVE_CONFIGS) {
    let scoreboard;
    try {
      scoreboard = await fetchLiveScoreboard(cfg.espnPath);
    } catch (err) {
      console.error(`[live] ${cfg.dbSport}: scoreboard fetch failed:`, err.message);
      continue;
    }

    const dbEvents = queryEvents({ sport: cfg.dbSport });

    for (const espnEvent of scoreboard) {
      const comp = espnEvent.competitions?.[0];
      if (!comp) continue;

      // Only include ASU games
      const asuComp = comp.competitors?.find(c =>
        c.team?.displayName?.toLowerCase().includes('arizona state')
      );
      if (!asuComp) continue;

      const oppComp = comp.competitors?.find(c =>
        !c.team?.displayName?.toLowerCase().includes('arizona state')
      );

      const state = comp.status?.type?.state;
      if (!state || !['in', 'pre', 'post'].includes(state)) continue;

      // Include today's games (all states) and completed games within the past 24 hours.
      // The 24h window keeps final scores visible after midnight without letting
      // off-season scoreboards (e.g. football) flood the feed with upcoming games.
      const todayPhoenix = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
      const gameDay = new Date(espnEvent.date).toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
      const isToday = gameDay === todayPhoenix;
      const isRecentFinal = state === 'post' && (Date.now() - new Date(espnEvent.date).getTime()) < 24 * 60 * 60 * 1000;
      if (!isToday && !isRecentFinal) continue;

      // Auto-update completed games in DB while we have the data
      if (state === 'post') {
        const scoreData = extractScore(espnEvent);
        if (scoreData) {
          const dbMatch = findDBMatch(scoreData, dbEvents, new Date(espnEvent.date));
          if (dbMatch && (dbMatch.result !== scoreData.result ||
              dbMatch.asu_score !== scoreData.asu_score ||
              dbMatch.opp_score !== scoreData.opp_score)) {
            updateScore(dbMatch.id, scoreData.asu_score, scoreData.opp_score, scoreData.result);
            console.log(`[live] Auto-updated completed game: ${dbMatch.title}`);
          }
        }
      }

      const gameState = state === 'in' ? 'live' : state === 'pre' ? 'upcoming' : 'final';
      const asuScore = asuComp.score?.displayValue ?? String(asuComp.score ?? '0');
      const oppScore = oppComp?.score?.displayValue ?? String(oppComp?.score ?? '0');
      const oppName = oppComp?.team?.displayName || 'Opponent';
      const oppLogo = oppComp?.team?.logo || null;
      const oppAbbr = oppComp?.team?.abbreviation || '';

      const matchKey = {
        espnOppDisplay: oppName.toLowerCase(),
        espnOppAbbr: oppAbbr.toLowerCase(),
        espnEventId: espnEvent.id,
      };
      const dbMatch = findDBMatch(matchKey, dbEvents, new Date(espnEvent.date));

      const title = dbMatch?.title || (asuComp.homeAway === 'away'
        ? `Arizona State at ${oppName}`
        : `Arizona State vs. ${oppName}`);

      const sportDetails = extractSportDetails(comp, cfg.dbSport);
      const situation = comp.status?.type?.shortDetail || comp.status?.type?.description || '';
      const notes = (espnEvent.notes || []).map(n => n.headline || '').join(' ');

      const isTournament = TOURNAMENT_RE.test(title) ||
        TOURNAMENT_RE.test(dbMatch?.badges || '') ||
        TOURNAMENT_RE.test(notes);

      const venue = comp.venue;
      const broadcast = comp.broadcasts?.[0]?.names?.[0]
        || comp.geoBroadcasts?.[0]?.media?.shortName
        || dbMatch?.tv_network
        || null;

      games.push({
        espnEventId: espnEvent.id,
        dbEventId: dbMatch?.id ?? null,
        sport: cfg.dbSport,
        title,
        state: gameState,
        asuScore: gameState !== 'upcoming' ? asuScore : null,
        oppScore: gameState !== 'upcoming' ? oppScore : null,
        asuWinner: asuComp.winner === true,
        oppName,
        oppLogo,
        oppAbbr,
        situation,
        sportDetails,
        location: venue?.fullName || dbMatch?.location_name || null,
        city: venue?.address?.city || dbMatch?.city || null,
        stateAbbr: venue?.address?.state || dbMatch?.state || null,
        tvNetwork: broadcast,
        startTime: Math.floor(new Date(espnEvent.date).getTime() / 1000),
        isTournament,
        espnNotes: notes,
        source: 'ESPN',
      });
    }
  }

  const liveTournaments = await buildTournaments(games);

  let dbTournaments = [];
  try {
    dbTournaments = await detectActiveTournaments();
  } catch (err) {
    console.error('[live] detectActiveTournaments failed:', err.message);
  }

  const liveKeys = new Set(liveTournaments.map(t => t.sport));
  const tournaments = [
    ...liveTournaments,
    ...dbTournaments.filter(t => !liveKeys.has(t.sport)),
  ];

  return { games, tournaments };
}

async function fetchAndStoreScores() {
  let updated = 0;
  let inserted = 0;

  for (const cfg of SPORT_CONFIG) {
    const season = getSeason(cfg.fallSport);
    console.log(`[scores] ${cfg.dbSport}: fetching ESPN season ${season}`);

    let espnEvents;
    try {
      espnEvents = await fetchESPNSchedule(cfg.espnPath, cfg.teamId, season);
    } catch (err) {
      console.error(`[scores] ${cfg.dbSport}: ESPN fetch failed:`, err.message);
      continue;
    }

    const completed = espnEvents.filter(e =>
      e.competitions?.[0]?.status?.type?.completed
    );
    console.log(`[scores] ${cfg.dbSport}: ${completed.length} completed from ESPN`);

    const dbEvents = queryEvents({ sport: cfg.dbSport });

    for (const espnEvent of completed) {
      const scoreData = extractScore(espnEvent);
      if (!scoreData) continue;

      const espnDate = new Date(espnEvent.date);
      const dbMatch = findDBMatch(scoreData, dbEvents, espnDate);

      if (dbMatch) {
        if (dbMatch.result === scoreData.result &&
            dbMatch.asu_score === scoreData.asu_score &&
            dbMatch.opp_score === scoreData.opp_score) continue;
        updateScore(dbMatch.id, scoreData.asu_score, scoreData.opp_score, scoreData.result);
        updated++;
      } else {
        upsertESPNEvent(buildESPNEvent(espnEvent, cfg.dbSport, scoreData));
        inserted++;
      }
    }
  }

  console.log(`[scores] Updated ${updated}, inserted ${inserted} ESPN events`);
  return { updated, inserted };
}

module.exports = { fetchAndStoreScores, fetchLiveGames, TOURNAMENT_RE };
