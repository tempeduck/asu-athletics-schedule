const cron = require('node-cron');
const { fetchAndStore } = require('./fetcher');
const { fetchAndStoreScores } = require('./scores');
const { getEventCount, getEventsPendingPush, markPushSent, cleanupExpiredSubscriptions, getGameSubscribers, getEndedGamesWithSubscribers } = require('./db');
const { geocodeAllMissing } = require('./geocoder');

function startScheduler() {
  // Nightly at 2am server local time
  cron.schedule('0 2 * * *', async () => {
    console.log('[scheduler] Running nightly fetch');
    try {
      await fetchAndStore();
    } catch (err) {
      console.error('[scheduler] Fetch failed:', err.message);
    }
    try {
      await fetchAndStoreScores();
    } catch (err) {
      console.error('[scheduler] Score fetch failed:', err.message);
    }
    // Geocode new events as a separate pass after the main fetch completes
    geocodeAllMissing().catch(err => console.error('[scheduler] Geocode pass failed:', err.message));
  });

  // Every 5 minutes during game hours: send game-start push notifications
  cron.schedule('*/5 8-23 * * *', async () => {
    let push;
    try { push = require('./push'); } catch (err) {
      console.error('[scheduler] push module load failed:', err.message); return;
    }
    try {
      const events = getEventsPendingPush();
      for (const event of events) {
        const subscribers = getGameSubscribers(event.id);
        if (!subscribers.length) { markPushSent(event.id); continue; }
        await push.sendGameStartAlert(event);
        markPushSent(event.id);
      }
      if (events.length) console.log(`[scheduler] push: sent alerts for ${events.length} event(s)`);
    } catch (err) {
      console.error('[scheduler] push tick failed:', err.message);
    }
  });

  // Every 3 minutes during game hours: send final-score push notifications.
  // Score data is written to DB by the frontend-driven /api/live flow (fetchLiveGames).
  // If no user has the live tab open when a game ends, DB scores won't be updated
  // until the nightly sync runs — this is a known limitation of the frontend-dependent
  // score writing approach.
  cron.schedule('*/3 8-23 * * *', async () => {
    let push;
    try { push = require('./push'); } catch (err) {
      console.error('[scheduler] push module load failed:', err.message); return;
    }
    try {
      const ended = getEndedGamesWithSubscribers();
      for (const event of ended) {
        await push.sendGameFinalAlert(event.id);
      }
      if (ended.length) console.log(`[scheduler] final-push: sent alerts for ${ended.length} event(s)`);
    } catch (err) {
      console.error('[scheduler] final-push tick failed:', err.message);
    }
  });

  // Daily at 3 AM: subscription cleanup
  cron.schedule('0 3 * * *', () => {
    try {
      const result = cleanupExpiredSubscriptions();
      console.log(`[scheduler] cleanup: removed ${result.deleted} game_subs, ${result.orphans} orphan push_subs`);
    } catch (err) {
      console.error('[scheduler] cleanup failed:', err.message);
    }
  });

  // Seed on startup if DB is empty
  if (getEventCount() === 0) {
    console.log('[scheduler] DB empty — running initial fetch');
    fetchAndStore()
      .then(() => geocodeAllMissing())
      .catch(err => console.error('[scheduler] Initial fetch/geocode failed:', err.message));
  } else {
    console.log(`[scheduler] DB has ${getEventCount()} events — skipping initial fetch`);
    // Backfill coordinates for any events added before geocoding was introduced
    geocodeAllMissing().catch(err => console.error('[scheduler] Startup geocode pass failed:', err.message));
  }
}

module.exports = { startScheduler };
