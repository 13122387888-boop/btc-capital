# BTC Capital Pulse

面向普通用户的比特币研究仪表盘：用紧凑图表回答“趋势怎样、资金怎样、持仓集中在哪里、市场计入了多少波动”，按“结论 → 依据 → 观察条件”组织信息。

原生 HTML / CSS / JavaScript + Node.js 内置模块，无 npm 运行依赖。支持本地服务与 GitHub Pages 定时快照两种模式。

## 页面与交互

首页用于快速扫描，详情用于验证；各视图通过 hash 路由切换，不是整页重新加载。

| 入口 | 内容 |
| --- | --- |
| `#overview` | 市场一句话、价格位置图、趋势/ETF 资金/期权持仓/波动四项摘要 |
| `#trend` | 已收盘日 K、20/60 日均线、成交量与有效期权持仓墙 |
| `#etf` | ETF 滚动资金、月度资金与价格、交易日明细 |
| `#options/oi` | 持仓位置；同区可切换 Gamma、波动定价、IBIT，并选择 Deribit 到期日 |
| 更多观察 | `#market` 情绪、`#onchain` 链上、`#seasonality` 历史回报、`#defi` 流动性 |
| 数据说明 | `#health` 数据健康、`#methodology` 来源与基本面 |

移动端采用单列、底部导航及单行横向标签，减少长页面滚动。主要图表支持放大；图表内上下手势保留页面滚动，左右操作读取数据。新手/专业模式只改变补充信息的展开，不改变结论规则。

虚线术语及“口径与来源”打开底部弹层，包含来源、方法、样本、更新时间和局限。支持系统“图片＋链接”分享；不支持文件分享时提供保存图片、复制链接，具体行为取决于浏览器和系统。

首屏在 HTML 中预设新版样式、顶部操作和期权面板；加载前按 hash 选定分区，避免先显示全部详情再折叠。禁用 JavaScript 或初始化失败时会显示说明。提供 favicon、Apple 主屏幕图标、深色 theme-color 及静态 OG / Twitter 预览信息；预览图不包含实时价格，微信等平台的卡片效果仍取决于其抓取和缓存机制。未加入离线 Service Worker。

## 本地运行

需要 Node.js **20 或更高版本**。无需 `npm install`；仅更新 IBIT 数据时额外需要可运行的 Longbridge CLI。

```bash
npm start
```

Windows 也可双击 `start.cmd`。启动器会先逐模块更新静态数据，再启动服务并打开页面；某个来源更新失败，不阻止其他模块更新或页面启动。

只启动服务、不做启动前更新：

```bash
npm run serve
```

打开 [本地页面](http://127.0.0.1:4173/)。关闭服务进程即可停止；不要以直接双击 `index.html` 代替本地 HTTP 服务，否则动态接口不可用。

### 本地只读接口

- `/api/data/market`：现货、全市场概览、BTC 已收盘日 K；`candles[].volume` 为 BTC，`volumeQuote` 为 USDT。
- `/api/data/sentiment`：恐慌贪婪当前值与历史。
- `/api/data/onchain`：区块高度、费率、内存池，保留逐字段来源和单位。
- `/api/data/defi`：公链 TVL 与稳定币供给。
- `/api/health`：动态模块状态、来源、抓取时间、截止日期和本机更新状态。
- `/api/gamma`：Deribit 期权结构、多个到期日样本与模型 Gamma。

前五类接口采用 `status / updatedAt / sources / data` 外层结构。**`/api/gamma` 不使用该统一封装**：`asOf`、`expirySnapshots`、`oiByStrike`、`byStrike` 等位于顶层；失败时可能返回 HTTP 503 与不可用状态。

服务运行后可检查接口：

```bash
npm run check:live
```

## 数据来源与计算边界

公开接口可能限流、调整结构或暂时不可达；本项目不保证上游持续可用，也不承诺第三方服务长期免费。

### 价格、ETF 与其他来源

- **现货与日 K**：Gate 官方 BTC/USDT；CoinGecko 提供价格备用及市场概览。USDT 与 USD 报价不完全相同。
- **ETF**：Farside 完整表优先，失败时尝试 SoSoValue V2；不依赖 KZG Flow。备用窗口会与已有重叠日期核对，保留窗口外历史；金额统一为百万美元。
- **情绪**：Alternative.me 恐慌贪婪指数，配合 BTC 日 K 展示；并非全部投资者情绪的直接测量。
- **链上**：Blockstream 优先，按字段回退 Blockchair / mempool.space；vbytes 与 bytes、sat/vB 与 sat/byte 不静默混用。
- **流动性**：DefiLlama 公链 TVL 与稳定币供给，不等同于流入 BTC 的净资金。
- **历史回报**：Gate 日 K 重建月度、季度与年度矩阵；完整月末价格与当月截至最新已收盘日的回报分开处理。

### 趋势不是预测

使用连续已收盘日 K 的简单均线：收盘价 > MA20 > MA60 为上方，反向排列为承压，其他排列为方向未一致。不足 60 日、日期不连续或数据失效时暂停方向结论。均线、成交量和期权点位用于验证结构，不构成自动交易信号。

### OI 墙与 Gamma 是两种不同统计

Deribit 仅覆盖该交易所的 BTC 反向期权，不代表全市场；IBIT 是独立的美股 ETF 期权静态序列，不与 Deribit 数量混算。

- **到期日**：默认选至少六天后的最近到期日；可切换快照中返回的其他未来到期日。一个期限的数据失效，不静默借用另一期限的结果。
- **持仓墙**：同一期限全部已知非负 OI 按行权价汇总，分别找 Call / Put 最大值；并列主点位取较低价。OI 单位为 BTC，Call 向上、Put 向下仅是画法。缺 IV 或位于 Gamma 价区外的 OI 仍保留；样本不完整时不输出完整墙结论。
- **Gamma**：取指数代理价上下 25% 合约，以远期价、利率、IV、剩余时间计算反向期权 Black-Scholes Gamma，再计算 `Gamma × OI(BTC) × 指数代理价² × 1%`。指数代理价为 `远期价 × exp(-rT)`，不重复乘合约乘数。
- **覆盖率**：Gamma 合约覆盖至少 70%、已知正 OI 覆盖至少 85% 才输出模型结果。Call 记正、Put 记负是代理假设，不是已知的做市商净持仓；Gamma 峰值不能改名为持仓墙。

期权结构保留 `schemaVersion: 2`，用独立的 `oiStatus`、`gammaStatus` 表示可用性。Gamma 输入不足但 OI 可用时仍返回部分可用的持仓样本，GEX 为 `null`、模型行为空；不会伪造零敞口。

### IV 与历史波动

先选最接近所选到期远期价的上市行权价，再取该价 Call / Put 标记 IV 平均值。只有双侧有效才输出前端比较，不用全链 IV 中位数代替 ATM IV，也不做固定期限插值。

历史波动 RV 使用近 N 日对数收益的样本标准差 × √365.25；N 为期权快照时剩余天数四舍五入，仅接受 7–90 日连续样本。还会检查日 K 抓取新鲜度，以及末根日期与期权快照是否相隔不超过 2.5 天。

到期简化区间为 `指数代理价 ± 指数代理价 × IV × √(剩余天数 / 365.25)`，IV 在公式中使用小数。它是一倍波动幅度的近似，不是保证覆盖率；没有历史 IV 分位，因此不直接判断期权“贵/便宜”。

## 快照、新鲜度与刷新

- **本地模式**：浏览器请求本机接口，服务端访问上游并缓存；浏览器还有成功结果缓存。来源失败可能降级到旧值，仍保留原始时间。
- **Pages 模式**：浏览器读取构建后的 JSON，不直接访问上游。页面标记 `SNAPSHOT` / `PARTIAL SNAPSHOT`，不是浏览器打开时的实时行情。
- **当前结论与历史读数分开**：新鲜度、样本或期限不满足条件时暂停相应结论；历史图表可带日期保留。缺失值显示为空，不生成演示数据填补。
- **动态有效期**：Pages 整体构建超过 6 小时标为过期；新首页还检查行情/期权自身时间，已到期合约停止当前位置与模型结论。来源健康页可能更早显示源数据逾期。
- **静态有效期**：ETF、IBIT 按超过 2 个已完成 UTC 工作日检查，季节性按 2 个自然日检查；工作日只排除周末，不是完整美国休市日历。
- **Gamma 回退**：上游请求失败时可保留不超过 24 小时的最后成功模型快照，并标明降级。这个保留窗口不等于当前结论的 6 小时有效期。

Pages 页面在可见时约每 5 分钟检查新快照；隐藏时停止轮询与定时重绘，返回前台或从往返缓存恢复时按条件检查。手动“刷新”检查最新版本并重试失败项，不刷新整页或主动跳回顶部；选中的期限仍存在时保留选择。

- **先显示、再核对**：页面先读取通过结构与保留期限校验的上次成功值，标为缓存，再请求 manifest；原始来源日期不变。浏览器缓存不能延长价格、期权或快照的有效期。
- **版本复用**：manifest 使用 `no-store` 且有超时；快照 URL 带 `?v=<generatedAt>` 并允许 HTTP 缓存。版本未变、已有该版有效数据时不再下载；缺失项仍会重试。`static.json` 同步原位更新 ETF 等静态序列。
- **失败与隔离**：客户端按站点路径、API/快照模式和缓存格式版本隔离数据；坏 JSON、结构错误、生成批次不符的响应不覆盖成功缓存。存储被禁用时仍可正常联网。Pages 设备缓存保留 6 小时用于预显示；本地 API 回退保留原规则（行情 24 分钟、链上与 Gamma 1 小时、情绪与 DeFi 3 小时、健康文件 12 分钟）。缓存保留期不是来源有效期，仍须检查原始日期；同一页面内已加载的旧图可继续展示，但超时结论停用。
- **混合批次**：部分文件更新失败时沿用各自旧日期；全局快照新鲜度保守采用已加载文件与静态数据的最旧批次，避免一个新文件把旧批次重新标为新鲜。
- **代码资源**：JS/CSS 按文件内容计算 SHA-256 指纹，不随纯数据刷新无故失效；代码或样式改版仍需重新加载页面生效。

Pages 发布层将 JSON 紧凑化，并仅保留 DeFi 图表实际使用的最近 740 条有效稳定币记录，保留 30 日比较所需缓冲；不修改上游缓存或本地完整历史。Gamma 多到期日样本和计算元数据、K 线字段结构均保持不变。

## 更新静态数据

先校验或试运行，不写入：

```bash
npm run validate
node scripts/update-static-data.mjs --only=ibit --dry-run
node scripts/update-static-data.mjs --only=seasonality --dry-run
node scripts/update-static-data.mjs --only=etf --etf-source=auto --dry-run
```

写入指定模块，或写到独立文件复核：

```bash
node scripts/update-static-data.mjs --only=ibit,seasonality
node scripts/update-static-data.mjs --only=seasonality --output ./data.next.js
node scripts/validate-static-data.mjs ./data.next.js
```

单次 `update-static-data.mjs` 会先构建、完整校验，再原子写入；失败保留目标文件。`--dry-run` 优先于 `--output`，不会落盘。

日常一键更新用 `npm run update` 或 `update.cmd`。编排器把季节性、IBIT、ETF 分开更新，一项失败不阻止其他项；执行前后校验，并保存运行锁、日志和更新前备份。

ETF 可用 `--etf-source=farside` 或 `--etf-source=sosovalue` 排查单一来源。若需浏览器保存的 Farside 完整 HTML，可保存 [BTC 完整表](https://farside.co.uk/bitcoin-etf-flow-all-data/) 与 [ETH 完整表](https://farside.co.uk/ethereum-etf-flow-all-data/)，同时提供两份文件：

```bash
node scripts/update-static-data.mjs --only=etf --farside-btc-html ./snapshots/farside-btc.html --farside-eth-html ./snapshots/farside-eth.html
```

IBIT 更新器调用下列 CLI，并验证日期、Call/Put 成交量、比率和总 OI；CLI 缺失或无可用数据时保留旧快照：

```bash
longbridge option volume daily IBIT.US --count 90 --format json
```

可用 `--longbridge-bin <路径>` 指定 CLI。账户、权限及接口可用性以实际安装环境为准；BTC 其他模块不依赖它。

## GitHub Pages + Actions

仓库 Pages 设置中选择 **GitHub Actions**。推送到 `main` 或手动运行 `Refresh data and deploy Pages` 会构建发布；工作流另设 **UTC 每小时第 37 分钟**运行，实际开始时间不保证准点。

Actions 使用 Node.js 24，尝试刷新季节性和 ETF，失败则沿用仓库内通过校验的静态数据；**不自动运行 IBIT CLI 更新**。动态模块由 runner 抓取后生成快照。自动刷新不回写仓库提交；Deribit last-good 通过 Actions cache 尽力保留。

本地复现与验证：

```bash
npm run validate
npm run test:deribit
npm run test:experience
npm run test:structure
npm run test:snapshots
npm run build:pages
npm run validate:pages
```

产物为 `dist-pages/`，只发布白名单内容：页面、前端资产、`data.js`、生成的 `deployment.js`、`.nojekyll` 和 `snapshots/` JSON。快照包括 market、sentiment、onchain、defi、gamma、health、manifest 和 static；不发布 `.runtime/`、服务器源码、更新脚本、日志或备份。

不要将整个仓库根目录作为 Pages artifact。构建使用相对资源路径，适配 `/<仓库名>/` 项目站点；域名设置由 GitHub Pages 管理。

## Windows 定时更新

```bat
auto-update.cmd install
auto-update.cmd status
auto-update.cmd remove
auto-update.cmd install --time=09:00
```

默认每天 **系统本地时间 08:30**，以当前登录用户运行，错过后在系统可用时补跑，并忽略并发实例。不是云端任务；关机或未登录时不能保证运行。移动项目目录前先移除任务，再从新目录安装。

安装时记录 Node 与可发现的 Longbridge CLI 路径。状态在 `.runtime/last-update.json`，日志在 `.runtime/logs/`，备份在 `.runtime/backups/`；移除计划任务不删除这些历史文件。

## 文件职责

- `index.html`、`styles.css`、`enhancements.css`：基础结构与图表样式。
- `experience.js`、`experience.css`：扫描首页、详情路由、移动端、弹层、放大与分享。
- `experience-math.js`：均线、连续性、RV、持仓峰值及区间的纯计算。
- `app.js`：数据应用、原位刷新、来源状态与基础图表；向体验层提供运行时数据。
- `snapshot-client.js`：版本化取数、缓存预读取、超时、校验、隔离与失败回退。
- `scripts/lib/public-assets.mjs`：发布资产白名单、内容指纹及 DeFi 快照裁剪。
- `favicon.svg`、`apple-touch-icon.png`、`og-image.png`：图标与静态分享预览；生成记录见 `SOCIAL_ASSETS.md`。
- `data.js`：ETF、IBIT、月末价格和季节性静态历史；`deployment.js`：本地/快照运行配置。
- `server.mjs`、`scripts/lib/`：上游适配、缓存、期权计算与数据更新校验逻辑。
- `scripts/`：启动、更新、测试、构建、契约检查与 Windows 调度脚本。
- `.github/workflows/pages.yml`：定时刷新、校验、白名单构建与部署。

仅用于研究观察，不构成投资建议。
