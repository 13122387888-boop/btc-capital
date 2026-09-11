import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { assetVersion, compactSnapshot } from './lib/public-assets.mjs';

const sandbox = { URL, AbortController, setTimeout, clearTimeout, Date, Map };
vm.runInNewContext(await readFile(new URL('../snapshot-client.js', import.meta.url), 'utf8'), sandbox);
const create = sandbox.PULSE_SNAPSHOT_CLIENT.create;
let clock = Date.parse('2026-09-11T10:00:00Z');
const oldGeneration = '2026-09-11T09:00:00Z', newGeneration = '2026-09-11T10:00:00Z';
const sourceTime = '2026-09-11T08:50:00Z';
const store = new Map();
const storage = { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value) };
const market = generation => ({ status: 'live', updatedAt: sourceTime, snapshot: { generatedAt: generation }, data: { assets: { bitcoin: { usd: 75000 } }, candles: [] } });
const manifest = generation => ({ generatedAt: generation, snapshots: Object.fromEntries(['market', 'sentiment', 'onchain', 'defi', 'gamma', 'health'].map(key => [key, {}])) });
let generation = oldGeneration, reply = null, calls = [];
const fetcher = async (url, options) => {
  calls.push({ url, cache: options.cache });
  return { ok: true, json: async () => url.includes('manifest.json') ? manifest(generation) : reply || market(generation) };
};
const options = { fetch: fetcher, storage, baseUrl: 'https://example.test/btc/', snapshotMode: true, generatedAt: oldGeneration, now: () => clock };
let client = create(options);
const get = () => client.get('serviceMarket', './snapshots/market.json', 120000);
await get();
assert.equal(calls[0].cache, 'default');
assert.equal(new URL(calls[0].url).searchParams.get('v'), oldGeneration);
const firstStorage = [...store.values()][0];
client = create(options);
assert.equal(client.read('serviceMarket').state, 'cached');
assert.equal(client.read('serviceMarket').value.updatedAt, sourceTime);
clock += 1000;
const before = calls.length;
await client.checkManifest();
await Promise.all([get(), get()]);
assert.equal(calls.length - before, 1, 'unchanged version only checks the manifest');
assert.equal(calls.at(-1).cache, 'no-store');
assert.equal([...store.values()][0], firstStorage, 'cache reads do not renew its age');

generation = newGeneration;
await client.checkManifest();
const priorCalls = calls.length;
await Promise.all([get(), get()]);
assert.equal(calls.length - priorCalls, 1, 'concurrent reads share one request');
assert.equal(client.read('serviceMarket').value.updatedAt, sourceTime);
assert.equal(new URL(calls.at(-1).url).searchParams.get('v'), newGeneration);

generation = '2026-09-11T10:00:01Z';
await client.checkManifest();
reply = market(oldGeneration);
const goodStore = [...store.values()][0];
assert.equal((await get()).state, 'cached', 'mismatched deployment keeps last successful value');
assert.equal([...store.values()][0], goodStore);
reply = { status: 'live', data: {} };
assert.equal((await get()).state, 'cached', 'malformed JSON objects do not poison the cache');
assert.equal([...store.values()][0], goodStore);
reply = null;
assert.equal((await get()).state, 'live', 'failed item is retried even at the same manifest version');

const isolated = create({ ...options, baseUrl: 'https://example.test/another/' });
assert.equal(isolated.read('serviceMarket'), null);
const api = create({ ...options, snapshotMode: false });
assert.equal(api.read('serviceMarket'), null, 'API and snapshot caches are isolated');
const apiBefore = calls.length;
await api.get('serviceMarket', '/api/data/market');
await api.get('serviceMarket', '/api/data/market');
assert.equal(calls.length - apiBefore, 2);
assert.equal(calls.at(-1).cache, 'no-store');
assert.equal(new URL(calls.at(-1).url).searchParams.has('v'), false);

assert.equal(create({ ...options, storage: { getItem: () => '{broken' } }).read('serviceMarket'), null);
assert.equal(create({ ...options, storage: { getItem: () => JSON.stringify({ at: clock + 1, value: market(oldGeneration) }) } }).read('serviceMarket'), null);
assert.equal(create({ ...options, storage: { getItem: () => JSON.stringify({ at: clock, value: { status: 'live' } }) } }).read('serviceMarket'), null);
const blockedStorage = { getItem() { throw Error('disabled'); }, setItem() { throw Error('quota'); } };
const noStorage = create({ ...options, storage: blockedStorage, generatedAt: generation });
await noStorage.get('serviceMarket', './snapshots/market.json');
assert.ok(noStorage.read('serviceMarket'), 'memory fallback works without localStorage');
clock += 6 * 3600000 + 1;
assert.equal(noStorage.read('serviceMarket'), null, 'expired device cache is not hydrated');
const expiredCalls = calls.length;
await noStorage.get('serviceMarket', './snapshots/market.json');
assert.equal(calls.length - expiredCalls, 1, 'expired memory entries cannot bypass the retention limit');
assert.equal(noStorage.read('serviceMarket').value.updatedAt, sourceTime, 'network revalidation still preserves the original source date');

let hang = true;
const timed = create({ ...options, storage: null, generatedAt: generation, fetch: (url, { signal }) => hang
  ? new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('timeout')), { once: true }))
  : Promise.resolve({ ok: true, json: async () => market(generation) }) });
await assert.rejects(timed.get('serviceMarket', './snapshots/market.json', 120000, 5), /timeout/);
hang = false;
await timed.get('serviceMarket', './snapshots/market.json', 120000, 5);

const gamma = { status: 'partial', schemaVersion: 2, venue: 'Deribit', asOf: sourceTime, snapshot: { generatedAt: generation }, oiByStrike: [{ strike: 70000, callOi: 1, putOi: 2 }], byStrike: [], gammaStatus: 'unavailable', oiStatus: 'live' };
const oiOnly = create({ ...options, generatedAt: generation, storage: null, fetch: async () => ({ ok: true, json: async () => gamma }) });
assert.equal((await oiOnly.get('serviceGammaV2', './snapshots/gamma.json')).value.oiStatus, 'live', 'OI survives missing Gamma model');

const series = Array.from({ length: 3208 }, (_, index) => ({ date: 1500000000 + index * 86400, supply: 1000 + index }));
const payload = { updatedAt: sourceTime, data: { stableSeries: series, totalTvl: 999 } };
const compact = compactSnapshot('defi', payload);
assert.equal(compact.data.stableSeries.length, 740);
assert.deepEqual(compact.data.stableSeries, series.slice(-740));
assert.equal(compact.data.totalTvl, 999);
assert.equal(payload.data.stableSeries.length, 3208, 'upstream input is untouched');
assert.equal(compactSnapshot('gamma', gamma), gamma, 'all option expiries and metadata remain unchanged');
assert.equal(assetVersion('same source'), assetVersion(Buffer.from('same source')));
assert.notEqual(assetVersion('same source'), assetVersion('changed source'));
const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const freshnessCode = appSource.slice(appSource.indexOf('  function recordSnapshotGeneration('), appSource.indexOf('  async function reloadForNewerSnapshot('));
const freshness = { Date, Map, isSnapshotMode: true, activeStaticGeneratedAt: newGeneration, deployment: { generatedAt: newGeneration }, moduleSnapshotGenerations: new Map(), activeSnapshotGeneratedAt: newGeneration };
vm.createContext(freshness);
vm.runInContext(freshnessCode, freshness);
freshness.recordSnapshotGeneration({ snapshot: { generatedAt: oldGeneration } }, 'market');
freshness.recordSnapshotGeneration({ snapshot: { generatedAt: newGeneration } }, 'gamma');
assert.equal(freshness.activeSnapshotGeneratedAt, oldGeneration, 'new options must not renew old market freshness');
freshness.recordSnapshotGeneration({ snapshot: { generatedAt: newGeneration } }, 'market');
assert.equal(freshness.activeSnapshotGeneratedAt, newGeneration);

const pollStart = appSource.indexOf('  setInterval(() => {');
const polling = appSource.slice(pollStart, appSource.indexOf('  }, 60_000);', pollStart) + '  }, 60_000);'.length);
let refreshes = 0, renders = 0, poll;
const pollingContext = { document: { visibilityState: 'hidden' }, Date, lastBackgroundRefreshAt: 0, isSnapshotMode: true, snapshotRefreshIntervalMs: 300000, latestHealthPayload: null, setInterval: fn => { poll = fn; }, refreshLiveDataInBackground: () => { refreshes++; }, renderTodayMarketState: () => { renders++; } };
vm.runInNewContext(polling, pollingContext);
poll();
assert.equal(refreshes + renders, 0, 'hidden tabs neither refresh nor redraw');
pollingContext.document.visibilityState = 'visible';
poll();
assert.equal(refreshes, 1);

const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const bootScript = index.match(/<script>([\s\S]*?)<\/script>/)[1];
for (const [hash, view, tab] of [['#overview', 'overview', 'oi'], ['#options/vol', 'options', 'vol'], ['#trend', 'trend', 'oi'], ['#missing', 'overview', 'oi']]) {
  const root = { dataset: {}, classList: { replace() {}, contains() { return false; }, add() {} } };
  vm.runInNewContext(bootScript, { document: { documentElement: root }, location: { hash }, window: {}, setTimeout() { return 1; } });
  assert.equal(root.dataset.initialView, view);
  assert.equal(root.dataset.initialTab, tab);
}
console.log('Snapshot tests passed: hydration, version reuse, freshness, schema, fallback, retry, isolation, timeout and compact build.');
