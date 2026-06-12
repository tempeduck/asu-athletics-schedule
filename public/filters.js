// Global filter state
const filters = {
  sports: new Set(),
  gameTypes: new Set(),
  region: '',
  state: '',
  season: '',
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

// sportColor / isUA / espnLogoUrl / opponentInitial / makeLogoPlaceholder
// now live in shared.js (loaded before this file).

function eventLogoHTML(event) {
  const color = sportColor(event.sport);

  // 1. UA → poop emoji
  if (isUA(event.title, event.opponent_logo)) {
    return `<div class="list-event-logo-placeholder" title="University of Arizona"
              style="font-size:1.4rem;background:none;border-color:transparent;">💩</div>`;
  }

  // 2. Feed-provided logo
  if (event.opponent_logo) {
    const safeTitle = (event.title || '').replace(/'/g, "\\'");
    return `<img class="list-event-logo" src="${event.opponent_logo}" alt="" loading="lazy"
             onerror="this.replaceWith(makeLogoPlaceholder('${safeTitle}','${color}'))">`;
  }

  // 3. ESPN CDN fallback by name
  const espnUrl = espnLogoUrl(event.title);
  if (espnUrl) {
    const safeTitle = (event.title || '').replace(/'/g, "\\'");
    return `<img class="list-event-logo" src="${espnUrl}" alt="" loading="lazy"
             onerror="this.replaceWith(makeLogoPlaceholder('${safeTitle}','${color}'))">`;
  }

  // 4. Colored initial (Sparky is for ASU context only — see resolveModalLogo)
  const initial = opponentInitial(event.title);
  return `<div class="list-event-logo-placeholder"
            style="border-color:${color}20;color:${color};">${initial}</div>`;
}

function resolveModalLogo(event) {
  if (isUA(event.title, event.opponent_logo)) return { type: 'emoji', value: '💩' };
  if (event.opponent_logo) return { type: 'img', value: event.opponent_logo };
  return { type: 'img', value: '/sparky.png' };
}

// ── Toast notifications ────────────────────────────────

function showToast(message, type = 'success', duration = 3500) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-show'));
  setTimeout(() => {
    toast.classList.remove('toast-show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, duration);
}

async function loadFilterOptions() {
  const [sports, locations, seasons, allEvents] = await Promise.all([
    fetch('/api/sports').then(r => r.json()),
    fetch('/api/locations').then(r => r.json()),
    fetch('/api/seasons').then(r => r.json()),
    fetch('/api/events').then(r => r.json()),
  ]);

  allLocations = locations;

  // Sport checkboxes
  const list = document.getElementById('sport-list');
  list.innerHTML = '';
  for (const sport of sports) {
    const color = sportColor(sport);
    const id = `sport-${sport.replace(/\W/g, '_')}`;
    const label = document.createElement('label');
    label.setAttribute('for', id);
    label.innerHTML = `
      <input type="checkbox" id="${id}" value="${sport}" onchange="toggleSport(this)" />
      <span class="sport-color-dot" style="background:${color};"></span>
      ${sport}
    `;
    list.appendChild(label);
  }

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

  // Season dropdown
  const seasonSelect = document.getElementById('filter-season');
  seasons.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = seasonLabel(s);
    seasonSelect.appendChild(opt);
  });

  // Auto-select most recent season with completed games; fall back to most recent season available
  const seasonsWithResults = [...new Set(allEvents.filter(e => e.result).map(e => e.season).filter(Boolean))];

  let defaultSeason = null;
  if (seasonsWithResults.length) {
    defaultSeason = seasonsWithResults.sort().pop();
  } else if (seasons.length) {
    // Off-season / new season: no results yet — pick the most recent season.
    defaultSeason = seasons[0]; // seasons array is ORDER BY season DESC
  }
  if (defaultSeason) {
    seasonSelect.value = defaultSeason;
    applySeason(defaultSeason);
  }

  // Restore date range open/closed state
  if (store.get('asu-date-range-open') === '1') {
    document.getElementById('date-range-body').style.display = 'block';
    document.getElementById('date-range-arrow').textContent = '▼';
  }
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
  const label = checkbox.closest('label');
  if (label) label.classList.toggle('sport-active', checkbox.checked);
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

function applySeason(val) {
  filters.season = val;
  applyFilters();
}

function applyFilters() {
  filters.region = document.getElementById('filter-region').value;
  filters.state = document.getElementById('filter-state').value;
  filters.from = document.getElementById('filter-from').value;
  filters.to = document.getElementById('filter-to').value;
  window.reloadEvents && window.reloadEvents();
}

function toggleDateRange() {
  const body  = document.getElementById('date-range-body');
  const arrow = document.getElementById('date-range-arrow');
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  arrow.textContent = isOpen ? '▶' : '▼';
  store.set('asu-date-range-open', isOpen ? '0' : '1');
}

function copyIcsUrl() {
  const url = `${window.location.origin}/api/events.ics`;
  navigator.clipboard.writeText(url).then(() => {
    showToast('Calendar URL copied — paste into Apple Calendar or Google Calendar to subscribe', 'success', 5000);
  }).catch(() => {
    window.open(url, '_blank');
  });
}

function clearFilters() {
  filters.sports.clear();
  filters.gameTypes.clear();
  filters.region = '';
  filters.state = '';
  filters.season = '';
  filters.from = '';
  filters.to = '';

  document.querySelectorAll('#sport-list input[type=checkbox]').forEach(cb => cb.checked = false);
  document.querySelectorAll('#sport-list label').forEach(l => l.classList.remove('sport-active'));
  document.querySelectorAll('.game-type-toggles button').forEach(b => b.classList.remove('active'));
  document.getElementById('filter-season').value = '';
  document.getElementById('filter-region').value = '';
  document.getElementById('filter-from').value = '';
  document.getElementById('filter-to').value = '';
  document.getElementById('date-range-body').style.display = 'none';
  document.getElementById('date-range-arrow').textContent = '▶';
  store.remove('asu-date-range-open');
  rebuildStateDropdown('');

  window.reloadEvents && window.reloadEvents();
}

function buildQueryString() {
  const params = new URLSearchParams();
  if (filters.sports.size === 1) params.set('sport', [...filters.sports][0]);
  if (filters.gameTypes.size === 1) params.set('game_type', [...filters.gameTypes][0]);
  if (filters.season) params.set('season', filters.season);
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

function cleanDisplayAddress(addr) {
  if (!addr) return '';
  return addr
    .replace(/(?:#[^,\s]+|\b(?:Suite|Ste\.?|Unit)\s+\w+)\s*/gi, '')
    .trim()
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*$/, '');
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
      oppRank:   event.opp_rank || null,
    });
    return;
  }

  document.getElementById('modal-title').textContent = shortTitle(event.title);
  document.getElementById('modal-sport').textContent = [event.sport, event.event_type].filter(Boolean).join(' · ');

  const logoEl = document.getElementById('modal-logo');
  const logoInfo = resolveModalLogo(event);

  const prevEmoji = logoEl.parentElement.querySelector('.modal-logo-emoji');
  if (prevEmoji) prevEmoji.remove();

  if (logoInfo.type === 'emoji') {
    logoEl.style.display = 'none';
    const emojiEl = document.createElement('div');
    emojiEl.className = 'modal-logo-emoji';
    emojiEl.style.cssText = 'font-size:2.8rem;line-height:1;flex-shrink:0;padding:4px;';
    emojiEl.title = 'University of Arizona';
    emojiEl.textContent = logoInfo.value;
    logoEl.parentElement.insertBefore(emojiEl, logoEl.nextSibling);
  } else {
    logoEl.src = logoInfo.value;
    logoEl.style.display = '';
    logoEl.onerror = function() { this.style.display = 'none'; };
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
  if (event.opp_rank) {
    rows.push(row('🏅', 'Opponent', `<span class="rank-badge">#${event.opp_rank}</span> in latest poll`));
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
  const nowTs = Math.floor(Date.now() / 1000);
  const isFuture = event.start_date && event.start_date > nowTs;
  if (isFuture && typeof window.bellIconHTML === 'function') {
    actions += `<div class="modal-bell-row">${window.bellIconHTML(event.id, true, undefined, event.sport)}<span class="modal-bell-label">Get game alerts</span></div>`;
  }
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
  btn.innerHTML = '<span class="btn-spinner"></span>';
  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`Refreshed — ${data.count} events loaded`, 'success');
      window.reloadEvents && window.reloadEvents();
      loadFilterOptions();
    } else {
      showToast('Refresh failed. Try again.', 'error');
    }
  } catch {
    showToast('Network error during refresh.', 'error');
  }
  setTimeout(() => { btn.disabled = false; btn.innerHTML = '↻'; }, 3000);
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

  store.set('asu-cal-view', view);
}

// Init — wait for all scripts to parse before calling setView/renderLiveView.
document.addEventListener('DOMContentLoaded', () => {
  const savedView = store.get('asu-cal-view') || 'live';
  setView(savedView);
  loadFilterOptions();
});

// Restore correct tab and restart polling after iOS Safari bfcache restore.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    const v = store.get('asu-cal-view') || 'live';
    setView(v);
    window.startLivePolling && window.startLivePolling();
  }
});
