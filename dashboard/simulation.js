// ═══════════════════════════════════════════════════════════════
// simulation.js — Provider data, state model, math helpers,
//                 and the main simulation tick engine.
// ═══════════════════════════════════════════════════════════════

// ── Provider catalogue ──────────────────────────────────────────
const PROVIDERS = [
  { id: 'p1', name: 'NodeRPC-Prime',   chain: 'ETH',  baseLatency: 32, baseAvail: 0.999, baseSync: 0.1 },
  { id: 'p2', name: 'InfraNode-Alpha', chain: 'ETH',  baseLatency: 41, baseAvail: 0.997, baseSync: 0.3 },
  { id: 'p3', name: 'CloudRPC-East',   chain: 'ETH',  baseLatency: 55, baseAvail: 0.995, baseSync: 0.8 },
  { id: 'p4', name: 'ValidatorIO',     chain: 'LAVA', baseLatency: 28, baseAvail: 0.999, baseSync: 0.2 },
  { id: 'p5', name: 'MeshNode-West',   chain: 'BTC',  baseLatency: 67, baseAvail: 0.992, baseSync: 1.5 },
  { id: 'p6', name: 'QuickNode-Pro',   chain: 'ETH',  baseLatency: 38, baseAvail: 0.998, baseSync: 0.4 },
  { id: 'p7', name: 'ChainLayer-EU',   chain: 'ATOM', baseLatency: 82, baseAvail: 0.990, baseSync: 2.1 },
  { id: 'p8', name: 'AnkrRPC-Global',  chain: 'ETH',  baseLatency: 49, baseAvail: 0.996, baseSync: 0.6 },
];

const METHODS = [
  'eth_getBlockByNumber',
  'eth_call',
  'eth_getTransactionReceipt',
  'eth_getLogs',
  'eth_blockNumber',
];

const MODES = ['Stateless', 'Stateless', 'Stateless', 'Stateless', 'CrossValidation'];

// ── Application state ───────────────────────────────────────────
const state = {
  tick: 0,
  incidentActive: false,
  incidentTick: -1,
  cbState: 'CLOSED',        // 'CLOSED' | 'HALF-OPEN' | 'OPEN'
  cbErrors: 0,
  blockedProviders: new Set(),
  degradedProviders: new Set(),
  providerHealth: {},
  providerErrors: {},
  providerSessions: {},
  feedRows: [],
  incidents: [],
  totalRequests: 0,
  totalErrors: 0,
  startTime: Date.now(),
  // CU (Compute Unit) billing tracking
  totalCU: 2400000,         // 2.4M base — accumulates each tick
  cuMismatches: 0,          // silent CU mismatch counter
  monthlyRevenue: 48000,    // $48K/month baseline for revenue impact calc
};

// Snapshot of p3's original health so we can restore it after an incident.
const p3orig = {
  avail: PROVIDERS[2].baseAvail,
  latency: PROVIDERS[2].baseLatency,
};

// Initialise per-provider health objects
PROVIDERS.forEach(p => {
  state.providerHealth[p.id]  = { avail: p.baseAvail, latency: p.baseLatency, sync: p.baseSync, score: 0.85 };
  state.providerErrors[p.id]  = 0;
  state.providerSessions[p.id] = Math.floor(Math.random() * 30) + 10;
});

// ── Math helpers ────────────────────────────────────────────────

/** Box-Muller Gaussian noise, mean 0, stddev 1. */
function gaussNoise() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Weighted Random Selection composite score.
 * Mirrors the formula in weighted_selector.go:252-268.
 *   composite = 0.3×avail + 0.3×latScore + 0.2×syncScore + 0.2×sqrt(stake)
 */
function calcScore(avail, latency, sync, stake = 0.5) {
  const latScore  = clamp(1 - latency / 500, 0, 1);
  const syncScore = clamp(1 - sync / 10,     0, 1);
  const stakeScore = Math.sqrt(stake);
  const composite  = 0.3 * avail + 0.3 * latScore + 0.2 * syncScore + 0.2 * stakeScore;
  return clamp(Math.max(composite, 0.01), 0, 1);
}

/** Pick a provider using WRS — higher composite score → higher probability. */
function weightedPickProvider() {
  const available = PROVIDERS.filter(p => !state.blockedProviders.has(p.id));
  if (available.length === 0) return PROVIDERS[0];

  const scores = available.map(p => {
    const h = state.providerHealth[p.id];
    return calcScore(h.avail, h.latency, h.sync);
  });
  const total = scores.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < available.length; i++) {
    r -= scores[i];
    if (r <= 0) return available[i];
  }
  return available[available.length - 1];
}

// ── Utility ─────────────────────────────────────────────────────

function formatTime(d) {
  return d.toTimeString().split(' ')[0];
}

function randId() {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

// ── Incident phases ─────────────────────────────────────────────

/**
 * Advance incident state-machine based on ticks elapsed since trigger.
 * Returns an object with the computed metrics for this tick so that
 * charts and renders stay decoupled from incident logic.
 */
function advanceIncident(t) {
  if (!state.incidentActive) return;

  if (t === 5) {
    state.degradedProviders.add('p3');
    state.providerHealth['p3'].avail   = 0.7;
    state.providerHealth['p3'].latency = 450;
  }
  if (t === 15) {
    state.blockedProviders.add('p3');
    state.degradedProviders.delete('p3');
    state.cbErrors++;
    document.getElementById('incident-status').textContent = 'p3 blocked — traffic redistributing';
    addIncident('Provider Blocked', 'p3 after 5 consecutive timeouts', 'Active');
  }
  if (t === 25) {
    state.degradedProviders.add('p7');
    state.providerHealth['p7'].avail   = 0.5;
    state.providerHealth['p7'].latency = 800;
  }
  if (t === 35) {
    state.blockedProviders.add('p7');
    state.degradedProviders.delete('p7');
    state.cbErrors  = 2;
    state.cbState   = 'OPEN';
    document.getElementById('incident-status').textContent = '⚡ Circuit OPEN — failover active';
    addIncident('Circuit Breaker OPEN', '2 consecutive PairingListEmptyErrors', 'Critical');
  }
  if (t === 55) {
    state.cbState  = 'HALF-OPEN';
    state.cbErrors = 1;
    document.getElementById('incident-status').textContent = 'Circuit HALF-OPEN — probing p3 recovery';
  }
  if (t === 75) {
    state.blockedProviders.delete('p3');
    state.providerHealth['p3'].avail   = p3orig.avail;
    state.providerHealth['p3'].latency = p3orig.latency;
    state.cbState  = 'CLOSED';
    state.cbErrors = 0;
    document.getElementById('incident-status').textContent = 'p3 recovered — circuit CLOSED';
  }
  if (t === 90) {
    resolveIncident();
  }
}

// ── Main simulation tick ─────────────────────────────────────────

/**
 * Called once per second by setInterval in app.js.
 * Returns a metrics snapshot used by charts.js and render.js.
 */
function tick() {
  state.tick++;
  const t = state.incidentActive ? (state.tick - state.incidentTick) : -1;

  advanceIncident(t);

  // Update provider health with Gaussian noise
  PROVIDERS.forEach(p => {
    if (state.blockedProviders.has(p.id)) return;
    const h     = state.providerHealth[p.id];
    const noise = 1 + 0.08 * gaussNoise();
    h.latency   = clamp(p.baseLatency * noise, 5, 2000);
    if (!state.degradedProviders.has(p.id)) {
      h.avail = clamp(p.baseAvail + 0.002 * gaussNoise(), 0.9, 1.0);
      h.sync  = clamp(p.baseSync  * (1 + 0.1 * gaussNoise()), 0.01, 20);
    }
    h.score = calcScore(h.avail, h.latency, h.sync);
    state.providerSessions[p.id] = clamp(
      state.providerSessions[p.id] + Math.round(gaussNoise() * 3), 5, 100
    );
  });

  // Compute latency percentiles across active providers
  const activeProviders = PROVIDERS.filter(p => !state.blockedProviders.has(p.id));
  const latencies = activeProviders.map(p => state.providerHealth[p.id].latency).sort((a, b) => a - b);
  const p50     = latencies[Math.floor(latencies.length * 0.50)] || 50;
  const p95base = latencies[Math.floor(latencies.length * 0.95)] || 120;
  const p99base = p95base * (1.5 + 0.3 * Math.abs(gaussNoise()));

  const incidentMult = state.incidentActive ? (1 + Math.min(t / 20, 2)) : 1;
  const incidentP50Mult = (state.incidentActive && t > 10 && t < 50) ? 1.4 : 1;
  const p50f = Math.round(p50 * (1 + 0.05 * gaussNoise()) * incidentP50Mult);
  const p95f = Math.round(p95base * incidentMult * (1 + 0.08 * gaussNoise()));
  const p99f = Math.round(p99base * incidentMult * (1 + 0.10 * Math.abs(gaussNoise())));

  // Throughput
  const rps = Math.round(1247 + 80 * gaussNoise() + (state.incidentActive && t < 40 ? -80 : 0));

  // Error rates by type
  const baseErrRate = state.incidentActive ? (t < 20 ? 0.5 : t < 50 ? 2.5 : 0.8) : 0.12;
  const errTimeout  = clamp(baseErrRate * 0.4 * (1 + 0.3 * Math.abs(gaussNoise())), 0, 10);
  const errUnavail  = clamp(baseErrRate * 0.3 * (1 + 0.3 * Math.abs(gaussNoise())), 0, 10);
  const errInvalid  = clamp(baseErrRate * 0.2 * (1 + 0.2 * Math.abs(gaussNoise())), 0, 10);
  const errCU       = clamp(baseErrRate * 0.1 * (1 + 0.2 * Math.abs(gaussNoise())), 0, 10);
  const totalErrRate = errTimeout + errUnavail + errInvalid + errCU;

  state.totalRequests += rps;
  state.totalErrors   += Math.round(rps * totalErrRate / 100);

  // CU accumulation — each request costs ~2 CU on average
  state.totalCU += rps * 2;
  // CU mismatches: rare in normal operation, frequent during degradation
  if (state.incidentActive && t > 10) {
    state.cuMismatches += Math.floor(rps * 0.003);  // 0.3% mismatch rate during incidents
  } else if (Math.random() < 0.02) {
    state.cuMismatches += 1;  // occasional single mismatch
  }

  // Revenue impact estimation (during incidents only)
  const revenueImpactPerSec = state.incidentActive
    ? (state.monthlyRevenue / 30 / 86400) * (totalErrRate / 100) * 10  // amplified for visibility
    : 0;

  return { p50f, p95f, p99f, rps, errTimeout, errUnavail, errInvalid, errCU, totalErrRate, revenueImpactPerSec };
}

// ── Incident lifecycle ───────────────────────────────────────────

function triggerIncident() {
  if (state.incidentActive) return;
  state.incidentActive = true;
  state.incidentTick   = state.tick;
  state.cbErrors       = 0;
  state._incidentRevenueLoss = 0;
  document.getElementById('incident-status').textContent = 'Incident in progress — degrading p3...';
  document.getElementById('incident-banner').style.display = 'flex';
  document.getElementById('incident-banner-text').textContent = 'Incident in progress — CloudRPC-East degrading';
  addIncident('Provider Failure', 'p3 (CloudRPC-East) connectivity loss', 'In Progress');
}

function resolveIncident() {
  state.incidentActive = false;
  state.incidentTick   = -1;
  state.blockedProviders.clear();
  state.degradedProviders.clear();
  state.cbState  = 'CLOSED';
  state.cbErrors = 0;

  PROVIDERS.forEach(p => {
    state.providerHealth[p.id] = {
      avail:   p.baseAvail,
      latency: p.baseLatency,
      sync:    p.baseSync,
      score:   0.85,
    };
  });

  updateCBState();
  document.getElementById('incident-status').textContent = 'Resolved — system normalized';
  document.getElementById('incident-banner').style.display = 'none';

  if (state.incidents.length > 0 && state.incidents[0].status === 'In Progress') {
    state.incidents[0].status   = 'Resolved';
    state.incidents[0].duration = Math.round((Date.now() - state.incidents[0]._start) / 1000) + 's';
  }
  renderIncidentTable();
}

function addIncident(type, trigger, status) {
  state.incidents.unshift({ time: formatTime(new Date()), type, trigger, duration: '—', status, _start: Date.now() });
  if (state.incidents.length > 10) state.incidents.pop();
  renderIncidentTable();
}
