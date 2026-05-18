let mapInstance = null;
let markerLayer = null;
let venueState = {};  // "lat,lng" → { marker, lat, lng, bg, border, fg, count, ve }

function initMap() {
  if (mapInstance) return;
  const mapEl = document.getElementById('map-view');
  mapInstance = L.map(mapEl, { zoomControl: true }).setView([39.5, -98.35], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(mapInstance);
  markerLayer = L.layerGroup().addTo(mapInstance);
}

async function renderMapView() {
  initMap();
  // Let Leaflet recalculate container size in case the div was previously hidden
  mapInstance.invalidateSize();

  let events;
  try {
    events = await fetchEvents();
  } catch (err) {
    console.error('[map] Failed to fetch events:', err);
    return;
  }

  updateStatus(events.length);
  markerLayer.clearLayers();

  // lat=0,lng=0 is the permanent-skip sentinel written by the geocoder for unresolvable addresses
  const geoEvents = events.filter(e => e.lat != null && e.lng != null && !(e.lat === 0 && e.lng === 0));
  if (geoEvents.length === 0) return;

  // Store events by id so popup click handlers can open the modal
  window.__mapEventById = {};
  for (const e of geoEvents) window.__mapEventById[e.id] = e;

  // Group events by venue coordinates
  const venues = {};
  for (const e of geoEvents) {
    const key = `${e.lat},${e.lng}`;
    if (!venues[key]) venues[key] = { lat: e.lat, lng: e.lng, events: [] };
    venues[key].events.push(e);
  }

  const bounds = [];
  venueState = {};

  for (const venue of Object.values(venues)) {
    const { lat, lng, events: ve } = venue;
    bounds.push([lat, lng]);

    // Gold for home/neutral venues, maroon for away
    const hasHome = ve.some(e => e.game_type === 'home' || e.game_type === 'neutral');
    const bg     = hasHome ? '#FFC627' : '#8C1D40';
    const border = hasHome ? '#333333' : '#4a0e22';
    const fg     = hasHome ? '#1a1a1a' : '#ffffff';
    const count  = ve.length;
    const key    = `${lat},${lng}`;

    const hasLive = ve.some(e => window.__liveData?.[e.id]);
    const icon = buildPinIcon(bg, border, fg, count, hasLive);

    const marker = L.marker([lat, lng], { icon });
    marker.bindPopup(buildPopupHTML(ve), { maxWidth: 300 });
    markerLayer.addLayer(marker);

    venueState[key] = { marker, lat, lng, bg, border, fg, count, ve };
  }

  if (bounds.length > 0) {
    mapInstance.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 });
    if (mapInstance.getZoom() < 4) {
      // Wide span (e.g. international pins) — re-frame on CONUS pins only
      const usBounds = bounds.filter(([lat, lng]) => lat >= 24 && lat <= 50 && lng >= -125 && lng <= -66);
      if (usBounds.length > 0) {
        mapInstance.fitBounds(usBounds, { padding: [30, 30], maxZoom: 12, minZoom: 4 });
      } else {
        mapInstance.setZoom(4);
      }
    }
  }
}

function buildPinIcon(bg, border, fg, count, hasLive) {
  const ring = hasLive ? '<div class="map-pin-pulse"></div>' : '';
  return L.divIcon({
    html: `<div class="map-pin-wrap">${ring}<div class="map-pin" style="background:${bg};border-color:${border};color:${fg}">${count > 1 ? count : ''}</div></div>`,
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -18],
  });
}

window.applyLiveToMap = function() {
  for (const [, state] of Object.entries(venueState)) {
    const hasLive = state.ve.some(e => window.__liveData?.[e.id]);
    state.marker.setIcon(buildPinIcon(state.bg, state.border, state.fg, state.count, hasLive));
  }
};

function buildPopupHTML(events) {
  const first = events[0];
  const venueName = first.location_name || first.city || 'Venue';
  const venueAddr = first.venue_address || '';

  let html = `<div class="map-popup">`;
  html += `<div class="map-popup-venue">${esc(venueName)}</div>`;
  if (venueAddr) html += `<div class="map-popup-addr">${esc(venueAddr)}</div>`;
  html += `<div class="map-popup-events">`;

  for (const e of events) {
    const date = e.start_date
      ? new Date(e.start_date * 1000).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix',
        })
      : '';

    let scoreHtml = '';
    if (e.result) {
      const cls = e.result === 'W' ? 'score-w' : e.result === 'L' ? 'score-l' : 'score-t';
      scoreHtml = `<span class="score-badge ${cls}">${e.result} ${e.asu_score}-${e.opp_score}</span>`;
    }

    html += `
      <div class="map-popup-event">
        <div class="map-popup-event-title">
          <a href="#" onclick="openEventModal(window.__mapEventById['${esc(e.id)}']);return false;">${esc(e.title || 'Event')}</a>
        </div>
        <div class="map-popup-event-meta">${esc(date)}${e.sport ? ' · ' + esc(e.sport) : ''} ${scoreHtml}</div>
      </div>`;
  }

  html += `</div></div>`;
  return html;
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.renderMapView = renderMapView;
