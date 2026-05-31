document.addEventListener('DOMContentLoaded', async () => {
  const calEl = document.getElementById('calendar');

  // Format today as YYYY-MM-DD in Phoenix local time so FullCalendar doesn't
  // shift to tomorrow when the browser's UTC offset crosses midnight.
  const todayPhoenix = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Phoenix' });

  const calendar = new FullCalendar.Calendar(calEl, {
    initialView: window.innerWidth < 768 ? 'listWeek' : 'dayGridMonth',
    initialDate: todayPhoenix,
    timeZone: 'America/Phoenix',
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,timeGridWeek,listWeek',
    },
    height: '100%',
    events: loadCalendarEvents,
    eventClick(info) {
      openEventModal(info.event.extendedProps.raw);
    },
    eventDidMount(info) {
      const sport = info.event.extendedProps.raw?.sport;
      info.el.title = info.event.title + (sport ? ` (${sport})` : '');
      // Store el reference so live.js can inject LIVE badges without refetching
      window.__calendarEventEls = window.__calendarEventEls || {};
      window.__calendarEventEls[info.event.id] = info.el;
    },
    eventContent(info) {
      const raw = info.event.extendedProps.raw;
      const liveGame = window.__liveData?.[raw?.id];
      const wrapper = document.createElement('div');
      wrapper.className = 'fc-event-main-frame';

      let extraLine = '';
      if (liveGame) {
        extraLine = `<div class="fc-live-line"><span class="live-badge-sm">LIVE</span> ${liveGame.asuScore}–${liveGame.oppScore} <span class="fc-live-situation">${liveGame.situation}</span></div>`;
      } else if (raw?.result) {
        const colorClass = raw.result === 'W' ? 'score-w' : raw.result === 'L' ? 'score-l' : 'score-t';
        extraLine = `<div class="fc-score-line ${colorClass}">${raw.result} ${raw.asu_score}-${raw.opp_score}</div>`;
      }

      const sport = raw?.sport || '';
      wrapper.innerHTML = `
        <div class="fc-event-time">${info.timeText}</div>
        <div class="fc-event-title-container">
          ${sport ? `<div class="fc-event-sport">${sport}</div>` : ''}
          <div class="fc-event-title fc-sticky">${info.event.title}</div>
          ${extraLine}
        </div>`;
      return { domNodes: [wrapper] };
    },
  });

  calendar.render();
  window.__calendar = calendar;

  window.reloadEvents = () => {
    const view = localStorage.getItem('asu-cal-view') || 'calendar';
    if (view === 'calendar') {
      calendar.refetchEvents();
    } else if (view === 'map') {
      window.renderMapView && window.renderMapView();
    } else if (view === 'live') {
      window.renderLiveView && window.renderLiveView();
    } else {
      renderListView();
    }
  };

});

function toPhoenixISO(ts) {
  // Convert Unix timestamp (seconds) to a Phoenix-local ISO string (no Z suffix)
  // so FullCalendar treats it as wall-clock time in the configured timeZone.
  const d = new Date(ts * 1000);
  const local = d.toLocaleString('sv-SE', { timeZone: 'America/Phoenix' });
  return local.replace(' ', 'T');
}

async function loadCalendarEvents(fetchInfo, successCallback, failureCallback) {
  try {
    const events = await fetchEvents();
    const mapped = events.map(e => ({
      id: e.id,
      title: shortTitle(e.title),
      start: e.start_date ? toPhoenixISO(e.start_date) : null,
      end: e.end_date ? toPhoenixISO(e.end_date) : null,
      backgroundColor: sportColor(e.sport),
      borderColor: sportColor(e.sport),
      textColor: '#fff',
      extendedProps: { raw: e },
    })).filter(e => e.start);

    updateStatus(mapped.length);
    successCallback(mapped);
  } catch (err) {
    console.error('Failed to load events:', err);
    failureCallback(err);
  }
}

async function renderListView() {
  const container = document.getElementById('list-view');
  container.innerHTML = '<div class="empty-state"><h3>Loading…</h3></div>';

  try {
    const events = await fetchEvents();
    updateStatus(events.length);

    if (events.length === 0) {
      container.innerHTML = '<div class="empty-state"><h3>No events found</h3><p>Try adjusting your filters.</p></div>';
      return;
    }

    // Filter out events older than 7 days before today
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffTs = cutoff.getTime() / 1000;
    const visibleEvents = events.filter(e => e.start_date >= cutoffTs);

    if (visibleEvents.length === 0) {
      container.innerHTML = '<div class="empty-state"><h3>No events found</h3><p>Try adjusting your filters.</p></div>';
      return;
    }

    // Group by date
    const groups = {};
    for (const e of visibleEvents) {
      if (!e.start_date) continue;
      const d = new Date(e.start_date * 1000);
      const key = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix' });
      if (!groups[key]) groups[key] = [];
      groups[key].push(e);
    }

    container.innerHTML = '';
    for (const [dateLabel, dayEvents] of Object.entries(groups)) {
      const group = document.createElement('div');
      group.className = 'list-date-group';
      group.innerHTML = `<div class="list-date-header">${dateLabel}</div>`;

      for (const e of dayEvents) {
        const el = document.createElement('div');
        el.className = 'list-event';
        el.dataset.eventId = e.id;
        el.innerHTML = listEventHTML(e);
        el.addEventListener('click', () => {
          const liveGame = window.__liveData?.[e.id];
          if (liveGame?.espnEventId && window.openGameDetailModal) {
            window.openGameDetailModal(liveGame.espnEventId, e.sport, {
              title: e.title, sport: e.sport,
              startTime: e.start_date,
              location: e.location_name || [e.city, e.state].filter(Boolean).join(', ') || null,
              tvNetwork: e.tv_network || null,
            });
          } else {
            openEventModal(e);
          }
        });
        group.appendChild(el);
      }

      container.appendChild(group);
    }

    // Scroll container so the first event on or after today is at the top
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTs = todayStart.getTime() / 1000;
    const futureEvents = visibleEvents.filter(e => e.start_date >= todayTs);
    if (futureEvents.length > 0) {
      const firstId = futureEvents[0].id;
      requestAnimationFrame(() => {
        const el = container.querySelector(`.list-event[data-event-id="${firstId}"]`);
        if (!el) return;
        const elRect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        container.scrollTop += elRect.top - containerRect.top;
      });
    }
  } catch (err) {
    container.innerHTML = '<div class="empty-state"><h3>Failed to load events</h3></div>';
    console.error(err);
  }
}

function listEventHTML(e) {
  const color = sportColor(e.sport);
  const rawTime = e.start_date
    ? new Date(e.start_date * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix' })
    : '';
  // Suppress midnight — it's the feed's "no time set" placeholder
  const time = rawTime === '12:00 AM' ? '' : rawTime;

  const metaParts = [e.sport, e.city ? `${e.city}, ${e.state || ''}`.trim().replace(/,$/, '') : null].filter(Boolean);
  const badges = e.badges ? e.badges.split('|').filter(Boolean).map(b => `<span class="badge">${b.trim()}</span>`).join('') : '';

  const scoreClass = e.result === 'W' ? 'score-w' : e.result === 'L' ? 'score-l' : 'score-t';
  const scoreHTML = e.result
    ? `<span class="score-badge ${scoreClass}">${e.result} ${e.asu_score}-${e.opp_score}</span>`
    : '';

  return `
    <span class="list-event-dot" style="background:${color}"></span>
    <div class="list-event-main">
      <div class="list-event-title">${shortTitle(e.title)}${badges}</div>
      <div class="list-event-meta">${metaParts.join(' · ')}</div>
    </div>
    <div class="list-event-right">
      ${scoreHTML || `<div class="list-event-time">${time}</div>`}
      <div class="list-event-type">${capitalize(e.game_type || '')}${e.tv_network ? ' · ' + e.tv_network : ''}</div>
    </div>
  `;
}

function updateStatus(count) {
  document.getElementById('status-bar').textContent =
    `${count} event${count !== 1 ? 's' : ''} shown · Last updated: ${new Date().toLocaleTimeString()}`;
}

window.renderListView = renderListView;
