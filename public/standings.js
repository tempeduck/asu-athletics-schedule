// Conference standings widget on the Live tab. live.js renders the shell on
// every 30s poll; the table loads async from /api/standings with a client
// cache and a last-rendered-HTML buffer (same anti-flicker pattern as the
// NCAA bracket) so re-renders don't blank or refetch.
(function() {
  const SPORTS = ['Football', "Men's Basketball", "Women's Basketball", 'Baseball', 'Ice Hockey', 'Volleyball'];
  const CLIENT_TTL = 10 * 60 * 1000;
  const _cache = {};      // sport -> {data, at}
  let _lastHtml = null;
  let _lastSport = null;

  function _defaultSport() {
    const stored = store.get('asu-standings-sport');
    if (SPORTS.includes(stored)) return stored;
    const m = new Date().getMonth();
    if (m >= 7) return 'Football';            // Aug–Dec
    if (m <= 2) return "Men's Basketball";    // Jan–Mar
    return 'Baseball';                        // Apr–Jul
  }

  function _pillsHtml(active) {
    return `<div class="standings-pills">${SPORTS.map(s =>
      `<button type="button" class="standings-pill${s === active ? ' active' : ''}" data-standings-sport="${esc(s)}">${esc(s)}</button>`
    ).join('')}</div>`;
  }

  function _tableHtml(data) {
    if (!data.available) {
      return `<div class="standings-note">Standings aren't available for this sport.</div>`;
    }
    if (!data.entries.length) {
      return `<div class="standings-note">Standings will appear when the season starts.</div>`;
    }
    const hasConf = data.entries.some(e => e.conf);
    const hasGB = data.entries.some(e => e.gamesBehind && e.gamesBehind !== '-');
    const rows = data.entries.map((e, i) => `
      <tr class="${e.isASU ? 'standings-asu-row' : ''}">
        <td class="standings-pos">${i + 1}</td>
        <td class="standings-team">${e.logo ? `<img src="${esc(e.logo)}" alt="" loading="lazy" />` : ''}${esc(e.name)}</td>
        <td>${esc(hasConf ? (e.conf || '–') : (e.confPct || '–'))}</td>
        <td>${esc(e.overall || '–')}</td>
        ${hasGB ? `<td>${esc(e.gamesBehind || '–')}</td>` : ''}
        <td>${esc(e.streak || '–')}</td>
      </tr>`).join('');
    const label = [
      data.seasonDisplayName ? `${data.seasonDisplayName}${data.isFinal ? ' (Final)' : ''}` : null,
      data.conference,
    ].filter(Boolean).join(' · ');
    return `
      ${label ? `<div class="standings-season">${esc(label)}</div>` : ''}
      <div class="standings-scroll">
        <table class="standings-table">
          <thead><tr><th></th><th>Team</th><th>Conf</th><th>Overall</th>${hasGB ? '<th>GB</th>' : ''}<th>Strk</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function _syncPills(sport) {
    document.querySelectorAll('.standings-pill').forEach(b =>
      b.classList.toggle('active', b.dataset.standingsSport === sport));
  }

  window.renderStandingsShell = function() {
    const sport = _lastSport || _defaultSport();
    return `
      <div class="bracket-wrapper standings-widget">
        <div class="live-section-header bracket-collapsible-header" onclick="toggleBracketBody(this)">
          📊 Conference Standings <span class="bracket-collapse-btn">▾</span>
        </div>
        <div class="bracket-body">
          ${_pillsHtml(sport)}
          <div id="standings-placeholder">${_lastHtml || '<div class="standings-note">Loading…</div>'}</div>
        </div>
      </div>`;
  };

  window.loadStandings = async function(sport) {
    sport = SPORTS.includes(sport) ? sport : _defaultSport();
    _lastSport = sport;
    store.set('asu-standings-sport', sport);
    _syncPills(sport);

    const hit = _cache[sport];
    if (hit && Date.now() - hit.at < CLIENT_TTL) {
      _lastHtml = _tableHtml(hit.data);
    } else {
      try {
        const res = await fetch(`/api/standings?sport=${encodeURIComponent(sport)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        _cache[sport] = { data, at: Date.now() };
        _lastHtml = _tableHtml(data);
      } catch (err) {
        console.error('[standings] load failed:', err.message);
        _lastHtml = `<div class="standings-note">Couldn't load standings right now.</div>`;
      }
    }

    // Re-query: the live view may have re-rendered while we were fetching,
    // and a faster pill click may have changed the selected sport.
    if (_lastSport !== sport) return;
    const placeholder = document.getElementById('standings-placeholder');
    if (placeholder) placeholder.innerHTML = _lastHtml;
  };

  // Delegated so the handler survives the 30s live-poll innerHTML resets.
  document.addEventListener('click', e => {
    const pill = e.target.closest('[data-standings-sport]');
    if (!pill) return;
    if (pill.dataset.standingsSport !== _lastSport) _lastHtml = null;
    const placeholder = document.getElementById('standings-placeholder');
    if (placeholder && !_lastHtml) placeholder.innerHTML = '<div class="standings-note">Loading…</div>';
    window.loadStandings(pill.dataset.standingsSport);
  });
})();
