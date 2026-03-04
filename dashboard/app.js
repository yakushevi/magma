// ═══════════════════════════════════════════════════════════════
// app.js — Bootstrap, tab switching, and the main tick loop.
//
// Load order in dashboard.html:
//   1. simulation.js   (state, PROVIDERS, math, tick engine)
//   2. charts.js       (Chart.js instances, updateCharts, prefillCharts)
//   3. render.js       (all DOM render functions)
//   4. app.js          (this file — wires everything together)
// ═══════════════════════════════════════════════════════════════

// ── Tab switching ────────────────────────────────────────────────

function switchTab(name, btn) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
  // Charts must be resized after their container becomes visible.
  setTimeout(resizeCharts, 50);
}

// ── Main tick loop ───────────────────────────────────────────────

function onTick() {
  const metrics = tick();   // simulation.js — advances state, returns metrics snapshot

  updateCharts(metrics);    // charts.js
  updateStatusBar(metrics); // render.js

  renderProviderScoresTable();
  renderProviderHealth();
  addFeedRow(metrics.p95f, metrics.totalErrRate);
  updateCBState();
  renderProviderErrorBars(metrics.errTimeout, metrics.errUnavail);
}

// ── Bootstrap ────────────────────────────────────────────────────

// Pre-fill charts with 59 seconds of baseline history so they aren't empty.
prefillCharts();  // charts.js

// Pre-fill the routing feed with 20 initial rows.
for (let i = 0; i < 20; i++) addFeedRow(88, 0.12);

// Initial synchronous renders.
renderProviderScoresTable();
renderProviderHealth();
updateCBState();
renderIncidentTable();
renderProviderErrorBars(0.05, 0.04);

// Start the 1-second simulation clock.
setInterval(onTick, 1000);
