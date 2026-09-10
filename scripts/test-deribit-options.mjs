import assert from "node:assert/strict";
import {
  blackScholesGamma,
  computeDeribitGammaSnapshot,
  deribitIndexFromForward,
  fetchDeribitGamma,
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
assert.equal(snapshot.callWall.strike, 80_000);
assert.equal(snapshot.callWall.openInterest, 150);
assert.equal(snapshot.putWall.strike, 80_000);
assert.equal(snapshot.putWall.openInterest, 210);
assert.equal(snapshot.callWall.shareOfSide, 150 / 270);
assert.equal(snapshot.oiByStrike.length, 2);
assert.equal(snapshot.oiCoverage.ratio, 1);
assert.equal(snapshot.atmIv.strike, 80_000);
assert.equal(snapshot.atmIv.value, 58.5);
assert.equal(snapshot.atmIv.daysToExpiry, 11);
assert.equal(snapshot.atmIv.status, "live");
assert.ok(Math.abs(snapshot.atmIv.expectedMove.moveUsd - index * 0.585 * Math.sqrt(years)) < 1e-9);
assert.equal(snapshot.expiries.length, 1);
assert.equal(snapshot.expiries[0].isDefault, true);
assert.equal(snapshot.expirySnapshots[0].expiry, snapshot.expiry);
assert.equal(snapshot.expirySnapshots[0].expirySnapshots, undefined, "到期日样本不能递归嵌套");

const fullOiDefinitions = [
  ...definitions,
  ["BTC-4SEP26-120000-C", 120_000, "call", 1_000, null],
  ["BTC-4SEP26-30000-P", 30_000, "put", 3_000, null],
  ["BTC-4SEP26-75000-C", 75_000, "call", 10, null],
];
const fullOiSnapshot = computeDeribitGammaSnapshot({
  instrumentsPayload: instrumentsFor(fullOiDefinitions),
  summariesPayload: summariesFor(fullOiDefinitions),
  fetchedAt,
});
assert.equal(fullOiSnapshot.callWall.strike, 120_000, "Call 墙必须使用全部已知 OI，不限于 Gamma 价区或有 IV 的合约");
assert.equal(fullOiSnapshot.putWall.strike, 30_000, "Put 墙必须使用全部已知 OI，不限于 Gamma 价区或有 IV 的合约");
assert.equal(fullOiSnapshot.oiByStrike.find((row) => row.strike === 75_000).callOi, 10, "区间内无 IV 的 OI 也必须保留");
assert.equal(fullOiSnapshot.byStrike.find((row) => row.strike === 75_000), undefined);
assert.equal(fullOiSnapshot.byStrike.length, 2);
assert.equal(fullOiSnapshot.callOi, 1_280);
assert.equal(fullOiSnapshot.putOi, 3_290);
assert.equal(fullOiSnapshot.oiCoverage.ratio, 1);
assert.equal(fullOiSnapshot.status, "partial");
const missingOutsideGamma = computeDeribitGammaSnapshot({
  instrumentsPayload: instrumentsFor([...definitions, fullOiDefinitions[4]]),
  summariesPayload,
  fetchedAt,
});
assert.equal(missingOutsideGamma.gammaStatus, "live");
assert.equal(missingOutsideGamma.oiStatus, "partial");
assert.equal(missingOutsideGamma.status, "partial", "Gamma 区间完整不能掩盖全行权价 OI 样本缺失");

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
assert.equal(partial.oiStatus, "partial");
assert.equal(partial.oiCoverage.missingContracts, 1, "缺失 OI 不能当作零持仓");

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

const nearExpiry = fetchedAt + 86400000;
const nearDefinitions = [["BTC-25AUG26-80000-C", 80_000, "call", 20, 50]];
const laterDefinitions = [
  ["BTC-11SEP26-80000-C", 80_000, "call", 50, null],
  ["BTC-11SEP26-80000-P", 80_000, "put", 40, null],
];
const multipleSnapshot = computeDeribitGammaSnapshot({
  instrumentsPayload: {
    jsonrpc: "2.0",
    result: [...instrumentsFor(nearDefinitions, nearExpiry).result, ...instrumentsPayload.result, ...instrumentsFor(laterDefinitions, laterExpiry).result],
  },
  summariesPayload: summariesFor([...nearDefinitions, ...definitions, ...laterDefinitions]),
  fetchedAt,
});
assert.deepEqual(multipleSnapshot.expiries.map((row) => row.expiry), ["2026-08-25", "2026-09-04", "2026-09-11"]);
assert.equal(multipleSnapshot.expiry, "2026-09-04", "默认仍使用至少六天后的最近期限");
assert.deepEqual(multipleSnapshot.expiries.map((row) => row.isDefault), [false, true, false]);
const laterSample = multipleSnapshot.expirySnapshots.at(-1);
assert.equal(laterSample.gammaStatus, "unavailable", "单一期限 Gamma 失效不得污染其他期限");
assert.equal(laterSample.netGex, null, "不可用 Gamma 不能给出虚假的零值");
assert.deepEqual(laterSample.byStrike, []);
assert.equal(laterSample.oiStatus, "live");
assert.equal(laterSample.callWall.openInterest, 50, "Gamma 不可用时仍应保留独立的完整 OI 样本");
assert.equal(laterSample.atmIv.status, "unavailable");
assert.equal(laterSample.atmIv.value, null);
assert.equal(laterSample.atmIv.expectedMove, null);

const missingAtmIv = definitions.map((row) => row[0] === "BTC-4SEP26-80000-C" ? [...row.slice(0, 4), null] : row);
assert.throws(() => computeDeribitGammaSnapshot({ instrumentsPayload, summariesPayload: summariesFor(missingAtmIv), fetchedAt }), /覆盖不足/);
const oiOnlySnapshot = computeDeribitGammaSnapshot({
  instrumentsPayload,
  summariesPayload: summariesFor(missingAtmIv),
  fetchedAt,
  allowGammaUnavailable: true,
});
assert.equal(oiOnlySnapshot.oiStatus, "live");
assert.equal(oiOnlySnapshot.gammaStatus, "unavailable");
assert.equal(oiOnlySnapshot.status, "partial", "可用的 OI 独立于不可用的 Gamma，整体状态应为部分可用");
assert.equal(oiOnlySnapshot.atmIv.strike, 80_000, "ATM 必须先选最近远期价的已上市行权价，不能因 IV 缺失而偷偷换点");
assert.equal(oiOnlySnapshot.atmIv.value, 59);
assert.equal(oiOnlySnapshot.atmIv.status, "partial");
assert.equal(oiOnlySnapshot.lastSuccessAt, null);
assert.equal(isUsableGammaPayload(oiOnlySnapshot, { now: fetchedAt + 60_000 }), false);
const fetchedOiOnly = await fetchDeribitGamma({
  now: fetchedAt,
  fetchImpl: async (url) => ({ ok: true, json: async () => url.includes("get_instruments") ? instrumentsPayload : summariesFor(missingAtmIv) }),
});
assert.equal(fetchedOiOnly.status, "partial", "公开接口仍有 OI 时，Gamma 模型故障不应丢弃新鲜持仓数据");
assert.equal(fetchedOiOnly.callWall.strike, 80_000);
assert.equal(fetchedOiOnly.gammaStatus, "unavailable");

const tiedRows = [
  ["BTC-4SEP26-70000-C", 70_000, "call", 100, 50],
  ["BTC-4SEP26-80000-C", 80_000, "call", 100, 50],
  ["BTC-4SEP26-80000-P", 80_000, "put", 0, 50],
];
const tiedSnapshot = computeDeribitGammaSnapshot({ instrumentsPayload: instrumentsFor(tiedRows), summariesPayload: summariesFor(tiedRows), fetchedAt });
assert.equal(tiedSnapshot.callWall.strike, 70_000);
assert.deepEqual(tiedSnapshot.callWall.tiedStrikes, [70_000, 80_000]);
assert.equal(tiedSnapshot.putWall, null, "一侧总 OI 为零时不能画出该侧持仓墙");
assert.throws(() => computeDeribitGammaSnapshot({ instrumentsPayload, summariesPayload, fetchedAt, expiryTimestamp: fetchedAt - 1 }), /已经到期/);

assert.equal(isUsableGammaPayload({ ...snapshot, schemaVersion: 1 }, { now: fetchedAt + 60_000 }), false);
assert.equal(isUsableGammaPayload({ ...snapshot, venue: "legacy" }, { now: fetchedAt + 60_000 }), false);
assert.equal(isUsableGammaPayload({ ...snapshot, gammaSource: "old-formula" }, { now: fetchedAt + 60_000 }), false);
assert.equal(isUsableGammaPayload(snapshot, { now: fetchedAt + 25 * 60 * 60 * 1000 }), false, "超过 24 小时的 last-good 必须拒绝");

process.stdout.write("Deribit 期权公式、独立 OI 墙、ATM IV、到期日样本、覆盖率与缓存版本校验通过。\n");
