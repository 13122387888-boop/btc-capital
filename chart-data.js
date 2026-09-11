(() => {
  'use strict';
  const value = input => typeof input === 'number' ? Number.isFinite(input) ? input : null : typeof input === 'string' ? input : null;
  const create = ({ title, columns, rows = [], notes = [], sources = [] }) => Object.freeze({
    title,
    columns: Object.freeze(columns.map(([key, label, digits = 2]) => Object.freeze({ key, label, digits }))),
    rows: Object.freeze(rows.map(row => Object.freeze(columns.map(([key]) => value(row[key]))))),
    notes: Object.freeze(notes.map(String)),
    sources: Object.freeze(sources.map(source => Object.freeze({ name: String(source.name || ''), url: String(source.url || '') })))
  });
  function trendRows(candles, count, math) {
    const ma20 = math.sma(candles, 20), ma60 = math.sma(candles, 60);
    return candles.map((row, index) => ({ ...row, ma20: ma20[index], ma60: ma60[index] })).slice(-count);
  }
  function oiRows(data) {
    return (data?.oiByStrike || []).filter(row => (row.callOi || 0) + (row.putOi || 0) > 0).slice().sort((a, b) => a.strike - b.strike);
  }
  function format(input, digits = 2) {
    if (input == null) return '—';
    return typeof input === 'number' ? input.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : input;
  }
  function csvCell(input) {
    if (input == null) return '';
    // Only untrusted strings need formula protection; negative numeric GEX stays numeric.
    let text = String(input);
    if (typeof input === 'string' && /^[\s\uFEFF]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function toCSV(model) {
    const metadata = [[model.title], ...model.notes.map(note => [note]), ...model.sources.map(source => ['来源', source.name, source.url])];
    return '\uFEFF' + [...metadata, [], model.columns.map(column => column.label), ...model.rows].map(row => row.map(csvCell).join(',')).join('\r\n');
  }
  globalThis.PulseChartData = Object.freeze({ create, trendRows, oiRows, format, toCSV });
})();
