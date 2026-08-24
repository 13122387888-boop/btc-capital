#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  atomicWriteStaticData,
  formatValidationReport,
  loadStaticData,
  validateStaticData,
} from "./lib/static-data.mjs";
import {
  updateEtfData,
  updateIbitData,
  updateSeasonalityData,
} from "./lib/providers.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INPUT_FILE = path.join(PROJECT_DIR, "data.js");
const VALID_SECTIONS = new Set(["etf", "ibit", "seasonality"]);

function help() {
  return `
用法：node scripts/update-static-data.mjs [选项]

选项：
  --only=etf,ibit,seasonality   只更新指定模块；默认更新全部
  --dry-run                    拉取、构建并完整校验，但不写文件
  --output <路径>              原子写入目标；默认覆盖项目 data.js
  --farside-btc-html <路径>    从浏览器保存的 BTC Farside 完整 HTML 读取
  --farside-eth-html <路径>    从浏览器保存的 ETH Farside 完整 HTML 读取
  --etf-source <来源>          auto（默认）、farside 或 sosovalue
  --longbridge-bin <路径>      指定 Longbridge CLI 可执行文件
  -h, --help                   显示帮助

说明：所有被选模块先在内存中完成，再统一校验和原子写入；任一模块失败都不会修改目标文件。
`;
}

function optionValue(args, index, name) {
  const argument = args[index];
  if (argument.startsWith(`${name}=`)) return { value: argument.slice(name.length + 1), consumed: 0 };
  if (argument === name) {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} 需要路径参数`);
    return { value, consumed: 1 };
  }
  return null;
}

function parseArguments(argv) {
  const options = {
    only: new Set(VALID_SECTIONS),
    dryRun: false,
    output: INPUT_FILE,
    btcHtml: null,
    ethHtml: null,
    etfSource: "auto",
    longbridgeBin: process.env.PULSE_LONGBRIDGE_BIN || null,
    showHelp: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      options.showHelp = true;
      continue;
    }
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument.startsWith("--only=")) {
      const values = argument
        .slice("--only=".length)
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (values.length === 0) throw new Error("--only 至少需要一个模块名");
      for (const value of values) {
        if (!VALID_SECTIONS.has(value)) {
          throw new Error(`--only 不支持 ${value}；可选 etf、ibit、seasonality`);
        }
      }
      options.only = new Set(values);
      continue;
    }

    const output = optionValue(argv, index, "--output");
    if (output) {
      options.output = path.resolve(output.value);
      index += output.consumed;
      continue;
    }
    const btcHtml = optionValue(argv, index, "--farside-btc-html");
    if (btcHtml) {
      options.btcHtml = path.resolve(btcHtml.value);
      index += btcHtml.consumed;
      continue;
    }
    const ethHtml = optionValue(argv, index, "--farside-eth-html");
    if (ethHtml) {
      options.ethHtml = path.resolve(ethHtml.value);
      index += ethHtml.consumed;
      continue;
    }
    const etfSource = optionValue(argv, index, "--etf-source");
    if (etfSource) {
      options.etfSource = etfSource.value.toLowerCase();
      index += etfSource.consumed;
      continue;
    }
    const longbridgeBin = optionValue(argv, index, "--longbridge-bin");
    if (longbridgeBin) {
      options.longbridgeBin = path.resolve(longbridgeBin.value);
      index += longbridgeBin.consumed;
      continue;
    }
    throw new Error(`未知参数: ${argument}`);
  }
  return options;
}

function refreshTopAsOf(data) {
  const candidates = [
    data.sources?.etfFlows?.asOf,
    data.sources?.ethEtfFlows?.asOf,
    data.sources?.btcMonthly?.asOf,
    data.sources?.ibitOptions?.asOf,
    data.seasonality?.asOf,
  ].filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value)));
  if (candidates.length) data.asOf = candidates.sort().at(-1);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.showHelp) {
    process.stdout.write(help());
    return;
  }

  const data = await loadStaticData(INPUT_FILE);
  const summaries = [];
  let etfResult = null;

  if (options.only.has("etf")) {
    etfResult = await updateEtfData(data, {
      btcHtml: options.btcHtml,
      ethHtml: options.ethHtml,
      source: options.etfSource,
    });
    summaries.push(
      `ETF：${etfResult.provider}；BTC ${etfResult.btcRows} 行（${etfResult.btcAsOf}），ETH ${etfResult.ethRows} 行（${etfResult.ethAsOf}）${etfResult.fallback ? "；已启用回退源" : ""}`,
    );
  }
  if (options.only.has("ibit")) {
    const result = updateIbitData(data, { longbridgeBin: options.longbridgeBin || undefined });
    summaries.push(
      `IBIT：CLI 返回 ${result.receivedRows} 行，合并后 ${result.totalRows} 行（${result.asOf}）`,
    );
  }
  if (options.only.has("seasonality")) {
    const result = await updateSeasonalityData(data);
    summaries.push(
      `季节性：${result.pages} 页 / ${result.candles} 根日 K，${result.completedMonths} 个完整月（${result.firstDate} 至 ${result.asOf}）`,
    );
  }

  refreshTopAsOf(data);
  const validation = validateStaticData(data, {
    requireCompleteEtf: etfResult?.completeHistory === true,
    strictSeasonality: options.only.has("seasonality"),
  });
  process.stdout.write(`${summaries.join("\n")}\n${formatValidationReport(validation)}\n`);
  if (validation.errors.length) {
    throw new Error("生成结果未通过校验，未写入任何文件");
  }

  if (options.dryRun) {
    process.stdout.write("DRY RUN：未写入文件。\n");
    return;
  }

  await atomicWriteStaticData(options.output, data);
  process.stdout.write(`已原子写入 ${options.output}\n`);
}

main().catch((error) => {
  process.stderr.write(`更新失败：${error.message}\n`);
  process.exitCode = 1;
});
