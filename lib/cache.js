// Minimal TTL cache matching the previous ad-hoc Map-of-{data,expiresAt}
// pattern: expired entries are evicted on read, no single-flight dedupe
// (concurrent misses each fetch, last write wins — same as before).
class TtlCache {
  constructor() {
    this._map = new Map();
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this._map.delete(key);
      return undefined;
    }
    return entry.data;
  }

  set(key, data, ttlMs) {
    this._map.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  async getOrFetch(key, ttlMs, fn) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const data = await fn();
    this.set(key, data, ttlMs);
    return data;
  }
}

module.exports = { TtlCache };
