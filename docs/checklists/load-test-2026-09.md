# Load test — 2026-09 (local, in-process)

Script: [`tests/load/run.mjs`](../../tests/load/run.mjs) — plain Node 22, no new dependencies (it loads the API through the
repo's own `tsx` and `postgres`/`@hono/node-server` from `apps/api/node_modules`).

```bash
# local: scratch DB (migrate.sh + seed.sh), API in-process on 127.0.0.1:<random>, MOCK providers, worker loop on
node tests/load/run.mjs --concurrency 20 --duration 30 --buyers 500 --trips 300 --webhook-payments 150 --json out.json
node tests/load/run.mjs --concurrency 50 --duration 30 --buyers 500 --trips 300 --webhook-payments 110
# external target: only the anonymous scenarios run (discovery, customs)
BASE_URL=https://staging-api.example node tests/load/run.mjs --scenarios discovery,customs
# options: --scenarios discovery,customs,quote,webhook  --pool 10  --worker on|off  --webhook-dupes 4  --keep-db
# env: LOAD_PG_ADMIN_URL (default postgres://postgres@localhost:5432/postgres)
```

## 1. What the script does

| Step | Detail |
|---|---|
| Scratch DB | `CREATE DATABASE jk_load_<ts>` → `db/scripts/migrate.sh` + `db/scripts/seed.sh` → app connects as a `jk_app` login role (production privileges, RLS/grants apply). Dropped at the end (`--keep-db` keeps it). |
| API | `createApp(buildDeps(...))` from `apps/api/src`, served by `@hono/node-server`, `APP_ENV=test` (MOCK payment/e-mail/push/SMS/FX/KYC), DB pool `--pool` (10), worker tick every 5 s (as `src/server.node.ts`). |
| Seed (direct SQL, not timed) | 75 travelers (KYC 4), 300 ACTIVE verified trips (JP/KR/SG → ID, departures +3…+42 days), 500 buyers (KYC 3) with a real session each and **2 MATCHED transactions** each (one for the quote scenario, one for the webhook scenario). |
| Scenarios (fixed duration, C virtual users, back-to-back requests over HTTP keep-alive) | **discovery** `GET /v1/trips` (6 filter variants, anonymous), **customs** `POST /v1/customs/estimate` (4 item types), **quote** `POST /v1/transactions/{id}/quote` as random buyers (collisions on the same transaction on purpose, 3 channels), **webhook** burst: 110–150 checkouts created through the API (untimed), then every provider callback sent `--webhook-dupes` (4) times + once more with a new event id, shuffled so duplicates race on different connections. |
| Client IPs | Public limits are per IP (`trips.discover` 120/min). Anonymous traffic carries `X-Forwarded-For` from a pool of 5 000 synthetic client IPs (a real crowd); webhooks come from **one** IP (like a PSP). |
| Report | requests, RPS, p50/p95/p99/max, error rate (non-expected status), status histogram, webhook outcomes, then DB invariants + worker health. Exit code 2 if an invariant is violated. |

## 2. Environment of this run

| Item | Value |
|---|---|
| Machine | 1 VM, **2 vCPU** Intel Xeon @ 2.80 GHz, 7 GB RAM — load generator, API, worker and PostgreSQL all on it |
| Runtime | Node v22.22.2; API + load generator share **one event loop** (in-process mode) |
| Database | PostgreSQL 16.13 local socket/TCP, `shared_buffers=128MB`, `synchronous_commit=on`, pool 10 |
| Providers | MOCK (payment, e-mail, push, FX static, KYC) — no network latency to Xendit/Resend/FCM |
| Noise | Another agent's `vitest` run was active on the same VM during parts of both runs (load average 1.9 → 4.8). Four c=20 runs today gave discovery 299–515 RPS and customs 359–477 RPS: treat numbers as **±40 %**. |

## 3. Results (final runs, 30 s per scenario)

**20 virtual users** (2026-09-27 20:23 UTC)

| Scenario | Requests | RPS | p50 ms | p95 ms | p99 ms | max ms | Error rate | Statuses |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| GET /v1/trips (public discovery) | 9 848 | 327.9 | 58.5 | 91.8 | 119.7 | 246.7 | 0.00 % | 200×9848 |
| POST /v1/customs/estimate (public) | 13 461 | 448.4 | 43.0 | 63.2 | 81.5 | 135.5 | 0.00 % | 200×13461 |
| POST /v1/transactions/{id}/quote (authenticated) | 2 464 | 81.8 | 238.6 | 342.7 | 403.7 | 481.7 | 0.00 % | 201×2464 |
| POST /v1/webhooks/payments/mock (burst, 150 payments × 5) | 750 | 275.5 | 42.9 | 227.0 | 343.0 | 493.7 | **20.00 %** | 200×600 **429×150** |

Webhook outcomes: 150 PROCESSED/SECURED, 123 PROCESSED/ALREADY_PROCESSED, 327 DUPLICATE, **150 × 429 RATE_LIMITED** (see F2).

**50 virtual users** (2026-09-27 20:25 UTC; webhook burst kept at 110 × 5 = 550 < 600/min to measure the path without the limiter)

| Scenario | Requests | RPS | p50 ms | p95 ms | p99 ms | max ms | Error rate | Statuses |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| GET /v1/trips (public discovery) | 13 663 | 454.6 | 101.7 | 170.2 | 229.8 | 1 068.2 | 0.00 % | 200×13663 |
| POST /v1/customs/estimate (public) | 12 840 | 427.2 | 110.4 | 175.2 | 230.4 | 309.4 | 0.00 % | 200×12840 |
| POST /v1/transactions/{id}/quote (authenticated) | 2 868 | 94.7 | 518.5 | 645.7 | 715.8 | 1 012.1 | 0.00 % | 201×2868 |
| POST /v1/webhooks/payments/mock (burst, 110 payments × 5) | 550 | 270.8 | 130.1 | 489.1 | 627.5 | 802.5 | 0.00 % | 200×550 |

Webhook outcomes: 110 SECURED, 121 ALREADY_PROCESSED, 319 DUPLICATE.

### DB invariants after each run — all **OK** (both runs)

| Invariant | c=20 | c=50 |
|---|---|---|
| duplicate live payments per (transaction, purpose) | 0 | 0 |
| SECURED payments / PAYMENT_CAPTURED journals | 150 / 150 | 110 / 110 |
| SECURED payments without exactly one capture journal | 0 | 0 |
| capture PROVIDER_CASH ≠ payment amount | 0 | 0 |
| unbalanced journals (Σ debit ≠ Σ credit) | 0 | 0 |
| transactions with > 1 PAYMENT_SECURED event | 0 | 0 |
| transactions with > 1 ACTIVE quote (concurrent re-quotes) | 0 | 0 |
| webhook payments secured | 150/150 | 110/110 |
| audit hash chain (`verify_audit_chain()`) | OK | OK |
| *worker health:* outbox events / unpublished at end / oldest unpublished | 1 900 / 1 362 / 101 s | 1 740 / 1 332 / 101 s |
| *worker health:* ticks in ~110 s / average tick | 5 / 15.2 s | 4 / 22.0 s |

## 4. Findings — what breaks first, and when

| # | Finding | Evidence | Impact / recommendation |
|---|---|---|---|
| F1 | **CPU-bound at ≈ 330–455 RPS (light reads) and ≈ 80–95 RPS (quote) on 2 vCPU.** 20 → 50 VUs changes throughput by +39 % (discovery), −5 % (customs), +16 % (quote) while p50 roughly doubles (customs 43 → 110 ms, quote 239 → 519 ms). | tables above | The quote is the expensive path (FX lock + customs + restricted + limits + promotions + 11 lines + inserts): 95 RPS on 2 vCPU ≈ 21 ms of CPU per quote (API + Postgres + generator combined). At the per-user limit (30/min = 0.5 RPS) ≈ 190 buyers quoting non-stop saturate this VM. Profile `buildQuote` + inserts before launch; cache customs/restricted rules per WIB day (they only change via maker-checker). |
| F2 | **Payment webhooks are rate-limited per IP (600/min, in-memory per instance)** — 150 of 750 provider callbacks (20 %) got `429` in the c=20 burst. | `money.webhook` limiter in `src/modules/webhooks/routes.ts`; outcomes above | A PSP sends from a handful of IPs; a flash sale above ~10 callbacks/s from one IP is throttled. Xendit retries (6×, back-off) and `money.reconcile_pending_payments` (PENDING > 15 min, every 10 min) recover, so no money is lost — but PAYMENT_SECURED (and the traveler's go-ahead) is delayed by minutes. Recommendation: verify the callback token first and exempt verified provider callbacks from the per-IP limiter (or key it per provider with a limit ≥ expected peak × 3); alert on 429 for `/v1/webhooks/*`. **Owner: money/security.** |
| F3 | **The outbox worker is the first bottleneck.** Under load one in-process worker tick (≤ 100 outbox events + due jobs) took 15–22 s → ~5–7 events/s. One completed transaction emits **≈ 25 outbox events** (measured on the J1 journey: 25 transaction/request events, 60 notification deliveries). | worker health rows; J1 measurement | ≈ 0.2–0.3 completed transactions/s per worker before notifications/e-mails/trust/referral side effects lag, well before the HTTP path saturates. (Most of the 1.3 k backlog here is seed-time events, so this measures drain rate, not user-visible lag.) Run the worker as its own process (`src/worker.node.ts`) with its own pool, batch notification dispatch, and watch `oldestUnpublishedAgeSec` in `/v1/admin/system/health` (alert threshold in `docs/06-observability.md`). |
| F4 | Idempotency, dedup and ledger held under concurrency: concurrent duplicate callbacks, same-transaction re-quotes and parallel checkouts produced no duplicate payment, capture, event or active quote. | invariants table | No action. |
| F5 | Tail latency outlier: discovery max 1.07 s at c=50 (p99 230 ms). | c=50 table | Likely GC / event-loop contention with the in-process load generator; re-check in staging with an external generator before investigating. |

## 5. Caveats (read before quoting these numbers)

* **Single machine, shared event loop.** The load generator runs in the same Node process and on the same 2 vCPU as the API,
  the worker and PostgreSQL, and another test run was active part of the time. Throughput is therefore a pessimistic lower
  bound for the API code, and latency includes client-side scheduling.
* **Not representative of production topology.** Production targets Cloudflare Workers (isolates, per-request DB client) and
  Neon (serverless Postgres over the network: 1–10 ms RTT per query, connection/compute limits, cold starts, autosuspend). Here
  the DB is local (≈ 0 ms RTT) — optimistic for DB-heavy paths such as the quote and webhooks (many sequential queries per request).
* MOCK providers: no Xendit/Resend/FCM latency or rate limits; no TLS; in-memory rate limiter per process (Workers: per isolate).
* Small data set (300 trips, 1 000 transactions): index/plan effects of a year of data are not visible.
* Webhook burst is finite (550–750 requests), so its RPS is a burst figure, not a sustained one.

## 6. Re-run in staging (before launch)

1. `BASE_URL=<staging> node tests/load/run.mjs --scenarios discovery,customs --concurrency 50 --duration 120` from a machine
   **outside** the Workers/Neon region, with Cloudflare rate-limiting rules active (verify real client-IP handling).
2. Quote + checkout with real sessions on staging (seed script against the staging DB, or k6/Artillery with OTP dev-echo on a
   staging-only flag) at the expected launch peak × 3; watch Neon compute CPU, connections and p95 per endpoint.
3. Xendit **test-mode** webhook burst (simulate payments via the Xendit dashboard/API) to confirm F2 and the retry/reconcile
   recovery time end to end.
4. Worker: run `worker.node.ts` (or the Workers cron) separately and measure outbox lag (`oldestUnpublishedAgeSec`) during a
   30-minute soak with the full lifecycle (F3).
5. Re-run the DB invariants query block of `run.mjs` (`invariants()`) against staging after every load test.

---
*Catatan keterbatasan: angka di atas berasal dari satu VM 2 vCPU yang dipakai bersama (generator beban, API, worker, PostgreSQL,
dan run pengujian lain), provider MOCK, dan DB lokal tanpa latensi jaringan — bukan prediksi kapasitas Cloudflare Workers/Neon.
Variasi antar-run ±40 %. Estimasi "≈25 event outbox per transaksi" diukur dari satu journey J1, bukan rata-rata produksi.*
