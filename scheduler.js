const cron = require('node-cron');
const { fetchAndStore } = require('./fetcher');
const { fetchAndStoreScores, fetchAndStoreLiveScores } = require('./scores');
const { getEventCount, getEventsPendingPush, getEventsPendingTvPush, markPushSent, markTvPushSent, cleanupExpiredSubscriptions, getGameSubscribers, getGameSubscribersForType, getEndedGamesWithSubscribers, getActiveGameWindows } = require('./db');
const { geocodeAllMissing } = require('./geocoder');
const push = require('./push');

// ── Cron job schedule ──────────────────────────────────────────────────────────
//
//  Game-hour jobs run 8:00–01:58 server time (America/Chicago). Phoenix is
//  1–2 h behind Chicago, so late tips (9–10 pm MST) end after midnight CT —
//  the 0-1 range covers those; games never straddle 2:00–7:59 CT.
//
//  */2  0-1,8-23  * * *  Background score poller
//    → Calls ESPN directly, writes game_status + scores to DB
//    → Only runs when subscribed games are in active windows
//    → Sends score_update pushes for subscribed live games
//
//  */3  0-1,8-23  * * *  Final score push trigger
//    → Reads DB for result set + final_push_sent = 0 (scores are written by
//      the */2 bg-poll above and by the /api/live flow when the tab is open)
//    → Calls sendGameFinalAlert() for each match, sets final_push_sent = 1
//
//  */5  0-1,8-23  * * *  Game-start push trigger
//    → Reads DB for games starting within 20 min + push_sent = 0
//    → Calls sendGameStartAlert(), sets push_sent = 1
//
//  0 3   *  *  *     Subscription cleanup
//    → Deletes game_subscriptions for past events (push_subscriptions are only
//      removed via 410s at send time — see cleanupExpiredSubscriptions)
//
//  The */2 and */3 jobs are intentionally decoupled:
//    - */2 writes scores to DB
//    - */3 reads DB scores, sends final-score push notifications
//  Maximum latency from game end to notification: ~5 minutes
//  (2-min poll interval + 3-min push check interval).

let bgPollRunning = false;

function startScheduler() {
  // Every 2 minutes during game hours: background score poller
  cron.schedule('*/2 0-1,8-23 * * *', async () => {
    if (bgPollRunning) {
      console.log('[bg-poll] Already running — skipping tick');
      return;
    }
    bgPollRunning = true;
    try {
      if (!getActiveGameWindows()) {
        console.log('[bg-poll] No active game windows — skipping');
        return;
      }
      const { fetched, written, scoreChanges } = await fetchAndStoreLiveScores();
      console.log(`[bg-poll] Fetched ${fetched} game(s), wrote ${written} DB update(s)`);
      if (scoreChanges.length) {
        for (const change of scoreChanges) {
          const subs = getGameSubscribersForType(change.eventId, 'score_update');
          if (subs.length) await push.sendScoreUpdateAlert(change, subs);
        }
      }
    } catch (err) {
      console.error(`[bg-poll] ESPN fetch failed: ${err.message}`);
    } finally {
      bgPollRunning = false;
    }
  });

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
  cron.schedule('*/5 0-1,8-23 * * *', async () => {
    try {
      const events = getEventsPendingPush();
      for (const event of events) {
        const subscribers = getGameSubscribersForType(event.id, 'game_start');
        if (!subscribers.length) continue;
        await push.sendGameStartAlert(event, subscribers);
        markPushSent(event.id);
      }
      const tvEvents = getEventsPendingTvPush();
      for (const event of tvEvents) {
        const subscribers = getGameSubscribersForType(event.id, 'tv_alert');
        if (subscribers.length) await push.sendTvAlert(event, subscribers);
        markTvPushSent(event.id);
      }
      if (events.length || tvEvents.length) console.log(`[scheduler] push: sent game alerts for ${events.length} event(s), TV alerts for ${tvEvents.length} event(s)`);
    } catch (err) {
      console.error('[scheduler] push tick failed:', err.message);
    }
  });

  // Every 3 minutes during game hours: send final-score push notifications.
  // Scores are written by the */2 bg-poll (and opportunistically by /api/live
  // when someone has the Live tab open); this job only reads and notifies.
  cron.schedule('*/3 0-1,8-23 * * *', async () => {
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
      console.log(`[scheduler] cleanup: removed ${result.deleted} expired game_subs`);
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
