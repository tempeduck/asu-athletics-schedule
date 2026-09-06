const fetch = require('node-fetch');
const { updateScore, updateLiveScore, upsertESPNEvent, queryEvents, updateGameStatus } = require('./db');
const { opponentFromTitle } = require('./lib/opponent');
const { USER_AGENT } = require('./lib/constants');
const { SPORT_CONFIG, ALL_LIVE_CONFIGS, TOURNAMENT_RE } = require('./lib/sports-config');
const { buildTournaments, detectActiveTournaments } = require('./lib/tournaments');
const { TtlCache } = require('./lib/cache');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

function getSeason(fallSport) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  return (fallSport && month < 7) ? year - 1 : year;
}

async function fetchESPNSchedule(espnPath, teamId, season) {
  const url = `${ESPN_BASE}/${espnPath}/teams/${teamId}/schedule?season=${season}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
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

function opponentMatches(dbOpp, espnDisplay, espnAbbr) {
  if (!dbOpp) return false;
  if (espnAbbr && dbOpp.includes(espnAbbr)) return true;
  const words = espnDisplay.split(/\s+/).filter(w => w.length > 3);
  return words.some(w => dbOpp.includes(w));
}

function findDBMatch(scoreData, dbEvents, espnDate) {
  // Strongest signal first: an espn_{id} row from a previous sync/auto-insert
  // is this exact game regardless of date shifts (reschedules, TBD times).
  if (scoreData.espnEventId) {
    const byEspnId = dbEvents.find(db => db.id === `espn_${scoreData.espnEventId}`);
    if (byEspnId) return byEspnId;
  }

  const espnDay = espnDate.toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });

  const sameDay = dbEvents.filter(db => {
    const dbDay = new Date(db.start_date * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
    return dbDay === espnDay;
  });
  if (sameDay.length === 0) return null;

  const withOpp = sameDay.filter(db => {
    const dbOpp = opponentFromTitle(db.title, { lowercase: true });
    return opponentMatches(dbOpp, scoreData.espnOppDisplay, scoreData.espnOppAbbr);
  });
  if (withOpp.length === 1) return withOpp[0];

  // Doubleheader: two same-day games vs the same opponent — take the one
  // whose start time is closest to ESPN's. If the feed left both on the
  // midnight placeholder they're indistinguishable; return null so the game
  // auto-inserts rather than risking writing game 2's score onto game 1.
  if (withOpp.length > 1) {
    const ts = Math.floor(espnDate.getTime() / 1000);
    const sorted = [...withOpp].sort((a, b) => Math.abs(a.start_date - ts) - Math.abs(b.start_date - ts));
    if (Math.abs(sorted[0].start_date - ts) !== Math.abs(sorted[1].start_date - ts)) return sorted[0];
    return null;
  }

  // No opponent-confirmed candidate. A lone same-day event is only trusted
  // when its opponent can't be parsed at all (legacy title shapes) — if it
  // parses to a DIFFERENT opponent, this is a different game (e.g. an ESPN
  // tournament game the feed never had) and matching it would write the
  // wrong score onto it.
  if (sameDay.length === 1 && opponentFromTitle(sameDay[0].title, { lowercase: true }) == null) {
    return sameDay[0];
  }

  return null;
}

function buildESPNEvent(espnEvent, sport, scoreData) {
  const comp = espnEvent.competitions?.[0];
  const venue = comp?.venue;
  const broadcast = comp?.broadcasts?.[0]?.names?.[0]
    || comp?.geoBroadcasts?.[0]?.media?.shortName
    || null;
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
    location_name: venue?.fullName || null,
    venue_address: null,
    city: venue?.address?.city || null,
    state: venue?.address?.state || null,
    country: null,
    game_type: gameType,
    event_type: 'Game',
    tv_network: broadcast,
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
  // ESPN's default football board omits games outside its featured selection.
  // Request the full FBS group so unranked ASU games reach both live consumers.
  const query = espnPath === 'football/college-football' ? '?groups=80' : '';
  const url = `${ESPN_BASE}/${espnPath}/scoreboard${query}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
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

// ── Live game helpers ─────────────────────────────────────────────────────────

// Include today's games (all states) and completed games within the past 24
// hours. The 24h window keeps final scores visible after midnight without
// letting off-season scoreboards (e.g. football) flood the feed with
// upcoming games.
function _isRelevantGame(espnEvent, comp) {
  const state = comp.status?.type?.state;
  if (!state || !['in', 'pre', 'post'].includes(state)) return false;

  const todayPhoenix = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
  // TBD games use a midnight-ish UTC placeholder that shifts the date back in western timezones.
  // Use the raw UTC date for those so "Jun 1 TBD" doesn't appear as May 31.
  const isTBDGame = comp.status?.type?.shortDetail === 'TBD';
  const gameDay = isTBDGame
    ? espnEvent.date.slice(0, 10)
    : new Date(espnEvent.date).toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
  const isToday = gameDay === todayPhoenix;
  const isRecentFinal = state === 'post' && (Date.now() - new Date(espnEvent.date).getTime()) < 24 * 60 * 60 * 1000;
  return isToday || isRecentFinal;
}

// Auto-update a completed game's final score + status in the DB while we
// have the scoreboard data in hand.
function _syncCompletedGame(espnEvent, dbEvents) {
  const scoreData = extractScore(espnEvent);
  if (!scoreData) return;
  scoreData.espnEventId = espnEvent.id; // enables the exact espn_{id} match
  const dbMatch = findDBMatch(scoreData, dbEvents, new Date(espnEvent.date));
  if (!dbMatch) return;
  if (dbMatch.result !== scoreData.result ||
      dbMatch.asu_score !== scoreData.asu_score ||
      dbMatch.opp_score !== scoreData.opp_score) {
    updateScore(dbMatch.id, scoreData.asu_score, scoreData.opp_score, scoreData.result);
    console.log(`[live] Auto-updated completed game: ${dbMatch.title}`);
  }
  if (dbMatch.game_status !== 'post') {
    updateGameStatus(dbMatch.id, 'post');
  }
}

// Assemble the live-game object served by /api/live from an ESPN scoreboard
// event and its optional DB match.
function _buildLiveGame(cfg, espnEvent, comp, asuComp, oppComp, dbMatch) {
  const state = comp.status?.type?.state;
  const gameState = state === 'in' ? 'live' : state === 'pre' ? 'upcoming' : 'final';
  const asuScore = asuComp.score?.displayValue ?? String(asuComp.score ?? '0');
  const oppScore = oppComp?.score?.displayValue ?? String(oppComp?.score ?? '0');
  const oppName = oppComp?.team?.displayName || 'Opponent';

  const title = dbMatch?.title || (asuComp.homeAway === 'away'
    ? `Arizona State at ${oppName}`
    : `Arizona State vs. ${oppName}`);

  const notes = (espnEvent.notes || []).map(n => n.headline || '').join(' ');
  const isTournament = TOURNAMENT_RE.test(title) ||
    TOURNAMENT_RE.test(dbMatch?.badges || '') ||
    TOURNAMENT_RE.test(notes);

  const venue = comp.venue;
  const broadcast = comp.broadcasts?.[0]?.names?.[0]
    || comp.geoBroadcasts?.[0]?.media?.shortName
    || dbMatch?.tv_network
    || null;

  return {
    espnEventId: espnEvent.id,
    dbEventId: dbMatch?.id ?? null,
    sport: cfg.dbSport,
    title,
    state: gameState,
    asuScore: gameState !== 'upcoming' ? asuScore : null,
    oppScore: gameState !== 'upcoming' ? oppScore : null,
    asuWinner: asuComp.winner === true,
    oppName,
    oppLogo: oppComp?.team?.logo || null,
    oppAbbr: oppComp?.team?.abbreviation || '',
    situation: comp.status?.type?.shortDetail || comp.status?.type?.description || '',
    sportDetails: extractSportDetails(comp, cfg.dbSport),
    location: venue?.fullName || dbMatch?.location_name || null,
    city: venue?.address?.city || dbMatch?.city || null,
    stateAbbr: venue?.address?.state || dbMatch?.state || null,
    tvNetwork: broadcast,
    startTime: Math.floor(new Date(espnEvent.date).getTime() / 1000),
    isTournament,
    espnNotes: notes,
    source: 'ESPN',
  };
}

// Insert an ESPN game that has no DB match so it appears in list/calendar
// views — happens for postseason/tournament games that the sundevils.com
// feed never emits. Only call when dbMatch was null: the game's location/
// tvNetwork/oppLogo fields then hold the raw ESPN values the row needs.
// Returns the new event id, or null if the insert failed.
function _autoInsertEspnGame(cfg, espnEvent, comp, asuComp, game) {
  const newEventId = `espn_${espnEvent.id}`;
  const gameType = comp.neutralSite === true ? 'neutral'
    : asuComp.homeAway === 'home' ? 'home' : 'away';
  try {
    upsertESPNEvent({
      id: newEventId,
      title: game.title,
      sport: cfg.dbSport,
      season: String(new Date(espnEvent.date).getFullYear()),
      start_date: Math.floor(new Date(espnEvent.date).getTime() / 1000),
      end_date: null,
      location_name: game.location,
      venue_address: null,
      city: game.city,
      state: game.stateAbbr,
      country: null,
      game_type: gameType,
      event_type: 'Game',
      tv_network: game.tvNetwork,
      ticket_url: null,
      ticket_label: null,
      opponent_logo: game.oppLogo,
      badges: null,
      image_url: null,
      node_url: null,
      updated_at: Date.now(),
      asu_score: null,
      opp_score: null,
      result: null,
    });
    console.log(`[live] Auto-inserted ESPN game: ${game.title}`);
    return newEventId;
  } catch (err) {
    console.error(`[live] Auto-insert failed for ${espnEvent.id}:`, err.message);
    return null;
  }
}

// /api/live is the hot 30s polling path: cache the full result briefly and
// single-flight concurrent misses so N clients cost one ESPN sweep, and fetch
// all sport scoreboards in parallel so latency is the slowest fetch, not the
// sum (a couple of slow ESPN responses used to stack sequentially).
const LIVE_CACHE_TTL = 15_000;
const _liveCache = new TtlCache();
let _liveInflight = null;

async function fetchLiveGames() {
  const hit = _liveCache.get('live');
  if (hit !== undefined) return hit;
  if (_liveInflight) return _liveInflight;
  _liveInflight = _fetchLiveGamesUncached()
    .then(result => {
      _liveCache.set('live', result, LIVE_CACHE_TTL);
      return result;
    })
    .finally(() => { _liveInflight = null; });
  return _liveInflight;
}

async function _fetchLiveGamesUncached() {
  const games = [];

  const boards = await Promise.allSettled(
    ALL_LIVE_CONFIGS.map(cfg => fetchLiveScoreboard(cfg.espnPath)),
  );

  for (let i = 0; i < ALL_LIVE_CONFIGS.length; i++) {
    const cfg = ALL_LIVE_CONFIGS[i];
    if (boards[i].status === 'rejected') {
      console.error(`[live] ${cfg.dbSport}: scoreboard fetch failed:`, boards[i].reason?.message);
      continue;
    }
    const scoreboard = boards[i].value;

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

      if (!_isRelevantGame(espnEvent, comp)) continue;

      if (comp.status?.type?.state === 'post') {
        _syncCompletedGame(espnEvent, dbEvents);
      }

      const matchKey = {
        espnOppDisplay: (oppComp?.team?.displayName || 'Opponent').toLowerCase(),
        espnOppAbbr: (oppComp?.team?.abbreviation || '').toLowerCase(),
        espnEventId: espnEvent.id,
      };
      const dbMatch = findDBMatch(matchKey, dbEvents, new Date(espnEvent.date));

      const game = _buildLiveGame(cfg, espnEvent, comp, asuComp, oppComp, dbMatch);
      if (!dbMatch) {
        game.dbEventId = _autoInsertEspnGame(cfg, espnEvent, comp, asuComp, game);
      }
      games.push(game);
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

// fetchAndStoreLiveScores — lightweight background poller (Phase 3).
// Fetches ESPN scoreboards for all sports, writes final scores + game_status
// to DB for completed ASU games. No tournament bracket logic, no game objects
// returned — this is a pure DB-write path for the background scheduler.
// Returns { fetched, written }: fetched = ASU games seen, written = DB rows updated.
async function fetchAndStoreLiveScores() {
  let fetched = 0;
  let written = 0;
  const scoreChanges = [];

  for (const cfg of ALL_LIVE_CONFIGS) {
    let scoreboard;
    try {
      scoreboard = await fetchLiveScoreboard(cfg.espnPath);
    } catch (err) {
      console.error(`[bg-poll] ${cfg.dbSport}: fetch failed:`, err.message);
      continue;
    }

    const dbEvents = queryEvents({ sport: cfg.dbSport });

    for (const espnEvent of scoreboard) {
      const comp = espnEvent.competitions?.[0];
      if (!comp) continue;

      const asuComp = comp.competitors?.find(c =>
        c.team?.displayName?.toLowerCase().includes('arizona state')
      );
      if (!asuComp) continue;

      fetched++;

      const state = comp.status?.type?.state;

      // ── Live game: detect score changes for score_update notifications ──
      if (state === 'in') {
        const oppComp = comp.competitors?.find(c =>
          !c.team?.displayName?.toLowerCase().includes('arizona state')
        );
        if (!oppComp) continue;

        const asuScore = asuComp.score?.displayValue ?? String(asuComp.score ?? '');
        const oppScore = oppComp.score?.displayValue ?? String(oppComp.score ?? '');
        if (!asuScore || !oppScore) continue;

        const liveData = {
          espnOppDisplay: (oppComp.team?.displayName || '').toLowerCase(),
          espnOppAbbr:    (oppComp.team?.abbreviation || '').toLowerCase(),
          espnEventId:    espnEvent.id,
        };
        const dbMatch = findDBMatch(liveData, dbEvents, new Date(espnEvent.date));
        if (!dbMatch) continue;

        if (dbMatch.asu_score !== asuScore || dbMatch.opp_score !== oppScore) {
          updateLiveScore(dbMatch.id, asuScore, oppScore);
          written++;
          const statusDetail = comp.status?.type?.shortDetail || '';
          scoreChanges.push({
            eventId: dbMatch.id,
            sport:   dbMatch.sport || cfg.dbSport,
            title:   dbMatch.title,
            asuScore,
            oppScore,
            statusDetail,
          });
        }
        if (dbMatch.game_status !== 'in') {
          updateGameStatus(dbMatch.id, 'in');
        }
        continue;
      }

      // ── Final score ──────────────────────────────────────────────────────
      if (state !== 'post') continue;

      const scoreData = extractScore(espnEvent);
      if (!scoreData) continue;
      scoreData.espnEventId = espnEvent.id;

      const dbMatch = findDBMatch(scoreData, dbEvents, new Date(espnEvent.date));
      if (!dbMatch) continue;

      if (dbMatch.result !== scoreData.result ||
          dbMatch.asu_score !== scoreData.asu_score ||
          dbMatch.opp_score !== scoreData.opp_score) {
        updateScore(dbMatch.id, scoreData.asu_score, scoreData.opp_score, scoreData.result);
        written++;
      }
      if (dbMatch.game_status !== 'post') {
        updateGameStatus(dbMatch.id, 'post');
        written++;
        console.log(`[bg-poll] wrote final: ${dbMatch.title} ASU ${scoreData.asu_score}–${scoreData.opp_score}`);
      }
    }
  }

  return { fetched, written, scoreChanges };
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
      scoreData.espnEventId = espnEvent.id;

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

// findDBMatch exported for tests only — not used by other modules.
module.exports = { fetchAndStoreScores, fetchAndStoreLiveScores, fetchLiveGames, findDBMatch };
