# Monitoring & alerting as code (launch checklist T6)

[`alerts.yaml`](alerts.yaml) is the provider-neutral definition of every alert: signal source, condition, threshold,
window, severity and runbook. It is checked in CI by `apps/api/src/modules/infra/monitoring.test.ts` (in-app thresholds
must equal `ALERT_THRESHOLDS` in code, every log alert must name a log message the API really emits, runbooks must
exist, nothing may claim `WIRED`).

## What exists today (honest status)

| Layer | State | Where |
|---|---|---|
| 21 in-app alerts (outbox lag, job queue, dead jobs, webhooks, refunds, payouts, reconciliation-adjacent, security events, audit chain, DB connections, SLA) | **evaluated** every 5 min by the worker (`admin.alerts_evaluate`), shown in Admin → DB & Infra Center; HIGH/CRITICAL openings write `security_events` `OPS_ALERT`; every opening logs `ALERT ops.alert_opened` | `apps/api/src/modules/admin/system/service.ts`, `docs/06-observability.md` §3 |
| Structured logs (`{ts, level, msg, …}`, PII redacted) incl. `ALERT payment.amount_mismatch`, `ALERT reconciliation.mismatch`, `ALERT audit.checkpoint_refused`, `http.request` (status, ms) | **emitted**; Workers Logs enabled for staging & production in `infra/cloudflare/wrangler.toml` (`[observability] enabled = true`) — but nothing is deployed yet | `apps/api/src/lib/logger.ts` |
| `GET /v1/health` (DB probe, schema version, integration modes) and `GET /v1/health/worker` (age of the last finished scheduled job; **503** when the cron/worker stopped) | **built**, public, no sensitive data | `modules/health`, `modules/infra/heartbeat.ts` |
| Paging to a phone / on-call rotation | **NOT WIRED** — no service connected, no on-call roster decided (owner) | this file |

Nobody is paged by anything yet. Until one of the options below is set up and a test page has been received,
the only way to see an alert is to open the admin UI.

## Wiring options (cheapest first)

### A. Free external uptime checker → the `http_check` alerts (do this first)

Any free HTTP monitor with keyword checks and e-mail/app-push notifications works (e.g. UptimeRobot, Better Stack,
Freshping — free-tier limits such as 5-minute intervals and monitor counts are **ASUMSI**, check when signing up).
Create, per environment:

| Monitor | URL | Type | Alert when | Alert id |
|---|---|---|---|---|
| API health | `https://<api-host>/v1/health` | keyword | keyword `"status":"ok"` **missing** (DB down returns HTTP 200 + `"degraded"`) or timeout > 10 s, 2 checks | `API_DOWN` |
| Worker heartbeat | `https://<api-host>/v1/health/worker` | HTTP status | status ≠ 200, 2 checks | `WORKER_STALE` |
| Payments LIVE (production only, after go-live) | `https://<api-host>/v1/health` | keyword | keyword `"payments":"LIVE"` missing | `INTEGRATION_NOT_LIVE` |

Response time > 2 s (`API_SLOW`) if the tool supports it. Hosts: `alerts.yaml` → `hosts`. The worker heartbeat is the
one signal in-app alerting cannot give: when the Cron Trigger stops, `admin.alerts_evaluate` stops too and every in-app
alert goes silent. Thresholds follow the cron cadence (production `*/5` → stale after 15 min, staging `*/15` → 45 min).

### B. Free GitHub Actions probe (not built — needs the CI owner)

A scheduled workflow (`on: schedule: cron: '*/15 * * * *'`) that `curl -fsS`es both health URLs and fails the run (GitHub
e-mails the workflow's owner on failure) costs nothing beyond Actions minutes. Limits: scheduled runs can be delayed or
skipped under GitHub load and the minimum interval is 5 minutes — acceptable as a second opinion, not as the only pager.
`.github/workflows/` is outside the operations ownership; propose it to the CI owner if option A is not chosen.

### C. Log-based alerts → the `log` alerts and every in-app alert (needs Workers Paid)

Workers Logs on the Free plan keeps 200 000 events/day for 3 days and is queryable in the dashboard, but Cloudflare's
docs describe no alerting on log queries; Tail Workers and Logpush require **Workers Paid** (already the production
assumption in `docs/01-architecture.md` §10 / `docs/STATUS.md` §5b). With Workers Paid:

1. Create a small Tail Worker (`jastipkita-alerts`) and attach it to the API: `[[env.production.tail_consumers]]`
   `service = "jastipkita-alerts"` in `infra/cloudflare/wrangler.toml`
   ([Cloudflare — Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/)).
2. In its `tail(events)` handler, parse each `event.logs[].message[0]` as JSON and forward lines whose `msg` is a
   `source.event` of a `log` alert in `alerts.yaml` (at minimum every `msg` starting with `ALERT `) to a free sink:
   Telegram bot `sendMessage`, a Discord/Slack incoming webhook, or e-mail via the existing Resend key. Rate-limit per
   `msg` (e.g. one message per id per 10 min) so a flood does not become a flood of pages.
3. Rate/percentile alerts (`HTTP_5XX_RATE`, `HTTP_LATENCY_P95`) need aggregation: count in the Tail Worker per minute
   (Durable Object or KV counter) **or** push `http.request` lines with Logpush to an external log tool with alerting.

Volume note: every request logs one `http.request` line. 200 000 events/day ≈ 2.3 requests/s on average — fine for
launch volume; above it Workers Logs samples and log-based alerts lose events (raise to Paid, or lower
`head_sampling_rate` only for `http.request`, never for `ALERT …` lines).

### D. In-app only (current)

Admin → DB & Infra Center polls `/v1/admin/system/alerts` every 60 s and shows the audit checkpoint card. Useful during
working hours; not a pager.

## On-call (T6 second half — owner decision, template)

| Week | Primary (24/7, CRITICAL ≤ 15 min ack) | Secondary (escalation after 30 min) | Business escalation (money/legal) |
|---|---|---|---|
| (isi) | (nama, kanal) | (nama, kanal) | Owner |

Severity policy: `alerts.yaml` → `severity_policy`. CRITICAL alerts with customer money (`PAYMENT_AMOUNT_MISMATCH`,
`PAYMENT_WEBHOOK_NOT_CONFIRMED`) or integrity (`AUDIT_CHAIN_*`, `AUDIT_CHECKPOINT_REFUSED`) also notify the owner.

## Changing an alert

- In-app thresholds: change `ALERT_THRESHOLDS` (code), `docs/06-observability.md` §3 **and** `alerts.yaml` together —
  the test fails otherwise.
- New log alert: the `event` must be an exact `msg` passed to `logger.*()` in `apps/api/src/` (test-enforced).
- Mark `status: WIRED` only after a real test notification was received; record the date in the PR.
