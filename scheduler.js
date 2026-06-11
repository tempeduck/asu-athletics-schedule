const cron = require('node-cron');
const { fetchAndStore } = require('./fetcher');
const { fetchAndStoreScores, fetchAndStoreLiveScores } = require('./scores');
const { getEventCount, getEventsPendingPush, markPushSent, cleanupExpiredSubscriptions, getGameSubscribers, getGameSubscribersForType, getEndedGamesWithSubscribers, getActiveGameWindows } = require('./db');
const { geocodeAllMissing } = require('./geocoder');
const push = require('./push');

// ── Cron job schedule ──────────────────────────────────────────────────────────
//
//  */2  8-23  * * *  Background score poller            (Phase 3)
//    → Calls ESPN directly, writes game_status + scores to DB
//    → Only runs when subscribed games are in active windows
//    → Does NOT send pushes
//
//  */3  8-23  * * *  Final score push trigger            (Phase 2)
//    → Reads DB for game_status = 'post' + final_push_sent = 0
//    → Calls sendGameFinalAlert() for each match
//    → Sets final_push_sent = 1
//
//  */5  8-23  * * *  Game-start push trigger             (Phase 1)
//    → Reads DB for games starting within 20 min + push_sent = 0
//    → Calls sendGameStartAlert()
//    → Sets push_sent = 1
//
//  0 3   *  *  *     Subscription cleanup               (Phase 1)
//    → Deletes expired game_subscriptions + orphaned push_subscriptions
//
//  The */2 and */3 jobs are intentionally decoupled:
//    - */2 writes scores to DB, never sends pushes
//    - */3 reads DB scores, sends push notifications
//  Maximum latency from game end to notification: ~5 minutes
//  (2-min poll interval + 3-min push check interval).

let bgPollRunning = false;

function startScheduler() {
  // Every 2 minutes during game hours: background score poller
  cron.schedule('*/2 8-23 * * *', async () => {
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
  cron.schedule('*/5 8-23 * * *', async () => {
    try {
      const events = getEventsPendingPush();
      for (const event of events) {
        const subscribers = getGameSubscribersForType(event.id, 'game_start');
        if (!subscribers.length) continue;
        await push.sendGameStartAlert(event, subscribers);
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
