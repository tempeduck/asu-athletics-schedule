(() => {
  const escAttr = value => esc(value == null ? '' : value);
  window.teamSummaryLink = (sport, name, teamId, content, className = '') => {
    if (!sport || !name || /^(tbd|opponent)$/i.test(name)) return content;
    return `<button type="button" class="team-summary-link ${className}" data-team-sport="${escAttr(sport)}" data-team-name="${escAttr(name)}" data-team-id="${escAttr(teamId || '')}" aria-label="View ${escAttr(name)} ${escAttr(sport)} season summary">${content}</button>`;
  };
  function close() { document.getElementById('team-modal-overlay')?.classList.remove('open'); }
  window.closeTeamModal = close;
  function game(g) {
    const score = g.score != null && g.opponentScore != null ? ` · ${esc(g.score)}–${esc(g.opponentScore)}` : '';
    return `<li><span>${esc(g.opponent || 'Opponent')}${score}</span><small>${esc(g.detail || (g.state === 'post' ? 'Final' : 'Upcoming'))}</small></li>`;
  }
  async function open(button) {
    const overlay = document.getElementById('team-modal-overlay'), inner = document.getElementById('team-modal-inner');
    if (!overlay || !inner) return;
    overlay.classList.add('open'); inner.innerHTML = '<div class="game-modal-spinner"></div>';
    try {
      const q = new URLSearchParams({ sport: button.dataset.teamSport, name: button.dataset.teamName });
      if (button.dataset.teamId) q.set('teamId', button.dataset.teamId);
      const res = await fetch(`/api/team-summary?${q}`); if (!res.ok) throw new Error(); const d = await res.json();
      inner.innerHTML = d.available ? `<div class="gm-header"><div class="gm-headline">${esc(d.sport)}</div><div class="team-summary-head">${d.logo ? `<img src="${esc(d.logo)}" alt="" class="gm-team-logo">` : ''}<div><strong>${esc(d.name)}</strong><div>${esc(d.season || 'Current season')} · ${esc(d.record)}</div></div></div></div><div class="team-summary-body"><h3>Season schedule</h3><ul>${d.games.map(game).join('') || '<li>No schedule is available.</li>'}</ul></div>` : `<div class="team-summary-body"><h3>${esc(button.dataset.teamName)}</h3><p>${esc(d.reason || 'No current-season summary is available.')}</p></div>`;
    } catch { inner.innerHTML = '<div class="team-summary-body"><p>Team summary is unavailable right now.</p></div>'; }
  }
  document.addEventListener('click', e => { const b = e.target.closest('[data-team-sport]'); if (b) { e.preventDefault(); open(b); } });
  document.addEventListener('click', e => { if (e.target.id === 'team-modal-overlay') close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
})();
