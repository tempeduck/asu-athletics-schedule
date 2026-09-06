// Game details from ESPN summary data. Features depend on the individual game's
// payload: missing plays or probabilities never become invented game state.
(() => {
  const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

  function playRow(play, sport, asuId, competitors) {
    const away = competitors.find(c => c.homeAway === 'away')?.team?.abbreviation || 'AWAY';
    const home = competitors.find(c => c.homeAway === 'home')?.team?.abbreviation || 'HOME';
    const period = _gmPeriodLabel(sport, play.period);
    const clock = play.clock?.displayValue || '';
    const score = play.awayScore != null && play.homeScore != null ? `${away} ${play.awayScore} · ${home} ${play.homeScore}` : '';
    const isAsu = String(play.team?.id || play.start?.team?.id || '') === asuId;
    return `<div class="gc-play${isAsu ? ' gc-play-asu' : ''}"${play.id != null ? ` data-gc-play="${esc(play.id)}"` : ''}>
      <div class="gc-play-meta"><span>${esc([period, clock].filter(Boolean).join(' · '))}</span>${play.scoringPlay ? '<strong>SCORING PLAY</strong>' : ''}</div>
      <p>${esc(play.text || play.shortDescription || play.type?.text || 'Play')}</p>
      ${score ? `<div class="gc-play-score">${esc(score)}</div>` : ''}
    </div>`;
  }

  function footballField(data, competitors) {
    const current = data.drives?.current;
    const plays = current?.plays || [];
    const position = plays[plays.length - 1]?.end;
    const complete = data.header?.competitions?.[0]?.status?.type?.completed;
    if (complete || !position || !finite(position.yardsToEndzone)) return '';
    const remaining = Number(position.yardsToEndzone);
    if (remaining < 0 || remaining > 100) return '';
    const teamId = String(position.team?.id || current.team?.id || '');
    const offense = competitors.find(c => String(c.team?.id) === teamId);
    if (!offense) return '';
    const defense = competitors.find(c => c !== offense);
    const x = 50 + (100 - remaining) * 5;
    const distance = Number(position.distance);
    const showLine = finite(position.distance) && distance > 0 && position.down >= 1 && position.down <= 4;
    const target = Math.min(550, x + distance * 5);
    const label = position.downDistanceText || position.possessionText || `${remaining} yards to goal`;
    const ticks = Array.from({ length: 11 }, (_, i) => {
      const tx = 50 + i * 50;
      const yard = i <= 5 ? i * 10 : (10 - i) * 10;
      return `<line x1="${tx}" y1="15" x2="${tx}" y2="155" stroke="white" opacity=".4"/>${i > 0 && i < 10 ? `<text x="${tx}" y="38" text-anchor="middle" fill="white" font-size="13">${yard}</text>` : ''}`;
    }).join('');
    return `<section class="gc-field-card">
      <div class="gc-section-heading">Latest reported field position</div>
      <div class="gc-possession"><strong>${esc(offense.team.abbreviation || offense.team.displayName)} drive →</strong><span>${esc(label)}</span></div>
      <svg class="gc-field" viewBox="0 0 600 170" role="img" aria-label="${esc(`${offense.team.displayName}: ${label}. Attacking toward the right end zone.`)}">
        <rect width="600" height="170" rx="8" fill="#195e40"/>
        <rect x="0" width="50" height="170" fill="#123d2c"/><rect x="550" width="50" height="170" fill="#123d2c"/>
        ${ticks}
        <text transform="translate(28 85) rotate(-90)" text-anchor="middle" fill="white" font-size="15">${esc(offense.team.abbreviation || '')}</text>
        <text transform="translate(578 85) rotate(90)" text-anchor="middle" fill="white" font-size="15">${esc(defense?.team?.abbreviation || '')}</text>
        ${showLine ? `<line x1="${target}" y1="15" x2="${target}" y2="155" stroke="#ffc627" stroke-width="3"/>` : ''}
        <line x1="${x}" y1="15" x2="${x}" y2="155" stroke="#75ceff" stroke-width="3"/>
        <ellipse cx="${x}" cy="90" rx="10" ry="7" fill="#753e20" stroke="white" stroke-width="2"/>
      </svg>
      <div class="gc-field-key">Blue: ball position${showLine ? ' · Gold: line to gain' : ''} · Offense moves right</div>
    </section>`;
  }

  function probabilityChart(data, asuTeam) {
    const homeAway = asuTeam?.homeAway;
    if (!['home', 'away'].includes(homeAway)) return '';
    const values = (data.winprobability || []).filter(p => finite(p.homeWinPercentage) && Number(p.homeWinPercentage) >= 0 && Number(p.homeWinPercentage) <= 1)
      .map(p => homeAway === 'home' ? Number(p.homeWinPercentage) : Math.max(0, 1 - Number(p.homeWinPercentage) - (finite(p.tiePercentage) ? Number(p.tiePercentage) : 0)));
    if (!values.length) return '';
    const percent = (values[values.length - 1] * 100).toFixed(1);
    const points = values.map((v, i) => `${10 + i / Math.max(1, values.length - 1) * 580},${90 - v * 80}`).join(' ');
    return `<section class="gc-probability">
      <div class="gc-probability-heading"><span>ASU win probability</span><strong>${percent}%</strong></div>
      <svg viewBox="0 0 600 100" role="img" aria-label="ASU win probability history by play. Latest estimate ${percent} percent.">
        <line x1="10" y1="50" x2="590" y2="50" stroke="currentColor" opacity=".2" stroke-dasharray="4 4"/>
        <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>
      </svg>
      <div class="gc-chart-key"><span>Game start</span><span>Latest play · ESPN estimate</span></div>
    </section>`;
  }

  window.buildGamecastPanel = function(data, sport, asuTeam, competitors) {
    const asuId = String(asuTeam?.team?.id || '');
    const current = data.drives?.current;
    const drives = [...(data.drives?.previous || [])].filter(d => !current?.id || String(d.id) !== String(current.id));
    if (current) drives.push(current);
    const plays = Array.isArray(data.plays) ? data.plays : [];
    const football = sport === 'Football';
    const timeline = football && drives.length
      ? `<div class="gc-section-heading gc-timeline-heading">Drives · Latest first</div>${drives.slice().reverse().map((drive, i) => {
        const isCurrent = drive === current && !data.header?.competitions?.[0]?.status?.type?.completed;
        const team = drive.team?.abbreviation || drive.team?.displayName || 'Drive';
        return `<details class="gc-drive" data-gm-drive="${esc(String(drive.id ?? `drive-${i}`))}"${isCurrent ? ' open' : ''}>
          <summary><span><strong>${esc(team)}</strong> · ${esc(drive.result || (isCurrent ? 'Current drive' : 'Drive'))}</span><span class="gc-drive-description">${esc(drive.description || '')}</span></summary>
          ${(drive.plays || []).slice().reverse().map(p => playRow(p, sport, asuId, competitors)).join('') || '<p class="gc-empty">Play details are not available yet.</p>'}
        </details>`;
      }).join('')}`
      : plays.length ? `<div class="gc-section-heading gc-timeline-heading">Play-by-play · Latest first</div>${plays.slice().reverse().map(p => playRow(p, sport, asuId, competitors)).join('')}` : '';
    const field = football ? footballField(data, competitors) : '';
    const probability = probabilityChart(data, asuTeam);
    if (!timeline && !field && !probability && !football) return null;
    return {
      tab: { id: 'gm-gamecast', label: 'Gamecast' },
      panel: `<div id="gm-gamecast" class="gm-tab-panel">${field}${probability}${timeline || '<p class="gc-empty">Play-by-play is not available for this game yet.</p>'}</div>`,
    };
  };
})();
