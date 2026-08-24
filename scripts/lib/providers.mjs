import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { aggregateMonthly } from "./static-data.mjs";

const FARSIDE_BTC_URL = "https://farside.co.uk/bitcoin-etf-flow-all-data/";
const FARSIDE_ETH_URL = "https://farside.co.uk/ethereum-etf-flow-all-data/";
const SOSO_FLOW_URL = "https://api.sosovalue.xyz/openapi/v2/etf/historicalInflowChart";
const SOSO_DOC_URL = "https://sosovalue.gitbook.io/soso-value-api-doc/api-document/get-etf-historical-inflow-chart";
const GATE_CANDLES_URL = "https://api.gateio.ws/api/v4/spot/candlesticks";
const DAY_SECONDS = 86_400;

function decodeHtml(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    minus: "−",
    quot: "\"",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const parsed = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function cellText(html) {
  return decodeHtml(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validUtcDate(year, month, day) {
  const stamp = Date.UTC(year, month - 1, day);
  const date = new Date(stamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function parseFarsideDate(input) {
  const value = input.replace(/[†‡*]+/g, "").trim();
  let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return validUtcDate(Number(match[1]), Number(match[2]), Number(match[3]));

  const months = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };

  match = value.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i);
  if (match && months[match[2].toLowerCase()]) {
    return validUtcDate(Number(match[3]), months[match[2].toLowerCase()], Number(match[1]));
  }
  match = value.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (match && months[match[1].toLowerCase()]) {
    return validUtcDate(Number(match[3]), months[match[1].toLowerCase()], Number(match[2]));
  }
  match = value.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (match) return validUtcDate(Number(match[3]), Number(match[2]), Number(match[1]));
  return null;
}

function parseFarsideTotal(input) {
  let value = input.trim().replace(/[†‡*]+$/g, "").trim().replace(/−/g, "-");
  if (/^(?:|[-–—−]|n\/?a)$/i.test(value)) return 0;
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  value = value.replace(/[,$£€\s]/g, "");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

function parseTableRows(tableHtml) {
  const rows = [];
  for (const rowMatch of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)) {
      cells.push(cellText(cellMatch[1]));
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

export function parseFarsideHtml(html, label = "Farside") {
  if (typeof html !== "string" || html.length < 200) {
    throw new Error(`${label} HTML 内容过短，拒绝把它当作完整数据表`);
  }
  if (/cf-chl-|just a moment|attention required|error code:\s*1010|cloudflare ray id/i.test(html)) {
    throw new Error(`${label} 返回 Cloudflare 验证页，不能解析为数据；请保存完整网页 HTML 后使用本地 HTML 参数`);
  }

  const candidates = [];
  for (const tableMatch of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = parseTableRows(tableMatch[1]);
    let headerIndex = -1;
    let dateIndex = -1;
    let totalIndex = -1;
    for (let index = 0; index < rows.length; index += 1) {
      const normalized = rows[index].map((value) => value.toLowerCase().replace(/[^a-z]/g, ""));
      const possibleDate = normalized.findIndex((value) => value === "date" || value.endsWith("date"));
      const possibleTotal = normalized.findLastIndex((value) => value === "total" || value.endsWith("total"));
      if (possibleDate >= 0 && possibleTotal >= 0 && possibleDate !== possibleTotal) {
        headerIndex = index;
        dateIndex = possibleDate;
        totalIndex = possibleTotal;
        break;
      }
    }
    if (headerIndex < 0) continue;

    const parsed = [];
    for (const cells of rows.slice(headerIndex + 1)) {
      if (cells.length <= Math.max(dateIndex, totalIndex)) continue;
      const date = parseFarsideDate(cells[dateIndex]);
      const total = parseFarsideTotal(cells[totalIndex]);
      if (date && total !== null) parsed.push([date, total]);
    }
    if (parsed.length) candidates.push(parsed);
  }

  if (candidates.length === 0) {
    throw new Error(`${label} 中未找到同时包含 Date 和 Total 的可解析表格`);
  }
  candidates.sort((a, b) => b.length - a.length);
  const selected = candidates[0];
  if (selected.length < 10) {
    throw new Error(`${label} 只解析到 ${selected.length} 行，低于完整表安全阈值 10 行`);
  }

  const byDate = new Map();
  for (const [date, value] of selected) {
    if (byDate.has(date)) throw new Error(`${label} 出现重复日期 ${date}`);
    byDate.set(date, value);
  }
  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function assertFullHistorySafe(existing, incoming, label) {
  if (!Array.isArray(existing) || existing.length === 0) return;
  if (incoming.length < existing.length) {
    throw new Error(`${label} 新表只有 ${incoming.length} 行，少于现有 ${existing.length} 行，拒绝覆盖历史`);
  }
  if (incoming[0][0] > existing[0][0]) {
    throw new Error(`${label} 新表首日 ${incoming[0][0]} 晚于现有首日 ${existing[0][0]}，疑似截断`);
  }
  if (incoming.at(-1)[0] < existing.at(-1)[0]) {
    throw new Error(`${label} 新表末日 ${incoming.at(-1)[0]} 早于现有末日 ${existing.at(-1)[0]}，疑似滞后`);
  }
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))];
}

function assertOverlapCompatible(existing, incoming, label) {
  if (!Array.isArray(existing) || existing.length < 10) return;
  const existingByDate = new Map(existing.map((row) => [row[0], Number(row[1])]));
  const differences = incoming
    .filter((row) => existingByDate.has(row[0]))
    .map((row) => Math.abs(Number(row[1]) - existingByDate.get(row[0])));
  if (differences.length < 10) return;
  const medianDifference = percentile(differences, 0.5);
  const p95Difference = percentile(differences, 0.95);
  if (medianDifference > 2 || p95Difference > 30) {
    throw new Error(
      `${label} 与现有已核验数据差异过大（中位差 ${round1(medianDifference)}、P95 ${round1(p95Difference)} 百万美元），拒绝自动切换来源`,
    );
  }
}

function mergeDailyRows(existing, incoming) {
  const merged = new Map((Array.isArray(existing) ? existing : []).map((row) => [row[0], row]));
  for (const row of incoming) merged.set(row[0], row);
  return [...merged.values()].sort((a, b) => a[0].localeCompare(b[0]));
}

function mergeMonthlyCoverage(existing, dailyRows, firstIncomingDate) {
  const firstIncomingMonth = firstIncomingDate.slice(0, 7);
  const merged = new Map(
    (Array.isArray(existing) ? existing : [])
      .filter(([month]) => month <= firstIncomingMonth)
      .map((row) => [row[0], row]),
  );
  for (const row of aggregateMonthly(dailyRows)) {
    if (row[0] > firstIncomingMonth) merged.set(row[0], row);
  }
  return [...merged.values()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function fetchSosoRows(type, label) {
  let response;
  try {
    const headers = { accept: "application/json", "content-type": "application/json" };
    if (process.env.SOSO_API_KEY) headers["x-soso-api-key"] = process.env.SOSO_API_KEY;
    response = await fetch(SOSO_FLOW_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ type }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`${label} 请求失败: ${error.message}`);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 180)}`);

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} 返回无效 JSON: ${error.message}`);
  }
  const list = Array.isArray(payload?.data) ? payload.data : payload?.data?.list;
  if (payload?.code !== 0 || !Array.isArray(list) || list.length < 200) {
    throw new Error(`${label} 历史不足：期望至少 200 个交易日，实际 ${Array.isArray(list) ? list.length : 0}`);
  }

  const byDate = new Map();
  for (const [index, item] of list.entries()) {
    const date = String(item?.date ?? "");
    const usd = Number(item?.totalNetInflow);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
      throw new Error(`${label} data[${index}].date 无效`);
    }
    if (!Number.isFinite(usd) || Math.abs(usd) > 5_000_000_000) {
      throw new Error(`${label} data[${index}].totalNetInflow 无效或超出安全范围`);
    }
    if (byDate.has(date)) throw new Error(`${label} 出现重复日期 ${date}`);
    byDate.set(date, round1(usd / 1_000_000));
  }
  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function readFarsideHtml({ localPath, url, label }) {
  if (localPath) {
    const resolved = path.resolve(localPath);
    return { html: await readFile(resolved, "utf8"), source: resolved };
  }

  let response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (compatible; BTC-Capital-Pulse-Data-Updater/1.0)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`${label} 请求失败: ${error.message}`);
  }
  const html = await response.text();
  if (!response.ok) {
    const cloudflare = /cloudflare|error code:\s*1010|cf-ray/i.test(html);
    throw new Error(
      `${label} HTTP ${response.status}${cloudflare ? "（Cloudflare 拦截）" : ""}；` +
        "请在浏览器保存完整网页 HTML，再传给对应的 --farside-*-html 参数",
    );
  }
  return { html, source: url };
}

export async function updateEtfData(data, options = {}) {
  const requestedSource = String(options.source ?? "auto").toLowerCase();
  const hasLocalHtml = Boolean(options.btcHtml || options.ethHtml);
  if (hasLocalHtml && !(options.btcHtml && options.ethHtml)) {
    throw new Error("使用本地 Farside HTML 时必须同时提供 BTC 与 ETH 两份完整网页");
  }
  if (!new Set(["auto", "farside", "sosovalue"]).has(requestedSource)) {
    throw new Error(`不支持的 ETF 来源 ${requestedSource}`);
  }

  let farsideError = null;
  if (requestedSource !== "sosovalue") {
    try {
      const [btcInput, ethInput] = await Promise.all([
        readFarsideHtml({ localPath: options.btcHtml, url: FARSIDE_BTC_URL, label: "Farside BTC ETF" }),
        readFarsideHtml({ localPath: options.ethHtml, url: FARSIDE_ETH_URL, label: "Farside ETH ETF" }),
      ]);
      const btcRows = parseFarsideHtml(btcInput.html, "Farside BTC ETF");
      const ethRows = parseFarsideHtml(ethInput.html, "Farside ETH ETF");
      assertFullHistorySafe(data.btcFlows, btcRows, "Farside BTC ETF");
      assertFullHistorySafe(data.ethFlows, ethRows, "Farside ETH ETF");
      const btcAsOf = btcRows.at(-1)[0];
      const ethAsOf = ethRows.at(-1)[0];

      data.btcFlows = btcRows;
      data.ethFlows = ethRows;
      data.btcMonthlyFlows = aggregateMonthly(btcRows);
      data.sources.etfFlows = {
        provider: "Farside Investors",
        url: FARSIDE_BTC_URL,
        asOf: btcAsOf,
        mode: "Bitcoin ETF Flow 表 Total 列完整历史；括号为负，横线为 0",
      };
      data.sources.ethEtfFlows = {
        provider: "Farside Investors",
        url: FARSIDE_ETH_URL,
        asOf: ethAsOf,
        mode: "Ethereum ETF Flow 表 Total 列完整历史；括号为负，横线为 0",
      };
      data.note =
        "ETF 日值与月度汇总来自 Farside 表 Total 列；自动更新会拒绝截断历史。Farside 不可达时才切换到经过重叠校验的 SoSoValue 公开接口。";
      return {
        provider: "Farside Investors",
        completeHistory: true,
        fallback: false,
        btcRows: btcRows.length,
        ethRows: ethRows.length,
        btcAsOf,
        ethAsOf,
        inputs: [btcInput.source, ethInput.source],
      };
    } catch (error) {
      farsideError = error;
      if (requestedSource === "farside" || hasLocalHtml) throw error;
    }
  }

  const [incomingBtc, incomingEth] = await Promise.all([
    fetchSosoRows("us-btc-spot", "SoSoValue BTC ETF"),
    fetchSosoRows("us-eth-spot", "SoSoValue ETH ETF"),
  ]);
  if (incomingBtc.at(-1)[0] < data.btcFlows.at(-1)[0]) {
    throw new Error(`SoSoValue BTC 最新日期 ${incomingBtc.at(-1)[0]} 早于现有 ${data.btcFlows.at(-1)[0]}`);
  }
  if (incomingEth.at(-1)[0] < data.ethFlows.at(-1)[0]) {
    throw new Error(`SoSoValue ETH 最新日期 ${incomingEth.at(-1)[0]} 早于现有 ${data.ethFlows.at(-1)[0]}`);
  }
  assertOverlapCompatible(data.btcFlows, incomingBtc, "SoSoValue BTC ETF");
  assertOverlapCompatible(data.ethFlows, incomingEth, "SoSoValue ETH ETF");

  const btcRows = mergeDailyRows(data.btcFlows, incomingBtc);
  const ethRows = mergeDailyRows(data.ethFlows, incomingEth);
  const btcAsOf = btcRows.at(-1)[0];
  const ethAsOf = ethRows.at(-1)[0];
  data.btcFlows = btcRows;
  data.ethFlows = ethRows;
  data.btcMonthlyFlows = mergeMonthlyCoverage(
    data.btcMonthlyFlows,
    btcRows,
    incomingBtc[0][0],
  );
  data.sources.etfFlows = {
    provider: "SoSoValue OpenAPI",
    url: SOSO_DOC_URL,
    asOf: btcAsOf,
    mode: "美国现货 BTC ETF totalNetInflow，USD 换算为百万美元；每次取 300 个交易日并与本地历史合并",
    fallbackFor: "Farside Investors",
  };
  data.sources.ethEtfFlows = {
    provider: "SoSoValue OpenAPI",
    url: SOSO_DOC_URL,
    asOf: ethAsOf,
    mode: "美国现货 ETH ETF totalNetInflow，USD 换算为百万美元；每次取 300 个交易日并与本地历史合并",
    fallbackFor: "Farside Investors",
  };
  data.note =
    "ETF 日值当前由 SoSoValue V2 公开接口提供，并与既有 Farside 区间做中位差与 P95 差异校验；本地会持续保留滚动窗口以外的已验证历史，不依赖 KZG Flow。";

  return {
    provider: "SoSoValue OpenAPI",
    completeHistory: false,
    fallback: Boolean(farsideError),
    fallbackReason: farsideError?.message ?? null,
    btcRows: btcRows.length,
    ethRows: ethRows.length,
    btcAsOf,
    ethAsOf,
    inputs: [SOSO_FLOW_URL],
  };
}

function parseNonNegativeInteger(value, field, index) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`Longbridge stats[${index}].${field} 缺失或不是非负整数`);
  }
  return number;
}

function timestampToDay(value, index) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Longbridge stats[${index}].timestamp 缺失或无效`);
  }
  return new Date(seconds * 1_000).toISOString().slice(0, 10);
}

export function parseLongbridgeIbitJson(output) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch (error) {
    throw new Error(`Longbridge CLI 未返回有效 JSON: ${error.message}`);
  }
  if (!payload || !Array.isArray(payload.stats) || payload.stats.length === 0) {
    throw new Error("Longbridge CLI 输出缺少非空 stats 数组");
  }

  const rows = payload.stats.map((row, index) => {
    if (!row || typeof row !== "object") throw new Error(`Longbridge stats[${index}] 不是对象`);
    const date = timestampToDay(row.timestamp, index);
    const callVolume = parseNonNegativeInteger(row.total_call_volume, "total_call_volume", index);
    const putVolume = parseNonNegativeInteger(row.total_put_volume, "total_put_volume", index);
    const openInterest = parseNonNegativeInteger(row.total_open_interest, "total_open_interest", index);
    const reportedRatio = Number(row.put_call_volume_ratio);
    if (!Number.isFinite(reportedRatio) || reportedRatio < 0) {
      throw new Error(`Longbridge stats[${index}].put_call_volume_ratio 缺失或无效`);
    }
    if (callVolume === 0) {
      throw new Error(`Longbridge stats[${index}] call volume 为 0，无法生成有限 Put/Call 比率`);
    }
    const calculatedRatio = putVolume / callVolume;
    if (Math.abs(calculatedRatio - reportedRatio) > 0.001) {
      throw new Error(`Longbridge stats[${index}] Put/Call 比率与成交量字段不一致`);
    }
    return [date, callVolume, putVolume, Math.round(calculatedRatio * 1_000) / 1_000, openInterest];
  });

  rows.sort((a, b) => a[0].localeCompare(b[0]));
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row[0])) throw new Error(`Longbridge CLI 输出包含重复交易日 ${row[0]}`);
    seen.add(row[0]);
  }
  return rows;
}

export function updateIbitData(data, options = {}) {
  const count = options.count || 90;
  const result = spawnSync(
    options.longbridgeBin || "longbridge",
    ["option", "volume", "daily", "IBIT.US", "--count", String(count), "--format", "json"],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw new Error(`无法运行 Longbridge CLI: ${result.error.message}；旧 IBIT 数据不会被修改`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "无错误详情").trim();
    throw new Error(`Longbridge CLI 退出码 ${result.status}: ${detail}；旧 IBIT 数据不会被修改`);
  }

  const incoming = parseLongbridgeIbitJson(result.stdout.trim());
  const existingDaily = Array.isArray(data.ibitOptions?.daily) ? data.ibitOptions.daily : [];
  const existingLatest = existingDaily.at(-1)?.[0];
  const incomingLatest = incoming.at(-1)[0];
  if (existingLatest && incomingLatest < existingLatest) {
    throw new Error(
      `Longbridge 最新交易日 ${incomingLatest} 早于现有快照 ${existingLatest}，疑似数据源滞后；旧 IBIT 数据不会被修改`,
    );
  }
  const merged = new Map(existingDaily.map((row) => [row[0], row]));
  for (const row of incoming) merged.set(row[0], row);
  const daily = [...merged.values()].sort((a, b) => a[0].localeCompare(b[0]));
  const latest = daily.at(-1);
  const retrievedAt = new Date().toISOString().slice(0, 10);
  data.ibitOptions = {
    asOf: latest[0],
    retrievedAt,
    snapshot: {
      tradeDate: latest[0],
      callVolume: latest[1],
      putVolume: latest[2],
      putCallRatio: latest[3],
      openInterest: latest[4],
    },
    daily,
  };
  data.sources.ibitOptions = {
    provider: "Longbridge Securities",
    url: "https://open.longbridge.com/docs/cli/derivatives/option",
    asOf: latest[0],
    mode: "longbridge option volume daily IBIT.US 的公开日频成交量与未平仓量快照",
  };

  return {
    receivedRows: incoming.length,
    totalRows: daily.length,
    asOf: latest[0],
  };
}

async function fetchGatePage(from, to) {
  const url = new URL(GATE_CANDLES_URL);
  url.searchParams.set("currency_pair", "BTC_USDT");
  url.searchParams.set("interval", "1d");
  url.searchParams.set("from", String(from));
  url.searchParams.set("to", String(to));

  let response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`Gate.io 日 K 请求失败（${new Date(from * 1_000).toISOString().slice(0, 10)} 起）: ${error.message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Gate.io 日 K HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Gate.io 日 K 返回无效 JSON: ${error.message}`);
  }
  if (!Array.isArray(payload)) {
    throw new Error(`Gate.io 日 K 返回非数组: ${text.slice(0, 240)}`);
  }
  return payload;
}

function monthOrdinal(month) {
  const [year, value] = month.split("-").map(Number);
  return year * 12 + value;
}

function lastCalendarDay(date) {
  const [year, month] = date.slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function round1(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

export async function updateSeasonalityData(data) {
  const start = Math.floor(Date.UTC(2013, 0, 1) / 1_000);
  const end = Math.floor(Date.now() / 1_000);
  const pageSpan = 900 * DAY_SECONDS;
  const pages = [];
  for (let cursor = start; cursor <= end; cursor += pageSpan) {
    const to = Math.min(cursor + pageSpan - 1, end);
    pages.push([cursor, to]);
  }

  const rawRows = [];
  for (const [from, to] of pages) {
    rawRows.push(...(await fetchGatePage(from, to)));
  }
  if (rawRows.length < 365) {
    throw new Error(`Gate.io 仅返回 ${rawRows.length} 根日 K，低于完整历史安全阈值 365`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const candlesByDate = new Map();
  for (const [index, row] of rawRows.entries()) {
    if (!Array.isArray(row) || row.length < 6) {
      throw new Error(`Gate.io K 线第 ${index} 行结构不足 6 列`);
    }
    const timestamp = Number(row[0]);
    const close = Number(row[2]);
    if (!Number.isFinite(timestamp) || !Number.isFinite(close) || close <= 0) {
      throw new Error(`Gate.io K 线第 ${index} 行 timestamp/close 无效`);
    }
    const date = new Date(timestamp * 1_000).toISOString().slice(0, 10);
    const closedFlag = row[7];
    const explicitlyClosed = closedFlag === true || closedFlag === "true" || closedFlag === 1 || closedFlag === "1";
    // 老数据可能没有 window_closed；只有早于 UTC 当天的 K 线可安全视为已收盘。
    if (!(explicitlyClosed || date < today)) continue;
    const previous = candlesByDate.get(date);
    if (previous !== undefined && previous !== close) {
      throw new Error(`Gate.io ${date} 存在冲突的重复收盘价`);
    }
    candlesByDate.set(date, close);
  }

  const candles = [...candlesByDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (candles.length < 365 || Number(candles[0][0].slice(0, 4)) > 2014) {
    throw new Error(`Gate.io 有效历史不足：${candles.length} 根，起始 ${candles[0]?.[0] || "未知"}`);
  }

  const monthGroups = new Map();
  for (const [date, close] of candles) monthGroups.set(date.slice(0, 7), { date, close });
  const months = [...monthGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (let index = 1; index < months.length; index += 1) {
    if (monthOrdinal(months[index][0]) !== monthOrdinal(months[index - 1][0]) + 1) {
      throw new Error(`Gate.io 月份不连续: ${months[index - 1][0]} -> ${months[index][0]}`);
    }
  }

  const currentMonth = today.slice(0, 7);
  const completedMonths = months.filter(([month]) => month < currentMonth);
  for (const [month, point] of completedMonths) {
    if (point.date !== lastCalendarDay(point.date)) {
      throw new Error(`Gate.io ${month} 缺少月末日 K（最后一根为 ${point.date}），拒绝写入半月数据`);
    }
  }
  if (completedMonths.length === 0) throw new Error("Gate.io 没有可用的完整月份");

  // 早期 BTC 价格只有百美元量级，保留两位小数才能让月度回报可复算。
  const btcMonthly = completedMonths.map(([month, point]) => [
    month,
    Math.round(point.close * 100) / 100,
  ]);
  const earliestYear = Math.max(2013, Number(months[0][0].slice(0, 4)));
  const latestYear = Number(months.at(-1)[0].slice(0, 4));
  const years = {};
  for (let year = earliestYear; year <= latestYear; year += 1) years[String(year)] = Array(12).fill(null);
  for (let index = 1; index < months.length; index += 1) {
    const [month, point] = months[index];
    const previous = months[index - 1][1];
    years[month.slice(0, 4)][Number(month.slice(5, 7)) - 1] = round1((point.close / previous.close - 1) * 100);
  }

  const latestCandleDate = candles.at(-1)[0];
  const latestCompleteDate = completedMonths.at(-1)[1].date;
  data.btcMonthly = btcMonthly;
  data.seasonality = {
    source: "Gate.io BTC/USDT daily close",
    asOf: latestCandleDate,
    years,
  };
  data.sources.btcMonthly = {
    provider: "Gate.io",
    url: "https://www.gate.com/docs/developers/apiv4/en/#market-candlesticks",
    asOf: latestCompleteDate,
    mode: "BTC/USDT 已收盘日 K 线重建的完整月末收盘价；当月仅进入季节性 MTD",
  };

  return {
    pages: pages.length,
    candles: candles.length,
    firstDate: candles[0][0],
    asOf: latestCandleDate,
    completedMonths: btcMonthly.length,
  };
}
