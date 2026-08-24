import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = fileURLToPath(new URL("../", import.meta.url));
const OUTPUT_DIR = resolve(PROJECT_DIR, "dist-pages");
const TEMP_DIR = resolve(PROJECT_DIR, `.dist-pages.${process.pid}.tmp`);
const PORT = Number(process.env.PULSE_PAGES_PORT || 43173);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const STATIC_FILES = [
  "index.html",
  "app.js",
  "data.js",
  "styles.css",
  "enhancements.css",
];

const SNAPSHOTS = [
  ["market", "/api/data/market"],
  ["sentiment", "/api/data/sentiment"],
  ["onchain", "/api/data/onchain"],
  ["defi", "/api/data/defi"],
  ["gamma", "/api/gamma"],
];

function assertGeneratedPath(target, label) {
  const resolved = resolve(target);
  const rel = relative(PROJECT_DIR, resolved);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`${label} 必须位于项目目录内：${resolved}`);
  }
  if (!basename(resolved).startsWith("dist-pages") && !basename(resolved).startsWith(".dist-pages")) {
    throw new Error(`${label} 不是受保护的 Pages 构建目录：${resolved}`);
  }
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function fetchJson(pathname, timeout = 90_000) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeout),
  });
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${pathname} 未返回有效 JSON 对象`);
  }
  return { httpStatus: response.status, payload };
}

async function waitForServer(child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`快照服务器提前退出（code ${child.exitCode}）`);
    try {
      const ping = await fetchJson("/api/ping", 2_000);
      if (ping.httpStatus === 200 && ping.payload.status === "live") return;
    } catch {
      await delay(250);
    }
  }
  throw new Error("等待快照服务器启动超时");
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise(resolveExit => child.once("exit", resolveExit)),
    delay(2_000).then(() => child.kill("SIGKILL")),
  ]);
}

async function copyStaticFiles(targetDir) {
  for (const name of STATIC_FILES) {
    const source = join(PROJECT_DIR, name);
    if (!(await stat(source)).isFile()) throw new Error(`缺少 Pages 静态文件：${name}`);
    await copyFile(source, join(targetDir, name));
  }
}

async function listFiles(root, current = root) {
  const rows = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) rows.push(...await listFiles(root, fullPath));
    else if (entry.isFile()) rows.push(relative(root, fullPath).split(sep).join("/"));
    else throw new Error(`Pages 产物包含不支持的链接或特殊文件：${fullPath}`);
  }
  return rows.sort();
}

function publicSnapshotPayload(name, payload, generatedAt) {
  if (name !== "health") return payload;
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const { serverStartedAt: _serverStartedAt, uptimeSeconds: _uptimeSeconds, automation: _automation, ...publicData } = data;
  return {
    ...payload,
    updatedAt: generatedAt,
    data: {
      ...publicData,
      checkedAt: generatedAt,
      automation: {
        scheduleEnabled: true,
        scheduleTime: "每 2 小时",
        status: "github-actions",
        trigger: process.env.GITHUB_EVENT_NAME || "local-pages-build",
        lastAttemptAt: generatedAt,
        lastCompletedAt: generatedAt,
        validation: "passed",
        modules: {},
      },
    },
  };
}

async function main() {
  if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65_535) throw new Error(`无效构建端口：${PORT}`);
  assertGeneratedPath(OUTPUT_DIR, "输出目录");
  assertGeneratedPath(TEMP_DIR, "临时目录");

  let serverLog = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: PROJECT_DIR,
    env: { ...process.env, PULSE_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", chunk => { serverLog = `${serverLog}${chunk}`.slice(-4_000); });
  child.stderr.on("data", chunk => { serverLog = `${serverLog}${chunk}`.slice(-4_000); });

  let captured;
  try {
    await waitForServer(child);
    const entries = await Promise.all(SNAPSHOTS.map(async ([name, pathname]) => [name, await fetchJson(pathname)]));
    const health = await fetchJson("/api/health");
    captured = Object.fromEntries([...entries, ["health", health]]);
  } catch (error) {
    throw new Error(`${error.message}${serverLog.trim() ? `\n服务器输出：${serverLog.trim()}` : ""}`);
  } finally {
    await stopServer(child);
  }

  const generatedAt = new Date().toISOString();
  await rm(TEMP_DIR, { recursive: true, force: true });
  await mkdir(join(TEMP_DIR, "snapshots"), { recursive: true });
  await copyStaticFiles(TEMP_DIR);

  const endpointConfig = Object.fromEntries(
    [...SNAPSHOTS, ["health", "/api/health"]].map(([name]) => [name, `./snapshots/${name}.json`]),
  );
  const deploymentSource = `window.PULSE_DEPLOYMENT = Object.freeze(${JSON.stringify({
    mode: "snapshot",
    generatedAt,
    staleAfterSeconds: 6 * 3600,
    endpoints: endpointConfig,
  }, null, 2)});\n`;
  await writeFile(join(TEMP_DIR, "deployment.js"), deploymentSource, "utf8");
  await writeFile(join(TEMP_DIR, ".nojekyll"), "", "utf8");

  const manifest = {
    generatedAt,
    commit: process.env.GITHUB_SHA || null,
    mode: "snapshot",
    snapshots: {},
  };
  for (const [name] of [...SNAPSHOTS, ["health", "/api/health"]]) {
    const result = captured[name];
    const payload = {
      ...publicSnapshotPayload(name, result.payload, generatedAt),
      snapshot: { generatedAt, httpStatusAtCapture: result.httpStatus },
    };
    await writeFile(join(TEMP_DIR, "snapshots", `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    manifest.snapshots[name] = {
      status: result.payload.status || "unknown",
      updatedAt: result.payload.updatedAt || result.payload.asOf || null,
      httpStatusAtCapture: result.httpStatus,
    };
  }
  await writeFile(join(TEMP_DIR, "snapshots", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const expected = new Set([
    ...STATIC_FILES,
    "deployment.js",
    ".nojekyll",
    "snapshots/manifest.json",
    ...[...SNAPSHOTS, ["health", "/api/health"]].map(([name]) => `snapshots/${name}.json`),
  ]);
  const actual = await listFiles(TEMP_DIR);
  const extras = actual.filter(name => !expected.has(name));
  const missing = [...expected].filter(name => !actual.includes(name));
  if (extras.length || missing.length) {
    throw new Error(`Pages 白名单校验失败；多余：${extras.join(", ") || "无"}；缺少：${missing.join(", ") || "无"}`);
  }

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await rename(TEMP_DIR, OUTPUT_DIR);
  const summary = Object.entries(manifest.snapshots).map(([name, row]) => `${name}=${row.status}`).join(" · ");
  process.stdout.write(`Pages 产物已生成：${OUTPUT_DIR}\n${summary}\n`);
}

main().catch(async error => {
  await rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
  process.stderr.write(`Pages 构建失败：${error.message}\n`);
  process.exitCode = 1;
});
