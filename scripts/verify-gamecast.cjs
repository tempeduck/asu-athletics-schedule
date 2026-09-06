// Run with PLAYWRIGHT_MODULE pointing to the shared screenshot tool's Playwright.
// GAMECAST_FIXTURES optionally reuses downloaded summary JSON files for repeat runs.
// Uses a local fixture server; never opens or writes the application's database.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const express = require('express');
const fetch = require('node-fetch');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const examples = [
  ['football', 'football/college-football', '401856774', 'Football'],
  ['mbb', 'basketball/mens-college-basketball', '401851289', "Men's Basketball"],
  ['wbb', 'basketball/womens-college-basketball', '401859472', "Women's Basketball"],
  ['baseball', 'baseball/college-baseball', '401873831', 'Baseball'],
  ['softball', 'baseball/college-softball', '401872541', 'Softball'],
  ['hockey', 'hockey/mens-college-hockey', '401821372', 'Ice Hockey'],
  ['volleyball', 'volleyball/womens-college-volleyball', '401886988', 'Volleyball'],
  ['soccer', 'soccer/usa.ncaa.w.1', '401886272', 'Soccer'],
];

(async () => {
  const fixtures = {};
  await Promise.all(examples.map(async ([name, slug, id]) => {
    fixtures[id] = process.env.GAMECAST_FIXTURES
      ? JSON.parse(fs.readFileSync(path.join(process.env.GAMECAST_FIXTURES, `${name}.json`)))
      : await (await fetch(`https://site.api.espn.com/apis/site/v2/sports/${slug}/summary?event=${id}`, { timeout: 15000 })).json();
    assert(fixtures[id].header, `Missing ESPN fixture: ${name}`);
  }));
  // Freeze a live state for lifecycle tests even if ESPN has since finalized it.
  const football = fixtures['401856774'];
  football.header.competitions[0].status.type = { state: 'in', completed: false, description: 'In Progress', shortDetail: 'Live test' };
  // Completed summaries may omit current; replay a recorded drive so this
  // verification still exercises live-field behavior after the game ends.
  if (!football.drives?.current?.plays?.length) {
    football.drives.current = [...(football.drives?.previous || [])].reverse().find(d => {
      const end = d.plays?.[d.plays.length - 1]?.end;
      return d.plays?.length >= 2 && end?.yardsToEndzone != null && end?.team?.id;
    });
  }
  assert(football.drives?.current, 'Football fixture requires a recorded drive');
  const app = express();
  let fail = false;
  let delay = null;
  let requests = 0;
  app.get('/api/game/:id', async (req, res) => {
    requests++;
    if (delay && req.params.id === '401856774') await delay;
    if (fail) return res.status(502).json({ error: 'Unavailable' });
    res.json(fixtures[req.params.id]);
  });
  app.get('/api/h2h', (_req, res) => res.json({ games: 0 }));
  app.get('/', (_req, res) => res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body>
    <button id="opener">Game details</button>
    <div class="game-modal-overlay" id="game-modal-overlay"><div class="game-modal" id="game-modal" role="dialog" aria-modal="true" aria-label="Game details"><button class="game-modal-close" onclick="closeGameModal()">✕</button><div id="game-modal-inner"></div></div></div>
    <script src="/shared.js"></script><script src="/gamecast.js"></script><script src="/game-modal.js"></script></body></html>`));
  app.use(express.static(path.join(root, 'public')));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const out = path.join(root, 'handoff/gamecast');
  fs.mkdirSync(out, { recursive: true });
  try {
    await page.clock.install();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const open = async (id, sport) => {
      await page.evaluate(({ id, sport }) => openGameDetailModal(id, sport, { sport, title: 'Arizona State game' }), { id, sport });
      await page.waitForFunction(() => document.querySelector('.gm-refresh-status')?.textContent.includes('Updated') || document.querySelector('.gm-refresh-status')?.textContent.includes('Final'));
    };
    const results = [];
    for (const [name, , id, sport] of examples) {
      await open(id, sport);
      const expected = ['football', 'mbb', 'wbb', 'baseball', 'softball'].includes(name);
      assert.equal(await page.locator('#gm-gamecast').count(), expected ? 1 : 0, `${name} capability`);
      if (expected) assert(await page.locator('.gc-play').count() > 0, `${name} timeline`);
      if (name === 'football') {
        assert.equal(await page.locator('.gc-field').count(), 1);
        await page.locator('.gc-field').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(out, 'football-desktop.png') });
      }
      results.push(`${sport}: ${expected ? 'Gamecast' : 'basic details only'}`);
      await page.evaluate(() => closeGameModal());
    }

    // Preserve tab, keyboard focus and scroll across polling; failures retain data.
    await open('401856774', 'Football');
    await page.locator('[data-gm-tab="gm-stats"]').click();
    await page.locator('[data-gm-tab="gm-stats"]').focus();
    await page.evaluate(() => { document.getElementById('game-modal').scrollTop = 250; });
    const scroll = await page.locator('#game-modal').evaluate(el => el.scrollTop);
    let count = requests;
    await page.clock.fastForward(5000);
    await page.waitForFunction(() => _gmSession?.controller === null);
    assert.equal(requests, count + 1);
    assert.equal(await page.locator('.gm-tab-panel.active').getAttribute('id'), 'gm-stats');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.gmTab), 'gm-stats');
    assert.equal(await page.locator('#game-modal').evaluate(el => el.scrollTop), scroll);
    fail = true;
    await page.clock.fastForward(5000);
    await page.waitForFunction(() => document.querySelector('.gm-refresh-status').textContent.includes('interrupted'));
    assert.equal(await page.locator('.gm-scores').count(), 1);
    fail = false;
    await page.clock.fastForward(30000);
    await page.waitForFunction(() => document.querySelector('.gm-refresh-status').textContent.includes('Updated'));

    await page.locator('[data-gm-tab="gm-gamecast"]').click();
    const previous = page.locator('.gc-drive').last();
    await previous.locator('summary').click();
    await page.clock.fastForward(5000);
    await page.waitForFunction(() => _gmSession?.controller === null);
    assert(await previous.evaluate(el => el.open), 'expanded drive preserved');

    // Adding a new play above the reader keeps the same play at the same height.
    const reading = page.locator('.gc-drive').first().locator('[data-gc-play]').nth(1);
    await reading.evaluate(el => el.scrollIntoView({ block: 'center' }));
    const readingId = await reading.getAttribute('data-gc-play');
    const readingTop = (await reading.boundingBox()).y;
    const currentPlays = football.drives.current.plays;
    currentPlays.push({ ...currentPlays[currentPlays.length - 1], id: 'verification-new-play', text: 'New play for scroll verification' });
    await page.clock.fastForward(5000);
    await page.waitForFunction(() => document.querySelector('[data-gc-play="verification-new-play"]'));
    const restoredTop = await page.evaluate(id => [...document.querySelectorAll('[data-gc-play]')].find(el => el.dataset.gcPlay === id).getBoundingClientRect().top, readingId);
    assert(Math.abs(restoredTop - readingTop) <= 1, 'reading position survives new plays');
    currentPlays.pop();
    await page.clock.fastForward(5000);
    await page.waitForFunction(() => !document.querySelector('[data-gc-play="verification-new-play"]'));

    count = requests;
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.fastForward(60000);
    assert.equal(requests, count, 'hidden page does not poll');
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => _gmSession?.controller === null);
    assert.equal(requests, count + 1, 'visible page resumes immediately');

    // Mobile light and dark layouts, including narrow phones.
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator('.gc-field').scrollIntoViewIfNeeded();
      assert(await page.locator('#game-modal').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `modal overflow at ${width}`);
      if (width === 390) {
        await page.screenshot({ path: path.join(out, 'football-mobile.png') });
        await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
        await page.clock.runFor(300); // Let theme color transitions finish.
        await page.screenshot({ path: path.join(out, 'football-mobile-dark.png') });
      }
    }

    // Stale responses from a closed/previous game cannot replace the current one.
    await page.evaluate(() => closeGameModal());
    let release;
    delay = new Promise(resolve => { release = resolve; });
    await page.evaluate(() => openGameDetailModal('401856774', 'Football', {}));
    await open('401851289', "Men's Basketball");
    release(); delay = null;
    assert.equal(await page.locator('.gm-headline').textContent(), "Men's Basketball");
    count = requests;
    await page.clock.fastForward(60000);
    assert.equal(requests, count, 'completed game does not poll');
    await page.evaluate(() => closeGameModal());
    await page.clock.fastForward(60000);
    assert.equal(requests, count, 'closed game does not poll');

    // Missing fields and hostile feed text stay safe; away probabilities invert.
    const edge = await page.evaluate(() => {
      const competitors = [{ homeAway: 'away', team: { id: '9', abbreviation: 'ASU' } }, { homeAway: 'home', team: { id: '1', abbreviation: 'OPP' } }];
      const html = buildGamecastPanel({ plays: [{ text: '<img src=x onerror=alert(1)>' }], winprobability: [{ homeWinPercentage: .8 }] }, "Men's Basketball", competitors[0], competitors).panel;
      return { escaped: html.includes('&lt;img'), raw: html.includes('<img'), away: html.includes('20.0%'), missing: buildGamecastPanel({}, 'Volleyball', competitors[0], competitors) };
    });
    assert(edge.escaped && !edge.raw && edge.away && edge.missing === null);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'PASS', sports: results, checks: ['5-second live refresh and 30-second error backoff', 'tab/focus/scroll preservation', 'reading position after new plays', 'expanded drives', 'network failure and recovery', 'hidden tab pause/resume', 'stale request isolation', 'stop after final/close', '320/390px overflow', 'escaped feed text', 'missing data', 'away win probability'], screenshots: out }, null, 2));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
