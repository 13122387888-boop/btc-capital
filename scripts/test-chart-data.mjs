import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import '../experience-math.js';
import '../chart-data.js';

const T = globalThis.PulseChartData, M = globalThis.PulseMath;
const candles = Array.from({ length: 100 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: i === 99 ? null : 50 + i }));
const trend = T.trendRows(candles, 30, M);
assert.equal(trend.length, 30);
assert.equal(trend[0].ma60, M.sma(candles, 60)[70], '先对完整历史算均线，再截范围');
assert.equal(trend.at(-1).volume, null);
assert.equal(T.trendRows(candles.slice(0, 2), 30, M)[0].ma20, null);
const chain = { oiByStrike: [{ strike: 120, callOi: 8, putOi: 9 }, { strike: 100, callOi: 0, putOi: 0 }, { strike: 80, callOi: null, putOi: 12 }] };
assert.deepEqual(T.oiRows(chain).map(row => row.strike), [80, 120]);
assert.equal(chain.oiByStrike[0].strike, 120, '排序不改变输入样本');

const input = [{ name: '=HYPERLINK("bad")', gex: -123.456, missing: null }, { name: '日期,"换行\n中文"', gex: Infinity, missing: 0 }];
const model = T.create({ title: '测试', columns: [['name', '字段'], ['gex', 'GEX'], ['missing', '缺失']], rows: input, notes: ['原始时间'], sources: [{ name: 'source', url: 'https://example.com/' }] });
const csv = T.toCSV(model);
input[0].gex = 999;
assert.equal(model.rows[0][1], -123.456, '弹层模型与后续更新隔离');
assert.ok(Object.isFrozen(model.rows[0]) && Object.isFrozen(model.sources[0]));
assert.ok(csv.startsWith('\uFEFF') && csv.includes("'=HYPERLINK") && csv.includes('"-123.456"'));
assert.ok(csv.includes('日期,""换行\n中文""'));
assert.equal(model.rows[1][1], null);
assert.equal(T.format(null), '—'); assert.equal(T.format(0), '0');
assert.ok(csv.includes('"-123.456",\r\n'), '缺失必须是空 CSV 单元格');

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const experience = await readFile(new URL('../experience.js', import.meta.url), 'utf8');
function extract(source, name) {
  const match = source.match(new RegExp(`^  function ${name}\\([^]*?^  }`, 'm'));
  assert.ok(match, `找不到 ${name}`); return match[0];
}
const base = {
  window: { PulseChartData: T }, RANGE_DAYS: { '7D': 7, '30D': 30, '90D': 90, '1Y': 366, '6M': 183 },
  btcCandles: candles, etfRollingRows: candles.map((row, index) => ({ date: row.date, daily: index, roll5: 1000 + index, roll20: 2000 + index })),
  defiTrendRows: candles.map(row => ({ label: row.date, left: 100, right: null })), fearGreedRows: [{ date: candles.at(-1).date, value: 0 }],
  currentBtcCandlesAsOf: '2026-04-11T00:00:00Z', moduleUpdatedAt: { sentiment: '2026-04-11T01:00:00Z', defi: '2026-04-11T02:00:00Z' }, sourceStates: { sentiment: 'cached', defi: 'partial' },
  staticData: { sources: { etfFlows: { provider: 'ETF fixture', asOf: '2026-04-10' }, ibitOptions: { provider: 'IBIT fixture', asOf: '2026-04-10' } } },
  chartState: { etfRolling: { range: '7D', overlay: true }, etfCombo: { range: 'ALL', overlay: true }, fng: { range: '7D', overlay: true }, defi: { range: '30D', overlay: true }, options: { range: '30D' } },
  etfComboData: () => [{ month: '2026-02', flow: 10, price: 100 }, { month: '2026-03', flow: 20, price: null }],
  optionChartRows: () => [{ date: '2026-04-10', call: 100, put: 50, ratio: .5, openInterest: 123 }],
  currentBtcProvider: 'Gate', currentBtcAsOf: '2026-04-11T00:01:00Z', sourceStateLabel: value => value
};
vm.createContext(base);
vm.runInContext(['dateValue', 'filterChartRows', 'rangeText', 'chartSeries', 'readChart'].map(name => extract(app, name)).join('\n'), base);
const rolling = base.readChart('etf-rolling-chart');
assert.equal(rolling.rows.length, 8, '沿用当前自然日边界，不误用最近N根');
assert.equal(rolling.rows[0][2], 1092); assert.equal(rolling.rows[0][3], 2092);
assert.equal(rolling.rows.at(-1)[1], 99, '单日净流对应 daily 字段');
assert.equal(rolling.rows.at(-1)[4], candles.at(-1).open);
base.chartState.etfRolling.overlay = false;
assert.equal(base.readChart('etf-rolling-chart').columns.length, 4);
const fng = base.readChart('fng-kline-chart');
assert.equal(fng.rows.at(-2).at(-1), null, '恐贪缺日不补前值');
assert.equal(fng.rows.at(-1).at(-1), 0, '零指数不能变成缺失');
base.btcCandles = candles.slice(1);
base.chartState.defi.range = 'ALL';
assert.equal(base.readChart('defi-chart').rows[0].at(-1), null, '稳定币与K线仅同日关联');
assert.equal(base.readChart('etf-chart').rows[1][2], null);
assert.equal(base.readChart('options-chart').rows[0][4], 123);
assert.equal(base.readChart('unknown'), null);

const context = { state: {}, api: { read: () => ({ gamma: { asOf: new Date().toISOString() }, candles, candleAsOf: new Date().toISOString() }) }, T, M, selectedLevels: () => [], trendRange: 30, usd: value => '$' + value };
context.chosen = { ...chain, expiry: '2026-12-25', expiryTimestamp: Date.now() + 86400000, oiStatus: 'live', gammaStatus: 'live', byStrike: [{ strike: 120, callGex: 100, putGex: -60, netGex: 40 }], coverage: 1 };
context.dataset = () => context.chosen;
vm.createContext(context);
vm.runInContext(extract(experience, 'validGamma') + '\n' + experience.match(/^  function gammaModelReady[^\n]+/m)[0] + '\n' + extract(experience, 'chartTable'), context);
assert.equal(context.chartTable('gamma-chart').rows[0][2], -60);
context.chosen = { ...context.chosen, expiry: '2027-01-29', byStrike: [{ strike: 140, callGex: 200, putGex: -70, netGex: 130 }] };
const selected = context.chartTable('gamma-chart');
assert.equal(selected.rows[0][0], 140); assert.ok(selected.notes[0].includes('2027-01-29'));
context.chosen = { ...context.chosen, gammaStatus: 'unavailable' };
assert.equal(context.chartTable('gamma-chart').rows.length, 0, '不可用Gamma不借用其他期限');
assert.equal(context.chartTable('oi-chart').rows.length, 2, 'Gamma缺失不删有效OI');
context.chosen = { ...context.chosen, gammaStatus: 'live', expiryTimestamp: Date.now() - 1 };
assert.equal(context.chartTable('gamma-chart').rows.length, 0, '到期模型停用');

const guard = {};
vm.createContext(guard); vm.runInContext(extract(app, 'canDrawCanvas'), guard);
const visible = { isConnected: true, getClientRects: () => [{}], getBoundingClientRect: () => ({ width: 300, height: 200 }) };
assert.equal(guard.canDrawCanvas(visible), true, '不依赖 section，放大弹层仍可画');
for (const canvas of [null, { ...visible, isConnected: false }, { ...visible, getClientRects: () => [] }, { ...visible, getBoundingClientRect: () => ({ width: 0, height: 200 }) }]) assert.equal(guard.canDrawCanvas(canvas), false);
const hidden = { ...visible, getClientRects: () => [] }, fail = () => { throw new Error('隐藏图不应绘制或准备数据'); };
const smoke = { $: () => hidden, ensureChartStage: fail, fitCanvas: fail, chartSeries: fail, gammaChartRows: [], btcCandles: [] };
vm.createContext(smoke);
vm.runInContext(['canDrawCanvas', 'drawFearGreedGauge', 'drawGammaChart', 'drawOptionsChart', 'drawDualLine', 'drawEtfCombo', 'drawFearGreedKline', 'drawEtfRolling'].map(name => extract(app, name)).join('\n'), smoke);
smoke.drawFearGreedGauge(50); smoke.drawGammaChart(); smoke.drawOptionsChart(); smoke.drawDualLine(hidden, {}); smoke.drawEtfCombo(); smoke.drawFearGreedKline(); smoke.drawEtfRolling();

const sheet = { scrollTop: 500, showModal() {} }, content = {}, close = { focus() {} }, opener = {};
const ui = { $: id => ({ 'note-sheet': sheet, 'sheet-content': content, 'sheet-close': close })[id], closeZoom() {}, put() {}, document: { activeElement: opener, body: { classList: { add() {} } } }, window: { scrollY: 420 } };
vm.createContext(ui); vm.runInContext(extract(experience, 'showSheet'), ui);
ui.showSheet('数据', '<table></table>');
assert.equal(sheet.scrollTop, 0, '复用弹层必须从顶部显示新的范围和来源');
assert.equal(ui.window.scrollY, 420, '开弹层不能跳动背景页面');
assert.equal(ui.sheetScroll, 420); assert.equal(ui.lastFocus, opener);

for (const fixture of [
  { days: 0, flow5: 100, flow20: 200, state: 'ready', text: '均为正' },
  { days: 0, flow5: null, flow20: null, state: 'error', text: '窗口尚未形成' },
  { days: null, flow5: 100, flow20: 200, state: 'error', text: '缺少有效截止日' },
  { days: 3, flow5: 100, flow20: 200, state: 'stale', text: '超出更新窗口' }
]) {
  const summary = { textContent: '正在计算' }, models = {};
  const capital = {
    staticData: { sources: { etfFlows: { asOf: '2026-09-09' } } }, currentEtf5d: fixture.flow5, currentEtf20d: fixture.flow20,
    completedUtcWeekdaysSince: () => fixture.days, isSnapshotStale: () => false,
    setMarketModel: (key, model) => { models[key] = model; }, flow: String, marketInputState: () => 'ready',
    $: id => id === 'etf-insight' ? { querySelector: () => summary } : null,
    window: { dispatchEvent() {} }, Event: class { constructor(type) { this.type = type; } }
  };
  vm.createContext(capital); vm.runInContext(extract(app, 'renderTodayMarketState'), capital);
  capital.renderTodayMarketState();
  assert.equal(models.capital.dataState, fixture.state);
  assert.equal(summary.textContent, models.capital.reason, 'ETF公共结论不能依赖隐藏月图绘制');
  assert.ok(summary.textContent.includes(fixture.text));
}
console.log('Chart data passed: same-range selectors, full-history MA, expiry/fallback, null/zero/signs, immutable CSV and seven hidden-canvas guards.');
