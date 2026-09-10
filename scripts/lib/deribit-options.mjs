const DERIBIT_BASE_URL = "https://www.deribit.com/api/v2";
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_DAYS_TO_EXPIRY = 6;
const DEFAULT_STRIKE_RANGE_RATIO = 0.25;
const MIN_CONTRACT_COVERAGE = 0.7;
const MIN_OI_COVERAGE = 0.85;
const GAMMA_SCHEMA_VERSION = 2;
const GAMMA_SOURCE = "deribit-inverse-bs-v2-from-mark-iv";
const LAST_GOOD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let instrumentCache = null;

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
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

function normalDensity(value) {
  return Math.exp(-0.5 * value * value) / Math.sqrt(2 * Math.PI);
}

export function deribitIndexFromForward({ forward, years, interestRate }) {
  if (![forward, years, interestRate].every(Number.isFinite) || forward <= 0 || years <= 0) return null;
  const index = forward * Math.exp(-interestRate * years);
  return Number.isFinite(index) && index > 0 ? index : null;
}

export function blackScholesGamma({ forward, strike, volatility, years, interestRate = 0 }) {
  if (![forward, strike, volatility, years, interestRate].every(Number.isFinite)) return null;
  if (forward <= 0 || strike <= 0 || volatility <= 0 || years <= 0) return null;
  const sigmaRootT = volatility * Math.sqrt(years);
  if (!Number.isFinite(sigmaRootT) || sigmaRootT <= 0) return null;
  const index = deribitIndexFromForward({ forward, years, interestRate });
  if (!Number.isFinite(index)) return null;
  const d1 = (Math.log(forward / strike) + 0.5 * volatility ** 2 * years) / sigmaRootT;
  const gamma = normalDensity(d1) / (index * sigmaRootT);
  return Number.isFinite(gamma) && gamma >= 0 ? gamma : null;
}

function payloadTime(payload, fallbackMs) {
  const raw = numberOrNull(payload?.usOut ?? payload?.usIn);
  if (raw === null) return fallbackMs;
  if (raw > 10_000_000_000_000) return raw / 1000;
  if (raw > 10_000_000_000) return raw;
  return fallbackMs;
}

function resultRows(payload, label) {
  if (!payload || payload.jsonrpc !== "2.0" || !Array.isArray(payload.result)) {
    throw new Error(`${label} 返回结构无效`);
  }
  return payload.result;
}

function normalizedInstrument(row) {
  const name = String(row?.instrument_name ?? "").trim();
  const expiryTimestamp = numberOrNull(row?.expiration_timestamp);
  const strike = numberOrNull(row?.strike);
  const optionType = String(row?.option_type ?? "").toLowerCase();
  const instrumentType = String(row?.instrument_type ?? "").toLowerCase();
  if (!name || row?.kind !== "option" || row?.is_active === false) return null;
  if (instrumentType && instrumentType !== "reversed") return null;
  if (String(row?.base_currency ?? "BTC").toUpperCase() !== "BTC") return null;
  if (!Number.isFinite(expiryTimestamp) || !Number.isFinite(strike) || strike <= 0) return null;
  if (!['call', 'put'].includes(optionType)) return null;
  return { name, expiryTimestamp, strike, optionType };
}

function maxPainReference(rows) {
  if (!rows.length) return null;
  const strikes = [...new Set(rows.map((row) => row.strike))].sort((a, b) => a - b);
  let best = null;
  for (const settlement of strikes) {
    const payout = rows.reduce((sum, row) => {
      const intrinsic = row.optionType === "call"
        ? Math.max(0, settlement - row.strike)
        : Math.max(0, row.strike - settlement);
      return sum + intrinsic * row.openInterest;
    }, 0);
    if (!best || payout < best.payout) best = { strike: settlement, payout };
  }
  return best?.strike ?? null;
}

function aggregateGamma(metrics) {
  const byStrike = new Map();
  let callGex = 0;
  let putGex = 0;
  for (const metric of metrics) {
    const unsignedGex = metric.gamma * metric.openInterest * metric.indexPrice ** 2 * 0.01;
    const signedGex = metric.optionType === "call" ? unsignedGex : -unsignedGex;
    const row = byStrike.get(metric.strike) ?? {
      strike: metric.strike,
      callGex: 0,
      putGex: 0,
      netGex: 0,
      callOi: 0,
      putOi: 0,
      contracts: 0,
    };
    if (metric.optionType === "call") {
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
    byStrike.set(metric.strike, row);
  }
  return {
    byStrike: [...byStrike.values()].sort((a, b) => a.strike - b.strike),
    callGex,
    putGex,
    netGex: callGex + putGex,
    grossGex: callGex + Math.abs(putGex),
  };
}

function aggregateOpenInterest(rows, requestedContracts) {
  const knownRows = rows.filter((row) => Number.isFinite(row.openInterest) && row.openInterest >= 0);
  const byStrike = new Map();
  let callOi = 0;
  let putOi = 0;
  for (const row of knownRows) {
    const aggregate = byStrike.get(row.strike) ?? { strike: row.strike, callOi: 0, putOi: 0, contracts: 0 };
    if (row.optionType === "call") {
      aggregate.callOi += row.openInterest;
      callOi += row.openInterest;
    } else {
      aggregate.putOi += row.openInterest;
      putOi += row.openInterest;
    }
    aggregate.contracts += 1;
    byStrike.set(row.strike, aggregate);
  }
  const oiByStrike = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  const wall = (field, total) => {
    if (total <= 0) return null;
    const maximum = Math.max(...oiByStrike.map((row) => row[field]));
    const tiedStrikes = oiByStrike.filter((row) => row[field] === maximum).map((row) => row.strike);
    return { strike: tiedStrikes[0], openInterest: maximum, shareOfSide: maximum / total, tiedStrikes };
  };
  return {
    oiByStrike,
    callOi,
    putOi,
    putCallOiRatio: callOi > 0 ? putOi / callOi : null,
    callWall: wall("callOi", callOi),
    putWall: wall("putOi", putOi),
    maxPain: maxPainReference(knownRows),
    oiStatus: knownRows.length === requestedContracts ? "live" : knownRows.length ? "partial" : "unavailable",
    oiCoverage: {
      ratio: requestedContracts ? knownRows.length / requestedContracts : 0,
      knownContracts: knownRows.length,
      requestedContracts,
      missingContracts: requestedContracts - knownRows.length,
      basis: "所选到期日全部 BTC 反向期权；已知非负 OI 按行权价聚合，不要求 IV 有效，不受 Gamma 的现价上下区间筛选影响。",
    },
    oiMethod: "Call/Put 墙分别是所选到期日已知 Call/Put OI 最大的行权价；并列时主点位取较低价并列出全部并列价。单位 BTC；不表示买卖方向、做市商仓位或必然支撑阻力。",
  };
}

function atTheMoneyIv(rows, { forward, spot, years, expiry, asOf }) {
  if (!Number.isFinite(forward) || forward <= 0 || !rows.length) return null;
  // Select the listed strike first. Missing IV must not silently move the sample to an OTM strike.
  const strikes = [...new Set(rows.map((row) => row.strike))].sort((a, b) => a - b);
  const strike = strikes.reduce((best, candidate) => Math.abs(candidate - forward) < Math.abs(best - forward) ? candidate : best);
  const sideIv = (side) => median(rows.filter((row) => row.strike === strike && row.optionType === side)
    .map((row) => row.markIv).filter((value) => Number.isFinite(value) && value > 0));
  const callIv = sideIv("call");
  const putIv = sideIv("put");
  const observed = [callIv, putIv].filter(Number.isFinite);
  const value = observed.length ? observed.reduce((sum, iv) => sum + iv, 0) / observed.length : null;
  const moveRatio = value === null ? null : value / 100 * Math.sqrt(years);
  const expectedMove = moveRatio !== null && Number.isFinite(spot) && spot > 0 ? {
    moveUsd: spot * moveRatio,
    movePct: moveRatio * 100,
    lower: Math.max(0, spot * (1 - moveRatio)),
    upper: spot * (1 + moveRatio),
    method: "指数代理价 × ATM IV/100 × sqrt(剩余天数/365.25)；简单一标准差幅度近似，不是价格预测或保证的概率区间。",
  } : null;
  return {
    status: observed.length === 2 ? "live" : observed.length ? "partial" : "unavailable",
    value,
    unit: "annualized percent",
    strike,
    callIv,
    putIv,
    moneynessPct: (strike / forward - 1) * 100,
    daysToExpiry: years * 365.25,
    expiry,
    asOf,
    expectedMove,
    method: "距所选到期日远期价最近的已上市行权价；取 Call/Put mark_iv 简单平均，仅一侧可用时标为 partial；未做固定期限插值。",
  };
}

export function computeDeribitGammaSnapshot({ instrumentsPayload, summariesPayload, fetchedAt = Date.now(), minDaysToExpiry = DEFAULT_MIN_DAYS_TO_EXPIRY, strikeRangeRatio = DEFAULT_STRIKE_RANGE_RATIO, expiryTimestamp: selectedExpiryTimestamp = null, includeExpirySnapshots = true, allowGammaUnavailable = false }) {
  const instruments = resultRows(instrumentsPayload, "Deribit instruments")
    .map(normalizedInstrument)
    .filter(Boolean);
  if (!instruments.length) throw new Error("Deribit 没有返回可识别的 BTC 反向期权合约");

  const summaries = resultRows(summariesPayload, "Deribit book summary");
  if (!summaries.length) throw new Error("Deribit 没有返回 BTC 期权市场汇总");
  const apiTime = payloadTime(summariesPayload, fetchedAt);
  const threshold = apiTime + minDaysToExpiry * 24 * 60 * 60 * 1000;
  const availableExpiries = [...new Set(instruments.map((row) => row.expiryTimestamp).filter((value) => value > apiTime))].sort((a, b) => a - b);
  const expiryTimestamp = selectedExpiryTimestamp ?? availableExpiries.find((value) => value >= threshold) ?? null;
  if (expiryTimestamp === null) throw new Error(`Deribit 没有至少 ${minDaysToExpiry} 天后到期的 BTC 期权`);
  if (!availableExpiries.includes(expiryTimestamp)) throw new Error("Deribit 所选到期日不存在或已经到期");

  const years = (expiryTimestamp - apiTime) / YEAR_MS;
  if (!Number.isFinite(years) || years <= 0) throw new Error("Deribit 期权到期时间无效");
  const summaryByName = new Map(summaries.map((row) => [String(row?.instrument_name ?? ""), row]));
  const expiryRows = instruments.filter((row) => row.expiryTimestamp === expiryTimestamp).map((instrument) => {
    const summary = summaryByName.get(instrument.name);
    const forwardPrice = numberOrNull(summary?.underlying_price);
    const interestRate = numberOrNull(summary?.interest_rate);
    return {
      ...instrument,
      summaryPresent: Boolean(summary),
      openInterest: numberOrNull(summary?.open_interest),
      markIv: numberOrNull(summary?.mark_iv),
      forwardPrice,
      interestRate,
      indexPrice: deribitIndexFromForward({ forward: forwardPrice, years, interestRate }),
    };
  });
  let gammaError = expiryRows.some((row) => row.summaryPresent) ? null : "Deribit 所选到期日缺少市场汇总";
  const forward = median(expiryRows.map((row) => row.forwardPrice).filter((value) => Number.isFinite(value) && value > 0));
  const spot = median(expiryRows.map((row) => row.indexPrice).filter((value) => Number.isFinite(value) && value > 0));
  if (!Number.isFinite(spot) || spot <= 0) gammaError ??= "Deribit BTC 期权参考标的价格不可用";

  const minimumStrike = Number.isFinite(spot) ? spot * (1 - strikeRangeRatio) : null;
  const maximumStrike = Number.isFinite(spot) ? spot * (1 + strikeRangeRatio) : null;
  const requestedRows = expiryRows.filter((row) => row.strike >= minimumStrike && row.strike <= maximumStrike);
  const positiveOiRows = requestedRows.filter((row) => Number.isFinite(row.openInterest) && row.openInterest > 0);
  if (!positiveOiRows.length) gammaError ??= "Deribit 现价附近没有带未平仓量的 BTC 期权";

  const metrics = positiveOiRows.flatMap((row) => {
    const volatility = Number.isFinite(row.markIv) ? row.markIv / 100 : null;
    const gamma = blackScholesGamma({
      forward: row.forwardPrice,
      strike: row.strike,
      volatility,
      years,
      interestRate: row.interestRate,
    });
    if (!Number.isFinite(gamma) || !Number.isFinite(row.indexPrice)) return [];
    return [{ ...row, volatility, gamma }];
  });
  const validNames = new Set(metrics.map((row) => row.name));
  const validContracts = requestedRows.filter((row) => row.summaryPresent && (
    row.openInterest === 0 || (Number.isFinite(row.openInterest) && row.openInterest > 0 && validNames.has(row.name))
  )).length;
  const requestedOi = positiveOiRows.reduce((sum, row) => sum + row.openInterest, 0);
  const validOi = metrics.reduce((sum, row) => sum + row.openInterest, 0);
  const contractCoverage = requestedRows.length ? validContracts / requestedRows.length : 0;
  const oiCoverage = requestedOi > 0 ? validOi / requestedOi : 0;
  if (contractCoverage < MIN_CONTRACT_COVERAGE || oiCoverage < MIN_OI_COVERAGE) {
    gammaError ??= `Deribit 模型 Gamma 覆盖不足（合约 ${(contractCoverage * 100).toFixed(1)}%，OI ${(oiCoverage * 100).toFixed(1)}%）`;
  }

  const aggregate = aggregateGamma(metrics);
  if (!aggregate.byStrike.length) gammaError ??= "Deribit 模型 Gamma 聚合结果为空";
  if (gammaError && !allowGammaUnavailable) throw new Error(gammaError);
  const oiStructure = aggregateOpenInterest(expiryRows, expiryRows.length);
  const markIvs = metrics.map((row) => row.markIv).filter(Number.isFinite);
  const missingSummaryContracts = requestedRows.filter((row) => !row.summaryPresent).length;
  const complete = validContracts === requestedRows.length && oiCoverage >= 0.995;

  const expiry = new Date(expiryTimestamp).toISOString().slice(0, 10);
  const asOf = new Date(apiTime).toISOString();
  const snapshot = {
    schemaVersion: GAMMA_SCHEMA_VERSION,
    status: gammaError ? (oiStructure.oiStatus === "unavailable" ? "unavailable" : "partial") : complete && oiStructure.oiStatus === "live" ? "live" : "partial",
    gammaStatus: gammaError ? "unavailable" : complete ? "live" : "partial",
    gammaError,
    symbol: "BTC",
    venue: "Deribit",
    source: "Deribit 官方公开 instruments 与 book summary",
    sourceHost: DERIBIT_BASE_URL,
    sourceUrls: {
      instruments: `${DERIBIT_BASE_URL}/public/get_instruments?currency=BTC&kind=option&expired=false`,
      summaries: `${DERIBIT_BASE_URL}/public/get_book_summary_by_currency?currency=BTC&kind=option`,
    },
    fetchedAt: new Date(fetchedAt).toISOString(),
    asOf,
    lastSuccessAt: gammaError ? null : asOf,
    spot,
    forward,
    expiry,
    expiryTimestamp,
    daysToExpiry: years * 365.25,
    strikeRange: { minimum: minimumStrike, maximum: maximumStrike },
    gammaSource: GAMMA_SOURCE,
    referencePriceType: "Deribit index proxy = underlying_price × exp(-interest_rate × T)",
    formula: "Deribit inverse Black-Scholes gamma(mark IV, forward) × OI(BTC) × index² × 0.01",
    unit: "USD per 1% BTC move",
    signConvention: "Call 为正、Put 为负；公开 OI 代理不代表做市商真实净持仓。",
    contractMultiplierApplied: false,
    coverage: contractCoverage,
    coverageDetail: {
      ratio: contractCoverage,
      validContracts,
      requestedContracts: requestedRows.length,
      modeledContracts: metrics.length,
      missingSummaryContracts,
      oiRatio: oiCoverage,
      validOpenInterest: validOi,
      requestedOpenInterest: requestedOi,
      basis: `指数代理价上下 ${strikeRangeRatio * 100}% 内，以 instruments 合约全集为分母；零 OI 合约只需完整 summary，正 OI 合约须具备标记 IV、利率与到期远期价`,
    },
    ...oiStructure,
    atmIv: atTheMoneyIv(expiryRows, { forward, spot, years, expiry, asOf }),
    medianMarkIv: median(markIvs),
    byStrike: gammaError ? [] : aggregate.byStrike,
    callGex: gammaError ? null : aggregate.callGex,
    putGex: gammaError ? null : aggregate.putGex,
    netGex: gammaError ? null : aggregate.netGex,
    grossGex: gammaError ? null : aggregate.grossGex,
  };
  if (includeExpirySnapshots) {
    const expirySnapshots = availableExpiries.map((timestamp) => timestamp === expiryTimestamp ? { ...snapshot } : computeDeribitGammaSnapshot({
      instrumentsPayload,
      summariesPayload,
      fetchedAt,
      minDaysToExpiry,
      strikeRangeRatio,
      expiryTimestamp: timestamp,
      includeExpirySnapshots: false,
      allowGammaUnavailable: true,
    }));
    snapshot.expirySnapshots = expirySnapshots;
    snapshot.expiries = expirySnapshots.map((sample) => ({
      expiry: sample.expiry,
      expiryTimestamp: sample.expiryTimestamp,
      daysToExpiry: sample.daysToExpiry,
      status: sample.status,
      gammaStatus: sample.gammaStatus,
      oiStatus: sample.oiStatus,
      atmIvStatus: sample.atmIv?.status ?? "unavailable",
      isDefault: sample.expiryTimestamp === expiryTimestamp,
    }));
    snapshot.expirySelectionMethod = `默认使用至少 ${minDaysToExpiry} 天后最近到期日；可切换本次 instruments 返回的全部未到期合约，不静默跨到期日替代。`;
  }
  return snapshot;
}

async function fetchJsonRpc(url, fetchImpl, timeoutMs) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "btc-capital-pulse/1.0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Deribit HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.error) throw new Error(`Deribit JSON-RPC ${payload.error.code ?? "error"}`);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw lastError ?? new Error("Deribit 请求失败");
}

async function fetchInstruments(fetchImpl, timeoutMs, now) {
  if (instrumentCache && instrumentCache.expiresAt > now) return instrumentCache.payload;
  const url = `${DERIBIT_BASE_URL}/public/get_instruments?currency=BTC&kind=option&expired=false`;
  const payload = await fetchJsonRpc(url, fetchImpl, timeoutMs);
  resultRows(payload, "Deribit instruments");
  instrumentCache = { payload, expiresAt: now + 60 * 60 * 1000 };
  return payload;
}

export async function fetchDeribitGamma({ fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now() } = {}) {
  const [instrumentsPayload, summariesPayload] = await Promise.all([
    fetchInstruments(fetchImpl, timeoutMs, now),
    fetchJsonRpc(`${DERIBIT_BASE_URL}/public/get_book_summary_by_currency?currency=BTC&kind=option`, fetchImpl, timeoutMs),
  ]);
  const snapshot = computeDeribitGammaSnapshot({ instrumentsPayload, summariesPayload, fetchedAt: now, allowGammaUnavailable: true });
  // A model failure must not discard independently observed OI. No-data failures still use the server's last-good fallback.
  if (snapshot.status === "unavailable") throw new Error(snapshot.gammaError || "Deribit 所选到期日缺少可用市场数据");
  return snapshot;
}

export function isUsableGammaPayload(payload, { now = Date.now(), maxAgeMs = LAST_GOOD_MAX_AGE_MS } = {}) {
  const successTime = Date.parse(payload?.lastSuccessAt || payload?.asOf || "");
  const ageMs = Number.isFinite(successTime) ? now - successTime : NaN;
  return Boolean(
    payload
    && payload.schemaVersion === GAMMA_SCHEMA_VERSION
    && payload.venue === "Deribit"
    && payload.gammaSource === GAMMA_SOURCE
    && ["live", "partial"].includes(payload.status)
    && Array.isArray(payload.byStrike)
    && payload.byStrike.length
    && Number.isFinite(Number(payload.spot))
    && Number.isFinite(Number(payload.netGex))
    && Number.isFinite(ageMs)
    && ageMs >= -5 * 60 * 1000
    && ageMs <= maxAgeMs
  );
}
