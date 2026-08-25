const webpush = require('web-push');
const { getGameSubscribersForType, deletePushSubscription, getEventById, markFinalPushSent } = require('./db');
const { opponentFromTitle } = require('./lib/opponent');
const { SITE_ORIGIN } = require('./lib/constants');
const { SPORT_EMOJI } = require('./lib/sports-config');
const { findChannel } = require('./lib/tvmedia');

// VAPID details are applied per-send rather than at require time so a missing
// key surfaces as a caught send error, not a boot failure (scheduler.js
// eager-requires this module).
function ensureVapid() {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

function buildPayload(event) {
  const emoji = SPORT_EMOJI[event.sport] || '🏟️';
  const opponent = opponentFromTitle(event.title, { fallback: 'Opponent' });
  const venue = event.location_name || '';

  // No time string here: the server's timezone is not the recipient's.
  // startTime rides along as a raw epoch and sw.js renders it in the
  // device's local timezone at display time (with the exact lead minutes —
  // the send window is 0–20 min out, so a fixed "in 15 min" was wrong too).
  return {
    web_push: 8030,
    startTime: event.start_date || null,
    notification: {
      title: `${emoji} ASU vs ${opponent} — starting soon`,
      body: venue,
      icon: '/icons/icon-192.png',
      navigate: SITE_ORIGIN,
      app_badge: '1',
      tag: `asu-start-${event.id}`,
    },
  };
}

function buildTvPayload(event, channel) {
  const emoji = SPORT_EMOJI[event.sport] || '🏟️';
  const opponent = opponentFromTitle(event.title, { fallback: 'Opponent' });
  const venue = event.location_name || '';
  return {
    web_push: 8030,
    startTime: event.start_date || null,
    notification: {
      title: `${emoji} ASU vs ${opponent} — televised`,
      body: [event.tv_network, channel ? `channel ${channel}` : '', venue].filter(Boolean).join(' · '),
      icon: '/icons/icon-192.png',
      navigate: SITE_ORIGIN,
      app_badge: '1',
      tag: `asu-tv-${event.id}`,
    },
  };
}

async function sendGameStartAlert(eventRow, subscribers) {
  if (!subscribers) subscribers = getGameSubscribersForType(eventRow.id, 'game_start');
  if (!subscribers.length) return;

  ensureVapid();

  const payload = JSON.stringify(buildPayload(eventRow));
  let sent = 0;
  let failed = 0;

  for (const sub of subscribers) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 410) {
        try { deletePushSubscription(sub.endpoint); } catch {}
      } else {
        console.error(`[push] send failed for endpoint ${sub.endpoint.slice(-20)}: ${err.message}`);
      }
    }
  }

  console.log(`[push] event ${eventRow.id}: sent=${sent} failed=${failed}`);
}

async function sendTvAlert(eventRow, subscribers) {
  if (!subscribers) subscribers = getGameSubscribersForType(eventRow.id, 'tv_alert');
  if (!subscribers.length) return;

  ensureVapid();
  let sent = 0;
  let failed = 0;
  for (const sub of subscribers) {
    try {
      let channel = null;
      try {
        const prefs = sub.tv_preferences ? JSON.parse(sub.tv_preferences) : null;
        if (prefs?.lineupId) channel = await findChannel(prefs.lineupId, eventRow.tv_network);
      } catch (err) {
        console.warn(`[push] TV channel lookup failed for event=${eventRow.id}: ${err.message}`);
      }
      const payload = JSON.stringify(buildTvPayload(eventRow, channel));
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 410) {
        try { deletePushSubscription(sub.endpoint); } catch {}
      } else {
        console.error(`[push] TV alert send failed for endpoint ${sub.endpoint.slice(-20)}: ${err.message}`);
      }
    }
  }
  console.log(`[push] TV alert event=${eventRow.id}: sent=${sent} failed=${failed}`);
}

async function sendGameFinalAlert(eventId) {
  const event = getEventById(eventId);
  if (!event) {
    console.warn(`[push] sendGameFinalAlert: event ${eventId} not found`);
    return;
  }

  const subscribers = getGameSubscribersForType(eventId, 'final_score');
  if (!subscribers.length) {
    markFinalPushSent(eventId);
    return;
  }

  ensureVapid();

  const emoji = SPORT_EMOJI[event.sport] || '🏟️';
  const opponent = opponentFromTitle(event.title, { fallback: 'Opponent' });
  const asuScore = event.asu_score ?? '?';
  const oppScore = event.opp_score ?? '?';

  const notifTitle = `${emoji} Final: ASU ${asuScore}, ${opponent} ${oppScore}`;
  const winLabel = event.result === 'W' ? 'Sun Devils win! 🎉' :
                   event.result === 'T' ? 'Final score — tie.' : 'Final score.';
  const body = `${winLabel} Tap to see the recap.`;

  const payload = JSON.stringify({
    web_push: 8030,
    notification: {
      title: notifTitle,
      body,
      icon: '/icons/icon-192.png',
      navigate: SITE_ORIGIN,
      app_badge: '0',
      // Same tag as this game's score updates: the final replaces the last one.
      tag: `asu-game-${eventId}`,
    },
  });

  let sent = 0;
  let failed = 0;

  for (const sub of subscribers) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 410) {
        try { deletePushSubscription(sub.endpoint); } catch {}
      } else {
        console.error(`[push] final alert send failed for ${sub.endpoint.slice(-20)}: ${err.message}`);
      }
    }
  }

  markFinalPushSent(eventId);
  console.log(`[push] final alert event=${eventId} sport=${event.sport} sent=${sent} failed=${failed}`);
}

async function sendScoreUpdateAlert(change, subscribers) {
  if (!subscribers.length) return;

  ensureVapid();

  const emoji = SPORT_EMOJI[change.sport] || '🏟️';
  const opponent = opponentFromTitle(change.title, { fallback: 'Opponent' });
  const asuN = parseInt(change.asuScore, 10);
  const oppN = parseInt(change.oppScore, 10);
  const situation = !isNaN(asuN) && !isNaN(oppN)
    ? (asuN > oppN ? 'leads' : asuN < oppN ? 'trails' : 'tied')
    : '';

  const title = `${emoji} ASU ${situation ? situation + ' ' : ''}${change.asuScore}–${change.oppScore}`;
  const body = change.statusDetail
    ? `${change.statusDetail} · Tap for live updates`
    : 'Score update · Tap for live updates';

  const payload = JSON.stringify({
    web_push: 8030,
    // Per-game tag: successive score updates replace each other instead of
    // stacking, and the final-score alert (same tag) replaces the last one.
    notification: { title, body, icon: '/icons/icon-192.png', navigate: SITE_ORIGIN, tag: `asu-game-${change.eventId}` },
  });

  let sent = 0;
  for (const sub of subscribers) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      sent++;
    } catch (err) {
      if (err.statusCode === 410) {
        try { deletePushSubscription(sub.endpoint); } catch {}
      } else {
        console.error(`[push] score-update send failed for ${sub.endpoint.slice(-20)}: ${err.message}`);
      }
    }
  }
  console.log(`[push] score-update event=${change.eventId} sent=${sent}`);
}

module.exports = { sendGameStartAlert, sendTvAlert, sendGameFinalAlert, sendScoreUpdateAlert, buildTvPayload };
