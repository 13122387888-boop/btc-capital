#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_DIR = path.join(PROJECT_DIR, ".runtime");
const CONFIG_FILE = path.join(RUNTIME_DIR, "schedule.json");
const XML_FILE = path.join(RUNTIME_DIR, "task.xml");
const TASK_NAME = "BTC Capital Pulse - Daily Update";

function parse(argv) {
  const command = (argv[0] || "status").toLowerCase();
  const timeArg = argv.find((value) => value.startsWith("--time="));
  const time = timeArg ? timeArg.slice("--time=".length) : "08:30";
  if (!new Set(["install", "status", "remove"]).has(command)) {
    throw new Error("用法：auto-update.cmd install|status|remove [--time=08:30]");
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("--time 必须是 HH:MM，例如 08:30");
  return { command, time };
}

function xml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function findLongbridge() {
  const result = spawnSync("where.exe", ["longbridge"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? null;
}

function userSid() {
  const result = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  const match = result.stdout.match(/S-\d+(?:-\d+)+/);
  if (result.status !== 0 || !match) throw new Error("无法取得当前用户 SID，未安装计划任务");
  return match[0];
}

function taskExists() {
  return spawnSync("schtasks.exe", ["/Query", "/TN", TASK_NAME], { windowsHide: true, stdio: "ignore" }).status === 0;
}

function dateStamp() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

async function writeConfig(value) {
  await mkdir(RUNTIME_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function install(time) {
  await mkdir(RUNTIME_DIR, { recursive: true });
  const sid = userSid();
  const longbridgeBin = findLongbridge();
  const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>每天更新 BTC Capital Pulse 本地数据快照</Description></RegistrationInfo>
  <Triggers><CalendarTrigger><StartBoundary>${dateStamp()}T${time}:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT30M</ExecutionTimeLimit><Enabled>true</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>${xml(process.execPath)}</Command><Arguments>${xml(`"${path.join(PROJECT_DIR, "scripts", "run-update.mjs")}" --trigger=scheduled`)}</Arguments><WorkingDirectory>${xml(PROJECT_DIR)}</WorkingDirectory></Exec></Actions>
</Task>`;
  await writeFile(XML_FILE, `\ufeff${taskXml}`, "utf16le");
  const result = spawnSync("schtasks.exe", ["/Create", "/TN", TASK_NAME, "/XML", XML_FILE, "/F"], {
    encoding: "utf8",
    windowsHide: true,
  });
  await rm(XML_FILE, { force: true });
  if (result.status !== 0) throw new Error(`计划任务安装失败：${(result.stderr || result.stdout || "未知错误").trim()}`);
  await writeConfig({
    enabled: true,
    taskName: TASK_NAME,
    time,
    projectDir: PROJECT_DIR,
    nodePath: process.execPath,
    longbridgeBin,
    installedAt: new Date().toISOString(),
  });
  process.stdout.write(`自动更新已开启：每天 ${time}，错过运行时间后会在系统可用时补跑。\n`);
  if (!longbridgeBin) process.stdout.write("提示：未找到 Longbridge CLI，IBIT 模块会保留旧快照，其余模块仍会更新。\n");
}

async function remove() {
  const result = spawnSync("schtasks.exe", ["/Delete", "/TN", TASK_NAME, "/F"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 && taskExists()) throw new Error(`删除计划任务失败：${(result.stderr || result.stdout || "未知错误").trim()}`);
  await writeConfig({ enabled: false, taskName: TASK_NAME, projectDir: PROJECT_DIR, removedAt: new Date().toISOString() });
  process.stdout.write("自动更新已关闭；历史数据、日志和备份均已保留。\n");
}

async function status() {
  if (taskExists()) {
    process.stdout.write(`自动更新：已开启（任务名：${TASK_NAME}）。\n`);
  } else {
    process.stdout.write("自动更新：尚未开启。运行 auto-update.cmd install 可启用每天 08:30 更新。\n");
  }
}

async function main() {
  if (process.platform !== "win32") throw new Error("计划任务管理脚本仅用于 Windows");
  const options = parse(process.argv.slice(2));
  if (options.command === "install") await install(options.time);
  if (options.command === "remove") await remove();
  if (options.command === "status") await status();
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
