/**
 * Admin dashboard: KPIs, time series and funnel — computed from the database (never from client analytics alone),
 * every number returned with its `definition`, `sampleSize` and a `dataQuality` note when the sample is small.
 * Calendar days are WIB (Asia/Jakarta). Ranges are inclusive WIB dates [from, to].
 */
import type { AppDeps } from '../../../context';
import { Errors } from '../../../lib/errors';
import { num } from '../common';
import { systemHealth } from '../system/service';

export const SMALL_SAMPLE = 30;

export interface Metric {
  key: string;
  label: string;
  value: number | null;
  unit: 'IDR' | 'COUNT' | 'RATIO' | 'HOURS';
  definition: string;
  sampleSize: number | null;
  dataQuality: string | null;
}

export interface Range {
  from: string;
  to: string;
  fromTs: Date;
  toTs: Date; // exclusive
  days: number;
}

const DAY = 86400_000;

function wibDate(d: Date): string {
  return new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

/** Inclusive WIB dates → [fromTs, toTs) instants. Default: last 30 days including today. Max 366 days. */
export function resolveRange(now: Date, from?: string, to?: string): Range {
  const toD = to ?? wibDate(now);
  const fromD = from ?? wibDate(new Date(now.getTime() - 29 * DAY));
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(fromD) || !re.test(toD)) throw Errors.validation({ issues: [{ path: 'from', message: 'format YYYY-MM-DD' }] });
  const fromTs = new Date(`${fromD}T00:00:00+07:00`);
  const toTs = new Date(new Date(`${toD}T00:00:00+07:00`).getTime() + DAY);
  if (Number.isNaN(fromTs.getTime()) || Number.isNaN(toTs.getTime()) || toTs <= fromTs) {
    throw Errors.unprocessable('RANGE_INVALID', 'Rentang tanggal tidak valid (from ≤ to)');
  }
  const days = Math.round((toTs.getTime() - fromTs.getTime()) / DAY);
  if (days > 366) throw Errors.unprocessable('RANGE_TOO_LONG', 'Rentang maksimal 366 hari');
  return { from: fromD, to: toD, fromTs, toTs, days };
}

export function quality(sampleSize: number | null): string | null {
  if (sampleSize === null) return null;
  if (sampleSize === 0) return 'Belum ada data pada periode ini.';
  if (sampleSize < SMALL_SAMPLE) return `Sampel kecil (n=${sampleSize} < ${SMALL_SAMPLE}); jangan disimpulkan sebagai tren.`;
  return null;
}

function metric(key: string, label: string, value: number | null, unit: Metric['unit'], definition: string, sampleSize: number | null): Metric {
  return { key, label, value, unit, definition, sampleSize, dataQuality: quality(sampleSize) };
}

const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1_000_000) / 1_000_000 : null);

export async function kpis(deps: AppDeps, q: { from?: string | undefined; to?: string | undefined }) {
  const now = deps.clock.now();
  const r = resolveRange(now, q.from, q.to);
  const db = deps.sql;
  const { fromTs: f, toTs: t } = r;

  const [c] = await db<{ n: number; gmv: number; platform: number; promo: number; traveler_fee: number }[]>`
    SELECT count(*)::int AS n, coalesce(sum(v.item_price_idr), 0)::bigint AS gmv, coalesce(sum(v.platform_revenue_idr), 0)::bigint AS platform,
           coalesce(sum(v.promo_cost_idr), 0)::bigint AS promo, coalesce(sum(v.traveler_fee_idr), 0)::bigint AS traveler_fee
      FROM v_completed_transaction_lines v JOIN transactions tx ON tx.id = v.transaction_id
     WHERE tx.completed_at >= ${f} AND tx.completed_at < ${t}`;
  const [lr] = await db<{ revenue: number; entries: number }[]>`
    SELECT coalesce(sum(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::bigint AS revenue, count(*)::int AS entries
      FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
     WHERE a.bucket = 'PLATFORM_REVENUE' AND a.currency = 'IDR' AND e.created_at >= ${f} AND e.created_at < ${t}`;
  const byStatus = await db<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM transactions GROUP BY status ORDER BY status`;
  const [txc] = await db<{ created: number; paid: number; delivered: number }[]>`
    SELECT (SELECT count(*) FROM transactions WHERE created_at >= ${f} AND created_at < ${t})::int AS created,
           (SELECT count(DISTINCT transaction_id) FROM payments WHERE secured_at >= ${f} AND secured_at < ${t})::int AS paid,
           (SELECT count(*) FROM transactions WHERE delivered_at >= ${f} AND delivered_at < ${t})::int AS delivered`;
  const [u] = await db<{ total: number; new_users: number; active: number; travelers_active: number; trips_active: number }[]>`
    SELECT (SELECT count(*) FROM users WHERE status <> 'DELETED')::int AS total,
           (SELECT count(*) FROM users WHERE created_at >= ${f} AND created_at < ${t})::int AS new_users,
           (SELECT count(*) FROM users WHERE last_login_at >= ${f} AND last_login_at < ${t})::int AS active,
           (SELECT count(DISTINCT traveler_id) FROM trips WHERE status IN ('ACTIVE','FULL','TRAVELING'))::int AS travelers_active,
           (SELECT count(*) FROM trips WHERE status IN ('ACTIVE','FULL','TRAVELING'))::int AS trips_active`;
  const [dr] = await db<{ opened: number; refunded_tx: number; refunded_idr: number }[]>`
    SELECT (SELECT count(*) FROM disputes WHERE created_at >= ${f} AND created_at < ${t})::int AS opened,
           (SELECT count(DISTINCT transaction_id) FROM refunds WHERE status = 'SUCCEEDED' AND processed_at >= ${f} AND processed_at < ${t})::int AS refunded_tx,
           (SELECT coalesce(sum(amount_idr), 0) FROM refunds WHERE status = 'SUCCEEDED' AND processed_at >= ${f} AND processed_at < ${t})::bigint AS refunded_idr`;
  const fraudBySubject = await db<{ subject_type: string; n: number }[]>`
    SELECT subject_type, count(*)::int AS n FROM risk_reviews WHERE status IN ('OPEN','IN_REVIEW') GROUP BY subject_type ORDER BY subject_type`;
  const fraudOpen = fraudBySubject.reduce((s, x) => s + x.n, 0);
  const buyerRef = await deps.config.get('referral.buyer');
  const monthStart = new Date(`${wibDate(now).slice(0, 7)}-01T00:00:00+07:00`);
  const [ref] = await db<{ spend: number; month_spend: number; rewarded: number; at_cap: number }[]>`
    SELECT (SELECT coalesce(sum(amount_idr), 0) FROM credit_entries WHERE reason = 'REFERRAL_REWARD' AND created_at >= ${f} AND created_at < ${t})::bigint AS spend,
           (SELECT coalesce(sum(amount_idr), 0) FROM credit_entries WHERE reason = 'REFERRAL_REWARD' AND created_at >= ${monthStart})::bigint AS month_spend,
           (SELECT count(*) FROM referrals WHERE status = 'REWARDED' AND rewarded_at >= ${f} AND rewarded_at < ${t})::int AS rewarded,
           (SELECT count(*) FROM (
              SELECT r.referrer_id FROM referrals r JOIN credit_entries ce ON ce.reference_type = 'referral' AND ce.reference_id = r.id
                                     AND ce.user_id = r.referrer_id AND ce.reason = 'REFERRAL_REWARD'
               WHERE ce.created_at >= ${monthStart} GROUP BY r.referrer_id HAVING sum(ce.amount_idr) >= ${buyerRef.monthlyCapIdr}) x)::int AS at_cap`;
  const channels = await db<{ channel: string | null; n: number; amount: number }[]>`
    SELECT channel, count(*)::int AS n, coalesce(sum(amount_idr), 0)::bigint AS amount FROM payments
     WHERE secured_at >= ${f} AND secured_at < ${t} GROUP BY channel ORDER BY amount DESC`;
  const [cu] = await db<{ n: number; estimated: number; declared: number }[]>`
    SELECT count(*)::int AS n,
           coalesce(sum((SELECT coalesce(sum(ql.amount_idr), 0) FROM quote_lines ql
                           WHERE ql.quote_id = tx.active_quote_id AND ql.line_type IN ('CUSTOMS_DUTY','IMPORT_TAX'))), 0)::bigint AS estimated,
           coalesce(sum(cd.total_paid_idr), 0)::bigint AS declared
      FROM customs_declarations cd JOIN transactions tx ON tx.id = cd.transaction_id
     WHERE cd.status <> 'REJECTED' AND cd.created_at >= ${f} AND cd.created_at < ${t}`;
  const tickets = await db<{ priority: string; open: number; breached: number }[]>`
    SELECT priority, count(*)::int AS open,
           count(*) FILTER (WHERE first_response_at IS NULL AND sla_due_at < ${now})::int AS breached
      FROM support_tickets WHERE status NOT IN ('RESOLVED','CLOSED') GROUP BY priority ORDER BY priority`;
  const health = await systemHealth(deps);

  const gmv = num(c!.gmv);
  const platform = num(c!.platform);
  const promo = num(c!.promo);
  const completed = c!.n;
  const ticketOpen = tickets.reduce((s, x) => s + x.open, 0);
  const ticketBreached = tickets.reduce((s, x) => s + x.breached, 0);
  const estimated = num(cu!.estimated);
  const declared = num(cu!.declared);

  const metrics: Metric[] = [
    metric('gmv', 'GMV', gmv, 'IDR', 'Σ baris ITEM_PRICE (quote aktif) transaksi COMPLETED dengan completed_at dalam periode (v_completed_transaction_lines).', completed),
    metric('completedTransactions', 'Transaksi selesai', completed, 'COUNT', 'Jumlah transaksi dengan completed_at dalam periode.', completed),
    metric('platformRevenue', 'Pendapatan platform (quote)', platform, 'IDR', 'Σ baris quote ber-bucket PLATFORM_REVENUE (platform fee + protection) transaksi COMPLETED dalam periode.', completed),
    metric('netRevenue', 'Pendapatan bersih', platform - promo, 'IDR', 'Pendapatan platform (quote) − biaya promo (DISCOUNT + REFERRAL_CREDIT) transaksi COMPLETED dalam periode.', completed),
    metric('takeRate', 'Take rate', ratio(platform, gmv), 'RATIO', 'Pendapatan platform (quote) ÷ GMV.', completed),
    metric('netTakeRate', 'Net take rate', ratio(platform - promo, gmv), 'RATIO', '(Pendapatan platform − biaya promo) ÷ GMV.', completed),
    metric('ledgerPlatformRevenue', 'Pendapatan platform (ledger)', num(lr!.revenue), 'IDR', 'Mutasi bersih akun PLATFORM_REVENUE (IDR) yang diposting dalam periode — angka finance-grade (termasuk fee yang ditahan saat pembatalan).', lr!.entries),
    metric('transactionsCreated', 'Transaksi dibuat', txc!.created, 'COUNT', 'Transaksi dengan created_at dalam periode.', txc!.created),
    metric('usersTotal', 'Total pengguna', u!.total, 'COUNT', 'Akun dengan status selain DELETED (saat ini).', u!.total),
    metric('usersNew', 'Pengguna baru', u!.new_users, 'COUNT', 'Akun dibuat dalam periode.', u!.new_users),
    metric('usersActive', 'Pengguna aktif', u!.active, 'COUNT', 'Akun dengan last_login_at dalam periode (login terakhir; bukan DAU/MAU).', u!.active),
    metric('travelersActive', 'Traveler aktif', u!.travelers_active, 'COUNT', 'Traveler berbeda dengan trip ACTIVE/FULL/TRAVELING saat ini.', u!.travelers_active),
    metric('tripsActive', 'Trip aktif', u!.trips_active, 'COUNT', 'Trip berstatus ACTIVE/FULL/TRAVELING saat ini.', u!.trips_active),
    metric('disputeRate', 'Dispute rate', ratio(dr!.opened, txc!.delivered), 'RATIO', 'Dispute dibuka dalam periode ÷ transaksi dengan delivered_at dalam periode.', txc!.delivered),
    metric('refundRate', 'Refund rate', ratio(dr!.refunded_tx, txc!.paid), 'RATIO', 'Transaksi dengan refund SUCCEEDED (processed_at dalam periode) ÷ transaksi dengan pembayaran SECURED dalam periode.', txc!.paid),
    metric('refundedIdr', 'Nominal refund', num(dr!.refunded_idr), 'IDR', 'Σ refund SUCCEEDED dengan processed_at dalam periode.', dr!.refunded_tx),
    metric('fraudReviewsOpen', 'Review fraud terbuka', fraudOpen, 'COUNT', 'risk_reviews berstatus OPEN/IN_REVIEW (saat ini).', fraudOpen),
    metric('referralSpend', 'Biaya referral', num(ref!.spend), 'IDR', 'Σ credit REFERRAL_REWARD yang diberikan dalam periode (kredit, tidak dapat ditarik).', ref!.rewarded),
    metric('referralSpendMonthToDate', 'Biaya referral bulan ini', num(ref!.month_spend), 'IDR', 'Σ credit REFERRAL_REWARD sejak awal bulan kalender (WIB).', null),
    metric('referralMonthlyCapPerReferrer', 'Batas bulanan per referrer', buyerRef.monthlyCapIdr, 'IDR', 'Config referral.buyer.monthlyCapIdr (batas per referrer per bulan WIB).', null),
    metric('referrersAtCap', 'Referrer mencapai batas', ref!.at_cap, 'COUNT', 'Referrer yang total REFERRAL_REWARD bulan ini ≥ batas bulanan.', null),
    metric('customsEstimatedIdr', 'Estimasi bea & pajak impor', estimated, 'IDR', 'Σ baris CUSTOMS_DUTY + IMPORT_TAX quote aktif untuk transaksi yang deklarasi bea cukainya dibuat dalam periode.', cu!.n),
    metric('customsDeclaredIdr', 'Bea & pajak dibayar (deklarasi)', declared, 'IDR', 'Σ total_paid_idr customs_declarations (status ≠ REJECTED) dibuat dalam periode.', cu!.n),
    metric('customsVarianceRatio', 'Selisih deklarasi vs estimasi', estimated > 0 ? Math.round(((declared - estimated) / estimated) * 1_000_000) / 1_000_000 : null, 'RATIO', '(dibayar − estimasi) ÷ estimasi; positif = estimasi terlalu rendah.', cu!.n),
    metric('supportBacklog', 'Backlog tiket', ticketOpen, 'COUNT', 'Tiket berstatus selain RESOLVED/CLOSED (saat ini).', ticketOpen),
    metric('supportSlaBreached', 'Tiket lewat SLA', ticketBreached, 'COUNT', 'Tiket terbuka tanpa respons pertama dengan sla_due_at sudah lewat.', ticketOpen),
  ];

  return {
    range: { from: r.from, to: r.to, days: r.days, timezone: 'Asia/Jakarta' },
    generatedAt: now.toISOString(),
    metrics,
    breakdowns: {
      transactionsByStatus: byStatus.map((x) => ({ status: x.status, count: x.n })),
      paymentsByChannel: channels.map((x) => ({ channel: x.channel ?? 'UNKNOWN', count: x.n, amountIdr: num(x.amount) })),
      fraudReviewsBySubject: fraudBySubject.map((x) => ({ subjectType: x.subject_type, count: x.n })),
      supportBacklogByPriority: tickets.map((x) => ({ priority: x.priority, open: x.open, slaBreached: x.breached })),
    },
    systemHealth: {
      status: health.status,
      outboxBacklog: health.outbox.backlog,
      oldestUnpublishedAgeSec: health.outbox.oldestUnpublishedAgeSec,
      deadJobs24h: health.jobs.dead24h,
      webhookFailures24h: health.webhooks.failed24h,
      alertsOpen: health.alertsOpen,
      integrations: health.integrations,
    },
    definitions: {
      transactionsByStatus: 'Jumlah transaksi per status saat ini (snapshot, tidak dibatasi periode).',
      paymentsByChannel: 'Pembayaran SECURED (secured_at dalam periode) per kanal: jumlah & nominal IDR.',
      fraudReviewsBySubject: 'risk_reviews OPEN/IN_REVIEW per subject type (snapshot).',
      supportBacklogByPriority: 'Tiket terbuka per prioritas + yang melewati SLA respons pertama (snapshot).',
    },
    notes: [
      'GMV/take rate memakai baris harga quote (product/BI); angka finance-grade memakai ledger (ledgerPlatformRevenue).',
      'SafePay berjalan di mode SANDBOX/MOCK sampai kontrak Xendit aktif — angka pembayaran belum uang riil.',
    ],
  };
}

// ------------------------------------------------------------------ time series

export const SERIES = {
  gmv: { unit: 'IDR', definition: 'Σ ITEM_PRICE transaksi COMPLETED per hari/minggu completed_at (WIB).' },
  net_revenue: { unit: 'IDR', definition: 'Σ (PLATFORM_REVENUE − promo) baris quote transaksi COMPLETED per completed_at (WIB).' },
  transactions_created: { unit: 'COUNT', definition: 'Transaksi dibuat per created_at (WIB).' },
  transactions_completed: { unit: 'COUNT', definition: 'Transaksi COMPLETED per completed_at (WIB).' },
  payments_secured_idr: { unit: 'IDR', definition: 'Σ amount_idr pembayaran per secured_at (WIB).' },
  signups: { unit: 'COUNT', definition: 'Akun dibuat per created_at (WIB).' },
  disputes_opened: { unit: 'COUNT', definition: 'Dispute dibuka per created_at (WIB).' },
  refunds_succeeded_idr: { unit: 'IDR', definition: 'Σ refund SUCCEEDED per processed_at (WIB).' },
} as const;
export type SeriesKey = keyof typeof SERIES;

export async function timeseries(deps: AppDeps, q: { metric: SeriesKey; interval: 'day' | 'week'; from?: string | undefined; to?: string | undefined }) {
  const r = resolveRange(deps.clock.now(), q.from, q.to);
  const db = deps.sql;
  const { fromTs: f, toTs: t } = r;
  const iv = q.interval;
  const bucket = (col: string) => db`date_trunc(${iv}, (${db(col)} AT TIME ZONE 'Asia/Jakarta'))::date`;
  let inner;
  switch (q.metric) {
    case 'gmv':
      inner = db`SELECT ${bucket('tx.completed_at')} AS b, sum(v.item_price_idr)::bigint AS v, count(*)::int AS n
                   FROM v_completed_transaction_lines v JOIN transactions tx ON tx.id = v.transaction_id
                  WHERE tx.completed_at >= ${f} AND tx.completed_at < ${t} GROUP BY 1`;
      break;
    case 'net_revenue':
      inner = db`SELECT ${bucket('tx.completed_at')} AS b, sum(v.platform_revenue_idr - v.promo_cost_idr)::bigint AS v, count(*)::int AS n
                   FROM v_completed_transaction_lines v JOIN transactions tx ON tx.id = v.transaction_id
                  WHERE tx.completed_at >= ${f} AND tx.completed_at < ${t} GROUP BY 1`;
      break;
    case 'transactions_created':
      inner = db`SELECT ${bucket('created_at')} AS b, count(*)::bigint AS v, count(*)::int AS n FROM transactions
                  WHERE created_at >= ${f} AND created_at < ${t} GROUP BY 1`;
      break;
    case 'transactions_completed':
      inner = db`SELECT ${bucket('completed_at')} AS b, count(*)::bigint AS v, count(*)::int AS n FROM transactions
                  WHERE completed_at >= ${f} AND completed_at < ${t} GROUP BY 1`;
      break;
    case 'payments_secured_idr':
      inner = db`SELECT ${bucket('secured_at')} AS b, sum(amount_idr)::bigint AS v, count(*)::int AS n FROM payments
                  WHERE secured_at >= ${f} AND secured_at < ${t} GROUP BY 1`;
      break;
    case 'signups':
      inner = db`SELECT ${bucket('created_at')} AS b, count(*)::bigint AS v, count(*)::int AS n FROM users
                  WHERE created_at >= ${f} AND created_at < ${t} GROUP BY 1`;
      break;
    case 'disputes_opened':
      inner = db`SELECT ${bucket('created_at')} AS b, count(*)::bigint AS v, count(*)::int AS n FROM disputes
                  WHERE created_at >= ${f} AND created_at < ${t} GROUP BY 1`;
      break;
    case 'refunds_succeeded_idr':
      inner = db`SELECT ${bucket('processed_at')} AS b, sum(amount_idr)::bigint AS v, count(*)::int AS n FROM refunds
                  WHERE status = 'SUCCEEDED' AND processed_at >= ${f} AND processed_at < ${t} GROUP BY 1`;
      break;
  }
  const points = await db<{ bucket: string; value: number; n: number }[]>`
    WITH buckets AS (
      SELECT generate_series(date_trunc(${iv}, ${r.from}::date::timestamp), ${r.to}::date::timestamp, ('1 ' || ${iv})::interval)::date AS b
    ), x AS (${inner})
    SELECT to_char(buckets.b, 'YYYY-MM-DD') AS bucket, coalesce(x.v, 0)::bigint AS value, coalesce(x.n, 0)::int AS n
      FROM buckets LEFT JOIN x ON x.b = buckets.b ORDER BY buckets.b`;
  const sample = points.reduce((s, p) => s + p.n, 0);
  return {
    metric: q.metric,
    interval: q.interval,
    unit: SERIES[q.metric].unit,
    definition: SERIES[q.metric].definition,
    range: { from: r.from, to: r.to, timezone: 'Asia/Jakarta' },
    points: points.map((p) => ({ bucket: p.bucket, value: num(p.value), sampleSize: p.n })),
    sampleSize: sample,
    dataQuality: quality(sample),
  };
}

// ------------------------------------------------------------------ funnel

export async function funnel(deps: AppDeps, q: { from?: string | undefined; to?: string | undefined }) {
  const r = resolveRange(deps.clock.now(), q.from, q.to);
  const db = deps.sql;
  const { fromTs: f, toTs: t } = r;
  const [x] = await db<Record<string, number>[]>`
    SELECT
      (SELECT count(DISTINCT coalesce(user_id::text, anonymous_id)) FROM analytics_events
        WHERE event_name = 'app_install' AND occurred_at >= ${f} AND occurred_at < ${t})::int AS install,
      (SELECT count(*) FROM users WHERE created_at >= ${f} AND created_at < ${t})::int AS signup,
      (SELECT count(*) FROM users WHERE phone_verified_at >= ${f} AND phone_verified_at < ${t})::int AS kyc,
      (SELECT count(*) FROM requests WHERE created_at >= ${f} AND created_at < ${t})::int AS request,
      (SELECT count(DISTINCT transaction_id) FROM transaction_events WHERE to_status = 'MATCHED' AND created_at >= ${f} AND created_at < ${t})::int AS match,
      (SELECT count(DISTINCT transaction_id) FROM transaction_events WHERE to_status = 'AWAITING_PAYMENT' AND created_at >= ${f} AND created_at < ${t})::int AS checkout,
      (SELECT count(DISTINCT transaction_id) FROM transaction_events WHERE to_status = 'PAYMENT_SECURED' AND created_at >= ${f} AND created_at < ${t})::int AS payment,
      (SELECT count(DISTINCT transaction_id) FROM transaction_events WHERE to_status = 'PURCHASED' AND created_at >= ${f} AND created_at < ${t})::int AS purchase,
      (SELECT count(DISTINCT transaction_id) FROM transaction_events WHERE to_status = 'DELIVERED' AND created_at >= ${f} AND created_at < ${t})::int AS delivery,
      (SELECT count(*) FROM (
         SELECT buyer_id, completed_at, row_number() OVER (PARTITION BY buyer_id ORDER BY completed_at) AS rn
           FROM transactions WHERE status = 'COMPLETED') c
        WHERE c.rn = 2 AND c.completed_at >= ${f} AND c.completed_at < ${t})::int AS repeat`;
  const defs: [string, string, string][] = [
    ['INSTALL', 'install', 'Perangkat/pengguna berbeda dengan event klien app_install dalam periode (bergantung pada SDK klien).'],
    ['SIGNUP', 'signup', 'Akun dibuat dalam periode.'],
    ['KYC', 'kyc', 'Akun yang mencapai level 2 (nomor HP terverifikasi, syarat checkout) dalam periode.'],
    ['REQUEST', 'request', 'Request titipan dibuat dalam periode.'],
    ['MATCH', 'match', 'Transaksi yang mencapai MATCHED dalam periode (transaction_events).'],
    ['CHECKOUT', 'checkout', 'Transaksi yang mencapai AWAITING_PAYMENT dalam periode.'],
    ['PAYMENT', 'payment', 'Transaksi yang mencapai PAYMENT_SECURED dalam periode.'],
    ['PURCHASE', 'purchase', 'Transaksi yang mencapai PURCHASED dalam periode.'],
    ['DELIVERY', 'delivery', 'Transaksi yang mencapai DELIVERED dalam periode.'],
    ['REPEAT', 'repeat', 'Pembeli yang transaksi COMPLETED ke-2-nya terjadi dalam periode.'],
  ];
  let prev: number | null = null;
  const steps = defs.map(([step, col, definition]) => {
    const count = x![col] ?? 0;
    const conv = prev === null ? null : prev > 0 ? Math.round((count / prev) * 10000) / 10000 : null;
    prev = count;
    return { step, count, conversionFromPrevious: conv, definition, dataQuality: quality(count) };
  });
  return {
    range: { from: r.from, to: r.to, timezone: 'Asia/Jakarta' },
    method: 'EVENT_COUNTS',
    note: 'Hitungan peristiwa per langkah dalam periode yang sama (bukan kohort); konversi antar langkah adalah rasio kasar, bisa > 1 bila langkah berikut berasal dari periode sebelumnya.',
    steps,
    dataQuality: quality(steps[1]!.count),
  };
}
