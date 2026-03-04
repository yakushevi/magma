// ═══════════════════════════════════════════════════════════════
// charts.js — Chart.js instance creation and update helpers.
//
// Depends on: simulation.js (for MAX_POINTS, makeLabels)
// Called by:  app.js (bootstrap) and the tick loop.
// ═══════════════════════════════════════════════════════════════

const MAX_POINTS = 60;

/** Returns an array of empty label strings with 'now' at the tail. */
function makeLabels() {
  return Array(MAX_POINTS).fill('').map((_, i) => i === MAX_POINTS - 1 ? 'now' : '');
}

// ── Shared Chart.js option defaults ─────────────────────────────
const chartDefaults = {
  responsive: true,
  maintainAspectRatio: true,
  animation: { duration: 200 },
  plugins: {
    legend: { labels: { color: '#8b949e', font: { size: 11 } } },
  },
  scales: {
    x: {
      ticks: { color: '#8b949e', font: { size: 10 }, maxTicksLimit: 8 },
      grid:  { color: '#21262d' },
    },
    y: {
      ticks: { color: '#8b949e', font: { size: 10 } },
      grid:  { color: '#21262d' },
    },
  },
};

// ── Chart instances ──────────────────────────────────────────────

const latencyChart = new Chart(document.getElementById('chart-latency'), {
  type: 'line',
  data: {
    labels: makeLabels(),
    datasets: [
      { label: 'P50', data: Array(MAX_POINTS).fill(null), borderColor: '#3fb950', backgroundColor: 'transparent', pointRadius: 0, borderWidth: 1.5, tension: 0.4 },
      { label: 'P95', data: Array(MAX_POINTS).fill(null), borderColor: '#d29922', backgroundColor: 'transparent', pointRadius: 0, borderWidth: 1.5, tension: 0.4 },
      { label: 'P99', data: Array(MAX_POINTS).fill(null), borderColor: '#f85149', backgroundColor: 'transparent', pointRadius: 0, borderWidth: 1.5, tension: 0.4 },
    ],
  },
  options: {
    ...chartDefaults,
    scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, min: 0, suggestedMax: 400 } },
  },
});

const errorChart = new Chart(document.getElementById('chart-errors'), {
  type: 'bar',
  data: {
    labels: makeLabels(),
    datasets: [
      { label: 'Timeout',      data: Array(MAX_POINTS).fill(null), backgroundColor: '#f85149cc', stack: 'errors' },
      { label: 'Unavailable',  data: Array(MAX_POINTS).fill(null), backgroundColor: '#d29922cc', stack: 'errors' },
      { label: 'Invalid Resp', data: Array(MAX_POINTS).fill(null), backgroundColor: '#bc8cffcc', stack: 'errors' },
      { label: 'CU Mismatch',  data: Array(MAX_POINTS).fill(null), backgroundColor: '#58a6ffcc', stack: 'errors' },
    ],
  },
  options: {
    ...chartDefaults,
    scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, min: 0, suggestedMax: 3 } },
  },
});

const throughputChart = new Chart(document.getElementById('chart-throughput'), {
  type: 'line',
  data: {
    labels: makeLabels(),
    datasets: [
      { label: 'Req/sec', data: Array(MAX_POINTS).fill(null), borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.08)', fill: true, pointRadius: 0, borderWidth: 1.5, tension: 0.4 },
    ],
  },
  options: {
    ...chartDefaults,
    scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, min: 0 } },
  },
});

// ── Chart update helpers ─────────────────────────────────────────

/** Append a single data point to a dataset, dropping the oldest if over MAX_POINTS. */
function pushPoint(chart, datasetIdx, value) {
  chart.data.datasets[datasetIdx].data.push(value);
  if (chart.data.datasets[datasetIdx].data.length > MAX_POINTS) {
    chart.data.datasets[datasetIdx].data.shift();
  }
}

/**
 * Push a full set of metrics into all three charts and call update().
 * Called once per tick from app.js.
 */
function updateCharts({ p50f, p95f, p99f, rps, errTimeout, errUnavail, errInvalid, errCU }) {
  pushPoint(latencyChart,   0, p50f);
  pushPoint(latencyChart,   1, p95f);
  pushPoint(latencyChart,   2, p99f);
  pushPoint(errorChart,     0, +errTimeout.toFixed(2));
  pushPoint(errorChart,     1, +errUnavail.toFixed(2));
  pushPoint(errorChart,     2, +errInvalid.toFixed(2));
  pushPoint(errorChart,     3, +errCU.toFixed(2));
  pushPoint(throughputChart, 0, rps);

  latencyChart.update('none');
  errorChart.update('none');
  throughputChart.update('none');
}

/** Pre-fill charts with historical baseline data so they aren't empty on load. */
function prefillCharts() {
  for (let i = 0; i < MAX_POINTS - 1; i++) {
    latencyChart.data.datasets[0].data[i] = Math.round(42  + 5  * gaussNoise());
    latencyChart.data.datasets[1].data[i] = Math.round(88  + 15 * gaussNoise());
    latencyChart.data.datasets[2].data[i] = Math.round(210 + 40 * Math.abs(gaussNoise()));
    errorChart.data.datasets[0].data[i]   = 0.05;
    errorChart.data.datasets[1].data[i]   = 0.04;
    errorChart.data.datasets[2].data[i]   = 0.02;
    errorChart.data.datasets[3].data[i]   = 0.01;
    throughputChart.data.datasets[0].data[i] = Math.round(1247 + 60 * gaussNoise());
  }
  latencyChart.update('none');
  errorChart.update('none');
  throughputChart.update('none');
}

/** Trigger a resize on all charts (needed after tab switches). */
function resizeCharts() {
  latencyChart.resize();
  errorChart.resize();
  throughputChart.resize();
}
