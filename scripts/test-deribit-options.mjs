import assert from "node:assert/strict";
import {
  blackScholesGamma,
  computeDeribitGammaSnapshot,
  deribitIndexFromForward,
  isUsableGammaPayload,
} from "./lib/deribit-options.mjs";

const fetchedAt = Date.UTC(2026, 7, 24, 8);
const expiry = Date.UTC(2026, 8, 4, 8);
const years = (expiry - fetchedAt) / (365.25 * 86400000);
const definitions = [
  ["BTC-4SEP26-70000-C", 70_000, "call", 120, 56],
  ["BTC-4SEP26-70000-P", 70_000, "put", 80, 57],
  ["BTC-4SEP26-80000-C", 80_000, "call", 150, 58],
  ["BTC-4SEP26-80000-P", 80_000, "put", 210, 59],
];

function instrumentsFor(rows = definitions, expirationTimestamp = expiry) {
  return {
    jsonrpc: "2.0",
    result: rows.map(([instrument_name, strike, option_type]) => ({
      instrument_name,
      strike,
      option_type,
      kind: "option",
      is_active: true,
      instrument_type: "reversed",
      base_currency: "BTC",
      expiration_timestamp: expirationTimestamp,
    })),
  };
}

function summariesFor(rows = definitions) {
  return {
    jsonrpc: "2.0",
    usOut: fetchedAt * 1000,
    result: rows.map(([instrument_name, , , open_interest, mark_iv]) => ({
      instrument_name,
      open_interest,
      mark_iv,
      underlying_price: 77_500,
      interest_rate: 0.01,
    })),
  };
}

const instrumentsPayload = instrumentsFor();
const summariesPayload = summariesFor();
const index = deribitIndexFromForward({ forward: 77_500, years, interestRate: 0.01 });
const sigma = 0.58;
const sigmaRootT = sigma * Math.sqrt(years);
const d1 = (Math.log(77_500 / 80_000) + 0.5 * sigma ** 2 * years) / sigmaRootT;
const expectedGamma = Math.exp(-0.5 * d1 ** 2) / Math.sqrt(2 * Math.PI) / (index * sigmaRootT);
const gamma = blackScholesGamma({ forward: 77_500, strike: 80_000, volatility: sigma, years, interestRate: 0.01 });
assert.ok(Number.isFinite(gamma) && gamma > 0, "Deribit 反向期权 Gamma 应为正数");
assert.ok(Math.abs(gamma - expectedGamma) < 1e-15, "Gamma 应使用到期远期价推导指数价，不能重复计入 carry");

const snapshot = computeDeribitGammaSnapshot({ instrumentsPayload, summariesPayload, fetchedAt });
assert.equal(snapshot.schemaVersion, 2);
assert.equal(snapshot.venue, "Deribit");
assert.equal(snapshot.status, "live");
assert.equal(snapshot.gammaSource, "deribit-inverse-bs-v2-from-mark-iv");
assert.ok(Math.abs(snapshot.spot - index) < 1e-9);
assert.equal(snapshot.forward, 77_500);
assert.equal(snapshot.byStrike.length, 2);
assert.equal(snapshot.callOi, 270);
assert.equal(snapshot.putOi, 290);
assert.ok(Math.abs(snapshot.putCallOiRatio - 290 / 270) < 1e-12);
assert.ok([70_000, 80_000].includes(snapshot.maxPain));
assert.ok(snapshot.callGex > 0 && snapshot.putGex < 0);
assert.ok(isUsableGammaPayload(snapshot, { now: fetchedAt + 60_000 }));

const partial = computeDeribitGammaSnapshot({
  instrumentsPayload,
  summariesPayload: summariesFor(definitions.slice(0, 3)),
  fetchedAt,
});
assert.equal(partial.status, "partial");
assert.equal(partial.coverageDetail.requestedContracts, 4, "覆盖率分母必须来自 instruments 合约全集");
assert.equal(partial.coverageDetail.validContracts, 3);
assert.equal(partial.coverageDetail.missingSummaryContracts, 1);
assert.equal(partial.coverage, 0.75);

const laterExpiry = Date.UTC(2026, 8, 11, 8);
const twoExpiries = {
  jsonrpc: "2.0",
  result: [
    ...instrumentsFor(definitions, expiry).result,
    ...instrumentsFor([["BTC-11SEP26-80000-C", 80_000, "call", 10, 55]], laterExpiry).result,
  ],
};
assert.throws(() => computeDeribitGammaSnapshot({
  instrumentsPayload: twoExpiries,
  summariesPayload: summariesFor([["BTC-11SEP26-80000-C", 80_000, "call", 10, 55]]),
  fetchedAt,
}), /所选到期日缺少市场汇总/, "不得因最近到期日缺 summary 而静默跳到更远到期日");

assert.equal(isUsableGammaPayload({ ...snapshot, schemaVersion: 1 }, { now: fetchedAt + 60_000 }), false);
assert.equal(isUsableGammaPayload({ ...snapshot, venue: "legacy" }, { now: fetchedAt + 60_000 }), false);
assert.equal(isUsableGammaPayload({ ...snapshot, gammaSource: "old-formula" }, { now: fetchedAt + 60_000 }), false);
assert.equal(isUsableGammaPayload(snapshot, { now: fetchedAt + 25 * 60 * 60 * 1000 }), false, "超过 24 小时的 last-good 必须拒绝");

process.stdout.write("Deribit 期权公式、覆盖率与缓存版本校验通过。\n");
