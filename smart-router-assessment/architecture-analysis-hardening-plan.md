---
title: "Lava Smart Router: Architecture Analysis and 90-Day Production Hardening Plan"
author: "Magma CTO Assessment - Ilya Yakushev"
date: "March 2026"
geometry: margin=1in
fontsize: 11pt
linestretch: 1.1
colorlinks: true
linkcolor: blue
urlcolor: blue
header-includes:
  - \usepackage{fancyhdr}
  - \pagestyle{fancy}
  - \fancyhead[L]{Lava Smart Router: Architecture \& Hardening}
  - \fancyhead[R]{\thepage}
  - \fancyfoot[C]{}
  - \usepackage{booktabs}
  - \usepackage{longtable}
---

> **Thesis:** The Smart Router is a well-engineered routing engine. It is not broken. But it has specific, fixable failure modes that will breach enterprise SLAs under load if not addressed before Magma signs its first custodian contract. This document identifies the five highest-severity risks, walks through the failure cascades they produce, and proposes a 90-day plan sequenced by blast radius.

\newpage

# 1. System Architecture

## 1.1 What It Does

The Smart Router (`protocol/rpcsmartrouter/`) is an enterprise RPC aggregation layer that sits between clients (custodians, exchanges, wallets) and a pool of RPC node providers. It abstracts multi-provider routing behind a single endpoint, selecting the best provider per request using a weighted composite QoS score, and retrying failed requests transparently. The consumer never sees individual provider addresses or failure events; they see a single, reliable RPC endpoint.

## 1.2 Two Deployment Models

| | **RPCSmartRouter** | **RPCConsumer** |
|---|---|---|
| Provider source | Static YAML config | Blockchain pairing |
| Provider weight boost | 10× for static providers (`consumer_types.go:47`) | None |
| Chain dependency | Off-chain only | Requires blockchain sync |
| Retry deduplication | In-memory ristretto (6h TTL) | Same |
| Health endpoint | None | None |
| Target use case | Enterprise (Magma) | Decentralized dApps |

The 10× weight boost (`WeightMultiplierForStaticProviders = 10`, applied at `consumer_types.go:719`) ensures statically configured providers dominate routing. This is correct for the enterprise model. Most of the risks in this document stem not from the routing algorithm but from the plumbing around it: retry behavior, shutdown lifecycle, circuit breaking, and observability.

## 1.3 Request Lifecycle

```
Client HTTP/WS/gRPC Request
  → ChainListener (chainlib — JSON-RPC / gRPC / REST / Tendermint)
    → ParseMsg → ProtocolMessage
      → SmartRouterRelayStateMachine
        → UsedProviders.TryLockSelection          (used_providers.go:230)
          → ProviderOptimizer.ChooseProvider        (WRS scoring)
            → ConsumerSessionManager.GetSessions   (RWMutex-guarded)
              → sendRelayToProvider                (concurrent goroutines)
                → RelayProcessor.WaitForResults → Response
```

The critical path runs through two locks: a polling mutex in `TryLockSelection` and a broad `RWMutex` in `ConsumerSessionManager` that guards the entire pairing map. That's provider list, blocked providers, session state, purge state, eight fields under one lock at `consumer_session_manager.go:41`.

## 1.4 Three Selection Modes and Retry Strategy

- **Stateless** (default): single provider per attempt; retries up to `MaximumNumberOfTickerRelayRetries = 10` times via a ticker that fires at `relayTimeout` interval (`rpcsmartrouter_server.go:47`). No exponential backoff, just a fixed 2ms sleep between initial relay attempts (`rpcsmartrouter_server.go:59,333`).
- **Stateful**: fan-out to all top providers simultaneously; first valid response wins; no retries.
- **CrossValidation**: fan-out to N providers; requires `AgreementThreshold` consensus; no retries.

For enterprise, Stateless mode carries 95%+ of production traffic. Its retry behavior is the SLA-critical path.

## 1.5 WRS Provider Scoring

```
composite = 0.3 × availability
          + 0.3 × latency_score      (normalized via adaptive P10-P90 T-Digest)
          + 0.2 × sync_score         (normalized via adaptive P10-P90 T-Digest)
          + 0.2 × sqrt(stake_ratio)

selection_weight = max(composite, minSelectionChance=0.01)
probability      = weight_i / Σ(weights)
```

Weights from `DefaultWeightedSelectorConfig()` at `weighted_selector.go:121-129`. The adaptive normalization is recent, well-tested, and sophisticated. I would not change the algorithm. The issues lie elsewhere.

---

# 2. Critical Technical Risks

I identified five risks, ranked by enterprise blast radius. The first three are the ones that will lose us a contract or cause a production incident. The last two erode trust over time.

## Risk 1: No Graceful Shutdown or Health Signaling — CRITICAL

The signal handler at `rpcsmartrouter.go:300-302`:

```go
signalChan := make(chan os.Signal, 1)
signal.Notify(signalChan, os.Interrupt)  // SIGINT only
<-signalChan
return nil
```

Three problems compound here:

**1a. SIGTERM is ignored.** Kubernetes sends SIGTERM for pod eviction, rolling deploys, and scale-down. The process does not catch it. After `terminationGracePeriodSeconds` (default 30s), SIGKILL fires. Every rolling deploy is a hard kill — dedup cache wiped, in-flight requests dropped, QoS state reset.

**1b. No connection drain.** No mechanism to stop accepting new connections while finishing in-flight relays. For a custodian submitting `eth_sendRawTransaction`, a kill between provider receiving the transaction and the router returning the receipt means the client retries and potentially double-submits.

**1c. No health/liveness endpoint.** No `/health`, no gRPC health service, no readiness probe. A router stuck in a lock storm (Risk 3) still accepts TCP connections but never responds. The load balancer keeps sending traffic to a zombie process.

**Impact:** Every deploy is a potential double-execution event. Every stuck process continues receiving traffic indefinitely. Table-stakes for financial transaction handling.

**Effort:** Low-medium. `syscall.SIGTERM` + `sync.WaitGroup` drain + `/health` endpoint returning 503 once drain begins. About a week.

---

## Risk 2: Retry Deduplication Cache Lost on Every Restart — CRITICAL

The retry deduplication system uses a ristretto in-memory cache with a 6-hour TTL (`relay_retries_manager.go:11-14`):

```go
const (
    CacheMaxCost     = 10 * 1024
    CacheNumCounters = 20000
    RetryEntryTTL    = 6 * time.Hour
)
```

The `RelayRetriesManagerInf` interface (`relay_retries_manager.go:17-21`) already has the right abstraction — three methods: `AddHashToCache`, `CheckHashInCache`, `RemoveHashFromCache`. Combined with Risk 1 (no graceful shutdown), every deploy wipes this cache. Any transaction hash in-flight at restart loses its deduplication entry. Client-side retries appear as new, unique requests.

**Impact:** Highest-severity hidden risk. A custodian processing `eth_sendRawTransaction` during a deploy has a non-zero probability of double-execution. Not reliability — *correctness*. Must be fixed before any custodian contract is signed.

**Fix:** Redis backend for `RelayRetriesManagerInf`. Fall back to ristretto when Redis is unavailable. Two days of engineering.

---

## Risk 3: Lock Contention Cascade Under Traffic Spikes — HIGH

Every relay traverses two nested locks:

1. **`UsedProviders.lock`**, polled via `TryLockSelection` up to 500 iterations × 5ms = 2.5s max wait (`used_providers.go:12, 230-250`)
2. **`ConsumerSessionManager.lock`** (RWMutex), guards eight fields including the pairing map, valid addresses, blocked providers, and purge state (`consumer_session_manager.go:41`)

The `ConsumerSessionManager` lock is broad: `getValidConsumerSessionsWithProvider()` holds an RLock for the entire provider selection via `defer` (line 1221-1222). When a write occurs (`UpdateAllProviders()` at line 166-167, or `blockProvider()` at line 1347-1363), Go's `RWMutex` drains all active readers before the writer proceeds. `TryLockSelection` polls up to 500 times with 5ms sleeps (2.5s max wait).

Under a traffic spike (1,000+ concurrent goroutines), a single write event starves all readers. No backpressure: the router accepts unlimited inbound connections, goroutines pile up in the polling loop, providers miss their 1500ms connection deadline, errors trigger retries, retries spawn more goroutines. Self-reinforcing cascade.

**Impact:** P99 → ∞ during the spike. SLA breach.

**Measurement before action:** Validate with a load test before committing to the fix. Run `pprof` goroutine dumps under 2× production TPS with a simultaneous provider kill. If bounded, defer to Q2. If it blows up, prioritize channel-based backpressure in Days 31-60.

---

## Risk 4: Circuit Breaker Is Primitive and Unobservable — HIGH

The circuit breaker at `smartrouter_relay_state_machine.go:378`:

```go
if srsm.consecutivePairingErrors >= 2 {
    utils.LavaFormatWarning("Circuit breaker triggered: ...")
    go validateReturnCondition(err)
    continue
}
```

Four problems:

1. **Inline literal threshold** (`2` at line 378). Not a named constant, not configurable. Operators cannot tune it.
2. **Counter resets on error-type change** (line 391). A flapping provider alternating between `PairingListEmptyError` and `TimeoutError` prevents the circuit from ever opening. That's exactly when a circuit breaker should be doing its job.
3. **No half-open state.** The circuit snaps closed the instant a non-pairing error occurs. No probe requests, no backoff, no minimum open duration.
4. **No Prometheus metric.** State transitions emit `LavaFormatWarning`, which is invisible in standard production alerting. The circuit breaker could fire thousands of times per day with no operator aware.

Additionally, the retry backoff between initial relay attempts is a fixed 2ms sleep (`rpcsmartrouter_server.go:333`). Not exponential, not configurable. Too short to matter for network operations.

**Impact:** During provider outages, the router sends futile retries for the full `MaximumNumberOfTickerRelayRetries (10) × relayTimeout` window before the circuit trips. At 1,000 TPS, that is thousands of failed requests during the detection window. Worse, the *operator doesn't know it happened* because there's no metric.

---

## Risk 5: All Behavioral Limits Are Compile-Time Constants — HIGH

Nine operational constants across `common.go:37-45` and `rpcsmartrouter_server.go:47-59` (connection attempts, timeouts, retry limits, backoff durations) are hard-coded `const` values. A custodian needs 5+ retries with long timeouts (correctness over latency). An exchange needs 1 retry with a 100ms hard deadline (latency over correctness). Today, serving both requires separate compiled binaries. The full list with current defaults appears in the Month 2 plan below.

**Impact:** Sales-blocking. Enterprise procurement teams ask to tune retry behavior before signing. The migration path is low-risk: `const` → `var`, wire to viper flags, keep current values as defaults.

---

# 3. Failure Modes Under Production Stress

These are not restatements of the risks above. They are specific *scenarios* where multiple risks compound into something worse than the sum of parts.

## Scenario A: "The Rolling Deploy"

`kubectl rollout restart` → SIGTERM ignored (Risk 1a) → SIGKILL after 30s → QoS data and dedup cache wiped (Risk 2) → replacement pod routes near-randomly while T-Digest rebuilds → no health endpoint (Risk 1c) so load balancer sends traffic immediately. This happens on every deploy. Double-execution risk for every in-flight subscription at the moment of SIGKILL.

## Scenario B: "The Provider Cascade"

One of four providers drops. Detection: 5 attempts × 1500ms = 7.5s + 3s backoff = 10-12s degradation. At 1,000 TPS: 10,000-12,000 failed requests. Remaining providers absorb 33% more traffic. If one was already at 80%, it starts timing out. The circuit breaker's flapping-reset bug (Risk 4) prevents it from opening. Two providers degraded. Spiral.

## Scenario C: "The Lock Storm"

Traffic spike coincides with a pairing update. Write lock in `UpdateAllProviders()` starves readers. Goroutines pile up in the 5ms polling loop. No backpressure, so new connections keep arriving. Timeouts → retries → more goroutines → scheduler degradation → P99 → ∞. Hard to detect in staging; requires load testing at 2× production TPS with a simultaneous provider kill.

---

# 4. Prioritized 90-Day Hardening Plan

**Philosophy:** Sequence by blast radius, not elegance. Fix what pages you at 3am first. Instrument before you optimize.

## Month 1: Stop the Bleeding, Start Measuring

**Week 1-2: Graceful shutdown + health endpoint.** First priority because it affects every deploy.

- Add `syscall.SIGTERM` to signal handler (`rpcsmartrouter.go:301`)
- Implement connection drain: stop accepting new connections, wait for in-flight relays with a configurable timeout (default 15s), then exit
- Expose `/health` endpoint: returns 200 when ready, 503 once drain begins
- Add Kubernetes liveness/readiness probe configuration to deployment manifests

This unblocks safe deploys immediately. No more SIGKILL cache wipes on routine rollouts.

**Week 2-3: Add missing Prometheus metrics.** Convert existing `LavaFormatWarning` calls to counters:

- Circuit breaker state transitions (labeled by chain), `smartrouter_relay_state_machine.go:378`
- `TryLockSelection` wait-time histogram, `used_providers.go:230`
- CU mismatch events (labeled by provider), `single_provider_session.go:98`
- Provider block/unblock events with reason

These are all logging calls today. Converting to metrics is low-risk, high-value.

**Week 3-4: Load test and profile.** 15-minute test at 2× production TPS. Kill one provider at minute 5, restore at minute 10. Profile `pprof` goroutine dumps at peak. This test answers one question: is the lock contention risk (Risk 3) theoretical or immediate? The answer determines whether lock decomposition enters Month 2.

## Month 2: Fix the Two Contract-Blocking Risks

**Weeks 5-6: Persistent retry deduplication.** Redis backend for `RelayRetriesManagerInf`. Three methods, no complex semantics. Fall back to ristretto if Redis unavailable. This eliminates the double-execution risk on restart.

**Weeks 6-8: Runtime-configurable operational constants.** Seven constants across `common.go` and `rpcsmartrouter_server.go` — connection attempts (5), connection timeout (1500ms), backoff on failure (3s), ticker relay retries (10), max relay retries (6), send relay attempts (3), and circuit breaker threshold (2) — need `const` → `var` conversion with viper flags. Existing defaults stay the same. Zero behavior change without explicit operator configuration. Directly unblocks enterprise sales: "yes, you can tune retry behavior per deployment."

## Month 3: Enterprise Differentiation

**Weeks 9-10: Replace the circuit breaker.** Configurable threshold, half-open state with probe requests, Prometheus metrics on transitions, per-provider state queryable via metrics endpoint. Use `sony/gobreaker` rather than rolling a custom implementation. The `RelayRetriesManagerInf` interface provides the insertion point.

**Weeks 11-12: Per-tenant routing profiles.** Named configuration profiles keyed by API key or HTTP header. A custodian account gets `MaxRelayRetries=5, Timeout=3000ms`; an exchange account gets `MaxRelayRetries=1, Timeout=100ms`. This is the feature that enables tiered enterprise SLAs from a single deployment.

**Week 12: Disaster recovery runbook.** Restart behavior (QoS warm-up window), graceful drain procedure, how to add/remove providers without restart, circuit breaker manual override. This document is a sales artifact as much as an operational one.

---

# 5. What I Would Not Focus on Initially

All reasonable engineering projects. None of them reduces the probability of a 3am page or an SLA breach in the next 90 days.

**ChainLib / gRPC proxy refactoring.** Known-messy (excluded from linting in `.golangci.yml`), but not on the enterprise reliability hot path. High regression risk. Q2.

**CrossValidation mode hardening.** Stateless carries 95%+ of enterprise traffic. Harden CrossValidation after Stateless is reliable.

**WRS algorithm improvements.** The adaptive T-Digest normalization is solid and recently shipped. The problem is missing observability, not algorithm quality.

**Horizontal Smart Router clustering.** No shared session state between instances; a load balancer provides horizontal scale today. Design clustering after single-instance reliability is proven.

**Relay state machine rewrite.** Complex but well-tested. Targeted fixes (metrics, circuit breaker, configurable constants) carry less regression risk than a restructure.

