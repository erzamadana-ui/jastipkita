#!/usr/bin/env node
/**
 * JastipKita API load test — plain Node 22, no new dependencies.
 *
 * Default (in-process) mode:
 *   1. creates a scratch database `jk_load_<ts>` and applies db/scripts/migrate.sh + seed.sh (psql),
 *   2. boots the real API (apps/api/src, loaded through the repo's own `tsx` loader) behind @hono/node-server on
 *      127.0.0.1:<random port>, connected as a jk_app login role (same privileges as production), MOCK providers,
 *      optional in-process worker loop (like src/server.node.ts),
 *   3. seeds N buyers / travelers / ACTIVE trips / MATCHED transactions straight into the DB (+ real sessions),
 *   4. runs each scenario for a fixed duration with C concurrent virtual users over real HTTP (fetch, keep-alive),
 *   5. reports RPS, p50/p95/p99/max latency, error rate and status histograms, then checks DB invariants
 *      (no duplicate payments, one capture per secured payment, every journal balanced, ≤ 1 ACTIVE quote per
 *      transaction, audit chain intact) and drops the scratch DB (unless --keep-db).
 *
 * External mode (BASE_URL=https://staging-api…): only the anonymous scenarios (discovery, customs) run; the
 * authenticated/webhook scenarios need seeded sessions and the MOCK payment provider and are skipped with a note.
 *
 * Usage:
 *   node tests/load/run.mjs [--concurrency 30] [--duration 30] [--scenarios discovery,customs,quote,webhook]
 *                           [--buyers 400] [--trips 300] [--webhook-payments 150] [--webhook-dupes 4]
 *                           [--pool 10] [--worker on|off] [--keep-db] [--json out.json]
 * Env: LOAD_PG_ADMIN_URL (default postgres://postgres@localhost:5432/postgres), BASE_URL (external mode).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const CONCURRENCY = Number(arg('concurrency', 30));
const DURATION_S = Number(arg('duration', 30));
const SCENARIOS = String(arg('scenarios', 'discovery,customs,quote,webhook')).split(',').map((s) => s.trim()).filter(Boolean);
const N_BUYERS = Number(arg('buyers', 400));
const N_TRIPS = Number(arg('trips', 300));
const N_WEBHOOK_PAYMENTS = Number(arg('webhook-payments', 150));
const WEBHOOK_DUPES = Number(arg('webhook-dupes', 4));
const POOL = Number(arg('pool', 10));
const WORKER = String(arg('worker', 'on')) !== 'off';
const KEEP_DB = arg('keep-db', false) === true;
const JSON_OUT = arg('json', null);
const BASE_URL = process.env.BASE_URL ?? null;
const ADMIN_URL = process.env.LOAD_PG_ADMIN_URL ?? process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const API_DIR = join(ROOT, 'apps/api');
const requireApi = createRequire(join(API_DIR, 'package.json'));
const log = (...a) => console.error(`[load ${new Date().toISOString().slice(11, 19)}]`, ...a);

// ------------------------------------------------------------------ stats
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
function summarize(name, samples, wallMs, expectOk) {
  const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
  const statuses = {};
  let errors = 0;
  for (const s of samples) {
    statuses[s.status] = (statuses[s.status] ?? 0) + 1;
    if (!expectOk(s.status)) errors++;
  }
  return {
    scenario: name,
    requests: samples.length,
    wallSeconds: +(wallMs / 1000).toFixed(1),
    rps: +(samples.length / (wallMs / 1000)).toFixed(1),
    p50: +percentile(lat, 50).toFixed(1),
    p95: +percentile(lat, 95).toFixed(1),
    p99: +percentile(lat, 99).toFixed(1),
    max: +(lat.at(-1) ?? 0).toFixed(1),
    errorRate: samples.length ? +(errors / samples.length).toFixed(4) : 0,
    statuses,
  };
}

/** Runs `step(vu, i)` in `concurrency` loops until `durationMs` elapsed (or `until()` says stop). */
async function runLoad(name, { concurrency, durationMs, step, expectOk, until }) {
  const samples = [];
  const deadline = performance.now() + durationMs;
  const started = performance.now();
  let seq = 0;
  async function vu(id) {
    while (performance.now() < deadline && !(until && until())) {
      const i = seq++;
      const t0 = performance.now();
      let status = 0;
      try {
        status = await step(id, i);
      } catch (e) {
        status = e?.name === 'AbortError' ? 'TIMEOUT' : 'NETERR';
      }
      samples.push({ ms: performance.now() - t0, status });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, i) => vu(i)));
  return summarize(name, samples, performance.now() - started, expectOk);
}

async function http(base, method, path, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  const res = await fetch(base + path, { method, headers: h, body: payload, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: json, headers: res.headers };
}

// Synthetic client IPs: the public limits are per IP (120/min for discovery) — a real crowd has many IPs.
const clientIp = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

// ------------------------------------------------------------------ in-process API + scratch DB
async function startInProcess() {
  // the ESM entry of the repo's tsx (createRequire would pick the CJS "require" condition)
  const tsxDir = dirname(requireApi.resolve('tsx/package.json'));
  const { register } = await import(pathToFileURL(join(tsxDir, 'dist/esm/api/index.mjs')).href);
  register();
  const postgres = requireApi('postgres');
  const imp = (p) => import(pathToFileURL(join(API_DIR, p)).href);

  const dbName = `jk_load_${Date.now().toString(36)}`;
  const base = new URL(ADMIN_URL);
  const adminDbUrl = `${base.protocol}//${base.username}${base.password ? ':' + base.password : ''}@${base.host}/${dbName}`;
  const appUrl = `postgres://jk_load:jk_load@${base.host}/${dbName}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  log(`scratch database ${dbName}: migrate + seed …`);
  const env = { ...process.env, DATABASE_URL: adminDbUrl };
  execFileSync('bash', [join(ROOT, 'db/scripts/migrate.sh')], { env, stdio: 'pipe' });
  execFileSync('bash', [join(ROOT, 'db/scripts/seed.sh')], { env, stdio: 'pipe' });
  await admin.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jk_load') THEN CREATE ROLE jk_load LOGIN PASSWORD 'jk_load' IN ROLE jk_app; END IF; END $$`);
  await admin.end();

  const [{ loadEnv }, { buildDeps }, { createApp }, { createSql }, { silentLogger }, mock, { issueSession }, { runWorkerTick }] = await Promise.all([
    imp('src/env.ts'),
    imp('src/deps.ts'),
    imp('src/app.ts'),
    imp('src/db/sql.ts'),
    imp('src/lib/logger.ts'),
    imp('src/providers/mock.ts'),
    imp('src/services/session.ts'),
    imp('src/jobs/runner.ts'),
  ]);
  const { serve } = requireApi('@hono/node-server');

  const appEnv = loadEnv({
    APP_ENV: 'test',
    API_BASE_URL: 'http://api.load',
    WEB_BASE_URL: 'http://web.load',
    ADMIN_BASE_URL: 'http://admin.load',
    JWT_SECRET: randomBytes(32).toString('hex'),
    DATA_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    HMAC_PEPPER: randomBytes(24).toString('hex'),
    OTP_DEV_ECHO: 'true',
    LOG_LEVEL: 'error',
    WORKER_ID: 'load-worker',
    DATABASE_URL: appUrl,
    DB_POOL_MAX: String(POOL),
  });
  const sql = createSql(appUrl, { max: POOL, application_name: 'jastipkita-api-load' });
  const adminSql = createSql(adminDbUrl, { max: 4, application_name: 'jastipkita-load-seed' });
  const payment = new mock.MockPaymentProvider(appEnv.API_BASE_URL);
  const deps = await buildDeps(appEnv, { sql, logger: silentLogger, providers: { payment, email: new mock.LogEmailProvider(), push: new mock.LogPushProvider(), sms: new mock.LogSmsProvider() } });
  const app = createApp(deps);
  const server = await new Promise((res) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => res(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  log(`API listening on ${baseUrl} (pool ${POOL}, worker ${WORKER ? 'on' : 'off'})`);

  let workerTimer = null;
  let workerTicks = 0;
  let workerMs = 0;
  let running = false;
  if (WORKER) {
    workerTimer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const t0 = performance.now();
        await runWorkerTick(deps);
        workerTicks++;
        workerMs += performance.now() - t0;
      } catch (e) {
        log('worker tick failed', e?.message);
      } finally {
        running = false;
      }
    }, 5_000);
  }

  return {
    baseUrl,
    deps,
    sql,
    adminSql,
    payment,
    issueSession,
    workerTicks: () => workerTicks,
    workerAvgTickMs: () => (workerTicks ? Math.round(workerMs / workerTicks) : 0),
    async stop() {
      if (workerTimer) clearInterval(workerTimer);
      while (running) await new Promise((r) => setTimeout(r, 50)); // let an in-flight worker tick finish
      await new Promise((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await sql.end({ timeout: 5 });
      await adminSql.end({ timeout: 5 });
      if (!KEEP_DB) {
        const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
        await a.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await a.end();
      } else log(`kept database ${dbName}`);
    },
    dbName,
  };
}

// ------------------------------------------------------------------ seed (direct SQL: realistic volume fast)
const ORIGINS = [
  ['JP', 'Tokyo', 'JPY', 6000],
  ['JP', 'Osaka', 'JPY', 8000],
  ['KR', 'Seoul', 'KRW', 60000],
  ['SG', 'Singapore', 'SGD', 5500],
];
const wibDay = (offset) => new Date(Date.now() + 7 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);

async function seed(ctx) {
  const { adminSql: db, deps, issueSession } = ctx;
  const t0 = performance.now();
  const nTravelers = Math.max(10, Math.ceil(N_TRIPS / 4));
  const travelers = [];
  for (let i = 0; i < nTravelers; i++) {
    const [u] = await db`INSERT INTO users (email, email_verified_at, phone_e164, phone_verified_at, display_name, kyc_level, active_mode, country_code, trust_score)
      VALUES (${`load-traveler-${i}@example.com`}, now(), ${`+62811${String(1000000 + i)}`}, now(), ${`Traveler Load ${i}`}, 4, 'TRAVELER', 'ID', 75) RETURNING id`;
    travelers.push(u.id);
  }
  const trips = [];
  for (let i = 0; i < N_TRIPS; i++) {
    const [origin, city] = ORIGINS[i % ORIGINS.length];
    const dep = 3 + (i % 40);
    const [tr] = await db`INSERT INTO trips (traveler_id, origin_country, origin_city, destination_country, destination_city, departure_date, arrival_date,
                                            capacity_kg, max_items, fee_type, fee_value, verified_at)
      VALUES (${travelers[i % nTravelers]}, ${origin}, ${city}, 'ID', ${i % 3 ? 'Jakarta' : 'Surabaya'}, ${wibDay(dep)}, ${wibDay(dep + 1)}, 30, 100, 'FIXED', ${100000 + (i % 5) * 25000}, now())
      RETURNING id`;
    await db`SELECT transition_trip(${tr.id}, 1, 'ACTIVE', 'SYSTEM', NULL, 'load seed')`;
    trips.push({ id: tr.id, travelerId: travelers[i % nTravelers], origin, i });
  }
  const jpTrips = trips.filter((t) => t.origin === 'JP');
  const buyers = [];
  for (let i = 0; i < N_BUYERS; i++) {
    const [u] = await db`INSERT INTO users (email, email_verified_at, phone_e164, phone_verified_at, display_name, kyc_level, active_mode, country_code, trust_score)
      VALUES (${`load-buyer-${i}@example.com`}, now(), ${`+62812${String(1000000 + i)}`}, now(), ${`Buyer Load ${i}`}, 3, 'BUYER', 'ID', 60) RETURNING id`;
    const s = await issueSession(deps, ctx.sql, u.id);
    const txs = [];
    for (let k = 0; k < 2; k++) {
      const trip = jpTrips[(i * 2 + k) % jpTrips.length];
      const [rq] = await db`INSERT INTO requests (buyer_id, source_type, product_name, merchant_name, merchant_country, category_code, quantity,
                                                  unit_price_minor, price_currency, max_budget_idr, destination_country, destination_city, status)
        VALUES (${u.id}, 'URL', ${`UNIQLO Ultra Light Down #${i}-${k}`}, 'UNIQLO', 'JP', 'FASHION_APPAREL', 1, ${6000 + (i % 7) * 100}, 'JPY', 3000000, 'ID', 'Jakarta', 'OPEN')
        RETURNING id`;
      const [of] = await db`INSERT INTO offers (request_id, trip_id, traveler_id, initiated_by, traveler_fee_idr, status, responded_at)
        VALUES (${rq.id}, ${trip.id}, ${trip.travelerId}, 'TRAVELER', 100000, 'ACCEPTED', now()) RETURNING id`;
      const [tx] = await db`INSERT INTO transactions (request_id, trip_id, offer_id, buyer_id, traveler_id, item_currency, quantity)
        VALUES (${rq.id}, ${trip.id}, ${of.id}, ${u.id}, ${trip.travelerId}, 'JPY', 1) RETURNING id`;
      await db`SELECT transition_transaction(${tx.id}, 1, 'MATCHED', 'BUYER', ${u.id}, 'load seed')`;
      await db`UPDATE requests SET status = 'MATCHED' WHERE id = ${rq.id}`;
      txs.push(tx.id);
    }
    buyers.push({ id: u.id, token: s.accessToken, quoteTx: txs[0], payTx: txs[1] });
  }
  log(`seeded ${nTravelers} travelers, ${trips.length} ACTIVE trips, ${buyers.length} buyers × 2 MATCHED transactions in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return { buyers, trips };
}

// ------------------------------------------------------------------ scenarios
const CUSTOMS_BODIES = [
  { originCountry: 'JP', categoryCode: 'TOYS_HOBBIES', unitPriceMinor: 60000, currency: 'JPY', quantity: 1 },
  { originCountry: 'JP', categoryCode: 'FASHION_APPAREL', unitPriceMinor: 5990, currency: 'JPY', quantity: 2 },
  { originCountry: 'KR', categoryCode: 'COSMETICS_SKINCARE', unitPriceMinor: 25000, currency: 'KRW', quantity: 3 },
  { originCountry: 'SG', categoryCode: 'ELECTRONICS_AUDIO', unitPriceMinor: 32900, currency: 'SGD', quantity: 1 },
];
const DISCOVERY_QUERIES = ['?originCountry=JP', '?originCountry=KR&limit=50', '?destinationCity=Jakarta', '?originCountry=JP&verifiedOnly=true', '', '?originCountry=SG&categoryCode=ELECTRONICS_AUDIO'];

async function scenarioDiscovery(base) {
  return runLoad('GET /v1/trips (public discovery)', {
    concurrency: CONCURRENCY,
    durationMs: DURATION_S * 1000,
    expectOk: (s) => s === 200,
    step: async (vu, i) => (await http(base, 'GET', `/v1/trips${DISCOVERY_QUERIES[i % DISCOVERY_QUERIES.length]}`, { headers: { 'x-forwarded-for': clientIp(i % 5000) } })).status,
  });
}

async function scenarioCustoms(base) {
  return runLoad('POST /v1/customs/estimate (public)', {
    concurrency: CONCURRENCY,
    durationMs: DURATION_S * 1000,
    expectOk: (s) => s === 200,
    step: async (vu, i) => (await http(base, 'POST', '/v1/customs/estimate', { body: CUSTOMS_BODIES[i % CUSTOMS_BODIES.length], headers: { 'x-forwarded-for': clientIp(i % 5000) } })).status,
  });
}

async function scenarioQuote(base, data) {
  const buyers = data.buyers;
  let limited = 0;
  const r = await runLoad('POST /v1/transactions/{id}/quote (authenticated)', {
    concurrency: CONCURRENCY,
    durationMs: DURATION_S * 1000,
    expectOk: (s) => s === 201,
    step: async (vu, i) => {
      // random buyer → collisions (double-taps on the same transaction) happen on purpose
      const b = buyers[Math.floor(Math.random() * buyers.length)];
      const res = await http(base, 'POST', `/v1/transactions/${b.quoteTx}/quote`, { token: b.token, body: { channel: ['QRIS', 'VA', 'EWALLET'][i % 3] }, headers: { 'x-forwarded-for': clientIp(i % 5000) } });
      if (res.status === 429) limited++;
      return res.status;
    },
  });
  r.notes = [`${limited} × 429 (per-user limit 30/min)`];
  return r;
}

async function scenarioWebhook(base, data, ctx) {
  // setup through the API: quote + checkout for W distinct transactions (not timed)
  const t0 = performance.now();
  const targets = data.buyers.slice(0, Math.min(N_WEBHOOK_PAYMENTS, data.buyers.length));
  const payments = [];
  let setupErrors = 0;
  await Promise.all(
    Array.from({ length: 8 }, async (_, lane) => {
      for (let i = lane; i < targets.length; i += 8) {
        const b = targets[i];
        const q = await http(base, 'POST', `/v1/transactions/${b.payTx}/quote`, { token: b.token, body: { channel: 'QRIS' } });
        if (q.status !== 201) {
          setupErrors++;
          continue;
        }
        const co = await http(base, 'POST', `/v1/transactions/${b.payTx}/checkout`, { token: b.token, body: { quoteId: q.body.quoteId }, headers: { 'idempotency-key': randomUUID() } });
        if (co.status !== 201) {
          setupErrors++;
          continue;
        }
        payments.push({ paymentId: co.body.paymentId, txId: b.payTx, amount: co.body.amountIdr });
      }
    }),
  );
  log(`webhook setup: ${payments.length} AWAITING_PAYMENT checkouts in ${((performance.now() - t0) / 1000).toFixed(1)} s (${setupErrors} setup errors)`);
  // build the provider notifications: each payment's event sent WEBHOOK_DUPES times + one extra event id (provider re-notification)
  const refs = await ctx.adminSql`SELECT id, provider_ref FROM payments WHERE id IN ${ctx.adminSql(payments.map((p) => p.paymentId))}`;
  const refOf = new Map(refs.map((r) => [r.id, r.provider_ref]));
  const deliveries = [];
  for (const p of payments) {
    const ref = refOf.get(p.paymentId);
    const ev = ctx.payment.buildPaymentWebhook(ref, 'SUCCEEDED');
    for (let d = 0; d < WEBHOOK_DUPES; d++) deliveries.push(ev);
    deliveries.push(ctx.payment.buildPaymentWebhook(ref, 'SUCCEEDED')); // different event id, same payment
  }
  // shuffle so duplicates of the same payment arrive concurrently on different connections
  for (let i = deliveries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deliveries[i], deliveries[j]] = [deliveries[j], deliveries[i]];
  }
  let next = 0;
  const outcomes = {};
  const r = await runLoad(`POST /v1/webhooks/payments/mock (burst, ${payments.length} payments × ${WEBHOOK_DUPES + 1})`, {
    concurrency: CONCURRENCY,
    durationMs: Math.max(DURATION_S, 60) * 1000,
    until: () => next >= deliveries.length,
    expectOk: (s) => s === 200,
    step: async () => {
      const idx = next++;
      if (idx >= deliveries.length) return 200;
      const res = await http(base, 'POST', '/v1/webhooks/payments/mock', { raw: deliveries[idx], headers: { 'content-type': 'application/json', 'x-callback-token': 'mock-webhook-token' } });
      const key = `${res.status}:${res.body?.status ?? res.body?.error?.code ?? '?'}:${res.body?.outcome ?? ''}`;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      return res.status;
    },
  });
  r.notes = [`outcomes ${JSON.stringify(outcomes)}`, `${payments.length} payments expected SECURED`];
  r.expectedSecured = payments.length;
  r.paymentIds = payments.map((p) => p.paymentId);
  return r;
}

// ------------------------------------------------------------------ invariants
async function invariants(ctx, webhook) {
  const db = ctx.adminSql;
  const out = {};
  const q1 = async (name, sqlq) => {
    const [row] = await sqlq;
    out[name] = Number(row.n);
  };
  await q1('duplicateLivePayments', db`SELECT count(*) AS n FROM (SELECT transaction_id, purpose FROM payments WHERE status IN ('PENDING','SECURED') GROUP BY 1, 2 HAVING count(*) > 1) x`);
  await q1('securedPayments', db`SELECT count(*) AS n FROM payments WHERE status = 'SECURED'`);
  await q1('captureJournals', db`SELECT count(*) AS n FROM ledger_journals WHERE kind = 'PAYMENT_CAPTURED'`);
  await q1('securedWithoutExactlyOneCapture', db`
    SELECT count(*) AS n FROM payments p WHERE p.status = 'SECURED'
       AND (SELECT count(*) FROM ledger_journals j WHERE j.idempotency_key = 'capture:' || p.id::text) <> 1`);
  await q1('unbalancedJournals', db`SELECT count(*) AS n FROM (SELECT journal_id FROM ledger_entries GROUP BY journal_id HAVING sum(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) <> 0) x`);
  await q1('duplicatePaymentSecuredEvents', db`SELECT count(*) AS n FROM (SELECT transaction_id FROM transaction_events WHERE to_status = 'PAYMENT_SECURED' GROUP BY 1 HAVING count(*) > 1) x`);
  await q1('transactionsWithMultipleActiveQuotes', db`SELECT count(*) AS n FROM (SELECT transaction_id FROM quotes WHERE status = 'ACTIVE' GROUP BY 1 HAVING count(*) > 1) x`);
  await q1('captureVsPaymentAmountMismatch', db`
    SELECT count(*) AS n FROM payments p JOIN ledger_journals j ON j.idempotency_key = 'capture:' || p.id::text
     JOIN ledger_entries e ON e.journal_id = j.id JOIN ledger_accounts a ON a.id = e.account_id AND a.bucket = 'PROVIDER_CASH'
     GROUP BY p.id, p.amount_idr HAVING sum(CASE e.direction WHEN 'DEBIT' THEN e.amount ELSE -e.amount END) <> p.amount_idr`.then((rows) => [{ n: rows.length }]));
  const [chain] = await db`SELECT verify_audit_chain() IS NULL AS ok`;
  out.auditChainOk = chain.ok;
  // not invariants — worker health signals (notifications / side effects lag behind when the outbox backs up)
  const [ob] = await db`SELECT count(*) FILTER (WHERE published_at IS NULL) AS backlog, count(*) AS total,
                               coalesce(extract(epoch FROM now() - min(created_at) FILTER (WHERE published_at IS NULL)), 0)::int AS oldest
                          FROM outbox_events`;
  out.outboxEventsTotal = Number(ob.total);
  out.outboxBacklogAtEnd = Number(ob.backlog);
  out.outboxOldestUnpublishedSec = Number(ob.oldest);
  if (webhook) {
    const [s] = await db`SELECT count(*) AS n FROM payments WHERE id IN ${db(webhook.paymentIds)} AND status = 'SECURED'`;
    out.webhookPaymentsSecured = `${Number(s.n)}/${webhook.expectedSecured}`;
    const [ev] = await db`SELECT count(*) AS n FROM payment_webhook_events`;
    out.webhookInboxRows = Number(ev.n);
  }
  const ok =
    out.duplicateLivePayments === 0 &&
    out.securedWithoutExactlyOneCapture === 0 &&
    out.unbalancedJournals === 0 &&
    out.duplicatePaymentSecuredEvents === 0 &&
    out.captureVsPaymentAmountMismatch === 0 &&
    out.auditChainOk &&
    (!webhook || out.webhookPaymentsSecured === `${webhook.expectedSecured}/${webhook.expectedSecured}`);
  return { ok, ...out };
}

// ------------------------------------------------------------------ main
function table(results) {
  const rows = results.map((r) => `| ${r.scenario} | ${r.requests} | ${r.rps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${(r.errorRate * 100).toFixed(2)}% | ${Object.entries(r.statuses).map(([k, v]) => `${k}×${v}`).join(' ')} |`);
  return ['| Scenario | Requests | RPS | p50 ms | p95 ms | p99 ms | max ms | Error rate | Statuses |', '|---|---:|---:|---:|---:|---:|---:|---:|---|', ...rows].join('\n');
}

async function main() {
  const meta = { startedAt: new Date().toISOString(), node: process.version, concurrency: CONCURRENCY, durationS: DURATION_S, scenarios: SCENARIOS, mode: BASE_URL ? 'external' : 'in-process' };
  const results = [];
  let ctx = null;
  let data = null;
  let base = BASE_URL;
  try {
    if (!BASE_URL) {
      ctx = await startInProcess();
      base = ctx.baseUrl;
      Object.assign(meta, { pool: POOL, worker: WORKER, buyers: N_BUYERS, trips: N_TRIPS, db: ctx.dbName });
      data = await seed(ctx);
      // warm-up (JIT, prepared statements, FX snapshot)
      await http(base, 'GET', '/v1/trips?originCountry=JP');
      await http(base, 'POST', '/v1/customs/estimate', { body: CUSTOMS_BODIES[0] });
      await http(base, 'POST', `/v1/transactions/${data.buyers.at(-1).quoteTx}/quote`, { token: data.buyers.at(-1).token, body: { channel: 'QRIS' } });
    }
    let webhook = null;
    for (const s of SCENARIOS) {
      log(`scenario ${s}: ${CONCURRENCY} VUs × ${DURATION_S} s …`);
      if (s === 'discovery') results.push(await scenarioDiscovery(base));
      else if (s === 'customs') results.push(await scenarioCustoms(base));
      else if (s === 'quote' || s === 'webhook') {
        if (!ctx) {
          log(`skip ${s}: needs seeded sessions + the MOCK payment provider (in-process mode)`);
          continue;
        }
        if (s === 'quote') results.push(await scenarioQuote(base, data));
        else results.push((webhook = await scenarioWebhook(base, data, ctx)));
      } else log(`unknown scenario ${s}`);
      const last = results.at(-1);
      if (last) log(`  → ${last.requests} req, ${last.rps} rps, p50 ${last.p50} ms, p95 ${last.p95} ms, p99 ${last.p99} ms, errors ${(last.errorRate * 100).toFixed(2)}%`);
    }
    let inv = null;
    if (ctx) {
      inv = await invariants(ctx, webhook);
      meta.workerTicks = ctx.workerTicks();
      meta.workerAvgTickMs = ctx.workerAvgTickMs();
    }
    const report = { meta, results: results.map(({ paymentIds, ...r }) => r), invariants: inv };
    console.log(`\n## Load test ${meta.startedAt} (${meta.mode}, ${CONCURRENCY} VUs, ${DURATION_S} s/scenario)\n`);
    console.log(table(results));
    for (const r of results) for (const n of r.notes ?? []) console.log(`- ${r.scenario}: ${n}`);
    if (inv) console.log(`\nInvariants: ${inv.ok ? 'OK' : 'VIOLATED'}\n${JSON.stringify(inv, null, 2)}`);
    if (JSON_OUT) writeFileSync(String(JSON_OUT), JSON.stringify(report, null, 2));
    process.exitCode = inv && !inv.ok ? 2 : 0;
  } finally {
    if (ctx) await ctx.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
