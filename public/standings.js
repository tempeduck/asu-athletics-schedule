// Conference standings widget on the Live tab. live.js renders the shell on
// every 30s poll; the table loads async from /api/standings with a client
// cache and a last-rendered-HTML buffer (same anti-flicker pattern as the
// NCAA bracket) so re-renders don't blank or refetch.
(function() {
  const SPORTS = ['Football', "Men's Basketball", "Women's Basketball", 'Baseball', 'Ice Hockey', 'Volleyball'];
  const ROSTER_SPORTS = new Set(['Football', "Men's Basketball", "Women's Basketball", 'Ice Hockey']);
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

  function _rosterBtnHtml(sport) {
    if (!ROSTER_SPORTS.has(sport)) return '';
    // \' keeps the apostrophe in "Men's Basketball" valid inside the inline handler
    return `<div class="roster-link-row">
      <button type="button" class="roster-btn" onclick="openRosterModal('${sport.replace(/'/g, "\\'")}')">👥 View roster</button>
    </div>`;
  }

  function _tableHtml(data) {
    const rosterBtn = _rosterBtnHtml(data.sport);
    if (!data.available) {
      return `<div class="standings-note">Standings aren't available for this sport.</div>${rosterBtn}`;
    }
    if (!data.entries.length) {
      return `<div class="standings-note">Standings will appear when the season starts.</div>${rosterBtn}`;
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
      </div>
      ${rosterBtn}`;
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

  // ── Sun Devils news widget ──────────────────────────────────────────────────

  let _newsHtml = null;
  let _newsAt = 0;

  function _relTime(iso) {
    if (!iso) return '';
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 60) return `${Math.max(mins, 1)}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    return `${Math.floor(mins / 1440)}d ago`;
  }

  function _newsRow(a) {
    const inner = `
      <span class="news-emoji">${a.emoji || '🔱'}</span>
      <span class="news-text">
        <span class="news-headline">${esc(a.headline)}</span>
        <span class="news-meta">${esc(a.sport)} · ${esc(_relTime(a.published))}</span>
      </span>`;
    return a.link
      ? `<a class="news-row" href="${esc(a.link)}" target="_blank" rel="noopener">${inner}<span class="news-ext">↗</span></a>`
      : `<div class="news-row">${inner}</div>`;
  }

  window.renderNewsShell = function() {
    return `
      <div class="bracket-wrapper news-widget">
        <div class="live-section-header bracket-collapsible-header" onclick="toggleBracketBody(this)">
          📰 Sun Devils News <span class="bracket-collapse-btn">▾</span>
        </div>
        <div class="bracket-body">
          <div id="news-placeholder">${_newsHtml || '<div class="standings-note">Loading…</div>'}</div>
        </div>
      </div>`;
  };

  window.loadNews = async function() {
    if (_newsHtml && Date.now() - _newsAt < CLIENT_TTL) {
      const ph = document.getElementById('news-placeholder');
      if (ph) ph.innerHTML = _newsHtml;
      return;
    }
    try {
      const res = await fetch('/api/news');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      _newsHtml = data.articles?.length
        ? data.articles.map(_newsRow).join('')
        : '<div class="standings-note">No recent Sun Devils news.</div>';
    } catch (err) {
      console.error('[news] load failed:', err.message);
      _newsHtml = `<div class="standings-note">Couldn't load news right now.</div>`;
    }
    _newsAt = Date.now();
    const ph = document.getElementById('news-placeholder');
    if (ph) ph.innerHTML = _newsHtml;
  };

  // ── Roster modal (reuses the game-modal overlay chrome) ─────────────────────

  function _rosterHtml(d) {
    const groups = d.groups.map(g => {
      const hasClass = g.players.some(p => p.classYear);
      const rows = g.players.map(p => `
        <tr>
          <td>${esc(p.jersey ?? '–')}</td>
          <td>${esc(p.name)}</td>
          <td>${esc(p.position || '–')}</td>
          <td>${esc(p.height || '–')}</td>
          <td>${esc(p.weight || '–')}</td>
          ${hasClass ? `<td>${esc(p.classYear || '–')}</td>` : ''}
        </tr>`).join('');
      return `
        ${g.label ? `<div class="gm-stats-team-header">${esc(g.label)}</div>` : ''}
        <div class="gm-stats-table-wrap"><table class="gm-stats-table">
          <thead><tr><th>#</th><th>Player</th><th>Pos</th><th>Ht</th><th>Wt</th>${hasClass ? '<th>Class</th>' : ''}</tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`;
    }).join('');
    return `
      <div class="gm-header">
        <div class="gm-headline">${esc(d.sport)}</div>
        <div style="font-size:1.1rem;font-weight:700;color:white;padding-right:36px">${esc(d.team)} — Roster</div>
      </div>
      <div class="gm-body">${groups}</div>`;
  }

  window.openRosterModal = async function(sport) {
    const overlay = document.getElementById('game-modal-overlay');
    const inner = document.getElementById('game-modal-inner');
    if (!overlay || !inner) return;

    overlay.onclick = (e) => { if (e.target === overlay) window.closeGameModal(); };
    const escKey = (e) => {
      if (e.key === 'Escape') { window.closeGameModal(); document.removeEventListener('keydown', escKey); }
    };
    document.addEventListener('keydown', escKey);

    inner.innerHTML = '<div class="game-modal-spinner"></div>';
    overlay.classList.add('open');

    try {
      const res = await fetch(`/api/roster?sport=${encodeURIComponent(sport)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      inner.innerHTML = data.available
        ? _rosterHtml(data)
        : `<div class="standings-note" style="padding:24px">Roster isn't available for this sport.</div>`;
    } catch (err) {
      console.error('[roster] load failed:', err.message);
      inner.innerHTML = `<div class="standings-note" style="padding:24px">Couldn't load the roster right now.</div>`;
    }
  };
})();
