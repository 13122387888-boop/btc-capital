import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import vm from "node:vm";

const projectDir = resolve(new URL("../", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
const outputDir = join(projectDir, "dist-pages");
const snapshotNames = ["market", "sentiment", "onchain", "defi", "gamma", "health"];
const expectedFiles = new Set([
  ".nojekyll",
  "app.js",
  "data.js",
  "deployment.js",
  "enhancements.css",
  "index.html",
  "styles.css",
  "snapshots/manifest.json",
  ...snapshotNames.map(name => `snapshots/${name}.json`),
]);

async function walk(root, current = root) {
  const rows = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) rows.push(...await walk(root, fullPath));
    else if (entry.isFile()) rows.push(relative(root, fullPath).split(sep).join("/"));
    else throw new Error(`发现链接或特殊文件：${fullPath}`);
  }
  return rows.sort();
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  check((await stat(outputDir)).isDirectory(), "缺少 dist-pages，请先运行 npm run build:pages");
  const actualFiles = await walk(outputDir);
  const extras = actualFiles.filter(name => !expectedFiles.has(name));
  const missing = [...expectedFiles].filter(name => !actualFiles.includes(name));
  check(!extras.length, `Pages 产物含白名单外文件：${extras.join(", ")}`);
  check(!missing.length, `Pages 产物缺少文件：${missing.join(", ")}`);

  const index = await readFile(join(outputDir, "index.html"), "utf8");
  const app = await readFile(join(outputDir, "app.js"), "utf8");
  const workflow = await readFile(join(projectDir, ".github", "workflows", "pages.yml"), "utf8");
  const deploymentIndex = index.indexOf("./deployment.js");
  const dataIndex = index.indexOf("./data.js");
  const appIndex = index.indexOf("./app.js");
  check(deploymentIndex >= 0 && deploymentIndex < dataIndex && dataIndex < appIndex, "脚本加载顺序必须是 deployment.js → data.js → app.js");
  check(index.includes('id="market-state-title"') && index.includes('id="market-state-liquidity"'), "首页缺少今日市场状态组件");
  check(index.includes('id="market-brief-text"') && index.includes('data-mobile-pager="market-state-page"'), "首页缺少 30 秒市场简报或移动分页");
  check(index.includes('data-mobile-section-body="bitcoin-fundamentals"') && index.includes('data-mobile-section-body="price-chart"'), "首页缺少移动端基本面或价格图折叠区");
  check(!index.includes('id="today-brief-title"'), "首页仍残留旧版今日三句话组件");
  check(index.includes('id="health-stale-count"') && !index.includes('id="health-cached-count"'), "健康状态主分类仍把缓存作为独立桶");
  check(index.includes("Deribit") && !index.includes("BYBIT BTC OPTIONS"), "Gamma 页面来源未切换到 Deribit");
  check(index.includes("±0.5%（含）") && index.includes("达到 ±2%") && index.includes("28–35 天"), "首页稳定币阈值边界或窗口口径不完整");
  check(index.includes("5 / 20 个美国交易日") && index.includes("7 / 30 个自然日"), "首页资金与趋势时间口径未区分交易日和自然日");
  check(["styles.css", "enhancements.css", "deployment.js", "data.js", "app.js"].every(asset => index.includes(`./${asset}?v=`)), "Pages 静态资源缺少构建版本号");
  check(app.includes("snapshotRefreshIntervalMs") && app.includes("reloadForNewerSnapshot") && app.includes("./snapshots/manifest.json") && app.includes('document.addEventListener("visibilitychange"') && app.includes('window.addEventListener("pageshow"'), "Pages 快照页面缺少自动续取与移动端恢复刷新");
  check(workflow.includes('cron: "37 * * * *"'), "Pages 定时刷新未配置为每小时错峰运行");

  const sandbox = { window: {}, Object };
  vm.runInNewContext(await readFile(join(outputDir, "deployment.js"), "utf8"), sandbox, { filename: "deployment.js" });
  const deployment = sandbox.window.PULSE_DEPLOYMENT;
  check(deployment?.mode === "snapshot", "deployment.js 未启用 snapshot 模式");
  check(Number.isFinite(Date.parse(deployment.generatedAt)), "deployment.js 缺少有效生成时间");
  check(Number(deployment.staleAfterSeconds) === 6 * 3600, "deployment.js 快照过期窗口不正确");
  for (const name of snapshotNames) {
    check(deployment.endpoints?.[name] === `./snapshots/${name}.json`, `${name} 快照路径不是相对 URL`);
    const payload = JSON.parse(await readFile(join(outputDir, "snapshots", `${name}.json`), "utf8"));
    check(payload && typeof payload === "object" && !Array.isArray(payload), `${name}.json 不是对象`);
    check(["live", "partial", "unavailable"].includes(payload.status), `${name}.json 状态无效：${payload.status}`);
    check(payload.snapshot?.generatedAt === deployment.generatedAt, `${name}.json 生成时间不一致`);
  }

  const manifest = JSON.parse(await readFile(join(outputDir, "snapshots", "manifest.json"), "utf8"));
  check(manifest.generatedAt === deployment.generatedAt, "manifest 生成时间不一致");
  check(snapshotNames.every(name => manifest.snapshots?.[name]), "manifest 缺少快照条目");
  const health = JSON.parse(await readFile(join(outputDir, "snapshots", "health.json"), "utf8"));
  check(!("serverStartedAt" in (health.data || {})) && !("uptimeSeconds" in (health.data || {})), "health.json 不应公开临时服务器运行信息");
  check(health.data?.automation?.status === "github-actions", "health.json 未标明 GitHub Actions 自动化模式");
  const healthSummary = health.data?.summary;
  const healthModules = health.data?.modules || [];
  const moduleIds = healthModules.map(module => module.id);
  const expectedModuleIds = ["market", "sentiment", "onchain", "defi", "gamma"];
  check(moduleIds.length === new Set(moduleIds).size, "health.json 存在重复模块 ID");
  check(expectedModuleIds.every(id => moduleIds.includes(id)) && moduleIds.length === expectedModuleIds.length, "health.json 动态模块集合不完整");
  const buckets = healthSummary?.health || {};
  const healthTotal = [buckets.healthy, buckets.degraded, buckets.stale, buckets.unavailable].reduce((sum, value) => sum + Number(value || 0), 0);
  check(Number.isInteger(healthSummary?.total) && healthSummary.total === healthTotal, "健康状态四个互斥桶之和必须等于模块总数");
  const effectiveHealth = module => module.status === "unavailable" ? "unavailable" : module.overdue === true ? "stale" : module.status === "partial" ? "degraded" : "healthy";
  const recomputedBuckets = Object.fromEntries(["healthy", "degraded", "stale", "unavailable"].map(key => [key, healthModules.filter(module => effectiveHealth(module) === key).length]));
  check(["healthy", "degraded", "stale", "unavailable"].every(key => Number(buckets[key]) === recomputedBuckets[key]), "健康状态四桶必须可由 modules 独立重算");
  check(healthSummary?.delivery && ["network", "freshCache", "staleCache"].every(key => Number.isFinite(Number(healthSummary.delivery[key]))), "健康状态缺少独立的取数方式统计");
  const selectedHas = (module, status) => module.sources?.some(source => source.selected === true && source.status === status);
  const recomputedDelivery = {
    network: healthModules.filter(module => selectedHas(module, "live")).length,
    freshCache: healthModules.filter(module => selectedHas(module, "cached")).length,
    staleCache: healthModules.filter(module => selectedHas(module, "stale")).length,
  };
  check(Object.keys(recomputedDelivery).every(key => Number(healthSummary.delivery[key]) === recomputedDelivery[key]), "健康状态取数方式必须由 selected sources 重算");
  const cachedUnion = healthModules.filter(module => selectedHas(module, "cached") || selectedHas(module, "stale")).length;
  check(Number(healthSummary?.cached || 0) === cachedUnion && cachedUnion <= healthSummary.total, "健康状态缓存模块数必须是 selected cache 的模块并集");
  check(healthModules.every(module => (module.sources || []).every(source => source.selected !== true || (Array.isArray(source.fields) && source.fields.length > 0))), "使用中的健康来源必须列出实际供给字段");
  process.stdout.write(`Pages 校验通过：${actualFiles.length} 个白名单文件，${snapshotNames.length} 个数据快照。\n`);
}

main().catch(error => {
  process.stderr.write(`Pages 校验失败：${error.message}\n`);
  process.exitCode = 1;
});
