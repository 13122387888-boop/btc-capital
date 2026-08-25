(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const staticData = window.PULSE_STATIC_DATA;
  const deployment = window.PULSE_DEPLOYMENT || {};
  const isSnapshotMode = deployment.mode === "snapshot";
  const snapshotStaleAfterSeconds = Number.isFinite(Number(deployment.staleAfterSeconds)) ? Number(deployment.staleAfterSeconds) : 6 * 3600;
  const cachePrefix = "btc_pulse_v2_";
  const sourceStates = {};
  let lastPriceSeries = [];
  let latestBtcPrice = null;
  let currentBtcChange = null;
  let currentBtcProvider = null;
  let currentBtcAsOf = null;
  let currentBtcCandlesAsOf = null;
  let currentFearGreed = null;
  let currentFearGreedLabel = null;
  let currentFearGreed7dChange = null;
  let currentFearGreedWindowDays = null;
  let currentFearGreedAsOf = null;
  let currentStableSupply = null;
  let currentStable30dChange = null;
  let currentStableWindowDays = null;
  let currentStableAsOf = null;
  let btcCandles = [];
  let fearGreedRows = [];
  let defiTrendRows = [];
  let latestHealthPayload = null;
  let gammaChartRows = [];
  let gammaSpot = null;
  let gammaNetGex = null;
  let etfRollingRows = [];
  let currentEtf5d = null;
  let currentEtf20d = null;
  const todayMarketModels = {};
  const moduleUpdatedAt = {};
  const marketInputMeta = {
    price: { missing: false, stale: false, fetchedAt: null, targetSeconds: 15 * 60 },
    sentiment: { missing: false, stale: false, fetchedAt: null, targetSeconds: 60 * 60 },
    defi: { missing: false, stale: false, fetchedAt: null, targetSeconds: 2 * 60 * 60 }
  };
  const SIGNAL_THRESHOLDS = Object.freeze({
    btc24hFlatPercent: 0.1,
    btcTrendFlatPercent: 1,
    stablecoinFlatPercent: 0.5,
    stablecoinStrongPercent: 2,
    feeLowSatVb: 5,
    feeHighSatVb: 20
  });
  const chartState = {
    price: { range: "30D", overlay: true },
    etfRolling: { range: "30D", overlay: false },
    etfCombo: { range: "1Y", overlay: true },
    fng: { range: "90D", overlay: true },
    options: { range: "30D", overlay: false },
    defi: { range: "1Y", overlay: true }
  };
  const chartBindings = new WeakMap();

  const endpoints = {
    health: "/api/health",
    market: "/api/data/market",
    sentiment: "/api/data/sentiment",
    onchain: "/api/data/onchain",
    defi: "/api/data/defi",
    gamma: "/api/gamma",
    ...(deployment.endpoints || {})
  };

  function sourceStateLabel(state) {
    if (state === "live") return isSnapshotMode ? isSnapshotStale() ? "STALE SNAPSHOT" : "SNAPSHOT" : "LIVE";
    if (state === "partial") return isSnapshotMode ? isSnapshotStale() ? "STALE SNAPSHOT" : "PARTIAL SNAPSHOT" : "PARTIAL";
    if (state === "cached") return isSnapshotMode ? "CACHED SNAPSHOT" : "CACHED";
    return "UNAVAILABLE";
  }

  function snapshotAgeSeconds() {
    const timestamp = Date.parse(deployment.generatedAt || "");
    return Number.isFinite(timestamp) ? Math.max(0, (Date.now() - timestamp) / 1000) : null;
  }

  function isSnapshotStale() {
    const age = snapshotAgeSeconds();
    return isSnapshotMode && Number.isFinite(age) && age > snapshotStaleAfterSeconds;
  }

  function currentModuleAge(module) {
    const snapshotFallback = isSnapshotMode && module?.kind === "dynamic" ? deployment.generatedAt : "";
    const timestamp = Date.parse(module?.fetchedAt || snapshotFallback || "");
    return Number.isFinite(timestamp) ? Math.max(0, (Date.now() - timestamp) / 1000) : num(module?.ageSeconds);
  }

  function moduleIsOverdue(module) {
    if (module?.overdue === true) return true;
    if (isSnapshotMode && module?.kind === "dynamic") return isSnapshotStale();
    const age = currentModuleAge(module), target = num(module?.targetSeconds);
    return Number.isFinite(age) && Number.isFinite(target) ? age > target : false;
  }

  function applyDeploymentLabels() {
    if (!isSnapshotMode) return;
    if ($("rail-mode-note")) $("rail-mode-note").textContent = "零密钥 · Actions 快照";
    if ($("btc-change")) $("btc-change").textContent = "等待快照行情";
    if ($("health-runtime-kicker")) $("health-runtime-kicker").textContent = "ACTION SNAPSHOTS";
    if ($("health-runtime-title")) $("health-runtime-title").textContent = "定时快照与上游状态";
    if ($("health-runtime-definition")) $("health-runtime-definition").innerHTML = `<b>快照新鲜度窗口</b> GitHub Actions 每两小时尝试刷新；超过 ${Math.round(snapshotStaleAfterSeconds / 3600)} 小时未重新生成时标为 STALE SNAPSHOT。抓取时间与上游数据截止日分开显示。`;
    if ($("runtime-method")) $("runtime-method").innerHTML = "<span>SNAPSHOT</span><h3>Actions 定时快照</h3><p>GitHub Actions 统一读取公开端点并生成同批 JSON；页面明确展示生成时间，不把快照称为实时数据。</p>";
    if ($("cache-method")) $("cache-method").innerHTML = "<span>CACHED</span><h3>浏览器成功缓存</h3><p>浏览器只在快照暂时读取失败时沿用最近成功结果，并明确标为 CACHED SNAPSHOT。</p>";
    document.querySelectorAll(".module-updated").forEach(node => { if (!node.textContent.includes("快照")) node.textContent = "等待快照"; });
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>'"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[ch]);
  }
  function num(value) { if (value === null || value === undefined || value === "") return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
  function fmtUsd(value, digits = 0) {
    if (!Number.isFinite(value)) return "—";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits }).format(value);
  }
  function compact(value) {
    if (!Number.isFinite(value)) return "—";
    return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
  }
  function signed(value, suffix = "%", digits = 2) {
    if (!Number.isFinite(value)) return "—";
    return `${value > 0 ? "+" : ""}${value.toFixed(digits)}${suffix}`;
  }
  function fearGreedLabel(value, rawLabel = "") {
    const translated = {
      "extreme fear": "极度恐慌",
      fear: "恐慌",
      neutral: "中性",
      greed: "贪婪",
      "extreme greed": "极度贪婪"
    }[String(rawLabel).trim().toLowerCase()];
    if (translated) return translated;
    if (!Number.isFinite(value)) return "—";
    if (value <= 24) return "极度恐慌";
    if (value <= 44) return "恐慌";
    if (value <= 55) return "中性";
    if (value <= 75) return "贪婪";
    return "极度贪婪";
  }
  function flow(value) {
    if (!Number.isFinite(value)) return "—";
    const sign = value > 0 ? "+" : value < 0 ? "−" : "";
    const absolute = Math.abs(value);
    return `${sign}$${absolute >= 1000 ? (absolute / 1000).toFixed(2) + "B" : absolute.toFixed(1) + "M"}`;
  }
  function tone(el, value) {
    if (!el || !Number.isFinite(value)) return;
    el.classList.toggle("up", value > 0);
    el.classList.toggle("down", value < 0);
  }
  function cacheRead(key) {
    try { return JSON.parse(localStorage.getItem(cachePrefix + key) || "null"); } catch { return null; }
  }
  function cacheWrite(key, value) {
    try { localStorage.setItem(cachePrefix + key, JSON.stringify({ at: Date.now(), value })); } catch { /* local cache is optional */ }
  }
  async function getJSON(key, url, ttl = 120000, timeout = 7500) {
    const cached = cacheRead(key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store", headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await response.json();
      if (value?.status === "unavailable") throw new Error("service unavailable");
      cacheWrite(key, value);
      return { value, state: "live", cachedAt: null };
    } catch (error) {
      if (cached && cached.value?.status !== "unavailable" && Date.now() - cached.at < ttl * 12) return { value: cached.value, state: "cached", cachedAt: cached.at };
      throw error;
    } finally { clearTimeout(timer); }
  }
  function shortUpdatedAt(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "时间未知";
    return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function setState(group, state, updatedAt = null) {
    sourceStates[group] = state;
    if (updatedAt && state !== "error") moduleUpdatedAt[group] = updatedAt;
    document.querySelectorAll(`[data-source-state="${group}"]`).forEach(el => {
      el.textContent = sourceStateLabel(state);
      el.classList.remove("live", "partial", "cached", "error");
      el.classList.add(isSnapshotStale() && (state === "live" || state === "partial") ? "partial" : state === "live" ? "live" : state === "partial" ? "partial" : state === "cached" ? "cached" : "error");
    });
    const updated = $(`${group}-updated`);
    if (updated) updated.textContent = `${state === "cached" ? "缓存于" : state === "partial" ? (isSnapshotMode ? "部分快照于" : "部分更新于") : state === "error" ? "最后尝试" : isSnapshotMode ? "快照于" : "更新于"} ${shortUpdatedAt(updatedAt || Date.now())}`;
  }
  function payloadState(payload, transportState = "live") {
    if (payload?.status === "unavailable") return "error";
    if (payload?.status === "partial") return "partial";
    if (transportState === "cached") return "cached";
    return "live";
  }
  function updateCompositeMarketTime() {
    const target = $("market-updated");
    if (!target) return;
    const parts = [];
    if (moduleUpdatedAt.market) parts.push(`行情 ${shortUpdatedAt(moduleUpdatedAt.market)}`);
    if (moduleUpdatedAt.sentiment) parts.push(`情绪 ${shortUpdatedAt(moduleUpdatedAt.sentiment)}`);
    target.textContent = parts.length ? parts.join(" · ") : "更新时间：等待首次更新";
  }
  function groupState(results) {
    const fulfilled = results.filter(r => r.status === "fulfilled").map(r => r.value.state);
    return fulfilled.includes("live") ? "live" : fulfilled.includes("cached") ? "cached" : "error";
  }

  function renderStatic() {
    const normalizePairs = rows => (Array.isArray(rows) ? rows : [])
      .map(row => [String(row?.[0] || ""), num(row?.[1])])
      .filter(row => row[0] && Number.isFinite(row[1]))
      .sort((a, b) => a[0].localeCompare(b[0]));
    const btc = normalizePairs(staticData?.btcFlows);
    const ethByDate = new Map(normalizePairs(staticData?.ethFlows));
    const last = btc.at(-1);
    const rollingSum = (rows, endIndex, windowSize) => endIndex + 1 < windowSize
      ? null
      : rows.slice(endIndex + 1 - windowSize, endIndex + 1).reduce((sum, row) => sum + row[1], 0);

    etfRollingRows = btc.map((row, index) => ({
      date: row[0],
      daily: row[1],
      roll5: rollingSum(btc, index, 5),
      roll20: rollingSum(btc, index, 20)
    }));
    currentEtf5d = etfRollingRows.at(-1)?.roll5 ?? null;
    currentEtf20d = etfRollingRows.at(-1)?.roll20 ?? null;
    const rollingNote = document.querySelector(".etf-rolling-panel .mini-note");
    if (rollingNote) rollingNote.textContent = `绿线 5日 · 橙线 20日 · ${btc.length} 个交易日 · 截至 ${staticData?.sources?.etfFlows?.asOf || "—"}`;

    $("stat-etf-last").textContent = last ? flow(last[1]) : "—";
    $("stat-etf-date").textContent = last ? `截至 ${last[0]}` : "快照暂不可用";
    if (last) tone($("stat-etf-last"), last[1]);
    if ($("etf-flow-5d")) { $("etf-flow-5d").textContent = flow(currentEtf5d); tone($("etf-flow-5d"), currentEtf5d); }
    if ($("etf-flow-20d")) { $("etf-flow-20d").textContent = flow(currentEtf20d); tone($("etf-flow-20d"), currentEtf20d); }
    if ($("etf-flow-latest")) {
      $("etf-flow-latest").textContent = last ? `${flow(last[1])} · ${last[0].slice(5)}` : "—";
      if (last) tone($("etf-flow-latest"), last[1]);
    }

    const monthly = normalizePairs(staticData?.btcMonthlyFlows);
    if (monthly.length) {
      const total = monthly.reduce((sum, row) => sum + row[1], 0);
      const positives = monthly.filter(row => row[1] > 0).length;
      const maximum = Math.max(...monthly.map(row => row[1]));
      $("etf-window").textContent = flow(total);
      $("etf-hit").textContent = `${(positives / monthly.length * 100).toFixed(1)}%`;
      $("etf-max").textContent = flow(maximum);
      tone($("etf-window"), total);
    } else {
      $("etf-window").textContent = "—";
      $("etf-hit").textContent = "—";
      $("etf-max").textContent = "—";
    }

    $("flow-rows").innerHTML = btc.length ? btc.slice(-8).reverse().map(row => {
      const eth = ethByDate.get(row[0]);
      return `<div class="tr" role="row"><span>${esc(row[0].slice(5))}</span><span class="${row[1] > 0 ? "up" : row[1] < 0 ? "down" : ""}">${esc(flow(row[1]))}</span><span class="${eth > 0 ? "up" : eth < 0 ? "down" : ""}">${esc(flow(eth))}</span></div>`;
    }).join("") : '<div class="tr" role="row"><span>—</span><span>ETF 快照暂不可用</span><span>—</span></div>';

    lastPriceSeries = normalizePairs(staticData?.btcMonthly).map(row => row[1]);
    $("btc-low").textContent = lastPriceSeries.length ? fmtUsd(Math.min(...lastPriceSeries), 0) : "—";
    $("btc-high").textContent = lastPriceSeries.length ? fmtUsd(Math.max(...lastPriceSeries), 0) : "—";
    requestAnimationFrame(() => {
      drawEtfCombo();
      drawEtfRolling();
      if (lastPriceSeries.length) drawLine($("price-chart"), lastPriceSeries);
    });
    renderTodayMarketState();
  }

  function fitCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = parseFloat(getComputedStyle(canvas).height) || Number(canvas.getAttribute("height")) || 200;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height };
  }
  function drawBars(canvas, values) {
    if (!canvas || !values.length) return;
    const { ctx, width, height } = fitCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const pad = { l: 8, r: 8, t: 12, b: 20 };
    const plotH = height - pad.t - pad.b;
    const maxAbs = Math.max(...values.map(Math.abs), 1);
    const zero = pad.t + plotH / 2;
    ctx.strokeStyle = "#2b302b"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.l, zero); ctx.lineTo(width - pad.r, zero); ctx.stroke();
    const step = (width - pad.l - pad.r) / values.length;
    const barW = Math.max(2, step * .55);
    values.forEach((v, i) => {
      const h = Math.abs(v) / maxAbs * (plotH / 2 - 8);
      ctx.fillStyle = v >= 0 ? "#6bd49b" : "#e9796f";
      ctx.globalAlpha = i === values.length - 1 ? 1 : .72;
      ctx.fillRect(pad.l + i * step + (step - barW) / 2, v >= 0 ? zero - h : zero, barW, h);
    });
    ctx.globalAlpha = 1;
  }
  function etfComboData() {
    const priceMap = new Map(Array.isArray(staticData?.btcMonthly) ? staticData.btcMonthly : []);
    if (Number.isFinite(latestBtcPrice)) priceMap.set(new Date().toISOString().slice(0, 7), latestBtcPrice);
    return (Array.isArray(staticData?.btcMonthlyFlows) ? staticData.btcMonthlyFlows : [])
      .map(([month, flowValue]) => ({ month: String(month || ""), flow: num(flowValue), price: num(priceMap.get(month)) }))
      .filter(row => row.month && Number.isFinite(row.flow));
  }
  function drawEtfCombo() {
    const canvas = $("etf-chart");
    const rows = etfComboData();
    if (!canvas || !rows.length) return;
    const { ctx, width, height } = fitCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const pad = { l: 52, r: 58, t: 18, b: 33 }, plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b;
    const flows = rows.map(r => r.flow), prices = rows.map(r => r.price).filter(Number.isFinite);
    const fMin = Math.min(0, ...flows), fMax = Math.max(0, ...flows), fSpan = fMax - fMin || 1;
    const pMinRaw = Math.min(...prices), pMaxRaw = Math.max(...prices), pPad = (pMaxRaw - pMinRaw || pMaxRaw * .1) * .12, pMin = pMinRaw - pPad, pMax = pMaxRaw + pPad;
    const x = i => pad.l + i / Math.max(1, rows.length - 1) * plotW;
    const yf = v => pad.t + (fMax - v) / fSpan * plotH;
    const yp = v => pad.t + (pMax - v) / (pMax - pMin || 1) * plotH;
    ctx.font = '12px "Microsoft YaHei"'; ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) { const y = pad.t + i / 4 * plotH; ctx.strokeStyle = "#202520"; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke(); const fv = fMax - i / 4 * fSpan, pv = pMax - i / 4 * (pMax - pMin); ctx.fillStyle = "#626862"; ctx.textAlign = "right"; ctx.fillText(`${fv / 1000 >= 0 ? "" : "−"}$${Math.abs(fv / 1000).toFixed(1)}B`, pad.l - 8, y); ctx.textAlign = "left"; ctx.fillText(`$${Math.round(pv / 1000)}k`, width - pad.r + 8, y); }
    const zeroY = yf(0); ctx.strokeStyle = "#596059"; ctx.beginPath(); ctx.moveTo(pad.l, zeroY); ctx.lineTo(width - pad.r, zeroY); ctx.stroke();
    const step = plotW / Math.max(1, rows.length - 1), barW = Math.max(3, Math.min(13, step * .52));
    rows.forEach((r, i) => { const y = yf(r.flow); ctx.fillStyle = r.flow >= 0 ? "rgba(107,212,155,.72)" : "rgba(233,121,111,.72)"; ctx.fillRect(x(i) - barW / 2, Math.min(y, zeroY), barW, Math.max(1, Math.abs(y - zeroY))); });
    ctx.beginPath(); let started = false; rows.forEach((r, i) => { if (!Number.isFinite(r.price)) return; const px = x(i), py = yp(r.price); if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py); }); ctx.strokeStyle = "#e9ae3f"; ctx.lineWidth = 2.2; ctx.stroke();
    rows.forEach((r, i) => { if (!Number.isFinite(r.price)) return; if (i === rows.length - 1 || i % 6 === 0) { ctx.fillStyle = "#e9ae3f"; ctx.beginPath(); ctx.arc(x(i), yp(r.price), i === rows.length - 1 ? 4 : 2.5, 0, Math.PI * 2); ctx.fill(); } });
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#626862"; rows.forEach((r, i) => { if (i % 5 === 0 || i === rows.length - 1) ctx.fillText(r.month.replace("-", "/"), x(i), height - pad.b + 10); });
    const recent = rows.slice(-3), recentFlow = recent.reduce((s, r) => s + r.flow, 0), priced = recent.filter(r => Number.isFinite(r.price));
    const priceChange = priced.length > 1 ? (priced[priced.length - 1].price / priced[0].price - 1) * 100 : null;
    let conclusion = recentFlow >= 0 ? `最近 3 个月 ETF 合计净流入 ${flow(recentFlow)}` : `最近 3 个月 ETF 合计净流出 ${flow(recentFlow)}`;
    if (Number.isFinite(priceChange)) conclusion += `，同期 BTC ${priceChange >= 0 ? "上涨" : "下跌"} ${Math.abs(priceChange).toFixed(1)}%`;
    conclusion += recentFlow > 0 && priceChange > 0 ? "；资金与价格同向，趋势得到确认。" : recentFlow > 0 && priceChange <= 0 ? "；资金先行但价格尚未确认。" : recentFlow < 0 && priceChange < 0 ? "；资金与价格同步承压。" : "；价格与资金出现背离，需要继续观察。";
    $("etf-insight").querySelector("span").textContent = conclusion;
  }
  function drawEtfRolling() {
    const canvas = $("etf-rolling-chart");
    const rows = etfRollingRows.filter(row => Number.isFinite(row.roll5) || Number.isFinite(row.roll20)).slice(-32);
    if (!canvas) return;
    const { ctx, width, height } = fitCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    if (rows.length < 2) {
      ctx.fillStyle = "#747b74";
      ctx.font = '13px "Microsoft YaHei"';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("ETF 快照不足，暂不能计算滚动趋势", width / 2, height / 2);
      return;
    }
    const pad = { l: 70, r: 24, t: 18, b: 36 }, plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b;
    const values = rows.flatMap(row => [row.roll5, row.roll20]).filter(Number.isFinite);
    const minimum = Math.min(0, ...values), maximum = Math.max(0, ...values), span = maximum - minimum || 1;
    const x = index => pad.l + index / Math.max(1, rows.length - 1) * plotW;
    const y = value => pad.t + (maximum - value) / span * plotH;
    ctx.font = '12px "Microsoft YaHei"'; ctx.textBaseline = "middle";
    for (let index = 0; index <= 4; index++) {
      const py = pad.t + index / 4 * plotH, value = maximum - index / 4 * span;
      ctx.strokeStyle = "#202520"; ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(width - pad.r, py); ctx.stroke();
      ctx.fillStyle = "#747b74"; ctx.textAlign = "right"; ctx.fillText(flow(value), pad.l - 9, py);
    }
    const zero = y(0); ctx.strokeStyle = "#596059"; ctx.beginPath(); ctx.moveTo(pad.l, zero); ctx.lineTo(width - pad.r, zero); ctx.stroke();
    const drawSeries = (key, color) => {
      ctx.beginPath(); let started = false;
      rows.forEach((row, index) => {
        if (!Number.isFinite(row[key])) { started = false; return; }
        if (started) ctx.lineTo(x(index), y(row[key])); else { ctx.moveTo(x(index), y(row[key])); started = true; }
      });
      ctx.strokeStyle = color; ctx.lineWidth = 2.4; ctx.stroke();
      const lastIndex = rows.findLastIndex(row => Number.isFinite(row[key]));
      if (lastIndex >= 0) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x(lastIndex), y(rows[lastIndex][key]), 4, 0, Math.PI * 2); ctx.fill(); }
    };
    drawSeries("roll5", "#6bd49b");
    drawSeries("roll20", "#e9ae3f");
    ctx.fillStyle = "#747b74"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    rows.forEach((row, index) => { if (index % Math.max(1, Math.ceil(rows.length / 6)) === 0 || index === rows.length - 1) ctx.fillText(row.date.slice(5), x(index), height - pad.b + 10); });
  }
  function drawLine(canvas, values) {
    if (!canvas || values.length < 2) return;
    const { ctx, width, height } = fitCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
    const pad = 6, x = i => pad + i / (values.length - 1) * (width - pad * 2), y = v => pad + (max - v) / span * (height - pad * 2);
    const gradient = ctx.createLinearGradient(0, 0, 0, height); gradient.addColorStop(0, "rgba(233,174,63,.26)"); gradient.addColorStop(1, "rgba(233,174,63,0)");
    ctx.beginPath(); ctx.moveTo(x(0), height - pad); values.forEach((v, i) => ctx.lineTo(x(i), y(v))); ctx.lineTo(x(values.length - 1), height - pad); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
    ctx.beginPath(); values.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))); ctx.strokeStyle = "#e9ae3f"; ctx.lineWidth = 2; ctx.stroke();
  }
  function drawDualLine(canvas, rows, options) {
    if (!canvas || rows.length < 2) return;
    const { ctx, width, height } = fitCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const pad = { l: 54, r: 58, t: 18, b: 32 }, plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b;
    const leftVals = rows.map(r => r.left).filter(Number.isFinite), rightVals = rows.map(r => r.right).filter(Number.isFinite);
    if (!leftVals.length || !rightVals.length) return;
    const range = values => { const min = Math.min(...values), max = Math.max(...values), extra = (max - min || Math.abs(max) || 1) * .12; return [Math.max(0, min - extra), max + extra]; };
    const [lMin, lMax] = range(leftVals), [rMin, rMax] = range(rightVals);
    const x = i => pad.l + i / Math.max(1, rows.length - 1) * plotW, yl = v => pad.t + (lMax - v) / (lMax - lMin || 1) * plotH, yr = v => pad.t + (rMax - v) / (rMax - rMin || 1) * plotH;
    ctx.font = '12px "Microsoft YaHei"'; ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) { const y = pad.t + i / 4 * plotH; ctx.strokeStyle = "#202520"; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke(); ctx.fillStyle = "#687068"; ctx.textAlign = "right"; ctx.fillText(options.leftFormat(lMax - i / 4 * (lMax - lMin)), pad.l - 8, y); ctx.textAlign = "left"; ctx.fillText(options.rightFormat(rMax - i / 4 * (rMax - rMin)), width - pad.r + 8, y); }
    const drawSeries = (key, yFn, color) => { ctx.beginPath(); let begun = false; rows.forEach((row, i) => { if (!Number.isFinite(row[key])) return; if (begun) ctx.lineTo(x(i), yFn(row[key])); else { ctx.moveTo(x(i), yFn(row[key])); begun = true; } }); ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.stroke(); const lastIndex = [...rows].map(r => r[key]).lastIndexOf(rows.slice().reverse().find(r => Number.isFinite(r[key]))?.[key]); if (lastIndex >= 0) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x(lastIndex), yFn(rows[lastIndex][key]), 4, 0, Math.PI * 2); ctx.fill(); } };
    drawSeries("left", yl, "#6bd49b"); drawSeries("right", yr, "#e9ae3f");
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#687068"; rows.forEach((row, i) => { if (i % Math.max(1, Math.ceil(rows.length / 6)) === 0 || i === rows.length - 1) ctx.fillText(row.label.replace("-", "/"), x(i), height - pad.b + 10); });
  }
  function drawHorizontalComparison(canvas, rows, formatValue) {
    if (!canvas || !rows.length) return;
    const { ctx, width, height } = fitCanvas(canvas); ctx.clearRect(0, 0, width, height);
    const pad = { l: 94, r: 72, t: 15, b: 15 }, plotW = width - pad.l - pad.r, rowH = (height - pad.t - pad.b) / rows.length, maxAbs = Math.max(...rows.map(r => Math.abs(r.value)), .0001), zeroX = pad.l + plotW / 2;
    ctx.strokeStyle = "#4a504a"; ctx.beginPath(); ctx.moveTo(zeroX, pad.t); ctx.lineTo(zeroX, height - pad.b); ctx.stroke(); ctx.font = '12px "Microsoft YaHei"'; ctx.textBaseline = "middle";
    rows.forEach((row, i) => { const y = pad.t + rowH * (i + .5), len = Math.abs(row.value) / maxAbs * (plotW / 2 - 8); ctx.fillStyle = "#a5aba5"; ctx.textAlign = "right"; ctx.fillText(row.label, pad.l - 10, y); ctx.fillStyle = row.value >= 0 ? "#6bd49b" : "#e9796f"; ctx.fillRect(row.value >= 0 ? zeroX : zeroX - len, y - 5, len, 10); ctx.textAlign = row.value >= 0 ? "left" : "right"; ctx.fillText(formatValue(row.value), row.value >= 0 ? zeroX + len + 7 : zeroX - len - 7, y); });
  }
  function drawFearGreedGauge(value) {
    const canvas = $("fng-gauge"); if (!canvas || !Number.isFinite(value)) return;
    const { ctx, width, height } = fitCanvas(canvas); ctx.clearRect(0, 0, width, height);
    const cx = width / 2, cy = height * .82, radius = Math.min(width * .38, height * .68), start = Math.PI, end = Math.PI * 2;
    const segments = [[0,.25,"#dc625c"],[.25,.45,"#d49b47"],[.45,.56,"#7e847e"],[.56,.76,"#b7ba55"],[.76,1,"#57bd82"]];
    ctx.lineWidth = Math.max(18, radius * .18); ctx.lineCap = "butt";
    segments.forEach(([a,b,color]) => { ctx.beginPath(); ctx.arc(cx, cy, radius, start + a * Math.PI, start + b * Math.PI); ctx.strokeStyle = color; ctx.stroke(); });
    for (let i = 0; i <= 10; i++) { const angle = start + i / 10 * Math.PI, r1 = radius - ctx.lineWidth * .7, r2 = radius + ctx.lineWidth * .7; ctx.beginPath(); ctx.moveTo(cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1); ctx.lineTo(cx + Math.cos(angle) * r2, cy + Math.sin(angle) * r2); ctx.strokeStyle = "rgba(8,10,9,.55)"; ctx.lineWidth = 1; ctx.stroke(); }
    const needle = start + Math.max(0, Math.min(100, value)) / 100 * Math.PI;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(needle) * radius * .78, cy + Math.sin(needle) * radius * .78); ctx.strokeStyle = "#f4f2ea"; ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.stroke(); ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fillStyle = "#f4f2ea"; ctx.fill();
    ctx.textAlign = "center"; ctx.fillStyle = "#f1f0e9"; ctx.font = '700 36px "Microsoft YaHei"'; ctx.fillText(String(Math.round(value)), cx, cy - radius * .28); ctx.fillStyle = "#929891"; ctx.font = '14px "Microsoft YaHei"'; const label = currentFearGreedLabel || fearGreedLabel(value); ctx.fillText(label, cx, cy - radius * .06);
    ctx.fillStyle = "#777e77"; ctx.font = '12px "Microsoft YaHei"'; ctx.textAlign = "left"; ctx.fillText("0 恐慌", cx - radius - 8, cy + 18); ctx.textAlign = "right"; ctx.fillText("贪婪 100", cx + radius + 8, cy + 18);
  }
  function drawFearGreedKline() {
    const canvas = $("fng-kline-chart"); if (!canvas || btcCandles.length < 5 || fearGreedRows.length < 5) return;
    const { ctx, width, height } = fitCanvas(canvas); ctx.clearRect(0, 0, width, height);
    const pad = { l: 66, r: 58, t: 22, b: 38 }, plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b;
    const candles = btcCandles.slice(-90), fngMap = new Map(fearGreedRows.map(row => [row.date, row.value]));
    const highs = candles.map(row => row.high), lows = candles.map(row => row.low), pMinRaw = Math.min(...lows), pMaxRaw = Math.max(...highs), pExtra = (pMaxRaw - pMinRaw || pMaxRaw * .08) * .08, pMin = pMinRaw - pExtra, pMax = pMaxRaw + pExtra;
    const x = index => pad.l + (index + .5) / candles.length * plotW;
    const py = value => pad.t + (pMax - value) / (pMax - pMin || 1) * plotH;
    const fy = value => pad.t + (100 - value) / 100 * plotH;
    const step = plotW / candles.length, bodyW = Math.max(2, Math.min(8, step * .62));
    ctx.fillStyle = "rgba(107,212,155,.035)"; ctx.fillRect(pad.l, fy(100), plotW, fy(76) - fy(100));
    ctx.fillStyle = "rgba(126,132,126,.025)"; ctx.fillRect(pad.l, fy(56), plotW, fy(44) - fy(56));
    ctx.fillStyle = "rgba(233,121,111,.04)"; ctx.fillRect(pad.l, fy(24), plotW, fy(0) - fy(24));
    ctx.font = '12px "Microsoft YaHei"'; ctx.textBaseline = "middle";
    for (let index = 0; index <= 4; index++) {
      const y = pad.t + index / 4 * plotH, price = pMax - index / 4 * (pMax - pMin);
      ctx.strokeStyle = "#202520"; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke();
      ctx.fillStyle = "#747b74"; ctx.textAlign = "right"; ctx.fillText(`$${Math.round(price / 1000)}k`, pad.l - 9, y);
      ctx.textAlign = "left"; ctx.fillText(String(100 - index * 25), width - pad.r + 9, y);
    }
    candles.forEach((candle, index) => {
      const color = candle.close >= candle.open ? "#6bd49b" : "#e9796f", px = x(index);
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, py(candle.high)); ctx.lineTo(px, py(candle.low)); ctx.stroke();
      const top = py(Math.max(candle.open, candle.close)), bottom = py(Math.min(candle.open, candle.close));
      ctx.fillStyle = color; ctx.fillRect(px - bodyW / 2, top, bodyW, Math.max(1.5, bottom - top));
    });
    ctx.beginPath(); let started = false, lastPoint = null;
    candles.forEach((candle, index) => {
      const value = fngMap.get(candle.date); if (!Number.isFinite(value)) { started = false; return; }
      const px = x(index), y = fy(value); if (started) ctx.lineTo(px, y); else { ctx.moveTo(px, y); started = true; }
      lastPoint = { x: px, y };
    });
    ctx.strokeStyle = "#f1b84e"; ctx.lineWidth = 2.6; ctx.shadowColor = "rgba(233,174,63,.28)"; ctx.shadowBlur = 5; ctx.stroke(); ctx.shadowBlur = 0;
    if (lastPoint) { ctx.fillStyle = "#f1b84e"; ctx.beginPath(); ctx.arc(lastPoint.x, lastPoint.y, 4, 0, Math.PI * 2); ctx.fill(); }
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#747b74";
    candles.forEach((candle, index) => { if (index % 15 === 0 || index === candles.length - 1) ctx.fillText(candle.date.slice(5), x(index), height - pad.b + 11); });
    ctx.textBaseline = "top"; ctx.fillStyle = "#9da39d"; ctx.textAlign = "left"; ctx.fillText("BTC 价格（左轴）", pad.l, 2); ctx.textAlign = "right"; ctx.fillText("恐贪 0–100（右轴）", width - pad.r, 2);
  }
  function drawOptionsChart() {
    const canvas = $("options-chart");
    const rows = (staticData.ibitOptions.daily || []).map(row => {
      const call = num(row?.[1]), put = num(row?.[2]);
      return [row?.[0], call, put, call > 0 && Number.isFinite(put) ? put / call : null, num(row?.[4])];
    }).filter(row => typeof row[0] === "string" && [row[1], row[2], row[3]].every(Number.isFinite));
    if (!canvas || !rows.length) return;
    const { ctx, width, height } = fitCanvas(canvas); ctx.clearRect(0, 0, width, height);
    const pad = { l: 58, r: 56, t: 18, b: 34 }, plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b, maxVol = Math.max(...rows.flatMap(r => [r[1],r[2]])), maxRatio = Math.max(1.5,...rows.map(r => r[3]));
    const x = i => pad.l + (i + .5) / rows.length * plotW, vy = v => pad.t + (maxVol - v) / maxVol * plotH, ry = v => pad.t + (maxRatio - v) / maxRatio * plotH, step = plotW / rows.length, bw = Math.max(2, Math.min(8, step * .32));
    ctx.font = '12px "Microsoft YaHei"'; ctx.textBaseline = "middle";
    for (let i=0;i<=4;i++){const y=pad.t+i/4*plotH;ctx.strokeStyle="#202520";ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(width-pad.r,y);ctx.stroke();ctx.fillStyle="#747b74";ctx.textAlign="right";ctx.fillText(compact(maxVol-i/4*maxVol),pad.l-8,y);ctx.textAlign="left";ctx.fillText((maxRatio-i/4*maxRatio).toFixed(1),width-pad.r+8,y)}
    rows.forEach((r,i)=>{const px=x(i);ctx.fillStyle="rgba(107,212,155,.76)";ctx.fillRect(px-bw-1,vy(r[1]),bw,height-pad.b-vy(r[1]));ctx.fillStyle="rgba(117,168,214,.75)";ctx.fillRect(px+1,vy(r[2]),bw,height-pad.b-vy(r[2]));});
    ctx.beginPath();rows.forEach((r,i)=>i?ctx.lineTo(x(i),ry(r[3])):ctx.moveTo(x(i),ry(r[3])));ctx.strokeStyle="#e9ae3f";ctx.lineWidth=2.2;ctx.stroke();
    ctx.textAlign="center";ctx.textBaseline="top";ctx.fillStyle="#747b74";rows.forEach((r,i)=>{if(i%5===0||i===rows.length-1)ctx.fillText(r[0].slice(5),x(i),height-pad.b+10)});
  }
  function renderOptions() {
    const d = staticData.ibitOptions || {}, s = d.snapshot || {};
    const call = num(s.callVolume), put = num(s.putVolume), ratio = call > 0 && Number.isFinite(put) ? put / call : num(s.putCallRatio), openInterest = num(s.openInterest);
    $("option-call-volume").textContent = compact(call); $("option-put-volume").textContent = compact(put); $("option-pc-ratio").textContent = Number.isFinite(ratio) ? ratio.toFixed(2) : "—"; $("option-oi").textContent = compact(openInterest);
    if (Number.isFinite(ratio)) {
      const toneText = ratio < .7 ? "看涨成交明显多于看跌成交，交易结构偏向进取。" : ratio > 1 ? "看跌成交多于看涨成交，保护性或谨慎需求偏高。" : "看涨与看跌成交相对均衡。";
      $("options-insight").querySelector("span").textContent = `IBIT 看跌/看涨成交比为 ${ratio.toFixed(2)}。${toneText}该比值不能单独判断方向。`;
    } else $("options-insight").querySelector("span").textContent = "IBIT 最近完整交易日的期权快照不完整，暂不判断看涨与看跌需求。";
    requestAnimationFrame(drawOptionsChart);
  }
  function compound(values) { const valid = values.filter(Number.isFinite); return valid.length ? (valid.reduce((p,v)=>p*(1+v/100),1)-1)*100 : null; }
  function heatStyle(value) { if (!Number.isFinite(value)) return ""; const alpha = Math.min(.88,.18+Math.abs(value)/45*.65); return `background:${value>=0?`rgba(57,151,98,${alpha})`:`rgba(180,66,60,${alpha})`};color:${alpha>.48?'#fff':'#d7dad4'}`; }
  function renderSeasonality() {
    const years = staticData.seasonality.years;
    const asOf = staticData.seasonality.asOf;
    const asOfDate = new Date(`${asOf}T00:00:00Z`);
    const lastDay = new Date(Date.UTC(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth() + 1, 0)).getUTCDate();
    const incompleteMonth = asOfDate.getUTCDate() < lastDay ? asOf.slice(0, 7) : null;
    const labels = ["年份", "1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月", "Q1", "Q2", "Q3", "Q4", "全年"];
    const html = labels.map((label, index) => `<div class="heat-cell heat-head ${index === 0 ? "heat-year" : ""} ${index >= 13 && index <= 16 ? "quarter" : ""} ${index === 13 ? "quarter-start" : ""} ${index === 17 ? "year-total" : ""}">${label}</div>`);
    const yearEntries = Object.entries(years);
    Object.entries(years).forEach(([year, months]) => {
      const containsIncomplete = indexes => indexes.some(index => `${year}-${String(index + 1).padStart(2, "0")}` === incompleteMonth);
      const quarters = [0, 1, 2, 3].map(index => {
        const indexes = [index * 3, index * 3 + 1, index * 3 + 2], values = indexes.map(month => months[month]);
        return values.every(Number.isFinite) && !containsIncomplete(indexes) ? compound(values) : null;
      });
      const annualIndexes = Array.from({ length: 12 }, (_, index) => index);
      const annual = months.length === 12 && months.every(Number.isFinite) && !containsIncomplete(annualIndexes) ? compound(months) : null;
      html.push(`<div class="heat-cell heat-year">${year}</div>`);
      [...months, ...quarters, annual].forEach((value, index) => {
        const monthKey = index < 12 ? `${year}-${String(index + 1).padStart(2, "0")}` : null;
        const partial = monthKey === incompleteMonth;
        const title = partial ? ` title="截至 ${asOf} 的月内回报"` : "";
        const display = Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(1)}%${partial ? "*" : ""}` : "—";
        html.push(`<div class="heat-cell ${index >= 12 && index <= 15 ? "quarter" : ""} ${index === 12 ? "quarter-start" : ""} ${index === 16 ? "year-total" : ""} ${partial ? "heat-partial" : ""} ${Number.isFinite(value) ? "" : "heat-empty"}" style="${heatStyle(value)}"${title}>${display}</div>`);
      });
    });
    const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const monthHistory = month => yearEntries.filter(([year]) => `${year}-${String(month + 1).padStart(2, "0")}` !== incompleteMonth).map(([, row]) => row[month]).filter(Number.isFinite);
    const averages = Array.from({ length: 12 }, (_, month) => mean(monthHistory(month)));
    const winRates = Array.from({ length: 12 }, (_, month) => { const values = monthHistory(month); return values.length ? values.filter(value => value > 0).length / values.length : null; });
    const averageQuarters = [0, 1, 2, 3].map(index => {
      const indexes = [index * 3, index * 3 + 1, index * 3 + 2];
      const values = yearEntries.map(([year, row]) => {
        const containsIncomplete = indexes.some(month => `${year}-${String(month + 1).padStart(2, "0")}` === incompleteMonth);
        const months = indexes.map(month => row[month]);
        return months.every(Number.isFinite) && !containsIncomplete ? compound(months) : null;
      }).filter(Number.isFinite);
      return mean(values);
    });
    const averageYear = mean(yearEntries.map(([year, months]) => months.length === 12 && months.every(Number.isFinite) && !incompleteMonth?.startsWith(`${year}-`) ? compound(months) : null).filter(Number.isFinite));
    const best = averages.indexOf(Math.max(...averages)), worst = averages.indexOf(Math.min(...averages));
    html.push('<div class="heat-cell heat-year">历史均值</div>');
    [...averages, ...averageQuarters, averageYear].forEach((value, index) => html.push(`<div class="heat-cell ${index >= 12 && index <= 15 ? "quarter" : ""} ${index === 12 ? "quarter-start" : ""} ${index === 16 ? "year-total" : ""}" style="${heatStyle(value)}">${value > 0 ? "+" : ""}${value.toFixed(1)}%</div>`));
    $("seasonality-heatmap").innerHTML = `<div class="heatmap-grid">${html.join("")}</div>`;
    $("seasonality-insight").querySelector("span").textContent = `历史平均回报最高的是 ${best + 1} 月（${signed(averages[best])}，上涨年份占 ${Math.round(winRates[best] * 100)}%）；最低的是 ${worst + 1} 月（${signed(averages[worst])}）。季节性是统计现象，不是确定规律。`;
  }
  function formatGex(value, showSign = false) {
    if (!Number.isFinite(value)) return "—";
    const sign = value < 0 ? "−" : showSign && value > 0 ? "+" : "", absolute = Math.abs(value);
    if (absolute >= 1e9) return `${sign}$${(absolute / 1e9).toFixed(2)}B`;
    if (absolute >= 1e6) return `${sign}$${(absolute / 1e6).toFixed(1)}M`;
    if (absolute >= 1e3) return `${sign}$${(absolute / 1e3).toFixed(1)}K`;
    return `${sign}$${absolute.toFixed(0)}`;
  }
  function drawGammaChart() {
    const canvas = $("gamma-chart"), rows = gammaChartRows;
    if (!canvas || !rows.length) return;
    ensureChartStage(canvas);
    const { ctx, width, height } = fitCanvas(canvas); ctx.clearRect(0, 0, width, height);
    const pad = responsiveChartPad(canvas, { l: 72, r: 24, t: 24, b: 42 }, { l: 56, r: 14, t: 20, b: 38 }), plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b;
    const maxAbs = Math.max(1, ...rows.flatMap(row => [Math.abs(row.callGex), Math.abs(row.putGex), Math.abs(row.netGex)]));
    const minStrike = rows[0].strike, maxStrike = rows.at(-1).strike;
    const x = row => pad.l + (row.strike - minStrike) / (maxStrike - minStrike || 1) * plotW;
    const y = value => pad.t + (maxAbs - value) / (maxAbs * 2) * plotH;
    const strikeXs = rows.map(x);
    const strikeSteps = strikeXs.slice(1).map((value, index) => value - strikeXs[index]).filter(value => value > 0);
    const minimumStep = strikeSteps.length ? Math.min(...strikeSteps) : plotW / Math.max(1, rows.length);
    const zero = y(0), barW = Math.max(2, Math.min(10, minimumStep * .32));
    ctx.font = chartCanvasFont(width); ctx.textBaseline = "middle";
    for (let index = 0; index <= 4; index++) {
      const value = maxAbs - index / 4 * maxAbs * 2, py = y(value);
      ctx.strokeStyle = index === 2 ? "#525852" : "#202520"; ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(width - pad.r, py); ctx.stroke();
      ctx.fillStyle = "#747b74"; ctx.textAlign = "right"; ctx.fillText(formatGex(value, true), pad.l - 9, py);
    }
    rows.forEach(row => {
      const px = x(row), callY = y(row.callGex), putY = y(row.putGex);
      ctx.fillStyle = "rgba(107,212,155,.78)"; ctx.fillRect(px - barW - 1, Math.min(callY, zero), barW, Math.max(1, Math.abs(zero - callY)));
      ctx.fillStyle = "rgba(233,121,111,.76)"; ctx.fillRect(px + 1, Math.min(putY, zero), barW, Math.max(1, Math.abs(zero - putY)));
    });
    ctx.beginPath();
    rows.forEach((row, index) => index ? ctx.lineTo(x(row), y(row.netGex)) : ctx.moveTo(x(row), y(row.netGex)));
    ctx.strokeStyle = "#e9ae3f"; ctx.lineWidth = 2; ctx.stroke();
    if (Number.isFinite(gammaSpot)) {
      const spotX = pad.l + (gammaSpot - minStrike) / (maxStrike - minStrike || 1) * plotW;
      if (spotX >= pad.l && spotX <= width - pad.r) {
        ctx.setLineDash([5, 5]); ctx.strokeStyle = "#d8d9d2"; ctx.beginPath(); ctx.moveTo(spotX, pad.t); ctx.lineTo(spotX, height - pad.b); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = "#d8d9d2"; ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText(`指数代理 $${gammaSpot.toFixed(0)}`, spotX, pad.t + 3);
      }
    }
    ctx.fillStyle = "#747b74"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    const gammaTickTarget = width < 520 ? 5 : 8;
    rows.forEach((row, index) => { if (index % Math.max(1, Math.ceil(rows.length / gammaTickTarget)) === 0 || index === rows.length - 1) ctx.fillText(`$${row.strike}`, x(row), height - pad.b + 11); });
    bindChartHover(canvas, {
      rows,
      value: row => row.strike,
      domain: [rows[0].strike, rows.at(-1).strike],
      pad,
      title: row => `执行价 $${row.strike.toLocaleString("en-US")}`,
      lines: row => [
        { label: "Call 代理 GEX", value: formatGex(row.callGex, true) },
        { label: "Put 代理 GEX", value: formatGex(row.putGex, true) },
        { label: "净代理 GEX", value: formatGex(row.netGex, true) },
        { label: "距指数代理价", value: strikeDistance(row.strike, gammaSpot) || "—" }
      ]
    });
  }
  function gammaZeroReference(rows, spot) {
    const candidates = [];
    rows.forEach((row, index) => {
      if (row.netGex === 0) candidates.push(row.strike);
      const next = rows[index + 1];
      if (!next || row.netGex === 0 || next.netGex === 0 || Math.sign(row.netGex) === Math.sign(next.netGex)) return;
      const weight = Math.abs(row.netGex) / (Math.abs(row.netGex) + Math.abs(next.netGex));
      candidates.push(row.strike + (next.strike - row.strike) * weight);
    });
    if (!candidates.length) return null;
    return candidates.reduce((nearest, value) => Math.abs(value - spot) < Math.abs(nearest - spot) ? value : nearest, candidates[0]);
  }
  function strikeDistance(strike, spot) {
    if (!Number.isFinite(strike) || !Number.isFinite(spot) || spot === 0) return "";
    const distance = (strike / spot - 1) * 100;
    return `距指数代理价 ${distance >= 0 ? "+" : ""}${distance.toFixed(1)}%`;
  }
  function classifyStablecoinChange(change) {
    if (!Number.isFinite(change)) return { label: "数据不足", tone: "neutral", direction: 0, text: "稳定币供给变化暂不可计算。" };
    const absolute = Math.abs(change);
    if (absolute <= SIGNAL_THRESHOLDS.stablecoinFlatPercent) {
      return { label: "基本持平", tone: "neutral", direction: 0, text: `稳定币供给基本持平（${signed(change)}），暂未出现明确扩张或收缩趋势。` };
    }
    const expanding = change > 0;
    const strong = absolute >= SIGNAL_THRESHOLDS.stablecoinStrongPercent;
    return {
      label: `${strong ? "明显" : "小幅"}${expanding ? "扩张" : "收缩"}`,
      tone: expanding ? "positive" : "negative",
      direction: expanding ? 1 : -1,
      text: `稳定币供给${strong ? "明显" : "小幅"}${expanding ? "扩张" : "收缩"}（${signed(change)}）。`
    };
  }

  function setMarketStateCard(key, model) {
    todayMarketModels[key] = { ...model };
    const card = $(`market-state-${key}`);
    if (!card) return;
    card.dataset.tone = model.tone || "neutral";
    card.dataset.dataState = model.dataState || "ready";
    $(`market-state-${key}-label`).textContent = model.label;
    $(`market-state-${key}-primary`).textContent = model.primary;
    $(`market-state-${key}-secondary`).textContent = model.secondary;
    $(`market-state-${key}-reason`).textContent = model.reason;
    $(`market-state-${key}-asof`).textContent = model.asOf;
  }

  function renderMarketBrief() {
    const brief = $("market-brief"), text = $("market-brief-text");
    if (!brief || !text) return;
    const items = [
      ["capital", "ETF 资金"],
      ["trend", "BTC 趋势"],
      ["sentiment", "市场情绪"],
      ["liquidity", "稳定币供给"]
    ];
    const models = items.map(([key, title]) => ({ key, title, ...(todayMarketModels[key] || {}) }));
    if (models.some(model => !model.label)) return;

    const nextText = models.every(model => model.dataState === "pending")
      ? "资金、趋势、情绪与流动性正在加载，暂不生成市场简报。"
      : `${models.map(model => `${model.title}：${model.label}`).join("；")}；四项独立观察，不合成总分。`;
    if (text.textContent !== nextText) text.textContent = nextText;

    const directional = models.filter(model => model.key !== "sentiment" && !["pending", "error", "stale"].includes(model.dataState));
    const tones = directional.map(model => model.tone).filter(tone => tone && tone !== "neutral");
    const hasPositive = tones.includes("positive"), hasNegative = tones.includes("negative"), hasMixed = tones.includes("mixed");
    brief.dataset.tone = hasMixed || (hasPositive && hasNegative) ? "mixed"
      : tones.filter(tone => tone === "positive").length >= 2 ? "positive"
        : tones.filter(tone => tone === "negative").length >= 2 ? "negative" : "neutral";
  }

  function trendReturn(days) {
    const current = Number.isFinite(latestBtcPrice) ? latestBtcPrice : btcCandles.at(-1)?.close;
    if (!Number.isFinite(current) || !btcCandles.length) return null;
    const fallbackDate = btcCandles.at(-1)?.date;
    const referenceValue = currentBtcAsOf || moduleUpdatedAt.market || (fallbackDate ? `${fallbackDate}T00:00:00Z` : "");
    const reference = typeof referenceValue === "number" ? referenceValue : Date.parse(referenceValue);
    if (!Number.isFinite(reference)) return null;
    const dayMs = 86400000, target = reference - days * dayMs;
    const candidates = btcCandles.map(row => ({ row, timestamp: Date.parse(`${row.date}T00:00:00Z`) })).filter(item => Number.isFinite(item.timestamp));
    const anchor = candidates.reduce((best, item) => !best || Math.abs(item.timestamp - target) < Math.abs(best.timestamp - target) ? item : best, null);
    if (!anchor || Math.abs(anchor.timestamp - target) > 1.5 * dayMs || !Number.isFinite(anchor.row.close) || anchor.row.close <= 0) return null;
    return {
      value: (current / anchor.row.close - 1) * 100,
      anchorDate: anchor.row.date,
      windowDays: (reference - anchor.timestamp) / dayMs,
      referenceAt: new Date(reference).toISOString()
    };
  }

  function marketInputState(group) {
    const state = sourceStates[group];
    if (!state) return "pending";
    if (state === "error") return "error";
    const meta = marketInputMeta[group] || {};
    if (meta.missing === true) return "error";
    if (meta.stale === true) return "stale";
    const fetchedAt = Date.parse(meta.fetchedAt || "");
    if (!isSnapshotMode && Number.isFinite(fetchedAt) && Number.isFinite(meta.targetSeconds) && Date.now() - fetchedAt > meta.targetSeconds * 1000) return "stale";
    if (isSnapshotStale()) return "stale";
    return state;
  }

  function completedUtcWeekdaysSince(asOf, now = Date.now()) {
    const start = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(asOf || "")) ? `${asOf}T00:00:00Z` : String(asOf || ""));
    if (!Number.isFinite(start)) return null;
    const current = new Date(now);
    const today = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
    const latestCompletedDate = today - (current.getUTCHours() < 23 ? 86400000 : 0);
    let weekdays = 0;
    for (let cursor = start + 86400000; cursor <= latestCompletedDate; cursor += 86400000) {
      const day = new Date(cursor).getUTCDay();
      if (day >= 1 && day <= 5) weekdays += 1;
    }
    return weekdays;
  }

  function marketDeliveryNote(state) {
    if (state === "cached") return " 当前读数来自浏览器缓存。";
    if (state === "partial") return " 当前为部分上游可用状态。";
    return "";
  }

  function directionWithBand(value, band) {
    if (!Number.isFinite(value)) return null;
    if (value > band) return 1;
    if (value < -band) return -1;
    return 0;
  }

  function renderTodayMarketState() {
    const etfAsOf = staticData?.sources?.etfFlows?.asOf || staticData?.asOf || "—";
    const capitalReady = Number.isFinite(currentEtf5d) && Number.isFinite(currentEtf20d);
    const completedWeekdays = completedUtcWeekdaysSince(etfAsOf);
    const capitalDateMissing = !Number.isFinite(completedWeekdays);
    const capitalStale = Number.isFinite(completedWeekdays) && completedWeekdays > 2;
    let capitalLabel = "数据不足", capitalTone = "neutral", capitalReason = "ETF 5D 或 20D 窗口尚未形成，暂不判断资金方向。";
    if (capitalReady) {
      const shortDirection = Math.sign(currentEtf5d), mediumDirection = Math.sign(currentEtf20d);
      if (shortDirection > 0 && mediumDirection > 0) { capitalLabel = "持续净流入"; capitalTone = "positive"; capitalReason = "ETF 5D 与 20D 净流均为正，短中期资金方向一致。"; }
      else if (shortDirection < 0 && mediumDirection < 0) { capitalLabel = "持续净流出"; capitalTone = "negative"; capitalReason = "ETF 5D 与 20D 净流均为负，短中期资金同步承压。"; }
      else if (shortDirection > 0) { capitalLabel = "短期转强"; capitalTone = "mixed"; capitalReason = "ETF 5D 转为净流入，但 20D 尚未确认。"; }
      else if (shortDirection < 0) { capitalLabel = "短期转弱"; capitalTone = "mixed"; capitalReason = "ETF 5D 转为净流出，但 20D 仍有支撑。"; }
      else { capitalLabel = "短期持平"; capitalReason = "ETF 5D 净流接近零，先观察 20D 方向。"; }
    }
    if (capitalDateMissing) { capitalLabel = "截止日无效"; capitalTone = "neutral"; capitalReason = "ETF 快照缺少有效截止日，暂不输出资金方向。"; }
    else if (capitalStale) { capitalLabel = "快照已过期"; capitalTone = "neutral"; capitalReason = "ETF 快照已落后超过 2 个已完成工作日，仅保留历史读数，不输出资金方向。"; }
    setMarketStateCard("capital", {
      label: capitalLabel, tone: capitalTone,
      dataState: capitalDateMissing ? "error" : capitalStale ? "stale" : capitalReady ? "ready" : "error",
      primary: Number.isFinite(currentEtf5d) ? flow(currentEtf5d) : "—",
      secondary: Number.isFinite(currentEtf20d) ? flow(currentEtf20d) : "—",
      reason: capitalReason,
      asOf: `Farside / SoSoValue · ${capitalReady && !capitalDateMissing ? `截至 ${etfAsOf}` : "截止日待确认"}`
    });

    const trendState = marketInputState("price");
    const return7d = trendReturn(7), return30d = trendReturn(30);
    const direction7d = directionWithBand(return7d?.value, SIGNAL_THRESHOLDS.btcTrendFlatPercent);
    const direction30d = directionWithBand(return30d?.value, SIGNAL_THRESHOLDS.btcTrendFlatPercent);
    let trendLabel = "数据不足", trendTone = "neutral", trendReason = "BTC 日 K 历史窗口不足，暂不判断趋势。";
    if (direction7d !== null && direction30d !== null) {
      if (direction7d > 0 && direction30d > 0) { trendLabel = "短中期上行"; trendTone = "positive"; trendReason = "BTC 7D 与 30D 回报均高于 +1% 横盘带。"; }
      else if (direction7d < 0 && direction30d < 0) { trendLabel = "短中期走弱"; trendTone = "negative"; trendReason = "BTC 7D 与 30D 回报均低于 -1% 横盘带。"; }
      else if (direction7d > 0 && direction30d <= 0) { trendLabel = "短线修复"; trendTone = "mixed"; trendReason = "BTC 7D 转强，但 30D 趋势尚未同步确认。"; }
      else if (direction7d < 0 && direction30d >= 0) { trendLabel = "短线回撤"; trendTone = "mixed"; trendReason = "BTC 7D 转弱，但 30D 方向仍未同步走弱。"; }
      else { trendLabel = "横盘 / 分歧"; trendReason = "至少一个周期位于 ±1% 横盘带内，方向尚不一致。"; }
    }
    const trendBlocked = trendState === "pending" || trendState === "error" || trendState === "stale";
    setMarketStateCard("trend", {
      label: trendState === "pending" ? "正在加载" : trendState === "error" ? "暂不可用" : trendState === "stale" ? "快照已过期" : trendLabel,
      tone: trendBlocked ? "neutral" : trendTone,
      dataState: trendState,
      primary: trendState === "error" || trendState === "pending" ? "—" : Number.isFinite(return7d?.value) ? signed(return7d.value) : "—",
      secondary: trendState === "error" || trendState === "pending" ? "—" : Number.isFinite(return30d?.value) ? signed(return30d.value) : "—",
      reason: trendState === "pending" ? "正在读取现价与已收盘日 K，暂不输出方向。"
        : trendState === "error" ? "行情服务当前不可用，方向结论已暂停。"
          : trendState === "stale" ? "快照超过有效期，仅保留历史读数，不输出趋势方向。"
            : `${trendReason}${Number.isFinite(latestBtcPrice) ? ` 当前价 ${fmtUsd(latestBtcPrice, 0)}。` : ""}${marketDeliveryNote(trendState)}`,
      asOf: `现价：${currentBtcProvider || "待确认"}${currentBtcAsOf ? ` · ${shortUpdatedAt(currentBtcAsOf)}` : ""} / K线：Gate.io${currentBtcCandlesAsOf ? ` · ${shortUpdatedAt(currentBtcCandlesAsOf)}` : ""}`
    });

    const sentimentState = marketInputState("sentiment");
    const sentimentLabel = Number.isFinite(currentFearGreed) ? (currentFearGreedLabel || fearGreedLabel(currentFearGreed)) : "数据不足";
    const sentimentTone = !Number.isFinite(currentFearGreed) ? "neutral" : currentFearGreed > 75 ? "negative" : currentFearGreed > 55 ? "mixed" : currentFearGreed < 25 ? "negative" : currentFearGreed < 45 ? "mixed" : "neutral";
    const sentimentReason = Number.isFinite(currentFearGreed)
      ? `沿用官方五档区间；${sentimentLabel.includes("贪婪") ? "情绪偏热不等于价格立即见顶" : sentimentLabel.includes("恐慌") ? "情绪偏冷不等于价格立即见底" : "当前处于中性区间"}。`
      : "恐慌与贪婪指数暂不可用。";
    setMarketStateCard("sentiment", {
      label: sentimentState === "pending" ? "正在加载" : sentimentState === "error" ? "暂不可用" : sentimentState === "stale" ? "快照已过期" : sentimentLabel,
      tone: ["pending", "error", "stale"].includes(sentimentState) ? "neutral" : sentimentTone,
      dataState: sentimentState,
      primary: ["pending", "error"].includes(sentimentState) ? "—" : Number.isFinite(currentFearGreed) ? String(Math.round(currentFearGreed)) : "—",
      secondary: ["pending", "error"].includes(sentimentState) ? "—" : Number.isFinite(currentFearGreed7dChange) ? `${currentFearGreed7dChange > 0 ? "+" : ""}${currentFearGreed7dChange.toFixed(0)} 点` : "—",
      reason: sentimentState === "pending" ? "正在读取恐慌与贪婪指数，暂不输出情绪结论。"
        : sentimentState === "error" ? "情绪服务当前不可用，结论已暂停。"
          : sentimentState === "stale" ? "快照超过有效期，仅保留历史读数，不输出情绪结论。"
            : `${sentimentReason}${Number.isFinite(currentFearGreedWindowDays) ? ` 变化窗口 ${currentFearGreedWindowDays.toFixed(0)} 个自然日。` : ""}${marketDeliveryNote(sentimentState)}`,
      asOf: `Alternative.me · ${currentFearGreedAsOf ? `截至 ${currentFearGreedAsOf}` : "截止日待确认"}`
    });

    const liquidityState = marketInputState("defi");
    const liquidity = classifyStablecoinChange(currentStable30dChange);
    const windowReady = Number.isFinite(currentStableWindowDays) && currentStableWindowDays >= 28 && currentStableWindowDays <= 35;
    setMarketStateCard("liquidity", {
      label: liquidityState === "pending" ? "正在加载" : liquidityState === "error" ? "暂不可用" : liquidityState === "stale" ? "快照已过期" : windowReady ? liquidity.label : "数据不足",
      tone: ["pending", "error", "stale"].includes(liquidityState) ? "neutral" : windowReady ? liquidity.tone : "neutral",
      dataState: liquidityState,
      primary: ["pending", "error"].includes(liquidityState) ? "—" : windowReady ? signed(currentStable30dChange) : "—",
      secondary: ["pending", "error"].includes(liquidityState) ? "—" : Number.isFinite(currentStableSupply) ? `$${compact(currentStableSupply)}` : "—",
      reason: liquidityState === "pending" ? "正在读取稳定币供给历史，暂不输出流动性方向。"
        : liquidityState === "error" ? "DefiLlama 当前不可用，流动性结论已暂停。"
          : liquidityState === "stale" ? "快照超过有效期，仅保留历史读数，不输出流动性方向。"
            : windowReady ? `${liquidity.text} 供给变化不等于资金一定买入 BTC。${marketDeliveryNote(liquidityState)}` : "历史窗口不在 28–35 天内，暂不推断月度方向。",
      asOf: `DefiLlama · ${currentStableAsOf ? `截至 ${currentStableAsOf}` : "截止日待确认"}`
    });
    renderMarketBrief();
  }

  function clearGammaValues() {
    gammaChartRows = [];
    gammaSpot = null;
    gammaNetGex = null;
    ["gamma-net", "gamma-positive", "gamma-negative", "gamma-expiry", "gamma-max-pain", "gamma-pc-oi"].forEach(id => {
      if ($(id)) $(id).textContent = "—";
    });
    if ($("gamma-key-insight")) {
      const text = $("gamma-key-insight").querySelector("span") || $("gamma-key-insight");
      text.textContent = "Deribit OI 与标记 IV 数据恢复后，将在这里给出模型 Gamma 峰值、Max Pain 与局部过零参考位。";
    }
  }

  async function loadGamma() {
    const panel = document.querySelector(".gamma-panel"), state = $("gamma-state"), message = $("gamma-message");
    if (!panel || !state || !message) return;
    try {
      const result = await getJSON("serviceGammaV2", endpoints.gamma, 5 * 60 * 1000, 30_000);
      const data = result.value || {};
      const successAt = Date.parse(data.lastSuccessAt || data.asOf || ""), gammaAgeMs = Number.isFinite(successAt) ? Date.now() - successAt : NaN;
      const usable = data.schemaVersion === 2
        && data.venue === "Deribit"
        && data.gammaSource === "deribit-inverse-bs-v2-from-mark-iv"
        && ["live", "partial"].includes(data.status)
        && Number.isFinite(gammaAgeMs)
        && gammaAgeMs >= -5 * 60 * 1000
        && gammaAgeMs <= 24 * 60 * 60 * 1000
        && Array.isArray(data.byStrike)
        && data.byStrike.length;
      if (!usable) throw new Error("invalid gamma payload");
      gammaChartRows = data.byStrike.map(row => ({ strike: num(row.strike), callGex: num(row.callGex), putGex: num(row.putGex), netGex: num(row.netGex) })).filter(row => [row.strike, row.callGex, row.putGex, row.netGex].every(Number.isFinite)).sort((a, b) => a.strike - b.strike);
      gammaSpot = num(data.spot);
      gammaNetGex = num(data.netGex);
      if (!gammaChartRows.length || !Number.isFinite(gammaSpot) || gammaSpot <= 0 || !Number.isFinite(gammaNetGex)) throw new Error("invalid gamma payload");
      const positive = gammaChartRows.reduce((best, row) => row.callGex > best.callGex ? row : best, gammaChartRows[0]);
      const negative = gammaChartRows.reduce((best, row) => row.putGex < best.putGex ? row : best, gammaChartRows[0]);
      const zeroReference = gammaZeroReference(gammaChartRows, gammaSpot);
      $("gamma-net").textContent = formatGex(gammaNetGex, true);
      $("gamma-positive").textContent = `$${positive.strike} · ${strikeDistance(positive.strike, gammaSpot)}`;
      $("gamma-negative").textContent = `$${negative.strike} · ${strikeDistance(negative.strike, gammaSpot)}`;
      $("gamma-expiry").textContent = data.expiry || "—";
      if ($("gamma-max-pain")) $("gamma-max-pain").textContent = Number.isFinite(num(data.maxPain)) ? fmtUsd(num(data.maxPain), 0) : "—";
      if ($("gamma-pc-oi")) $("gamma-pc-oi").textContent = Number.isFinite(num(data.putCallOiRatio)) ? num(data.putCallOiRatio).toFixed(2) : "—";
      if ($("gamma-key-insight")) {
        const keyText = $("gamma-key-insight").querySelector("span") || $("gamma-key-insight");
        keyText.textContent = `指数代理价 ${fmtUsd(gammaSpot, 0)}；Call 峰值在 $${positive.strike.toLocaleString("en-US")}（${strikeDistance(positive.strike, gammaSpot)}），Put 峰值在 $${negative.strike.toLocaleString("en-US")}（${strikeDistance(negative.strike, gammaSpot)}）。${Number.isFinite(zeroReference) ? `局部净 GEX 过零参考约 $${Math.round(zeroReference).toLocaleString("en-US")}；` : ""}Max Pain 参考 ${Number.isFinite(num(data.maxPain)) ? fmtUsd(num(data.maxPain), 0) : "暂缺"}。这些都不是严格的 dealer Gamma Flip。`;
      }
      const contractCoverage = num(data.coverage), oiCoverage = num(data.coverageDetail?.oiRatio);
      const degraded = data.stale === true || data.status === "partial" || result.state === "cached" || isSnapshotStale();
      message.textContent = data.message || `${isSnapshotMode ? "GitHub Actions 定时抓取的 " : ""}Deribit 最近有效到期；模型 Gamma 覆盖 ${Number.isFinite(contractCoverage) ? Math.round(contractCoverage * 100) + "% 合约" : "合约口径待确认"}${Number.isFinite(oiCoverage) ? `、${Math.round(oiCoverage * 100)}% OI` : ""}。`;
      panel.classList.remove("is-unavailable"); panel.classList.add("is-live"); panel.classList.toggle("is-degraded", degraded);
      const displayState = data.stale === true || result.state === "cached" ? "cached" : data.status === "partial" ? "partial" : "live";
      state.textContent = sourceStateLabel(displayState); state.classList.remove("error", "partial", "cached", "live"); state.classList.add(displayState === "cached" ? "cached" : displayState === "partial" || isSnapshotStale() ? "partial" : "live");
      setState("gamma", displayState, data.asOf || data.lastSuccessAt);
      renderTodayMarketState();
      requestAnimationFrame(drawGammaChart);
    } catch {
      clearGammaValues();
      panel.classList.add("is-unavailable"); panel.classList.remove("is-live", "is-degraded"); state.textContent = "UNAVAILABLE"; state.classList.remove("live", "partial", "cached"); state.classList.add("error");
      setState("gamma", "error", Date.now());
      message.textContent = isSnapshotMode ? "本次 Deribit Gamma 快照不可用，且没有 24 小时内的最后成功值；IBIT 成交量与总 OI 快照仍可正常使用。" : "Deribit 官方公开接口暂不可达，且本机没有 24 小时内的最后成功值；IBIT 快照仍可正常使用。";
      renderTodayMarketState();
    }
  }
  function updateMarketInsight() {
    if (!$("market-insight")) return;
    if (!Number.isFinite(currentBtcChange) && !Number.isFinite(currentFearGreed)) return;
    const parts = [];
    if (Number.isFinite(currentBtcChange)) {
      const flat = Math.abs(currentBtcChange) < SIGNAL_THRESHOLDS.btc24hFlatPercent;
      parts.push(flat ? `BTC 过去 24 小时基本持平（${signed(currentBtcChange)}）` : `BTC 过去 24 小时${currentBtcChange > 0 ? "上涨" : "下跌"} ${Math.abs(currentBtcChange).toFixed(2)}%`);
    }
    const label = currentFearGreedLabel || fearGreedLabel(currentFearGreed);
    if (Number.isFinite(currentFearGreed)) parts.push(`情绪指数 ${currentFearGreed}，处于${label}`);
    const warning = label === "极度贪婪" ? "情绪偏热，追涨风险上升。" : label === "极度恐慌" ? "情绪偏冷，市场风险偏好较弱。" : "情绪尚未进入极端区间。";
    $("market-insight").querySelector("span").textContent = `${parts.join("；")}。${warning}`;
  }

  async function loadPrices() {
    const results = await Promise.allSettled([
      getJSON("gateBtcTicker", endpoints.gateBtcTicker, 60000),
      getJSON("gateEthTicker", endpoints.gateEthTicker, 60000),
      getJSON("prices", endpoints.prices, 60000),
      getJSON("global", endpoints.global, 180000),
      getJSON("btcCandles", endpoints.btcCandles, 900000)
    ]);
    const gateBtc = results[0].status === "fulfilled" ? results[0].value.value?.[0] || {} : {};
    const gateEth = results[1].status === "fulfilled" ? results[1].value.value?.[0] || {} : {};
    const coinGecko = results[2].status === "fulfilled" ? results[2].value.value || {} : {};
    const btcFallback = coinGecko.bitcoin || {}, ethFallback = coinGecko.ethereum || {};
    const btcPrice = Number.isFinite(num(gateBtc.last)) ? num(gateBtc.last) : num(btcFallback.usd);
    const ethPrice = Number.isFinite(num(gateEth.last)) ? num(gateEth.last) : num(ethFallback.usd);
    const btcChange = Number.isFinite(num(gateBtc.change_percentage)) ? num(gateBtc.change_percentage) : num(btcFallback.usd_24h_change);
    const ethChange = Number.isFinite(num(gateEth.change_percentage)) ? num(gateEth.change_percentage) : num(ethFallback.usd_24h_change);
    const priceState = Number.isFinite(num(gateBtc.last)) ? results[0].value.state : results[2].status === "fulfilled" ? results[2].value.state : "error";
    setState("price", priceState);
    setState("market", groupState(results));
    if (Number.isFinite(btcPrice)) {
      latestBtcPrice = btcPrice;
      currentBtcChange = btcChange;
      $("btc-price").textContent = fmtUsd(btcPrice, 0); $("ticker-btc").textContent = fmtUsd(btcPrice, 0); $("ticker-eth").textContent = fmtUsd(ethPrice, 0);
      $("btc-change").textContent = `${signed(btcChange)} · 过去 24 小时 · ${Number.isFinite(num(gateBtc.last)) ? "Gate.io BTC/USDT" : "CoinGecko 备用"}`;
      $("ticker-btc-change").textContent = signed(btcChange); $("ticker-eth-change").textContent = signed(ethChange);
      tone($("btc-change"), btcChange); tone($("ticker-btc-change"), btcChange); tone($("ticker-eth-change"), ethChange);
      requestAnimationFrame(() => drawEtfCombo());
      updateMarketInsight();
    }
    if (results[2].status === "fulfilled") {
      const data = results[2].value.value;
      const ids = [["bitcoin", "BTC"], ["ethereum", "ETH"], ["solana", "SOL"], ["ripple", "XRP"], ["binancecoin", "BNB"], ["dogecoin", "DOGE"]];
      $("coin-list").innerHTML = ids.map(([id, sym], index) => { const d = data[id] || {}; const chg = num(d.usd_24h_change); return `<div class="coin-row"><i>${String(index + 1).padStart(2, "0")}</i><b class="coin-name">${sym}<small>${esc(id)}</small></b><span>${esc(fmtUsd(num(d.usd), num(d.usd) < 10 ? 3 : 0))}<small class="${chg > 0 ? "up" : chg < 0 ? "down" : ""}">${esc(signed(chg))}</small></span><span class="coin-mcap">${esc(compact(num(d.usd_market_cap)))}</span></div>`; }).join("");
    } else if (Number.isFinite(btcPrice)) {
      const fallbackRows = [["BTC", btcPrice, btcChange], ["ETH", ethPrice, ethChange]];
      $("coin-list").innerHTML = fallbackRows.map(([symbol, price, change], index) => `<div class="coin-row"><i>${String(index + 1).padStart(2, "0")}</i><b class="coin-name">${symbol}<small>Gate.io spot</small></b><span>${esc(fmtUsd(price, symbol === "ETH" ? 2 : 0))}<small class="${change > 0 ? "up" : change < 0 ? "down" : ""}">${esc(signed(change))}</small></span><span class="coin-mcap">市值暂缺</span></div>`).join("");
    }
    if (results[3].status === "fulfilled") {
      const d = results[3].value.value.data || {};
      const mcap = num(d.total_market_cap?.usd), vol = num(d.total_volume?.usd), btcDom = num(d.market_cap_percentage?.btc), ethDom = num(d.market_cap_percentage?.eth);
      $("ticker-mcap").textContent = `$${compact(mcap)}`; $("global-mcap").textContent = fmtUsd(mcap); $("global-volume").textContent = fmtUsd(vol); $("global-btc-dom").textContent = signed(btcDom, "%", 1).replace("+", ""); $("global-eth-dom").textContent = signed(ethDom, "%", 1).replace("+", ""); $("global-coins").textContent = new Intl.NumberFormat("en-US").format(num(d.active_cryptocurrencies) || 0); $("stat-dominance").textContent = `${btcDom?.toFixed(1) || "—"}%`;
    }
    if (results[4].status === "fulfilled") {
      btcCandles = (Array.isArray(results[4].value.value) ? results[4].value.value : []).map(row => {
        const timestamp = num(row?.[0]);
        const closed = row?.[7] !== false && String(row?.[7]).toLowerCase() !== "false";
        if (!Number.isFinite(timestamp) || !closed) return null;
        const date = new Date(timestamp * 1000);
        if (Number.isNaN(date.getTime())) return null;
        return { date: date.toISOString().slice(0, 10), open: num(row[5]), high: num(row[3]), low: num(row[4]), close: num(row[2]) };
      }).filter(row => row && [row.open, row.high, row.low, row.close].every(Number.isFinite)).sort((a, b) => a.date.localeCompare(b.date));
      lastPriceSeries = btcCandles.slice(-30).map(row => row.close);
      if (lastPriceSeries.length) {
        $("price-period").textContent = `30D · GATE.IO${isSnapshotMode ? " SNAPSHOT" : ""}`; $("btc-low").textContent = fmtUsd(Math.min(...lastPriceSeries), 0); $("btc-high").textContent = fmtUsd(Math.max(...lastPriceSeries), 0);
        requestAnimationFrame(() => { drawLine($("price-chart"), lastPriceSeries); drawFearGreedKline(); });
      }
    }
  }

  async function loadSentiment() {
    try {
      const result = await getJSON("fng", endpoints.fng, 900000); const rows = result.value.data || []; if (!rows.length) throw new Error("empty");
      fearGreedRows = rows.map(row => {
        const timestamp = num(row?.timestamp), rowValue = num(row?.value);
        if (!Number.isFinite(timestamp) || !Number.isFinite(rowValue)) return null;
        const date = new Date(timestamp * 1000);
        return Number.isNaN(date.getTime()) ? null : { date: date.toISOString().slice(0, 10), value: rowValue, rawLabel: row?.value_classification || "" };
      }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
      const latest = fearGreedRows.at(-1); if (!latest) throw new Error("invalid current value");
      const value = latest.value;
      const targetDate = new Date(new Date(`${latest.date}T00:00:00Z`).getTime() - 7 * 86400000).toISOString().slice(0, 10);
      const prior = fearGreedRows.find(row => row.date === targetDate);
      const weeklyChange = prior ? value - prior.value : null;
      currentFearGreedLabel = fearGreedLabel(value, latest.rawLabel);
      $("ticker-fng").textContent = `${value} ${currentFearGreedLabel}`;
      $("stat-fng").textContent = value;
      $("stat-fng-label").textContent = currentFearGreedLabel;
      $("gauge-value").textContent = value;
      $("fng-7d").textContent = Number.isFinite(weeklyChange) ? `${weeklyChange > 0 ? "+" : ""}${weeklyChange.toFixed(0)} 点` : "—";
      tone($("fng-7d"), weeklyChange);
      currentFearGreed = value;
      updateMarketInsight();
      requestAnimationFrame(() => { drawFearGreedGauge(value); drawFearGreedKline(); });
    } catch { /* standalone indicator remains unavailable */ }
  }
  async function loadOnchain() {
    const results = await Promise.allSettled([
      getJSON("blockstreamFees", endpoints.blockstreamFees, 300000),
      getJSON("blockstreamMempool", endpoints.blockstreamMempool, 300000),
      getJSON("blockstreamHeight", endpoints.blockstreamHeight, 300000),
      getJSON("blockchairStats", endpoints.blockchairStats, 600000),
      getJSON("mempoolFees", endpoints.mempoolFees, 300000),
      getJSON("mempoolHeight", endpoints.mempoolHeight, 300000)
    ]);
    setState("onchain", groupState(results));
    const fulfilled = index => results[index].status === "fulfilled";
    const blockchair = fulfilled(3) ? results[3].value.value?.data || {} : {};
    let fast = null, hour = null, feeSource = "";
    if (fulfilled(0)) {
      const data = results[0].value.value || {};
      fast = num(data["1"]); hour = num(data["6"]); feeSource = "Blockstream";
    } else if (fulfilled(4)) {
      const data = results[4].value.value || {};
      fast = num(data.fastestFee); hour = num(data.hourFee); feeSource = "mempool.space 备用";
    }
    const feeText = value => Number.isFinite(value) ? (value >= 10 ? String(Math.round(value)) : value.toFixed(1)) : "—";
    if (Number.isFinite(fast)) {
      $("fee-fast").textContent = feeText(fast); $("fee-hour").textContent = feeText(hour); $("ticker-fee").textContent = `${feeText(fast)} sat/vB`;
    }
    const height = fulfilled(2) ? num(results[2].value.value) : Number.isFinite(num(blockchair.best_block_height)) ? num(blockchair.best_block_height) : fulfilled(5) ? num(results[5].value.value) : null;
    if (Number.isFinite(height)) $("chain-height").textContent = new Intl.NumberFormat("en-US").format(height);
    let mempoolCount = null, mempoolSize = null, mempoolUnit = "";
    if (fulfilled(1)) {
      const data = results[1].value.value || {};
      mempoolCount = num(data.count); mempoolSize = num(data.vsize); mempoolUnit = "vMB";
    } else if (Number.isFinite(num(blockchair.mempool_transactions))) {
      mempoolCount = num(blockchair.mempool_transactions); mempoolSize = num(blockchair.mempool_size); mempoolUnit = "MB";
    }
    if (Number.isFinite(mempoolCount)) $("mempool-count").textContent = new Intl.NumberFormat("en-US").format(mempoolCount);
    if (Number.isFinite(mempoolSize)) $("mempool-vsize").textContent = `内存池体积 ${(mempoolSize / 1e6).toFixed(1)} ${mempoolUnit}`;
    if (Number.isFinite(fast) || Number.isFinite(mempoolCount)) {
      const parts = [];
      if (Number.isFinite(fast)) parts.push(`下一块费率约 ${feeText(fast)} sat/vB`);
      if (Number.isFinite(mempoolCount)) parts.push(`数据源节点待确认 ${new Intl.NumberFormat("zh-CN").format(mempoolCount)} 笔${Number.isFinite(mempoolSize) ? `、约 ${(mempoolSize / 1e6).toFixed(1)} ${mempoolUnit}` : ""}`);
      const reading = Number.isFinite(fast) && fast <= 5 ? "当前优先确认成本较低。" : Number.isFinite(fast) && fast <= 20 ? "当前费用处于常见区间。" : Number.isFinite(fast) ? "当前优先确认成本偏高。" : "费率暂不可用，仅展示待确认规模。";
      $("onchain-insight").querySelector("span").textContent = `${parts.join("；")}。${reading} 来源：${feeSource || (fulfilled(1) ? "Blockstream" : "Blockchair 备用")}。`;
    } else $("onchain-insight").querySelector("span").textContent = "Blockstream、Blockchair 与 mempool.space 当前均不可达，暂不判断拥堵程度。";
  }

  async function loadMarketService() {
    try {
      const result = await getJSON("serviceMarket", endpoints.market, 120000, 10000);
      const payload = result.value || {}, data = payload.data || {}, assets = data.assets || {}, updatedAt = payload.updatedAt || Date.now();
      const state = payloadState(payload, result.state);
      setState("price", state, updatedAt); setState("market", state, updatedAt); updateCompositeMarketTime();
      currentBtcProvider = data.btcPriceProvider || data.priceProvider || "统一数据服务";
      currentBtcAsOf = data.btcPriceAsOf || updatedAt;
      currentBtcCandlesAsOf = data.btcCandlesAsOf || updatedAt;
      const btc = assets.bitcoin || {}, eth = assets.ethereum || {};
      const btcPrice = num(btc.usd), ethPrice = num(eth.usd), btcChange = num(btc.usd24hChange), ethChange = num(eth.usd24hChange);
      if (Number.isFinite(btcPrice)) {
        latestBtcPrice = btcPrice; currentBtcChange = btcChange;
        $("btc-price").textContent = fmtUsd(btcPrice, 0); $("ticker-btc").textContent = fmtUsd(btcPrice, 0); $("ticker-eth").textContent = fmtUsd(ethPrice, 0);
        $("btc-change").textContent = `${signed(btcChange)} · 过去 24 小时 · ${data.btcPriceProvider || data.priceProvider || "统一数据服务"}`;
        $("ticker-btc-change").textContent = signed(btcChange); $("ticker-eth-change").textContent = signed(ethChange);
        tone($("btc-change"), btcChange); tone($("ticker-btc-change"), btcChange); tone($("ticker-eth-change"), ethChange);
      }
      const ids = [["bitcoin", "BTC"], ["ethereum", "ETH"], ["solana", "SOL"], ["ripple", "XRP"], ["binancecoin", "BNB"], ["dogecoin", "DOGE"]];
      const available = ids.filter(([id]) => Number.isFinite(num(assets[id]?.usd)));
      if (available.length) $("coin-list").innerHTML = available.map(([id, symbol], index) => {
        const asset = assets[id] || {}, change = num(asset.usd24hChange), price = num(asset.usd), marketCap = num(asset.usdMarketCap);
        return `<div class="coin-row"><i>${String(index + 1).padStart(2, "0")}</i><b class="coin-name">${symbol}<small>${esc(id)}</small></b><span>${esc(fmtUsd(price, price < 10 ? 3 : 0))}<small class="${change > 0 ? "up" : change < 0 ? "down" : ""}">${esc(signed(change))}</small></span><span class="coin-mcap">${Number.isFinite(marketCap) ? esc(compact(marketCap)) : "市值暂缺"}</span></div>`;
      }).join("");
      const global = data.global || {}, marketCap = num(global.totalMarketCapUsd), volume = num(global.totalVolumeUsd), btcDominance = num(global.btcDominance), ethDominance = num(global.ethDominance);
      if (Number.isFinite(marketCap)) { $("ticker-mcap").textContent = `$${compact(marketCap)}`; $("global-mcap").textContent = fmtUsd(marketCap); }
      if (Number.isFinite(volume)) $("global-volume").textContent = fmtUsd(volume);
      if (Number.isFinite(btcDominance)) { $("global-btc-dom").textContent = signed(btcDominance, "%", 1).replace("+", ""); $("stat-dominance").textContent = `${btcDominance.toFixed(1)}%`; }
      if (Number.isFinite(ethDominance)) $("global-eth-dom").textContent = signed(ethDominance, "%", 1).replace("+", "");
      if (Number.isFinite(num(global.activeCryptocurrencies))) $("global-coins").textContent = new Intl.NumberFormat("en-US").format(num(global.activeCryptocurrencies));
      btcCandles = (Array.isArray(data.candles) ? data.candles : []).map(row => ({ date: String(row.date || "").slice(0, 10), open: num(row.open), high: num(row.high), low: num(row.low), close: num(row.close) })).filter(row => row.date && [row.open, row.high, row.low, row.close].every(Number.isFinite)).sort((a, b) => a.date.localeCompare(b.date));
      const marketSources = Array.isArray(payload.sources) ? payload.sources : [];
      const btcInputSources = marketSources.filter(source => source.selected === true && Array.isArray(source.fields) && source.fields.some(field => String(field).includes("BTC 价格") || String(field).includes("BTC 日 K")));
      const btcInputTimes = [currentBtcAsOf, currentBtcCandlesAsOf, ...btcInputSources.map(source => source.updatedAt)].map(value => Date.parse(value || "")).filter(Number.isFinite);
      marketInputMeta.price = {
        missing: !Number.isFinite(btcPrice) || btcCandles.length < 2,
        stale: btcInputSources.some(source => source.status === "stale"),
        fetchedAt: btcInputTimes.length ? new Date(Math.min(...btcInputTimes)).toISOString() : null,
        targetSeconds: 15 * 60
      };
      lastPriceSeries = btcCandles.slice(-30).map(row => row.close);
      if (lastPriceSeries.length) {
        $("price-period").textContent = `30D · GATE.IO${isSnapshotMode ? " SNAPSHOT" : ""}`; $("btc-low").textContent = fmtUsd(Math.min(...lastPriceSeries), 0); $("btc-high").textContent = fmtUsd(Math.max(...lastPriceSeries), 0);
        requestAnimationFrame(() => { drawEtfCombo(); drawEtfRolling(); drawLine($("price-chart"), lastPriceSeries); drawFearGreedKline(); if (defiTrendRows.length) drawDualLine($("defi-chart"), defiTrendRows, { leftFormat: value => `$${value.toFixed(0)}B`, rightFormat: value => `$${Math.round(value / 1000)}k` }); });
      }
      updateMarketInsight(); renderTodayMarketState();
    } catch {
      marketInputMeta.price = { ...marketInputMeta.price, missing: true };
      setState("price", "error", Date.now()); setState("market", "error", Date.now()); updateCompositeMarketTime(); renderTodayMarketState();
    }
  }

  async function loadSentimentService() {
    try {
      const result = await getJSON("serviceSentiment", endpoints.sentiment, 900000, 10000);
      const payload = result.value || {}, data = payload.data || {}, updatedAt = payload.updatedAt || Date.now();
      setState("sentiment", payloadState(payload, result.state), updatedAt); updateCompositeMarketTime();
      fearGreedRows = (Array.isArray(data.rows) ? data.rows : []).map(row => ({ date: String(row.date || "").slice(0, 10), value: num(row.value), rawLabel: row.label || "" })).filter(row => row.date && Number.isFinite(row.value)).sort((a, b) => a.date.localeCompare(b.date));
      const latest = data.current && Number.isFinite(num(data.current.value)) ? { date: String(data.current.date || "").slice(0, 10), value: num(data.current.value), rawLabel: data.current.label || "" } : fearGreedRows.at(-1);
      if (!latest) throw new Error("empty sentiment");
      const dayMs = 86400000, latestTime = Date.parse(`${latest.date}T00:00:00Z`), targetTime = latestTime - 7 * dayMs;
      const candidate = fearGreedRows.map(row => ({ row, timestamp: Date.parse(`${row.date}T00:00:00Z`) })).filter(item => Number.isFinite(item.timestamp)).reduce((best, item) => !best || Math.abs(item.timestamp - targetTime) < Math.abs(best.timestamp - targetTime) ? item : best, null);
      const prior = candidate && Math.abs(candidate.timestamp - targetTime) <= 1.5 * dayMs ? candidate.row : null;
      const weeklyChange = prior ? latest.value - prior.value : null;
      currentFearGreed = latest.value; currentFearGreedLabel = fearGreedLabel(latest.value, latest.rawLabel);
      currentFearGreed7dChange = weeklyChange;
      currentFearGreedWindowDays = prior ? (latestTime - candidate.timestamp) / dayMs : null;
      currentFearGreedAsOf = latest.date;
      const sentimentSource = (Array.isArray(payload.sources) ? payload.sources : []).find(source => source.selected === true) || null;
      marketInputMeta.sentiment = {
        missing: false,
        stale: sentimentSource?.status === "stale",
        fetchedAt: sentimentSource?.updatedAt || updatedAt,
        targetSeconds: 60 * 60
      };
      $("ticker-fng").textContent = `${latest.value} ${currentFearGreedLabel}`; $("stat-fng").textContent = latest.value; $("stat-fng-label").textContent = currentFearGreedLabel; $("gauge-value").textContent = latest.value;
      $("fng-7d").textContent = Number.isFinite(weeklyChange) ? `${weeklyChange > 0 ? "+" : ""}${weeklyChange.toFixed(0)} 点` : "—"; tone($("fng-7d"), weeklyChange);
      updateMarketInsight(); renderTodayMarketState(); requestAnimationFrame(() => { drawFearGreedGauge(latest.value); drawFearGreedKline(); });
    } catch { marketInputMeta.sentiment = { ...marketInputMeta.sentiment, missing: true }; setState("sentiment", "error", Date.now()); updateCompositeMarketTime(); renderTodayMarketState(); }
  }

  async function loadOnchainService() {
    try {
      const result = await getJSON("serviceOnchain", endpoints.onchain, 300000, 10000);
      const payload = result.value || {}, data = payload.data || {}, state = payloadState(payload, result.state);
      setState("onchain", state, payload.updatedAt || Date.now());
      const height = num(data.height), fast = num(data.feeFast), hour = num(data.feeHour), mempoolCount = num(data.mempoolCount), mempoolSize = num(data.mempoolSize), rawMempoolUnit = data.mempoolUnit || "";
      const mempoolUnit = rawMempoolUnit === "vB" ? "vMB" : rawMempoolUnit === "bytes" ? "MB" : rawMempoolUnit;
      const feeText = value => Number.isFinite(value) ? (value >= 10 ? String(Math.round(value)) : value.toFixed(1)) : "—";
      if (Number.isFinite(height)) $("chain-height").textContent = new Intl.NumberFormat("en-US").format(height);
      if (Number.isFinite(fast)) { $("fee-fast").textContent = feeText(fast); $("ticker-fee").textContent = `${feeText(fast)} sat/vB`; }
      if (Number.isFinite(hour)) $("fee-hour").textContent = feeText(hour);
      if (Number.isFinite(mempoolCount)) $("mempool-count").textContent = new Intl.NumberFormat("en-US").format(mempoolCount);
      if (Number.isFinite(mempoolSize)) $("mempool-vsize").textContent = `内存池体积 ${(mempoolSize / 1e6).toFixed(1)} ${mempoolUnit}`;
      const parts = [];
      if (Number.isFinite(fast)) parts.push(`下一块费率约 ${feeText(fast)} sat/vB`);
      if (Number.isFinite(mempoolCount)) parts.push(`待确认 ${new Intl.NumberFormat("zh-CN").format(mempoolCount)} 笔${Number.isFinite(mempoolSize) ? `、约 ${(mempoolSize / 1e6).toFixed(1)} ${mempoolUnit}` : ""}`);
      const reading = Number.isFinite(fast) && fast <= 5 ? "当前优先确认成本较低" : Number.isFinite(fast) && fast <= 20 ? "当前费用处于常见区间" : Number.isFinite(fast) ? "当前优先确认成本偏高" : "费率暂不可用";
      $("onchain-insight").querySelector("span").textContent = parts.length ? `${parts.join("；")}。${reading}。` : "统一链上数据服务当前没有可用读数。";
    } catch { setState("onchain", "error", Date.now()); $("onchain-insight").querySelector("span").textContent = "链上数据服务当前不可达，暂不判断拥堵程度。"; }
  }

  async function loadDefiService() {
    try {
      const result = await getJSON("serviceDefi", endpoints.defi, 900000, 10000);
      const payload = result.value || {}, data = payload.data || {};
      setState("defi", payloadState(payload, result.state), payload.updatedAt || Date.now());
      const totalTvl = num(data.totalTvl), top = data.topChain || {};
      if (Number.isFinite(totalTvl)) $("defi-tvl").textContent = `$${compact(totalTvl)}`;
      if (top.name) { $("top-chain").textContent = top.name; $("top-chain-tvl").textContent = `TVL ${fmtUsd(num(top.tvl))}`; }
      const series = (Array.isArray(data.stableSeries) ? data.stableSeries : []).map(row => {
        const numericDate = num(row.date), date = numericDate ? new Date(numericDate * (numericDate > 1e12 ? 1 : 1000)).toISOString().slice(0, 10) : String(row.date || "").slice(0, 10);
        return { date, supply: num(row.supply) };
      }).filter(row => row.date && Number.isFinite(row.supply)).sort((a, b) => a.date.localeCompare(b.date));
      const stableSource = (Array.isArray(payload.sources) ? payload.sources : []).find(source => source.role === "stablecoin supply history") || null;
      marketInputMeta.defi = {
        missing: series.length === 0,
        stale: stableSource?.status === "stale",
        fetchedAt: stableSource?.updatedAt || payload.updatedAt || null,
        targetSeconds: 2 * 60 * 60
      };
      const latest = series.at(-1), latestTime = latest ? Date.parse(`${latest.date}T00:00:00Z`) : NaN;
      const targetTime = Number.isFinite(latestTime) ? latestTime - 30 * 86400000 : NaN;
      const prior = Number.isFinite(targetTime) ? [...series].reverse().find(row => Date.parse(`${row.date}T00:00:00Z`) <= targetTime) : null;
      const priorTime = prior ? Date.parse(`${prior.date}T00:00:00Z`) : NaN;
      const windowDays = Number.isFinite(latestTime) && Number.isFinite(priorTime) ? Math.round((latestTime - priorTime) / 86400000) : null;
      const supply = latest?.supply, oldSupply = prior?.supply, change = oldSupply ? (supply / oldSupply - 1) * 100 : null;
      currentStableSupply = supply;
      currentStable30dChange = change;
      currentStableWindowDays = windowDays;
      currentStableAsOf = latest?.date || null;
      if (Number.isFinite(supply)) $("stable-supply").textContent = `$${compact(supply)}`;
      const liquidityReading = classifyStablecoinChange(change);
      const completeWindow = Number.isFinite(windowDays) && windowDays >= 28 && windowDays <= 35;
      $("stable-change").textContent = signed(change); tone($("stable-change"), completeWindow ? liquidityReading.direction : 0);
      $("defi-insight").querySelector("span").textContent = Number.isFinite(change) && completeWindow
        ? `过去 ${windowDays} 天${liquidityReading.text}`
        : series.length ? "稳定币历史窗口不在 28–35 天内，暂不推断月度流动性方向。" : "稳定币供给变化暂不可计算。";
      defiTrendRows = series.map(row => ({ label: row.date, left: row.supply / 1e9, right: null })).slice(-740);
      requestAnimationFrame(() => drawDualLine($("defi-chart"), defiTrendRows, { leftFormat: value => `$${value.toFixed(0)}B`, rightFormat: value => `$${Math.round(value / 1000)}k` }));
      renderTodayMarketState();
    } catch { marketInputMeta.defi = { ...marketInputMeta.defi, missing: true }; setState("defi", "error", Date.now()); $("defi-insight").querySelector("span").textContent = "DeFi 数据服务当前不可达，暂不判断链上流动性方向。"; renderTodayMarketState(); }
  }

  const RANGE_DAYS = { "7D": 7, "30D": 30, "90D": 90, "6M": 183, "1Y": 366, "2Y": 732 };

  function responsiveChartPad(canvas, desktop, mobile) {
    return canvas.getBoundingClientRect().width < 520 ? mobile : desktop;
  }

  function chartCanvasFont(width) {
    return `${width < 520 ? 10 : 12}px "Microsoft YaHei"`;
  }

  function dateValue(value) {
    const raw = String(value || "");
    const normalized = /^\d{4}-\d{2}$/.test(raw) ? `${raw}-01` : raw.slice(0, 10);
    const timestamp = Date.parse(`${normalized}T00:00:00Z`);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function filterChartRows(rows, range, getDate) {
    const valid = (Array.isArray(rows) ? rows : []).filter(row => Number.isFinite(dateValue(getDate(row))));
    if (range === "ALL" || !RANGE_DAYS[range] || valid.length < 2) return valid;
    const end = Math.max(...valid.map(row => dateValue(getDate(row))));
    const start = end - RANGE_DAYS[range] * 86400000;
    return valid.filter(row => dateValue(getDate(row)) >= start);
  }

  function chartTimeScale(rows, getDate, left, right) {
    const timestamps = rows.map(row => dateValue(getDate(row)));
    const minimum = Math.min(...timestamps), maximum = Math.max(...timestamps), span = maximum - minimum || 1;
    return {
      minimum,
      maximum,
      x: row => left + (dateValue(getDate(row)) - minimum) / span * (right - left)
    };
  }

  function rangeText(range) {
    return range === "ALL" ? "全部" : range;
  }

  function updateRangeAvailability(chart, rows, getDate) {
    const buttons = [...document.querySelectorAll(`[data-range-chart="${chart}"]`)];
    const timestamps = (Array.isArray(rows) ? rows : []).map(row => dateValue(getDate(row))).filter(Number.isFinite);
    const coverageDays = timestamps.length > 1 ? (Math.max(...timestamps) - Math.min(...timestamps)) / 86400000 : 0;
    buttons.forEach(button => {
      const range = button.dataset.range;
      const requiredDays = RANGE_DAYS[range] || 0;
      const enough = range === "ALL" || (filterChartRows(rows, range, getDate).length >= 2 && coverageDays >= requiredDays * .85);
      button.disabled = !enough;
      button.title = enough ? `查看 ${rangeText(range)} 数据` : "当前历史覆盖不足";
    });
  }

  function optionChartRows() {
    return (Array.isArray(staticData?.ibitOptions?.daily) ? staticData.ibitOptions.daily : []).map(row => {
      const call = num(row?.[1]), put = num(row?.[2]);
      return { date: String(row?.[0] || ""), call, put, ratio: call > 0 && Number.isFinite(put) ? put / call : num(row?.[3]), openInterest: num(row?.[4]) };
    }).filter(row => row.date && [row.call, row.put, row.ratio].every(Number.isFinite));
  }

  function drawOptionsChart() {
    const canvas = $("options-chart"); if (!canvas) return;
    ensureChartStage(canvas);
    const fullRows = optionChartRows();
    updateRangeAvailability("options", fullRows, row => row.date);
    const rows = filterChartRows(fullRows, chartState.options.range, row => row.date);
    if (rows.length < 2) return;
    const { ctx, width, height } = fitCanvas(canvas); ctx.clearRect(0, 0, width, height);
    const pad = responsiveChartPad(canvas, { l: 62, r: 58, t: 18, b: 36 }, { l: 46, r: 38, t: 16, b: 34 }), plotH = height - pad.t - pad.b, scale = chartTimeScale(rows, row => row.date, pad.l, width - pad.r);
    const maxVolume = Math.max(1, ...rows.flatMap(row => [row.call, row.put])), maxRatio = Math.max(1.5, ...rows.map(row => row.ratio)), volumeY = value => pad.t + (maxVolume - value) / maxVolume * plotH, ratioY = value => pad.t + (maxRatio - value) / maxRatio * plotH;
    ctx.font = chartCanvasFont(width); ctx.textBaseline = "middle";
    for (let index = 0; index <= 4; index++) { const lineY = pad.t + index / 4 * plotH; ctx.strokeStyle = "#202520"; ctx.beginPath(); ctx.moveTo(pad.l, lineY); ctx.lineTo(width - pad.r, lineY); ctx.stroke(); ctx.fillStyle = "#747b74"; ctx.textAlign = "right"; ctx.fillText(compact(maxVolume - index / 4 * maxVolume), pad.l - 8, lineY); ctx.textAlign = "left"; ctx.fillText((maxRatio - index / 4 * maxRatio).toFixed(1), width - pad.r + 8, lineY); }
    const barWidth = Math.max(2, Math.min(9, (width - pad.l - pad.r) / rows.length * .28));
    rows.forEach(row => { const x = scale.x(row); ctx.fillStyle = "rgba(107,212,155,.76)"; ctx.fillRect(x - barWidth - 1, volumeY(row.call), barWidth, height - pad.b - volumeY(row.call)); ctx.fillStyle = "rgba(117,168,214,.75)"; ctx.fillRect(x + 1, volumeY(row.put), barWidth, height - pad.b - volumeY(row.put)); });
    ctx.beginPath(); rows.forEach((row, index) => index ? ctx.lineTo(scale.x(row), ratioY(row.ratio)) : ctx.moveTo(scale.x(row), ratioY(row.ratio))); ctx.strokeStyle = "#e9ae3f"; ctx.lineWidth = 2.2; ctx.stroke();
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#747b74"; rows.forEach((row, index) => { if (index % Math.max(1, Math.ceil(rows.length / 6)) === 0 || index === rows.length - 1) ctx.fillText(row.date.slice(5), scale.x(row), height - pad.b + 10); });
    bindChartHover(canvas, {
      rows, value: row => dateValue(row.date), domain: [scale.minimum, scale.maximum], pad, title: row => row.date,
      lines: row => [
        { label: "Call 成交", value: compact(row.call) },
        { label: "Put 成交", value: compact(row.put) },
        { label: "Put / Call", value: row.ratio.toFixed(3) },
        { label: "未平仓", value: compact(row.openInterest) }
      ]
    });
  }

  function drawDualLine(canvas, inputRows, options) {
    if (!canvas) return;
    ensureChartStage(canvas);
    const fullRows = Array.isArray(inputRows) ? inputRows.filter(row => Number.isFinite(row.left) && dateValue(row.label) !== null) : [];
    if (canvas.id !== "defi-chart") return;
    updateRangeAvailability("defi", fullRows, row => row.label);
    const candleMap = new Map(btcCandles.map(row => [row.date, row.close]));
    const rows = filterChartRows(fullRows, chartState.defi.range, row => row.label).map(row => ({ ...row, right: candleMap.get(row.label) ?? null }));
    if (rows.length < 2) return;
    const { ctx, width, height } = fitCanvas(canvas); ctx.clearRect(0, 0, width, height);
    const showPrice = chartState.defi.overlay && rows.some(row => Number.isFinite(row.right));
    const pad = responsiveChartPad(canvas, { l: 60, r: showPrice ? 64 : 24, t: 18, b: 34 }, { l: 46, r: showPrice ? 42 : 18, t: 16, b: 32 }), plotH = height - pad.t - pad.b, scale = chartTimeScale(rows, row => row.label, pad.l, width - pad.r);
    const leftValues = rows.map(row => row.left), leftMinRaw = Math.min(...leftValues), leftMaxRaw = Math.max(...leftValues), leftExtra = (leftMaxRaw - leftMinRaw || Math.abs(leftMaxRaw) || 1) * .08, leftMin = leftMinRaw - leftExtra, leftMax = leftMaxRaw + leftExtra, leftY = value => pad.t + (leftMax - value) / (leftMax - leftMin || 1) * plotH;
    const rightValues = rows.map(row => row.right).filter(Number.isFinite), rightMinRaw = rightValues.length ? Math.min(...rightValues) : 0, rightMaxRaw = rightValues.length ? Math.max(...rightValues) : 1, rightExtra = (rightMaxRaw - rightMinRaw || Math.abs(rightMaxRaw) || 1) * .08, rightMin = rightMinRaw - rightExtra, rightMax = rightMaxRaw + rightExtra, rightY = value => pad.t + (rightMax - value) / (rightMax - rightMin || 1) * plotH;
    ctx.font = chartCanvasFont(width); ctx.textBaseline = "middle";
    for (let index = 0; index <= 4; index++) { const lineY = pad.t + index / 4 * plotH; ctx.strokeStyle = "#202520"; ctx.beginPath(); ctx.moveTo(pad.l, lineY); ctx.lineTo(width - pad.r, lineY); ctx.stroke(); ctx.fillStyle = "#747b74"; ctx.textAlign = "right"; ctx.fillText(options.leftFormat(leftMax - index / 4 * (leftMax - leftMin)), pad.l - 8, lineY); if (showPrice) { ctx.textAlign = "left"; ctx.fillText(options.rightFormat(rightMax - index / 4 * (rightMax - rightMin)), width - pad.r + 8, lineY); } }
    const drawSeries = (key, y, color) => { ctx.beginPath(); let started = false; rows.forEach(row => { if (!Number.isFinite(row[key])) { started = false; return; } if (started) ctx.lineTo(scale.x(row), y(row[key])); else { ctx.moveTo(scale.x(row), y(row[key])); started = true; } }); ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.stroke(); };
    drawSeries("left", leftY, "#6bd49b"); if (showPrice) drawSeries("right", rightY, "#e9ae3f");
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#747b74"; rows.forEach((row, index) => { if (index % Math.max(1, Math.ceil(rows.length / 6)) === 0 || index === rows.length - 1) ctx.fillText(row.label.slice(5).replace("-", "/"), scale.x(row), height - pad.b + 10); });
    bindChartHover(canvas, {
      rows, value: row => dateValue(row.label), domain: [scale.minimum, scale.maximum], pad, title: row => row.label,
      lines: row => [
        { label: "稳定币供给", value: `$${row.left.toFixed(2)}B` },
        showPrice ? { label: "BTC 收盘", value: fmtUsd(row.right, 0) } : null
      ]
    });
  }

  function formatAge(seconds) {
    if (!Number.isFinite(seconds)) return "时间未知";
    if (seconds < 60) return `${Math.max(0, Math.round(seconds))} 秒前`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
    return `${Math.round(seconds / 86400)} 天前`;
  }

  function staticSnapshotRows() {
    const sources = staticData?.sources || {};
    const automation = latestHealthPayload?.data?.automation || null;
    const now = Date.now();
    const makeRow = ({ id, label, asOf, providers, reviewDays, reviewBusinessDays = null }) => {
      const timestamp = dateValue(asOf), ageSeconds = Number.isFinite(timestamp) ? Math.max(0, Math.round((now - timestamp) / 1000)) : null;
      const missingDate = !Number.isFinite(timestamp);
      const businessAge = Number.isFinite(reviewBusinessDays) ? completedUtcWeekdaysSince(asOf, now) : null;
      const stale = !missingDate && (Number.isFinite(reviewBusinessDays) ? businessAge > reviewBusinessDays : ageSeconds > reviewDays * 86400);
      const targetSeconds = Number.isFinite(reviewBusinessDays) ? 6 * 86400 : reviewDays * 86400;
      const update = automation?.modules?.[id] || null;
      const updateFailed = update?.status === "failed";
      return {
        id, label, kind: "static", status: missingDate ? "unavailable" : updateFailed ? "review" : "static", dataAsOf: asOf || null,
        ageSeconds, targetSeconds, overdue: stale, fallbackActive: false,
        reasonCodes: [...(missingDate ? ["missing_date"] : []), ...(stale ? ["needs_review"] : []), ...(updateFailed ? ["last_update_failed"] : [])], missingFields: missingDate ? ["快照截止日"] : [],
        updateStatus: update?.status || null,
        lastAttemptAt: update?.lastAttemptAt || null,
        lastSuccessAt: update?.lastSuccessAt || null,
        updateErrorCode: update?.errorCode || null,
        scheduleEnabled: automation?.scheduleEnabled === true,
        scheduleTime: automation?.scheduleTime || null,
        sources: providers.filter(Boolean).map(source => ({ provider: source.provider, role: source.mode || "静态快照", status: "static", selected: true, fields: [label], url: source.url }))
      };
    };
    return [
      makeRow({ id: "etf", label: "ETF 机构资金", asOf: sources.etfFlows?.asOf, providers: [sources.etfFlows, sources.ethEtfFlows], reviewDays: 6, reviewBusinessDays: 2 }),
      makeRow({ id: "ibit", label: "IBIT 期权", asOf: sources.ibitOptions?.asOf || staticData?.ibitOptions?.asOf, providers: [sources.ibitOptions], reviewDays: 6, reviewBusinessDays: 2 }),
      makeRow({ id: "seasonality", label: "历史季节性", asOf: staticData?.seasonality?.asOf || staticData?.asOf, providers: [{ provider: "Gate.io", mode: "BTC/USDT 日 K 重建", url: sources.btcMonthly?.url }], reviewDays: 2 })
    ];
  }

  function effectiveHealth(module) {
    if (!module || module.status === "unavailable") return "unavailable";
    if (moduleIsOverdue(module)) return "stale";
    if (["partial", "review"].includes(module.status)) return "degraded";
    return "healthy";
  }

  function healthStatus(module) {
    const health = effectiveHealth(module);
    if (health === "stale") {
      const wholeSnapshotStale = isSnapshotMode && module.kind === "dynamic" && module?.overdue !== true && isSnapshotStale();
      return { key: "overdue", label: wholeSnapshotStale ? "STALE SNAPSHOT" : "SOURCE OVERDUE" };
    }
    if (health === "degraded") return { key: module.status === "review" ? "review" : "partial", label: module.status === "review" ? "需检查" : isSnapshotMode && module.kind === "dynamic" ? "PARTIAL SNAPSHOT" : "PARTIAL" };
    if (health === "healthy") return { key: "live", label: module.status === "static" ? "STATIC" : isSnapshotMode && module.kind === "dynamic" ? "SNAPSHOT" : "LIVE" };
    return { key: "error", label: "UNAVAILABLE" };
  }

  function sourceStatusLabel(status) {
    return ({ live: isSnapshotMode ? "构建时抓取" : "本次抓取", cached: "新鲜缓存（不计入异常）", stale: "过期缓存", unavailable: "不可用", static: "静态快照" })[status] || status || "未知";
  }

  function renderHealthRows(target, modules) {
    if (!target) return;
    if (!modules.length) { target.innerHTML = '<div class="empty">暂无可用健康记录</div>'; return; }
    target.innerHTML = modules.map(module => {
      const state = healthStatus(module), abnormal = state.key === "partial" || state.key === "error" || state.key === "overdue" || state.key === "review";
      const displayAge = currentModuleAge(module);
      const detail = [
        module.dataAsOf ? `数据截至 ${String(module.dataAsOf).replace("T", " ").slice(0, 16)}` : null,
        module.fetchedAt ? `抓取于 ${shortUpdatedAt(module.fetchedAt)}` : module.kind === "dynamic" ? "抓取时间未知" : null,
        module.fallbackActive ? "正在使用备用源" : null,
        module.kind === "static" && module.updateStatus === "failed" ? `最近自动更新失败${module.updateErrorCode ? `（${module.updateErrorCode}）` : ""}` : null,
        module.kind === "static" && ["success", "no_change"].includes(module.updateStatus) ? `本机更新已完成${module.lastAttemptAt ? ` · ${shortUpdatedAt(module.lastAttemptAt)}` : ""}` : null,
        module.kind === "static" && module.scheduleEnabled ? (isSnapshotMode ? `${module.scheduleTime || "每 2 小时"}由 GitHub Actions 自动刷新` : `每日 ${module.scheduleTime || "设定时间"} 自动更新`) : null
      ].filter(Boolean).join(" · ");
      const sources = (module.sources || []).map(source => `<div class="health-source"><b>${esc(source.provider || "未知来源")}${source.selected ? " · 使用中" : ""}</b><span>${esc(source.role || (source.fields || []).join("、") || "数据源")}</span><span>${esc(sourceStatusLabel(source.status))}${source.fetchedAt ? ` · ${esc(formatAge((Date.now() - Date.parse(source.fetchedAt)) / 1000))}` : ""}</span></div>`).join("");
      const missingConsequence = effectiveHealth(module) === "unavailable" ? "因此不可用" : effectiveHealth(module) === "stale" ? "且数据已过期" : "因此降级";
      const missing = module.missingFields?.length ? `<div class="health-source"><b>缺失字段</b><span>${esc(module.missingFields.join("、"))}</span><span>${missingConsequence}</span></div>` : "";
      return `<details class="health-row" ${abnormal ? "open" : ""}><summary><span class="health-row-title"><b>${esc(module.label)}</b><small>${esc(detail || "状态与来源可展开查看")}</small></span><span class="health-pill ${state.key}">${state.label}</span><span class="health-age">${module.kind === "static" ? `截止 ${esc(module.dataAsOf || "—")}` : `抓取 ${esc(formatAge(displayAge))}`}</span></summary><div class="health-sources">${missing}${sources || '<div class="health-source"><span>没有返回来源明细</span></div>'}</div></details>`;
    }).join("");
  }

  function updateStaticLabels() {
    const etfAsOf = staticData?.sources?.etfFlows?.asOf || "—";
    const optionAsOf = staticData?.sources?.ibitOptions?.asOf || staticData?.ibitOptions?.asOf || "—";
    const seasonAsOf = staticData?.seasonality?.asOf || staticData?.asOf || "—";
    if ($("etf-static-state")) $("etf-static-state").textContent = `STATIC · ${etfAsOf}`;
    const rollingNote = document.querySelector(".etf-rolling-panel .mini-note"); if (rollingNote) rollingNote.textContent = `绿线 5日 · 橙线 20日 · 截至 ${etfAsOf}`;
    if ($("options-static-state")) $("options-static-state").textContent = `IBIT 快照 · ${optionAsOf}`;
    document.querySelectorAll(".options-cards .metric-card small").forEach(node => { node.textContent = `${node.textContent.split(" · ")[0]} · ${optionAsOf}`; });
    const years = Object.keys(staticData?.seasonality?.years || {});
    if ($("seasonality-static-state")) $("seasonality-static-state").textContent = `${years[0] || "—"}–${years.at(-1) || "—"} · 截至 ${seasonAsOf}`;
  }

  function renderHealth(payload = latestHealthPayload) {
    const dynamic = Array.isArray(payload?.data?.modules) ? payload.data.modules : [];
    const statics = staticSnapshotRows();
    renderHealthRows($("health-modules"), dynamic);
    renderHealthRows($("health-static"), statics);
    const all = [...dynamic, ...statics];
    const expectedDynamic = new Set(["market", "sentiment", "onchain", "defi", "gamma"]);
    dynamic.forEach(module => expectedDynamic.delete(module.id));
    const missingDynamic = expectedDynamic.size;
    const buckets = { healthy: 0, degraded: 0, stale: 0, unavailable: missingDynamic };
    all.forEach(module => { buckets[effectiveHealth(module)] += 1; });
    const staleCache = dynamic.filter(module => module.sources?.some(source => source.selected === true && source.status === "stale")).length;
    const freshCache = dynamic.filter(module => module.sources?.some(source => source.selected === true && source.status === "cached") && !module.sources?.some(source => source.selected === true && source.status === "stale")).length;
    const cacheBacked = freshCache + staleCache;
    $("health-live-count").textContent = String(buckets.healthy);
    $("health-partial-count").textContent = String(buckets.degraded);
    $("health-stale-count").textContent = String(buckets.stale);
    $("health-error-count").textContent = String(buckets.unavailable);
    const fallbacks = dynamic.filter(module => module.fallbackActive).length;
    const totalModules = all.length + missingDynamic;
    const primary = `${totalModules} 个模块：${buckets.healthy} 个正常${buckets.degraded ? `，${buckets.degraded} 个部分可用` : ""}${buckets.stale ? `，${buckets.stale} 个数据过期` : ""}${buckets.unavailable ? `，${buckets.unavailable} 个不可用` : ""}。`;
    const deliveryParts = [freshCache ? `${freshCache} 个使用新鲜缓存` : null, staleCache ? `${staleCache} 个含过期缓存` : null].filter(Boolean);
    const delivery = cacheBacked ? `其中 ${deliveryParts.join("，")}；缓存是取数方式，不重复计入主状态。` : "本次实际供数未使用缓存降级。";
    const browserDelivery = payload?._browserCached ? "健康状态文件本身来自浏览器缓存。" : "";
    const fallbackText = fallbacks ? `另有 ${fallbacks} 个模块正在使用备用源或最后成功值。` : "";
    const insight = missingDynamic ? `动态健康记录缺少 ${missingDynamic} 个预期模块。${primary}${delivery}${browserDelivery}` : `${primary}${delivery}${browserDelivery}${fallbackText}`;
    $("health-insight").querySelector("span").textContent = insight;
    const checkedAt = payload?.data?.checkedAt || payload?.updatedAt;
    $("health-checked").textContent = checkedAt ? `${payload?._browserCached ? "浏览器缓存检查" : isSnapshotMode ? "快照生成于" : "检查于"} ${shortUpdatedAt(checkedAt)}` : "动态健康接口暂不可用";
  }

  async function loadHealth() {
    const button = $("health-refresh"); if (button) { button.disabled = true; button.textContent = isSnapshotMode ? "读取中…" : "检查中…"; }
    try {
      const result = await getJSON("serviceHealth", `${endpoints.health}?t=${Date.now()}`, 60000, 20000);
      const payload = result.value || {};
      latestHealthPayload = { ...payload, _browserCached: result.state === "cached", _browserCachedAt: result.cachedAt };
      setState("health", payloadState(payload, result.state), payload.data?.checkedAt || payload.updatedAt || Date.now());
      renderHealth(latestHealthPayload);
    } catch {
      latestHealthPayload = null;
      setState("health", "error", Date.now());
      renderHealth(null);
    } finally {
      if (button) { button.disabled = false; button.textContent = isSnapshotMode ? "重新读取快照" : "重新检查"; }
    }
  }

  function drawEtfCombo() {
    const canvas = $("etf-chart"); if (!canvas) return;
    ensureChartStage(canvas);
    const fullRows = etfComboData();
    updateRangeAvailability("etfCombo", fullRows, row => row.month);
    const rows = filterChartRows(fullRows, chartState.etfCombo.range, row => row.month);
    if (rows.length < 2) return;
    const { ctx, width, height } = fitCanvas(canvas); ctx.clearRect(0, 0, width, height);
    const showPrice = chartState.etfCombo.overlay && rows.some(row => Number.isFinite(row.price));
    const pad = responsiveChartPad(canvas, { l: 58, r: showPrice ? 62 : 24, t: 18, b: 34 }, { l: 46, r: showPrice ? 42 : 18, t: 16, b: 32 }), plotH = height - pad.t - pad.b, scale = chartTimeScale(rows, row => row.month, pad.l, width - pad.r);
    const flows = rows.map(row => row.flow), fMin = Math.min(0, ...flows), fMax = Math.max(0, ...flows), fSpan = fMax - fMin || 1, yf = value => pad.t + (fMax - value) / fSpan * plotH;
    const prices = rows.map(row => row.price).filter(Number.isFinite), pMinRaw = prices.length ? Math.min(...prices) : 0, pMaxRaw = prices.length ? Math.max(...prices) : 1, pExtra = (pMaxRaw - pMinRaw || Math.abs(pMaxRaw) || 1) * .1, pMin = pMinRaw - pExtra, pMax = pMaxRaw + pExtra, yp = value => pad.t + (pMax - value) / (pMax - pMin || 1) * plotH;
    ctx.font = chartCanvasFont(width); ctx.textBaseline = "middle";
    for (let index = 0; index <= 4; index++) {
      const lineY = pad.t + index / 4 * plotH, flowValue = fMax - index / 4 * fSpan;
      ctx.strokeStyle = "#202520"; ctx.beginPath(); ctx.moveTo(pad.l, lineY); ctx.lineTo(width - pad.r, lineY); ctx.stroke();
      ctx.fillStyle = "#747b74"; ctx.textAlign = "right"; ctx.fillText(flow(flowValue), pad.l - 8, lineY);
      if (showPrice) { const price = pMax - index / 4 * (pMax - pMin); ctx.textAlign = "left"; ctx.fillText(`$${Math.round(price / 1000)}k`, width - pad.r + 8, lineY); }
    }
    const zero = yf(0), barWidth = Math.max(4, Math.min(18, (width - pad.l - pad.r) / rows.length * .48));
    ctx.strokeStyle = "#596059"; ctx.beginPath(); ctx.moveTo(pad.l, zero); ctx.lineTo(width - pad.r, zero); ctx.stroke();
    rows.forEach(row => { const barY = yf(row.flow); ctx.fillStyle = row.flow >= 0 ? "rgba(107,212,155,.72)" : "rgba(233,121,111,.72)"; ctx.fillRect(scale.x(row) - barWidth / 2, Math.min(barY, zero), barWidth, Math.max(1, Math.abs(barY - zero))); });
    if (showPrice) {
      ctx.beginPath(); let started = false; rows.forEach(row => { if (!Number.isFinite(row.price)) { started = false; return; } if (started) ctx.lineTo(scale.x(row), yp(row.price)); else { ctx.moveTo(scale.x(row), yp(row.price)); started = true; } }); ctx.strokeStyle = "#e9ae3f"; ctx.lineWidth = 2.2; ctx.stroke();
    }
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#747b74"; rows.forEach((row, index) => { if (index % Math.max(1, Math.ceil(rows.length / 6)) === 0 || index === rows.length - 1) ctx.fillText(row.month.replace("-", "/"), scale.x(row), height - pad.b + 10); });
    const total = rows.reduce((sum, row) => sum + row.flow, 0), positive = rows.filter(row => row.flow > 0).length, maximum = Math.max(...rows.map(row => row.flow));
    $("etf-window").textContent = flow(total); $("etf-hit").textContent = `${(positive / rows.length * 100).toFixed(1)}%`; $("etf-max").textContent = flow(maximum); tone($("etf-window"), total);
    const recent = rows.slice(-3), recentFlow = recent.reduce((sum, row) => sum + row.flow, 0), priced = recent.filter(row => Number.isFinite(row.price)), priceChange = priced.length > 1 ? (priced.at(-1).price / priced[0].price - 1) * 100 : null;
    let conclusion = `所选 ${rangeText(chartState.etfCombo.range)} 内 ETF 合计${total >= 0 ? "净流入" : "净流出"} ${flow(Math.abs(total)).replace("+", "")}`;
    if (Number.isFinite(priceChange)) conclusion += `；最近 3 个月 BTC ${priceChange >= 0 ? "上涨" : "下跌"} ${Math.abs(priceChange).toFixed(1)}%`;
    $("etf-insight").querySelector("span").textContent = `${conclusion}。`;
    bindChartHover(canvas, {
      rows, value: row => dateValue(row.month), domain: [scale.minimum, scale.maximum], pad, title: row => row.month,
      lines: row => [{ label: "ETF 月度净流", value: flow(row.flow) }, showPrice ? { label: "BTC 月末/当前", value: fmtUsd(row.price, 0) } : null]
    });
  }

  function drawFearGreedKline() {
    const canvas = $("fng-kline-chart"); if (!canvas || btcCandles.length < 2) return;
    ensureChartStage(canvas);
    updateRangeAvailability("fng", btcCandles, row => row.date);
    const candles = filterChartRows(btcCandles, chartState.fng.range, row => row.date);
    if (candles.length < 2) return;
    const fngMap = new Map(fearGreedRows.map(row => [row.date, row.value]));
    const { ctx, width, height } = fitCanvas(canvas); ctx.clearRect(0, 0, width, height);
    const showFng = chartState.fng.overlay, pad = responsiveChartPad(canvas, { l: 68, r: showFng ? 58 : 24, t: 22, b: 38 }, { l: 50, r: showFng ? 36 : 18, t: 18, b: 34 }), plotH = height - pad.t - pad.b, scale = chartTimeScale(candles, row => row.date, pad.l, width - pad.r);
    const pMinRaw = Math.min(...candles.map(row => row.low)), pMaxRaw = Math.max(...candles.map(row => row.high)), extra = (pMaxRaw - pMinRaw || pMaxRaw * .08) * .08, pMin = pMinRaw - extra, pMax = pMaxRaw + extra, py = value => pad.t + (pMax - value) / (pMax - pMin || 1) * plotH, fy = value => pad.t + (100 - value) / 100 * plotH;
    if (showFng) { ctx.fillStyle = "rgba(107,212,155,.035)"; ctx.fillRect(pad.l, fy(100), width - pad.l - pad.r, fy(76) - fy(100)); ctx.fillStyle = "rgba(233,121,111,.04)"; ctx.fillRect(pad.l, fy(24), width - pad.l - pad.r, fy(0) - fy(24)); }
    ctx.font = chartCanvasFont(width); ctx.textBaseline = "middle";
    for (let index = 0; index <= 4; index++) { const lineY = pad.t + index / 4 * plotH, price = pMax - index / 4 * (pMax - pMin); ctx.strokeStyle = "#202520"; ctx.beginPath(); ctx.moveTo(pad.l, lineY); ctx.lineTo(width - pad.r, lineY); ctx.stroke(); ctx.fillStyle = "#747b74"; ctx.textAlign = "right"; ctx.fillText(`$${Math.round(price / 1000)}k`, pad.l - 9, lineY); if (showFng) { ctx.textAlign = "left"; ctx.fillText(String(100 - index * 25), width - pad.r + 9, lineY); } }
    const pixelsPerCandle = (width - pad.l - pad.r) / candles.length;
    if (pixelsPerCandle < 2.2) {
      ctx.beginPath();
      candles.forEach((candle, index) => index ? ctx.lineTo(scale.x(candle), py(candle.close)) : ctx.moveTo(scale.x(candle), py(candle.close)));
      ctx.strokeStyle = "#aeb3ad"; ctx.lineWidth = 1.4; ctx.stroke();
    } else {
      const bodyWidth = Math.max(1.5, Math.min(8, pixelsPerCandle * .55));
      candles.forEach(candle => { const color = candle.close >= candle.open ? "#6bd49b" : "#e9796f", x = scale.x(candle); ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(x, py(candle.high)); ctx.lineTo(x, py(candle.low)); ctx.stroke(); const top = py(Math.max(candle.open, candle.close)), bottom = py(Math.min(candle.open, candle.close)); ctx.fillStyle = color; ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, Math.max(1.4, bottom - top)); });
    }
    if (showFng) { ctx.beginPath(); let started = false; candles.forEach(candle => { const value = fngMap.get(candle.date); if (!Number.isFinite(value)) { started = false; return; } if (started) ctx.lineTo(scale.x(candle), fy(value)); else { ctx.moveTo(scale.x(candle), fy(value)); started = true; } }); ctx.strokeStyle = "#f1b84e"; ctx.lineWidth = 2.4; ctx.stroke(); }
    const fngTickTarget = width < 520 ? 5 : 7;
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#747b74"; candles.forEach((candle, index) => { if (index % Math.max(1, Math.ceil(candles.length / fngTickTarget)) === 0 || index === candles.length - 1) ctx.fillText(candle.date.slice(5), scale.x(candle), height - pad.b + 11); });
    bindChartHover(canvas, {
      rows: candles, value: row => dateValue(row.date), domain: [scale.minimum, scale.maximum], pad, title: row => row.date,
      lines: row => {
        const fear = fngMap.get(row.date);
        return [
          { label: "开 / 高", value: `${fmtUsd(row.open, 0)} / ${fmtUsd(row.high, 0)}` },
          { label: "低 / 收", value: `${fmtUsd(row.low, 0)} / ${fmtUsd(row.close, 0)}` },
          showFng && Number.isFinite(fear) ? { label: "恐贪", value: `${fear} · ${fearGreedLabel(fear)}` } : null
        ];
      }
    });
  }

  function ensureChartStage(canvas) {
    if (!canvas) return null;
    let stage = canvas.parentElement?.classList.contains("chart-stage") ? canvas.parentElement : null;
    if (!stage) {
      stage = document.createElement("div");
      stage.className = "chart-stage";
      canvas.parentNode.insertBefore(stage, canvas);
      stage.appendChild(canvas);
    }
    let crosshair = stage.querySelector(".chart-crosshair");
    if (!crosshair) {
      crosshair = document.createElement("i");
      crosshair.className = "chart-crosshair";
      crosshair.hidden = true;
      stage.appendChild(crosshair);
    }
    let tooltip = stage.querySelector(".chart-tooltip");
    if (!tooltip) {
      tooltip = document.createElement("output");
      tooltip.className = "chart-tooltip";
      tooltip.setAttribute("role", "status");
      tooltip.hidden = true;
      stage.appendChild(tooltip);
    }
    canvas.tabIndex = 0;
    return { stage, crosshair, tooltip };
  }

  function bindChartHover(canvas, config) {
    if (!canvas || !config?.rows?.length) return;
    const shell = ensureChartStage(canvas);
    shell.crosshair.hidden = true;
    shell.tooltip.hidden = true;
    chartBindings.set(canvas, { ...config, ...shell, activeIndex: config.rows.length - 1, pinned: false, touchStart: null, touchMoved: false });
    if (canvas.dataset.hoverBound === "true") return;
    canvas.dataset.hoverBound = "true";

    const showIndex = index => {
      const binding = chartBindings.get(canvas);
      if (!binding?.rows?.length) return;
      const safeIndex = Math.max(0, Math.min(binding.rows.length - 1, index));
      binding.activeIndex = safeIndex;
      const row = binding.rows[safeIndex];
      const value = binding.value(row);
      const ratio = (value - binding.domain[0]) / (binding.domain[1] - binding.domain[0] || 1);
      const canvasRect = canvas.getBoundingClientRect();
      const position = binding.pad.l + Math.max(0, Math.min(1, ratio)) * (canvasRect.width - binding.pad.l - binding.pad.r);
      const title = binding.title(row, safeIndex);
      const lines = binding.lines(row, safeIndex).filter(line => line && line.value !== undefined && line.value !== null);
      binding.tooltip.innerHTML = `<b>${esc(title)}</b>${lines.map(line => `<span><i>${esc(line.label)}</i><strong>${esc(line.value)}</strong></span>`).join("")}`;
      binding.crosshair.style.left = `${position}px`;
      binding.crosshair.style.top = `${binding.pad.t}px`;
      binding.crosshair.style.bottom = `${binding.pad.b}px`;
      binding.crosshair.hidden = false;
      binding.tooltip.hidden = false;
      const tooltipWidth = binding.tooltip.offsetWidth || 190;
      const preferredLeft = position + tooltipWidth + 18 < canvasRect.width ? position + 10 : position - tooltipWidth - 10;
      const left = Math.max(8, Math.min(preferredLeft, canvasRect.width - tooltipWidth - 8));
      binding.tooltip.style.left = `${left}px`;
    };

    const hideTooltip = binding => {
      if (!binding) return;
      binding.crosshair.hidden = true;
      binding.tooltip.hidden = true;
    };

    const indexFromPointer = event => {
      const binding = chartBindings.get(canvas);
      if (!binding?.rows?.length) return 0;
      const rect = canvas.getBoundingClientRect();
      const px = Math.max(binding.pad.l, Math.min(rect.width - binding.pad.r, event.clientX - rect.left));
      const target = binding.domain[0] + (px - binding.pad.l) / Math.max(1, rect.width - binding.pad.l - binding.pad.r) * (binding.domain[1] - binding.domain[0]);
      let nearest = 0, distance = Infinity;
      binding.rows.forEach((row, index) => {
        const candidate = Math.abs(binding.value(row) - target);
        if (candidate < distance) { distance = candidate; nearest = index; }
      });
      return nearest;
    };

    canvas.addEventListener("pointermove", event => {
      const binding = chartBindings.get(canvas);
      if (event.pointerType === "touch" && binding?.touchStart) {
        const dx = event.clientX - binding.touchStart.x, dy = event.clientY - binding.touchStart.y;
        if (Math.hypot(dx, dy) > 8) binding.touchMoved = true;
        if (Math.abs(dx) > Math.abs(dy)) showIndex(indexFromPointer(event));
        return;
      }
      showIndex(indexFromPointer(event));
    });
    canvas.addEventListener("pointerdown", event => {
      const binding = chartBindings.get(canvas); if (!binding) return;
      if (event.pointerType === "touch") {
        binding.touchStart = { x: event.clientX, y: event.clientY };
        binding.touchMoved = false;
        return;
      }
      showIndex(indexFromPointer(event));
    });
    canvas.addEventListener("pointerup", event => {
      const binding = chartBindings.get(canvas);
      if (event.pointerType !== "touch" || !binding?.touchStart) return;
      const dx = event.clientX - binding.touchStart.x, dy = event.clientY - binding.touchStart.y;
      const moved = binding.touchMoved || Math.hypot(dx, dy) > 8;
      binding.touchStart = null;
      binding.touchMoved = false;
      if (moved) {
        if (Math.abs(dx) > Math.abs(dy)) { binding.pinned = true; showIndex(indexFromPointer(event)); }
        else if (!binding.pinned) hideTooltip(binding);
        return;
      }
      if (binding.pinned) { binding.pinned = false; hideTooltip(binding); return; }
      binding.pinned = true;
      showIndex(indexFromPointer(event));
    });
    canvas.addEventListener("pointercancel", () => {
      const binding = chartBindings.get(canvas); if (!binding) return;
      binding.touchStart = null;
      binding.touchMoved = false;
      if (!binding.pinned) hideTooltip(binding);
    });
    canvas.addEventListener("pointerleave", () => {
      const binding = chartBindings.get(canvas);
      if (!binding || binding.pinned) return;
      hideTooltip(binding);
    });
    canvas.addEventListener("focus", () => showIndex(chartBindings.get(canvas)?.activeIndex ?? 0));
    canvas.addEventListener("blur", () => {
      const binding = chartBindings.get(canvas); if (!binding || binding.pinned) return;
      hideTooltip(binding);
    });
    canvas.addEventListener("keydown", event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Escape") return;
      const binding = chartBindings.get(canvas); if (!binding) return;
      if (event.key === "Escape") { binding.pinned = false; hideTooltip(binding); return; }
      event.preventDefault();
      showIndex(binding.activeIndex + (event.key === "ArrowRight" ? 1 : -1));
    });
  }

  function redrawChart(chart) {
    if (chart === "price") drawLine($("price-chart"), lastPriceSeries);
    if (chart === "etfRolling") drawEtfRolling();
    if (chart === "etfCombo") drawEtfCombo();
    if (chart === "fng") drawFearGreedKline();
    if (chart === "options") drawOptionsChart();
    if (chart === "defi") drawDualLine($("defi-chart"), defiTrendRows, { leftFormat: value => `$${value.toFixed(0)}B`, rightFormat: value => `$${Math.round(value / 1000)}k` });
  }

  function setupChartControls() {
    document.querySelectorAll("[data-range-chart]").forEach(button => button.addEventListener("click", () => {
      const chart = button.dataset.rangeChart, range = button.dataset.range;
      if (!chartState[chart] || button.disabled) return;
      chartState[chart].range = range;
      document.querySelectorAll(`[data-range-chart="${chart}"]`).forEach(item => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      redrawChart(chart);
    }));
    document.querySelectorAll("[data-overlay-chart]").forEach(input => input.addEventListener("change", () => {
      const chart = input.dataset.overlayChart;
      if (!chartState[chart]) return;
      chartState[chart].overlay = input.checked;
      redrawChart(chart);
    }));
  }

  function drawLine(canvas, values) {
    if (!canvas) return;
    ensureChartStage(canvas);
    const liveRows = btcCandles.map(row => ({ ...row, date: row.date, close: num(row.close) })).filter(row => Number.isFinite(row.close));
    const staticRows = (Array.isArray(staticData?.btcMonthly) ? staticData.btcMonthly : []).map(row => ({ date: row[0], close: num(row[1]), open: num(row[1]), high: num(row[1]), low: num(row[1]) })).filter(row => Number.isFinite(row.close));
    const fullRows = liveRows.length >= 2 ? liveRows : staticRows;
    updateRangeAvailability("price", fullRows, row => row.date);
    const rows = filterChartRows(fullRows, chartState.price.range, row => row.date);
    if (rows.length < 2) return;
    const { ctx, width, height } = fitCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const pad = { l: 7, r: 7, t: 8, b: 8 }, scale = chartTimeScale(rows, row => row.date, pad.l, width - pad.r);
    const prices = rows.map(row => row.close), minimum = Math.min(...prices), maximum = Math.max(...prices), span = maximum - minimum || 1;
    const y = value => pad.t + (maximum - value) / span * (height - pad.t - pad.b);
    const gradient = ctx.createLinearGradient(0, 0, 0, height); gradient.addColorStop(0, "rgba(233,174,63,.26)"); gradient.addColorStop(1, "rgba(233,174,63,0)");
    ctx.beginPath(); ctx.moveTo(scale.x(rows[0]), height - pad.b); rows.forEach(row => ctx.lineTo(scale.x(row), y(row.close))); ctx.lineTo(scale.x(rows.at(-1)), height - pad.b); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
    ctx.beginPath(); rows.forEach((row, index) => index ? ctx.lineTo(scale.x(row), y(row.close)) : ctx.moveTo(scale.x(row), y(row.close))); ctx.strokeStyle = "#e9ae3f"; ctx.lineWidth = 2; ctx.stroke();
    const first = rows[0].close, last = rows.at(-1).close, periodChange = first ? (last / first - 1) * 100 : null;
    $("price-period").textContent = `${chartState.price.range} · ${liveRows.length ? `GATE.IO${isSnapshotMode ? " SNAPSHOT" : ""}` : "STATIC"}`;
    $("btc-low").textContent = fmtUsd(minimum, 0); $("btc-high").textContent = fmtUsd(maximum, 0);
    bindChartHover(canvas, {
      rows,
      value: row => dateValue(row.date),
      domain: [scale.minimum, scale.maximum],
      pad,
      title: row => row.date,
      lines: row => [
        { label: "BTC 收盘", value: fmtUsd(row.close, 0) },
        { label: "所选区间", value: Number.isFinite(periodChange) ? signed(periodChange) : "—" }
      ]
    });
  }

  function drawEtfRolling() {
    const canvas = $("etf-rolling-chart"); if (!canvas) return;
    ensureChartStage(canvas);
    const candleMap = new Map(btcCandles.map(row => [row.date, row]));
    const fullRows = etfRollingRows.filter(row => Number.isFinite(row.roll5) || Number.isFinite(row.roll20)).map(row => ({ ...row, candle: candleMap.get(row.date) || null }));
    updateRangeAvailability("etfRolling", fullRows, row => row.date);
    const rows = filterChartRows(fullRows, chartState.etfRolling.range, row => row.date);
    const { ctx, width, height } = fitCanvas(canvas); ctx.clearRect(0, 0, width, height);
    if (rows.length < 2) {
      ctx.fillStyle = "#747b74"; ctx.font = '13px "Microsoft YaHei"'; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("ETF 历史覆盖不足，暂不能绘制所选范围", width / 2, height / 2); return;
    }
    const showBtc = chartState.etfRolling.overlay && rows.some(row => row.candle);
    const pad = responsiveChartPad(canvas, { l: 70, r: showBtc ? 62 : 24, t: 18, b: 36 }, { l: 52, r: showBtc ? 42 : 18, t: 16, b: 34 }), plotH = height - pad.t - pad.b, scale = chartTimeScale(rows, row => row.date, pad.l, width - pad.r);
    const values = rows.flatMap(row => [row.roll5, row.roll20]).filter(Number.isFinite), minimum = Math.min(0, ...values), maximum = Math.max(0, ...values), span = maximum - minimum || 1;
    const y = value => pad.t + (maximum - value) / span * plotH;
    const priceValues = rows.flatMap(row => row.candle ? [row.candle.high, row.candle.low] : []).filter(Number.isFinite);
    const priceMin = priceValues.length ? Math.min(...priceValues) : 0, priceMax = priceValues.length ? Math.max(...priceValues) : 1, py = value => pad.t + (priceMax - value) / (priceMax - priceMin || 1) * plotH;
    ctx.font = chartCanvasFont(width); ctx.textBaseline = "middle";
    for (let index = 0; index <= 4; index++) {
      const lineY = pad.t + index / 4 * plotH, value = maximum - index / 4 * span;
      ctx.strokeStyle = "#202520"; ctx.beginPath(); ctx.moveTo(pad.l, lineY); ctx.lineTo(width - pad.r, lineY); ctx.stroke();
      ctx.fillStyle = "#747b74"; ctx.textAlign = "right"; ctx.fillText(flow(value), pad.l - 9, lineY);
      if (showBtc) { const price = priceMax - index / 4 * (priceMax - priceMin); ctx.textAlign = "left"; ctx.fillText(`$${Math.round(price / 1000)}k`, width - pad.r + 8, lineY); }
    }
    const zero = y(0); ctx.strokeStyle = "#596059"; ctx.beginPath(); ctx.moveTo(pad.l, zero); ctx.lineTo(width - pad.r, zero); ctx.stroke();
    if (showBtc) {
      const pixelsPerCandle = (width - pad.l - pad.r) / rows.length;
      if (pixelsPerCandle < 2.2) {
        ctx.beginPath(); let started = false;
        rows.forEach(row => {
          if (!row.candle) { started = false; return; }
          if (started) ctx.lineTo(scale.x(row), py(row.candle.close)); else { ctx.moveTo(scale.x(row), py(row.candle.close)); started = true; }
        });
        ctx.strokeStyle = "rgba(216,217,210,.55)"; ctx.lineWidth = 1.3; ctx.stroke();
      } else {
        const bodyWidth = Math.max(2, Math.min(7, pixelsPerCandle * .45));
        rows.forEach(row => {
          if (!row.candle) return;
          const color = row.candle.close >= row.candle.open ? "rgba(107,212,155,.38)" : "rgba(233,121,111,.38)", x = scale.x(row);
          ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(x, py(row.candle.high)); ctx.lineTo(x, py(row.candle.low)); ctx.stroke();
          ctx.fillStyle = color; const top = py(Math.max(row.candle.open, row.candle.close)), bottom = py(Math.min(row.candle.open, row.candle.close)); ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, Math.max(1, bottom - top));
        });
      }
    }
    const drawSeries = (key, color) => { ctx.beginPath(); let started = false; rows.forEach(row => { if (!Number.isFinite(row[key])) { started = false; return; } if (started) ctx.lineTo(scale.x(row), y(row[key])); else { ctx.moveTo(scale.x(row), y(row[key])); started = true; } }); ctx.strokeStyle = color; ctx.lineWidth = 2.4; ctx.stroke(); };
    drawSeries("roll5", "#6bd49b"); drawSeries("roll20", "#e9ae3f");
    ctx.fillStyle = "#747b74"; ctx.textAlign = "center"; ctx.textBaseline = "top"; rows.forEach((row, index) => { if (index % Math.max(1, Math.ceil(rows.length / 6)) === 0 || index === rows.length - 1) ctx.fillText(row.date.slice(5), scale.x(row), height - pad.b + 10); });
    bindChartHover(canvas, {
      rows, value: row => dateValue(row.date), domain: [scale.minimum, scale.maximum], pad, title: row => row.date,
      lines: row => [
        { label: "单日 ETF", value: flow(row.daily) },
        { label: "5 日净流", value: flow(row.roll5) },
        { label: "20 日净流", value: flow(row.roll20) },
        showBtc && row.candle ? { label: "BTC 收盘", value: fmtUsd(row.candle.close, 0) } : null
      ]
    });
  }

  function setupNavigation() {
    const links = [...document.querySelectorAll(".rail nav a")]; const sections = links.map(a => document.querySelector(a.getAttribute("href"))).filter(Boolean);
    const menu = $("mobile-menu"), scrim = $("nav-scrim"), rail = $("site-navigation");
    const desktopQuery = window.matchMedia("(min-width: 921px)");
    const setOpen = (open, returnFocus = false) => {
      document.body.classList.toggle("nav-open", open);
      menu.setAttribute("aria-expanded", String(open));
      menu.setAttribute("aria-label", open ? "关闭导航" : "打开导航");
      menu.textContent = open ? "×" : "☰";
      if (scrim) scrim.tabIndex = open ? 0 : -1;
      if (open) {
        if (rail) { rail.inert = false; rail.removeAttribute("aria-hidden"); }
        requestAnimationFrame(() => links[0]?.focus({ preventScroll: true }));
      } else {
        if (returnFocus) menu.focus({ preventScroll: true });
        if (rail && !desktopQuery.matches) { rail.inert = true; rail.setAttribute("aria-hidden", "true"); }
        else if (rail) { rail.inert = false; rail.removeAttribute("aria-hidden"); }
      }
    };
    const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (!entry.isIntersecting) return; links.forEach(a => a.classList.toggle("active", a.getAttribute("href") === `#${entry.target.id}`)); }), { rootMargin: "-25% 0px -65%" });
    sections.forEach(section => observer.observe(section));
    links.forEach(a => a.addEventListener("click", () => {
      if (!desktopQuery.matches) {
        const target = document.querySelector(a.getAttribute("href"));
        const heading = target?.querySelector("h1, h2");
        if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
      }
      setOpen(false);
    }));
    menu.addEventListener("click", () => setOpen(!document.body.classList.contains("nav-open")));
    if (scrim) scrim.addEventListener("click", () => setOpen(false, true));
    document.addEventListener("keydown", event => { if (event.key === "Escape" && document.body.classList.contains("nav-open")) setOpen(false, true); });
    desktopQuery.addEventListener?.("change", event => { if (event.matches) setOpen(false); });
    setOpen(false);
  }

  function redrawMobileTabPanel(panel) {
    if (!panel) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (panel.querySelector("#etf-rolling-chart")) drawEtfRolling();
      if (panel.querySelector("#etf-chart")) drawEtfCombo();
      if (panel.querySelector("#fng-gauge") && Number.isFinite(currentFearGreed)) drawFearGreedGauge(currentFearGreed);
      if (panel.querySelector("#fng-kline-chart")) drawFearGreedKline();
      if (panel.querySelector("#options-chart")) drawOptionsChart();
      if (panel.querySelector("#gamma-chart")) drawGammaChart();
    }));
  }

  function setupMobileTabs() {
    if (!window.matchMedia) return;
    const mobileQuery = window.matchMedia("(max-width: 620px)");
    document.querySelectorAll(".mobile-tabs[data-mobile-tabs]").forEach((tablist, groupIndex) => {
      const group = tablist.dataset.mobileTabs;
      const buttons = [...tablist.querySelectorAll("[data-mobile-tab-value]")];
      const panels = [...document.querySelectorAll(`[data-mobile-tab-panel="${group}"]`)];
      let activeValue = buttons.find(button => button.getAttribute("aria-selected") === "true")?.dataset.mobileTabValue || buttons[0]?.dataset.mobileTabValue;
      if (!buttons.length || !panels.length || !activeValue) return;

      const revealButton = button => {
        const listRect = tablist.getBoundingClientRect(), buttonRect = button.getBoundingClientRect();
        const leftDelta = buttonRect.left - listRect.left - 6, rightDelta = buttonRect.right - listRect.right + 6;
        const delta = leftDelta < 0 ? leftDelta : rightDelta > 0 ? rightDelta : 0;
        if (!delta) return;
        const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
        if (typeof tablist.scrollBy === "function") tablist.scrollBy({ left: delta, behavior });
        else tablist.scrollLeft += delta;
      };

      const activate = (value, moveFocus = false, reveal = false) => {
        if (!buttons.some(button => button.dataset.mobileTabValue === value)) return;
        activeValue = value;
        buttons.forEach((button, index) => {
          const active = button.dataset.mobileTabValue === value;
          button.classList.toggle("active", active);
          button.setAttribute("aria-selected", String(active));
          button.tabIndex = active ? 0 : -1;
          if (active) {
            if (reveal) revealButton(button);
            if (moveFocus) button.focus({ preventScroll: true });
          }
          button.id ||= `mobile-tab-${groupIndex}-${index}`;
        });
        panels.forEach((panel, index) => {
          const active = panel.dataset.mobileTabValue === value;
          panel.id ||= `mobile-panel-${groupIndex}-${index}`;
          panel.classList.toggle("is-mobile-tab-active", active);
          panel.classList.toggle("is-mobile-tab-inactive", !active);
          panel.setAttribute("aria-hidden", String(!active));
          if (active) redrawMobileTabPanel(panel);
        });
      };

      const syncMode = () => {
        if (!mobileQuery.matches) {
          tablist.removeAttribute("role");
          buttons.forEach(button => {
            button.removeAttribute("role");
            button.removeAttribute("aria-controls");
            button.removeAttribute("tabindex");
            button.classList.remove("active");
          });
          panels.forEach(panel => {
            panel.classList.remove("is-mobile-tab-active", "is-mobile-tab-inactive");
            panel.removeAttribute("role");
            panel.removeAttribute("aria-hidden");
            panel.removeAttribute("aria-labelledby");
          });
          return;
        }
        tablist.setAttribute("role", "tablist");
        buttons.forEach((button, index) => {
          const panel = panels.find(item => item.dataset.mobileTabValue === button.dataset.mobileTabValue);
          button.setAttribute("role", "tab");
          button.id ||= `mobile-tab-${groupIndex}-${index}`;
          if (panel) {
            panel.id ||= `mobile-panel-${groupIndex}-${panels.indexOf(panel)}`;
            button.setAttribute("aria-controls", panel.id);
            panel.setAttribute("role", "tabpanel");
            panel.setAttribute("aria-labelledby", button.id);
          }
        });
        activate(activeValue);
      };

      buttons.forEach(button => button.addEventListener("click", () => {
        if (mobileQuery.matches) activate(button.dataset.mobileTabValue, false, true);
      }));
      tablist.addEventListener("keydown", event => {
        if (!mobileQuery.matches || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const currentIndex = Math.max(0, buttons.findIndex(button => button.dataset.mobileTabValue === activeValue));
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
        activate(buttons[nextIndex].dataset.mobileTabValue, true, true);
      });

      panels.forEach(panel => {
        const swipeSurface = group === "daily-brief" ? panel : panel.querySelector(":scope > .panel-title");
        if (!swipeSurface) return;
        let touchStart = null;
        swipeSurface.addEventListener("touchstart", event => {
          if (!mobileQuery.matches || event.touches.length !== 1) return;
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest("canvas, button, input, label, a, .chart-stage, .heatmap-wrap, .range-tabs, .chart-toolbar, .mobile-snap-region")) return;
          const touch = event.touches[0];
          if (touch.clientX <= 24 || touch.clientX >= window.innerWidth - 24) return;
          touchStart = { x: touch.clientX, y: touch.clientY, at: Date.now() };
        }, { passive: true });
        swipeSurface.addEventListener("touchend", event => {
          if (!mobileQuery.matches || !touchStart || !event.changedTouches.length) { touchStart = null; return; }
          const touch = event.changedTouches[0], dx = touch.clientX - touchStart.x, dy = touch.clientY - touchStart.y;
          const duration = Date.now() - touchStart.at;
          touchStart = null;
          if (duration > 700 || Math.abs(dx) < 52 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
          const currentIndex = Math.max(0, buttons.findIndex(button => button.dataset.mobileTabValue === activeValue));
          const nextIndex = Math.max(0, Math.min(buttons.length - 1, currentIndex + (dx < 0 ? 1 : -1)));
          if (nextIndex !== currentIndex) activate(buttons[nextIndex].dataset.mobileTabValue, false, true);
        }, { passive: true });
        swipeSurface.addEventListener("touchcancel", () => { touchStart = null; }, { passive: true });
      });

      syncMode();
      if (typeof mobileQuery.addEventListener === "function") mobileQuery.addEventListener("change", syncMode);
      else mobileQuery.addListener?.(syncMode);
    });
  }

  function setupMobileDefinitions() {
    if (!window.matchMedia) return;
    const mobileQuery = window.matchMedia("(max-width: 620px)");
    document.querySelectorAll(".definition").forEach((definition, index) => {
      if (definition.previousElementSibling?.classList.contains("definition-toggle")) return;
      const sourceText = definition.querySelector("a")?.textContent?.replace(/^(来源|主源|备用)：?\s*/, "").replace(/\s*↗\s*$/, "").trim() || "查看说明";
      const shortSource = sourceText.length > 26 ? `${sourceText.slice(0, 25)}…` : sourceText;
      const button = document.createElement("button");
      const definitionId = definition.id || `mobile-definition-${index}`;
      definition.id = definitionId;
      button.type = "button";
      button.className = "definition-toggle";
      button.setAttribute("aria-controls", definitionId);
      button.setAttribute("aria-expanded", "false");
      button.innerHTML = `<span>口径与来源</span><small>${esc(shortSource)}</small><i aria-hidden="true">＋</i>`;
      definition.classList.add("mobile-collapsible");
      definition.before(button);
      button.addEventListener("click", () => {
        const expanded = !definition.classList.contains("is-expanded");
        definition.classList.toggle("is-expanded", expanded);
        button.classList.toggle("is-expanded", expanded);
        button.setAttribute("aria-expanded", String(expanded));
        button.querySelector("i").textContent = expanded ? "−" : "＋";
        if (mobileQuery.matches) definition.setAttribute("aria-hidden", String(!expanded));
      });
      const syncMode = () => {
        if (mobileQuery.matches) definition.setAttribute("aria-hidden", String(!definition.classList.contains("is-expanded")));
        else definition.removeAttribute("aria-hidden");
      };
      syncMode();
      if (typeof mobileQuery.addEventListener === "function") mobileQuery.addEventListener("change", syncMode);
      else mobileQuery.addListener?.(syncMode);
    });
  }

  function setupMobileCarousels() {
    if (!window.matchMedia) return;
    const mobileQuery = window.matchMedia("(max-width: 620px)");
    const regions = document.querySelectorAll(".mobile-snap-cards, .market-state-grid, .etf-rolling-metrics, .chart-summary, .gamma-summary");
    regions.forEach(region => {
      region.classList.add("mobile-snap-region");
      const cards = [...region.children];
      const page = region.dataset.mobilePager ? $(region.dataset.mobilePager) : null;
      const pagination = page?.closest(".market-state-pagination") || null;
      const dots = pagination ? [...pagination.querySelectorAll("[data-market-state-index]")] : [];
      let currentIndex = 0, scrollFrame = 0;

      const cardName = card => card.querySelector("h3")?.textContent?.trim()
        || card.querySelector(":scope > span")?.textContent?.trim()
        || `指标 ${cards.indexOf(card) + 1}`;
      const nearestCardIndex = () => {
        const regionLeft = region.getBoundingClientRect().left;
        return cards.reduce((nearest, card, index) => {
          const distance = Math.abs(card.getBoundingClientRect().left - regionLeft);
          return distance < nearest.distance ? { index, distance } : nearest;
        }, { index: 0, distance: Number.POSITIVE_INFINITY }).index;
      };
      const updatePager = (index = nearestCardIndex()) => {
        if (!mobileQuery.matches || !page || !cards.length) return;
        currentIndex = Math.max(0, Math.min(cards.length - 1, index));
        const name = cardName(cards[currentIndex]);
        const nextText = `${currentIndex + 1} / ${cards.length} · ${name}`;
        if (page.textContent !== nextText) page.textContent = nextText;
        dots.forEach((dot, dotIndex) => {
          const active = dotIndex === currentIndex;
          dot.classList.toggle("active", active);
          if (active) dot.setAttribute("aria-current", "true");
          else dot.removeAttribute("aria-current");
        });
      };
      const schedulePager = () => {
        if (!page || scrollFrame) return;
        scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; updatePager(); });
      };
      const scrollToCard = index => {
        if (!mobileQuery.matches || !cards[index]) return;
        const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
        const delta = cards[index].getBoundingClientRect().left - region.getBoundingClientRect().left;
        if (typeof region.scrollBy === "function") region.scrollBy({ left: delta, behavior });
        else region.scrollLeft += delta;
        updatePager(index);
      };

      const syncMode = () => {
        if (mobileQuery.matches) {
          region.tabIndex = 0;
          region.setAttribute("role", "region");
          if (!region.hasAttribute("aria-label")) {
            region.setAttribute("aria-label", region.dataset.mobileSnapLabel || "可左右滑动的指标卡");
            region.dataset.mobileSnapAriaInjected = "true";
          }
          if (page) {
            cards.forEach((card, index) => {
              card.setAttribute("role", "group");
              card.setAttribute("aria-roledescription", "卡片");
              card.setAttribute("aria-label", `第 ${index + 1} 项，共 ${cards.length} 项：${cardName(card)}`);
            });
            requestAnimationFrame(() => updatePager());
          }
        } else {
          region.removeAttribute("tabindex");
          region.removeAttribute("role");
          if (region.dataset.mobileSnapAriaInjected === "true") {
            region.removeAttribute("aria-label");
            delete region.dataset.mobileSnapAriaInjected;
          }
          if (page) cards.forEach(card => {
            card.removeAttribute("role");
            card.removeAttribute("aria-roledescription");
            card.removeAttribute("aria-label");
          });
        }
      };
      if (page) {
        region.addEventListener("scroll", schedulePager, { passive: true });
        region.addEventListener("keydown", event => {
          if (!mobileQuery.matches || event.target !== region || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? cards.length - 1
            : Math.max(0, Math.min(cards.length - 1, currentIndex + (event.key === "ArrowRight" ? 1 : -1)));
          scrollToCard(nextIndex);
        });
        dots.forEach(dot => dot.addEventListener("click", () => scrollToCard(Number(dot.dataset.marketStateIndex))));
        window.addEventListener("resize", schedulePager, { passive: true });
      }
      syncMode();
      if (typeof mobileQuery.addEventListener === "function") mobileQuery.addEventListener("change", syncMode);
      else mobileQuery.addListener?.(syncMode);
    });
  }

  function setupMobileSections() {
    if (!window.matchMedia) return;
    const mobileQuery = window.matchMedia("(max-width: 620px)");
    document.querySelectorAll("[data-mobile-section-toggle]").forEach(button => {
      const key = button.dataset.mobileSectionToggle;
      const body = document.querySelector(`[data-mobile-section-body="${key}"]`);
      if (!body) return;
      let expanded = button.getAttribute("aria-expanded") === "true";
      const render = () => {
        button.setAttribute("aria-expanded", String(expanded));
        button.classList.toggle("is-expanded", expanded);
        body.classList.toggle("is-expanded", expanded);
        button.textContent = expanded ? button.dataset.labelOpen : button.dataset.labelClosed;
        if (mobileQuery.matches) body.setAttribute("aria-hidden", String(!expanded));
        else body.removeAttribute("aria-hidden");
        if (mobileQuery.matches && expanded && body.querySelector("#price-chart") && lastPriceSeries.length) {
          requestAnimationFrame(() => requestAnimationFrame(() => drawLine($("price-chart"), lastPriceSeries)));
        }
      };
      button.addEventListener("click", () => {
        expanded = !expanded;
        if (!expanded && body.contains(document.activeElement)) button.focus({ preventScroll: true });
        render();
      });
      render();
      if (typeof mobileQuery.addEventListener === "function") mobileQuery.addEventListener("change", render);
      else mobileQuery.addListener?.(render);
    });
  }

  function setupMobileChartDefaults() {
    if (!window.matchMedia || !window.matchMedia("(max-width: 620px)").matches) return;
    const defaults = { fng: "30D", defi: "6M" };
    Object.entries(defaults).forEach(([chart, range]) => {
      chartState[chart].range = range;
      document.querySelectorAll(`[data-range-chart="${chart}"]`).forEach(button => {
        const active = button.dataset.range === range;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
    });
  }
  function refreshMarketSectionState() {
    const states = [sourceStates.price, sourceStates.sentiment].filter(Boolean);
    if (!states.length) return;
    const available = states.filter(state => state !== "error");
    const composite = !available.length ? "error"
      : states.includes("error") || states.includes("partial") ? "partial"
      : states.includes("cached") ? "cached"
      : "live";
    sourceStates.market = composite;
    document.querySelectorAll('[data-source-state="market"]').forEach(el => {
      el.textContent = sourceStateLabel(composite);
      el.classList.remove("live", "partial", "cached", "error");
      el.classList.add(isSnapshotStale() && (composite === "live" || composite === "partial") ? "partial" : composite === "live" ? "live" : composite === "partial" ? "partial" : composite === "cached" ? "cached" : "error");
    });
  }
  function finishStatus() {
    const states = ["market", "onchain", "defi", "gamma"].map(group => sourceStates[group] || "error");
    const live = states.filter(state => state === "live").length;
    const partial = states.filter(state => state === "partial").length;
    const cached = states.filter(state => state === "cached").length;
    const failed = states.filter(state => state === "error").length;
    const parts = [];
    if (isSnapshotStale()) parts.push(`快照已超过 ${Math.round(snapshotStaleAfterSeconds / 3600)} 小时`);
    if (live) parts.push(`${live} 组${isSnapshotMode ? "快照" : "实时"}`);
    if (partial) parts.push(`${partial} 组${isSnapshotMode ? "部分快照" : "部分可用"}`);
    if (cached) parts.push(`${cached} 组缓存`);
    if (failed) parts.push(`${failed} 组不可用`);
    $("rail-status").textContent = parts.join(" · ") || "公开数据等待连接";
    const displayTime = isSnapshotMode && deployment.generatedAt ? new Date(deployment.generatedAt) : new Date();
    $("update-time").textContent = `${isSnapshotMode ? "快照" : "更新"} ${displayTime.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
    document.querySelector(".rail-foot .pulse-dot").classList.toggle("warn", failed > 0 || partial > 0 || isSnapshotStale());
  }

  async function init() {
    applyDeploymentLabels(); setupNavigation(); setupMobileDefinitions(); setupMobileTabs(); setupMobileCarousels(); setupMobileSections(); setupMobileChartDefaults(); setupChartControls(); updateStaticLabels(); renderStatic(); renderOptions(); renderSeasonality();
    if ($("health-refresh")) $("health-refresh").addEventListener("click", loadHealth);
    await Promise.allSettled([loadMarketService(), loadSentimentService(), loadOnchainService(), loadDefiService(), loadGamma(), loadHealth()]);
    refreshMarketSectionState();
    finishStatus();
  }
  let resizeTimer, viewportWidth = document.documentElement.clientWidth;
  let backgroundRefreshInFlight = false, lastBackgroundRefreshAt = Date.now();
  async function refreshLiveDataInBackground() {
    if (isSnapshotMode || backgroundRefreshInFlight) return;
    backgroundRefreshInFlight = true;
    lastBackgroundRefreshAt = Date.now();
    try {
      await Promise.allSettled([loadMarketService(), loadSentimentService(), loadOnchainService(), loadDefiService(), loadGamma(), loadHealth()]);
      refreshMarketSectionState();
      finishStatus();
      const failed = ["market", "sentiment", "onchain", "defi", "gamma", "health"].some(group => sourceStates[group] === "error");
      if (failed) lastBackgroundRefreshAt = Date.now() - 10 * 60 * 1000;
    } finally {
      backgroundRefreshInFlight = false;
      renderTodayMarketState();
      if (latestHealthPayload) renderHealth(latestHealthPayload);
    }
  }
  setInterval(() => {
    if (!isSnapshotMode && Date.now() - lastBackgroundRefreshAt >= 15 * 60 * 1000) void refreshLiveDataInBackground();
    else {
      renderTodayMarketState();
      if (latestHealthPayload) renderHealth(latestHealthPayload);
    }
  }, 60_000);
  window.addEventListener("resize", () => {
    const nextWidth = document.documentElement.clientWidth;
    if (nextWidth === viewportWidth) return;
    viewportWidth = nextWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { drawEtfCombo(); drawEtfRolling(); if (lastPriceSeries.length) drawLine($("price-chart"), lastPriceSeries); if (Number.isFinite(currentFearGreed)) drawFearGreedGauge(currentFearGreed); drawFearGreedKline(); drawOptionsChart(); drawGammaChart(); if (defiTrendRows.length) drawDualLine($("defi-chart"), defiTrendRows, { leftFormat: v => `$${v.toFixed(0)}B`, rightFormat: v => `$${Math.round(v / 1000)}k` }); }, 160);
  });
  init();
})();
