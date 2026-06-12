// game-modal.js — ESPN box-score modal (header, linescore, player stats tabs).
// Extracted from filters.js; uses esc/shortTitle/formatTs from shared.js and is
// invoked lazily via window.openGameDetailModal from live.js, list rows, and
// map popups. Loads after filters.js, before live.js.

// ── Game Detail Modal (box score) ─────────────────────────────────────────────

let _gmEscKey = null;

window.closeGameModal = function() {
  document.getElementById('game-modal-overlay')?.classList.remove('open');
  if (_gmEscKey) { document.removeEventListener('keydown', _gmEscKey); _gmEscKey = null; }
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

  overlay.onclick = (e) => { if (e.target === overlay) window.closeGameModal(); };
  _gmEscKey = (e) => { if (e.key === 'Escape') window.closeGameModal(); };
  document.addEventListener('keydown', _gmEscKey);

  inner.innerHTML = '<div class="game-modal-spinner"></div>';
  overlay.classList.add('open');

  if (!espnEventId) {
    _gmRenderFallback(inner, fallback);
    return;
  }

  fetch(`/api/game/${encodeURIComponent(espnEventId)}?sport=${encodeURIComponent(sport || '')}`)
    .then(r => r.json())
    .then(data => {
      if (data.error) _gmRenderFallback(inner, fallback);
      else _gmRenderStats(inner, data, sport);
    })
    .catch(() => _gmRenderFallback(inner, fallback));
};

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
  container.innerHTML = hdr + (rows.length ? `<div class="gm-fallback">${rows.join('')}</div>` : '');
}

function _gmRenderStats(container, data, sport) {
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

  const lsHtml   = _gmBuildLinescore(comp, competitors, asuTeam, sport);
  const boxHtml  = _gmBuildBoxScore(data?.boxscore, asuTeam, sport);

  container.innerHTML = hdrHtml + `<div class="gm-body">${lsHtml}${boxHtml}</div>`;
  container.querySelector('.gm-tab')?.click();
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
  if (!boxscore?.players?.length) return '';
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
    return `<div class="gm-tabs">
      <button class="gm-tab" onclick="switchGameTab(this,'gm-batting')">Batting</button>
      <button class="gm-tab" onclick="switchGameTab(this,'gm-pitching')">Pitching</button>
    </div>
    ${buildPanel(0, 'gm-batting')}
    ${buildPanel(1, 'gm-pitching')}`;
  }

  return `<div class="gm-tabs">
    <button class="gm-tab" onclick="switchGameTab(this,'gm-stats')">Player Stats</button>
  </div>
  ${buildPanel(0, 'gm-stats')}`;
}
