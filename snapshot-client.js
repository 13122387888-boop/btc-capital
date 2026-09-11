/* Versioned transport only: source timestamps are never rewritten by the cache. */
(() => {
  'use strict';
  function create({ fetch: request, storage, baseUrl, snapshotMode, generatedAt = '', now = Date.now }) {
    const prefix = `btc_pulse_v3:${snapshotMode ? 'snapshot' : 'api'}:${new URL('.', baseUrl).href}:`;
    const memory = new Map(), pending = new Map();
    let generation = generatedAt;
    const validDate = value => Number.isFinite(Date.parse(value)) && Date.parse(value) <= now() + 300000;
    function valid(key, value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      if (key === 'static') return validDate(value.generatedAt) && Array.isArray(value.data?.btcFlows) && !!value.data?.sources;
      if (!['live', 'partial'].includes(value.status)) return false;
      if (key === 'serviceGammaV2') return value.schemaVersion === 2 && value.venue === 'Deribit' && validDate(value.asOf) && Array.isArray(value.oiByStrike) && Array.isArray(value.byStrike);
      const data = value.data;
      if (!data || typeof data !== 'object' || Array.isArray(data) || !validDate(value.updatedAt)) return false;
      if (key === 'serviceMarket') return !!data.assets && Array.isArray(data.candles);
      if (key === 'serviceSentiment') return Array.isArray(data.rows) && (!!data.current || data.rows.length > 0);
      if (key === 'serviceOnchain') return ['height', 'feeFast', 'feeHour', 'mempoolCount'].some(field => Number.isFinite(data[field]));
      if (key === 'serviceDefi') return Array.isArray(data.stableSeries);
      if (key === 'serviceHealth') return Array.isArray(data.modules);
      return false;
    }
    const version = value => value?.snapshot?.generatedAt || value?.generatedAt || '';
    function read(key, ttl = 120000) {
      try {
        const item = memory.get(key) || JSON.parse(storage?.getItem(prefix + key) || 'null');
        const retention = snapshotMode ? 6 * 3600000 : ttl * 12;
        if (!item || !Number.isFinite(item.at) || item.at > now() || now() - item.at > retention || !valid(key, item.value)) return null;
        if (snapshotMode && !validDate(version(item.value))) return null;
        memory.set(key, item);
        return { value: item.value, state: 'cached', cachedAt: item.at };
      } catch { return null; }
    }
    function write(key, value) {
      const item = { at: now(), value };
      memory.set(key, item);
      try { storage?.setItem(prefix + key, JSON.stringify(item)); } catch { /* optional device cache */ }
    }
    async function json(url, timeout, cache) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await request(url, { cache, signal: controller.signal, headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } finally { clearTimeout(timer); }
    }
    async function checkManifest() {
      if (!snapshotMode) return { changed: false, generation };
      const manifest = await json(new URL('./snapshots/manifest.json', baseUrl).href, 5000, 'no-store');
      if (!validDate(manifest?.generatedAt) || !['market', 'sentiment', 'onchain', 'defi', 'gamma', 'health'].every(name => manifest.snapshots?.[name])) throw new Error('Invalid snapshot manifest');
      const changed = !validDate(generation) || Date.parse(manifest.generatedAt) > Date.parse(generation);
      if (changed) generation = manifest.generatedAt;
      return { changed, generation };
    }
    async function get(key, url, ttl = 120000, timeout = 7500) {
      const target = generation, cached = read(key, ttl);
      if (snapshotMode && cached && version(cached.value) === target) return { ...cached, state: 'live' };
      const address = new URL(url, baseUrl);
      if (snapshotMode && target) address.searchParams.set('v', target);
      const pendingKey = `${key}:${address.href}`;
      if (pending.has(pendingKey)) return pending.get(pendingKey);
      const task = (async () => {
        try {
          const value = await json(address.href, timeout, snapshotMode ? 'default' : 'no-store');
          if (!valid(key, value)) throw new Error(`Invalid ${key} payload`);
          // Query parameters alone do not guarantee an immutable deployment.
          if (snapshotMode && (version(value) !== target || target !== generation)) throw new Error('Snapshot generation mismatch');
          write(key, value);
          return { value, state: 'live', cachedAt: null };
        } catch (error) {
          if (cached) return cached;
          throw error;
        } finally { pending.delete(pendingKey); }
      })();
      pending.set(pendingKey, task);
      return task;
    }
    return Object.freeze({ read, get, checkManifest, generation: () => generation });
  }
  globalThis.PULSE_SNAPSHOT_CLIENT = Object.freeze({ create });
})();
