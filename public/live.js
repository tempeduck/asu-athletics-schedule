// live.js — ASU Athletics Live Tab + cross-view badge injection

const POLL_INTERVAL = 30_000;
window.__liveData = {};   // keyed by dbEventId → game object (for calendar/list badges)
let _pollTimer = null;
let _countdownTimer = null;
let _lastData = null;     // cached response for re-renders when switching tabs

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
    if (soonest.startTime) startCountdown('live-countdown', soonest.startTime);

  } else if (finalGames.length > 0) {
    html += sectionHeader("Today's Results");
    html += `<div class="live-cards-grid">${finalGames.map(renderGameCard).join('')}</div>`;
    if (nextGame) html += renderNextGameBlock(nextGame);

  } else if (nextGame) {
    html += `<p class="live-no-games-msg">No games in progress right now.</p>`;
    html += renderNextGameBlock(nextGame);

  } else {
    html += `
      <div class="live-empty-state">
        <div class="live-empty-icon">🏟️</div>
        <h3>No games scheduled</h3>
        <p>Check back soon for ASU Sun Devil Athletics action.</p>
      </div>`;
  }

  container.innerHTML = html;
  // Start countdown after DOM insert
  if (upcomingGames.length > 0 && liveGames.length === 0) {
    const soonest = upcomingGames.reduce((a, b) => a.startTime < b.startTime ? a : b);
    if (soonest.startTime) startCountdown('live-countdown', soonest.startTime);
  }
  if ((finalGames.length > 0 || !games.length) && nextGame && nextGame.startTime) {
    startCountdown('next-countdown', nextGame.startTime);
  }
}

function sectionHeader(innerHTML, pulse) {
  return `<div class="live-section-header${pulse ? ' live-section-live' : ''}">${innerHTML}</div>`;
}

// ── Game card ─────────────────────────────────────────────────────────────────

function renderGameCard(game) {
  const stateClass = game.state === 'live' ? 'card-live' : game.state === 'upcoming' ? 'card-upcoming' : 'card-final';

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
    <div class="live-card ${stateClass}" data-event-id="${esc(game.dbEventId || '')}">
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
  return tournaments.map(t => `
    <div class="bracket-section">
      ${sectionHeader(`🏆 ${esc(t.name)}`)}
      <div class="live-cards-grid">${t.games.map(renderGameCard).join('')}</div>
    </div>`
  ).join('');
}

// ── Next game countdown block ─────────────────────────────────────────────────

function renderNextGameBlock(nextGame) {
  return `
    <div class="live-next-game">
      <div class="live-next-label">Next Game</div>
      <div class="live-next-title">${esc(shortTitle(nextGame.title))}</div>
      <div class="live-next-sport">${esc(nextGame.sport)}</div>
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
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix',
  });
}

function formatGameDateTime(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix',
  });
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
