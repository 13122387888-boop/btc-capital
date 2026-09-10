import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const files = ["index.html", "app.js", "experience.js", "styles.css", "enhancements.css", "experience.css"];
const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(new URL(`../${file}`, import.meta.url), "utf8")])));
const index = sources["index.html"];
const htmlIds = [...index.matchAll(/\bid="([\w-]+)"/g)].map(match => match[1]);
assert.equal(new Set(htmlIds).size, htmlIds.length, "index.html 不得包含重复 ID");

const generatedMarkup = sources["experience.js"] + sources["app.js"];
const declaredIds = new Set([...htmlIds, ...[...generatedMarkup.matchAll(/\bid=["']([\w-]+)["']/g)].map(match => match[1])]);
for (const file of ["app.js", "experience.js"]) {
  const names = [...sources[file].matchAll(/^  (?:async )?function (\w+)\(/gm)].map(match => match[1]);
  assert.equal(new Set(names).size, names.length, `${file} 不得包含重复的顶层函数定义`);
  const referencedIds = [...sources[file].matchAll(/\$\(["']([\w-]+)["']\)/g)].map(match => match[1]);
  const missing = [...new Set(referencedIds.filter(id => !declaredIds.has(id)))];
  assert.deepEqual(missing, [], `${file} 引用了未声明的元素 ID`);
}

for (const [file, source] of Object.entries(sources)) {
  assert.ok(!/soxx|cp-asset-switcher/i.test(source), `${file} 不得残留其他资产入口`);
}
for (const id of ["price-hero", "price-chart", "market-brief-text", "market-state-capital", "stat-etf-last", "ticker-eth"]) {
  assert.ok(!declaredIds.has(id), `旧版 DOM ${id} 应被移除，而非隐藏`);
}
for (const id of ["overview", "trend", "etf", "market", "onchain", "options", "seasonality", "defi", "health", "methodology"]) {
  assert.ok(htmlIds.includes(id) && index.includes(`href="#${id}"`), `缺少 ${id} 分区或导航入口`);
}
const fundamentals = index.indexOf('id="bitcoin-fundamentals"');
assert.ok(fundamentals > index.indexOf('id="methodology"'), "基本面应直接声明在来源详情中，不依赖运行时迁移");
console.log(`Frontend structure passed: ${htmlIds.length} unique IDs, live routes, no legacy asset entry or duplicate top-level functions.`);
