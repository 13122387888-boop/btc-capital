#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestedPort = Number(process.env.PULSE_PORT || 4173);
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65_535
  ? requestedPort
  : 4173;
const URL = `http://127.0.0.1:${PORT}/`;

function assertNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 20) {
    throw new Error(`当前 Node.js 为 ${process.versions.node}，需要 20 或更高版本`);
  }
}

async function probe() {
  try {
    const response = await fetch(`${URL}api/ping`, { signal: AbortSignal.timeout(1_500) });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    if (response.ok && payload?.service === "btc-capital-pulse") return "ours";
    return "occupied";
  } catch {
    return "free";
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: PROJECT_DIR,
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function updateBeforeOpen() {
  if (process.env.PULSE_SKIP_STARTUP_UPDATE === "1") return;
  process.stdout.write("正在更新本地快照；任何单一来源失败都不会阻止页面启动……\n");
  const code = await run(process.execPath, ["scripts/run-update.mjs", "--trigger=startup"]);
  if (code !== 0) process.stdout.write("更新未完全成功，将继续使用上次通过校验的快照。\n");
}

function openPage() {
  if (process.env.PULSE_NO_BROWSER === "1") return;
  const opener = spawn("cmd.exe", ["/d", "/s", "/c", "start", "", URL], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  opener.unref();
}

async function waitUntilReady(child) {
  let exited = false;
  child.once("exit", () => { exited = true; });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (exited) return false;
    if (await probe() === "ours") return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main() {
  assertNodeVersion();
  const initial = await probe();
  if (initial === "occupied") {
    throw new Error(`端口 ${PORT} 已被其他程序占用；请关闭占用程序，或设置 PULSE_PORT 后重试`);
  }

  await updateBeforeOpen();
  if (initial === "ours") {
    process.stdout.write(`本地服务已在运行：${URL}\n`);
    openPage();
    return;
  }

  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: PROJECT_DIR,
    env: { ...process.env, PULSE_PORT: String(PORT) },
    stdio: "inherit",
    windowsHide: true,
  });
  const stop = () => { if (!child.killed) child.kill("SIGINT"); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  if (!(await waitUntilReady(child))) {
    stop();
    throw new Error("本地服务未能在 15 秒内就绪");
  }
  process.stdout.write(`页面已就绪：${URL}\n关闭此窗口即可停止本地服务。\n`);
  openPage();
  const exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 0)));
  process.exitCode = exitCode;
}

main().catch((error) => {
  process.stderr.write(`启动失败：${error.message}\n`);
  process.exitCode = 1;
});
