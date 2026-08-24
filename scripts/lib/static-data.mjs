import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function isValidDay(value) {
  if (!DAY_RE.test(String(value))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidMonth(value) {
  if (!MONTH_RE.test(String(value))) return false;
  const month = Number(String(value).slice(5, 7));
  return month >= 1 && month <= 12;
}

function round1(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

export async function loadStaticData(filePath) {
  const source = await readFile(filePath, "utf8");
  const context = { window: {} };

  try {
    vm.runInNewContext(source, context, {
      filename: filePath,
      timeout: 1_000,
      codeGeneration: { strings: false, wasm: false },
    });
  } catch (error) {
    throw new Error(`无法解析静态数据文件 ${filePath}: ${error.message}`);
  }

  const value = context.window.PULSE_STATIC_DATA;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filePath} 未定义有效的 window.PULSE_STATIC_DATA 对象`);
  }

  // 去掉 vm realm 的原型，后续只处理 JSON 可表达的数据。
  return JSON.parse(JSON.stringify(value));
}

export function serializeStaticData(data) {
  return `window.PULSE_STATIC_DATA = ${JSON.stringify(data, null, 2)};\n`;
}

export async function atomicWriteStaticData(filePath, data) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, serializeStaticData(data), {
      encoding: "utf8",
      flag: "wx",
    });
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rename(temporary, filePath);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
      }
    }
    if (lastError) throw lastError;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function aggregateMonthly(rows) {
  const totals = new Map();
  for (const [date, value] of rows) {
    const month = date.slice(0, 7);
    totals.set(month, (totals.get(month) || 0) + Number(value));
  }
  return [...totals.entries()].map(([month, total]) => [month, round1(total)]);
}

function validateSeries({ name, rows, keyType = "day", valueCheck }) {
  const errors = [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return [`${name} 必须是非空数组`];
  }

  const seen = new Set();
  let previous = "";
  rows.forEach((row, index) => {
    if (!Array.isArray(row)) {
      errors.push(`${name}[${index}] 不是数组`);
      return;
    }
    const key = row[0];
    const validKey = keyType === "month" ? isValidMonth(key) : isValidDay(key);
    if (!validKey) errors.push(`${name}[${index}] 日期无效: ${String(key)}`);
    if (seen.has(key)) errors.push(`${name} 存在重复日期: ${String(key)}`);
    if (previous && String(key) <= previous) {
      errors.push(`${name} 日期未严格升序: ${previous} -> ${String(key)}`);
    }
    seen.add(key);
    previous = String(key);
    if (valueCheck) valueCheck(row, index, errors);
  });
  return errors;
}

function checkFinite(value, label, errors, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) {
    errors.push(`${label} 必须是 ${min} 至 ${max} 范围内的有限数值`);
  }
}

function adjacentMonth(a, b) {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return by * 12 + bm === ay * 12 + am + 1;
}

function validateEtf(data, errors, warnings, { requireCompleteAggregation = false } = {}) {
  errors.push(
    ...validateSeries({
      name: "btcFlows",
      rows: data.btcFlows,
      valueCheck(row, index, target) {
        if (row.length !== 2) target.push(`btcFlows[${index}] 必须包含日期和值`);
        checkFinite(row[1], `btcFlows[${index}][1]`, target);
      },
    }),
    ...validateSeries({
      name: "ethFlows",
      rows: data.ethFlows,
      valueCheck(row, index, target) {
        if (row.length !== 2) target.push(`ethFlows[${index}] 必须包含日期和值`);
        checkFinite(row[1], `ethFlows[${index}][1]`, target);
      },
    }),
    ...validateSeries({
      name: "btcMonthlyFlows",
      rows: data.btcMonthlyFlows,
      keyType: "month",
      valueCheck(row, index, target) {
        if (row.length !== 2) target.push(`btcMonthlyFlows[${index}] 必须包含月份和值`);
        checkFinite(row[1], `btcMonthlyFlows[${index}][1]`, target);
      },
    }),
  );

  if (!Array.isArray(data.btcFlows) || !Array.isArray(data.btcMonthlyFlows)) return;
  if (data.btcFlows.length === 0 || data.btcMonthlyFlows.length === 0) return;

  const firstDailyMonth = data.btcFlows[0][0].slice(0, 7);
  const lastDailyMonth = data.btcFlows.at(-1)[0].slice(0, 7);
  const firstMonthly = data.btcMonthlyFlows[0][0];
  const lastMonthly = data.btcMonthlyFlows.at(-1)[0];
  const fullHistory = firstDailyMonth === firstMonthly && lastDailyMonth === lastMonthly;

  if (!fullHistory) {
    const expectedByMonth = new Map(aggregateMonthly(data.btcFlows));
    const monthlyByMonth = new Map(data.btcMonthlyFlows);
    for (const [month, value] of expectedByMonth) {
      if (month === firstDailyMonth) continue;
      const actual = monthlyByMonth.get(month);
      if (!Number.isFinite(actual) || Math.abs(Number(actual) - value) > 0.051) {
        errors.push(`btcMonthlyFlows[${month}] 与已保留日值聚合不一致：期望 ${value}，实际 ${actual ?? "缺失"}`);
      }
    }
    const message =
      "btcFlows 未保留最早期逐日明细；已复核当前日序列完整覆盖月份的月度聚合。";
    if (requireCompleteAggregation) errors.push(message);
    else warnings.push(message);
    return;
  }

  const expected = aggregateMonthly(data.btcFlows);
  if (expected.length !== data.btcMonthlyFlows.length) {
    errors.push(
      `btcMonthlyFlows 月份数不一致：日值聚合 ${expected.length}，文件 ${data.btcMonthlyFlows.length}`,
    );
    return;
  }

  expected.forEach(([month, value], index) => {
    const actual = data.btcMonthlyFlows[index];
    if (!actual || actual[0] !== month || Math.abs(Number(actual[1]) - value) > 0.051) {
      errors.push(
        `btcMonthlyFlows[${month}] 与日值聚合不一致：期望 ${value}，实际 ${actual?.[1] ?? "缺失"}`,
      );
    }
  });
}

function validateIbit(data, errors) {
  const ibit = data.ibitOptions;
  if (!ibit || typeof ibit !== "object") {
    errors.push("ibitOptions 必须是对象");
    return;
  }

  errors.push(
    ...validateSeries({
      name: "ibitOptions.daily",
      rows: ibit.daily,
      valueCheck(row, index, target) {
        if (row.length !== 5) {
          target.push(`ibitOptions.daily[${index}] 必须有 5 列`);
          return;
        }
        checkFinite(row[1], `ibitOptions.daily[${index}] callVolume`, target, { min: 0 });
        checkFinite(row[2], `ibitOptions.daily[${index}] putVolume`, target, { min: 0 });
        checkFinite(row[3], `ibitOptions.daily[${index}] putCallRatio`, target, { min: 0 });
        checkFinite(row[4], `ibitOptions.daily[${index}] openInterest`, target, { min: 0 });
        if (![row[1], row[2], row[4]].every(Number.isInteger)) {
          target.push(`ibitOptions.daily[${index}] 成交量和 OI 必须是整数`);
        }
        if (row[1] > 0 && Math.abs(row[2] / row[1] - row[3]) > 0.0015) {
          target.push(`ibitOptions.daily[${index}] Put/Call 比率与成交量不一致`);
        }
      },
    }),
  );

  if (!Array.isArray(ibit.daily) || ibit.daily.length === 0) return;
  const last = ibit.daily.at(-1);
  const snapshot = ibit.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    errors.push("ibitOptions.snapshot 必须是对象");
    return;
  }

  const expected = {
    tradeDate: last[0],
    callVolume: last[1],
    putVolume: last[2],
    putCallRatio: last[3],
    openInterest: last[4],
  };
  for (const [field, value] of Object.entries(expected)) {
    if (snapshot[field] !== value) {
      errors.push(`ibitOptions.snapshot.${field} 与 daily 最后一行不一致`);
    }
  }
  if (ibit.asOf !== last[0]) errors.push("ibitOptions.asOf 与 daily 最后交易日不一致");
}

function validateSeasonality(data, errors, warnings, { strictCrossCheck = true } = {}) {
  errors.push(
    ...validateSeries({
      name: "btcMonthly",
      rows: data.btcMonthly,
      keyType: "month",
      valueCheck(row, index, target) {
        if (row.length !== 2) target.push(`btcMonthly[${index}] 必须包含月份和收盘价`);
        checkFinite(row[1], `btcMonthly[${index}][1]`, target, { min: Number.EPSILON });
      },
    }),
  );

  const seasonality = data.seasonality;
  if (!seasonality || typeof seasonality !== "object") {
    errors.push("seasonality 必须是对象");
    return;
  }
  if (!isValidDay(seasonality.asOf)) errors.push("seasonality.asOf 必须是有效日期");
  const years = seasonality.years;
  if (!years || typeof years !== "object" || Array.isArray(years)) {
    errors.push("seasonality.years 必须是对象");
    return;
  }

  const yearKeys = Object.keys(years);
  if (yearKeys.length === 0) errors.push("seasonality.years 不能为空");
  yearKeys.forEach((year, yearIndex) => {
    if (!/^\d{4}$/.test(year)) errors.push(`seasonality 年份无效: ${year}`);
    if (yearIndex > 0 && Number(year) !== Number(yearKeys[yearIndex - 1]) + 1) {
      errors.push(`seasonality 年份不连续: ${yearKeys[yearIndex - 1]} -> ${year}`);
    }
    const values = years[year];
    if (!Array.isArray(values) || values.length !== 12) {
      errors.push(`seasonality.years.${year} 必须恰好包含 12 个月`);
      return;
    }
    values.forEach((value, monthIndex) => {
      if (value !== null) {
        checkFinite(value, `seasonality.years.${year}[${monthIndex}]`, errors, {
          min: -100,
          max: 1_000,
        });
      }
    });
  });

  if (isValidDay(seasonality.asOf)) {
    const asOfYear = Number(seasonality.asOf.slice(0, 4));
    const asOfMonth = Number(seasonality.asOf.slice(5, 7));
    for (const [year, values] of Object.entries(years)) {
      values.forEach((value, monthIndex) => {
        const inFuture = Number(year) > asOfYear ||
          (Number(year) === asOfYear && monthIndex + 1 > asOfMonth);
        if (inFuture && value !== null) {
          errors.push(`seasonality ${year}-${String(monthIndex + 1).padStart(2, "0")} 是未来月份，必须为 null`);
        }
      });
    }
  }

  if (!Array.isArray(data.btcMonthly)) return;
  const crossCheckErrors = [];
  for (let index = 1; index < data.btcMonthly.length; index += 1) {
    const previous = data.btcMonthly[index - 1];
    const current = data.btcMonthly[index];
    if (!adjacentMonth(previous[0], current[0])) continue;
    const yearValues = years[current[0].slice(0, 4)];
    if (!Array.isArray(yearValues)) continue;
    const matrixValue = yearValues[Number(current[0].slice(5, 7)) - 1];
    const expected = round1((current[1] / previous[1] - 1) * 100);
    // btcMonthly 展示值会四舍五入到美元，允许 0.2 个百分点的误差。
    if (matrixValue !== null && Math.abs(matrixValue - expected) > 0.2) {
      crossCheckErrors.push(`${current[0]} 季节性回报与 btcMonthly 相邻月收盘价不一致`);
    }
  }
  if (strictCrossCheck) errors.push(...crossCheckErrors);
  else if (crossCheckErrors.length) {
    warnings.push(`现有 btcMonthly 与季节性矩阵有 ${crossCheckErrors.length} 个月无法互相复算；本次未更新 seasonality，未把它作为写入阻断项。`);
  }
}

function validateSources(data, errors) {
  if (!isValidDay(data.asOf)) errors.push("顶层 asOf 必须是有效日期");
  const sources = data.sources;
  if (!sources || typeof sources !== "object") {
    errors.push("sources 必须是对象");
    return;
  }

  const checks = [
    ["etfFlows", data.btcFlows?.at(-1)?.[0]],
    ["ethEtfFlows", data.ethFlows?.at(-1)?.[0]],
    ["ibitOptions", data.ibitOptions?.daily?.at(-1)?.[0]],
  ];
  for (const [key, expected] of checks) {
    const source = sources[key];
    if (!source || typeof source !== "object") {
      errors.push(`sources.${key} 缺失`);
      continue;
    }
    if (!source.provider || !source.url || !source.mode) {
      errors.push(`sources.${key} 必须包含 provider、url、mode`);
    }
    if (expected && source.asOf !== expected) {
      errors.push(`sources.${key}.asOf 与对应数据最后日期不一致`);
    }
  }

  const btcSource = sources.btcMonthly;
  if (!btcSource || typeof btcSource !== "object") {
    errors.push("sources.btcMonthly 缺失");
  } else if (data.btcMonthly?.length && btcSource.asOf?.slice(0, 7) !== data.btcMonthly.at(-1)[0]) {
    errors.push("sources.btcMonthly.asOf 与 btcMonthly 最后月份不一致");
  }
}

export function validateStaticData(data, options = {}) {
  const errors = [];
  const warnings = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { errors: ["静态数据根节点必须是对象"], warnings };
  }
  validateSources(data, errors);
  validateEtf(data, errors, warnings, {
    requireCompleteAggregation: options.requireCompleteEtf === true,
  });
  validateIbit(data, errors);
  validateSeasonality(data, errors, warnings, {
    strictCrossCheck: options.strictSeasonality !== false,
  });
  return { errors, warnings };
}

export function formatValidationReport(result) {
  const lines = [];
  for (const warning of result.warnings) lines.push(`警告: ${warning}`);
  for (const error of result.errors) lines.push(`错误: ${error}`);
  if (result.errors.length === 0) {
    lines.push(`校验通过（${result.warnings.length} 条警告）`);
  } else {
    lines.push(`校验失败（${result.errors.length} 个错误，${result.warnings.length} 条警告）`);
  }
  return lines.join("\n");
}
