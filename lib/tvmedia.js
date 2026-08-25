const fetch = require('node-fetch');
const { TtlCache } = require('./cache');

const API_BASE = 'https://api.tvmedia.ca/tv/v4';
const cache = new TtlCache({ maxEntries: 100 });

function apiKey() { return process.env.TVMEDIA_API_KEY || ''; }
function requireApiKey() {
  if (!apiKey()) throw new Error('TV Media API key is not configured');
}
function validPostalCode(postalCode) {
  return typeof postalCode === 'string' && /^\d{5}(?:-\d{4})?$/.test(postalCode.trim());
}
function validLineupId(lineupId) {
  return typeof lineupId === 'string' && /^[A-Za-z0-9]+$/.test(lineupId);
}

async function tvMediaGet(path, params = {}) {
  requireApiKey();
  const query = new URLSearchParams({ ...params, api_key: apiKey() });
  const res = await fetch(`${API_BASE}${path}?${query}`, { timeout: 10000 });
  if (!res.ok) throw new Error(`TV Media API HTTP ${res.status}`);
  return res.json();
}

async function getLineups(postalCode) {
  const zip = String(postalCode || '').trim();
  if (!validPostalCode(zip)) throw new Error('valid 5-digit ZIP code required');
  const key = `lineups:${zip}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const data = await tvMediaGet('/lineups', { postalCode: zip });
  const lineups = Array.isArray(data) ? data.map(l => ({
    lineupID: String(l.lineupID || ''), lineupName: l.lineupName || '',
    lineupType: l.lineupType || '', providerID: String(l.providerID || ''),
    providerName: l.providerName || '', serviceArea: l.serviceArea || '',
  })).filter(l => l.lineupID && l.providerName) : [];
  cache.set(key, lineups, 24 * 3600 * 1000);
  return lineups;
}

async function getLineup(lineupId) {
  const id = String(lineupId || '').trim();
  if (!validLineupId(id)) throw new Error('valid lineup ID required');
  const key = `lineup:${id}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const data = await tvMediaGet(`/lineups/${encodeURIComponent(id)}`);
  if (!data || !Array.isArray(data.stations)) throw new Error('TV Media lineup response missing stations');
  cache.set(key, data, 29 * 24 * 3600 * 1000);
  return data;
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+hd$/, '').replace(/[^a-z0-9]/g, '');
}

async function findChannel(lineupId, network) {
  if (!lineupId || !network) return null;
  const wanted = normalize(network);
  if (!wanted) return null;
  const lineup = await getLineup(lineupId);
  const matches = lineup.stations.filter(s =>
    normalize(s.name) === wanted || normalize(s.callsign) === wanted || normalize(s.network) === wanted
  );
  if (!matches.length) return null;
  matches.sort((a, b) => (Number(a.channelNumber) || Number.MAX_SAFE_INTEGER) - (Number(b.channelNumber) || Number.MAX_SAFE_INTEGER));
  return String(matches[0].number || matches[0].channelNumber || '');
}

module.exports = { validPostalCode, validLineupId, getLineups, findChannel };
