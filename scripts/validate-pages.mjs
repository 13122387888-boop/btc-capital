import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import vm from "node:vm";
import { STATIC_FILES, VERSIONED_ASSETS, assetVersion } from "./lib/public-assets.mjs";

const projectDir = resolve(new URL("../", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
const outputDir = join(projectDir, "dist-pages");
const snapshotNames = ["market", "sentiment", "onchain", "defi", "gamma", "health"];
const expectedFiles = new Set([
  ".nojekyll",
  ...STATIC_FILES,
  "deployment.js",
  "snapshots/manifest.json",
  "snapshots/static.json",
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
  const scriptTags = [...index.matchAll(/<script\b([^>]*\bsrc="\.\/([^"?]+)[^"]*"[^>]*)>/g)];
  check(JSON.stringify(scriptTags.map(match => match[2])) === JSON.stringify(['deployment.js', 'data.js', 'experience-math.js', 'chart-data.js', 'experience.js', 'snapshot-client.js', 'app.js']), '前端脚本依赖顺序不一致');
  check(scriptTags.every(match => /\bdefer\b/.test(match[1]) && !/\basync\b/.test(match[1])), '所有外部脚本须依次 defer');
  check(index.includes('/og-image.jpg') && (await stat(join(outputDir, 'og-image.jpg'))).size < 150000, '分享预览未使用压缩 JPEG');
  check(deploymentIndex >= 0 && deploymentIndex < dataIndex && dataIndex < appIndex, "脚本加载顺序必须是 deployment.js → data.js → app.js");
  check(["scan-home", "position-chart", "scan-trend", "scan-capital", "scan-options", "scan-vol"].every(id => index.includes(`id="${id}"`)), "首页缺少价格位置图或四项观察");
  check(index.includes('id="bitcoin-fundamentals"') && index.includes('id="trend-chart"'), "缺少基本面说明或当前趋势图");
  check(!index.includes('id="market-brief-text"') && !index.includes('id="price-hero"'), "仍残留已停用的旧首页");
  check(index.includes('id="health-stale-count"') && !index.includes('id="health-cached-count"'), "健康状态主分类仍把缓存作为独立桶");
  check(index.includes("Deribit") && !index.includes("BYBIT BTC OPTIONS"), "Gamma 页面来源未切换到 Deribit");
  check(/stablecoinFlatPercent:\s*0\.5/.test(app) && /stablecoinStrongPercent:\s*2/.test(app) && app.includes("28–35 天"), "稳定币阈值边界或窗口校验缺失");
  check(index.includes("交易日净流") && index.includes("20日均线") && index.includes("60日均线"), "资金交易日与日线均线口径缺失");
  for (const asset of VERSIONED_ASSETS) {
    check(index.includes(`./${asset}?v=${assetVersion(await readFile(join(outputDir, asset)))}`), `${asset} 缺少正确的内容指纹`);
  }
  check(index.indexOf('./snapshot-client.js') < appIndex, '缓存客户端必须先于应用加载');
  check(index.includes('class="experience"') && index.includes('<noscript>') && index.includes('og:image') && index.includes('theme-color'), '首屏降级或分享信息缺失');
  check(index.includes('id="scan-home"') && index.includes('id="trend-chart"') && index.includes('id="note-sheet"'), "缺少扫描首页、价格结构或说明弹层");
  check(!app.includes("window.location.replace"), "数据更新不得触发整页导航");
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
    if (name === 'defi') check((payload.data?.stableSeries?.length || 0) <= 740, 'DeFi 快照超出图表历史窗口');
  }

  const manifest = JSON.parse(await readFile(join(outputDir, "snapshots", "manifest.json"), "utf8"));
  check(manifest.generatedAt === deployment.generatedAt, "manifest 生成时间不一致");
  const staticSnapshot = JSON.parse(await readFile(join(outputDir, "snapshots", "static.json"), "utf8"));
  check(staticSnapshot.generatedAt === deployment.generatedAt && Array.isArray(staticSnapshot.data?.btcFlows), "原位刷新静态数据缺失或版本不一致");
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
