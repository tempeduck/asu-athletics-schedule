// game-modal.js — ESPN box-score modal (header, linescore, player stats tabs).
// Extracted from filters.js; uses esc/shortTitle/formatTs from shared.js and is
// invoked lazily via window.openGameDetailModal from live.js, list rows, and
// map popups. Loads after filters.js, before live.js.

// ── Game Detail Modal (box score) ─────────────────────────────────────────────

let _gmEscKey = null;
let _gmPrevFocus = null;
let _gmSession = null;

function _gmStopSession() {
  if (!_gmSession) return;
  clearTimeout(_gmSession.timer);
  _gmSession.controller?.abort();
  _gmSession = null;
}

window.closeGameModal = function() {
  _gmStopSession();
  document.getElementById('game-modal-overlay')?.classList.remove('open');
  if (_gmEscKey) { document.removeEventListener('keydown', _gmEscKey); _gmEscKey = null; }
  if (_gmPrevFocus?.focus) { _gmPrevFocus.focus(); _gmPrevFocus = null; }
};

window.switchGameTab = function(btn, panelId) {
  const inner = document.getElementById('game-modal-inner');
  if (!inner) return;
  inner.querySelectorAll('.gm-tab').forEach(t => t.classList.remove('active'));
  inner.querySelectorAll('.gm-tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  inner.querySelector('#' + panelId)?.classList.add('active');
};

window.openGameDetailModal = function(espnEventId, sport, fallback) {
  const overlay = document.getElementById('game-modal-overlay');
  const inner   = document.getElementById('game-modal-inner');
  if (!overlay || !inner) return;
  _gmStopSession();
  if (_gmEscKey) document.removeEventListener('keydown', _gmEscKey);

  overlay.onclick = (e) => { if (e.target === overlay) window.closeGameModal(); };
  _gmEscKey = (e) => { if (e.key === 'Escape') window.closeGameModal(); };
  document.addEventListener('keydown', _gmEscKey);

  inner.innerHTML = '<div class="game-modal-spinner"></div>';
  overlay.classList.add('open');
  // Basic dialog a11y: move focus in, restore on close (closeGameModal).
  _gmPrevFocus = document.activeElement;
  overlay.querySelector('.game-modal-close')?.focus();

  if (!espnEventId) {
    _gmRenderFallback(inner, fallback);
    return;
  }

  const session = { espnEventId, sport, fallback, inner, loaded: false, timer: null };
  _gmSession = session;
  _gmRefresh(session);
};

async function _gmRefresh(session) {
  if (_gmSession !== session) return;
  // Background tabs resume on visibilitychange without polling ESPN while hidden.
  if (document.hidden) return;
  clearTimeout(session.timer);
  session.refreshMs = 30000; // Back off after errors; upcoming games also use 30s.
  session.controller = new AbortController();
  const timeout = setTimeout(() => session.controller.abort(), 15000);
  try {
    const res = await fetch(`/api/game/${encodeURIComponent(session.espnEventId)}?sport=${encodeURIComponent(session.sport || '')}`, { signal: session.controller.signal });
    if (!res.ok) throw new Error('Game data unavailable');
    const data = await res.json();
    if (_gmSession !== session) return;
    if (data.error || !data.header?.competitions?.[0]) throw new Error('Game data unavailable');
    const inner = session.inner;
    const modal = document.getElementById('game-modal');
    const scroll = modal.scrollTop;
    const bounds = modal.getBoundingClientRect();
    const anchor = scroll > 0 ? [...inner.querySelectorAll('.gm-tab-panel.active [data-gc-play]')].find(el => {
      const rect = el.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    }) : null;
    const anchorId = anchor?.dataset.gcPlay;
    const anchorTop = anchor?.getBoundingClientRect().top;
    const activeTab = inner.querySelector('.gm-tab-panel.active')?.id;
    const driveState = new Map([...inner.querySelectorAll('[data-gm-drive]')].map(el => [el.dataset.gmDrive, el.open]));
    const focused = document.activeElement;
    const focusTab = focused?.classList.contains('gm-tab') ? focused.dataset.gmTab : null;
    const focusDrive = focused?.closest('[data-gm-drive]')?.dataset.gmDrive;
    const h2h = session.loaded ? inner.querySelector('#gm-h2h')?.innerHTML : undefined;
    _gmRenderStats(inner, data, session.sport, h2h);
    if (activeTab) {
      const button = [...inner.querySelectorAll('.gm-tab')].find(el => el.dataset.gmTab === activeTab);
      if (button) window.switchGameTab(button, activeTab);
    }
    inner.querySelectorAll('[data-gm-drive]').forEach(el => {
      if (driveState.has(el.dataset.gmDrive)) el.open = driveState.get(el.dataset.gmDrive);
    });
    if (focusTab) [...inner.querySelectorAll('.gm-tab')].find(el => el.dataset.gmTab === focusTab)?.focus({ preventScroll: true });
    if (focusDrive) [...inner.querySelectorAll('[data-gm-drive]')].find(el => el.dataset.gmDrive === focusDrive)?.querySelector('summary')?.focus({ preventScroll: true });
    modal.scrollTop = scroll;
    if (anchorId) {
      const restored = [...inner.querySelectorAll('.gm-tab-panel.active [data-gc-play]')].find(el => el.dataset.gcPlay === anchorId);
      if (restored) modal.scrollTop += restored.getBoundingClientRect().top - anchorTop;
    }
    session.loaded = true;
    session.completed = data.header.competitions[0].status?.type?.completed === true;
    session.refreshMs = data.header.competitions[0].status?.type?.state === 'in' ? 5000 : 30000;
    const status = inner.querySelector('.gm-refresh-status');
    if (status) status.textContent = session.completed ? 'Final · Updates complete' : `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · Refreshes every ${session.refreshMs / 1000} seconds`;
  } catch (err) {
    if (_gmSession !== session) return;
    if (!session.loaded) {
      _gmRenderFallback(session.inner, session.fallback);
      session.inner.insertAdjacentHTML('beforeend', '<p class="gm-refresh-status" role="status">Game details unavailable. Retrying in 30 seconds.</p>');
    } else {
      const status = session.inner.querySelector('.gm-refresh-status');
      if (status) status.textContent = 'Updates interrupted · Showing last received data. Retrying in 30 seconds.';
    }
  } finally {
    clearTimeout(timeout);
    session.controller = null;
    if (_gmSession === session && !session.completed && !document.hidden) session.timer = setTimeout(() => _gmRefresh(session), session.refreshMs);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!_gmSession) return;
  clearTimeout(_gmSession.timer);
  if (!document.hidden && !_gmSession.completed && !_gmSession.controller) _gmRefresh(_gmSession);
});

function _gmRenderFallback(container, fallback) {
  if (!fallback) { container.innerHTML = ''; return; }
  const hdr = `<div class="gm-header">
    <div class="gm-headline">${esc(fallback.sport || '')}</div>
    <div style="font-size:1.1rem;font-weight:700;color:white;margin-bottom:8px;padding-right:36px">${rankBadgeHTML(fallback.oppRank)}${esc(shortTitle(fallback.title || ''))}</div>
  </div>`;
  const rows = [];
  if (fallback.startTime) rows.push(`<div class="gm-fallback-row"><span class="gm-fallback-icon">📅</span><span class="gm-fallback-label">When</span><span class="gm-fallback-value">${esc(formatTs(fallback.startTime))}</span></div>`);
  if (fallback.location) rows.push(`<div class="gm-fallback-row"><span class="gm-fallback-icon">📍</span><span class="gm-fallback-label">Venue</span><span class="gm-fallback-value">${esc(fallback.location)}</span></div>`);
  if (fallback.tvNetwork) rows.push(`<div class="gm-fallback-row"><span class="gm-fallback-icon">📺</span><span class="gm-fallback-label">TV</span><span class="gm-fallback-value">${esc(fallback.tvNetwork)}</span></div>`);
  container.innerHTML = hdr
    + (rows.length ? `<div class="gm-fallback">${rows.join('')}</div>` : '')
    + '<div id="gm-h2h"></div>';
  window.loadH2hInto('gm-h2h', fallback.sport, fallback.title);
}

function _gmRenderStats(container, data, sport, h2hHtml) {
  const comp = data?.header?.competitions?.[0];
  if (!comp) { _gmRenderFallback(container, {}); return; }

  const competitors = comp.competitors || [];
  const statusDesc  = comp.status?.type?.description || '';
  const completed   = comp.status?.type?.completed === true;
  const shortDetail = comp.status?.type?.shortDetail || '';
  const headline    = (comp.notes || [])[0]?.headline || '';

  // Identify ASU vs opponent
  const asuTeam = competitors.find(c =>
    (c.team?.displayName || '').toLowerCase().includes('arizona state') ||
    (c.team?.abbreviation || '').toUpperCase() === 'ASU'
  );
  const oppTeam = competitors.find(c => c !== asuTeam);

  const asuScore = parseInt(asuTeam?.score, 10);
  const oppScore = parseInt(oppTeam?.score, 10);
  const asuWins  = completed && !isNaN(asuScore) && !isNaN(oppScore) && asuScore > oppScore;
  const oppWins  = completed && !isNaN(asuScore) && !isNaN(oppScore) && oppScore > asuScore;

  // Status badge
  const badgeCls  = completed ? 'gm-status-final' : statusDesc === 'In Progress' ? 'gm-status-live' : 'gm-status-pre';
  const badgeText = completed ? 'Final' : statusDesc === 'In Progress' ? 'LIVE' : statusDesc;

  // Venue / meta
  const gameInfo  = data?.gameInfo;
  const venue     = gameInfo?.venue?.fullName || '';
  const city      = gameInfo?.venue?.address?.city || '';
  const stateName = gameInfo?.venue?.address?.state || '';
  const attend    = gameInfo?.attendance;
  const bcast     = comp.broadcasts?.[0]?.names?.[0] || comp.broadcast || '';

  function teamLogoHtml(team) {
    const logo = team?.team?.logos?.[0]?.href || team?.team?.logo;
    const name = team?.team?.displayName || team?.team?.name || '';
    if (isUA(name, logo)) {
      return `<div class="gm-team-logo-placeholder" title="University of Arizona" style="font-size:2.5rem;background:none;border-color:transparent;display:flex;align-items:center;justify-content:center;">💩</div>`;
    }
    if (logo) return `<img class="gm-team-logo" src="${esc(logo)}" alt="" loading="lazy">`;
    return `<div class="gm-team-logo-placeholder">${esc((team?.team?.abbreviation || '???').slice(0,3).toUpperCase())}</div>`;
  }

  const metaRows = [];
  const locStr = [venue, [city, stateName].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  if (locStr) metaRows.push(`<div class="gm-meta-row">📍 ${esc(locStr)}</div>`);
  if (attend) metaRows.push(`<div class="gm-meta-row">👥 Att: ${attend.toLocaleString()}</div>`);
  if (bcast)  metaRows.push(`<div class="gm-meta-row">📺 ${esc(bcast)}</div>`);

  const hdrHtml = `
    <div class="gm-header">
      <div class="gm-headline">${esc(headline || sport || '')}</div>
      <div class="gm-scores">
        <div class="gm-team">
          ${asuTeam ? teamLogoHtml(asuTeam) : '<div class="gm-team-logo-placeholder">ASU</div>'}
          <div class="gm-team-name">${rankBadgeHTML(asuTeam?.rank)}${esc(asuTeam?.team?.displayName || 'Arizona State')}</div>
          <div class="gm-score${asuWins ? ' gm-winner' : ''}">${esc(asuTeam?.score ?? '–')}</div>
        </div>
        <div class="gm-vs">–</div>
        <div class="gm-team">
          ${oppTeam ? teamLogoHtml(oppTeam) : '<div class="gm-team-logo-placeholder">OPP</div>'}
          <div class="gm-team-name">${rankBadgeHTML(oppTeam?.rank)}${esc(oppTeam?.team?.displayName || 'Opponent')}</div>
          <div class="gm-score${oppWins ? ' gm-winner' : ''}">${esc(oppTeam?.score ?? '–')}</div>
        </div>
      </div>
      <div class="gm-status">
        <span class="gm-status-badge ${badgeCls}">${esc(badgeText)}</span>
        ${shortDetail && !completed ? `<span class="gm-status-detail">${esc(shortDetail)}</span>` : ''}
      </div>
      ${metaRows.length ? `<div class="gm-meta">${metaRows.join('')}</div>` : ''}
    </div>`;

  const lsHtml = _gmBuildLinescore(comp, competitors, asuTeam, sport);
  const box    = _gmBuildBoxScore(data?.boxscore, asuTeam, sport);
  const plays  = _gmBuildPlays(data, sport, asuTeam, competitors);
  const gamecast = window.buildGamecastPanel(data, sport, asuTeam, competitors);

  const tabs = [...(gamecast ? [gamecast.tab] : []), ...box.tabs, ...(plays ? [plays.tab] : [])];
  const tabsHtml = tabs.length
    ? `<div class="gm-tabs">${tabs.map(t =>
        `<button class="gm-tab" data-gm-tab="${t.id}" onclick="switchGameTab(this,'${t.id}')">${esc(t.label)}</button>`).join('')}</div>`
    : '';

  container.innerHTML = hdrHtml +
    `<div class="gm-body"><p class="gm-refresh-status" role="status"></p><div id="gm-h2h"></div>${lsHtml}${tabsHtml}${gamecast ? gamecast.panel : ''}${box.panels}${plays ? plays.panel : ''}</div>`;
  container.querySelector('.gm-tab')?.click();
  if (h2hHtml !== undefined) container.querySelector('#gm-h2h').innerHTML = h2hHtml;
  else window.loadH2hInto('gm-h2h', sport, oppTeam?.team?.displayName);
}

// ── Scoring plays tab ─────────────────────────────────────────────────────────
// Football summaries ship ready-made scoringPlays; baseball/softball and
// basketball flag scoring plays inside the full pitch/possession play list.

function _gmOrdinal(n) {
  const s = ['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4)] || 'th';
  return `${n}${s}`;
}

function _gmPeriodLabel(sport, period) {
  const n = period?.number;
  if (period?.type && period?.displayValue) {
    return `${period.type} ${period.displayValue.replace(/ Inning$/, '')}`; // "Top 1st"
  }
  if (!n) return '';
  if (sport === 'Football') return n <= 4 ? `${_gmOrdinal(n)} Quarter` : `OT${n > 5 ? n - 4 : ''}`;
  if (sport === "Men's Basketball" || sport === 'Basketball') return n <= 2 ? `${_gmOrdinal(n)} Half` : `OT${n > 3 ? n - 2 : ''}`;
  if (sport === "Women's Basketball") return n <= 4 ? `${_gmOrdinal(n)} Quarter` : `OT${n > 5 ? n - 4 : ''}`;
  return period?.displayValue || _gmOrdinal(n);
}

function _gmBuildPlays(data, sport, asuTeam, competitors) {
  const asuTeamId = String(asuTeam?.team?.id ?? asuTeam?.id ?? '');
  const raw = data?.scoringPlays?.length
    ? data.scoringPlays
    : (data?.plays || []).filter(p => p.scoringPlay === true);
  if (!raw.length) return null;

  const away = competitors.find(c => c.homeAway === 'away');
  const home = competitors.find(c => c.homeAway === 'home');
  const awayAbbr = (away?.team?.abbreviation || 'AWAY').toUpperCase();
  const homeAbbr = (home?.team?.abbreviation || 'HOME').toUpperCase();

  const groups = [];
  for (const p of raw) {
    const label = _gmPeriodLabel(sport, p.period);
    if (!groups.length || groups[groups.length - 1].label !== label) {
      groups.push({ label, plays: [] });
    }
    groups[groups.length - 1].plays.push(p);
  }

  const groupsHtml = groups.map(g => {
    const rows = g.plays.map(p => {
      const isAsu = p.team?.id != null && String(p.team.id) === asuTeamId;
      const side = [
        p.clock?.displayValue ? `<span class="gm-play-clock">${esc(p.clock.displayValue)}</span>` : '',
        p.awayScore != null && p.homeScore != null
          ? `<span class="gm-play-score">${esc(awayAbbr)} ${esc(p.awayScore)}, ${esc(homeAbbr)} ${esc(p.homeScore)}</span>`
          : '',
      ].join('');
      const typeText = p.type?.text && p.type.text !== 'Play Result' ? p.type.text : '';
      return `<div class="gm-play-row${isAsu ? ' gm-play-asu' : ''}">
        <div class="gm-play-main">
          ${typeText ? `<span class="gm-play-type">${esc(typeText)}</span>` : ''}
          <span class="gm-play-text">${esc(p.text || '')}</span>
        </div>
        <div class="gm-play-side">${side}</div>
      </div>`;
    }).join('');
    return `<div class="gm-plays-group">
      ${g.label ? `<div class="gm-plays-period">${esc(g.label)}</div>` : ''}
      ${rows}
    </div>`;
  }).join('');

  return {
    tab: { id: 'gm-plays', label: 'Scoring' },
    panel: `<div id="gm-plays" class="gm-tab-panel">${groupsHtml}</div>`,
  };
}

// ── Head-to-head strip (local DB via /api/h2h) ────────────────────────────────
// Shared with the plain event modal in filters.js, hence window-exposed.

window.loadH2hInto = function(elId, sport, opponent) {
  if (!sport || !opponent) return;
  const target = document.getElementById(elId);
  fetch(`/api/h2h?sport=${encodeURIComponent(sport)}&opponent=${encodeURIComponent(opponent)}`)
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      const el = document.getElementById(elId);
      if (!el || el !== target || !d || !d.games) return;
      el.innerHTML = _h2hStripHtml(d);
    })
    .catch(() => {});
};

function _h2hStripHtml(d) {
  const name = shortOppName(d.opponent);
  const lead = d.w > d.l ? `ASU leads ${d.w}–${d.l}`
    : d.l > d.w ? `${esc(name)} leads ${d.l}–${d.w}`
    : `Series tied ${d.w}–${d.l}`;
  const tie = d.t ? ` (${d.t} tie${d.t > 1 ? 's' : ''})` : '';
  const rows = d.meetings.map(m => {
    const date = new Date(m.startDate * 1000)
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const cls = m.result === 'W' ? 'score-w' : m.result === 'L' ? 'score-l' : 'score-t';
    const where = m.gameType ? m.gameType.charAt(0).toUpperCase() + m.gameType.slice(1) : '';
    return `<div class="h2h-row">
      <span class="h2h-date">${esc(date)}</span>
      <span class="score-badge ${cls}">${esc(m.result)} ${esc(m.asuScore)}–${esc(m.oppScore)}</span>
      <span class="h2h-where">${esc(where)}</span>
    </div>`;
  }).join('');
  return `<div class="h2h-strip">
    <div class="h2h-head">Head-to-head vs ${esc(name)} · <strong>${lead}${tie}</strong></div>
    <div class="h2h-rows">${rows}</div>
  </div>`;
}

function _gmBuildLinescore(comp, competitors, asuTeam, sport) {
  const sports = ['Baseball', 'Softball', 'Football', "Women's Soccer", "Men's Soccer", 'Soccer'];
  if (!sports.includes(sport)) return '';
  const ls0 = competitors[0]?.linescores || [];
  const ls1 = competitors[1]?.linescores || [];
  const n = Math.max(ls0.length, ls1.length);
  if (!n) return '';

  const isBaseball = sport === 'Baseball' || sport === 'Softball';
  const completed  = comp.status?.type?.completed;

  let periodHdrs;
  if (isBaseball) {
    periodHdrs = Array.from({ length: n }, (_, i) => String(i + 1));
  } else if (sport === 'Football') {
    const base = ['1','2','3','4'];
    for (let i = 4; i < n; i++) base.push(`OT${i === 4 ? '' : i - 3}`);
    periodHdrs = base.slice(0, n);
  } else {
    periodHdrs = n === 2 ? ['1st','2nd'] : Array.from({ length: n }, (_, i) => String(i + 1));
  }

  const sc0 = parseInt(competitors[0]?.score, 10);
  const sc1 = parseInt(competitors[1]?.score, 10);
  const c0w  = completed && !isNaN(sc0) && !isNaN(sc1) && sc0 > sc1;
  const c1w  = completed && !isNaN(sc0) && !isNaN(sc1) && sc1 > sc0;

  // Put ASU first
  const asuIdx = competitors.indexOf(asuTeam);
  const ordered = asuIdx === 0
    ? [[competitors[0], c0w], [competitors[1], c1w]]
    : [[competitors[1], c1w], [competitors[0], c0w]];

  function buildRow([comp, isWin]) {
    const abbr = (comp?.team?.abbreviation || comp?.team?.displayName?.slice(0,4) || '???').toUpperCase();
    const ls   = comp?.linescores || [];
    const score = comp?.score ?? '–';
    const cells = Array.from({ length: n }, (_, i) =>
      `<td>${esc(ls[i]?.displayValue ?? '–')}</td>`).join('');

    let rheCells;
    if (isBaseball) {
      const hasH = ls.some(c => c?.hits != null);
      const hasE = ls.some(c => c?.errors != null);
      const totalH = hasH ? ls.reduce((s, c) => s + (c?.hits ?? 0), 0) : null;
      const totalE = hasE ? ls.reduce((s, c) => s + (c?.errors ?? 0), 0) : null;
      rheCells = `<td class="gm-ls-rhe"><strong>${esc(score)}</strong></td><td class="gm-ls-rhe">${totalH != null ? totalH : '–'}</td><td class="gm-ls-rhe">${totalE != null ? totalE : '–'}</td>`;
    } else {
      rheCells = `<td><strong>${esc(score)}</strong></td>`;
    }
    const cls = isWin ? ' class="gm-linescore-winner"' : '';
    return `<tr${cls}><td><strong>${esc(abbr)}</strong></td>${cells}${rheCells}</tr>`;
  }

  const pHtml  = periodHdrs.map(h => `<th>${esc(h)}</th>`).join('');
  const rhHtml = isBaseball ? '<th class="gm-ls-rhe">R</th><th class="gm-ls-rhe">H</th><th class="gm-ls-rhe">E</th>' : '<th>Total</th>';

  return `<div class="gm-linescore"><table class="gm-linescore-table">
    <thead><tr><th>Team</th>${pHtml}${rhHtml}</tr></thead>
    <tbody>${ordered.map(buildRow).join('')}</tbody>
  </table></div>`;
}

function _gmBuildBoxScore(boxscore, asuTeam, sport) {
  if (!boxscore?.players?.length) return { tabs: [], panels: '' };
  const isBaseball = sport === 'Baseball' || sport === 'Softball';
  const asuName = asuTeam?.team?.displayName || '';

  // Sort: ASU first
  const players = [...boxscore.players].sort((a, b) => {
    const aIsAsu = a.team?.displayName === asuName;
    const bIsAsu = b.team?.displayName === asuName;
    return aIsAsu ? -1 : bIsAsu ? 1 : 0;
  });

  function buildPanel(groupIdx, panelId) {
    const sections = players.map(teamData => {
      const tName  = teamData.team?.displayName || 'Team';
      const isAsu  = tName === asuName;
      const grp    = (teamData.statistics || [])[groupIdx];
      if (!grp) return '';
      const labels   = grp.labels || [];
      const athletes = grp.athletes || [];
      if (!athletes.length) return '';
      const thCells = labels.map(l => `<th>${esc(l)}</th>`).join('');
      const rows = athletes.map(a => {
        const starter = a.starter === true;
        const cells   = (a.stats || []).map(s => `<td>${esc(s)}</td>`).join('');
        const cls     = [starter ? 'st-starter' : '', isAsu ? 'st-asu-row' : ''].filter(Boolean).join(' ');
        return `<tr class="${cls}"><td>${esc(a.athlete?.displayName || '')}</td>${cells}</tr>`;
      }).join('');
      return `<div class="gm-stats-section">
        <div class="gm-stats-team-header">${esc(tName)}</div>
        <div class="gm-stats-table-wrap"><table class="gm-stats-table">
          <thead><tr><th>Player</th>${thCells}</tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`;
    }).join('');
    return `<div id="${panelId}" class="gm-tab-panel">${sections}</div>`;
  }

  if (isBaseball) {
    return {
      tabs: [{ id: 'gm-batting', label: 'Batting' }, { id: 'gm-pitching', label: 'Pitching' }],
      panels: buildPanel(0, 'gm-batting') + buildPanel(1, 'gm-pitching'),
    };
  }

  return {
    tabs: [{ id: 'gm-stats', label: 'Player Stats' }],
    panels: buildPanel(0, 'gm-stats'),
  };
}
