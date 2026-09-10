/* Pure, shared calculations. No network and no fabricated fallback values. */
((root) => {
  const DAY = 86400000;
  const valid = v => typeof v === "number" && Number.isFinite(v);
  function continuous(rows) {
    return rows.every((r, i) => valid(r.close) && r.close > 0 && Number.isFinite(Date.parse(r.date)) && (!i || Date.parse(r.date) - Date.parse(rows[i - 1].date) === DAY));
  }
  function sma(rows, length) {
    return rows.map((_, i) => {
      if (i + 1 < length) return null;
      const sample = rows.slice(i + 1 - length, i + 1);
      return continuous(sample) ? sample.reduce((s, r) => s + r.close, 0) / length : null;
    });
  }
  function trend(rows, ready = true) {
    const ma20 = sma(rows, 20), ma60 = sma(rows, 60), a = ma20.at(-1), b = ma60.at(-1), close = rows.at(-1)?.close;
    if (!ready || ![a, b, close].every(valid)) return { label: "等待有效趋势数据", tone: "neutral", ready: false, ma20, ma60 };
    const rising = close > a && a > b, falling = close < a && a < b;
    return { label: rising ? "价格站在均线上方" : falling ? "价格在均线下方承压" : "短中期方向尚未一致", tone: rising ? "positive" : falling ? "negative" : "mixed", ready: true, ma20, ma60, close, a, b };
  }
  function realizedVol(rows, days) {
    if (!valid(days)) return null;
    const n = Math.round(days);
    if (n < 7 || n > 90 || rows.length < n + 1) return null;
    const sample = rows.slice(-n - 1);
    if (!continuous(sample)) return null;
    const returns = sample.slice(1).map((r, i) => Math.log(r.close / sample[i].close));
    const mean = returns.reduce((s, x) => s + x, 0) / n;
    return Math.sqrt(returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) * 365.25) * 100;
  }
  function walls(rows) {
    const known = (rows || []).filter(r => valid(r.strike) && r.strike > 0);
    const peak = key => known.filter(r => valid(r[key]) && r[key] > 0).sort((a, b) => b[key] - a[key] || a.strike - b.strike)[0] || null;
    return { call: peak("callOi"), put: peak("putOi") };
  }
  function range(spot, iv, days) {
    if (![spot, iv, days].every(valid) || spot <= 0 || iv <= 0 || days <= 0) return null;
    const move = spot * iv / 100 * Math.sqrt(days / 365.25);
    return { low: Math.max(0, spot - move), high: spot + move, move, percent: move / spot * 100 };
  }
  function fresh(asOf, now = Date.now(), hours = 6) {
    const age = now - Date.parse(asOf || "");
    return Number.isFinite(age) && age >= -300000 && age <= hours * 3600000;
  }
  root.PulseMath = Object.freeze({ sma, trend, realizedVol, walls, range, fresh, continuous });
})(globalThis);
