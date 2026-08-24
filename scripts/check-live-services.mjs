const baseUrl = (process.env.PULSE_BASE_URL || "http://127.0.0.1:4173").replace(/\/$/, "");
const allowedStates = new Set(["live", "partial", "unavailable"]);

const checks = [
  ["ping", "/api/ping", (data, payload) => payload.service === "btc-capital-pulse" && Boolean(data.serverStartedAt), false],
  ["health", "/api/health", (data, payload) => payload.service === "btc-capital-pulse" && Array.isArray(data.modules) && data.modules.length >= 5 && data.modules.every(module => Object.hasOwn(module, "fetchedAt") && Object.hasOwn(module, "dataAsOf") && Array.isArray(module.sources)) && data.automation && typeof data.automation.scheduleEnabled === "boolean" && data.automation.modules && typeof data.automation.modules === "object", true],
  ["market", "/api/data/market", data => data.assets && Array.isArray(data.candles), true],
  ["sentiment", "/api/data/sentiment", data => Array.isArray(data.rows), true],
  ["onchain", "/api/data/onchain", data => data && typeof data === "object", true],
  ["defi", "/api/data/defi", data => Array.isArray(data.stableSeries), true],
  ["gamma", "/api/gamma", data => Array.isArray(data.byStrike), false]
];

async function readJson(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${baseUrl}${path}`, { signal: controller.signal, headers: { accept: "application/json" } });
    const body = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

let failed = false;
for (const [name, path, validateData, normalized] of checks) {
  try {
    const payload = await readJson(path);
    if (!allowedStates.has(payload.status)) throw new Error(`非法 status：${payload.status}`);
    if (!payload.updatedAt && !payload.asOf) throw new Error("缺少更新时间");
    if (normalized && !Array.isArray(payload.sources)) throw new Error("缺少 sources 数组");
    if (payload.status !== "unavailable" && !validateData(payload.data || payload, payload)) throw new Error("数据结构不完整");
    console.log(`${name.padEnd(9)} ${payload.status.toUpperCase()} · ${payload.updatedAt || payload.asOf}`);
  } catch (error) {
    failed = true;
    console.error(`${name.padEnd(9)} FAILED · ${error.message}`);
  }
}

if (failed) process.exitCode = 1;
