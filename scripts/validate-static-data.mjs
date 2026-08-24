#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatValidationReport,
  loadStaticData,
  validateStaticData,
} from "./lib/static-data.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseInput(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(
      "用法：node scripts/validate-static-data.mjs [data.js 路径]\n默认校验项目根目录的 data.js；发现错误时退出码为 1。\n",
    );
    return null;
  }
  if (argv.length > 1) throw new Error("最多接受一个 data.js 路径参数");
  return argv[0] ? path.resolve(argv[0]) : path.join(PROJECT_DIR, "data.js");
}

async function main() {
  const input = parseInput(process.argv.slice(2));
  if (!input) return;
  const data = await loadStaticData(input);
  const result = validateStaticData(data);
  process.stdout.write(`${input}\n${formatValidationReport(result)}\n`);
  if (result.errors.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`校验失败：${error.message}\n`);
  process.exitCode = 1;
});

