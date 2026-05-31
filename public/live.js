// live.js — ASU Athletics Live Tab + cross-view badge injection

const POLL_INTERVAL = 30_000;
window.__liveData = {};   // keyed by dbEventId → game object (for calendar/list badges)
let _pollTimer = null;
let _countdownTimer = null;
let _lastData = null;     // cached response for re-renders when switching tabs

// NCAA bracket client-side cache (avoids flicker on 30-second poll re-renders)
let _ncaaBracketHtml     = null;
let _ncaaBracketLoadedAt = 0;

// ── Main polling ──────────────────────────────────────────────────────────────

async function pollLive() {
  let data;
  try {
    const res = await fetch('/api/live');
    data = await res.json();
    if (!data || typeof data !== 'object') throw new Error('bad response');
  } catch (err) {
    console.error('[live] poll failed:', err);
    return;
  }

  // Support both old array format and new {games, tournaments, nextGame}
  const games      = Array.isArray(data) ? data : (data.games || []);
  const tournaments = Array.isArray(data) ? [] : (data.tournaments || []);
  const nextGame   = Array.isArray(data) ? null : (data.nextGame || null);
  _lastData = { games, tournaments, nextGame };

  const liveGames = games.filter(g => g.state === 'live');

  // Rebuild __liveData for calendar/list badge injection
  window.__liveData = {};
  for (const g of liveGames) {
    if (g.dbEventId) window.__liveData[g.dbEventId] = g;
  }

  updateLiveBanner(liveGames);
  updateCalendarLiveBadges();
  updateListLiveBadges();
  window.applyLiveToMap && window.applyLiveToMap();
  updateLiveTabDot(liveGames.length > 0);

  // Use DOM visibility as the source of truth — more reliable than localStorage on reload.
  const liveEl = document.getElementById('live-view');
  if (liveEl && liveEl.style.display === 'block') {
    try {
      _renderLiveView(games, tournaments, nextGame);
    } catch (err) {
      console.error('[live] renderLiveView failed:', err);
      liveEl.innerHTML = `<div class="live-empty-state"><p>Error rendering live data. Check console.</p></div>`;
    }
  }
}

// ── Live tab render ───────────────────────────────────────────────────────────

function _renderLiveView(games, tournaments, nextGame) {
  const container = document.getElementById('live-view');
  if (!container) return;

  clearCountdown();

  const liveGames     = games.filter(g => g.state === 'live');
  const upcomingGames = games.filter(g => g.state === 'upcoming');
  const finalGames    = games.filter(g => g.state === 'final');

  // If there are baseball games but no baseball bracket tournament detected (e.g. ESPN notes
  // missing or DB event not synced), inject a synthetic baseball bracket tournament so the
  // NCAA bracket section always shows during postseason.
  const hasBracketTourney = tournaments.some(t => t.sport === 'Baseball' && t.format === 'bracket');
  const baseballMonth = new Date().getMonth(); // 0-indexed; 4=May 5=June
  const hasBaseballGames = games.some(g => g.sport === 'Baseball');
  if (!hasBracketTourney && hasBaseballGames && (baseballMonth === 4 || baseballMonth === 5)) {
    tournaments = [...tournaments, {
      id: 'ncaa-baseball-auto',
      sport: 'Baseball',
      name: 'NCAA Regional',
      format: 'bracket',
      bracketReady: false,
      rounds: [],
      games: [],
    }];
  }

  let html = '';

  if (liveGames.length > 0) {
    html += sectionHeader('<span class="live-dot-lg"></span> Live Now', true);
    html += `<div class="live-cards-grid">${liveGames.map(renderGameCard).join('')}</div>`;

    if (tournaments.length > 0) html += renderTournaments(tournaments);

    if (upcomingGames.length > 0) {
      html += sectionHeader('Also Today');
      html += `<div class="live-cards-grid">${upcomingGames.map(renderGameCard).join('')}</div>`;
    }
    if (finalGames.length > 0) {
      html += sectionHeader("Today's Results");
      html += `<div class="live-cards-grid">${finalGames.map(renderGameCard).join('')}</div>`;
    }

  } else if (upcomingGames.length > 0) {
    const soonest = upcomingGames.reduce((a, b) => a.startTime < b.startTime ? a : b);
    html += sectionHeader(`Today's Games <span class="live-countdown" id="live-countdown"></span>`);
    html += `<div class="live-cards-grid">${upcomingGames.map(renderGameCard).join('')}</div>`;
    if (finalGames.length > 0) {
      html += sectionHeader("Today's Results");
      html += `<div class="live-cards-grid">${finalGames.map(renderGameCard).join('')}</div>`;
    }
    if (tournaments.length > 0) html += renderTournaments(tournaments);
    if (soonest.startTime) startCountdown('live-countdown', soonest.startTime);

  } else if (finalGames.length > 0) {
    html += sectionHeader("Today's Results");
    html += `<div class="live-cards-grid">${finalGames.map(renderGameCard).join('')}</div>`;
    if (tournaments.length > 0) html += renderTournaments(tournaments);
    if (nextGame) html += renderNextGameBlock(nextGame);

  } else if (nextGame) {
    html += `<p class="live-no-games-msg">No games in progress right now.</p>`;
    if (tournaments.length > 0) html += renderTournaments(tournaments);
    html += renderNextGameBlock(nextGame);

  } else if (tournaments.length > 0) {
    html += renderTournaments(tournaments);

  } else {
    html += `
      <div class="live-empty-state">
        <div class="live-empty-icon">🏟️</div>
        <h3>No games scheduled</h3>
        <p>Check back soon for ASU Sun Devil Athletics action.</p>
      </div>`;
  }

  container.innerHTML = html;

  // Set up delegated click handler for game cards (add once; survives innerHTML resets)
  if (!container._hasCardClicks) {
    container._hasCardClicks = true;
    container.addEventListener('click', _handleCardClick);
  }

  // Async-load NCAA bracket into any placeholder that was rendered
  const bracketPlaceholder = container.querySelector('#ncaa-bracket-placeholder');
  if (bracketPlaceholder) {
    // Reset scroll immediately (stale HTML may have been pre-rendered in the shell)
    const rounds = bracketPlaceholder.querySelector('.ncaa-bracket-rounds');
    if (rounds) rounds.scrollLeft = 0;
    _loadNcaaBracket(bracketPlaceholder.dataset.sport || 'Baseball').catch(() => {});
  }

  // Start countdown after DOM insert
  if (upcomingGames.length > 0 && liveGames.length === 0) {
    const soonest = upcomingGames.reduce((a, b) => a.startTime < b.startTime ? a : b);
    if (soonest.startTime) startCountdown('live-countdown', soonest.startTime);
  }
  if ((finalGames.length > 0 || !games.length) && nextGame && nextGame.startTime) {
    startCountdown('next-countdown', nextGame.startTime);
  }
}

function _handleCardClick(e) {
  const card = e.target.closest('[data-espn-id]');
  if (!card) return;
  const espnId = card.dataset.espnId;
  const sport  = card.dataset.sport || '';
  if (!espnId || !window.openGameDetailModal) return;
  window.openGameDetailModal(espnId, sport, {
    title:     card.dataset.title || '',
    sport,
    startTime: card.dataset.startTime ? parseInt(card.dataset.startTime, 10) : null,
    location:  card.dataset.location || null,
    tvNetwork: card.dataset.tv || null,
  });
}

function sectionHeader(innerHTML, pulse) {
  return `<div class="live-section-header${pulse ? ' live-section-live' : ''}">${innerHTML}</div>`;
}

// ── Game card ─────────────────────────────────────────────────────────────────

function renderGameCard(game) {
  const stateClass    = game.state === 'live' ? 'card-live' : game.state === 'upcoming' ? 'card-upcoming' : 'card-final';
  const clickableClass = game.espnEventId ? ' card-clickable' : '';
  const espnAttrs = game.espnEventId
    ? `data-espn-id="${esc(game.espnEventId)}" data-sport="${esc(game.sport || '')}" data-title="${esc(game.title || '')}" data-start-time="${game.startTime || ''}" data-location="${esc(game.location || (game.city ? [game.city, game.stateAbbr].filter(Boolean).join(', ') : '') || '')}" data-tv="${esc(game.tvNetwork || '')}"`
    : '';

  const statusBadge = game.state === 'live'
    ? `<span class="live-status-badge live-status-live"><span class="live-dot-sm"></span>LIVE</span>`
    : game.state === 'final'
    ? `<span class="live-status-badge live-status-final">FINAL</span>`
    : `<span class="live-status-badge live-status-upcoming">UPCOMING</span>`;

  const tvBadge = game.tvNetwork
    ? `<span class="live-card-tv">${esc(game.tvNetwork)}</span>` : '';

  const asuLogoSvg = `<div class="live-card-asu-badge">ASU</div>`;
  const oppLogoEl  = game.oppLogo
    ? `<img class="live-card-logo" src="${esc(game.oppLogo)}" alt="${esc(game.oppName)}" loading="lazy" />`
    : `<div class="live-card-logo-placeholder">${esc((game.oppAbbr || game.oppName).slice(0,3).toUpperCase())}</div>`;

  const asuScoreEl = game.state !== 'upcoming'
    ? `<div class="live-card-score${game.asuWinner ? ' score-winner' : ''}">${esc(game.asuScore)}</div>` : '';
  const oppScoreEl = game.state !== 'upcoming'
    ? `<div class="live-card-score${!game.asuWinner && game.state === 'final' ? ' score-winner' : ''}">${esc(game.oppScore)}</div>` : '';

  const vsOrTime = game.state === 'upcoming'
    ? `<div class="live-card-vs">${esc(formatGameTime(game.startTime))}</div>`
    : `<div class="live-card-vs">–</div>`;

  const sportDetailsHtml = renderSportDetails(game);

  const situationHtml = game.situation
    ? `<div class="live-card-situation">${esc(game.situation)}</div>` : '';

  const locationParts = [];
  if (game.location) locationParts.push(game.location);
  else if (game.city) locationParts.push([game.city, game.stateAbbr].filter(Boolean).join(', '));
  const locationHtml = locationParts.length
    ? `<div class="live-card-meta">📍 ${esc(locationParts[0])}</div>` : '';

  return `
    <div class="live-card ${stateClass}${clickableClass}" data-event-id="${esc(game.dbEventId || '')}" ${espnAttrs}>
      <div class="live-card-header">
        <span class="live-card-sport">${esc(game.sport)}</span>
        ${statusBadge}
        ${tvBadge}
      </div>
      <div class="live-card-matchup">
        <div class="live-card-team">
          ${asuLogoSvg}
          <div class="live-card-team-name">Arizona State</div>
          ${asuScoreEl}
        </div>
        ${vsOrTime}
        <div class="live-card-team">
          ${oppLogoEl}
          <div class="live-card-team-name">${esc(shortOppName(game.oppName))}</div>
          ${oppScoreEl}
        </div>
      </div>
      ${sportDetailsHtml}
      ${situationHtml || locationHtml ? `<div class="live-card-footer">${situationHtml}${locationHtml}</div>` : ''}
    </div>`;
}

// ── Sport-specific detail sections ────────────────────────────────────────────

function renderSportDetails(game) {
  if (game.state === 'upcoming') return '';
  const d = game.sportDetails || {};
  const s = game.sport;

  if (s === 'Baseball' || s === 'Softball') return renderBaseballDetails(d);
  if (s === 'Football')                     return renderFootballDetails(d, game);
  if (s === "Men's Basketball" || s === "Women's Basketball" || s === 'Basketball')
    return renderBasketballDetails(d);
  if (s === "Women's Soccer" || s === "Men's Soccer" || s === 'Soccer')
    return renderSoccerDetails(d);
  return '';
}

function renderBaseballDetails(d) {
  if (d.inning == null) return '';

  const inningLabel = `${d.isTop ? '▲' : '▽'} ${d.inning}`;
  const chips = [inningLabel];
  if (d.outs != null) chips.push(`${d.outs} out${d.outs !== 1 ? 's' : ''}`);
  if (d.balls != null && d.strikes != null) chips.push(`${d.balls}-${d.strikes}`);

  const diamond = `
    <div class="baseball-diamond" aria-label="Runners on base">
      <div class="bd-base bd-2b${d.onSecond ? ' bd-on' : ''}"></div>
      <div class="bd-row-mid">
        <div class="bd-base bd-3b${d.onThird ? ' bd-on' : ''}"></div>
        <div class="bd-gap"></div>
        <div class="bd-base bd-1b${d.onFirst ? ' bd-on' : ''}"></div>
      </div>
      <div class="bd-base bd-hp"></div>
    </div>`;

  return `
    <div class="live-card-sport-details baseball-layout">
      ${diamond}
      <div class="sport-chips">${chips.map(c => `<span class="sport-chip">${esc(c)}</span>`).join('')}</div>
    </div>`;
}

function renderFootballDetails(d, game) {
  const chips = [];
  if (d.quarter) chips.push(`Q${d.quarter}`);
  if (d.gameClock) chips.push(d.gameClock);
  if (d.downDistanceText) chips.push(d.downDistanceText);
  else if (d.down && d.distance != null) chips.push(`${ordinal(d.down)} & ${d.distance}`);
  if (d.yardLine != null) chips.push(`${d.yardLine} yd line`);
  if (d.isRedZone) chips.push('🔴 Red Zone');

  if (!chips.length) return '';
  return chipRow(chips);
}

function renderBasketballDetails(d) {
  const chips = [];
  if (d.half) {
    const halfLabel = d.half === 1 ? '1st Half' : d.half === 2 ? '2nd Half' : `OT${d.half > 2 ? d.half - 2 : ''}`;
    chips.push(halfLabel);
  }
  if (d.gameClock) chips.push(d.gameClock);
  // FALLBACK: shot clock requires ESPN summary endpoint /summary?event={id}
  if (d.shotClock != null) chips.push(`Shot: ${d.shotClock}s`);

  if (!chips.length) return '';
  return chipRow(chips);
}

function renderSoccerDetails(d) {
  const chips = [];
  if (d.half) chips.push(d.half === 1 ? '1st Half' : d.half === 2 ? '2nd Half' : 'Extra Time');
  if (d.minute) chips.push(`${d.minute}'`);

  if (!chips.length) return '';
  return chipRow(chips);
}

function chipRow(chips) {
  return `<div class="sport-chips">${chips.map(c => `<span class="sport-chip">${esc(c)}</span>`).join('')}</div>`;
}

// ── Tournament section ────────────────────────────────────────────────────────

function renderTournaments(tournaments) {
  if (!tournaments || !tournaments.length) return '';
  return tournaments.map(t => {
    // Baseball bracket has its own NCAA data source — always show it.
    if (t.format === 'bracket' && t.sport === 'Baseball') return renderNcaaBracketShell(t);
    // All other tournaments: hide until at least one game is live or final.
    const hasData = (t.games || []).some(g => g.state === 'live' || g.state === 'final');
    if (!hasData) return '';
    if (!t.bracketReady) return renderUpcomingTournament(t);
    if (t.format === 'pool') return renderPoolStandings(t);
    if (t.format === 'series') return renderSeriesPanel(t);
    if (t.format === 'bracket' && t.rounds && t.rounds.length) return renderBracket(t);
    return renderUpcomingTournament(t);
  }).join('');
}

// ── NCAA Regional Bracket ─────────────────────────────────────────────────────

function renderNcaaBracketShell(tournament) {
  const colId = `ncaa-bracket-col-${(tournament.id || '').replace(/[^a-z0-9]/gi, '-')}`;
  // Show stale bracket instantly if we have it, else show loading
  const bodyContent = _ncaaBracketHtml
    ? _ncaaBracketHtml
    : '<div class="ncaa-bracket-loading">Loading bracket…</div>';

  return `
    <div class="bracket-wrapper">
      <div class="live-section-header bracket-collapsible-header" onclick="toggleBracketBody(this)">
        🏆 ${esc(tournament.name)} <span class="bracket-collapse-btn">▾</span>
      </div>
      <div class="bracket-body" id="${esc(colId)}">
        <div id="ncaa-bracket-placeholder" data-col-id="${esc(colId)}" data-sport="${esc(tournament.sport || 'Baseball')}">${bodyContent}</div>
      </div>
    </div>`;
}

function _setBracketHtml(el, html) {
  if (!el) return;
  el.innerHTML = html;
  // Always start at the left edge — browser may auto-scroll to a focused/highlighted element
  const rounds = el.querySelector('.ncaa-bracket-rounds');
  if (rounds) rounds.scrollLeft = 0;
}

async function _loadNcaaBracket(sport) {
  const placeholder = document.getElementById('ncaa-bracket-placeholder');
  if (!placeholder) return;

  // If cache is fresh (< 30s), just use it — no fetch needed
  if (_ncaaBracketHtml && Date.now() - _ncaaBracketLoadedAt < 30_000) {
    _setBracketHtml(placeholder, _ncaaBracketHtml);
    return;
  }

  // Show stale data immediately while fetching
  if (_ncaaBracketHtml) _setBracketHtml(placeholder, _ncaaBracketHtml);

  try {
    const secRes = await fetch('/api/ncaa/asu-section');
    if (!secRes.ok) throw new Error('section fetch failed');
    const { sectionId } = await secRes.json();

    const bRes = await fetch(`/api/ncaa/bracket/${sectionId}`);
    if (!bRes.ok) throw new Error('bracket fetch failed');
    const games = await bRes.json();
    if (!Array.isArray(games) || !games.length) throw new Error('empty bracket');

    _ncaaBracketHtml     = _buildNcaaBracketHtml(games);
    _ncaaBracketLoadedAt = Date.now();

    _setBracketHtml(document.getElementById('ncaa-bracket-placeholder'), _ncaaBracketHtml);
  } catch (err) {
    console.warn('[live] NCAA bracket fetch failed:', err.message);
    const el = document.getElementById('ncaa-bracket-placeholder');
    if (el && !_ncaaBracketHtml) {
      el.innerHTML = '<div class="tourn-note">🏆 Tournament in progress · Live bracket updates when games start</div>';
    }
  }
}

function _buildNcaaBracketHtml(games) {
  const cols = _bracketColumns(games);
  const COL_LABELS = ['Winners R1', 'Losers R1', 'Winners Final', 'Losers R2', 'Regional Final'];

  const colsHtml = cols.map((colGames, i) => {
    if (!colGames.length) return '';
    const gamesHtml = colGames.map(_renderNcaaGameCard).join('');
    return `<div class="ncaa-bracket-col">
      <div class="ncaa-bracket-col-label">${esc(COL_LABELS[i] || `Round ${i + 1}`)}</div>
      <div class="ncaa-bracket-games">${gamesHtml}</div>
    </div>`;
  }).join('');

  return `<div class="ncaa-bracket-rounds">${colsHtml}</div>`;
}

function _bracketColumns(games) {
  const byId = new Map(games.map(g => [g.bracketId, g]));

  // incoming[targetId] = [{fromId, type}]
  const incoming = new Map();
  for (const g of games) {
    for (const [type, tid] of [['victor', g.victorBracketPositionId], ['loser', g.loserBracketPositionId]]) {
      if (!tid || !byId.has(tid)) continue;
      if (!incoming.has(tid)) incoming.set(tid, []);
      incoming.get(tid).push({ fromId: g.bracketId, type });
    }
  }

  // Memoised depth (longest predecessor chain)
  const depthMemo = new Map();
  function getDepth(id, seen) {
    if (depthMemo.has(id)) return depthMemo.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const preds = incoming.get(id) || [];
    const d = preds.length === 0 ? 0 : 1 + Math.max(...preds.map(p => getDepth(p.fromId, new Set(seen))));
    depthMemo.set(id, d);
    return d;
  }
  for (const g of games) getDepth(g.bracketId, new Set());

  const hasLoserInput = id => (incoming.get(id) || []).some(e => e.type === 'loser');

  // Column assignment:
  // depth 0                   → col 0 (Winners R1)
  // depth 1 + loser input     → col 1 (Losers R1)
  // depth 1 + all victor      → col 2 (Winners Final)
  // depth 2                   → col 3 (Losers R2)
  // depth >= 3                → col 4 (Regional Final incl. if-necessary)
  const cols = [[], [], [], [], []];
  for (const g of games) {
    const d   = depthMemo.get(g.bracketId) ?? 0;
    let col;
    if (d === 0)     col = 0;
    else if (d === 1) col = hasLoserInput(g.bracketId) ? 1 : 2;
    else if (d === 2) col = 3;
    else              col = 4;
    cols[col].push(g);
  }
  return cols;
}

function _renderNcaaGameCard(game) {
  const isLive  = game.gameState === 'I';
  const isFinal = game.gameState === 'F';
  const canClick = !!game.espnEventId && (isLive || isFinal);

  const cardClass = ['ncaa-game-card', isLive ? 'ncaa-live' : '', canClick ? 'ncaa-clickable' : ''].filter(Boolean).join(' ');
  const espnAttrs = canClick
    ? `data-espn-id="${esc(game.espnEventId)}" data-sport="Baseball"`
    : '';

  // Card header content
  let headerHtml = '';
  if (isLive) {
    headerHtml = `<span class="ncaa-live-badge">LIVE</span> ${esc(game.currentPeriod || '')}`;
  } else if (isFinal) {
    headerHtml = `<span class="ncaa-final-badge">Final</span>`;
  } else {
    const parts = [];
    if (game.startDate) parts.push(_ncaaFormatDate(game.startDate));
    if (game.broadcaster?.name) parts.push(esc(game.broadcaster.name));
    headerHtml = parts.join(' · ');
  }

  const teams = game.teams || [];
  const row1  = _renderNcaaTeamRow(teams[0] || null, isFinal, isLive);
  const row2  = _renderNcaaTeamRow(teams[1] || null, isFinal, isLive);

  return `<div class="${cardClass}" ${espnAttrs}>
    <div class="ncaa-card-header">${headerHtml}</div>
    ${row1}${row2}
  </div>`;
}

function _renderNcaaTeamRow(team, isFinal, isLive) {
  if (!team) return `<div class="ncaa-team-row"><span class="ncaa-team-name" style="color:var(--text-muted)">TBD</span></div>`;

  const isAsu   = team.seoname === 'arizona-st';
  const isWin   = team.isWinner === true;
  const isElim  = team.eliminated === true;
  const hasScore = team.score != null;

  const rowClass = ['ncaa-team-row',
    isAsu ? 'ncaa-asu' : '',
    isWin && isFinal ? 'ncaa-winner' : '',
    !isWin && isFinal && !isElim ? 'ncaa-loser' : '',
    isElim ? 'ncaa-eliminated' : '',
  ].filter(Boolean).join(' ');

  const seedHtml = team.seed != null
    ? `<span class="ncaa-team-seed">${esc(team.seed)}</span>`
    : `<span class="ncaa-team-seed"></span>`;

  const logoUrl = team.logoUrl ? `https://www.ncaa.com${team.logoUrl}` : null;
  const logoHtml = logoUrl
    ? `<img class="ncaa-team-logo" src="${esc(logoUrl)}" alt="" loading="lazy">`
    : `<span class="ncaa-team-abbr">${esc((team.name6Char || team.nameShort || 'TBD').slice(0, 6).toUpperCase())}</span>`;

  const recordHtml = team.sectionRecord
    ? `<span class="ncaa-team-record">${esc(team.sectionRecord)}</span>` : '';

  const scoreHtml = hasScore
    ? `<span class="ncaa-team-score${isWin && isFinal ? ' ncaa-win-score' : ''}">${esc(team.score)}</span>`
    : '';

  const elimHtml = isElim ? '<span class="ncaa-elim-label">ELIM</span>' : '';

  return `<div class="${rowClass}">${seedHtml}${logoHtml}<span class="ncaa-team-name">${esc(team.nameShort || 'TBD')}</span>${recordHtml}${scoreHtml}${elimHtml}</div>`;
}

function _ncaaFormatDate(dateStr) {
  // dateStr: "05/29/2026"
  if (!dateStr) return '';
  try {
    const [m, d, y] = dateStr.split('/');
    return new Date(parseInt(y), parseInt(m) - 1, parseInt(d))
      .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function renderUpcomingTournament(tournament) {
  const VENUE_RE = /ncaa|regional|championship|west\s+regional|east\s+regional|north\s+regional|south\s+regional|midwest\s+regional/i;
  const games = tournament.games || [];
  const nowTs = Math.floor(Date.now() / 1000);

  const rows = games.map(g => {
    const oppDisplay = (!g.oppName || VENUE_RE.test(g.oppName)) ? 'TBD' : shortOppName(g.oppName);

    const dateStr = g.startTime
      ? new Date(g.startTime * 1000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      : '';
    const timeStr = g.startTime
      ? new Date(g.startTime * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
      : '';

    let resultChip = '';
    if (g.state === 'final' && g.asuScore != null) {
      const wl = g.asuWinner ? 'W' : 'L';
      const cls = g.asuWinner ? 'tourn-result-w' : 'tourn-result-l';
      resultChip = `<span class="${cls}">${wl} ${esc(g.asuScore)}–${esc(g.oppScore)}</span>`;
    }

    const tvHtml = g.tvNetwork ? `<span class="tourn-tv">📺 ${esc(g.tvNetwork)}</span>` : '';

    return `
      <div class="tourn-game-row">
        <div class="tourn-game-left">
          <span class="tourn-opp">${esc(oppDisplay)}</span>
          ${resultChip}
        </div>
        <div class="tourn-game-right">
          ${dateStr ? `<span class="tourn-date">${esc(dateStr)}</span>` : ''}
          ${timeStr ? `<span class="tourn-time">${esc(timeStr)}</span>` : ''}
          ${tvHtml}
        </div>
      </div>`;
  }).join('');

  const allFuture = games.length > 0 && games.every(g => g.startTime > nowTs);
  const note = allFuture
    ? `<div class="tourn-note">🗓 Schedule confirmed · Bracket releases when tournament begins</div>`
    : `<div class="tourn-note">🏆 Tournament in progress · Live bracket updates when games start</div>`;

  const colId = `ut-${(tournament.id || '').replace(/[^a-z0-9]/gi, '-')}`;

  return `
    <div class="bracket-wrapper">
      <div class="live-section-header bracket-collapsible-header" onclick="toggleBracketBody(this)">
        🏆 ${esc(tournament.name)} <span class="bracket-collapse-btn">▾</span>
      </div>
      <div class="bracket-body" id="${esc(colId)}">
        ${note}
        <div class="tourn-game-list">${rows || '<div class="tourn-note">No games found</div>'}</div>
      </div>
    </div>`;
}

function toggleBracketBody(headerEl) {
  const body = headerEl.nextElementSibling;
  if (!body) return;
  const collapsed = body.classList.toggle('collapsed');
  const btn = headerEl.querySelector('.bracket-collapse-btn');
  if (btn) btn.classList.toggle('rotated', collapsed);
}

function renderBracket(tournament) {
  const colId = `bb-${tournament.id.replace(/[^a-z0-9]/gi, '-')}`;
  const roundsHtml = tournament.rounds.map(round => `
    <div class="bracket-round">
      <div class="bracket-round-label">${esc(round.name)}</div>
      ${(round.matchups || []).map(m => renderMatchup(m)).join('')}
    </div>`).join('');

  return `
    <div class="bracket-wrapper">
      <div class="live-section-header bracket-collapsible-header" onclick="toggleBracketBody(this)">
        🏆 ${esc(tournament.name)} <span class="bracket-collapse-btn">▾</span>
      </div>
      <div class="bracket-body" id="${esc(colId)}">
        <div class="bracket-rounds">${roundsHtml}</div>
      </div>
    </div>`;
}

function renderMatchup(m) {
  const liveClass = m.state === 'in' ? ' bm-live' : '';
  const teamA = m.teamA || { name: 'TBD', abbr: 'TBD', logo: null, seed: null, score: null, winner: null, isASU: false };
  const teamB = m.teamB || { name: 'TBD', abbr: 'TBD', logo: null, seed: null, score: null, winner: null, isASU: false };
  const timeOrSituation = m.state === 'in' && m.situation
    ? `<div class="bracket-situation">${esc(m.situation)}</div>`
    : m.state === 'pre' && m.startTime
    ? `<div class="bracket-situation">${esc(formatGameTime(m.startTime))}</div>`
    : '';

  return `
    <div class="bracket-matchup${liveClass}">
      ${renderBracketTeam(teamA, m.state)}
      ${renderBracketTeam(teamB, m.state)}
      ${timeOrSituation}
    </div>`;
}

function renderBracketTeam(team, state) {
  const winnerClass = team.winner === true ? ' bt-winner' : '';
  const loserClass  = team.winner === false ? ' bt-loser' : '';
  const asuClass    = team.isASU ? ' bt-asu' : '';

  const seedHtml = team.seed != null
    ? `<span class="bracket-seed">${esc(team.seed)}</span>`
    : `<span class="bracket-seed"></span>`;

  const logoHtml = team.logo
    ? `<img class="bracket-team-logo" src="${esc(team.logo)}" alt="" loading="lazy">`
    : `<span class="bracket-team-abbr">${esc((team.abbr || team.name || 'TBD').slice(0, 3).toUpperCase())}</span>`;

  const scoreHtml = state !== 'pre' && team.score != null
    ? `<span class="bracket-team-score">${esc(team.score)}</span>` : '';

  const liveBadge = state === 'in'
    ? `<span class="bracket-live-badge">LIVE</span>` : '';

  return `<div class="bracket-team${winnerClass}${loserClass}${asuClass}">
    ${seedHtml}${logoHtml}
    <span class="bracket-team-name">${esc(shortOppName(team.name || 'TBD'))}</span>
    ${scoreHtml}${liveBadge}
  </div>`;
}

function renderPoolStandings(tournament) {
  const colId = `ps-${tournament.id.replace(/[^a-z0-9]/gi, '-')}`;
  const rows = (tournament.standings || []).map(s => `
    <tr class="${s.isASU ? 'standings-asu-row' : ''}">
      <td>${esc(s.rank)}</td>
      <td>
        ${s.logo ? `<img class="bracket-team-logo" src="${esc(s.logo)}" alt="" loading="lazy"> ` : ''}${esc(s.name)}
      </td>
      <td>${esc(s.w)}</td>
      <td>${esc(s.l)}</td>
      <td>${esc(s.pct)}</td>
      <td>${esc(s.gb)}</td>
    </tr>`).join('');

  const gamesHtml = (tournament.games || []).length
    ? `<div class="live-cards-grid" style="padding:12px 16px 16px">${tournament.games.map(renderGameCard).join('')}</div>` : '';

  return `
    <div class="bracket-wrapper">
      <div class="live-section-header bracket-collapsible-header" onclick="toggleBracketBody(this)">
        🏆 ${esc(tournament.name)} — Pool Standings <span class="bracket-collapse-btn">▾</span>
      </div>
      <div class="bracket-body" id="${esc(colId)}">
        <table class="standings-table">
          <thead><tr><th>#</th><th>Team</th><th>W</th><th>L</th><th>Pct</th><th>GB</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${gamesHtml}
      </div>
    </div>`;
}

function renderSeriesPanel(tournament) {
  const colId = `sp-${tournament.id.replace(/[^a-z0-9]/gi, '-')}`;
  const seriesGames = tournament.seriesGames || tournament.games || [];
  const asuWins  = seriesGames.filter(g => g.state === 'final' && g.asuWinner === true).length;
  const oppWins  = seriesGames.filter(g => g.state === 'final' && g.asuWinner === false).length;
  const oppName  = seriesGames[0]?.oppName || 'Opponent';

  const dots = seriesGames.map(g => {
    if (g.state === 'pre') return `<span class="series-dot sd-tbd" title="TBD"></span>`;
    if (g.state === 'live') return `<span class="series-dot sd-tbd" title="Live"></span>`;
    return g.asuWinner === true
      ? `<span class="series-dot sd-win" title="W"></span>`
      : `<span class="series-dot sd-loss" title="L"></span>`;
  }).join('');

  let seriesScoreText = '';
  const played = asuWins + oppWins;
  if (played > 0) {
    if (asuWins > oppWins)      seriesScoreText = `ASU leads ${asuWins}–${oppWins}`;
    else if (oppWins > asuWins) seriesScoreText = `${esc(shortOppName(oppName))} leads ${oppWins}–${asuWins}`;
    else                        seriesScoreText = `Tied ${asuWins}–${asuWins}`;
  }

  return `
    <div class="bracket-wrapper">
      <div class="live-section-header bracket-collapsible-header" onclick="toggleBracketBody(this)">
        🏆 ${esc(tournament.name)} <span class="bracket-collapse-btn">▾</span>
      </div>
      <div class="bracket-body" id="${esc(colId)}">
        <div class="series-panel">
          <div class="series-dots">${dots}</div>
          ${seriesScoreText ? `<div class="series-score">${seriesScoreText}</div>` : ''}
        </div>
        <div class="live-cards-grid" style="padding:0 16px 16px">${seriesGames.map(renderGameCard).join('')}</div>
      </div>
    </div>`;
}

// ── Next game countdown block ─────────────────────────────────────────────────

function renderNextGameBlock(nextGame) {
  const tournamentPill = nextGame.isTournament
    ? ` <span style="display:inline-block;font-size:0.72rem;background:var(--gold);color:#000;border-radius:4px;padding:1px 7px;font-weight:700;vertical-align:middle">🏆 Tournament</span>`
    : '';
  return `
    <div class="live-next-game">
      <div class="live-next-label">Next Game</div>
      <div class="live-next-title">${esc(shortTitle(nextGame.title))}</div>
      <div class="live-next-sport">${esc(nextGame.sport)}${tournamentPill}</div>
      <div class="live-next-countdown" id="next-countdown">–</div>
      <div class="live-next-meta">
        ${nextGame.startTime ? `<span>${esc(formatGameDateTime(nextGame.startTime))}</span>` : ''}
        ${nextGame.location   ? `<span>📍 ${esc(nextGame.location)}</span>` : ''}
        ${nextGame.tvNetwork  ? `<span>📺 ${esc(nextGame.tvNetwork)}</span>` : ''}
      </div>
    </div>`;
}

// ── Countdown timer ───────────────────────────────────────────────────────────

function startCountdown(elementId, targetTs) {
  clearCountdown();
  function tick() {
    const el = document.getElementById(elementId);
    if (!el) { clearCountdown(); return; }
    const diff = targetTs - Math.floor(Date.now() / 1000);
    if (diff <= 0) { el.textContent = 'Starting now!'; clearCountdown(); return; }
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${String(m).padStart(2, '0')}m`);
    parts.push(`${String(s).padStart(2, '0')}s`);
    el.textContent = parts.join(' ');
  }
  tick();
  _countdownTimer = setInterval(tick, 1000);
}

function clearCountdown() {
  if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
}

// ── Live tab dot indicator ────────────────────────────────────────────────────

function updateLiveTabDot(hasLive) {
  const dot = document.getElementById('live-tab-dot');
  if (dot) {
    dot.style.display = hasLive ? 'inline-block' : 'none';
    dot.classList.toggle('live-tab-dot-active', hasLive);
  }
}

// ── Cross-view: Live Now banner ───────────────────────────────────────────────

function updateLiveBanner(liveGames) {
  const banner = document.getElementById('live-banner');
  if (!banner) return;
  if (!liveGames.length) { banner.hidden = true; banner.innerHTML = ''; return; }

  const items = liveGames.map(g =>
    `<span class="live-banner-game">
       <span class="live-dot"></span>
       <strong>${esc(g.title)}</strong>
       <span class="live-score">${esc(g.asuScore)}–${esc(g.oppScore)}</span>
       <span class="live-situation">${esc(g.situation)}</span>
     </span>`
  ).join('');
  banner.innerHTML = `<div class="live-banner-inner"><span class="live-banner-label">LIVE NOW</span>${items}</div>`;
  banner.hidden = false;
}

// ── Cross-view: Calendar live badges ─────────────────────────────────────────

function updateCalendarLiveBadges() {
  const els = window.__calendarEventEls || {};
  document.querySelectorAll('.fc-live-line').forEach(el => el.remove());
  for (const [id, game] of Object.entries(window.__liveData)) {
    const el = els[id];
    if (!el || !document.contains(el)) continue;
    el.querySelector('.fc-score-line')?.remove();
    const line = document.createElement('div');
    line.className = 'fc-live-line';
    line.innerHTML = `<span class="live-badge-sm">LIVE</span> ${esc(game.asuScore)}–${esc(game.oppScore)} <span class="fc-live-situation">${esc(game.situation)}</span>`;
    el.querySelector('.fc-event-title-container')?.appendChild(line);
  }
}

// ── Cross-view: List live badges ──────────────────────────────────────────────

function updateListLiveBadges() {
  document.querySelectorAll('.list-event[data-event-id]').forEach(el => {
    const id = el.dataset.eventId;
    const game = window.__liveData[id];
    el.querySelector('.live-badge-list')?.remove();
    el.classList.toggle('list-event-live', !!game);
    if (!game) return;
    const right = el.querySelector('.list-event-right');
    if (!right) return;
    const badge = document.createElement('div');
    badge.className = 'live-badge-list';
    badge.innerHTML =
      `<span class="live-badge-pill">🔴 LIVE</span>` +
      `<span class="live-score-text">${esc(game.asuScore)}–${esc(game.oppScore)} · ${esc(game.situation)}</span>`;
    right.prepend(badge);
  });
}

// ── Polling control ───────────────────────────────────────────────────────────

function startLivePolling() {
  if (_pollTimer) return;
  pollLive();
  _pollTimer = setInterval(pollLive, POLL_INTERVAL);
}

function stopLivePolling() {
  clearInterval(_pollTimer);
  _pollTimer = null;
}

document.addEventListener('visibilitychange', () => {
  document.hidden ? stopLivePolling() : startLivePolling();
});

startLivePolling();

window.startLivePolling = startLivePolling;

// Called by setView('live') in filters.js
window.renderLiveView = function() {
  const container = document.getElementById('live-view');
  if (!container) {
    console.error('[live] #live-view not found in DOM');
    return;
  }
  if (_lastData) {
    try {
      _renderLiveView(_lastData.games, _lastData.tournaments, _lastData.nextGame);
    } catch (err) {
      console.error('[live] renderLiveView threw:', err);
      container.innerHTML = `<div class="live-empty-state"><p style="color:red">Render error: ${err.message}</p></div>`;
    }
  } else {
    container.innerHTML = '<div class="live-empty-state"><p>Loading…</p></div>';
    // poll is in flight; when it resolves it will render via the DOM visibility check in pollLive
  }
};

// ── Utility helpers ───────────────────────────────────────────────────────────

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shortOppName(name) {
  if (!name) return '';
  return name.replace(/^(University of |The )/i, '');
}

function shortTitle(title) {
  if (!title) return 'Event';
  return title
    .replace(/^Sun Devil [^:]+:\s*/i, '')
    .replace(/^Arizona State\s+/i, '');
}

function formatGameTime(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

function formatGameDateTime(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
