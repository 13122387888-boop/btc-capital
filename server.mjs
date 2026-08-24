import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchDeribitGamma, isUsableGammaPayload } from './scripts/lib/deribit-options.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const GAMMA_CACHE_MS = 5 * 60 * 1000;
const GAMMA_LAST_GOOD_MS = 24 * 60 * 60 * 1000;
const GAMMA_LAST_GOOD_FILE = join(root, '.runtime', 'pages-cache', 'gamma-last-good.json');
const DATA_TIMEOUT_MS = 5_000;
const STALE_TTL_MULTIPLIER = 12;

let gammaCache = null;
let gammaPending = null;
let gammaLastGood = null;
const serverStartedAt = Date.now();
const resourceCache = new Map();
const resourcePending = new Map();

const DATA_ENDPOINTS = {
  gateBtcTicker: 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT',
  gateEthTicker: 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=ETH_USDT',
  gateBtcCandles: 'https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=1d&limit=370',
  coinGeckoPrices: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple,binancecoin,dogecoin&vs_currencies=usd&include_24hr_change=true&include_market_cap=true',
  coinGeckoGlobal: 'https://api.coingecko.com/api/v3/global',
  fearGreed: 'https://api.alternative.me/fng/?limit=370&format=json',
  blockstreamFees: 'https://blockstream.info/api/fee-estimates',
  blockstreamMempool: 'https://blockstream.info/api/mempool',
  blockstreamHeight: 'https://blockstream.info/api/blocks/tip/height',
  mempoolFees: 'https://mempool.space/api/v1/fees/recommended',
  mempoolHeight: 'https://mempool.space/api/blocks/tip/height',
  blockchairStats: 'https://api.blockchair.com/bitcoin/stats',
  defiChains: 'https://api.llama.fi/v2/chains',
  stablecoinHistory: 'https://stablecoins.llama.fi/stablecoincharts/all',
};

const DATA_TTL = {
  ticker: 60_000,
  prices: 2 * 60_000,
  global: 5 * 60_000,
  candles: 15 * 60_000,
  sentiment: 15 * 60_000,
  onchainFast: 2 * 60_000,
  onchainSlow: 10 * 60_000,
  defiChains: 15 * 60_000,
  stablecoins: 30 * 60_000,
};

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchJson(url, timeout = DATA_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'btc-capital-pulse/1.0',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeout = DATA_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'btc-capital-pulse/1.0',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function resourceResult(key, ttl, loader) {
  const now = Date.now();
  const cached = resourceCache.get(key);
  if (cached && cached.expiresAt > now) {
    return { available: true, value: cached.value, fetchedAt: cached.fetchedAt, state: 'cached' };
  }
  if (resourcePending.has(key)) return resourcePending.get(key);

  const pending = (async () => {
    try {
      const value = await loader();
      const fetchedAt = Date.now();
      resourceCache.set(key, { value, fetchedAt, expiresAt: fetchedAt + ttl });
      return { available: true, value, fetchedAt, state: 'live' };
    } catch {
      const staleLimit = ttl * STALE_TTL_MULTIPLIER;
      if (cached && now - cached.fetchedAt <= staleLimit) {
        return { available: true, value: cached.value, fetchedAt: cached.fetchedAt, state: 'stale' };
      }
      return { available: false, value: null, fetchedAt: null, state: 'unavailable' };
    }
  })().finally(() => resourcePending.delete(key));

  resourcePending.set(key, pending);
  return pending;
}

function jsonResource(key, url, ttl) {
  return resourceResult(key, ttl, () => fetchJson(url, DATA_TIMEOUT_MS));
}

function textResource(key, url, ttl) {
  return resourceResult(key, ttl, () => fetchText(url, DATA_TIMEOUT_MS));
}

function sourceInfo(provider, role, url, result) {
  return {
    provider,
    role,
    url,
    status: result?.state ?? 'unavailable',
    updatedAt: result?.fetchedAt ? new Date(result.fetchedAt).toISOString() : null,
  };
}

function moduleEnvelope(data, resources, { hasData, complete }) {
  const available = resources.filter((resource) => resource?.result?.available);
  const selectedAvailable = resources.filter((resource) => resource?.selected === true && resource?.result?.available);
  const effectiveResources = selectedAvailable.length ? selectedAvailable : available;
  const hasStale = effectiveResources.some((resource) => resource.result.state === 'stale');
  const updatedAtMs = Math.max(0, ...effectiveResources.map((resource) => resource.result.fetchedAt ?? 0));
  return {
    status: !hasData ? 'unavailable' : complete && !hasStale ? 'live' : 'partial',
    updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : null,
    sources: resources.map(({ provider, role, url, result, selected = false, fields = [] }) => ({
      ...sourceInfo(provider, role, url, result),
      selected: selected === true && result?.available === true,
      fields,
    })),
    data,
  };
}

function firstRow(result) {
  return result?.available && Array.isArray(result.value) ? result.value[0] ?? {} : {};
}

function normalizedAsset(coinGeckoRow, gateRow = null) {
  const gatePrice = numberOrNull(gateRow?.last);
  const gateChange = numberOrNull(gateRow?.change_percentage);
  return {
    usd: gatePrice ?? numberOrNull(coinGeckoRow?.usd),
    usd24hChange: gateChange ?? numberOrNull(coinGeckoRow?.usd_24h_change),
    usdMarketCap: numberOrNull(coinGeckoRow?.usd_market_cap),
  };
}

function normalizeGateCandles(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const timestamp = numberOrNull(row?.[0]);
    const open = numberOrNull(row?.[5]);
    const high = numberOrNull(row?.[3]);
    const low = numberOrNull(row?.[4]);
    const close = numberOrNull(row?.[2]);
    const closed = row?.[7] !== false && String(row?.[7]).toLowerCase() !== 'false';
    if (timestamp === null || !closed || [open, high, low, close].some((item) => item === null)) return [];
    const date = new Date(timestamp * 1000);
    if (Number.isNaN(date.getTime())) return [];
    return [{ date: date.toISOString().slice(0, 10), open, high, low, close }];
  }).sort((a, b) => a.date.localeCompare(b.date));
}

async function marketDataResult() {
  const [gateBtcResult, gateEthResult, candlesResult, pricesResult, globalResult] = await Promise.all([
    jsonResource('market:gate:btc', DATA_ENDPOINTS.gateBtcTicker, DATA_TTL.ticker),
    jsonResource('market:gate:eth', DATA_ENDPOINTS.gateEthTicker, DATA_TTL.ticker),
    jsonResource('market:gate:candles', DATA_ENDPOINTS.gateBtcCandles, DATA_TTL.candles),
    jsonResource('market:coingecko:prices', DATA_ENDPOINTS.coinGeckoPrices, DATA_TTL.prices),
    jsonResource('market:coingecko:global', DATA_ENDPOINTS.coinGeckoGlobal, DATA_TTL.global),
  ]);
  const gateBtc = firstRow(gateBtcResult);
  const gateEth = firstRow(gateEthResult);
  const coinGecko = pricesResult.available && pricesResult.value && typeof pricesResult.value === 'object'
    ? pricesResult.value
    : {};
  const assetIds = ['bitcoin', 'ethereum', 'solana', 'ripple', 'binancecoin', 'dogecoin'];
  const assets = Object.fromEntries(assetIds.map((id) => [id, normalizedAsset(
    coinGecko[id],
    id === 'bitcoin' ? gateBtc : id === 'ethereum' ? gateEth : null,
  )]));
  const globalRow = globalResult.available ? globalResult.value?.data ?? {} : {};
  const global = {
    totalMarketCapUsd: numberOrNull(globalRow?.total_market_cap?.usd),
    totalVolumeUsd: numberOrNull(globalRow?.total_volume?.usd),
    btcDominance: numberOrNull(globalRow?.market_cap_percentage?.btc),
    ethDominance: numberOrNull(globalRow?.market_cap_percentage?.eth),
    activeCryptocurrencies: numberOrNull(globalRow?.active_cryptocurrencies),
  };
  const candles = normalizeGateCandles(candlesResult.value);
  const bitcoinUsesGate = numberOrNull(gateBtc?.last) !== null;
  const ethereumUsesGate = numberOrNull(gateEth?.last) !== null;
  const btcPriceProvider = bitcoinUsesGate ? 'Gate.io' : assets.bitcoin.usd !== null ? 'CoinGecko fallback' : null;
  const btcPriceResult = bitcoinUsesGate ? gateBtcResult : assets.bitcoin.usd !== null ? pricesResult : null;
  const btcPriceAsOf = btcPriceResult?.fetchedAt ? new Date(btcPriceResult.fetchedAt).toISOString() : null;
  const btcCandlesAsOf = candlesResult?.fetchedAt && candles.length ? new Date(candlesResult.fetchedAt).toISOString() : null;
  const priceProvider = bitcoinUsesGate && ethereumUsesGate
    ? 'Gate.io'
    : bitcoinUsesGate || ethereumUsesGate ? 'Gate.io / CoinGecko fallback' : 'CoinGecko fallback';
  const coinGeckoPriceFields = [];
  if (!bitcoinUsesGate && assets.bitcoin.usd !== null) coinGeckoPriceFields.push('BTC 价格与 24h 变化');
  if (!ethereumUsesGate && assets.ethereum.usd !== null) coinGeckoPriceFields.push('ETH 价格与 24h 变化');
  if (assetIds.slice(2).some((id) => assets[id].usd !== null)) coinGeckoPriceFields.push('其他币种价格');
  if (assetIds.some((id) => assets[id].usdMarketCap !== null)) coinGeckoPriceFields.push('币种市值');
  const globalFields = Object.entries(global).filter(([, value]) => value !== null).map(([field]) => field);
  const resources = [
    { provider: 'Gate.io', role: 'BTC/USDT ticker', url: DATA_ENDPOINTS.gateBtcTicker, result: gateBtcResult, selected: bitcoinUsesGate, fields: bitcoinUsesGate ? ['BTC 价格', 'BTC 24h 变化'] : [] },
    { provider: 'Gate.io', role: 'ETH/USDT ticker', url: DATA_ENDPOINTS.gateEthTicker, result: gateEthResult, selected: ethereumUsesGate, fields: ethereumUsesGate ? ['ETH 价格', 'ETH 24h 变化'] : [] },
    { provider: 'Gate.io', role: 'BTC/USDT daily candles', url: DATA_ENDPOINTS.gateBtcCandles, result: candlesResult, selected: candles.length > 0, fields: candles.length ? ['BTC 日 K'] : [] },
    { provider: 'CoinGecko', role: 'asset metadata and price fallback', url: DATA_ENDPOINTS.coinGeckoPrices, result: pricesResult, selected: coinGeckoPriceFields.length > 0, fields: coinGeckoPriceFields },
    { provider: 'CoinGecko', role: 'global crypto market totals', url: DATA_ENDPOINTS.coinGeckoGlobal, result: globalResult, selected: globalFields.length > 0, fields: globalFields },
  ];
  const hasData = assets.bitcoin.usd !== null || candles.length > 0 || global.totalMarketCapUsd !== null;
  const complete = assets.bitcoin.usd !== null
    && assets.ethereum.usd !== null
    && assetIds.every((id) => assets[id].usd !== null)
    && candles.length > 0
    && Object.values(global).every((value) => value !== null);
  return moduleEnvelope({ assets, global, candles, priceProvider, btcPriceProvider, btcPriceAsOf, btcCandlesAsOf }, resources, { hasData, complete });
}

async function sentimentDataResult() {
  const result = await jsonResource('sentiment:alternative', DATA_ENDPOINTS.fearGreed, DATA_TTL.sentiment);
  const rows = (result.available && Array.isArray(result.value?.data) ? result.value.data : []).flatMap((row) => {
    const timestamp = numberOrNull(row?.timestamp);
    const value = numberOrNull(row?.value);
    if (timestamp === null || value === null) return [];
    const date = new Date(timestamp * 1000);
    if (Number.isNaN(date.getTime())) return [];
    return [{ date: date.toISOString().slice(0, 10), value, label: String(row?.value_classification ?? '') }];
  }).sort((a, b) => a.date.localeCompare(b.date));
  const current = rows.at(-1) ?? null;
  const resources = [{
    provider: 'Alternative.me',
    role: 'Crypto Fear & Greed Index',
    url: DATA_ENDPOINTS.fearGreed,
    result,
    selected: current !== null,
    fields: current !== null ? ['当前恐贪值', '历史恐贪序列'] : [],
  }];
  return moduleEnvelope({ rows, current }, resources, {
    hasData: current !== null,
    complete: current !== null && rows.length > 1,
  });
}

function finiteNonNegative(value) {
  const normalized = numberOrNull(value);
  return normalized !== null && normalized >= 0 ? normalized : null;
}

function finitePositive(value) {
  const normalized = numberOrNull(value);
  return normalized !== null && normalized > 0 ? normalized : null;
}

async function onchainDataResult() {
  const [blockstreamFeesResult, blockstreamMempoolResult, blockstreamHeightResult] = await Promise.all([
    jsonResource('onchain:blockstream:fees', DATA_ENDPOINTS.blockstreamFees, DATA_TTL.onchainFast),
    jsonResource('onchain:blockstream:mempool', DATA_ENDPOINTS.blockstreamMempool, DATA_TTL.onchainFast),
    textResource('onchain:blockstream:height', DATA_ENDPOINTS.blockstreamHeight, DATA_TTL.onchainFast),
  ]);
  const resources = [
    { provider: 'Blockstream', role: 'fee estimates', url: DATA_ENDPOINTS.blockstreamFees, result: blockstreamFeesResult },
    { provider: 'Blockstream', role: 'mempool size', url: DATA_ENDPOINTS.blockstreamMempool, result: blockstreamMempoolResult },
    { provider: 'Blockstream', role: 'chain height', url: DATA_ENDPOINTS.blockstreamHeight, result: blockstreamHeightResult },
  ];
  const sourceByField = {};
  let feeFast = finitePositive(blockstreamFeesResult.value?.['1']);
  let feeHour = finitePositive(blockstreamFeesResult.value?.['6']);
  if (feeFast !== null) sourceByField.feeFast = 'Blockstream';
  if (feeHour !== null) sourceByField.feeHour = 'Blockstream';

  if (feeFast === null || feeHour === null) {
    const mempoolFeesResult = await jsonResource('onchain:mempool:fees', DATA_ENDPOINTS.mempoolFees, DATA_TTL.onchainFast);
    resources.push({ provider: 'mempool.space', role: 'fee estimates fallback', url: DATA_ENDPOINTS.mempoolFees, result: mempoolFeesResult });
    if (feeFast === null) {
      feeFast = finitePositive(mempoolFeesResult.value?.fastestFee);
      if (feeFast !== null) sourceByField.feeFast = 'mempool.space';
    }
    if (feeHour === null) {
      feeHour = finitePositive(mempoolFeesResult.value?.hourFee);
      if (feeHour !== null) sourceByField.feeHour = 'mempool.space';
    }
  }

  let height = finitePositive(blockstreamHeightResult.value);
  if (height !== null) sourceByField.height = 'Blockstream';
  if (height === null) {
    const mempoolHeightResult = await textResource('onchain:mempool:height', DATA_ENDPOINTS.mempoolHeight, DATA_TTL.onchainFast);
    resources.push({ provider: 'mempool.space', role: 'chain height fallback', url: DATA_ENDPOINTS.mempoolHeight, result: mempoolHeightResult });
    height = finitePositive(mempoolHeightResult.value);
    if (height !== null) sourceByField.height = 'mempool.space';
  }

  const blockstreamCount = finiteNonNegative(blockstreamMempoolResult.value?.count);
  const blockstreamSize = finiteNonNegative(blockstreamMempoolResult.value?.vsize);
  let mempoolCount = blockstreamCount;
  let mempoolSize = blockstreamSize;
  let mempoolUnit = blockstreamCount !== null && blockstreamSize !== null ? 'vB' : null;
  if (mempoolUnit) {
    sourceByField.mempoolCount = 'Blockstream';
    sourceByField.mempoolSize = 'Blockstream';
  }

  if (height === null || mempoolUnit === null) {
    const blockchairResult = await jsonResource('onchain:blockchair:stats', DATA_ENDPOINTS.blockchairStats, DATA_TTL.onchainSlow);
    resources.push({ provider: 'Blockchair', role: 'height and mempool fallback', url: DATA_ENDPOINTS.blockchairStats, result: blockchairResult });
    const stats = blockchairResult.value?.data ?? {};
    if (height === null) {
      height = finitePositive(stats.best_block_height);
      if (height !== null) sourceByField.height = 'Blockchair';
    }
    if (mempoolUnit === null) {
      const count = finiteNonNegative(stats.mempool_transactions);
      const size = finiteNonNegative(stats.mempool_size);
      if (count !== null && size !== null) {
        mempoolCount = count;
        mempoolSize = size;
        mempoolUnit = 'bytes';
        sourceByField.mempoolCount = 'Blockchair';
        sourceByField.mempoolSize = 'Blockchair';
      }
    }
  }

  const data = { height, feeFast, feeHour, mempoolCount, mempoolSize, mempoolUnit, sourceByField };
  const values = [height, feeFast, feeHour, mempoolCount, mempoolSize];
  const fieldsByRole = {
    'fee estimates': ['feeFast', 'feeHour'],
    'mempool size': ['mempoolCount', 'mempoolSize'],
    'chain height': ['height'],
    'fee estimates fallback': ['feeFast', 'feeHour'],
    'chain height fallback': ['height'],
    'height and mempool fallback': ['height', 'mempoolCount', 'mempoolSize'],
  };
  resources.forEach((resource) => {
    resource.fields = (fieldsByRole[resource.role] || []).filter((field) => sourceByField[field] === resource.provider);
    resource.selected = resource.fields.length > 0;
  });
  return moduleEnvelope(data, resources, {
    hasData: values.some((value) => value !== null),
    complete: values.every((value) => value !== null) && mempoolUnit !== null,
  });
}

async function defiDataResult() {
  const [chainsResult, stablecoinsResult] = await Promise.all([
    jsonResource('defi:chains', DATA_ENDPOINTS.defiChains, DATA_TTL.defiChains),
    jsonResource('defi:stablecoins', DATA_ENDPOINTS.stablecoinHistory, DATA_TTL.stablecoins),
  ]);
  const chains = (chainsResult.available && Array.isArray(chainsResult.value) ? chainsResult.value : [])
    .map((row) => ({ name: String(row?.name ?? '').trim(), tvl: finiteNonNegative(row?.tvl) }))
    .filter((row) => row.name && row.tvl !== null);
  const totalTvl = chains.length ? chains.reduce((sum, row) => sum + row.tvl, 0) : null;
  const topChain = chains.length
    ? chains.reduce((best, row) => row.tvl > best.tvl ? row : best)
    : null;
  const stableByDate = new Map();
  const rawStableRows = stablecoinsResult.available && Array.isArray(stablecoinsResult.value)
    ? stablecoinsResult.value
    : [];
  for (const row of rawStableRows) {
    const rawTimestamp = numberOrNull(row?.date);
    const supply = finiteNonNegative(row?.totalCirculatingUSD?.peggedUSD);
    if (rawTimestamp === null || supply === null) continue;
    const timestamp = rawTimestamp > 10_000_000_000 ? rawTimestamp : rawTimestamp * 1000;
    const parsedDate = new Date(timestamp);
    if (!Number.isNaN(parsedDate.getTime())) stableByDate.set(parsedDate.toISOString().slice(0, 10), supply);
  }
  const stableSeries = [...stableByDate.entries()]
    .map(([date, supply]) => ({ date, supply }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const resources = [
    { provider: 'DefiLlama', role: 'chain TVL', url: DATA_ENDPOINTS.defiChains, result: chainsResult, selected: totalTvl !== null, fields: totalTvl !== null ? ['全链 TVL', '头部公链 TVL'] : [] },
    { provider: 'DefiLlama', role: 'stablecoin supply history', url: DATA_ENDPOINTS.stablecoinHistory, result: stablecoinsResult, selected: stableSeries.length > 0, fields: stableSeries.length ? ['稳定币供给历史'] : [] },
  ];
  return moduleEnvelope({ totalTvl, topChain, stableSeries }, resources, {
    hasData: totalTvl !== null || stableSeries.length > 0,
    complete: totalTvl !== null && topChain !== null && stableSeries.length > 1,
  });
}

function gammaPayloadTime(payload) {
  const timestamp = Date.parse(payload?.lastSuccessAt || payload?.asOf || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function readGammaLastGood() {
  if (isUsableGammaPayload(gammaLastGood)) return gammaLastGood;
  try {
    const payload = JSON.parse(await readFile(GAMMA_LAST_GOOD_FILE, 'utf8'));
    if (!isUsableGammaPayload(payload)) return null;
    gammaLastGood = payload;
    return payload;
  } catch {
    return null;
  }
}

async function writeGammaLastGood(payload) {
  if (!isUsableGammaPayload(payload)) return;
  const clean = { ...payload, status: payload.status === 'partial' ? 'partial' : 'live', stale: false, lastAttemptAt: payload.asOf };
  gammaLastGood = clean;
  await mkdir(join(root, '.runtime', 'pages-cache'), { recursive: true });
  await writeFile(GAMMA_LAST_GOOD_FILE, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
}

function gammaErrorCode(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'DERIBIT_TIMEOUT';
  const message = String(error?.message || '');
  if (/HTTP 429/.test(message)) return 'DERIBIT_RATE_LIMIT';
  if (/HTTP \d+/.test(message)) return 'DERIBIT_HTTP_ERROR';
  if (/覆盖不足/.test(message)) return 'DERIBIT_LOW_COVERAGE';
  if (/结构无效|无法匹配/.test(message)) return 'DERIBIT_SCHEMA_ERROR';
  return 'DERIBIT_UNAVAILABLE';
}

function unavailableResult(error = null) {
  return {
    statusCode: 503,
    payload: {
      status: 'unavailable',
      message: 'Deribit 官方公开期权接口暂不可达，且没有 24 小时内可用的最后成功快照。',
      symbol: 'BTC',
      venue: 'Deribit',
      lastAttemptAt: new Date().toISOString(),
      errorCode: gammaErrorCode(error),
    },
  };
}

async function fallbackGammaResult(error) {
  const lastGood = await readGammaLastGood();
  const lastGoodAt = gammaPayloadTime(lastGood);
  const ageMs = Number.isFinite(lastGoodAt) ? Date.now() - lastGoodAt : Infinity;
  if (!isUsableGammaPayload(lastGood) || ageMs > GAMMA_LAST_GOOD_MS) return unavailableResult(error);
  const lastAttemptAt = new Date().toISOString();
  return {
    statusCode: 200,
    payload: {
      ...lastGood,
      status: 'partial',
      stale: true,
      delivery: 'stale_cache',
      lastSuccessAt: lastGood.lastSuccessAt || lastGood.asOf,
      lastAttemptAt,
      errorCode: gammaErrorCode(error),
      message: `本次 Deribit 请求失败，沿用 ${Math.max(1, Math.round(ageMs / 60000))} 分钟前的最后成功快照；超过 24 小时将停止展示。`,
    },
  };
}

async function gammaResult() {
  const now = Date.now();
  if (gammaCache && gammaCache.expiresAt > now) return { ...gammaCache, cache: 'HIT' };
  if (gammaPending) return gammaPending;

  gammaPending = (async () => {
    let result;
    try {
      const payload = await fetchDeribitGamma({ now });
      await writeGammaLastGood(payload);
      result = { statusCode: 200, payload };
    } catch (error) {
      result = await fallbackGammaResult(error);
    }
    gammaCache = { ...result, expiresAt: Date.now() + GAMMA_CACHE_MS };
    return { ...gammaCache, cache: 'MISS' };
  })().finally(() => {
    gammaPending = null;
  });

  return gammaPending;
}

async function readRuntimeJson(name) {
  try {
    const value = JSON.parse(await readFile(join(root, '.runtime', name), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function automationStatus() {
  const [update, schedule] = await Promise.all([
    readRuntimeJson('last-update.json'),
    readRuntimeJson('schedule.json'),
  ]);
  const modules = {};
  for (const [id, value] of Object.entries(update?.modules ?? {})) {
    if (!['etf', 'ibit', 'seasonality'].includes(id) || !value || typeof value !== 'object') continue;
    modules[id] = {
      status: value.status ?? null,
      dataAsOf: value.dataAsOf ?? value.afterAsOf ?? null,
      provider: value.provider ?? null,
      lastAttemptAt: value.lastAttemptAt ?? null,
      lastSuccessAt: value.lastSuccessAt ?? null,
      errorCode: value.errorCode ?? null,
    };
  }
  return {
    scheduleEnabled: schedule?.enabled === true,
    scheduleTime: schedule?.enabled === true ? schedule.time ?? null : null,
    status: update?.status ?? 'not_run',
    trigger: update?.trigger ?? null,
    lastAttemptAt: update?.startedAt ?? null,
    lastCompletedAt: update?.finishedAt ?? null,
    validation: update?.validation ?? null,
    modules,
  };
}

async function healthDataResult() {
  const checkedAt = new Date().toISOString();
  const automation = await automationStatus();
  const definitions = [
    { id: 'market', label: '市场行情与 K 线', targetSeconds: 15 * 60, loader: marketDataResult },
    { id: 'sentiment', label: '恐慌与贪婪', targetSeconds: 60 * 60, loader: sentimentDataResult },
    { id: 'onchain', label: 'Bitcoin 链上', targetSeconds: 15 * 60, loader: onchainDataResult },
    { id: 'defi', label: 'DeFi 流动性', targetSeconds: 2 * 60 * 60, loader: defiDataResult },
  ];
  const settled = await Promise.allSettled([
    ...definitions.map((definition) => definition.loader()),
    gammaResult(),
  ]);
  const modules = definitions.map((definition, index) => {
    const result = settled[index];
    const payload = result.status === 'fulfilled'
      ? result.value
      : { status: 'unavailable', updatedAt: null, sources: [], data: {} };
    const data = payload.data ?? {};
    const missingFields = [];
    let dataAsOf = null;
    let fallbackActive = false;
    if (definition.id === 'market') {
      const assets = data.assets ?? {}, global = data.global ?? {};
      if (assets.bitcoin?.usd === null || assets.bitcoin?.usd === undefined) missingFields.push('BTC 价格');
      if (!Array.isArray(data.candles) || !data.candles.length) missingFields.push('BTC 日 K');
      if (global.totalMarketCapUsd === null || global.totalMarketCapUsd === undefined) missingFields.push('全市场市值');
      dataAsOf = data.candles?.at(-1)?.date ?? null;
      fallbackActive = String(data.priceProvider ?? '').includes('fallback');
    } else if (definition.id === 'sentiment') {
      if (!data.current) missingFields.push('当前恐贪值');
      dataAsOf = data.current?.date ?? data.rows?.at(-1)?.date ?? null;
    } else if (definition.id === 'onchain') {
      const fieldLabels = { height: '区块高度', feeFast: '下一块费率', feeHour: '约 1 小时费率', mempoolCount: '待确认交易', mempoolSize: '内存池体积' };
      for (const field of ['height', 'feeFast', 'feeHour', 'mempoolCount', 'mempoolSize']) {
        if (data[field] === null || data[field] === undefined) missingFields.push(fieldLabels[field]);
      }
      fallbackActive = Object.values(data.sourceByField ?? {}).some((provider) => provider !== 'Blockstream');
    } else if (definition.id === 'defi') {
      if (data.totalTvl === null || data.totalTvl === undefined) missingFields.push('全链 TVL');
      if (!Array.isArray(data.stableSeries) || !data.stableSeries.length) missingFields.push('稳定币供给');
      dataAsOf = data.stableSeries?.at(-1)?.date ?? null;
    }
    const sources = (Array.isArray(payload.sources) ? payload.sources : []).map((source) => ({
      ...source,
      fetchedAt: source.updatedAt ?? null,
      selected: source.selected === true && source.status !== 'unavailable',
      fields: Array.isArray(source.fields) ? source.fields : [],
    }));
    const selectedTimes = sources.filter((source) => source.selected && source.fetchedAt).map((source) => Date.parse(source.fetchedAt)).filter(Number.isFinite);
    const fetchedAtMs = selectedTimes.length ? Math.min(...selectedTimes) : payload.updatedAt ? Date.parse(payload.updatedAt) : NaN;
    const ageSeconds = Number.isFinite(fetchedAtMs) ? Math.max(0, Math.round((Date.now() - fetchedAtMs) / 1000)) : null;
    const overdue = Number.isFinite(ageSeconds) && ageSeconds > definition.targetSeconds;
    const reasonCodes = [];
    if (missingFields.length) reasonCodes.push('missing_field');
    if (sources.some((source) => source.status === 'unavailable')) reasonCodes.push('missing_source');
    if (fallbackActive) reasonCodes.push('fallback_active');
    if (overdue) reasonCodes.push('stale_source');
    return {
      id: definition.id,
      label: definition.label,
      kind: 'dynamic',
      status: payload.status,
      fetchedAt: Number.isFinite(fetchedAtMs) ? new Date(fetchedAtMs).toISOString() : null,
      dataAsOf,
      ageSeconds,
      targetSeconds: definition.targetSeconds,
      overdue,
      fallbackActive,
      reasonCodes,
      missingFields,
      sources,
    };
  });
  const gammaSettled = settled.at(-1);
  const gammaPayload = gammaSettled.status === 'fulfilled' ? gammaSettled.value.payload : unavailableResult().payload;
  const gammaFetchedAt = gammaPayload.fetchedAt ?? gammaPayload.asOf ?? null;
  const gammaDataAsOf = gammaPayload.asOf ?? null;
  const gammaUpdatedAtMs = gammaDataAsOf ? Date.parse(gammaDataAsOf) : NaN;
  const gammaSourceStatus = gammaPayload.stale ? 'stale' : ['live', 'partial'].includes(gammaPayload.status) ? 'live' : 'unavailable';
  const gammaStatus = gammaPayload.status === 'live' ? 'live' : gammaPayload.status === 'partial' ? 'partial' : 'unavailable';
  modules.push({
    id: 'gamma',
    label: 'Deribit BTC Gamma 估算',
    kind: 'dynamic',
    status: gammaStatus,
    fetchedAt: gammaFetchedAt,
    dataAsOf: gammaDataAsOf,
    ageSeconds: Number.isFinite(gammaUpdatedAtMs) ? Math.max(0, Math.round((Date.now() - gammaUpdatedAtMs) / 1000)) : null,
    targetSeconds: 15 * 60,
    overdue: Number.isFinite(gammaUpdatedAtMs) ? Date.now() - gammaUpdatedAtMs > 15 * 60 * 1000 : false,
    fallbackActive: gammaPayload.stale === true,
    reasonCodes: gammaPayload.status === 'live' ? [] : gammaPayload.status === 'partial' ? [gammaPayload.stale ? 'stale_cache' : 'partial_coverage'] : ['missing_source'],
    missingFields: gammaPayload.status === 'unavailable' ? ['Deribit OI / 标记 IV'] : [],
    sources: [
      {
        provider: 'Deribit',
        role: 'BTC 期权合约、到期日与执行价',
        url: 'https://docs.deribit.com/api-reference/market-data/public-get_instruments',
        status: gammaSourceStatus,
        updatedAt: gammaFetchedAt,
        fetchedAt: gammaFetchedAt,
        selected: gammaPayload.status !== 'unavailable',
        fields: ['合约元数据', '到期日', '执行价'],
      },
      {
        provider: 'Deribit',
        role: 'BTC 期权 OI、标记 IV、利率与参考标的价',
        url: 'https://docs.deribit.com/api-reference/market-data/public-get_book_summary_by_currency',
        status: gammaSourceStatus,
        updatedAt: gammaFetchedAt,
        fetchedAt: gammaFetchedAt,
        selected: gammaPayload.status !== 'unavailable',
        fields: ['OI', '标记 IV', '利率', '参考标的价'],
      },
    ],
  });
  const effectiveHealth = (module) => module.status === 'unavailable' ? 'unavailable'
    : module.overdue ? 'stale'
      : module.status === 'partial' ? 'degraded'
        : 'healthy';
  const healthSummary = Object.fromEntries(['healthy', 'degraded', 'stale', 'unavailable'].map((key) => [key, modules.filter((module) => effectiveHealth(module) === key).length]));
  const deliverySummary = {
    network: modules.filter((module) => module.sources.some((source) => source.selected === true && source.status === 'live')).length,
    freshCache: modules.filter((module) => module.sources.some((source) => source.selected === true && source.status === 'cached')).length,
    staleCache: modules.filter((module) => module.sources.some((source) => source.selected === true && source.status === 'stale')).length,
  };
  const cachedModuleCount = modules.filter((module) => module.sources.some((source) => source.selected === true && ['cached', 'stale'].includes(source.status))).length;
  const summary = {
    total: modules.length,
    health: healthSummary,
    delivery: deliverySummary,
    healthy: healthSummary.healthy,
    partial: healthSummary.degraded,
    unavailable: healthSummary.unavailable,
    overdue: healthSummary.stale,
    cached: cachedModuleCount,
  };
  const availableCount = modules.length - healthSummary.unavailable;
  const status = !availableCount ? 'unavailable'
    : healthSummary.degraded || healthSummary.stale || healthSummary.unavailable ? 'partial'
    : 'live';
  return {
    service: 'btc-capital-pulse',
    status,
    updatedAt: checkedAt,
    sources: modules.flatMap((module) => module.sources.map((source) => ({ ...source, module: module.id }))),
    data: {
      checkedAt,
      serverStartedAt: new Date(serverStartedAt).toISOString(),
      uptimeSeconds: Math.round((Date.now() - serverStartedAt) / 1000),
      summary,
      modules,
      automation,
    },
  };
}

function sendJson(res, statusCode, payload, cache = null) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (cache) headers['X-Gamma-Cache'] = cache;
  if (statusCode === 405) headers.Allow = 'GET';
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

const DATA_ROUTES = new Map([
  ['/api/health', {
    handler: healthDataResult,
    emptyData: {
      checkedAt: null,
      serverStartedAt: null,
      uptimeSeconds: null,
      summary: {
        total: 5,
        health: { healthy: 0, degraded: 0, stale: 0, unavailable: 5 },
        delivery: { network: 0, freshCache: 0, staleCache: 0 },
        healthy: 0,
        partial: 0,
        unavailable: 5,
        overdue: 0,
        cached: 0,
      },
      modules: [],
      automation: null,
    },
  }],
  ['/api/data/market', {
    handler: marketDataResult,
    emptyData: {
      assets: {},
      global: {
        totalMarketCapUsd: null,
        totalVolumeUsd: null,
        btcDominance: null,
        ethDominance: null,
        activeCryptocurrencies: null,
      },
      candles: [],
      priceProvider: null,
      btcPriceProvider: null,
      btcPriceAsOf: null,
      btcCandlesAsOf: null,
    },
  }],
  ['/api/data/sentiment', {
    handler: sentimentDataResult,
    emptyData: { rows: [], current: null },
  }],
  ['/api/data/onchain', {
    handler: onchainDataResult,
    emptyData: {
      height: null,
      feeFast: null,
      feeHour: null,
      mempoolCount: null,
      mempoolSize: null,
      mempoolUnit: null,
      sourceByField: {},
    },
  }],
  ['/api/data/defi', {
    handler: defiDataResult,
    emptyData: { totalTvl: null, topChain: null, stableSeries: [] },
  }],
]);

const configuredPort = Number(process.env.PULSE_PORT);
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
  ? configuredPort
  : 4173;

createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/api/ping') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { status: 'method_not_allowed', message: '仅支持 GET。' });
        return;
      }
      sendJson(res, 200, {
        service: 'btc-capital-pulse',
        status: 'live',
        updatedAt: new Date().toISOString(),
        data: { serverStartedAt: new Date(serverStartedAt).toISOString() },
      });
      return;
    }
    if (pathname === '/api/gamma') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { status: 'method_not_allowed', message: '仅支持 GET。' });
        return;
      }
      const result = await gammaResult();
      sendJson(res, result.statusCode, result.payload, result.cache);
      return;
    }
    const dataRoute = DATA_ROUTES.get(pathname);
    if (dataRoute) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { status: 'method_not_allowed', message: '仅支持 GET。' });
        return;
      }
      let payload;
      try {
        payload = await dataRoute.handler();
      } catch {
        payload = { status: 'unavailable', updatedAt: null, sources: [], data: dataRoute.emptyData };
      }
      sendJson(res, 200, payload);
      return;
    }
    const relative = normalize(pathname === '/' ? 'index.html' : pathname.slice(1));
    const file = join(root, relative);
    if (!file.startsWith(root) || !(await stat(file)).isFile()) throw new Error('Not found');
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
