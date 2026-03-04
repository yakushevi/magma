# Magma CTO Assessment - Lava Smart Router

Two deliverables:

1. **[architecture-analysis-hardening-plan.md](smart-router-assessment/architecture-analysis-hardening-plan.md)** - Technical architecture and 90-day hardening plan
2. **[dashboard/](dashboard/)** - Live operations dashboard prototype (no build step)

---

## Part 1: Architecture Document

### Render to PDF

```bash
cd smart-router-assessment
pandoc architecture-analysis-hardening-plan.md -o architecture-analysis-hardening-plan.pdf --pdf-engine=xelatex --variable mainfont="DejaVu Serif" --variable sansfont="DejaVu Sans" --variable monofont="DejaVu Sans Mono" --variable fontsize=11pt --variable geometry:margin=1in --variable linestretch=1.1 --variable colorlinks=true --variable linkcolor=blue --highlight-style=tango -H <(echo '\usepackage[none]{hyphenat}\sloppy')
```

---

## Part 2: Dashboard Prototype

### Open Locally

```bash
# Open directly in browser - no server needed
open dashboard/dashboard.html         # macOS
xdg-open dashboard/dashboard.html     # Linux
```

### File Structure

```
dashboard/
  dashboard.html    ← HTML shell, <link>/<script> references only
  dashboard.css     ← all styles and CSS variables
  simulation.js     ← provider data, state, math helpers, tick engine
  charts.js         ← Chart.js instances, updateCharts(), prefillCharts()
  render.js         ← all DOM render functions
  app.js            ← bootstrap, tab switching, tick loop wiring
```

### Features

| Tab | What it shows |
|---|---|
| **System Overview** | P50/P95/P99 latency, error rates by type, throughput, provider composite score table |
| **Provider Health** | Per-provider cards with availability, sync lag, session count, traffic share |
| **Routing Feed** | Live audit trail of routing decisions - provider selected, WRS score, retry count, result |
| **Circuit Breaker** | State machine visualization (CLOSED → HALF-OPEN → OPEN), incident log, "Trigger Incident" button |

### Incident Simulation

Click **"Trigger Incident"** on the Circuit Breaker tab to run a 90-second cascade:

- T+5s: Provider `CloudRPC-East` starts degrading
- T+15s: Provider blocked, traffic redistributes
- T+25s: Second provider (`ChainLayer-EU`) degrades
- T+35s: Circuit breaker trips to OPEN state
- T+55s: Transitions to HALF-OPEN, probing recovery
- T+75s: First provider recovers, circuit closes
- T+90s: Full resolution
