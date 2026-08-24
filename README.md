# BTC Capital Pulse

免费公开数据驱动的比特币研究仪表盘，覆盖 ETF 资金流、价格与市值、恐慌贪婪、Bitcoin 链上、IBIT 期权快照、BTC Gamma、历史季节性及 DeFi 流动性。

趋势图采用统一阅读方式：绿色表示资金、上涨或看涨成交，橙色表示 BTC 价格或比率，红色表示净流出或下跌。恐慌贪婪采用仪表盘，并以右轴曲线叠加在 90 天 BTC 日 K 线的同一绘图区；各分区顶部提供自动生成的“先看结论”。

## 本地运行

Windows 直接双击 `start.cmd`：它会先逐模块更新数据，再启动本地服务并打开页面。单一来源失败时仍会使用上次通过校验的快照，不会阻止页面启动；关闭命令窗口即可停止服务。

也可以在终端使用：

```bash
npm start
```

若只想启动、不执行启动前更新，可运行 `node server.mjs`，然后打开 `http://127.0.0.1:4173/`。页面运行时只请求本机 `/api/*`，由本地服务统一访问、归一化并缓存公开上游。直接打开 `index.html` 只能查看静态快照，动态模块会明确显示不可用。

本地只读数据端点：

- `/api/health`：动态模块、逐来源抓取时间、数据截止日、备用源和缺失字段。
- `/api/data/market`：BTC/ETH 等现货、全市场概览和 BTC 日 K。
- `/api/data/sentiment`：恐慌贪婪历史与当前值。
- `/api/data/onchain`：区块高度、费率与内存池，保留每个字段的来源和单位。
- `/api/data/defi`：公链 TVL 与稳定币供给序列。
- `/api/gamma`：Deribit BTC 期权 OI 与标记 IV 驱动的模型 Gamma 聚合代理。

所有统一端点都返回 `status`、`updatedAt`、`sources` 和 `data`；服务端使用短时资源缓存、请求合并和上次成功值回退，浏览器端另保留一层本地成功缓存。可在服务运行时检查数据契约：

```bash
node scripts/check-live-services.mjs
```

页面“数据健康”分区把动态数据与静态快照分开：动态模块同时显示本地抓取时间和上游数据自身截止日；静态 ETF、IBIT 与季节性显示快照日期、最近本机更新结果和自动更新时刻。更新失败只标为“需检查”并继续使用旧快照，不会把旧数据伪装成实时数据。

主要时间序列图使用统一交互：按钮按主数据最后日期过滤自然日范围，滚动指标先在完整历史上计算再截取；历史覆盖不足的范围会自动禁用。鼠标悬停、触摸或键盘方向键可读取日期和口径值。ETF 滚动资金图可选叠加同日 BTC K 线，月度 ETF、恐贪和 DeFi 图可分别关闭 BTC 或辅助曲线。

## GitHub Pages + Actions 发布

项目已经支持两种运行模式：本地服务继续读取 `/api/*`；GitHub Pages 读取 Actions 构建时生成的 `snapshots/*.json`。公网版会显示 `SNAPSHOT` 或 `PARTIAL SNAPSHOT`，不会把定时快照标成实时数据。

首次发布：

1. 在 GitHub 新建一个仓库，并把本目录内容推送到 `main` 分支。
2. 打开仓库 `Settings → Pages`，在 `Build and deployment` 中把 `Source` 设为 `GitHub Actions`。
3. 打开 `Actions → Refresh data and deploy Pages`，点击 `Run workflow` 执行首次部署。
4. 部署完成后，网址通常为 `https://<GitHub 用户名>.github.io/<仓库名>/`。

工作流位于 `.github/workflows/pages.yml`：在推送到 `main`、手动触发以及每两小时的第 23 分钟运行。GitHub 的计划任务不是精确定时服务，高峰期可能延迟；公开仓库长期无活动时，GitHub 也可能暂停计划任务，因此健康页始终同时展示快照生成时间和上游数据截止时间。连续 6 小时没有新构建时，公网版会明确标记 `STALE SNAPSHOT`。

Pages 构建不需要 API Key，也不会回写自动提交。它会尽力更新 Gate.io 季节性和 Farside/SoSoValue ETF 数据；IBIT 的 Longbridge CLI 快照暂时沿用仓库中的最后一次有效数据。动态行情、恐贪、链上、DeFi 与 Deribit Gamma 会在 Actions runner 中抓取后固化为 JSON。Actions cache 会保存最近一次成功的 Deribit 快照；本次抓取失败时可沿用 24 小时内的最后成功值并明确标为降级，超过窗口后停止展示。

本地复现 Pages 构建：

```bash
npm run validate
npm run build:pages
```

发布目录是被 `.gitignore` 排除的 `dist-pages/`。构建器只允许以下内容进入产物：HTML、CSS、前端 JS、`data.js`、部署配置和公开 JSON 快照；不会包含 `.runtime/`、备份、日志、更新脚本、服务器源码或本地配置。不要把整个项目根目录改成 Pages artifact。

如需绑定域名，可在首次部署成功后从 `Settings → Pages → Custom domain` 添加；仓库名路径已经使用相对 URL，不需要为了项目站点修改前端路径。

## 数据原则

- `LIVE`：本次从公开接口成功取得。
- `PARTIAL`：模块仍可读，但至少一个字段或备用源暂不可用。
- `SNAPSHOT` / `PARTIAL SNAPSHOT`：GitHub Actions 构建时的成功或部分成功快照，不代表浏览器打开这一刻的实时值。
- `CACHED`：接口暂时不可达，使用本浏览器中未过期的上次成功结果。
- `STATIC`：明确截止日期的 ETF、IBIT 期权和历史回报公开数据快照。
- `UNAVAILABLE`：实时接口和缓存均不可用；页面显示空值，不以演示数字替代。

每项数据的口径和来源链接均就近展示在页面中。

- BTC/ETH 现货价格与 BTC 日 K 线优先读取 Gate.io 官方公开 API；CoinGecko 仅作价格备用，并提供市值与全市场结构。
- ETF 资金流不依赖 KZG Flow。更新器优先读取 Farside Investors 完整表；Cloudflare 阻断时回退到 SoSoValue V2 公开接口的 300 个交易日窗口，自动与既有 Farside 重叠区间做差异校验，再写入本地快照。

## 静态数据更新与校验

更新脚本仅依赖 Node.js 内置模块（建议 Node.js 20 或更高版本），不需要安装 npm 包。所有被选模块会先在内存中完成，再统一校验；只有全部通过后才把临时文件原子替换为目标文件。抓取、字段或校验任一步失败都不会修改旧数据。

先检查当前快照：

```bash
node scripts/validate-static-data.mjs
```

校验内容包括日期严格升序、重复日期、ETF 日值/月度汇总、IBIT 最新快照与日序列、月末价格与季节性回报互相复算，以及热力图年份、12 个月列和回报范围。失败时进程退出码为 `1`，可直接接入计划任务或 CI。

分模块试运行，不落盘：

```bash
node scripts/update-static-data.mjs --only=ibit --dry-run
node scripts/update-static-data.mjs --only=seasonality --dry-run
```

更新指定模块并写回 `data.js`：

```bash
node scripts/update-static-data.mjs --only=ibit,seasonality
```

日常使用可直接双击 `update.cmd`。它把季节性、IBIT 和 ETF 分成三个独立提交单元：任一模块失败不会阻止其他模块成功写入；更新前后都会独立校验，并在 `.runtime` 保存状态、月度日志和更新前备份。

也可以用 `--output` 写入另一个文件，先人工复核再替换正式快照：

```bash
node scripts/update-static-data.mjs --only=seasonality --output ./data.next.js
node scripts/validate-static-data.mjs ./data.next.js
```

`--dry-run` 的优先级高于 `--output`，两者同时出现时不会产生文件。

### ETF：Farside 首选，SoSoValue 自动回退

脚本会先识别 Farside BTC 与 ETH 页面中含 `Date` 和 `Total` 的完整表格，括号数值解析为负数，空白及横线解析为 `0`。新表首日变晚、末日倒退或行数缩短时会拒绝覆盖，防止结构正确但历史被截断的页面抹掉旧数据。

直接请求遭遇 Cloudflare 时，默认 `auto` 模式会读取 SoSoValue V2 的 BTC/ETH `totalNetInflow`。接口每次返回 300 个交易日，金额从 USD 换算为百万美元；写入前会对既有重叠日期计算中位差和 P95 差异，超过阈值即安全失败。滚动窗口以外的本地历史会保留，因此后续更新不会缩短 1Y 图表。

可显式选择来源做试运行：

```bash
node scripts/update-static-data.mjs --only=etf --etf-source=sosovalue --dry-run
node scripts/update-static-data.mjs --only=etf --etf-source=farside --dry-run
```

Cloudflare 拦截时，在浏览器分别打开 Farside 的 [Bitcoin ETF Flow](https://farside.co.uk/bitcoin-etf-flow-all-data/) 和 [Ethereum ETF Flow](https://farside.co.uk/ethereum-etf-flow-all-data/)，将“完整网页”保存为 HTML（不是截图），然后执行：

```bash
node scripts/update-static-data.mjs --only=etf --farside-btc-html ./snapshots/farside-btc.html --farside-eth-html ./snapshots/farside-eth.html
```

BTC 与 ETH 两张表必须同时成功；任一文件不完整都不会写入半成品。

### IBIT：Longbridge CLI 公共期权量

IBIT 使用无需登录的公开命令：

```bash
longbridge option volume daily IBIT.US --count 90 --format json
```

脚本实际读取 `timestamp`、Call/Put 成交量、Put/Call 成交量比率和总未平仓量，校验比率后按交易日合并到既有 `daily`，并让 `snapshot` 始终等于最后一行。CLI 不存在、超时、返回非 JSON 或缺字段时会报出具体字段并保留旧数据。

### Gate.io：月末价格与季节性

脚本按不超过 900 天的窗口分页请求 Gate.io 官方 `BTC_USDT` 日 K，从 2013 年开始去重并排序。`btcMonthly` 只写入拥有月末日 K 的完整月份；热力图允许把最新已收盘日计算为本月迄今回报。任一页失败、月份断档或历史长度异常都会终止整次更新。

### 建议更新频率

- ETF：每个美国交易日收盘且 Farside 更新后执行一次；页面受 Cloudflare 保护时使用当天保存的 HTML。
- IBIT：每个美国期权交易日收盘后执行一次。
- Gate.io 季节性：每天一次即可；若只关心完整月度价格，可在每月 1 日执行。
- 自动任务先使用 `--dry-run`，确认连续数日稳定后再启用正式写入；正式写入后再运行一次独立校验。

## Windows 自动更新

项目内置 Windows 计划任务管理器，不需要管理员权限，默认每天北京时间 `08:30` 更新。启用、检查和关闭：

```bat
auto-update.cmd install
auto-update.cmd status
auto-update.cmd remove
```

可在安装时指定时间，例如 `auto-update.cmd install --time=09:00`。任务采用“错过后补跑”和“忽略并发实例”，应用层另有原子更新锁；项目移动目录后应先 `remove`，再从新目录 `install`。安装时会记录 Longbridge CLI 的绝对路径，避免计划任务环境的 `PATH` 不同导致 IBIT 更新失效。

运行状态写入 `.runtime/last-update.json`，日志写入 `.runtime/logs/`，更新前备份写入 `.runtime/backups/`。这些文件只属于当前本地副本，不参与页面数据口径。

## 链上拥堵数据与回退

- 链上拥堵与区块高度优先使用 Blockstream Esplora 公共 API；主源不可用时，按指标回退到 Blockchair 或 mempool.space。
- Blockstream 的 `mempool.vsize` 是内存池交易的总虚拟体积（virtual bytes）；Blockchair 的 `mempool_size` 是字节数（bytes）。两者不是同一口径，页面会保留来源和单位，不把跨源变化直接比较为同一序列。
- 费率优先采用 Blockstream 按确认目标给出的 sat/vB 估算；mempool.space 可提供同单位备用。Blockchair 的建议值口径为 sat/byte，仅作备用参考，不与 sat/vB 静默混用。

## 期权与 Gamma

期权模块包含两个互不混算的数据集：带交易日的 IBIT 上市期权静态快照，用于观察美国现货比特币 ETF 期权成交结构；Deribit BTC 反向期权公开数据用于估算单一交易所的 Gamma 分布。两者都不等同于全市场期权情绪。

Gamma 图读取 Deribit 官方公开 `get_instruments` 与 `get_book_summary_by_currency`，使用 OI、标记 IV、利率、到期时间和到期参考远期价计算反向期权 Black-Scholes Gamma，无需 API Key。模型先按 `指数代理价 = 到期远期价 × exp(-rT)` 还原指数口径，再选取至少六天后最近到期日，将指数代理价上下 25% 内的合约按行权价聚合：`模型 Gamma × OI（BTC）× 指数代理价² × 1%`；Deribit 的 OI 已按 BTC 基础币数量表达，不重复乘合约乘数。覆盖率分母来自所选到期日的 instruments 合约全集；合约覆盖低于 70% 或已知 OI 覆盖低于 85% 时不会生成新结果。快照带 `schemaVersion: 2`，旧公式或非 Deribit 缓存不会被沿用。Call 记正、Put 记负只是统一的可视化代理假设，并非观察到的做市商真实持仓。

## 文件

- `index.html`：页面结构与数据字典
- `styles.css`：应用界面与响应式样式
- `enhancements.css`：Gamma、热力图及后续增强模块的补充样式
- `data.js`：ETF 资金流、历史价格、IBIT 期权及季节回报静态快照
- `app.js`：统一数据端点消费、浏览器缓存、状态、今日三句话与图表
- `deployment.js`：本地动态 API 模式；Pages 构建时会被替换为相对路径快照配置
- `server.mjs`：零 npm 依赖的本地静态服务器、公开上游适配、双层缓存和 Gamma 聚合
- `.github/workflows/pages.yml`：定时刷新、白名单构建并部署 GitHub Pages
- `scripts/build-pages.mjs`：抓取统一接口并生成安全的 `dist-pages/` 发布产物
- `scripts/check-live-services.mjs`：本地服务契约与可用性检查
- `scripts/update-static-data.mjs`：零 npm 依赖的 ETF、IBIT 与季节性更新器
- `scripts/validate-static-data.mjs`：可独立运行、失败返回非零退出码的快照校验器
- `scripts/run-update.mjs`：带运行锁、模块隔离、日志和备份的一键更新编排器
- `scripts/start-local.mjs`：启动前更新、端口识别、服务就绪检查与页面打开
- `scripts/manage-schedule.mjs`：Windows 自动更新计划任务的安装、状态和移除
- `start.cmd` / `update.cmd` / `auto-update.cmd`：双击入口
