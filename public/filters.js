// Global filter state
const filters = {
  sports: new Set(),
  gameTypes: new Set(),
  city: '',
  region: '',
  state: '',
  from: '',
  to: '',
};

const REGIONS = {
  'Southwest':         ['Arizona', 'New Mexico', 'Texas', 'Oklahoma'],
  'West':              ['California', 'Nevada', 'Utah', 'Colorado'],
  'Pacific Northwest': ['Washington', 'Oregon', 'Idaho'],
  'Midwest':           ['Illinois', 'Ohio', 'Indiana', 'Michigan', 'Wisconsin', 'Minnesota', 'Iowa', 'Missouri', 'Kansas', 'Nebraska', 'North Dakota', 'South Dakota'],
  'Southeast':         ['Florida', 'Georgia', 'Alabama', 'Mississippi', 'Tennessee', 'South Carolina', 'North Carolina', 'Virginia', 'Kentucky', 'Arkansas', 'Louisiana'],
  'Northeast':         ['New York', 'Pennsylvania', 'New Jersey', 'Connecticut', 'Massachusetts', 'Rhode Island', 'Vermont', 'New Hampshire', 'Maine', 'Maryland', 'Delaware', 'District of Columbia', 'West Virginia'],
  'Mountain':          ['Montana', 'Wyoming', 'Idaho'],
  'Hawaii/Alaska':     ['Hawaii', 'Alaska'],
};

let allLocations = [];

// Sport color palette — cycles through these
const SPORT_COLORS = [
  '#8C1D40', '#C0392B', '#27AE60', '#2980B9', '#8E44AD',
  '#D35400', '#16A085', '#2C3E50', '#E74C3C', '#1ABC9C',
  '#F39C12', '#6C3483', '#1F618D', '#117A65', '#7D6608',
];
const sportColorMap = {};
let colorIdx = 0;

function sportColor(sport) {
  if (!sport) return '#8C1D40';
  if (!sportColorMap[sport]) {
    sportColorMap[sport] = SPORT_COLORS[colorIdx % SPORT_COLORS.length];
    colorIdx++;
  }
  return sportColorMap[sport];
}

async function loadFilterOptions() {
  const [sports, locations] = await Promise.all([
    fetch('/api/sports').then(r => r.json()),
    fetch('/api/locations').then(r => r.json()),
  ]);

  allLocations = locations;

  // Sport checkboxes
  const list = document.getElementById('sport-list');
  list.innerHTML = '';
  for (const sport of sports) {
    const color = sportColor(sport);
    const id = `sport-${sport.replace(/\W/g, '_')}`;
    const label = document.createElement('label');
    label.innerHTML = `
      <input type="checkbox" id="${id}" value="${sport}" onchange="toggleSport(this)" />
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></span>
      ${sport}
    `;
    list.appendChild(label);
  }

  // City dropdown
  const citySelect = document.getElementById('filter-city');
  const cities = [...new Set(locations.map(l => l.city).filter(Boolean))].sort();
  cities.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    citySelect.appendChild(opt);
  });

  // Region dropdown — only show regions that have at least one event location
  const regionSelect = document.getElementById('filter-region');
  const locationStates = new Set(locations.map(l => l.state).filter(Boolean));
  for (const [regionName, states] of Object.entries(REGIONS)) {
    if (states.some(s => locationStates.has(s))) {
      const opt = document.createElement('option');
      opt.value = regionName;
      opt.textContent = regionName;
      regionSelect.appendChild(opt);
    }
  }

  // State dropdown
  rebuildStateDropdown('');
}

function rebuildStateDropdown(region) {
  const stateSelect = document.getElementById('filter-state');
  const prevState = stateSelect.value;
  stateSelect.innerHTML = '<option value="">All States</option>';

  let states = [...new Set(allLocations.map(l => l.state).filter(Boolean))].sort();
  if (region && REGIONS[region]) {
    const regionSet = new Set(REGIONS[region]);
    states = states.filter(s => regionSet.has(s));
  }

  states.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    stateSelect.appendChild(opt);
  });

  // Restore prior selection only if it's still in the narrowed list
  if (prevState && states.includes(prevState)) stateSelect.value = prevState;
}

function toggleRegion(select) {
  filters.region = select.value;
  // Clear state selection if it no longer belongs to the new region
  if (filters.region && REGIONS[filters.region]) {
    const regionSet = new Set(REGIONS[filters.region]);
    if (filters.state && !regionSet.has(filters.state)) {
      filters.state = '';
    }
  }
  rebuildStateDropdown(filters.region);
  applyFilters();
}

function toggleSport(checkbox) {
  if (checkbox.checked) filters.sports.add(checkbox.value);
  else filters.sports.delete(checkbox.value);
  applyFilters();
}

function toggleGameType(btn) {
  const type = btn.dataset.type;
  if (btn.classList.contains('active')) {
    btn.classList.remove('active');
    filters.gameTypes.delete(type);
  } else {
    btn.classList.add('active');
    filters.gameTypes.add(type);
  }
  applyFilters();
}

function applyFilters() {
  filters.city = document.getElementById('filter-city').value;
  filters.region = document.getElementById('filter-region').value;
  filters.state = document.getElementById('filter-state').value;
  filters.from = document.getElementById('filter-from').value;
  filters.to = document.getElementById('filter-to').value;
  window.reloadEvents && window.reloadEvents();
}

function clearFilters() {
  filters.sports.clear();
  filters.gameTypes.clear();
  filters.city = '';
  filters.region = '';
  filters.state = '';
  filters.from = '';
  filters.to = '';

  document.querySelectorAll('#sport-list input[type=checkbox]').forEach(cb => cb.checked = false);
  document.querySelectorAll('.game-type-toggles button').forEach(b => b.classList.remove('active'));
  document.getElementById('filter-city').value = '';
  document.getElementById('filter-region').value = '';
  document.getElementById('filter-from').value = '';
  document.getElementById('filter-to').value = '';
  rebuildStateDropdown('');

  window.reloadEvents && window.reloadEvents();
}

function buildQueryString() {
  const params = new URLSearchParams();
  if (filters.sports.size === 1) params.set('sport', [...filters.sports][0]);
  if (filters.gameTypes.size === 1) params.set('game_type', [...filters.gameTypes][0]);
  if (filters.city) params.set('city', filters.city);
  if (filters.region) params.set('region', filters.region);
  if (filters.state) params.set('state', filters.state);
  if (filters.from) params.set('from', Math.floor(new Date(filters.from).getTime() / 1000));
  if (filters.to) params.set('to', Math.floor(new Date(filters.to + 'T23:59:59').getTime() / 1000));
  return params.toString();
}

async function fetchEvents() {
  const qs = buildQueryString();
  const all = await fetch(`/api/events${qs ? '?' + qs : ''}`).then(r => r.json());

  // Client-side multi-sport / multi-game-type filtering (API only supports single value)
  return all.filter(e => {
    if (filters.sports.size > 1 && !filters.sports.has(e.sport)) return false;
    if (filters.gameTypes.size > 1 && !filters.gameTypes.has(e.game_type)) return false;
    return true;
  });
}

// ── Modal ──────────────────────────────────────────────

function shortTitle(title) {
  if (!title) return 'Event';
  return title
    .replace(/^Sun Devil [^:]+:\s*/i, '')
    .replace(/^Arizona State\s+/i, '');
}

function cleanDisplayAddress(addr) {
  if (!addr) return '';
  return addr
    .replace(/(?:#[^,\s]+|\b(?:Suite|Ste\.?|Unit)\s+\w+)\s*/gi, '')
    .trim()
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*$/, '');
}

function formatTs(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  // Midnight Phoenix = feed placeholder for "time unknown" — show date only (no time).
  // Keep the Phoenix check here since it's a feed artifact, not a display concern.
  const phoenixTime = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix' });
  if (phoenixTime === '12:00 AM') {
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

// ── Game Detail Modal (box score) ─────────────────────────────────────────────

function _gmEsc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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
    <div class="gm-headline">${_gmEsc(fallback.sport || '')}</div>
    <div style="font-size:1.1rem;font-weight:700;color:white;margin-bottom:8px;padding-right:36px">${_gmEsc(shortTitle(fallback.title || ''))}</div>
  </div>`;
  const rows = [];
  if (fallback.startTime) rows.push(`<div class="gm-fallback-row"><span class="gm-fallback-icon">📅</span><span class="gm-fallback-label">When</span><span class="gm-fallback-value">${_gmEsc(formatTs(fallback.startTime))}</span></div>`);
  if (fallback.location) rows.push(`<div class="gm-fallback-row"><span class="gm-fallback-icon">📍</span><span class="gm-fallback-label">Venue</span><span class="gm-fallback-value">${_gmEsc(fallback.location)}</span></div>`);
  if (fallback.tvNetwork) rows.push(`<div class="gm-fallback-row"><span class="gm-fallback-icon">📺</span><span class="gm-fallback-label">TV</span><span class="gm-fallback-value">${_gmEsc(fallback.tvNetwork)}</span></div>`);
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
    if (logo) return `<img class="gm-team-logo" src="${_gmEsc(logo)}" alt="" loading="lazy">`;
    return `<div class="gm-team-logo-placeholder">${_gmEsc((team?.team?.abbreviation || '???').slice(0,3).toUpperCase())}</div>`;
  }

  const metaRows = [];
  const locStr = [venue, [city, stateName].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  if (locStr) metaRows.push(`<div class="gm-meta-row">📍 ${_gmEsc(locStr)}</div>`);
  if (attend) metaRows.push(`<div class="gm-meta-row">👥 Att: ${attend.toLocaleString()}</div>`);
  if (bcast)  metaRows.push(`<div class="gm-meta-row">📺 ${_gmEsc(bcast)}</div>`);

  const hdrHtml = `
    <div class="gm-header">
      <div class="gm-headline">${_gmEsc(headline || sport || '')}</div>
      <div class="gm-scores">
        <div class="gm-team">
          ${asuTeam ? teamLogoHtml(asuTeam) : '<div class="gm-team-logo-placeholder">ASU</div>'}
          <div class="gm-team-name">${_gmEsc(asuTeam?.team?.displayName || 'Arizona State')}</div>
          <div class="gm-score${asuWins ? ' gm-winner' : ''}">${_gmEsc(asuTeam?.score ?? '–')}</div>
        </div>
        <div class="gm-vs">–</div>
        <div class="gm-team">
          ${oppTeam ? teamLogoHtml(oppTeam) : '<div class="gm-team-logo-placeholder">OPP</div>'}
          <div class="gm-team-name">${_gmEsc(oppTeam?.team?.displayName || 'Opponent')}</div>
          <div class="gm-score${oppWins ? ' gm-winner' : ''}">${_gmEsc(oppTeam?.score ?? '–')}</div>
        </div>
      </div>
      <div class="gm-status">
        <span class="gm-status-badge ${badgeCls}">${_gmEsc(badgeText)}</span>
        ${shortDetail && !completed ? `<span class="gm-status-detail">${_gmEsc(shortDetail)}</span>` : ''}
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
      `<td>${_gmEsc(ls[i]?.displayValue ?? '–')}</td>`).join('');

    let rheCells;
    if (isBaseball) {
      const hasH = ls.some(c => c?.hits != null);
      const hasE = ls.some(c => c?.errors != null);
      const totalH = hasH ? ls.reduce((s, c) => s + (c?.hits ?? 0), 0) : null;
      const totalE = hasE ? ls.reduce((s, c) => s + (c?.errors ?? 0), 0) : null;
      rheCells = `<td class="gm-ls-rhe"><strong>${_gmEsc(score)}</strong></td><td class="gm-ls-rhe">${totalH != null ? totalH : '–'}</td><td class="gm-ls-rhe">${totalE != null ? totalE : '–'}</td>`;
    } else {
      rheCells = `<td><strong>${_gmEsc(score)}</strong></td>`;
    }
    const cls = isWin ? ' class="gm-linescore-winner"' : '';
    return `<tr${cls}><td><strong>${_gmEsc(abbr)}</strong></td>${cells}${rheCells}</tr>`;
  }

  const pHtml  = periodHdrs.map(h => `<th>${_gmEsc(h)}</th>`).join('');
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
      const thCells = labels.map(l => `<th>${_gmEsc(l)}</th>`).join('');
      const rows = athletes.map(a => {
        const starter = a.starter === true;
        const cells   = (a.stats || []).map(s => `<td>${_gmEsc(s)}</td>`).join('');
        const cls     = [starter ? 'st-starter' : '', isAsu ? 'st-asu-row' : ''].filter(Boolean).join(' ');
        return `<tr class="${cls}"><td>${_gmEsc(a.athlete?.displayName || '')}</td>${cells}</tr>`;
      }).join('');
      return `<div class="gm-stats-section">
        <div class="gm-stats-team-header">${_gmEsc(tName)}</div>
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

// ── Event modal (existing) with ESPN intercept ────────────────────────────────

function openEventModal(event) {
  // If there is a live/recent ESPN match, open the box score modal instead
  const liveGame = window.__liveData?.[event.id];
  if (liveGame?.espnEventId && window.openGameDetailModal) {
    window.openGameDetailModal(liveGame.espnEventId, event.sport, {
      title:     event.title,
      sport:     event.sport,
      startTime: event.start_date,
      location:  event.location_name || [event.city, event.state].filter(Boolean).join(', ') || null,
      tvNetwork: event.tv_network || null,
    });
    return;
  }

  document.getElementById('modal-title').textContent = shortTitle(event.title);
  document.getElementById('modal-sport').textContent = [event.sport, event.event_type].filter(Boolean).join(' · ');

  const logo = document.getElementById('modal-logo');
  if (event.opponent_logo) {
    logo.src = event.opponent_logo;
    logo.style.display = '';
  } else {
    logo.style.display = 'none';
  }

  const body = document.getElementById('modal-body');
  const rows = [];

  // liveGame already checked above for ESPN intercept; re-read for LIVE badge in existing modal
  const liveGameBadge = window.__liveData?.[event.id];
  if (liveGameBadge) {
    rows.push(row('🔴', 'Live', `<span class="live-badge-modal">LIVE</span> <strong>${liveGameBadge.asuScore}–${liveGameBadge.oppScore}</strong> <span class="live-situation">${liveGameBadge.situation}</span>`));
  } else if (event.result) {
    const scoreClass = event.result === 'W' ? 'score-w' : event.result === 'L' ? 'score-l' : 'score-t';
    const label = event.result === 'W' ? 'Win' : event.result === 'L' ? 'Loss' : 'Tie';
    rows.push(row('🏆', 'Result', `<span class="score-badge ${scoreClass}">${event.result} ${event.asu_score}–${event.opp_score}</span> <span style="color:var(--text-muted);font-size:0.8rem">${label}</span>`));
  }

  const endStr = event.end_date && event.end_date !== event.start_date ? formatTs(event.end_date) : '';
  rows.push(row('📅', 'When', endStr ? `${formatTs(event.start_date)} – ${endStr}` : formatTs(event.start_date)));

  if (event.location_name || event.venue_address) {
    const cleanAddr = cleanDisplayAddress(event.venue_address);
    rows.push(row('📍', 'Venue', [event.location_name, cleanAddr].filter(Boolean).join('<br/>')));
  }
  if (event.city || event.state) {
    rows.push(row('🏙️', 'Location', [event.city, event.state].filter(Boolean).join(', ')));
  }
  if (event.game_type) {
    rows.push(row('🏟️', 'Type', capitalize(event.game_type)));
  }
  if (event.tv_network) {
    rows.push(row('📺', 'TV', event.tv_network));
  }
  if (event.season) {
    rows.push(row('📆', 'Season', event.season));
  }
  if (event.badges) {
    const badges = event.badges.split('|').filter(Boolean).map(b => `<span class="badge">${b.trim()}</span>`).join(' ');
    rows.push(row('⭐', 'Promotions', badges));
  }

  let actions = '';
  if (event.ticket_url) {
    actions += `<a class="modal-ticket-btn" href="${event.ticket_url}" target="_blank" rel="noopener">${event.ticket_label || 'Get Tickets'}</a>`;
  }
  if (event.node_url) {
    const href = event.node_url.startsWith('http') ? event.node_url : `https://sundevils.com${event.node_url}`;
    actions += `<a class="modal-event-link" href="${href}" target="_blank" rel="noopener">Event page ↗</a>`;
  }

  body.innerHTML = rows.join('') + actions;
  document.getElementById('modal-overlay').classList.add('open');
}

function row(icon, label, value) {
  return `<div class="modal-row"><span class="modal-row-icon">${icon}</span><span class="modal-row-label">${label}</span><span class="modal-row-value">${value}</span></div>`;
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function closeModal(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModalDirect();
}

function closeModalDirect() {
  document.getElementById('modal-overlay').classList.remove('open');
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModalDirect(); });

// ── Refresh ────────────────────────────────────────────

async function triggerRefresh() {
  const btn = document.getElementById('btn-refresh');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      btn.textContent = `Done (${data.count} events)`;
      window.reloadEvents && window.reloadEvents();
      loadFilterOptions();
    } else {
      btn.textContent = 'Error';
    }
  } catch {
    btn.textContent = 'Error';
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = 'Refresh'; }, 3000);
}

// ── Filters toggle (mobile) ────────────────────────────

function toggleFilters() {
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('btn-filters');
  const isOpen = sidebar.classList.toggle('open');
  btn.classList.toggle('active', isOpen);
}

// ── View toggle ────────────────────────────────────────

function setView(view) {
  const liveView = document.getElementById('live-view');
  const calView  = document.getElementById('calendar-view');
  const listView = document.getElementById('list-view');
  const mapView  = document.getElementById('map-view');
  const btnLive  = document.getElementById('btn-live-view');
  const btnCal   = document.getElementById('btn-calendar-view');
  const btnList  = document.getElementById('btn-list-view');
  const btnMap   = document.getElementById('btn-map-view');

  // Always use explicit 'none'/'block' so inline styles override any CSS display:none
  if (liveView)  liveView.style.display  = 'none';
  calView.style.display  = 'none';
  listView.style.display = 'none';
  mapView.style.display  = 'none';
  [btnLive, btnCal, btnList, btnMap].forEach(b => b && b.classList.remove('active'));

  if (view === 'live') {
    if (liveView) liveView.style.display = 'block';
    btnLive && btnLive.classList.add('active');
    window.renderLiveView && window.renderLiveView();
  } else if (view === 'calendar') {
    calView.style.display = 'block';
    btnCal && btnCal.classList.add('active');
    window.__calendar && window.__calendar.updateSize();
  } else if (view === 'map') {
    mapView.style.display = 'block';
    btnMap && btnMap.classList.add('active');
    window.renderMapView && window.renderMapView();
  } else {
    listView.style.display = 'block';
    btnList && btnList.classList.add('active');
    window.renderListView && window.renderListView();
  }

  localStorage.setItem('asu-cal-view', view);
}

// Init — wait for all scripts to parse before calling setView/renderLiveView.
document.addEventListener('DOMContentLoaded', () => {
  const savedView = localStorage.getItem('asu-cal-view') || 'calendar';
  setView(savedView);
  loadFilterOptions();
});

// Restore correct tab and restart polling after iOS Safari bfcache restore.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    const v = localStorage.getItem('asu-cal-view') || 'calendar';
    setView(v);
    window.startLivePolling && window.startLivePolling();
  }
});
