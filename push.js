const webpush = require('web-push');
const { getGameSubscribersForType, deletePushSubscription, getEventById, markFinalPushSent } = require('./db');
const { opponentFromTitle } = require('./lib/opponent');
const { SITE_ORIGIN } = require('./lib/constants');

// VAPID env may be loaded after this module (loadSecretsFallback runs in the
// entry point), so details are applied per-send rather than at require time.
function ensureVapid() {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

const SPORT_EMOJI = {
  'Football':             '🏈',
  "Men's Basketball":     '🏀',
  "Women's Basketball":   '🏀',
  'Basketball':           '🏀',
  'Baseball':             '⚾',
  'Softball':             '🥎',
  "Women's Soccer":       '⚽',
  "Men's Soccer":         '⚽',
  'Soccer':               '⚽',
  "Women's Volleyball":   '🏐',
  'Volleyball':           '🏐',
  "Golf (Men's)":         '⛳',
  "Golf (Women's)":       '⛳',
  "Tennis (Men's)":       '🎾',
  "Tennis (Women's)":     '🎾',
  'Swimming':             '🏊',
  'Swimming & Diving':    '🏊',
  'Track and Field':      '🏃',
  'Cross Country':        '🏃',
  'Wrestling':            '🤼',
  'Gymnastics':           '🤸',
};

function buildPayload(event) {
  const emoji = SPORT_EMOJI[event.sport] || '🏟️';
  const opponent = (event.title || '').replace(/^.*?(?:at|vs\.?)\s+/i, '').trim() || 'Opponent';
  const timeStr = event.start_date
    ? new Date(event.start_date * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : '';
  const venue = event.location_name || '';

  return {
    web_push: 8030,
    notification: {
      title: `${emoji} ASU vs ${opponent} — Starting in 15 min`,
      body: [venue, timeStr ? `Kickoff at ${timeStr}` : ''].filter(Boolean).join(' · '),
      icon: '/icons/icon-192.png',
      navigate: SITE_ORIGIN,
      app_badge: '1',
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
    notification: { title, body, icon: '/icons/icon-192.png', navigate: SITE_ORIGIN },
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

module.exports = { sendGameStartAlert, sendGameFinalAlert, sendScoreUpdateAlert };
