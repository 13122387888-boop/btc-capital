#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadStaticData } from "./lib/static-data.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = path.join(PROJECT_DIR, "data.js");
const RUNTIME_DIR = path.join(PROJECT_DIR, ".runtime");
const LOCK_DIR = path.join(RUNTIME_DIR, "update.lock");
const STATUS_FILE = path.join(RUNTIME_DIR, "last-update.json");
const CONFIG_FILE = path.join(RUNTIME_DIR, "schedule.json");
const LOG_DIR = path.join(RUNTIME_DIR, "logs");
const BACKUP_DIR = path.join(RUNTIME_DIR, "backups");
const STALE_LOCK_MS = 30 * 60 * 1000;

function parseTrigger(argv) {
  const entry = argv.find((value) => value.startsWith("--trigger="));
  const trigger = entry ? entry.slice("--trigger=".length) : "manual";
  return new Set(["manual", "scheduled", "startup"]).has(trigger) ? trigger : "manual";
}

function runId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

async function readJson(filePath) {
  try { return JSON.parse(await readFile(filePath, "utf8")); } catch { return null; }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rename(temporary, filePath);
        return;
      } catch (error) {
        if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function acquireLock(owner) {
  await mkdir(RUNTIME_DIR, { recursive: true });
  try {
    await mkdir(LOCK_DIR);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previousOwner = await readJson(path.join(LOCK_DIR, "owner.json"));
    const lockStat = await stat(LOCK_DIR).catch(() => null);
    const age = lockStat ? Date.now() - lockStat.mtimeMs : 0;
    if (processAlive(Number(previousOwner?.pid)) || age < STALE_LOCK_MS) return false;
    if (!path.resolve(LOCK_DIR).startsWith(`${path.resolve(RUNTIME_DIR)}${path.sep}`)) {
      throw new Error("更新锁路径越出运行目录，拒绝清理");
    }
    await rm(LOCK_DIR, { recursive: true, force: true });
    await mkdir(LOCK_DIR);
  }
  await writeJsonAtomic(path.join(LOCK_DIR, "owner.json"), owner);
  return true;
}

async function releaseLock() {
  if (!path.resolve(LOCK_DIR).startsWith(`${path.resolve(RUNTIME_DIR)}${path.sep}`)) return;
  await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
}

function cleanLine(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/((?:api[_-]?key|authorization|bearer)\s*[:=])\s*\S+/gi, "$1 [已隐藏]")
    .trim();
}

function conciseOutput(value) {
  return cleanLine(value).split(/\r?\n/).filter(Boolean).slice(-6).join(" | ").slice(0, 1_500);
}

function errorCode(value) {
  const text = String(value).toLowerCase();
  if (text.includes("cloudflare") || text.includes("http 403")) return "cloudflare";
  if (text.includes("timeout") || text.includes("aborted")) return "timeout";
  if (text.includes("longbridge") && (text.includes("无法运行") || text.includes("not found"))) return "dependency_missing";
  if (text.includes("校验")) return "validation";
  if (text.includes("http 429")) return "rate_limited";
  return "upstream_unavailable";
}

function runCommand(args, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "", stderr = "", timedOut = false;
    const append = (target, chunk) => `${target}${chunk}`.slice(-200_000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`, timedOut });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

function moduleAsOf(data, id) {
  if (id === "etf") return data?.sources?.etfFlows?.asOf ?? null;
  if (id === "ibit") return data?.sources?.ibitOptions?.asOf ?? data?.ibitOptions?.asOf ?? null;
  if (id === "seasonality") return data?.seasonality?.asOf ?? null;
  return null;
}

function moduleProvider(data, id) {
  if (id === "etf") return data?.sources?.etfFlows?.provider ?? null;
  if (id === "ibit") return data?.sources?.ibitOptions?.provider ?? null;
  if (id === "seasonality") return data?.sources?.btcMonthly?.provider ?? "Gate.io";
  return null;
}

function moduleFingerprint(data, id) {
  if (id === "etf") {
    return JSON.stringify({
      btcRows: data?.btcFlows?.length ?? 0,
      ethRows: data?.ethFlows?.length ?? 0,
      btcFirst: data?.btcFlows?.[0]?.[0] ?? null,
      ethFirst: data?.ethFlows?.[0]?.[0] ?? null,
      btcLast: data?.btcFlows?.at(-1) ?? null,
      ethLast: data?.ethFlows?.at(-1) ?? null,
      provider: moduleProvider(data, id),
    });
  }
  if (id === "ibit") {
    return JSON.stringify({ rows: data?.ibitOptions?.daily?.length ?? 0, last: data?.ibitOptions?.daily?.at(-1) ?? null });
  }
  if (id === "seasonality") {
    return JSON.stringify({ rows: data?.btcMonthly?.length ?? 0, last: data?.btcMonthly?.at(-1) ?? null, asOf: data?.seasonality?.asOf ?? null });
  }
  return "";
}

async function restoreBackup(backupPath) {
  const temporary = path.join(PROJECT_DIR, `.data.js.restore.${process.pid}.${Date.now()}.tmp`);
  await copyFile(backupPath, temporary);
  try { await rename(temporary, DATA_FILE); } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

async function log(message) {
  const month = new Date().toISOString().slice(0, 7);
  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(path.join(LOG_DIR, `update-${month}.log`), `${new Date().toISOString()} ${cleanLine(message)}\n`, "utf8");
}

async function main() {
  const trigger = parseTrigger(process.argv.slice(2));
  const id = runId();
  const startedAt = new Date().toISOString();
  const owner = { pid: process.pid, runId: id, trigger, startedAt };
  if (!(await acquireLock(owner))) {
    process.stdout.write("已有更新任务正在运行，本次已安全跳过。\n");
    process.exitCode = 0;
    return;
  }

  let previous = await readJson(STATUS_FILE) ?? {};
  let currentState = {
    runId: id,
    trigger,
    startedAt,
    finishedAt: null,
    status: "running",
    validation: "pending",
    modules: previous.modules ?? {},
  };
  await writeJsonAtomic(STATUS_FILE, currentState);
  await log(`开始更新 runId=${id} trigger=${trigger}`);

  try {
    const initialValidation = await runCommand(["scripts/validate-static-data.mjs"]);
    if (initialValidation.code !== 0) {
      throw new Error(`现有 data.js 未通过校验：${conciseOutput(initialValidation.stderr || initialValidation.stdout)}`);
    }

    await mkdir(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(BACKUP_DIR, `data-${id}.js`);
    await copyFile(DATA_FILE, backupPath);
    const scheduleConfig = await readJson(CONFIG_FILE) ?? {};
    const modules = [
      { id: "seasonality", label: "历史季节性", args: ["scripts/update-static-data.mjs", "--only=seasonality"] },
      {
        id: "ibit",
        label: "IBIT 期权",
        args: [
          "scripts/update-static-data.mjs",
          "--only=ibit",
          ...(scheduleConfig.longbridgeBin ? ["--longbridge-bin", scheduleConfig.longbridgeBin] : []),
        ],
      },
      { id: "etf", label: "ETF 资金流", args: ["scripts/update-static-data.mjs", "--only=etf", "--etf-source=auto"] },
    ];

    let successCount = 0;
    for (const module of modules) {
      const before = await loadStaticData(DATA_FILE);
      const beforeAsOf = moduleAsOf(before, module.id);
      const beforeFingerprint = moduleFingerprint(before, module.id);
      process.stdout.write(`更新 ${module.label}……\n`);
      const result = await runCommand(module.args);
      const detail = conciseOutput(result.stderr || result.stdout);
      if (result.code === 0) {
        const after = await loadStaticData(DATA_FILE);
        const afterAsOf = moduleAsOf(after, module.id);
        const status = moduleFingerprint(after, module.id) === beforeFingerprint ? "no_change" : "success";
        currentState.modules[module.id] = {
          status,
          beforeAsOf,
          afterAsOf,
          dataAsOf: afterAsOf,
          provider: moduleProvider(after, module.id),
          lastAttemptAt: new Date().toISOString(),
          lastSuccessAt: new Date().toISOString(),
          errorCode: null,
        };
        successCount += 1;
        process.stdout.write(`${module.label}：${status === "success" ? "已更新" : "暂无新交易日"}（${afterAsOf ?? "日期未知"}）\n`);
        await log(`${module.id} ${status} ${detail}`);
      } else {
        currentState.modules[module.id] = {
          ...(previous.modules?.[module.id] ?? {}),
          status: "failed",
          beforeAsOf,
          afterAsOf: beforeAsOf,
          dataAsOf: beforeAsOf,
          lastAttemptAt: new Date().toISOString(),
          lastSuccessAt: previous.modules?.[module.id]?.lastSuccessAt ?? null,
          errorCode: result.timedOut ? "timeout" : errorCode(detail),
        };
        process.stdout.write(`${module.label}：更新失败，继续使用 ${beforeAsOf ?? "现有"} 快照。\n`);
        await log(`${module.id} failed ${detail}`);
      }
      await writeJsonAtomic(STATUS_FILE, currentState);
    }

    const finalValidation = await runCommand(["scripts/validate-static-data.mjs"]);
    if (finalValidation.code !== 0) {
      await restoreBackup(backupPath);
      throw new Error(`最终校验失败，已恢复更新前快照：${conciseOutput(finalValidation.stderr || finalValidation.stdout)}`);
    }

    const failedCount = Object.values(currentState.modules).filter((module) => module.status === "failed").length;
    currentState.status = failedCount === 0 ? "success" : successCount ? "partial" : "failed";
    currentState.validation = "passed";
    currentState.finishedAt = new Date().toISOString();
    await writeJsonAtomic(STATUS_FILE, currentState);
    await log(`完成 status=${currentState.status} validation=passed`);
    process.stdout.write(`更新完成：${currentState.status === "success" ? "全部模块正常" : "部分模块失败，旧数据已安全保留"}。\n`);
    if (currentState.status === "failed") process.exitCode = 1;
  } catch (error) {
    currentState = {
      ...currentState,
      status: "failed",
      validation: "failed",
      finishedAt: new Date().toISOString(),
      errorCode: errorCode(error.message),
      message: cleanLine(error.message).slice(0, 500),
    };
    await writeJsonAtomic(STATUS_FILE, currentState).catch(() => {});
    await log(`失败 ${error.message}`).catch(() => {});
    process.stderr.write(`更新失败：${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await releaseLock();
  }
}

main().catch((error) => {
  process.stderr.write(`更新器异常：${error.message}\n`);
  process.exitCode = 1;
});
