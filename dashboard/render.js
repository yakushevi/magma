// ═══════════════════════════════════════════════════════════════
// render.js — All DOM rendering functions.
//
// Depends on: simulation.js (state, PROVIDERS, calcScore, etc.)
// Called by:  app.js tick loop and incident handlers.
// ═══════════════════════════════════════════════════════════════

// ── Status bar ───────────────────────────────────────────────────

function updateStatusBar({ p95f, rps, totalErrRate, revenueImpactPerSec }) {
  const uptimePct = (1 - state.totalErrors / Math.max(state.totalRequests, 1)) * 100;

  const uptimeEl = document.getElementById('stat-uptime');
  uptimeEl.textContent  = uptimePct.toFixed(2) + '%';
  uptimeEl.style.color  = uptimePct > 99.5 ? 'var(--green)' : uptimePct > 99 ? 'var(--yellow)' : 'var(--red)';

  // SLA target comparison
  const slaTarget = 99.9;
  const slaEl = document.getElementById('stat-sla-target');
  slaEl.textContent = uptimePct >= slaTarget
    ? 'Target: ' + slaTarget + '% ✓'
    : 'Target: ' + slaTarget + '% — BREACH';
  slaEl.style.color = uptimePct >= slaTarget ? 'var(--text-dim)' : 'var(--red)';

  document.getElementById('stat-rps').textContent = rps.toLocaleString();

  const active = PROVIDERS.length - state.blockedProviders.size;
  const provEl = document.getElementById('stat-providers');
  provEl.textContent = active + '/' + PROVIDERS.length;
  provEl.style.color = active === PROVIDERS.length ? 'var(--green)' : active >= 6 ? 'var(--yellow)' : 'var(--red)';

  document.getElementById('stat-p95').innerHTML = p95f + '<span class="stat-unit">ms</span>';

  const errEl = document.getElementById('stat-errrate');
  errEl.innerHTML    = totalErrRate.toFixed(2) + '<span class="stat-unit">%</span>';
  errEl.style.color  = totalErrRate < 0.5 ? 'var(--green)' : totalErrRate < 2 ? 'var(--yellow)' : 'var(--red)';

  // CU billing display
  const cuMillions = (state.totalCU / 1e6).toFixed(1);
  document.getElementById('stat-cu').innerHTML = cuMillions + '<span class="stat-unit">M</span>';

  const cuMismatchEl = document.getElementById('stat-cu-mismatch');
  cuMismatchEl.textContent = state.cuMismatches.toLocaleString() + ' mismatches';
  cuMismatchEl.style.color = state.cuMismatches === 0 ? 'var(--green)' : state.cuMismatches < 50 ? 'var(--yellow)' : 'var(--red)';

  // Incident banner revenue impact
  if (state.incidentActive && revenueImpactPerSec > 0) {
    state._incidentRevenueLoss = (state._incidentRevenueLoss || 0) + revenueImpactPerSec;
    document.getElementById('incident-revenue-impact').textContent =
      '$' + Math.round(state._incidentRevenueLoss).toLocaleString();

    // Update banner text based on incident phase
    const t = state.tick - state.incidentTick;
    if (t >= 35) {
      document.getElementById('incident-banner-text').textContent = 'Circuit OPEN — failover active, traffic rerouted';
    } else if (t >= 25) {
      document.getElementById('incident-banner-text').textContent = 'Cascade risk — ChainLayer-EU degrading';
    } else if (t >= 15) {
      document.getElementById('incident-banner-text').textContent = 'CloudRPC-East blocked — traffic redistributing';
    }
  }

  document.getElementById('clock').textContent = formatTime(new Date());
}

// ── Provider composite scores table (Overview tab) ───────────────

function renderProviderScoresTable() {
  const tbody = document.getElementById('provider-scores-tbody');

  // Compute scores and total for proportional traffic share
  const scores = PROVIDERS.map(p => {
    const blocked = state.blockedProviders.has(p.id);
    if (blocked) return 0;
    const h = state.providerHealth[p.id];
    return calcScore(h.avail, h.latency, h.sync);
  });
  const totalScore = scores.reduce((a, b) => a + b, 0) || 1;

  tbody.innerHTML = PROVIDERS.map((p, i) => {
    const h        = state.providerHealth[p.id];
    const blocked  = state.blockedProviders.has(p.id);
    const degraded = state.degradedProviders.has(p.id);
    const score    = scores[i];
    const traffic  = blocked ? 0 : (score / totalScore * 100);
    const rowClass   = blocked ? 'row-red' : degraded ? 'row-yellow' : score > 0.7 ? 'row-green' : '';
    const scoreColor = blocked ? 'var(--red)' : degraded ? 'var(--yellow)' : score > 0.8 ? 'var(--green)' : 'var(--text)';

    return `<tr class="${rowClass}">
      <td>
        <span style="font-weight:600">${p.name}</span><br>
        <span style="color:var(--text-dim);font-size:10px">${p.chain}</span>
      </td>
      <td style="color:${scoreColor};font-weight:700">${blocked ? 'BLOCKED' : score.toFixed(3)}</td>
      <td>${blocked ? '—' : (h.avail * 100).toFixed(1) + '%'}</td>
      <td>${blocked ? '—' : Math.round(h.latency)}</td>
      <td>${blocked ? '—' : h.sync.toFixed(1)}</td>
      <td>${blocked ? '0.0%' : traffic.toFixed(1) + '%'}</td>
    </tr>`;
  }).join('');
}

// ── Provider health cards (Provider Health tab) ──────────────────

function renderProviderHealth() {
  const grid = document.getElementById('provider-health-grid');
  grid.innerHTML = PROVIDERS.map(p => {
    const h          = state.providerHealth[p.id];
    const blocked    = state.blockedProviders.has(p.id);
    const degraded   = state.degradedProviders.has(p.id);
    const score      = blocked ? 0 : calcScore(h.avail, h.latency, h.sync);
    const statusLabel = blocked ? 'BLOCKED' : degraded ? 'DEGRADED' : 'HEALTHY';
    const statusClass = blocked ? 'badge-red' : degraded ? 'badge-yellow' : 'badge-green';
    const cardClass   = blocked ? 'blocked' : degraded ? 'degraded' : '';
    const availPct    = blocked ? 0 : h.avail * 100;
    const availColor  = availPct > 99 ? 'var(--green)' : availPct > 95 ? 'var(--yellow)' : 'var(--red)';

    return `
    <div class="provider-card ${cardClass}">
      <div class="provider-card-header">
        <div class="provider-name">${p.name}</div>
        <span class="badge ${statusClass}">${statusLabel}</span>
      </div>
      <div class="provider-stat">
        <span class="provider-stat-label">Chain</span>
        <span style="color:var(--blue)">${p.chain}</span>
      </div>
      <div class="provider-stat">
        <span class="provider-stat-label">Score</span>
        <span style="font-weight:700;color:${score > 0.7 ? 'var(--green)' : 'var(--red)'}">
          ${blocked ? 'N/A' : score.toFixed(3)}
        </span>
      </div>
      <div class="provider-stat">
        <span class="provider-stat-label">P50 Latency</span>
        <span>${blocked ? '—' : Math.round(h.latency) + 'ms'}</span>
      </div>
      <div class="provider-stat">
        <span class="provider-stat-label">Sync Lag</span>
        <span>${blocked ? '—' : h.sync.toFixed(2) + 's'}</span>
      </div>
      <div class="provider-stat">
        <span class="provider-stat-label">Sessions</span>
        <span>${blocked ? '0' : state.providerSessions[p.id]}</span>
      </div>
      <div style="margin-top:8px;">
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-dim);margin-bottom:3px;">
          <span>Availability</span><span>${availPct.toFixed(1)}%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${availPct}%;background:${availColor}"></div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ── Routing feed (Routing Feed tab) ─────────────────────────────

function addFeedRow(p95f, totalErrRate) {
  const provider = weightedPickProvider();
  const method   = METHODS[Math.floor(Math.random() * METHODS.length)];
  const mode     = MODES[Math.floor(Math.random() * MODES.length)];
  const h        = state.providerHealth[provider.id];
  const score    = calcScore(h.avail, h.latency, h.sync);
  const isError  = Math.random() < totalErrRate / 100;
  const retry    = isError ? Math.floor(Math.random() * 3) + 1 : 0;
  const latency  = Math.round(h.latency * (1 + 0.2 * gaussNoise()) * (retry > 0 ? 1.5 : 1));
  const result   = isError ? 'ERROR' : retry > 0 ? 'RETRY_OK' : 'OK';

  state.feedRows.unshift({
    time:     formatTime(new Date()),
    id:       randId(),
    chain:    provider.chain,
    method:   method.substring(0, 18),
    provider: provider.name,
    mode,
    score:    score.toFixed(3),
    retry,
    latency:  latency + 'ms',
    result,
    rowClass: result === 'OK' ? 'row-green' : result === 'RETRY_OK' ? 'row-yellow' : 'row-red',
  });
  if (state.feedRows.length > 50) state.feedRows.pop();

  renderFeed();
}

function renderFeed() {
  const tbody = document.getElementById('feed-tbody');
  tbody.innerHTML = state.feedRows.map(r => `
    <tr class="${r.rowClass}">
      <td class="monospace">${r.time}</td>
      <td class="monospace" style="color:var(--text-dim)">${r.id}</td>
      <td><span style="color:var(--blue)">${r.chain}</span> · <span style="font-size:11px">${r.method}</span></td>
      <td style="font-size:11px">${r.provider}</td>
      <td><span class="badge ${r.mode === 'Stateless' ? 'badge-blue' : 'badge-purple'}" style="font-size:10px">${r.mode}</span></td>
      <td class="monospace">${r.score}</td>
      <td style="color:${r.retry > 0 ? 'var(--yellow)' : 'var(--text-dim)'}">${r.retry}</td>
      <td class="monospace">${r.latency}</td>
      <td><span class="badge ${r.result === 'OK' ? 'badge-green' : r.result === 'RETRY_OK' ? 'badge-yellow' : 'badge-red'}" style="font-size:10px">${r.result}</span></td>
    </tr>`).join('');
}

// ── Circuit breaker display (Circuit Breaker tab) ────────────────

function updateCBState() {
  document.getElementById('cb-closed').className = 'cb-state' + (state.cbState === 'CLOSED'    ? ' active-state' : '');
  document.getElementById('cb-half').className   = 'cb-state' + (state.cbState === 'HALF-OPEN' ? ' active-half'  : '');
  document.getElementById('cb-open').className   = 'cb-state' + (state.cbState === 'OPEN'      ? ' active-open'  : '');

  const cbBadge = document.getElementById('cb-header-badge');
  if (state.cbState === 'CLOSED') {
    cbBadge.className   = 'badge badge-green';
    cbBadge.textContent = 'Circuit: CLOSED';
  } else if (state.cbState === 'HALF-OPEN') {
    cbBadge.className   = 'badge badge-yellow';
    cbBadge.textContent = 'Circuit: HALF-OPEN';
  } else {
    cbBadge.className   = 'badge badge-red';
    cbBadge.textContent = 'Circuit: OPEN';
  }

  const errPct = Math.min(state.cbErrors / 2 * 100, 100);
  const bar    = document.getElementById('cb-error-bar');
  bar.style.width = errPct + '%';
  bar.className   = 'error-bar-fill' + (errPct >= 100 ? ' crit' : errPct >= 50 ? ' warn' : '');
  document.getElementById('cb-error-count').textContent = state.cbErrors + ' errors';
}

// ── Incident log table ───────────────────────────────────────────

function renderIncidentTable() {
  const tbody = document.getElementById('incident-tbody');
  if (state.incidents.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:20px;">No incidents recorded. Trigger one above.</td></tr>';
    return;
  }
  tbody.innerHTML = state.incidents.map(inc => {
    const cls = inc.status === 'Resolved' ? 'badge-green' : inc.status === 'Critical' ? 'badge-red' : 'badge-yellow';
    return `<tr>
      <td class="monospace" style="font-size:11px">${inc.time}</td>
      <td>${inc.type}</td>
      <td style="font-size:11px;color:var(--text-dim)">${inc.trigger}</td>
      <td>${inc.duration}</td>
      <td><span class="badge ${cls}">${inc.status}</span></td>
    </tr>`;
  }).join('');
}

// ── Provider error rate bars (Circuit Breaker tab) ───────────────

function renderProviderErrorBars(errTimeout, errUnavail) {
  document.getElementById('provider-error-bars').innerHTML = PROVIDERS.map(p => {
    const blocked  = state.blockedProviders.has(p.id);
    const degraded = state.degradedProviders.has(p.id);
    const errRate  = blocked  ? 95
                  : degraded ? 40 + Math.abs(gaussNoise() * 10)
                  : errTimeout + errUnavail + Math.abs(gaussNoise() * 0.5);
    const color    = errRate > 20 ? 'var(--red)' : errRate > 5 ? 'var(--yellow)' : 'var(--green)';
    return `<div style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">
        <span>${p.name}</span>
        <span style="color:${color};font-weight:600">${errRate.toFixed(1)}%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:${Math.min(errRate, 100)}%;background:${color}"></div>
      </div>
    </div>`;
  }).join('');
}
