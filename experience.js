(() => {
  "use strict";
  const $ = id => document.getElementById(id), M = globalThis.PulseMath;
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const usd = v => Number.isFinite(v) ? "$" + Math.round(v).toLocaleString("en-US") : "—";
  const pct = v => Number.isFinite(v) ? `${v > 0 ? "+" : ""}${v.toFixed(1)}%` : "—";
  const date = v => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "时间待确认";
  const put = (id, value) => { const node = $(id); if (node && node.textContent !== value) node.textContent = value; };
  const C = { text: "#e5eade", muted: "#99a394", grid: "#30372f", green: "#93ceac", red: "#e79a89", gold: "#e9b76b", blue: "#a4b7ef" };
  let api, state = {}, selectedExpiry = "", trendRange = 90, hoverIndex = null, activeView = "", frame, zoomRestore, lastFocus, sheetScroll = 0;
  const viewScroll = new Map(), tabValues = new Map();
  const charts = new Map();
  function dataset() {
    const g = state.gamma;
    const samples = Array.isArray(g?.expirySnapshots) ? g.expirySnapshots : [];
    return samples.find(x => x.expiry === selectedExpiry) || g;
  }
  function oiRows(g = dataset()) { return g?.oiByStrike || []; }
  function daysLeft(g) {
    const expiry = g?.expiryTimestamp || Date.parse(`${g?.expiry}T08:00:00Z`);
    return (expiry - Date.parse(g?.asOf || state.gamma?.asOf || "")) / 86400000;
  }
  function ivOf(g) { return g?.atmIv?.status === "live" && Number.isFinite(g.atmIv.value) ? g.atmIv.value : null; }
  function comparableRv(g) {
    const last = Date.parse(state.candles?.at(-1)?.date || ""), optionTime = Date.parse(state.gamma?.asOf || ""), age = optionTime - last;
    if (!M.fresh(state.candleAsOf) || state.snapshotStale || !Number.isFinite(age) || age < 0 || age > 2.5 * 86400000) return null;
    return M.realizedVol(state.candles || [], daysLeft(g));
  }
  function validGamma(g) {
    return g && !state.snapshotStale && M.fresh(state.gamma?.asOf) && g.oiStatus !== "unavailable" && g.expiryTimestamp > Date.now();
  }
  function trendModel() {
    const ready = !["pending", "error", "stale"].includes(state.states?.trend?.dataState) && M.fresh(state.priceAsOf) && !state.snapshotStale;
    const latestDay = Date.parse(state.candles?.at(-1)?.date || ""), age = Date.now() - latestDay;
    return M.trend(state.candles || [], ready && age > 0 && age < 2.5 * 86400000);
  }
  function wallSet(g = dataset()) { return M.walls(oiRows(g)); }
  function selectedLevels() {
    const t = trendModel(), g = dataset(), w = wallSet(g), levels = [];
    if (t.ready) levels.push({ name: "20日均线", value: t.a, color: C.gold }, { name: "60日均线", value: t.b, color: C.blue });
    if (validGamma(g) && g.oiStatus === "live") {
      if (w.call) levels.push({ name: "看涨墙", value: w.call.strike, color: C.green });
      if (w.put) levels.push({ name: "看跌墙", value: w.put.strike, color: C.red });
    }
    return levels;
  }
  const noteEntries = {
    bitcoin: () => ["为什么观察比特币", "Bitcoin 是可全天交易的数字资产。这里观察价格、ETF 资金和期权持仓，不把任何单项指标当作买卖信号。", ["基本面", "协议供应上限约 2,100 万枚，平均出块目标约 10 分钟，区块补贴每 210,000 个区块减半。"], ["能回答", "价格结构、公开资金方向与已知持仓如何变化。"], ["不能回答", "无法覆盖全部场外交易、实际持仓意图或确定未来价格。"], ["来源", '<a href="https://bitcoin.org/bitcoin.pdf" target="_blank" rel="noreferrer">Bitcoin 白皮书</a> · <a href="https://developer.bitcoin.org/devguide/block_chain.html" target="_blank" rel="noreferrer">Bitcoin 开发文档</a>']],
    trend: () => ["趋势 · 先看已收盘数据", "收盘价 > 20日均线 > 60日均线时标为上方；反向排列为承压；其他排列为方向未一致。", ["计算方法", "20 / 60 个连续自然日收盘价的简单平均；不使用尚未收盘日 K。成交量取 Gate 现货 BTC 基础币成交量。日线不连续或不足 60 日时暂停结论。"], ["样本 / 更新", `${state.candles?.length || 0} 根日 K；末根 ${esc(state.candles?.at(-1)?.date || "—")}；抓取 ${date(state.candleAsOf)}。`], ["来源", '<a href="https://www.gate.com/docs/developers/apiv4/en/#market-candlesticks" target="_blank" rel="noreferrer">Gate BTC/USDT 日 K</a>；现价备用为 CoinGecko USD 聚合价。'], ["能 / 不能回答", "描述已发生的趋势排列，不能保证突破有效。日 K 为 USDT 报价，其他市场 USD 报价可能存在价差。"], ["平台差异", "交易所、时区、已收盘规则、简单或指数均线及现价时间不同，均会影响结果。"]],
    walls: () => { const g = dataset(); return ["看涨墙 / 看跌墙", "分别指所选到期日 Call / Put 未平仓量最多的行权价，是持仓集中点，不保证是阻力或支撑。", ["计算方法", "按行权价加总 OI，分别找 Call 与 Put 最大值；并列时取较低行权价。使用有效 OI 的全行权价样本，独立于 IV 和 Gamma 是否可计算。Put 向下仅为图形方向，数量不是负数。"], ["样本范围", `仅 Deribit BTC 反向期权，到期 ${esc(g?.expiry || "—")}；${oiRows(g).length} 个有记录行权价；数量单位 BTC，不混合 IBIT 张数。`], ["更新 / 来源", `${date(state.gamma?.asOf)} · <a href="https://docs.deribit.com/api-reference/market-data/public-get_book_summary_by_currency" target="_blank" rel="noreferrer">Deribit 官方公共 API</a>`], ["能 / 不能回答", "能定位已知 OI 集中处；不能识别持仓方、净多空意图或推断做市商必然如何对冲。"], ["平台差异", "到期日、交易所范围、币本位/币种、全行权价或近价筛选不同会改变峰值。Gamma 峰值额外受到 IV、剩余时间和模型影响，不能替代 OI 墙。"]]; },
    gamma: () => ["Gamma 敞口 · 模型代理", "显示价格小幅变化时，模型对冲敏感度如何分布。它不是做市商真实敞口。", ["计算方法", "Deribit 到期远期价 × exp(−rT) 推导指数代理价；Black-Scholes Gamma × 未平仓 BTC × 指数代理价² × 1%。Call 记正、Put 记负，仅为符号假设。"], ["样本范围", `所选到期日 ${esc(dataset()?.expiry || "—")}；近指数 ±25% 行权价，须有有效 OI、IV、利率与远期价。`], ["更新 / 来源", `${date(state.gamma?.asOf)} · <a href="https://docs.deribit.com/" target="_blank" rel="noreferrer">Deribit</a>`], ["能 / 不能回答", "可观察模型敏感度集中点；不能证明 dealer 净头寸，局部过零不是严格 Gamma Flip。"], ["平台差异", "模型、范围、期权币本位、利率、快照时间和符号假设会影响数值。"]],
    volatility: () => ["波动定价 · 不直接判断贵贱", "平值 IV 是市场对未来波动的定价；历史波动是已经发生的波动。两者不同不代表存在确定交易机会。", ["计算方法", "先选最接近到期远期价的上市行权价，再取该价 Call / Put 标记 IV 平均值；只有双侧有效才输出比较。历史波动为近 N 天日对数收益样本标准差 × √365.25，N 为剩余天数四舍五入，仅比较 7–90 天连续且新鲜的样本。"], ["模型区间", "指数代理价 ± 指数代理价 × IV × √(剩余天数 / 365.25)。是简化的一倍波动幅度，不是保本边界或保证覆盖率。"], ["样本 / 更新时间", `${esc(dataset()?.expiry || "—")} 到期；期权 ${date(state.gamma?.asOf)}；现货末根 ${esc(state.candles?.at(-1)?.date || "—")}。`], ["来源", '<a href="https://docs.deribit.com/" target="_blank" rel="noreferrer">Deribit 标记 IV</a> / <a href="https://www.gate.com/docs/developers/apiv4/en/" target="_blank" rel="noreferrer">Gate 日 K</a>。两端时间与市场不同。'], ["平台差异 / 局限", "ATM 选择、年化天数、回看长度和波动微笑插值不同。此处没有历史 IV 分位，不使用全链中位 IV 代替平值 IV，也不下“昂贵/便宜”的确定结论。"]]
  };
  function showSheet(title, html) {
    closeZoom(); lastFocus = document.activeElement; sheetScroll = window.scrollY;
    put("sheet-title", title); $("sheet-content").innerHTML = html;
    $("note-sheet").showModal(); document.body.classList.add("modal-open"); $("sheet-close").focus({ preventScroll: true });
  }
  function closeSheet() { $("note-sheet").close(); document.body.classList.remove("modal-open"); lastFocus?.focus({ preventScroll: true }); window.scrollTo({ top: sheetScroll, behavior: "instant" }); }
  function showNote(key) {
    const data = noteEntries[key]?.(); if (!data) return;
    const [title, intro, ...facts] = data;
    showSheet(title, `<p class="sheet-intro">${intro}</p><dl>${facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>`);
  }
  function toast(text) { put("experience-toast", text); $("experience-toast").classList.add("show"); setTimeout(() => $("experience-toast").classList.remove("show"), 4000); }
  function setupOptions() {
    $("expiry-select").addEventListener("change", () => { selectedExpiry = $("expiry-select").value; hoverIndex = null; render(); });
  }
  function tabSelect(group, value, focus = false) {
    const list = document.querySelector(`[data-mobile-tabs="${group}"]`); if (!list) return;
    const buttons = [...list.querySelectorAll('button')], panels = [...document.querySelectorAll(`[data-mobile-tab-panel="${group}"]`)];
    if (!buttons.some(x => x.dataset.mobileTabValue === value)) value = buttons[0]?.dataset.mobileTabValue;
    tabValues.set(group, value); list.setAttribute('role', 'tablist');
    buttons.forEach((b, i) => { const on = b.dataset.mobileTabValue === value; b.id ||= `tab-${group}-${i}`; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; b.classList.toggle('active', on); if (on && focus) b.focus({ preventScroll: true }); });
    panels.forEach((p, i) => { const on = p.dataset.mobileTabValue === value, b = buttons.find(x => x.dataset.mobileTabValue === p.dataset.mobileTabValue); p.id ||= `panel-${group}-${i}`; p.hidden = !on; p.classList.toggle('is-mobile-tab-inactive', !on); p.classList.toggle('is-mobile-tab-active', on); p.setAttribute('role', 'tabpanel'); p.setAttribute('aria-labelledby', b.id); b.setAttribute('aria-controls', p.id); });
    requestAnimationFrame(() => { api.redraw(); drawAll(); });
  }
  function setupTabs() {
    document.querySelectorAll('[data-mobile-tabs]').forEach(list => {
      const group = list.dataset.mobileTabs; tabSelect(group, group === 'options-detail' ? 'oi' : list.querySelector('button')?.dataset.mobileTabValue);
      list.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; tabSelect(group, b.dataset.mobileTabValue); if (group === 'options-detail') history.replaceState(null, '', `#options/${b.dataset.mobileTabValue}`); });
      list.addEventListener('keydown', e => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); const bs = [...list.querySelectorAll('button')], n = bs.findIndex(b => b.dataset.mobileTabValue === tabValues.get(group)); const next = e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : (n + (e.key === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length; tabSelect(group, bs[next].dataset.mobileTabValue, true); });
    });
  }
  function navigate(hash = '#overview', push = true) {
    const [key, tab] = hash.replace(/^#/, '').split('/'), view = document.querySelector(`main > section[id="${CSS.escape(key)}"]`) ? key : 'overview';
    if (activeView) viewScroll.set(activeView, window.scrollY);
    const changed = view !== activeView, leavingContent = document.querySelector('main')?.contains(document.activeElement); activeView = view;
    document.querySelectorAll('main > section').forEach(s => { s.hidden = s.id !== view; });
    document.querySelectorAll('.rail nav a,.bottom-nav a').forEach(a => { const on = a.hash === `#${view}`; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    setDrawer(false, false);
    if (push) history.pushState(null, '', `#${view}${tab ? '/' + tab : ''}`);
    if (view === 'options' && tab) tabSelect('options-detail', tab);
    if (changed) window.scrollTo({ top: viewScroll.get(view) || 0, behavior: 'instant' });
    if (changed && leavingContent) { const title = $(view).querySelector('h1,h2'); if (title) { title.tabIndex = -1; title.focus({ preventScroll:true }); } }
    requestAnimationFrame(() => { api.redraw(); drawAll(); });
  }
  function setupNotes() {
    document.querySelectorAll('.definition').forEach((node, index) => {
      node.id ||= `source-definition-${index}`; node.hidden = true;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'term source-term'; b.textContent = '口径与来源'; b.addEventListener('click', () => showLegacyNote(node)); node.before(b);
    });
    document.addEventListener('click', e => { const note = e.target.closest('[data-note]'); if (note) showNote(note.dataset.note); });
    $('sheet-close').addEventListener('click', closeSheet);
    $('note-sheet').addEventListener('click', e => { if (e.target === $('note-sheet')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeSheet(); } });
    $('note-sheet').addEventListener('cancel', e => { e.preventDefault(); closeSheet(); });
  }
  function showLegacyNote(node) {
    const section = node.closest('main>section')?.id || 'methodology';
    const s = state.staticData || {}, etf = s.sources?.etfFlows || {}, ibit = s.sources?.ibitOptions || {};
    const context = {
      etf: { source: etf.provider, url: etf.url, asOf:etf.asOf, scope:'美国现货 BTC / ETH ETF，交易日口径；单位百万美元。', use:'观察公开基金资金方向与价格的同步或背离，不识别全部机构交易，也不能证明资金流导致价格变化。' },
      options: { source:ibit.provider, url:ibit.url, asOf:ibit.asOf, scope:'IBIT.US 全部上市期权的日频成交和 OI，单位张；不与 Deribit BTC 单位混合。',use:'观察成交结构，不等于交易者净多空方向。' },
      seasonality:{source:'Gate.io',url:'https://www.gate.com/docs/developers/apiv4/en/#market-candlesticks',asOf:s.seasonality?.asOf,scope:`BTC/USDT ${Object.keys(s.seasonality?.years || {}).join('、')} 年；未完成月份 MTD 不纳入历史均值和胜率。`,use:'比较已发生的月份与季度分布，不预测本年度必然重演。'},
      market:{source:'Gate / CoinGecko / Alternative.me',asOf:state.priceAsOf,scope:'行情按资产对应市场；恐贪指数为 0–100 日频综合情绪。各子图以自身日期为准。',use:'观察情绪及相对涨跌，不能从恐慌或贪婪直接判断顶底。'},
      onchain:{source:'Blockstream / mempool.space / Blockchair',scope:'Bitcoin 主网区块、内存池与费用估算；来源按健康页的实际选用记录。',use:'观察结算拥堵，不能将费用或内存池大小直接解释为价格涨跌。'},
      defi:{source:'DefiLlama / Gate.io',scope:'DefiLlama 收录链和稳定币；与同日 BTC K 线组合。',use:'观察稳定币供给，不能等同于银行现金储备或推断全部资金会买入 BTC。'}
    }[section] || {source:'本站健康记录与各官方端点',scope:'页面实际使用的动态模块与静态快照。',use:'核对供数状态，不保证上游数据绝对准确。'};
    const copy = node.cloneNode(true), links = [...copy.querySelectorAll('a')].map(a => a.outerHTML).join(' · '); copy.querySelectorAll('a').forEach(a=>a.remove());
    let method = copy.innerHTML;
    if (context.asOf && ['etf','options'].includes(section)) method = method.replace(/\d{4}-\d{2}-\d{2}/g,esc(context.asOf));
    if (section === 'seasonality') method = '月回报 = 当月最后一个已收盘日 K ÷ 上月最后一个已收盘日 K − 1。季度须有 3 个完整月、全年须有 12 个完整月；否则显示 —。未完成月份带 *，不纳入均值及胜率。';
    const source = context.url ? `<a href="${esc(context.url)}" target="_blank" rel="noreferrer">${esc(context.source)}</a>` : links || esc(context.source);
    const updated = context.asOf || $(section)?.querySelector('.module-updated')?.textContent || '各子图显示自身截止日';
    showSheet('口径与来源', `<dl><div><dt>计算方法</dt><dd>${method}</dd></div><div><dt>数据来源</dt><dd>${source}</dd></div><div><dt>样本范围</dt><dd>${esc(context.scope)}</dd></div><div><dt>更新时间</dt><dd>${esc(updated)}</dd></div><div><dt>用途与边界</dt><dd>${esc(context.use)}</dd></div><div><dt>平台差异</dt><dd>统计范围、截止时点、时区、货币单位、补数与修订规则不同，可能产生不同结果。来源故障时的缓存不会改写数据截止日。</dd></div></dl>`);
  }
  function setDrawer(open, focus = true) {
    const rail = $('site-navigation'), mobile = matchMedia('(max-width:920px)').matches;
    document.body.classList.toggle('nav-open',mobile && open); $('mobile-menu').setAttribute('aria-expanded',String(mobile && open));
    rail.inert = mobile && !open; rail.setAttribute('aria-hidden',String(mobile && !open));
    if (focus && mobile) (open ? rail.querySelector('a') : $('mobile-menu'))?.focus({preventScroll:true});
  }
  function canvasContext(canvas) {
    if (!canvas || !canvas.getClientRects().length) return null;
    const width = canvas.clientWidth, height = canvas.clientHeight, ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = width * ratio; canvas.height = height * ratio; const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height); ctx.font = '13px "Microsoft YaHei", sans-serif'; return { ctx, w: width, h: height };
  }
  function empty(ctx, w, h, text) { ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.fillText(text, w / 2, h / 2); }
  function drawPosition() {
    const fit = canvasContext($('position-chart')); if (!fit) return; const { ctx, w, h } = fit;
    const price = state.price, levels = selectedLevels();
    if (!(price > 0) || !M.fresh(state.priceAsOf) || state.snapshotStale) return empty(ctx, w, h, '有效行情恢复后显示价格位置');
    const all = [...levels, { name: '现价', value: price, color: C.text }].sort((a, b) => a.value - b.value);
    const lo = Math.min(...all.map(x => x.value)) * .98, hi = Math.max(...all.map(x => x.value)) * 1.02;
    const x = v => 22 + (v - lo) / (hi - lo) * (w - 44), y = h / 2;
    ctx.fillStyle = '#283a30'; ctx.fillRect(22, y - 5, w - 44, 10);
    // Label lanes are separated from the true price coordinates by leader lines.
    all.forEach((p, i) => {
      const px = x(p.value), lane = i % 2, labelX = Math.max(48, Math.min(w - 48, 48 + Math.floor(i / 2) * ((w - 96) / Math.max(1, Math.ceil(all.length / 2) - 1))));
      const py = lane ? y + 36 : y - 41; ctx.strokeStyle = p.color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, y); ctx.lineTo(px, lane ? y + 15 : y - 15); ctx.lineTo(labelX, py + (lane ? -12 : 13)); ctx.stroke();
      ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(px, y, p.name === '现价' ? 5 : 3, 0, Math.PI * 2); ctx.fill(); ctx.textAlign = 'center'; ctx.fillText(p.name, labelX, py); ctx.font = 'bold 13px "Microsoft YaHei"'; ctx.fillText(usd(p.value), labelX, py + 18); ctx.font = '13px "Microsoft YaHei"';
    });
  }
  function drawTrend() {
    const fit = canvasContext($('trend-chart')); if (!fit) return; const { ctx, w, h } = fit;
    const all = state.candles || [], rows = all.slice(-trendRange); if (rows.length < 2) return empty(ctx, w, h, '日 K 数据暂不可用');
    const levels = selectedLevels(), visibleLevels = levels.filter(l => /墙/.test(l.name));
    const bottom = h - 85, left = 8, right = w - 78, top = 30, pw = right - left;
    const priceValues = [...rows.flatMap(r => [r.high, r.low]), ...visibleLevels.map(l => l.value), ...M.sma(all,20).slice(-rows.length).filter(Number.isFinite), ...M.sma(all,60).slice(-rows.length).filter(Number.isFinite)];
    const min = Math.min(...priceValues), max = Math.max(...priceValues), padding = (max - min || max * .1) * .1;
    const lo = min - padding, hi = max + padding, y = v => top + (hi - v) / (hi - lo) * (bottom - top), x = i => left + (i + .5) / rows.length * pw;
    ctx.textAlign = 'left';
    for (let i = 0; i < 5; i++) { const val = lo + (hi - lo) * i / 4, py = y(val); ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke(); ctx.fillStyle = C.muted; ctx.fillText(usd(val), right + 5, py + 4); }
    const maxVolume = Math.max(1, ...rows.map(r => r.volume || 0)), bar = Math.max(1, pw / rows.length * .65);
    rows.forEach((r, i) => { const px = x(i), color = r.close >= r.open ? C.green : C.red; ctx.strokeStyle = color; ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(px, y(r.high)); ctx.lineTo(px, y(r.low)); ctx.stroke(); ctx.fillRect(px - bar / 2, Math.min(y(r.open), y(r.close)), bar, Math.max(1, Math.abs(y(r.open) - y(r.close)))); if (Number.isFinite(r.volume)) { const vh = r.volume / maxVolume * 36; ctx.globalAlpha = .65; ctx.fillRect(px - bar / 2, h - 30 - vh, bar, vh); ctx.globalAlpha = 1; } });
    for (const [n, color] of [[20, C.gold], [60, C.blue]]) { const values = M.sma(all, n).slice(-rows.length); ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath(); let started = false; values.forEach((v, i) => { if (v === null) { started = false; return; } if (started) ctx.lineTo(x(i), y(v)); else ctx.moveTo(x(i), y(v)); started = true; }); ctx.stroke(); }
    let previous = -100;
    visibleLevels.sort((a,b) => b.value - a.value).forEach(l => { const py = y(l.value); ctx.setLineDash([5, 4]); ctx.strokeStyle = l.color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke(); ctx.setLineDash([]); const labelY = Math.max(py - 6, previous + 18); previous = labelY; ctx.fillStyle = '#111812'; ctx.fillRect(9, labelY - 14, 153, 18); ctx.fillStyle = l.color; ctx.fillText(`${l.name} ${usd(l.value)}`, 12, labelY); });
    ctx.fillStyle = C.muted; ctx.fillText(rows.some(r => Number.isFinite(r.volume)) ? '成交量 · BTC' : '成交量暂缺', 10, h - 70);
    ctx.fillText(rows[0].date.slice(5), 8, h - 6); ctx.textAlign = 'right'; ctx.fillText(rows.at(-1).date, right, h - 6);
    if (hoverIndex !== null) { const i = Math.min(rows.length - 1, Math.max(0, hoverIndex)), r = rows[i]; ctx.strokeStyle = '#c8cfc0'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x(i), top); ctx.lineTo(x(i), h - 25); ctx.stroke(); ctx.setLineDash([]); put('trend-readout', `${r.date} · 开 ${usd(r.open)} 高 ${usd(r.high)} 低 ${usd(r.low)} 收 ${usd(r.close)}${Number.isFinite(r.volume) ? ' · 量 ' + Math.round(r.volume).toLocaleString() + ' BTC' : ''}`); }
    charts.set('trend-chart', { rows, left, right });
  }
  function drawOi() {
    const fit = canvasContext($('oi-chart')); if (!fit) return; const { ctx, w, h } = fit;
    const rows = oiRows().filter(r => (r.callOi || 0) + (r.putOi || 0) > 0).sort((a,b) => a.strike - b.strike); if (!rows.length) return empty(ctx, w, h, '全行权价 OI 样本暂缺');
    const left = 12, right = w - 55, zero = h / 2, max = Math.max(...rows.flatMap(r => [r.callOi || 0, r.putOi || 0]), 1), space = right - left;
    const x = value => left + (value - rows[0].strike) / (rows.at(-1).strike - rows[0].strike || 1) * space;
    const gaps = rows.slice(1).map((r, i) => x(r.strike) - x(rows[i].strike)); const bar = Math.max(1, Math.min(14, ...(gaps.length ? gaps : [20])) * .65);
    ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(left, zero); ctx.lineTo(right, zero); ctx.stroke();
    rows.forEach(r => { const px = x(r.strike); for (const [key, color, sign] of [['callOi', C.green, -1], ['putOi', C.red, 1]]) { const height = (r[key] || 0) / max * (zero - 48); ctx.fillStyle = color; ctx.fillRect(px - bar / 2, sign < 0 ? zero - height : zero, bar, height); } });
    const spot = dataset()?.spot;
    if (spot >= rows[0].strike && spot <= rows.at(-1).strike) { ctx.strokeStyle = C.gold; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x(spot), 36); ctx.lineTo(x(spot), h - 34); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = C.gold; ctx.textAlign = 'center'; ctx.fillText(`指数 ${usd(spot)}`, Math.max(80, Math.min(w - 80, x(spot))), 20); }
    ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.fillText(Math.round(max).toLocaleString(), right + 5, 52); ctx.fillText('0', right + 5, zero + 4); ctx.fillText(Math.round(max).toLocaleString(), right + 5, h - 46);
    ctx.textAlign = 'left'; ctx.fillText(usd(rows[0].strike), left, h - 6); ctx.textAlign = 'right'; ctx.fillText(usd(rows.at(-1).strike), right, h - 6);
    const peaks = wallSet();
    for (const [peak,label,color,py] of [[peaks.call,'看涨墙',C.green,43],[peaks.put,'看跌墙',C.red,h-26]]) { if(!peak || dataset()?.oiStatus !== 'live') continue; ctx.fillStyle=color;ctx.textAlign='center';ctx.fillText(`${label} ${usd(peak.strike)}`,Math.max(78,Math.min(w-78,x(peak.strike))),py); }
    charts.set('oi-chart', { rows, left, right, priceX: x });
  }
  function drawVol() {
    const fit = canvasContext($('vol-chart')); if (!fit) return; const { ctx, w, h } = fit, g = dataset(), iv = ivOf(g), days = daysLeft(g), rv = comparableRv(g);
    if (!validGamma(g) || !(iv > 0)) return empty(ctx, w, h, '平值 IV 暂缺，暂停波动比较');
    const values = [{ label: '市场平值 IV', value: iv, color: C.gold }, { label: `过去 ${Math.round(days)} 天波动`, value: rv, color: C.blue }], max = Math.max(iv, rv || 0) * 1.2;
    values.forEach((r, i) => { const py = 48 + i * 87; ctx.fillStyle = C.text; ctx.textAlign = 'left'; ctx.fillText(r.label, 10, py - 16); ctx.fillStyle = C.grid; ctx.fillRect(10, py, w - 90, 19); if (r.value !== null) { ctx.fillStyle = r.color; ctx.fillRect(10, py, r.value / max * (w - 90), 19); } ctx.fillStyle = r.color; ctx.fillText(r.value !== null ? r.value.toFixed(1) + '%' : '不足', w - 68, py + 15); });
    const band = M.range(g.spot,iv,days);
    if(band) { const py=h-48;ctx.strokeStyle=C.gold;ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(40,py);ctx.lineTo(w-40,py);ctx.stroke();ctx.fillStyle=C.text;ctx.beginPath();ctx.arc(w/2,py,5,0,Math.PI*2);ctx.fill();ctx.font='12px "Microsoft YaHei"';ctx.textAlign='center';ctx.fillText(`指数 ${usd(g.spot)}`,w/2,py-12);ctx.textAlign='left';ctx.fillText(usd(band.low),10,py+26);ctx.textAlign='right';ctx.fillText(usd(band.high),w-10,py+26); }
  }
  function drawAll() { drawPosition(); drawTrend(); drawOi(); drawVol(); }
  function render() {
    state = api.read(); const t = trendModel(), capital = state.states?.capital, g = dataset(), walls = wallSet(g), gammaReady = validGamma(g), oiReady = gammaReady && g.oiStatus === 'live', iv = ivOf(g), days = daysLeft(g);
    put('scan-price', usd(state.price)); put('scan-change', `${pct(state.change)} · 24H`);
    put('scan-conclusion', `${t.ready ? t.label : '趋势暂待确认'}；${capital?.dataState === 'ready' ? 'ETF ' + capital.label : '资金结论待更新'}。`);
    put('scan-trend', t.ready ? t.tone === 'positive' ? '上方' : t.tone === 'negative' ? '承压' : '分歧' : '待确认');
    put('scan-trend-evidence', t.ready ? `收盘 ${usd(t.close)} · 20日 ${usd(t.a)}` : '待有效且连续的已收盘日 K');
    put('scan-capital', capital?.dataState === 'ready' ? capital.label : '待更新');
    put('scan-capital-evidence', `5日 ${capital?.primary || '—'} · 20日 ${capital?.secondary || '—'}`);
    put('scan-options', oiReady && (walls.call || walls.put) ? `${g.expiry?.slice(5) || '—'} 到期` : '待更新');
    put('scan-options-evidence', oiReady && (walls.call || walls.put) ? `Call ${usd(walls.call?.strike)} · Put ${usd(walls.put?.strike)}` : '等待完整持仓样本');
    put('scan-vol', gammaReady && iv > 0 ? iv.toFixed(1) + '%' : '待确认');
    put('scan-vol-evidence', gammaReady && iv > 0 ? `约 ${Math.round(days)} 天平值 IV · 尚不判断贵贱` : '等待所选期限平值 IV');
    put('position-date', `${state.provider || '现货'} ${date(state.priceAsOf)}${state.sourceStates?.market === 'cached' ? ' · 上次成功数据' : ''} · 均线截至 ${state.candles?.at(-1)?.date || '—'}${gammaReady ? ` · 期权 ${g.expiry} 到期 / ${date(state.gamma?.asOf)}` : ' · 期权位置待更新'}`);
    put('trend-conclusion', t.label); put('trend-date', `Gate BTC/USDT · 已收盘日 K 截至 ${state.candles?.at(-1)?.date || '—'} · 抓取 ${date(state.candleAsOf)}`);
    put('trend-observe', t.ready ? `观察后续日线收盘能否保持在 20日均线 ${usd(t.a)} ${t.close > t.a ? '上方' : '下方'}，以及 20日与60日均线的排列是否改变。均线会随每日新收盘价更新。` : '数据未齐备或已超出新鲜度窗口，暂不输出方向。');
    put('trend-pro', t.ready ? `MA20 ${usd(t.a)} / MA60 ${usd(t.b)}；已收盘价距 MA20 ${pct((t.close / t.a - 1) * 100)}。` : '均线须由完整连续样本计算。');
    const choices = state.gamma?.expirySnapshots || (state.gamma ? [state.gamma] : []);
    const select = $('expiry-select');
    if (choices.length && select.dataset.choices !== choices.map(r => r.expiry).join()) { select.dataset.choices = choices.map(r => r.expiry).join(); select.innerHTML = choices.map(r => `<option value="${esc(r.expiry)}">${esc(r.expiry)}</option>`).join(''); if (choices.some(r => r.expiry === selectedExpiry)) select.value = selectedExpiry; else { selectedExpiry = state.gamma.expiry; select.value = selectedExpiry; } }
    select.disabled = !choices.length;
    put('options-asof', `Deribit · ${date(state.gamma?.asOf)}${gammaReady ? (state.gamma?.stale || state.sourceStates?.gamma === 'cached') ? ' · 最近成功快照' : '' : ' · 历史值 / 待更新'}`);
    put('oi-conclusion', oiReady && (walls.call || walls.put) ? `Call 集中在 ${usd(walls.call?.strike)}，Put 集中在 ${usd(walls.put?.strike)}。` : '样本待补齐或待更新，仅展示已知持仓，不判断完整关键位置。');
    put('call-wall', usd(walls.call?.strike)); put('put-wall', usd(walls.put?.strike));
    put('call-distance', !oiReady ? '已知样本峰值 · 非完整结论' : walls.call && g.spot ? `距指数 ${pct((walls.call.strike / g.spot - 1) * 100)}` : '距离暂缺');
    put('put-distance', !oiReady ? '已知样本峰值 · 非完整结论' : walls.put && g.spot ? `距指数 ${pct((walls.put.strike / g.spot - 1) * 100)}` : '距离暂缺');
    put('oi-sample', `${oiRows(g).length} 个行权价 · OI 合约覆盖 ${Number.isFinite(g?.oiCoverage?.ratio) ? (g.oiCoverage.ratio * 100).toFixed(1) + '%' : '—'} · ${g?.expiry || '—'} 到期。`);
    const rv = comparableRv(g), range = gammaReady ? M.range(g?.spot, iv, days) : null;
    put('vol-conclusion', gammaReady && iv > 0 ? `平值 IV ${iv.toFixed(1)}%${rv !== null ? `，近 ${Math.round(days)} 天历史波动 ${rv.toFixed(1)}%` : '；近似同期限历史样本不足'}。` : '平值 IV 暂缺或快照待更新，暂停比较。');
    put('vol-range', range ? `到期简化区间 ${usd(range.low)} — ${usd(range.high)} · ±${range.percent.toFixed(1)}%` : '模型区间暂缺');
    put('vol-sample', `剩余约 ${Number.isFinite(days) ? days.toFixed(1) : '—'} 天 · 期权 ${date(state.gamma?.asOf)} / 现货日 K ${state.candles?.at(-1)?.date || '—'}`);
    const modelReady = gammaReady && g?.gammaStatus !== 'unavailable' && g?.byStrike?.length > 0;
    api.selectGamma(modelReady ? g : null);
    const gammaPanel = document.querySelector('.gamma-panel'); gammaPanel.classList.toggle('is-unavailable',!modelReady); gammaPanel.classList.toggle('is-live',Boolean(modelReady));
    put('gamma-state', modelReady ? g.gammaStatus === 'partial' ? '部分模型' : '模型可用' : '待更新');
    $('gamma-state').className = 'state-badge ' + (modelReady ? 'live' : 'partial');
    if (modelReady) { put('gamma-expiry', g.expiry); put('gamma-net', (g.netGex / 1e6).toFixed(2) + 'M USD / 1%'); put('gamma-max-pain', usd(g.maxPain)); put('gamma-pc-oi', Number.isFinite(g.putCallOiRatio) ? g.putCallOiRatio.toFixed(2) : '—'); const call = [...g.byStrike].filter(r => r.callGex > 0).sort((a,b)=>b.callGex-a.callGex)[0], p = [...g.byStrike].filter(r => r.putGex < 0).sort((a,b)=>a.putGex-b.putGex)[0]; put('gamma-positive', usd(call?.strike)); put('gamma-negative', usd(p?.strike)); $('gamma-key-insight').querySelector('span').textContent = `所选 ${g.expiry}：Call 模型峰值 ${usd(call?.strike)} / Put 模型峰值 ${usd(p?.strike)}；这是敏感度峰值，与 OI 持仓墙不同。`; put('gamma-message',`所选期限模型合约覆盖 ${Number.isFinite(g.coverage) ? Math.round(g.coverage*100)+'%' : '—'} · ${date(state.gamma?.asOf)}`); }
    else { ['gamma-net','gamma-positive','gamma-negative','gamma-max-pain','gamma-pc-oi'].forEach(id => put(id,'—')); put('gamma-expiry',g?.expiry || '—'); put('gamma-message','所选期限模型数据待更新；持仓位置可独立查看。'); $('gamma-key-insight').querySelector('span').textContent = '不从其他到期日借用模型结果。'; }
    drawAll();
  }
  function bindChartInput(id) {
    const canvas = $(id); canvas.style.touchAction = 'pan-y';
    const inspect = px => { const info = charts.get(id); if (!info) return; const rect = canvas.getBoundingClientRect(), pos = px - rect.left; let i = Math.max(0, Math.min(info.rows.length - 1, Math.floor((pos - info.left) / (info.right - info.left) * info.rows.length))); if (info.priceX) i = info.rows.reduce((best, row, n) => Math.abs(info.priceX(row.strike) - pos) < Math.abs(info.priceX(info.rows[best].strike) - pos) ? n : best, 0); if (id === 'trend-chart') { hoverIndex = i; drawTrend(); } else { const r = info.rows[i]; put('oi-readout', `行权价 ${usd(r.strike)} · Call ${Number(r.callOi || 0).toLocaleString()} BTC · Put ${Number(r.putOi || 0).toLocaleString()} BTC`); } };
    let start = null;
    canvas.addEventListener('pointerdown', e => { start = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') inspect(e.clientX); else if (start && Math.abs(e.clientX - start.x) > Math.abs(e.clientY - start.y) * 1.4 && Math.abs(e.clientX - start.x) > 9) inspect(e.clientX); }, { passive: true });
    canvas.addEventListener('pointerup', () => { start = null; }); canvas.addEventListener('pointercancel', () => { start = null; });
    canvas.addEventListener('keydown', e => { if (!['ArrowLeft','ArrowRight'].includes(e.key)) return; e.preventDefault(); const info = charts.get(id); if (!info) return; const n = Math.max(0, Math.min(info.rows.length - 1, (Number(canvas.dataset.cursor) || 0) + (e.key === 'ArrowRight' ? 1 : -1))); canvas.dataset.cursor = n; const pos = info.priceX ? info.priceX(info.rows[n].strike) : info.left + (n + .5) / info.rows.length * (info.right - info.left); inspect(pos + canvas.getBoundingClientRect().left); });
  }
  function closeZoom() { if (!zoomRestore) return; const { element, marker, focus } = zoomRestore; marker.replaceWith(element); zoomRestore = null; $('zoom-content').replaceChildren(); $('zoom-dialog').close(); document.body.classList.remove('modal-open'); focus?.focus({ preventScroll: true }); requestAnimationFrame(() => { api.redraw(); drawAll(); }); }
  function enlarge(id, focus) { const canvas = $(id); if (!canvas) return; const element = canvas.closest('.chart-stage') || canvas, marker = document.createComment('chart-location'); element.before(marker); zoomRestore = { element, marker, focus }; $('zoom-content').append(element); put('zoom-title', canvas.getAttribute('aria-label') || '图表'); $('zoom-dialog').showModal(); document.body.classList.add('modal-open'); requestAnimationFrame(() => { api.redraw(); drawAll(); }); }
  async function share() {
    const url = new URL(location.href); url.search = ''; const title = 'BTC Capital Pulse · 市场观察';
    const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1140; const c = canvas.getContext('2d'); c.fillStyle = '#141b16'; c.fillRect(0,0,1080,1140); c.fillStyle = C.gold; c.font = '30px "Microsoft YaHei"'; c.fillText('BTC / CAPITAL PULSE', 60, 85); c.fillStyle = C.text; c.font = 'bold 64px "Microsoft YaHei"'; c.fillText(usd(state.price),60,180); c.font = '28px "Microsoft YaHei"'; c.fillStyle = C.muted; c.fillText(date(state.priceAsOf), 60,230);
    const rows = [['趋势', $('scan-trend').textContent, $('scan-trend-evidence').textContent], ['资金', $('scan-capital').textContent, $('scan-capital-evidence').textContent], ['持仓', $('scan-options').textContent, $('scan-options-evidence').textContent], ['波动', $('scan-vol').textContent, $('scan-vol-evidence').textContent]];
    rows.forEach(([label, value, evidence], i) => { const y = 340 + i * 160; c.fillStyle = C.gold; c.font = '28px "Microsoft YaHei"'; c.fillText(label,60,y); c.fillStyle = C.text; c.font = 'bold 38px "Microsoft YaHei"'; c.fillText(value,190,y); c.fillStyle = C.muted; c.font = '26px "Microsoft YaHei"'; c.fillText(evidence,60,y+58,960); });
    c.fillStyle = C.muted; c.font = '25px "Microsoft YaHei"'; c.fillText('仅用于研究观察，不构成投资建议',60,1020); c.font = '22px "Microsoft YaHei"'; c.fillText(url.origin + url.pathname,60,1080,960);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); if (!blob) return toast('图片生成失败，请复制页面链接');
    const file = new File([blob], 'btc-market-observation.png', { type:'image/png' });
    if (navigator.canShare?.({ files:[file] })) { try { await navigator.share({ title, text:title, url:url.href, files:[file] }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    const imageUrl = URL.createObjectURL(blob); showSheet('分享这份观察', `<p>保存图片并复制链接，可直接发给微信好友。</p><img class="share-preview" src="${imageUrl}" alt="BTC 市场观察分享图片"><a class="share-download" href="${imageUrl}" download="btc-market-observation.png">保存图片</a><button type="button" id="copy-share-link">复制链接</button><input class="share-url" aria-label="分享链接" readonly value="${esc(url.href)}">`);
    $('copy-share-link').addEventListener('click', async () => { try { await navigator.clipboard.writeText(url.href); toast('链接已复制'); } catch { document.querySelector('.share-url').select(); toast('请长按或复制已选中的链接'); } });
    $('note-sheet').addEventListener('close', () => URL.revokeObjectURL(imageUrl), { once:true });
  }
  function init() {
    api = window.PULSE_RUNTIME; if (!api) return;
    setupOptions(); setupTabs(); setupNotes();
    document.querySelector('[data-overlay-chart="etfRolling"]').checked = true;
    document.addEventListener('click', e => { const a = e.target.closest('a[href^="#"]'); if (a && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); if ($('note-sheet').open) closeSheet(); navigate(a.hash); } const zoom = e.target.closest('[data-enlarge]'); if (zoom) enlarge(zoom.dataset.enlarge, zoom); });
    $('mobile-menu').addEventListener('click', () => setDrawer(!document.body.classList.contains('nav-open'))); $('nav-scrim').addEventListener('click', () => setDrawer(false));
    document.addEventListener('keydown', e => { if(e.key === 'Escape' && document.body.classList.contains('nav-open')) { e.preventDefault(); setDrawer(false); } });
    $('more-views').addEventListener('click', () => showSheet('更多观察', '<div class="more-links"><a href="#market">情绪与市场 ↗</a><a href="#onchain">链上拥堵 ↗</a><a href="#seasonality">历史季节性 ↗</a><a href="#defi">稳定币流动性 ↗</a><a href="#health">数据健康 ↗</a><a href="#methodology">来源与基本面 ↗</a></div>'));
    $('view-mode').addEventListener('click', () => { const pro = document.body.classList.toggle('professional'); put('view-mode', pro ? '专业模式' : '新手模式'); $('view-mode').setAttribute('aria-pressed', String(pro)); try { localStorage.setItem('pulse-pro-mode', pro ? '1' : '0'); } catch {} });
    try { if (localStorage.getItem('pulse-pro-mode') === '1') { document.body.classList.add('professional'); put('view-mode', '专业模式'); $('view-mode').setAttribute('aria-pressed', 'true'); } } catch {}
    $('refresh-data').addEventListener('click', async () => { const b = $('refresh-data'); b.disabled = true; b.textContent = '刷新中'; try { await api.refresh(); render(); toast('已检查最新数据，截止日期见各模块'); } finally { b.disabled = false; b.textContent = '刷新'; } });
    $('share-view').addEventListener('click', () => share().catch(() => toast('分享未完成，可复制地址栏链接')));
    $('trend-ranges').addEventListener('click', e => { const b = e.target.closest('[data-trend-range]'); if (!b) return; trendRange = Number(b.dataset.trendRange); hoverIndex = null; document.querySelectorAll('[data-trend-range]').forEach(x => { const on = x === b; x.classList.toggle('active',on); x.setAttribute('aria-pressed',String(on)); }); put('trend-readout','左右移动查看某日价格 · 上下滑动浏览页面'); drawTrend(); });
    $('zoom-close').addEventListener('click',closeZoom); $('zoom-dialog').addEventListener('cancel',e => { e.preventDefault(); closeZoom(); });
    ['trend-chart','oi-chart'].forEach(bindChartInput);
    window.addEventListener('popstate', () => navigate(location.hash,false));
    window.addEventListener('pulse:update', () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(render); });
    window.addEventListener('resize', () => { setDrawer(document.body.classList.contains('nav-open'),false); cancelAnimationFrame(frame); frame=requestAnimationFrame(drawAll); });
    navigate(location.hash || '#overview', false); render();
    document.querySelectorAll('.experience-tools button').forEach(button => { button.disabled = false; });
    document.documentElement.classList.add('app-ready');
    document.documentElement.classList.remove('init-failed');
    clearTimeout(window.PULSE_BOOT_TIMER);
  }
  document.addEventListener('DOMContentLoaded', init, { once:true });
})();
