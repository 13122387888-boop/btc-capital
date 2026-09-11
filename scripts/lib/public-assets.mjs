import { createHash } from 'node:crypto';

export const STATIC_FILES = [
  'index.html', 'app.js', 'data.js', 'styles.css', 'enhancements.css',
  'experience.js', 'experience-math.js', 'experience.css', 'snapshot-client.js', 'chart-data.js',
  'favicon.svg', 'apple-touch-icon.png', 'og-image.png', 'og-image.jpg'
];
export const VERSIONED_ASSETS = [...STATIC_FILES.filter(name => name !== 'index.html' && !name.startsWith('og-image.')), 'deployment.js'];
export const assetVersion = content => createHash('sha256').update(content).digest('hex').slice(0, 16);

export function compactSnapshot(name, payload) {
  if (name !== 'defi' || !Array.isArray(payload?.data?.stableSeries)) return payload;
  const timestamp = row => {
    const numeric = Number(row?.date);
    return Number.isFinite(numeric) && row?.date != null ? numeric * (numeric > 1e12 ? 1 : 1000) : Date.parse(row?.date);
  };
  const series = payload.data.stableSeries.filter(row => row?.supply != null && Number.isFinite(Number(row.supply)) && Number.isFinite(timestamp(row)))
    .sort((a, b) => timestamp(a) - timestamp(b));
  return { ...payload, data: { ...payload.data, stableSeries: series.slice(-740) } };
}
