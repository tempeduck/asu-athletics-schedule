// pwa.js — Install banner, offline banner, push subscription, bell state

// ── Debug panel ───────────────────────────────────────────────────────────────

let _debugLines = [];
let _debugPanelEl = null;

function _pwaLog(level, msg) {
  if (store.get('pwaDebug') !== 'true') return;
  const t = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = `${t} [${level}] ${msg}`;
  _debugLines.push(line);
  if (_debugLines.length > 12) _debugLines.shift();
  const body = _debugPanelEl?.querySelector('.dbg-body');
  if (body) body.textContent = _debugLines.join('\n');
}

function _initDebugPanel() {
  if (store.get('pwaDebug') !== 'true') return;

  const panel = document.createElement('div');
  panel.id = 'pwa-debug-panel';
  panel.innerHTML = `
    <div class="dbg-header">
      <span>PWA Debug</span>
      <button class="dbg-close" onclick="this.closest('#pwa-debug-panel').style.display='none'">✕</button>
    </div>
    <pre class="dbg-body"></pre>
  `;
  document.body.appendChild(panel);
  _debugPanelEl = panel;

  // Intercept console methods to mirror output into the panel
  ['log', 'warn', 'error'].forEach(lvl => {
    const orig = console[lvl].bind(console);
    console[lvl] = (...args) => {
      orig(...args);
      _pwaLog(lvl, args.map(a => (a && typeof a === 'object') ? JSON.stringify(a) : String(a)).join(' '));
    };
  });

  // Log initial diagnostic state
  _pwaLog('log', `endpoint: ${store.get('asu-push-endpoint') || 'null'}`);
  _pwaLog('log', `standalone: ${window.navigator.standalone ?? 'n/a'}`);
  _pwaLog('log', `SW: ${navigator.serviceWorker?.controller ? 'active' : 'none'}`);
  // typeof guard everywhere: iOS Safari tabs have no Notification global, and
  // even `Notification?.` throws ReferenceError on an undeclared identifier.
  _pwaLog('log', `permission: ${typeof Notification !== 'undefined' ? Notification.permission : 'n/a'}`);
}

// ── Push subscription state ───────────────────────────────────────────────────

const PUSH_ENDPOINT_KEY = 'asu-push-endpoint';
const TV_PREFS_KEY = 'asu-tv-preferences';
let _swRegistration = null;

window.getPushEndpoint = () => store.get(PUSH_ENDPOINT_KEY) || null;
function _getTvPrefs() { return store.getJSON(TV_PREFS_KEY, null); }

async function _initPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  try {
    _swRegistration = await navigator.serviceWorker.ready;
    let sub = await _swRegistration.pushManager.getSubscription();
    if (!sub) {
      const keyRes = await fetch('/api/vapid-public-key');
      const { publicKey } = await keyRes.json();
      sub = await _swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlBase64ToUint8Array(publicKey),
      });
    }
    const p256dh = btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh'))));
    const auth   = btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth'))));

    // Always (re-)register with the server — no skip-if-known-endpoint check.
    // Skipping is what stranded devices whose server row disappeared: the
    // client believed it was registered and every bell action 409'd forever.
    // One small POST per page load buys a self-healing subscription.
    await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint, p256dh, auth, tvPrefs: _getTvPrefs() }),
    });
    store.set(PUSH_ENDPOINT_KEY, sub.endpoint);

    _pwaLog('log', '[pwa] Push subscription active');
    console.log('[pwa] Push subscription active');
    window.dispatchEvent(new CustomEvent('pwa-push-ready'));
  } catch (err) {
    _pwaLog('error', `[pwa] Push subscription failed: ${err.message}`);
    console.warn('[pwa] Push subscription failed:', err.message);
  }
}

function _urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

// ── Bell icon state ───────────────────────────────────────────────────────────

// _gameSubscriptions: Map<eventId, string[]> — notification type arrays per game.
// Migrates from old Set format (array of strings) to new Map format automatically.
const _gameSubscriptions = (() => {
  try {
    const stored = store.getJSON('asu-game-subs', []);
    if (!stored.length) return new Map();
    if (typeof stored[0] === 'string') {
      // Old Set format: ['id1', 'id2'] → Map with legacy defaults
      return new Map(stored.map(id => [id, ['game_start', 'final_score']]));
    }
    return new Map(stored);
  } catch { return new Map(); }
})();

function _persistGameSubs() {
  store.setJSON('asu-game-subs', [..._gameSubscriptions]);
}

window.isGameSubscribed = function(eventId) {
  const types = _gameSubscriptions.get(eventId);
  return !!(types && types.length);
};

// Bell HTML — generates a button with data-bell-event-id for delegation.
function bellIconHTML(eventId, isFutureOrLive, tooltip, sport, tvNetwork) {
  if (!isFutureOrLive) return '';
  const endpoint = window.getPushEndpoint();
  const types = endpoint ? (_gameSubscriptions.get(eventId) || []) : [];
  const subscribed = types.length > 0;
  const disabled = !endpoint;
  const cls = disabled ? 'bell-disabled' : (subscribed ? 'bell-on' : 'bell-off');
  const title = disabled ? 'Enable notifications first'
    : (subscribed ? 'Notification options' : (tooltip || 'Get game alerts'));
  const sportAttr = sport ? ` data-bell-sport="${sport}"` : '';
  const tvAttr = tvNetwork ? ` data-bell-tv="${esc(tvNetwork)}"` : '';
  return `<button class="bell-btn ${cls}" data-bell-event-id="${eventId}"${sportAttr}${tvAttr} title="${title}" aria-label="${disabled ? 'Notifications disabled' : (subscribed ? 'Notification options' : 'Get game alerts')}">🔔</button>`;
}

window.bellIconHTML = bellIconHTML;

// showBellError — briefly flash the bell and display message as tooltip
window.showBellError = function(bellEl, message) {
  _pwaLog('warn', `bell error: ${message}`);
  if (!bellEl) return;
  bellEl.classList.add('bell-error');
  const prev = bellEl.title;
  bellEl.title = message;
  setTimeout(() => { bellEl.classList.remove('bell-error'); bellEl.title = prev; }, 3000);
};

// ── Bell notification menu ────────────────────────────────────────────────────

let _activeBellEl = null;

function _scoreUpdateLabel(sport) {
  if (/baseball|softball/i.test(sport || '')) return 'Inning updates';
  return 'Score updates';
}

function _openBellMenu(bellEl, eventId, sport, tvNetwork) {
  _closeBellMenu();

  const endpoint = window.getPushEndpoint();
  if (!endpoint) { window.showBellError(bellEl, 'Enable notifications first'); return; }

  const currentTypes = _gameSubscriptions.get(eventId) || [];
  const ck = t => currentTypes.includes(t) ? ' checked' : '';

  const menu = document.createElement('div');
  menu.id = 'bell-menu';
  menu.className = 'bell-menu';
  menu.innerHTML = `
    <div class="bell-menu-header">Notify me for</div>
    <label class="bell-menu-row">
      <input type="checkbox" data-btype="game_start"${ck('game_start')}>
      <span>Game start<span class="bell-menu-hint">15 min before tip-off</span></span>
    </label>
    <label class="bell-menu-row">
      <input type="checkbox" data-btype="score_update"${ck('score_update')}>
      <span>${_scoreUpdateLabel(sport)}</span>
    </label>
    <label class="bell-menu-row">
      <input type="checkbox" data-btype="final_score"${ck('final_score')}>
      <span>Final score</span>
    </label>
    ${tvNetwork ? `<label class="bell-menu-row">
      <input type="checkbox" data-btype="tv_alert"${ck('tv_alert')}>
      <span>TV broadcast<span class="bell-menu-hint">${esc(tvNetwork)} · before start</span></span>
    </label>` : ''}
  `;

  document.body.appendChild(menu);
  _activeBellEl = bellEl;

  // Position: right-align with bell, just below it
  const rect = bellEl.getBoundingClientRect();
  const w = 230;
  let left = rect.right - w;
  if (left < 8) left = 8;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  menu.style.cssText = `position:fixed;left:${Math.round(left)}px;top:${Math.round(rect.bottom + 6)}px;z-index:9999`;

  menu.addEventListener('change', async () => {
    const newTypes = [...menu.querySelectorAll('[data-btype]:checked')].map(c => c.dataset.btype);
    await _applyBellTypes(endpoint, eventId, newTypes, bellEl);
  });

  menu.addEventListener('click', e => e.stopPropagation());
}

function _closeBellMenu() {
  document.getElementById('bell-menu')?.remove();
  _activeBellEl = null;
}

async function _applyBellTypes(endpoint, eventId, types, bellEl, isRetry = false) {
  try {
    const res = await fetch('/api/subscribe/game', {
      method: types.length ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint, eventId, types }),
    });
    // 409 = the server no longer knows this device (e.g. DB restored from a
    // copy). Re-register the push subscription and retry once.
    if (res.status === 409 && !isRetry) {
      store.remove(PUSH_ENDPOINT_KEY);
      await _initPushSubscription();
      const fresh = window.getPushEndpoint();
      if (fresh) return _applyBellTypes(fresh, eventId, types, bellEl, true);
      throw new Error('re-register failed');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (types.length) { _gameSubscriptions.set(eventId, types); }
    else              { _gameSubscriptions.delete(eventId); }
    _persistGameSubs();

    const subscribed = types.length > 0;
    bellEl.classList.remove('bell-disabled', 'bell-error');
    bellEl.classList.toggle('bell-on',  subscribed);
    bellEl.classList.toggle('bell-off', !subscribed);
    bellEl.title = subscribed ? 'Notification options' : 'Get game alerts';
    _pwaLog('log', `bell types: ${eventId} → [${types.join(',')}]`);
  } catch (err) {
    _pwaLog('error', `bell update failed: ${err.message}`);
    window.showBellError(bellEl, 'Failed — try again');
  }
}

// ── Document-level delegated bell click handler ───────────────────────────────

document.addEventListener('click', function(e) {
  const bell = e.target.closest('[data-bell-event-id]');
  if (!bell) return;
  e.stopPropagation();
  // Toggle: click same bell again → close
  if (_activeBellEl === bell && document.getElementById('bell-menu')) {
    _closeBellMenu(); return;
  }
  const eventId = bell.dataset.bellEventId;
  const sport   = bell.dataset.bellSport || '';
  const tvNetwork = bell.dataset.bellTv || '';
  _pwaLog('log', `bell click: ${eventId} endpoint=${window.getPushEndpoint()?.slice(-12) ?? 'null'}`);
  _openBellMenu(bell, eventId, sport, tvNetwork);
}, true); // capture phase

// Close on outside click
document.addEventListener('click', function(e) {
  if (!document.getElementById('bell-menu')) return;
  if (!e.target.closest('#bell-menu')) _closeBellMenu();
});

// Close on Escape
document.addEventListener('keydown', e => { if (e.key === 'Escape') _closeBellMenu(); });

// ── Enable notifications button ───────────────────────────────────────────────

window.requestPushPermission = async function() {
  if (!('Notification' in window)) return;
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    await _initPushSubscription();
    _renderNotifSection();
  }
};

// ── iOS install banner ────────────────────────────────────────────────────────

function _isIosSafari() {
  const ua = navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) && !/Chrome|CriOS|FxiOS|OPT\//i.test(ua);
}

function _isStandalone() {
  return window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
}

function _showIosBanner() {
  if (_isStandalone()) return;
  if (!_isIosSafari()) return;
  if (store.get('installBannerDismissed')) return;

  const banner = document.createElement('div');
  banner.id = 'ios-install-banner';
  banner.innerHTML = `
    <img src="/sparky.png" alt="Sun Devils" style="width:36px;height:36px;border-radius:8px;flex-shrink:0">
    <span class="ios-banner-text">Add to Home Screen for the full experience &mdash; tap <strong>⬆ Share</strong> → <strong>Add to Home Screen</strong></span>
    <button class="ios-banner-dismiss" onclick="window._dismissIosBanner()" aria-label="Dismiss">✕</button>
  `;
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add('ios-banner-visible'));
}

window._dismissIosBanner = function() {
  store.set('installBannerDismissed', '1');
  const banner = document.getElementById('ios-install-banner');
  if (banner) {
    banner.classList.remove('ios-banner-visible');
    setTimeout(() => banner.remove(), 350);
  }
};

// ── Offline banner ────────────────────────────────────────────────────────────

function _initOfflineBanner() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'offline') _showOfflineBanner();
    // SW posts 'online' on any successful API response — the window 'online'
    // event alone never fires when the banner came from a slow fetch.
    if (event.data?.type === 'online') _hideOfflineBanner();
  });
  window.addEventListener('online', _hideOfflineBanner);
}

let _offlineBannerTimer = null;

function _showOfflineBanner() {
  if (document.getElementById('offline-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'offline-banner';
  bar.textContent = "You're offline — showing cached schedule. Live scores unavailable.";
  document.body.appendChild(bar); // fixed overlay — never in layout flow
  // Belt-and-braces: self-dismiss; a still-offline session will re-show it
  // on the next failed fetch anyway.
  clearTimeout(_offlineBannerTimer);
  _offlineBannerTimer = setTimeout(_hideOfflineBanner, 10_000);
}

function _hideOfflineBanner() {
  document.getElementById('offline-banner')?.remove();
}

// ── Install App sidebar section ───────────────────────────────────────────────

function _renderInstallSection() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  if (_isStandalone()) return;

  const section = document.createElement('div');
  section.className = 'filter-group install-app-section';
  section.id = 'install-app-section';
  section.innerHTML = `
    <label class="group-label">Install App</label>
    <p class="install-benefit">Get game-start notifications and offline schedule access.</p>
    <ol class="install-steps">
      <li>Tap <span class="install-icon">⬆</span> <strong>Share</strong></li>
      <li>Scroll to find <span class="install-icon">➕</span></li>
      <li>Tap <strong>"Add to Home Screen"</strong></li>
    </ol>
  `;
  sidebar.appendChild(section);
}

// ── Notifications sidebar section ─────────────────────────────────────────────

function _renderNotifSection() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  // No Notification global (iOS Safari tab) → notifications are impossible
  // in-browser; skip the section entirely (the install section covers iOS).
  if (typeof Notification === 'undefined') return;

  document.getElementById('notif-section')?.remove();

  const perm = Notification.permission ?? 'default';
  const section = document.createElement('div');
  section.className = 'filter-group';
  section.id = 'notif-section';

  if (perm === 'denied') {
    section.innerHTML = `<label class="group-label">Notifications</label><p class="install-benefit" style="color:#c0392b">Blocked in browser settings.</p>`;
    sidebar.appendChild(section);
    return;
  }

  if (perm !== 'granted') {
    section.innerHTML = `
      <label class="group-label">Notifications</label>
      <p class="install-benefit">Get notified 15 min before game start.</p>
      <button class="btn-enable-notif" onclick="window.requestPushPermission()">Enable Notifications</button>
    `;
    sidebar.appendChild(section);
    return;
  }

  // No per-sport checkboxes here: sport_prefs was never read server-side —
  // the checkboxes were a dead control implying broadcast alerts that don't
  // exist. Alerts are per-game via the 🔔 bell; say so instead.
  section.innerHTML = `
    <label class="group-label">Notifications <span style="font-size:0.7rem;font-weight:400;opacity:0.7">(enabled)</span></label>
    <p class="install-benefit">Tap the 🔔 bell on any game to pick alerts: game start, score updates, final score.</p>
    <div class="tv-prefs">
      <p class="install-benefit"><strong>Optional TV channel lookup</strong><br>Choose your ZIP code and provider to include your channel number in TV alerts.</p>
      <div style="display:flex;gap:5px;margin:6px 0">
        <input id="tv-zip" inputmode="numeric" maxlength="5" placeholder="ZIP code" value="${esc(_getTvPrefs()?.postalCode || '')}" style="min-width:0;flex:1">
        <button id="tv-find" class="btn-enable-notif" style="padding:5px 8px">Find providers</button>
      </div>
      <select id="tv-provider" style="width:100%;margin:4px 0" disabled><option value="">Find providers first</option></select>
      <button id="tv-save" class="btn-enable-notif" style="padding:5px 8px;margin-top:4px" disabled>Save TV provider</button>
      <p id="tv-status" class="install-benefit" style="margin-top:5px"></p>
      <a href="https://www.tvmedia.ca" target="_blank" rel="noopener" class="install-benefit">TV data by TV Media</a>
    </div>
  `;
  sidebar.appendChild(section);
  const zipEl = section.querySelector('#tv-zip');
  const providerEl = section.querySelector('#tv-provider');
  const findEl = section.querySelector('#tv-find');
  const saveEl = section.querySelector('#tv-save');
  const statusEl = section.querySelector('#tv-status');
  let lineups = [];
  const saved = _getTvPrefs();
  if (saved?.providerName) statusEl.textContent = `Saved provider: ${saved.providerName}`;
  findEl.addEventListener('click', async () => {
    const zip = zipEl.value.trim();
    if (!/^\d{5}$/.test(zip)) { statusEl.textContent = 'Enter a valid 5-digit ZIP code.'; return; }
    findEl.disabled = true; statusEl.textContent = 'Finding providers…';
    try {
      const res = await fetch(`/api/tv/lineups?postalCode=${encodeURIComponent(zip)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      lineups = data;
      providerEl.innerHTML = '<option value="">Select your provider</option>' + lineups.map(l =>
        `<option value="${esc(l.lineupID)}">${esc([l.providerName, l.serviceArea, l.lineupType].filter(Boolean).join(' — '))}</option>`
      ).join('');
      providerEl.disabled = !lineups.length;
      saveEl.disabled = true;
      statusEl.textContent = lineups.length ? `${lineups.length} providers found.` : 'No providers found for that ZIP.';
    } catch (err) {
      statusEl.textContent = err.message;
    } finally { findEl.disabled = false; }
  });
  providerEl.addEventListener('change', () => { saveEl.disabled = !providerEl.value; });
  saveEl.addEventListener('click', async () => {
    const selected = lineups.find(l => l.lineupID === providerEl.value);
    if (!selected) return;
    const prefs = { postalCode: zipEl.value.trim(), lineupId: selected.lineupID, providerName: selected.providerName };
    store.setJSON(TV_PREFS_KEY, prefs);
    const endpoint = window.getPushEndpoint();
    if (!endpoint) { statusEl.textContent = `Saved ${selected.providerName}; enable notifications to sync it.`; return; }
    saveEl.disabled = true; statusEl.textContent = 'Saving…';
    try {
      const res = await fetch('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, tvPrefs: prefs }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      statusEl.textContent = `Saved ${selected.providerName}.`;
    } catch (err) { statusEl.textContent = `Saved locally; server sync failed (${err.message}).`; }
    finally { saveEl.disabled = false; }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  _initDebugPanel();
  _initOfflineBanner();
  _showIosBanner();
  _renderInstallSection();
  _renderNotifSection();

  // iOS Safari fallback for modal bells.
  // On iOS, the document capture-phase handler (above) can be bypassed when the
  // click target is inside a position:fixed element that has its own onclick —
  // exactly the case for #modal-overlay (onclick="closeModal(event)").
  // This bubble-phase listener on #modal fires reliably in that scenario.
  // On desktop the document capture handler fires first and calls stopPropagation,
  // so the event never bubbles here — no double-fire.
  const _modalEl = document.getElementById('modal');
  if (_modalEl) {
    _modalEl.addEventListener('click', function(e) {
      const bell = e.target.closest('[data-bell-event-id]');
      if (!bell) return;
      e.stopPropagation();
      if (_activeBellEl === bell && document.getElementById('bell-menu')) {
        _closeBellMenu(); return;
      }
      const eventId = bell.dataset.bellEventId;
      const sport   = bell.dataset.bellSport || '';
      const tvNetwork = bell.dataset.bellTv || '';
      _pwaLog('log', `modal bell: eventId=${eventId}`);
      _openBellMenu(bell, eventId, sport, tvNetwork);
    });
  }

  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    _swRegistration = _swRegistration || (await navigator.serviceWorker.ready.catch(() => null));
    await _initPushSubscription();
  }
});

window.addEventListener('pwa-push-ready', _renderNotifSection);
