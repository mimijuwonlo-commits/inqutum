# Synthetic Journey Monitor for Critical End-to-End Workflow (#264)

## Context & Objectives
Inqutum’s most valuable end-to-end workflow comprises the invoice-to-settlement lifecycle:
1. **Invoice Creation**: Seller initiates a payment request with a unique memo and asset specification.
2. **Payment Discovery & Envelope Inspection**: Payer retrieves payment parameters (QR code, destination, memo).
3. **On-Chain Settlement Verification**: Incoming Stellar payment matching memo, amount, and asset is detected.
4. **State Transition to Settled**: Invoice transitions to `PAID` with optimistic locking and settlement audit metadata.
5. **Event Emission & Receipt Generation**: Payment confirmation event is emitted and receipt artifact is exportable.

The Synthetic Journey Monitor exercises this critical happy path on a recurring schedule or on-demand, reporting per-step latencies, end-to-end duration, and—when any step fails—**unambiguous dependency blame** to accelerate incident response.

---

## Journey Steps & Dependency Attribution

| Step Name | Subsystem Exercised | Blamed Dependency on Failure | Diagnostic Triage |
|---|---|---|---|
| `CREATE_INVOICE` | Storage engine & ID generation | `STORAGE_LAYER` | Database connection pool, disk space, table lock contention. |
| `INSPECT_PAYMENT_DETAILS` | Retrieval API & query layer | `API_LAYER` | Route middleware, cache coherence, replica replication lag. |
| `VERIFY_STELLAR_PAYMENT` | Horizon RPC & payment matching | `STELLAR_HORIZON` | Horizon node availability, network fee spikes, RPC gateway timeouts. |
| `CONFIRM_SETTLEMENT` | Settlement engine & transitions | `SETTLEMENT_ENGINE` | Optimistic concurrency conflicts, lease expiration, worker deadlock. |
| `DISPATCH_EVENT_AND_RECEIPT`| Event broker & export engine | `EXPORT_ENGINE` / `NOTIFICATION_PIPELINE`| Template rendering errors, Redis broker queue depth, worker crashes. |

---

## Runnable Execution & CLI

### 1. CLI Execution
```bash
# Run monitor and view human-readable report
npm run journey:monitor

# Run with machine-readable JSON output
npx tsx scripts/synthetic-journey-monitor.ts --json

# Run in CI / readiness mode (exit code 1 if journey fails)
npx tsx scripts/synthetic-journey-monitor.ts --check
```

### 2. HTTP Ops API
Maintainers and monitoring agents can trigger synthetic journeys via the admin-authenticated ops API:
```http
POST /api/ops/synthetic-journey/run
Authorization: Bearer <JOBS_ADMIN_TOKEN>
```
Response:
```json
{
  "success": true,
  "data": {
    "journeyId": "journey_1729027200000_a1b2c3d4",
    "timestamp": "2026-10-15T21:00:00.000Z",
    "success": true,
    "totalLatencyMs": 18,
    "steps": [
      { "step": "CREATE_INVOICE", "status": "PASS", "latencyMs": 4, "dependency": "STORAGE_LAYER" },
      { "step": "INSPECT_PAYMENT_DETAILS", "status": "PASS", "latencyMs": 2, "dependency": "API_LAYER" },
      { "step": "VERIFY_STELLAR_PAYMENT", "status": "PASS", "latencyMs": 5, "dependency": "STELLAR_HORIZON" },
      { "step": "CONFIRM_SETTLEMENT", "status": "PASS", "latencyMs": 4, "dependency": "SETTLEMENT_ENGINE" },
      { "step": "DISPATCH_EVENT_AND_RECEIPT", "status": "PASS", "latencyMs": 3, "dependency": "EXPORT_ENGINE" }
    ]
  }
}
```

---

## Operational Edge Cases & Failure Modes

### 1. Horizon RPC Degradation
- **Symptom**: Step `VERIFY_STELLAR_PAYMENT` times out or fails with HTTP 504.
- **Dependency Blame**: `STELLAR_HORIZON`.
- **Operator Action**: Fail over to secondary Horizon endpoint or check Stellar status dashboard. Invoices remain safe in `PENDING` state and will settle once Horizon connectivity recovers.

### 2. High Concurrency Optimistic Lock Contention
- **Symptom**: Step `CONFIRM_SETTLEMENT` fails due to version mismatch.
- **Dependency Blame**: `SETTLEMENT_ENGINE`.
- **Operator Action**: Inspect settlement worker concurrency settings and verify lease renewal intervals.

### 3. Data Isolation Guarantee
- Synthetic journeys use distinct `SYNTH-` memo prefixes and isolate entities.
- Production analytics and financial totals filter synthetic records to prevent accounting pollution.

### 4. Retries, SLA Thresholds & Run History (#391)
- `SyntheticJourneyMonitor.runJourneyWithRetry({ maxRetries, retryDelayMs, slaThresholdMs })` retries transient failures and flags `slaBreached: true` if `totalLatencyMs > slaThresholdMs`.
- `POST /api/ops/synthetic-journey/run` accepts optional `{ retries, slaThresholdMs }` and requires `Authorization: Bearer <JOBS_ADMIN_TOKEN>` (`401`/`403` otherwise).
- `GET /api/ops/synthetic-journey/history` returns recent bounded run reports (admin-authenticated).
- **Recovery / Rollback**: Failed synthetic runs automatically clean up synthetic invoices in `finally` so no orphan test records remain.


### Bounded CLI retries and SLA checks

The standalone runner delegates to `SyntheticJourneyMonitor.runJourneyWithRetry()`
so retries use the same bounded retry implementation and appear in the monitor's
run history. Retry count is limited to 0–5 additional attempts; malformed,
missing, or excessive values are rejected instead of silently becoming zero.

```bash
npm run journey:monitor -- --check --retries 2 --sla-ms 1500
npm run journey:monitor -- --json --retries 1
```

The JSON and human-readable reports include the attempt count when retries are
enabled and the SLA result when `--sla-ms` is supplied. In check mode, either a
failed journey or an SLA breach returns exit code `1`. Without check mode the
runner still emits the report and returns `0`, allowing operators to inspect a
known failure without making an interactive shell step fail.

Argument errors return exit code `2` and do not start a journey. A failed
attempt is cleaned up by the monitor before the next attempt; no database
schema or invoice API contract changes are required.
