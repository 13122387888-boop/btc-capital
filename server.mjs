import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const GAMMA_CACHE_MS = 5 * 60 * 1000;
const BYBIT_TIMEOUT_MS = 4_000;
const DATA_TIMEOUT_MS = 5_000;
const STALE_TTL_MULTIPLIER = 12;
const MIN_COVERAGE = 0.7;
const MIN_DAYS_TO_EXPIRY = 6;
const STRIKE_RANGE_RATIO = 0.25;
const CONTRACT_MULTIPLIER = 1;
const BYBIT_HOSTS = [
  'https://api.bybit.nl',
  'https://api.bybit.kz',
  'https://api.bybit.com',
];
const MONTHS = new Map([
  ['JAN', 0], ['FEB', 1], ['MAR', 2], ['APR', 3], ['MAY', 4], ['JUN', 5],
  ['JUL', 6], ['AUG', 7], ['SEP', 8], ['OCT', 9], ['NOV', 10], ['DEC', 11],
]);

let gammaCache = null;
let gammaPending = null;
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

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function isoDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function parseOptionSymbol(value) {
  const symbol = String(value ?? '').trim().toUpperCase();
  const match = symbol.match(
    /^BTC(?:USDT|USDC)?-(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2}|\d{4})-(\d+(?:\.\d+)?)-([CP])(?:-(USDT|USDC))?$/,
  );
  if (!match) return null;

  const day = Number(match[1]);
  const month = MONTHS.get(match[2]);
  const rawYear = Number(match[3]);
  const year = match[3].length === 2 ? 2000 + rawYear : rawYear;
  const strike = Number(match[4]);
  const expiryTimestamp = Date.UTC(year, month, day, 8);
  const expiryDate = new Date(expiryTimestamp);
  if (
    !Number.isFinite(strike) || strike <= 0
    || expiryDate.getUTCFullYear() !== year
    || expiryDate.getUTCMonth() !== month
    || expiryDate.getUTCDate() !== day
  ) return null;

  return {
    symbol,
    expiryTimestamp,
    expiry: isoDate(expiryTimestamp),
    strike,
    direction: match[5] === 'C' ? 'call' : 'put',
    settlement: match[6] ?? (symbol.startsWith('BTCUSDT-') ? 'USDT' : 'USDC'),
  };
}

async function fetchJson(url, timeout = BYBIT_TIMEOUT_MS) {
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
  const hasStale = available.some((resource) => resource.result.state === 'stale');
  const updatedAtMs = Math.max(0, ...available.map((resource) => resource.result.fetchedAt ?? 0));
  return {
    status: !hasData ? 'unavailable' : complete && !hasStale ? 'live' : 'partial',
    updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : null,
    sources: resources.map(({ provider, role, url, result }) => sourceInfo(provider, role, url, result)),
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
  const priceProvider = bitcoinUsesGate && ethereumUsesGate
    ? 'Gate.io'
    : bitcoinUsesGate || ethereumUsesGate ? 'Gate.io / CoinGecko fallback' : 'CoinGecko fallback';
  const resources = [
    { provider: 'Gate.io', role: 'BTC/USDT ticker', url: DATA_ENDPOINTS.gateBtcTicker, result: gateBtcResult },
    { provider: 'Gate.io', role: 'ETH/USDT ticker', url: DATA_ENDPOINTS.gateEthTicker, result: gateEthResult },
    { provider: 'Gate.io', role: 'BTC/USDT daily candles', url: DATA_ENDPOINTS.gateBtcCandles, result: candlesResult },
    { provider: 'CoinGecko', role: 'asset metadata and price fallback', url: DATA_ENDPOINTS.coinGeckoPrices, result: pricesResult },
    { provider: 'CoinGecko', role: 'global crypto market totals', url: DATA_ENDPOINTS.coinGeckoGlobal, result: globalResult },
  ];
  const hasData = assets.bitcoin.usd !== null || candles.length > 0 || global.totalMarketCapUsd !== null;
  const complete = assets.bitcoin.usd !== null
    && assets.ethereum.usd !== null
    && assetIds.every((id) => assets[id].usd !== null)
    && candles.length > 0
    && Object.values(global).every((value) => value !== null);
  return moduleEnvelope({ assets, global, candles, priceProvider }, resources, { hasData, complete });
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
    { provider: 'DefiLlama', role: 'chain TVL', url: DATA_ENDPOINTS.defiChains, result: chainsResult },
    { provider: 'DefiLlama', role: 'stablecoin supply history', url: DATA_ENDPOINTS.stablecoinHistory, result: stablecoinsResult },
  ];
  return moduleEnvelope({ totalTvl, topChain, stableSeries }, resources, {
    hasData: totalTvl !== null || stableSeries.length > 0,
    complete: totalTvl !== null && topChain !== null && stableSeries.length > 1,
  });
}

async function fetchBybitOptionTickers() {
  const failures = [];
  for (const host of BYBIT_HOSTS) {
    const url = `${host}/v5/market/tickers?category=option&baseCoin=BTC`;
    try {
      const payload = await fetchJson(url);
      const apiTime = numberOrNull(payload?.time);
      const rows = payload?.result?.list;
      if (payload?.retCode !== 0 || !Array.isArray(rows) || rows.length === 0 || apiTime === null) {
        throw new Error(`Invalid Bybit response (${payload?.retCode ?? 'unknown'})`);
      }
      return { host, apiTime, rows };
    } catch (error) {
      failures.push(`${host}: ${error?.name === 'AbortError' ? 'timeout' : error?.message ?? 'request failed'}`);
    }
  }
  throw new Error(`Bybit option tickers unavailable. ${failures.join('; ')}`);
}

function selectExpiry(parsedRows, apiTime) {
  const threshold = apiTime + MIN_DAYS_TO_EXPIRY * 24 * 60 * 60 * 1000;
  const expiries = [...new Set(parsedRows
    .map((row) => row.metadata.expiryTimestamp)
    .filter((timestamp) => timestamp >= threshold))]
    .sort((a, b) => a - b);
  return expiries[0] ?? null;
}

function aggregateGamma(metrics, spot) {
  const byStrike = new Map();
  let callGex = 0;
  let putGex = 0;

  for (const metric of metrics) {
    const unsignedGex = metric.gamma * metric.openInterest * CONTRACT_MULTIPLIER * spot ** 2 * 0.01;
    const signedGex = metric.metadata.direction === 'call' ? unsignedGex : -unsignedGex;
    const row = byStrike.get(metric.metadata.strike) ?? {
      strike: metric.metadata.strike,
      callGex: 0,
      putGex: 0,
      netGex: 0,
      callOi: 0,
      putOi: 0,
      contracts: 0,
    };

    if (metric.metadata.direction === 'call') {
      row.callGex += signedGex;
      row.callOi += metric.openInterest;
      callGex += signedGex;
    } else {
      row.putGex += signedGex;
      row.putOi += metric.openInterest;
      putGex += signedGex;
    }
    row.netGex += signedGex;
    row.contracts += 1;
    byStrike.set(metric.metadata.strike, row);
  }

  return {
    byStrike: [...byStrike.values()].sort((a, b) => a.strike - b.strike),
    callGex,
    putGex,
    netGex: callGex + putGex,
    grossGex: callGex + Math.abs(putGex),
  };
}

async function computeGamma() {
  const { host, apiTime, rows } = await fetchBybitOptionTickers();
  const parsedRows = rows
    .map((row) => ({ row, metadata: parseOptionSymbol(row?.symbol) }))
    .filter((item) => item.metadata !== null);
  if (!parsedRows.length) throw new Error('Bybit returned no recognizable BTC option symbols.');

  const expiryTimestamp = selectExpiry(parsedRows, apiTime);
  if (expiryTimestamp === null) throw new Error('No Bybit BTC option expiry at least six days away is available.');

  const expiryRows = parsedRows.filter((item) => item.metadata.expiryTimestamp === expiryTimestamp);
  const spot = median(expiryRows
    .map(({ row }) => numberOrNull(row?.underlyingPrice) ?? numberOrNull(row?.indexPrice))
    .filter((value) => value !== null && value > 0));
  if (spot === null || spot <= 0) throw new Error('Bybit BTC underlying price is unavailable.');

  const minimumStrike = spot * (1 - STRIKE_RANGE_RATIO);
  const maximumStrike = spot * (1 + STRIKE_RANGE_RATIO);
  const requestedRows = expiryRows.filter(({ metadata }) => (
    metadata.strike >= minimumStrike && metadata.strike <= maximumStrike
  ));
  if (!requestedRows.length) throw new Error('No Bybit BTC options are available in the requested strike range.');

  const metrics = requestedRows.flatMap(({ row, metadata }) => {
    const gamma = numberOrNull(row?.gamma);
    const openInterest = numberOrNull(row?.openInterest);
    if (gamma === null || gamma < 0 || openInterest === null || openInterest < 0) return [];
    return [{ metadata, gamma, openInterest }];
  });
  const coverage = metrics.length / requestedRows.length;
  const coverageDetail = {
    ratio: coverage,
    validContracts: metrics.length,
    requestedContracts: requestedRows.length,
    basis: '具有有效 Gamma 与 OI 的合约数 / 到期日及执行价范围内的合约数',
  };
  if (coverage < MIN_COVERAGE) {
    return {
      statusCode: 503,
      payload: {
        status: 'unavailable',
        message: `Bybit 有效期权数据覆盖率仅 ${(coverage * 100).toFixed(1)}%，低于 70%；未输出 GEX。`,
        symbol: 'BTC',
        venue: 'Bybit',
        expiry: isoDate(expiryTimestamp),
        coverage,
        coverageDetail,
      },
    };
  }

  const aggregate = aggregateGamma(metrics, spot);
  return {
    statusCode: 200,
    payload: {
      status: 'live',
      symbol: 'BTC',
      venue: 'Bybit',
      source: 'Bybit V5 官方公共期权行情',
      sourceHost: host,
      asOf: new Date(apiTime).toISOString(),
      spot,
      expiry: isoDate(expiryTimestamp),
      strikeRange: { minimum: minimumStrike, maximum: maximumStrike },
      formula: 'gamma × OI(BTC) × contract multiplier(1) × spot² × 0.01',
      unit: 'USD per 1% BTC move',
      signConvention: 'Call 为正、Put 为负；OI 代理口径不代表交易商真实净持仓。',
      contractMultiplier: CONTRACT_MULTIPLIER,
      coverage,
      coverageDetail,
      multiplierFallbackContracts: 0,
      byStrike: aggregate.byStrike,
      callGex: aggregate.callGex,
      putGex: aggregate.putGex,
      netGex: aggregate.netGex,
      grossGex: aggregate.grossGex,
    },
  };
}

function unavailableResult() {
  return {
    statusCode: 503,
    payload: {
      status: 'unavailable',
      message: 'Bybit 官方免费期权接口暂不可达；未生成 Gamma 敞口数据。',
      symbol: 'BTC',
      venue: 'Bybit',
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
      result = await computeGamma();
    } catch {
      result = unavailableResult();
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
    const selectedProviders = new Set();
    const missingFields = [];
    let dataAsOf = null;
    let fallbackActive = false;
    if (definition.id === 'market') {
      const assets = data.assets ?? {}, global = data.global ?? {};
      if (assets.bitcoin?.usd === null || assets.bitcoin?.usd === undefined) missingFields.push('BTC 价格');
      if (!Array.isArray(data.candles) || !data.candles.length) missingFields.push('BTC 日 K');
      if (global.totalMarketCapUsd === null || global.totalMarketCapUsd === undefined) missingFields.push('全市场市值');
      dataAsOf = data.candles?.at(-1)?.date ?? null;
      if (String(data.priceProvider ?? '').includes('Gate.io')) selectedProviders.add('Gate.io');
      if (String(data.priceProvider ?? '').includes('CoinGecko') || (global.totalMarketCapUsd !== null && global.totalMarketCapUsd !== undefined)) selectedProviders.add('CoinGecko');
      fallbackActive = String(data.priceProvider ?? '').includes('fallback');
    } else if (definition.id === 'sentiment') {
      if (!data.current) missingFields.push('当前恐贪值');
      dataAsOf = data.current?.date ?? data.rows?.at(-1)?.date ?? null;
      selectedProviders.add('Alternative.me');
    } else if (definition.id === 'onchain') {
      const fieldLabels = { height: '区块高度', feeFast: '下一块费率', feeHour: '约 1 小时费率', mempoolCount: '待确认交易', mempoolSize: '内存池体积' };
      for (const field of ['height', 'feeFast', 'feeHour', 'mempoolCount', 'mempoolSize']) {
        if (data[field] === null || data[field] === undefined) missingFields.push(fieldLabels[field]);
      }
      Object.values(data.sourceByField ?? {}).forEach((provider) => selectedProviders.add(provider));
      fallbackActive = [...selectedProviders].some((provider) => provider !== 'Blockstream');
    } else if (definition.id === 'defi') {
      if (data.totalTvl === null || data.totalTvl === undefined) missingFields.push('全链 TVL');
      if (!Array.isArray(data.stableSeries) || !data.stableSeries.length) missingFields.push('稳定币供给');
      dataAsOf = data.stableSeries?.at(-1)?.date ?? null;
      selectedProviders.add('DefiLlama');
    }
    const sources = (Array.isArray(payload.sources) ? payload.sources : []).map((source) => ({
      ...source,
      fetchedAt: source.updatedAt ?? null,
      selected: selectedProviders.has(source.provider) && source.status !== 'unavailable',
      fields: definition.id === 'onchain'
        ? Object.entries(data.sourceByField ?? {}).filter(([, provider]) => provider === source.provider).map(([field]) => field)
        : [source.role],
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
  const gammaUpdatedAt = gammaPayload.asOf ?? null;
  const gammaUpdatedAtMs = gammaUpdatedAt ? Date.parse(gammaUpdatedAt) : NaN;
  modules.push({
    id: 'gamma',
    label: 'BTC Gamma',
    kind: 'dynamic',
    status: gammaPayload.status === 'live' ? 'live' : 'unavailable',
    fetchedAt: gammaUpdatedAt,
    dataAsOf: gammaUpdatedAt,
    ageSeconds: Number.isFinite(gammaUpdatedAtMs) ? Math.max(0, Math.round((Date.now() - gammaUpdatedAtMs) / 1000)) : null,
    targetSeconds: 15 * 60,
    overdue: Number.isFinite(gammaUpdatedAtMs) ? Date.now() - gammaUpdatedAtMs > 15 * 60 * 1000 : false,
    fallbackActive: false,
    reasonCodes: gammaPayload.status === 'live' ? [] : ['missing_source'],
    missingFields: gammaPayload.status === 'live' ? [] : ['逐合约 Gamma'],
    sources: [{
      provider: 'Bybit',
      role: 'BTC 逐合约 Gamma 与未平仓量',
      url: 'https://bybit-exchange.github.io/docs/v5/market/tickers',
      status: gammaPayload.status === 'live' ? 'live' : 'unavailable',
      updatedAt: gammaUpdatedAt,
      fetchedAt: gammaUpdatedAt,
      selected: gammaPayload.status === 'live',
      fields: ['Gamma', 'OI', 'BTC 标的价格'],
    }],
  });
  const summary = {
    healthy: modules.filter((module) => module.status === 'live' && !module.overdue).length,
    partial: modules.filter((module) => module.status === 'partial').length,
    unavailable: modules.filter((module) => module.status === 'unavailable').length,
    overdue: modules.filter((module) => module.overdue).length,
    cached: modules.filter((module) => module.sources.some((source) => source.status === 'cached' || source.status === 'stale')).length,
  };
  const availableCount = modules.length - summary.unavailable;
  const status = !availableCount ? 'unavailable'
    : summary.partial || summary.unavailable || summary.overdue ? 'partial'
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
      summary: { live: 0, partial: 0, unavailable: 5, stale: 0 },
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
