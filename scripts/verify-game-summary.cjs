// Deterministic cache/concurrency checks without network or database access.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
let now = 0;
class Clock extends Date { static now() { return now; } }
const cacheContext = { module: { exports: {} }, Date: Clock };
vm.runInNewContext(fs.readFileSync(path.join(root, 'lib/cache.js'), 'utf8'), cacheContext);
let calls = 0;
let state = 'in';
let fail = false;
let malformed = false;
let release;
let gate = null;
const context = {
  module: { exports: {} },
  require: id => {
    if (id === './cache') return cacheContext.module.exports;
    if (id === './constants') return { USER_AGENT: 'verification' };
    if (id === 'node-fetch') return async () => {
      calls++;
      if (gate) await gate;
      return { ok: !fail, status: fail ? 503 : 200, json: async () => malformed ? {} : ({ header: { competitions: [{ status: { type: { state, completed: state === 'post' } } }] } }) };
    };
    throw new Error(`Unexpected import: ${id}`);
  },
};
vm.runInNewContext(fs.readFileSync(path.join(root, 'lib/game-summary.js'), 'utf8'), context);
const { fetchGameSummary } = context.module.exports;
(async () => {
  gate = new Promise(resolve => { release = resolve; });
  const requests = Array.from({ length: 20 }, () => fetchGameSummary('football/college-football', '9'));
  assert.equal(calls, 1, 'concurrent viewers share one upstream request');
  release(); gate = null;
  await Promise.all(requests);
  now = 4999;
  await fetchGameSummary('football/college-football', '9');
  assert.equal(calls, 1);
  now = 5000;
  await fetchGameSummary('football/college-football', '9');
  assert.equal(calls, 2, 'live cache expires after five seconds');
  await fetchGameSummary('basketball/mens-college-basketball', '9');
  assert.equal(calls, 3, 'sports cannot share cached IDs');
  for (const [nextState, id, ttl] of [['pre', '10', 30000], ['post', '11', 300000]]) {
    state = nextState;
    await fetchGameSummary('football/college-football', id);
    const before = calls;
    now += ttl - 1;
    await fetchGameSummary('football/college-football', id);
    assert.equal(calls, before);
    now++;
    await fetchGameSummary('football/college-football', id);
    assert.equal(calls, before + 1);
  }
  fail = true;
  await assert.rejects(fetchGameSummary('football/college-football', '12'), /503/);
  fail = false; malformed = true;
  await assert.rejects(fetchGameSummary('football/college-football', '12'), /missing game status/);
  malformed = false;
  await fetchGameSummary('football/college-football', '12');
  console.log('PASS: 20 simultaneous requests share one fetch; live/upcoming/final TTLs; sport isolation; failures clear in-flight entries and retry.');
})().catch(err => { console.error(err); process.exitCode = 1; });
