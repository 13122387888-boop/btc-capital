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
  const deploymentIndex = index.indexOf("./deployment.js");
  const dataIndex = index.indexOf("./data.js");
  const appIndex = index.indexOf("./app.js");
  check(deploymentIndex >= 0 && deploymentIndex < dataIndex && dataIndex < appIndex, "脚本加载顺序必须是 deployment.js → data.js → app.js");

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
  process.stdout.write(`Pages 校验通过：${actualFiles.length} 个白名单文件，${snapshotNames.length} 个数据快照。\n`);
}

main().catch(error => {
  process.stderr.write(`Pages 校验失败：${error.message}\n`);
  process.exitCode = 1;
});
