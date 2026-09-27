# 06 — Observability: health, alerts, KPIs, audit-chain checks

Owner: admin group (thresholds, admin jobs, admin endpoints). Code: `apps/api/src/modules/admin/system/service.ts`
(`systemHealth`, `ALERT_THRESHOLDS`, `evaluateAlerts`, `evaluateAndPersistAlerts`), `apps/api/src/jobs/admin.ts`,
`apps/api/src/modules/admin/dashboard/service.ts`, table `admin_ops_alerts` / `admin_kpi_snapshots` (`db/migrations/0060_admin.sql`).
`ALERT_THRESHOLDS` in code is the single source of truth; this page mirrors it — change both together.

---

## 1. Signals

| Source | Where | Notes |
|---|---|---|
| Structured logs | stdout (Workers Logs / container logs) via `lib/logger.ts` | JSON lines, request id, PII keys redacted (`email`, `phone`, `token`, `account_number`, `nik`, …) |
| Public liveness | `GET /v1/health` | no auth; for uptime checks / load balancer |
| Operational health | `GET /v1/admin/system/health` (`infra.db.read`) | snapshot below; computed live, no caching |
| Alerts | `GET /v1/admin/system/alerts` (`infra.db.read`) | current alerts + `firstSeenAt`/`occurrences` from `admin_ops_alerts` + the threshold table |
| DB internals | `GET /v1/admin/infra/db/health` | version, size, connections by state, cache-hit ratio, long-running queries (> 30 s), replication |
| Business KPIs | `GET /v1/admin/dashboard/kpis`, daily `admin_kpi_snapshots` | every metric carries `definition` + `dataQuality` |
| Security events | `security_events` (append-only) | `ADMIN_PII_REVEALED`, `ROLE_*`, `OPS_ALERT`, `AUDIT_CHAIN_BROKEN`, `ADMIN_BREAK_GLASS_GRANT`, auth events … |
| Integrity | `audit_logs` hash chain, `app_health_checks` component `AUDIT_CHAIN` | nightly verification job |

## 2. `GET /v1/admin/system/health` fields

| Field | Meaning |
|---|---|
| `status` | `OK` · `DEGRADED` (any HIGH alert) · `CRITICAL` (any CRITICAL alert or the DB probe failed) |
| `database` | `ok`, `latencyMs` (SELECT 1), `schemaVersion` (last `schema_migrations`), `connections` / `maxConnections` |
| `outbox` | `backlog` (unpublished events), `oldestUnpublishedAgeSec`, `retryingEvents` |
| `jobs` | `queued`, `running`, `overdue` (QUEUED with `run_at` > 10 min ago), `dead24h`, `deadTotal`, `expiredLeases` (RUNNING with lease in the past) |
| `webhooks` | `received24h`, `failed24h` (processing_error), `unprocessedOlderThan10m`, `invalidSignature24h` |
| `refunds` | `failed`, `pendingApproval`, `pendingApprovalOlderThan24h`, `processingOlderThan1h` |
| `payouts` | `failed`, `onHold`, `onHoldOlderThan48h`, `processingOlderThan1h` |
| `notifications` | `deliveries24h` (sent + failed), `failed24h`, `failureRate` (null without deliveries) |
| `security` | HIGH/CRITICAL events in 24 h (**excluding `OPS_ALERT`**, so alerts never feed themselves), `critical24h`, `byType` |
| `disputes.slaBreachedOpen` | open disputes with an SLA breach flag (set by `engagement.dispute_sla`) |
| `support.firstResponseBreached` | open tickets past `sla_due_at` without a first agent response |
| `auditChain` | latest `app_health_checks` row for `AUDIT_CHAIN`: `status` (UP/DOWN), `checkedAt`, `brokenAtId` |
| `integrations` | payments / email / push / sms / storage / kyc: `MOCK` · `SANDBOX` · `LIVE`; `dbAdmin` provider; `paymentProviderEnv` |
| `alertsOpen` | open rows in `admin_ops_alerts` |

## 3. Alert thresholds

A value at or above the threshold raises the alert at that severity (highest tier wins). Rates marked * use a strict `>`.

| Code | Condition | Unit | MEDIUM | HIGH | CRITICAL |
|---|---|---|---|---|---|
| `OUTBOX_BACKLOG` | Unpublished outbox events | events | ≥ 100 | ≥ 500 | — |
| `OUTBOX_STALE` | Age of the oldest unpublished outbox event | seconds | ≥ 300 | ≥ 900 | — |
| `JOBS_DEAD` | Jobs that reached DEAD (max attempts) in the last 24 h | jobs | — | ≥ 1 | — |
| `JOBS_OVERDUE` | QUEUED jobs whose `run_at` is more than 10 minutes in the past | jobs | ≥ 20 | — | — |
| `JOBS_LEASE_EXPIRED` | RUNNING jobs with an expired lease (crashed worker) | jobs | ≥ 1 | — | — |
| `WEBHOOK_FAILURES` | Payment webhooks with `processing_error` in the last 24 h | events | ≥ 1 | ≥ 5 | — |
| `WEBHOOK_BACKLOG` | Payment webhooks unprocessed for more than 10 minutes | events | — | ≥ 1 | — |
| `WEBHOOK_SIGNATURE_INVALID` | Webhooks with an invalid signature/token in the last 24 h | events | ≥ 3 | ≥ 10 | — |
| `REFUND_FAILURES` | Refunds in FAILED | refunds | — | ≥ 1 | — |
| `REFUND_STUCK` | Refunds PROCESSING for more than 1 hour | refunds | ≥ 1 | — | — |
| `REFUND_APPROVAL_BACKLOG` | Refunds PENDING_APPROVAL for more than 24 hours | refunds | ≥ 1 | — | — |
| `PAYOUT_FAILURES` | Payouts in FAILED | payouts | — | ≥ 1 | — |
| `PAYOUT_STUCK` | Payouts PROCESSING for more than 1 hour | payouts | ≥ 1 | — | — |
| `PAYOUT_HOLD_AGING` | Payouts ON_HOLD for more than 48 hours | payouts | ≥ 1 | — | — |
| `NOTIFICATION_FAILURE_RATE`* | failed ÷ (sent + failed) deliveries, 24 h — only with ≥ 20 deliveries | ratio | > 0.05 | > 0.20 | — |
| `SECURITY_EVENTS_HIGH` | HIGH/CRITICAL security events in 24 h (any CRITICAL event → CRITICAL) | events | ≥ 1 | ≥ 10 | any CRITICAL |
| `AUDIT_CHAIN_BROKEN` | Latest nightly `verify_audit_chain()` result is DOWN | check | — | — | ≥ 1 |
| `DB_CONNECTIONS`* | Connections to this database ÷ `max_connections` | ratio | > 0.70 | > 0.85 | — |
| `DISPUTE_SLA_BREACHED` | Open disputes with an SLA breach flag | disputes | ≥ 1 | — | — |
| `SUPPORT_SLA_BREACHED` | Open tickets past `sla_due_at` without a first response | tickets | ≥ 5 | — | — |
| `INTEGRATION_NOT_LIVE_IN_PRODUCTION` | `APP_ENV=production` while payments/email/push/sms/storage is MOCK or SANDBOX | integrations | — | ≥ 1 | — |

Rationale: money-path failures (refund/payout FAILED, dead jobs, webhook backlog) are HIGH at the first occurrence because each one is a
customer's money or an unprocessed payment; backlog-type signals start at MEDIUM. Thresholds are deliberately conservative for launch
volume (< 1k transactions/month) and should be revisited with real traffic.

### Alert lifecycle (`admin.alerts_evaluate`, every 5 min)
* New condition → `admin_ops_alerts` row `OPEN` (one open row per code, DB unique index); HIGH/CRITICAL openings also write one
  `security_events` row `OPS_ALERT` (deduplicated per opening — the page sees it once, not every 5 minutes).
* Still true → `last_seen_at`, `occurrences + 1`, value/severity updated.
* No longer true → `RESOLVED` with `resolved_at`.
* Paging: forward `security_events` of type `OPS_ALERT` / `AUDIT_CHAIN_BROKEN` / `ADMIN_BREAK_GLASS_GRANT` with severity HIGH/CRITICAL to the
  on-call channel (log drain filter on `admin.*` / `security_events` inserts). The admin UI polls `/v1/admin/system/alerts`.

| Alert | First response (runbook) |
|---|---|
| `WEBHOOK_*`, `REFUND_*`, `PAYOUT_*` | `docs/runbooks/payment-incident.md` |
| `DISPUTE_SLA_BREACHED` | `docs/runbooks/dispute-sla-breach.md` |
| `SECURITY_EVENTS_HIGH`, `AUDIT_CHAIN_BROKEN`, `WEBHOOK_SIGNATURE_INVALID` | `docs/runbooks/security-incident.md` |
| `DB_CONNECTIONS`, `JOBS_*`, `OUTBOX_*` | worker/DB health: `GET /v1/admin/infra/db/health`, restart worker, check long-running queries; restore: `docs/runbooks/db-restore.md` |

## 4. Admin background jobs (`apps/api/src/jobs/admin.ts`, all idempotent)

| Job | Every | What it does |
|---|---|---|
| `admin.kpi_snapshot` | 24 h | yesterday's (WIB) KPIs → `admin_kpi_snapshots` (upsert per day) for cheap trend charts |
| `admin.alerts_evaluate` | 5 min | §3 lifecycle |
| `admin.stale_ops_cleanup` | 1 h | `db_operations` REQUESTED > 72 h → CANCELLED; non-migration RUNNING > 24 h → FAILED; expires role requests, settlement changes and trust overrides past `expires_at`; one audit row when anything changed |
| `admin.audit_chain_verify` | 24 h | `verify_audit_chain()` → `app_health_checks` AUDIT_CHAIN UP/DOWN (+ `brokenAtId`, duration); DOWN also writes a CRITICAL `AUDIT_CHAIN_BROKEN` security event and an error log |
| queue `admin.export` | on demand | anonymized analytics export for the DB & Infra Center |

The on-demand check `GET /v1/admin/audit-logs/verify` runs the same function (optionally over an id range) and shows the chain head and the
last external checkpoint.

## 5. KPI definitions

Each KPI in `/v1/admin/dashboard/kpis` returns its own `definition` (Indonesian, shown in the UI tooltip) and `dataQuality`:
`"Belum ada data."` for an empty sample and `"Sampel kecil (n=…)."` below 30 — the UI must render it; ratios on small samples are not
decision-grade. Revenue KPIs come from quote lines of COMPLETED transactions (`v_completed_transaction_lines`) with a ledger cross-check
(`ledgerPlatformRevenue`); dates are WIB calendar days.
