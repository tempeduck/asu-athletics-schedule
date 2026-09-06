const fetch = require('node-fetch');
const { USER_AGENT } = require('./constants');
const { TtlCache } = require('./cache');

const cache = new TtlCache();
const inflight = new Map();

async function fetchGameSummary(slug, eventId) {
  const key = `${slug}:${eventId}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (inflight.has(key)) return inflight.get(key);
  const request = (async () => {
    const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${slug}/summary?event=${eventId}`, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000,
    });
    if (!response.ok) throw new Error(`ESPN HTTP ${response.status}`);
    const data = await response.json();
    const status = data?.header?.competitions?.[0]?.status?.type;
    if (!status) throw new Error('ESPN summary missing game status');
    // ESPN summary responses advertise max-age=4; five seconds is a practical
    // live polling interval, not a guarantee of ESPN's publication latency.
    cache.set(key, data, status.completed ? 300000 : status.state === 'in' ? 5000 : 30000);
    return data;
  })();
  inflight.set(key, request);
  try {
    return await request;
  } finally {
    inflight.delete(key);
  }
}

module.exports = { fetchGameSummary };
