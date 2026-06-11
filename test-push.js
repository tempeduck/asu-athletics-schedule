#!/usr/bin/env node
// test-push.js — Manual push test utility. Not served by Express.
// Usage:
//   node test-push.js list
//   node test-push.js start <eventId>
//   node test-push.js final <eventId>
//   node test-push.js bg-poll

const { loadSecretsFallback } = require('./lib/env');

if (!loadSecretsFallback()) {
  console.warn('[test-push] secrets.env not found — VAPID keys must already be in environment');
}

const db = require('./db');
const push = require('./push');
const { fetchAndStoreLiveScores } = require('./scores');

const [,, cmd, eventId] = process.argv;

async function main() {
  if (cmd === 'list') {
    const events = db.queryEvents({});
    const withSubs = [];
    for (const event of events) {
      const subs = db.getGameSubscribers(event.id);
      if (subs.length) withSubs.push({ event, subs });
    }

    if (!withSubs.length) {
      console.log('No game subscriptions found.');
    } else {
      console.log(`--- game_subscriptions (${withSubs.length} event(s)) ---`);
      for (const { event, subs } of withSubs) {
        console.log(`\nEvent:      ${event.id}`);
        console.log(`  Title:    ${event.title}`);
        console.log(`  Sport:    ${event.sport}`);
        console.log(`  Result:   ${event.result ?? '(pending)'}`);
        console.log(`  Scores:   ASU ${event.asu_score ?? '?'} — Opp ${event.opp_score ?? '?'}`);
        console.log(`  FinalSent:${event.final_push_sent ? ' yes' : ' no'}`);
        console.log(`  Subscribers: ${subs.length}`);
        for (const s of subs) {
          console.log(`    ...${s.endpoint.slice(-40)}`);
        }
      }
    }
    process.exit(0);
  }

  if (cmd === 'start' || cmd === 'final') {
    if (!eventId) {
      console.error(`Usage: node test-push.js ${cmd} <eventId>`);
      process.exit(1);
    }
    const event = db.getEventById(eventId);
    if (!event) {
      console.error(`Event not found: ${eventId}`);
      process.exit(1);
    }
    console.log(`Event: ${event.title} (${event.sport})`);
    if (cmd === 'start') {
      await push.sendGameStartAlert(event);
    } else {
      await push.sendGameFinalAlert(eventId);
    }
    console.log('Done.');
    process.exit(0);
  }

  if (cmd === 'bg-poll') {
    console.log('Running background score poll...');
    const { fetched, written } = await fetchAndStoreLiveScores();
    console.log(`Fetched ${fetched} completed ASU game(s) from ESPN`);
    console.log(`Wrote ${written} DB update(s)`);
    process.exit(0);
  }

  console.error('Usage: node test-push.js list | start <eventId> | final <eventId> | bg-poll');
  process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
