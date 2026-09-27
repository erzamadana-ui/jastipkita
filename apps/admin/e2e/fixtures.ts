/**
 * Deterministic API fixtures shaped like the OpenAPI responses / admin service DTOs. Numbers are internally
 * consistent (the 11 price lines add up to TOTAL, every ledger journal balances) — they are sample data for UI
 * tests, not production figures.
 */
export const NOW = new Date('2026-09-27T07:30:00Z');
const iso = (d: Date) => d.toISOString();
const hoursAgo = (h: number) => iso(new Date(NOW.getTime() - h * 3600_000));
const daysAgo = (d: number) => hoursAgo(d * 24);

export const ME_ID = '7d1c2b3a-0f4e-4a51-9c61-6f2d1c0e9a11';
export const OTHER_ADMIN = 'c2b9e0d4-5a3b-4f11-8e61-1f2d1c0e7b22';
export const TX_ID = '0b7f6d7e-5a3b-4a51-9c61-6f2d1c0e9a11';

export const profile = {
  id: ME_ID,
  email: 'rina.ops@jastipkita.id',
  emailVerified: true,
  phone: null,
  phoneVerified: false,
  displayName: 'Rina Prameswari',
  avatarFileId: null,
  locale: 'id',
  countryCode: 'ID',
  status: 'ACTIVE',
  kycLevel: 2,
  activeMode: 'BUYER',
  trustScore: 80,
  referralCode: 'RINA26',
  transactionEmail: null,
  roles: ['SUPER_ADMIN'],
  mfaEnabled: true,
  deletionScheduledFor: null,
  createdAt: '2026-06-02T03:00:00Z',
};

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}
export function jwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.e2e`;
}
export function tokens(mfaAt?: number) {
  const exp = Math.floor(Date.now() / 1000) + 900;
  return {
    tokenType: 'Bearer',
    accessToken: jwt({ sub: ME_ID, exp, sid: 'sess-e2e', ...(mfaAt ? { mfa_at: mfaAt } : {}) }),
    accessTokenExpiresAt: new Date(exp * 1000).toISOString(),
    refreshToken: `rt-${Math.random().toString(36).slice(2)}`,
    refreshTokenExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    sessionId: 'sess-e2e',
  };
}

// ------------------------------------------------------------------ dashboard

const m = (key: string, label: string, value: number | null, unit: string, definition: string, sampleSize: number | null) => ({
  key,
  label,
  value,
  unit,
  definition,
  sampleSize,
  dataQuality: sampleSize === null ? null : sampleSize === 0 ? 'Belum ada data pada periode ini.' : sampleSize < 30 ? `Sampel kecil (n=${sampleSize} < 30); jangan disimpulkan sebagai tren.` : null,
});

export function kpis(from: string, to: string) {
  return {
    range: { from, to, days: 30, timezone: 'Asia/Jakarta' },
    generatedAt: iso(NOW),
    metrics: [
      m('gmv', 'GMV', 412_650_000, 'IDR', 'Σ baris ITEM_PRICE (quote aktif) transaksi COMPLETED dengan completed_at dalam periode (v_completed_transaction_lines).', 64),
      m('completedTransactions', 'Transaksi selesai', 64, 'COUNT', 'Jumlah transaksi dengan completed_at dalam periode.', 64),
      m('platformRevenue', 'Pendapatan platform (quote)', 26_820_000, 'IDR', 'Σ baris quote ber-bucket PLATFORM_REVENUE (platform fee + protection) transaksi COMPLETED dalam periode.', 64),
      m('netRevenue', 'Pendapatan bersih', 23_140_000, 'IDR', 'Pendapatan platform (quote) − biaya promo (DISCOUNT + REFERRAL_CREDIT) transaksi COMPLETED dalam periode.', 64),
      m('takeRate', 'Take rate', 0.064995, 'RATIO', 'Pendapatan platform (quote) ÷ GMV.', 64),
      m('netTakeRate', 'Net take rate', 0.056077, 'RATIO', '(Pendapatan platform − biaya promo) ÷ GMV.', 64),
      m('ledgerPlatformRevenue', 'Pendapatan platform (ledger)', 26_455_300, 'IDR', 'Mutasi bersih akun PLATFORM_REVENUE (IDR) yang diposting dalam periode — angka finance-grade (termasuk fee yang ditahan saat pembatalan).', 158),
      m('transactionsCreated', 'Transaksi dibuat', 141, 'COUNT', 'Transaksi dengan created_at dalam periode.', 141),
      m('usersTotal', 'Total pengguna', 3_482, 'COUNT', 'Akun dengan status selain DELETED (saat ini).', 3482),
      m('usersNew', 'Pengguna baru', 612, 'COUNT', 'Akun dibuat dalam periode.', 612),
      m('usersActive', 'Pengguna aktif', 1_204, 'COUNT', 'Akun dengan last_login_at dalam periode (login terakhir; bukan DAU/MAU).', 1204),
      m('travelersActive', 'Traveler aktif', 57, 'COUNT', 'Traveler berbeda dengan trip ACTIVE/FULL/TRAVELING saat ini.', 57),
      m('tripsActive', 'Trip aktif', 73, 'COUNT', 'Trip berstatus ACTIVE/FULL/TRAVELING saat ini.', 73),
      m('disputeRate', 'Dispute rate', 0.041096, 'RATIO', 'Dispute dibuka dalam periode ÷ transaksi dengan delivered_at dalam periode.', 73),
      m('refundRate', 'Refund rate', 0.078652, 'RATIO', 'Transaksi dengan refund SUCCEEDED (processed_at dalam periode) ÷ transaksi dengan pembayaran SECURED dalam periode.', 89),
      m('refundedIdr', 'Nominal refund', 38_210_500, 'IDR', 'Σ refund SUCCEEDED dengan processed_at dalam periode.', 7),
      m('fraudReviewsOpen', 'Review fraud terbuka', 9, 'COUNT', 'risk_reviews berstatus OPEN/IN_REVIEW (saat ini).', 9),
      m('referralSpend', 'Biaya referral', 3_250_000, 'IDR', 'Σ credit REFERRAL_REWARD yang diberikan dalam periode (kredit, tidak dapat ditarik).', 65),
      m('referralSpendMonthToDate', 'Biaya referral bulan ini', 2_900_000, 'IDR', 'Σ credit REFERRAL_REWARD sejak awal bulan kalender (WIB).', null),
      m('referralMonthlyCapPerReferrer', 'Batas bulanan per referrer', 250_000, 'IDR', 'Config referral.buyer.monthlyCapIdr (batas per referrer per bulan WIB).', null),
      m('referrersAtCap', 'Referrer mencapai batas', 2, 'COUNT', 'Referrer yang total REFERRAL_REWARD bulan ini ≥ batas bulanan.', null),
      m('customsEstimatedIdr', 'Estimasi bea & pajak impor', 18_940_000, 'IDR', 'Σ baris CUSTOMS_DUTY + IMPORT_TAX quote aktif untuk transaksi yang deklarasi bea cukainya dibuat dalam periode.', 12),
      m('customsDeclaredIdr', 'Bea & pajak dibayar (deklarasi)', 20_115_000, 'IDR', 'Σ total_paid_idr customs_declarations (status ≠ REJECTED) dibuat dalam periode.', 12),
      m('customsVarianceRatio', 'Selisih deklarasi vs estimasi', 0.062038, 'RATIO', '(dibayar − estimasi) ÷ estimasi; positif = estimasi terlalu rendah.', 12),
      m('supportBacklog', 'Backlog tiket', 23, 'COUNT', 'Tiket berstatus selain RESOLVED/CLOSED (saat ini).', 23),
      m('supportSlaBreached', 'Tiket lewat SLA', 3, 'COUNT', 'Tiket terbuka tanpa respons pertama dengan sla_due_at sudah lewat.', 23),
    ],
    breakdowns: {
      transactionsByStatus: [
        ['REQUEST_CREATED', 18], ['MATCHED', 11], ['AWAITING_PAYMENT', 9], ['PAYMENT_SECURED', 7], ['PRICE_CHANGE_PENDING', 2], ['PURCHASE_APPROVED', 5], ['PURCHASED', 8],
        ['TRAVELING', 12], ['CUSTOMS_PROCESS', 3], ['READY_FOR_HANDOVER', 4], ['DELIVERED', 6], ['COMPLETED', 214], ['DISPUTED', 3], ['REFUND_PENDING', 2], ['REFUNDED', 17], ['CANCELLED', 41],
      ].map(([status, count]) => ({ status, count })),
      paymentsByChannel: [
        { channel: 'VA', count: 52, amountIdr: 431_220_000 },
        { channel: 'QRIS', count: 21, amountIdr: 96_410_000 },
        { channel: 'EWALLET', count: 11, amountIdr: 58_900_000 },
        { channel: 'CARD', count: 5, amountIdr: 61_750_000 },
      ],
      fraudReviewsBySubject: [
        { subjectType: 'TRANSACTION', count: 4 },
        { subjectType: 'USER', count: 3 },
        { subjectType: 'REFERRAL', count: 2 },
      ],
      supportBacklogByPriority: [
        { priority: 'URGENT', open: 2, slaBreached: 1 },
        { priority: 'HIGH', open: 6, slaBreached: 2 },
        { priority: 'NORMAL', open: 11, slaBreached: 0 },
        { priority: 'LOW', open: 4, slaBreached: 0 },
      ],
    },
    systemHealth: { status: 'OK', outboxBacklog: 3, oldestUnpublishedAgeSec: 14, deadJobs24h: 0, webhookFailures24h: 0, alertsOpen: 2, integrations: INTEGRATIONS },
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

export const INTEGRATIONS = { payments: 'SANDBOX', email: 'LIVE', push: 'MOCK', sms: 'MOCK', storage: 'LIVE', fx: 'LIVE', kyc: 'MANUAL', insurance: 'DISABLED', dbAdmin: 'neon', paymentProviderEnv: 'SANDBOX' };

function rnd(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function timeseries(metric: string, interval: string, from: string, to: string) {
  const idr = ['gmv', 'net_revenue', 'payments_secured_idr', 'refunds_succeeded_idr'].includes(metric);
  const r = rnd(metric.length * 97 + (interval === 'week' ? 7 : 1));
  const points: { bucket: string; value: number; sampleSize: number }[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const step = interval === 'week' ? 7 : 1;
  let i = 0;
  for (let t = start; t <= end; t += step * 86400_000, i++) {
    const trend = 1 + i / 40;
    const weekday = new Date(t).getUTCDay();
    const season = weekday === 0 || weekday === 6 ? 1.25 : 1;
    const n = Math.max(0, Math.round((idr ? 2.2 : 4.5) * trend * season * step * (0.6 + r())));
    const value = idr ? Math.round(n * (metric === 'net_revenue' ? 360_000 : 6_450_000) * (0.8 + r() * 0.4)) : n;
    points.push({ bucket: new Date(t).toISOString().slice(0, 10), value, sampleSize: n });
  }
  const sample = points.reduce((s, p) => s + p.sampleSize, 0);
  return {
    metric,
    interval,
    unit: idr ? 'IDR' : 'COUNT',
    definition: metric === 'gmv' ? 'Σ ITEM_PRICE transaksi COMPLETED per hari/minggu completed_at (WIB).' : `Deret ${metric} per bucket WIB.`,
    range: { from, to, timezone: 'Asia/Jakarta' },
    points,
    sampleSize: sample,
    dataQuality: sample < 30 ? `Sampel kecil (n=${sample} < 30); jangan disimpulkan sebagai tren.` : null,
  };
}

export function funnel(from: string, to: string) {
  const steps = [
    ['INSTALL', 2_140, 'Perangkat/pengguna berbeda dengan event klien app_install dalam periode (bergantung pada SDK klien).'],
    ['SIGNUP', 612, 'Akun dibuat dalam periode.'],
    ['KYC', 388, 'Akun yang mencapai level 2 (nomor HP terverifikasi, syarat checkout) dalam periode.'],
    ['REQUEST', 297, 'Request titipan dibuat dalam periode.'],
    ['MATCH', 158, 'Transaksi yang mencapai MATCHED dalam periode (transaction_events).'],
    ['CHECKOUT', 124, 'Transaksi yang mencapai AWAITING_PAYMENT dalam periode.'],
    ['PAYMENT', 89, 'Transaksi yang mencapai PAYMENT_SECURED dalam periode.'],
    ['PURCHASE', 81, 'Transaksi yang mencapai PURCHASED dalam periode.'],
    ['DELIVERY', 73, 'Transaksi yang mencapai DELIVERED dalam periode.'],
    ['REPEAT', 19, 'Pembeli yang transaksi COMPLETED ke-2-nya terjadi dalam periode.'],
  ] as const;
  let prev: number | null = null;
  return {
    range: { from, to, timezone: 'Asia/Jakarta' },
    method: 'EVENT_COUNTS',
    note: 'Hitungan peristiwa per langkah dalam periode yang sama (bukan kohort).',
    steps: steps.map(([step, count, definition]) => {
      const conv = prev === null ? null : prev > 0 ? Math.round((count / prev) * 10000) / 10000 : null;
      prev = count;
      return { step, count, conversionFromPrevious: conv, definition, dataQuality: count < 30 ? `Sampel kecil (n=${count} < 30); jangan disimpulkan sebagai tren.` : null };
    }),
    dataQuality: null,
  };
}

export const alerts = {
  generatedAt: iso(NOW),
  status: 'OK',
  alerts: [
    { code: 'REFUND_APPROVAL_BACKLOG', severity: 'MEDIUM', value: 2, threshold: 1, message: '2 refund menunggu approval > 24 jam', description: 'Refunds PENDING_APPROVAL for more than 24 hours', firstSeenAt: hoursAgo(5), occurrences: 61, acknowledged: false },
    { code: 'DISPUTE_SLA_BREACHED', severity: 'MEDIUM', value: 1, threshold: 1, message: '1 dispute melewati SLA', description: 'Open disputes with an SLA breach flag', firstSeenAt: hoursAgo(2), occurrences: 24, acknowledged: false },
  ],
  thresholds: {},
};

export const systemHealth = {
  generatedAt: iso(NOW),
  status: 'OK',
  database: { ok: true, latencyMs: 11, schemaVersion: '0060', connections: 14, maxConnections: 104 },
  outbox: { backlog: 3, oldestUnpublishedAgeSec: 14, retryingEvents: 0 },
  jobs: { queued: 5, running: 1, overdue: 0, dead24h: 0, deadTotal: 1, expiredLeases: 0 },
  webhooks: { received24h: 36, failed24h: 0, unprocessedOlderThan10m: 0, invalidSignature24h: 1 },
  refunds: { failed: 0, pendingApproval: 3, pendingApprovalOlderThan24h: 2, processingOlderThan1h: 0 },
  payouts: { failed: 0, onHold: 2, onHoldOlderThan48h: 0, processingOlderThan1h: 0 },
  notifications: { deliveries24h: 812, failed24h: 9, failureRate: 0.0111 },
  security: { highOrCritical24h: 0, critical24h: 0, byType: [] },
  disputes: { slaBreachedOpen: 1 },
  support: { firstResponseBreached: 3 },
  auditChain: { status: 'UP', checkedAt: hoursAgo(6), brokenAtId: null },
  integrations: INTEGRATIONS,
  alertsOpen: 2,
};

// ------------------------------------------------------------------ transactions

const buyer = { id: '4a8e9c1d-7b2f-4c3e-9a10-5d6e7f8a9b01', displayName: 'Dewi A.', kycLevel: 2, trustScore: 74, status: 'ACTIVE' };
const traveler = { id: '9f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f', displayName: 'Bagus P.', kycLevel: 4, trustScore: 91, status: 'ACTIVE' };

const line = (type: string, labelId: string, labelEn: string, amountIdr: number, bucket: string | null, isEstimate = false, ruleRef: string | null = null) => ({ type, labelId, labelEn, amountIdr, bucket, isEstimate, ruleRef });

export const quote = {
  quoteId: 'q-5e6f7a8b',
  transactionId: TX_ID,
  status: 'ACCEPTED',
  createdAt: daysAgo(6),
  expiresAt: daysAgo(5.98),
  currency: 'IDR',
  totalIdr: 8_963_461,
  paymentChannel: 'VA',
  lines: [
    line('ITEM_PRICE', 'Harga Barang', 'Item price', 6_523_770, 'PRODUCT_FUND'),
    line('TRAVELER_FEE', 'Traveler Fee', 'Traveler fee', 450_000, 'TRAVELER_EARNING'),
    line('CUSTOMS_DUTY', 'Bea Masuk', 'Import duty', 489_300, 'CUSTOMS_RESERVE', true, 'customs:ID_PASSENGER_V2025@v3'),
    line('IMPORT_TAX', 'Pajak Impor', 'Import tax', 1_100_200, 'CUSTOMS_RESERVE', true, 'customs:ID_PASSENGER_V2025@v3'),
    line('PROTECTION_FEE', 'JastipKita Protection', 'JastipKita Protection', 97_857, 'PLATFORM_REVENUE', false, 'config:pricing.protection_fee@v1'),
    line('PLATFORM_FEE', 'Platform Fee', 'Platform fee', 326_189, 'PLATFORM_REVENUE', false, 'config:pricing.platform_fee@v2'),
    line('SERVICE_TAX', 'PPN atas layanan', 'VAT on services', 46_645, 'TAX_PAYABLE', false, 'config:pricing.service_tax@v1'),
    line('PAYMENT_FEE', 'Biaya Pembayaran', 'Payment fee', 4_500, 'PAYMENT_FEE', false, 'config:pricing.payment_fees@v1'),
    line('DISCOUNT', 'Diskon promo', 'Promo discount', -50_000, 'PROMOTION_CREDIT', false, 'promo:MUDIK50'),
    line('REFERRAL_CREDIT', 'JastipKita Credit', 'JastipKita Credit', -25_000, 'PROMOTION_CREDIT'),
    line('TOTAL', 'Total Landed Cost', 'Total landed cost', 8_963_461, null),
  ],
  estimateBadges: ['CUSTOMS_DUTY', 'IMPORT_TAX'],
  fx: { base: 'JPY', quote: 'IDR', spotRate: '110.2500000000', markupBps: 150, lockedRate: '111.9037500000', lockedAt: daysAgo(6), expiresAt: daysAgo(5.98) },
  customs: { ruleCode: 'ID_PASSENGER_V2025', dutyIdr: 489_300, importTaxIdr: 1_100_200, isEstimate: true },
  restricted: { classification: 'ALLOWED', requiresAcknowledgement: false },
  promotion: { discountIdr: 50_000, cashbackIdr: 0 },
  credit: { appliedIdr: 25_000, availableIdr: 0, withdrawable: false },
};

const entry = (bucket: string, direction: 'DEBIT' | 'CREDIT', amountIdr: number, ownerUserId: string | null = null, memo: string | null = null) => ({ bucket, ownerUserId, direction, amountIdr, memo });

export const transactionDetail = {
  id: TX_ID,
  number: 'JK-260921-7KQ2MD',
  status: 'TRAVELING',
  version: 9,
  item: { productName: 'Sony WH-1000XM6 (hitam)', categoryCode: 'ELECTRONICS', merchantCountry: 'JP', merchantName: 'Bic Camera Shinjuku', restrictionClass: 'ALLOWED', quantity: 1, unitPriceMinor: 58_300, currency: 'JPY' },
  buyer,
  traveler,
  tripId: '3c2b1a09-8f7e-4d6c-b5a4-938271605f4e',
  totalIdr: 8_963_461,
  securedIdr: 8_963_461,
  payoutHoldReason: null,
  purchaseGate: { allowed: true },
  quote,
  payments: [
    { id: 'pay-1', purpose: 'CHECKOUT', status: 'SECURED', amountIdr: 8_963_461, refundedIdr: 0, channel: 'VA', provider: 'XENDIT', providerEnv: 'TEST', sandbox: true, checkoutUrl: null, expiresAt: daysAgo(5.9), securedAt: daysAgo(5.95), failureReason: null, createdAt: daysAgo(6) },
  ],
  refunds: [],
  payouts: [
    { id: 'po-1', number: 'PO-260921-4TZ8K1', status: 'SCHEDULED', amountIdr: 6_973_770, feeIdr: 0, netIdr: 6_973_770, holdReason: null, heldBy: null, releasedBy: null, scheduledFor: iso(new Date(NOW.getTime() + 5 * 86400_000)), paidAt: null, providerEnv: 'TEST', failureReason: null, attempts: 0, destination: { bankCode: 'BCA', accountMask: '****0961' } },
  ],
  ledger: {
    balanced: true,
    escrow: [
      { bucket: 'CLEARING', netCreditIdr: 0 },
      { bucket: 'CUSTOMS_RESERVE', netCreditIdr: 1_589_500 },
      { bucket: 'PAYMENT_FEE', netCreditIdr: 4_500 },
      { bucket: 'PLATFORM_REVENUE', netCreditIdr: 424_046 },
      { bucket: 'PRODUCT_FUND', netCreditIdr: 6_523_770 },
      { bucket: 'PROMOTION_CREDIT', netCreditIdr: -75_000 },
      { bucket: 'TAX_PAYABLE', netCreditIdr: 46_645 },
      { bucket: 'TRAVELER_EARNING', netCreditIdr: 450_000 },
    ],
    journals: [
      {
        id: 'j-1', seq: 1, kind: 'PAYMENT_CAPTURE', description: 'Capture VA XENDIT (TEST)', idempotencyKey: 'payment:pay-1:capture', postedAt: daysAgo(5.95), refundId: null, payoutId: null, paymentId: 'pay-1',
        entries: [entry('PROVIDER_CASH', 'DEBIT', 8_963_461, null, 'VA BCA'), entry('CLEARING', 'CREDIT', 8_963_461)],
      },
      {
        id: 'j-2', seq: 2, kind: 'ESCROW_ALLOCATION', description: 'Alokasi ke bucket sesuai quote q-5e6f7a8b', idempotencyKey: 'tx:0b7f6d7e:allocate:v1', postedAt: daysAgo(5.95), refundId: null, payoutId: null, paymentId: 'pay-1',
        entries: [
          entry('CLEARING', 'DEBIT', 8_963_461),
          entry('PROMOTION_CREDIT', 'DEBIT', 75_000, null, 'MUDIK50 + credit'),
          entry('PRODUCT_FUND', 'CREDIT', 6_523_770),
          entry('TRAVELER_EARNING', 'CREDIT', 450_000, traveler.id),
          entry('CUSTOMS_RESERVE', 'CREDIT', 1_589_500),
          entry('PLATFORM_REVENUE', 'CREDIT', 424_046),
          entry('TAX_PAYABLE', 'CREDIT', 46_645),
          entry('PAYMENT_FEE', 'CREDIT', 4_500),
        ],
      },
    ],
  },
  priceConfirmations: [],
  purchaseProofs: [{ id: 'pp-1', status: 'ACCEPTED', merchantName: 'Bic Camera Shinjuku', actualPriceMinor: 58_300, currency: 'JPY', fraudReasons: [], createdAt: daysAgo(4) }],
  delivery: { id: 'del-1', method: 'MEETUP', status: 'SCHEDULED', courierName: null, trackingNumber: null, addressCity: 'Jakarta Selatan', meetupPoint: 'Stasiun MRT Blok M', scheduledAt: iso(new Date(NOW.getTime() + 2 * 86400_000)), confirmedAt: null, confirmedVia: null, proofFileIds: [], pin: { locked: false, attemptsRemaining: 5 } },
  disputes: [],
  conversationId: 'conv-1',
  events: [
    { from: null, to: 'REQUEST_CREATED', actorType: 'BUYER', actorId: buyer.id, reason: null, at: daysAgo(7) },
    { from: 'REQUEST_CREATED', to: 'MATCHED', actorType: 'BUYER', actorId: buyer.id, reason: 'offer accepted', at: daysAgo(6.2) },
    { from: 'MATCHED', to: 'AWAITING_PAYMENT', actorType: 'SYSTEM', actorId: null, reason: 'checkout', at: daysAgo(6) },
    { from: 'AWAITING_PAYMENT', to: 'PAYMENT_SECURED', actorType: 'WEBHOOK', actorId: null, reason: 'xendit va paid', at: daysAgo(5.95) },
    { from: 'PAYMENT_SECURED', to: 'PURCHASE_APPROVED', actorType: 'SYSTEM', actorId: null, reason: 'price within tolerance', at: daysAgo(5.9) },
    { from: 'PURCHASE_APPROVED', to: 'PURCHASED', actorType: 'TRAVELER', actorId: traveler.id, reason: null, at: daysAgo(4) },
    { from: 'PURCHASED', to: 'TRAVELING', actorType: 'TRAVELER', actorId: traveler.id, reason: 'JL 725 NRT → CGK', at: daysAgo(1) },
  ],
  adminAllowedTransitions: ['REFUND_PENDING'],
  createdAt: daysAgo(7),
  updatedAt: daysAgo(1),
};

const products = ['Sony WH-1000XM6 (hitam)', 'Uniqlo U Oversized Coat', 'Hario V60 Craft Coffee Kit', 'Nintendo Switch 2 (JP)', 'Shiseido Ultimune 75 ml', 'Pokémon TCG 151 Booster Box', 'Tokyo Banana 12 pcs', 'Muji Aroma Diffuser', 'Olive Young Mask Set', 'Longchamp Le Pliage M', 'KitKat Matcha 13 pcs', 'Apple AirPods Pro 3 (US)'];
const statuses = ['TRAVELING', 'PAYMENT_SECURED', 'AWAITING_PAYMENT', 'COMPLETED', 'DISPUTED', 'CUSTOMS_PROCESS', 'MATCHED', 'REFUND_PENDING', 'PURCHASED', 'DELIVERED', 'COMPLETED', 'CANCELLED'];
export const transactions = {
  data: products.map((p, i) => ({
    id: i === 0 ? TX_ID : `${(i + 10).toString(16).padStart(8, '0')}-5a3b-4a51-9c61-6f2d1c0e9a${String(i).padStart(2, '0')}`,
    number: i === 0 ? 'JK-260921-7KQ2MD' : `JK-2609${String(26 - i).padStart(2, '0')}-${['A4F9QX', 'M2K8TR', 'Z7Q1HD', 'P3N6WC', 'H8D2LS', 'V5R7YB', 'C1T4GM', 'K9W3EF', 'B6J8NU', 'X2L5QA', 'D7S1ZP'][i - 1]}`,
    status: statuses[i],
    buyer: { id: buyer.id, displayName: ['Dewi A.', 'Andi S.', 'Maya R.', 'Fikri H.', 'Sari W.', 'Yoga P.'][i % 6] },
    traveler: i === 6 ? { id: traveler.id, displayName: 'Bagus P.' } : { id: traveler.id, displayName: ['Bagus P.', 'Clara T.', 'Hendra K.'][i % 3] },
    productName: p,
    categoryCode: 'ELECTRONICS',
    totalIdr: [8_963_461, 3_210_000, 1_145_500, 6_880_000, 2_402_900, 1_918_000, 540_000, 1_020_300, 895_000, 3_870_000, 402_500, 4_615_000][i],
    securedIdr: ['AWAITING_PAYMENT', 'MATCHED', 'CANCELLED'].includes(statuses[i]!) ? 0 : [8_963_461, 3_210_000, 0, 6_880_000, 2_402_900, 1_918_000, 0, 1_020_300, 895_000, 3_870_000, 402_500, 0][i],
    payoutHoldReason: i === 4 ? 'DISPUTE_OPEN' : null,
    openDispute: statuses[i] === 'DISPUTED',
    statusChangedAt: hoursAgo(i * 7 + 3),
    createdAt: hoursAgo(i * 19 + 30),
  })),
  nextCursor: 'eyJ0IjoiMjAyNi0wOS0xNSJ9',
};

// ------------------------------------------------------------------ refunds

const refund = (id: string, number: string, tx: string, amount: number, requestedBy: string, waiting: number, note: string) => ({
  id,
  number,
  transactionId: TX_ID,
  transactionNumber: tx,
  transactionStatus: 'REFUND_PENDING',
  paymentId: 'pay-1',
  channel: 'VA',
  sandbox: true,
  reasonCode: 'ADMIN',
  reasonNote: note,
  amountIdr: amount,
  type: 'FULL',
  status: 'PENDING_APPROVAL',
  method: 'PROVIDER_REFUND',
  requestedBy,
  approvedBy: null,
  canApprove: requestedBy !== ME_ID,
  failureReason: null,
  attempts: 0,
  waitingHours: waiting,
  createdAt: hoursAgo(waiting),
});

export function refunds(approved: Set<string>) {
  return {
    data: [
      refund('rf-1', 'RFD-260926-8F3K2Q', 'JK-260919-M2K8TR', 12_450_000, OTHER_ADMIN, 30.5, 'Traveler batal berangkat; dana penuh dikembalikan'),
      refund('rf-2', 'RFD-260925-2MWX9A', 'JK-260918-Z7Q1HD', 10_800_000, ME_ID, 26.1, 'Barang tidak tersedia di toko'),
      refund('rf-3', 'RFD-260927-Q7N4TD', 'JK-260917-P3N6WC', 15_200_000, OTHER_ADMIN, 3.2, 'Harga aktual melebihi toleransi, penitip menolak'),
    ].filter((r) => !approved.has(r.id)),
    nextCursor: null,
  };
}

// ------------------------------------------------------------------ config

const cfg = (version: number, status: string, value: unknown, createdBy: string | null, extra: Record<string, unknown> = {}) => ({
  id: `cfg-platform-fee-v${version}`,
  key: 'pricing.platform_fee',
  version,
  value,
  status,
  effectiveFrom: daysAgo(40 - version * 10),
  changeReason: version === 1 ? 'Seed default (business-config.defaults.json)' : version === 2 ? 'Batas bawah Rp 10.000 agar item murah tetap menutup biaya operasional' : 'Kampanye Q4: turunkan platform fee 5% → 4,5% dan batas atas Rp 600.000',
  isAssumption: version === 3,
  notes: null,
  createdBy,
  approvedBy: status === 'ACTIVE' || status === 'SUPERSEDED' ? OTHER_ADMIN : null,
  approvedAt: status === 'ACTIVE' || status === 'SUPERSEDED' ? daysAgo(40 - version * 10) : null,
  rejectedReason: null,
  supersededAt: status === 'SUPERSEDED' ? daysAgo(20) : null,
  createdAt: daysAgo(41 - version * 10),
  ...extra,
});

export const configState = { approved: false };

export function configDetail() {
  const v1 = { rateBps: 500, minIdr: 5000, maxIdr: 750000 };
  const v2 = { rateBps: 500, minIdr: 10000, maxIdr: 750000 };
  const v3 = { rateBps: 450, minIdr: 10000, maxIdr: 600000 };
  if (configState.approved) {
    return { key: 'pricing.platform_fee', active: cfg(3, 'ACTIVE', v3, OTHER_ADMIN), history: [cfg(3, 'ACTIVE', v3, OTHER_ADMIN, { diffFromActive: [] }), cfg(2, 'SUPERSEDED', v2, 'seed', { diffFromActive: [] }), cfg(1, 'SUPERSEDED', v1, 'seed', { diffFromActive: [] })] };
  }
  return {
    key: 'pricing.platform_fee',
    active: cfg(2, 'ACTIVE', v2, 'seed'),
    history: [
      cfg(3, 'PENDING_APPROVAL', v3, OTHER_ADMIN, {
        diffFromActive: [
          { path: 'maxIdr', op: 'changed', before: 750000, after: 600000 },
          { path: 'rateBps', op: 'changed', before: 500, after: 450 },
        ],
      }),
      cfg(2, 'ACTIVE', v2, 'seed', { diffFromActive: [] }),
      cfg(1, 'SUPERSEDED', v1, null, { diffFromActive: [{ path: 'minIdr', op: 'changed', before: 10000, after: 5000 }] }),
    ],
  };
}

export function configDiff(version: number, against?: number) {
  const vals: Record<number, Record<string, number>> = { 1: { rateBps: 500, minIdr: 5000, maxIdr: 750000 }, 2: { rateBps: 500, minIdr: 10000, maxIdr: 750000 }, 3: { rateBps: 450, minIdr: 10000, maxIdr: 600000 } };
  const base = against ?? 2;
  const a = vals[base]!;
  const b = vals[version]!;
  const changes = Object.keys(a)
    .sort()
    .filter((k) => a[k] !== b[k])
    .map((k) => ({ path: k, op: 'changed', before: a[k], after: b[k] }));
  return { key: 'pricing.platform_fee', from: { version: base, status: base === 2 ? 'ACTIVE' : 'SUPERSEDED' }, to: { version, status: version === 3 ? 'PENDING_APPROVAL' : version === 2 ? 'ACTIVE' : 'SUPERSEDED' }, changes };
}

const KEYS = ['pricing.platform_fee', 'pricing.protection_fee', 'pricing.service_tax', 'pricing.fx_markup', 'pricing.payment_fees', 'pricing.traveler_fee_bounds', 'pricing.minimum_transaction', 'fx.lock', 'price_confirmation', 'delivery', 'dispute.sla', 'referral.buyer', 'referral.traveler', 'limits.transaction', 'risk.thresholds', 'matching.weights', 'trust.weights', 'trips', 'cancellation.matrix', 'money.policy', 'marketplace.lifetimes', 'support.sla'];
export function configList() {
  return {
    data: KEYS.map((key, i) => ({
      key,
      active: { ...cfg(i === 0 ? 2 : 1, 'ACTIVE', {}, 'seed'), key, changeReason: i === 0 ? 'Batas bawah Rp 10.000 agar item murah tetap menutup biaya operasional' : 'Seed default (business-config.defaults.json)', isAssumption: [2, 11, 13, 19].includes(i) },
      latestVersion: i === 0 ? 3 : 1,
      pendingApprovals: i === 0 && !configState.approved ? 1 : 0,
      isAssumption: [2, 11, 13, 19].includes(i),
    })),
    assumptions: ['pricing.service_tax: perlakuan PPN atas layanan menunggu konfirmasi konsultan pajak', 'referral.buyer: nominal & batas bulanan menunggu uji unit economics', 'limits.transaction: batas per level KYC menunggu review compliance', 'money.policy: batas auto-approve refund Rp 10.000.000'],
  };
}

// ------------------------------------------------------------------ DB & infra

export const dbHealth = {
  checkedAt: iso(NOW),
  provider: { dbProvider: 'neon', adminProvider: 'neon' },
  target: { host: 'ep***.neon.tech', port: '5432', database: 'ja***', ssl: true },
  server: { version: '17.5', versionString: 'PostgreSQL 17.5 on x86_64-pc-linux-gnu', timezone: 'UTC', startedAt: daysAgo(3), inRecovery: false },
  latencyMs: 11,
  sizeBytes: 486_539_264,
  connections: { total: 14, max: 104, reservedSuperuser: 3, utilization: 0.1346, byState: [{ state: 'active', count: 2 }, { state: 'idle', count: 11 }, { state: 'idle in transaction', count: 1 }] },
  cacheHitRatio: 0.9971,
  transactions: { commits: 1_284_551, rollbacks: 2_311, deadlocks: 0, tempBytes: 0 },
  longRunningQueries: { thresholdSec: 30, count: 0 },
  replication: { walSenders: 0, walReceiverStatus: null, isReplica: false },
  dataQuality: null,
};

export const provider = {
  provider: 'neon',
  dbProvider: 'neon',
  capabilities: { backups: true, pitr: true, branching: true, replicationInfo: false },
  info: { projectId: 'np***', region: 'aws-ap-southeast-1', branch: 'main', pgVersion: 17, historyRetentionSeconds: 86400 },
  target: dbHealth.target,
  backupsManagedOutsideApp: false,
  credentials: 'Tidak pernah ditampilkan atau dapat diubah dari admin UI (secret store / env server).',
};

const MANIFEST: [string, string, string][] = [
  ['0001', 'foundation', '166bd7898c72612c278e8d771fbc16f789bf8e31afa453e584d96b244de3a6a7'],
  ['0002', 'reference', 'a1dfc2852d33ac654424b87505f2eae60e586e256f4474a2b2e315c6e0ba53bc'],
  ['0003', 'identity_access', 'f569580e436b5d53271333d421640cdeccc7851874c383b2afe40ddabaec0643'],
  ['0004', 'audit_outbox_jobs', 'aaacac803f1ca1b4e86e3399b2d1649174b894facdfd4c266f8a4d91f9e85c55'],
  ['0005', 'config_rules', '9cc306b984061369ef69606fc333dcacbdf5b129c3e3253854f4765db74889ad'],
  ['0006', 'kyc', 'c5a114cce82353f348d9b330750d7d312d0d9d68df83d85a9ae13f39fe5167ea'],
  ['0007', 'trips_requests', '17cd7a0a757204415e54013d6f55143621d6d63393247289ca47e828dc1f28c0'],
  ['0008', 'transactions', '55a8f95875ba7e5fbf252f6ab8a90a8ef7d587471960bb4bc69d12a804638a51'],
  ['0009', 'payments_ledger', '1195f7a2501eb1d82a3306ee5c27d1345ac288ca83aa854bbba19809d3288520'],
  ['0010', 'growth', 'c0bbbbae03571a29651ee05aae34ee0da9f5063ae959f1a8d52b8f880931603d'],
  ['0011', 'trust_risk', '3834a0c6554722278e55a026ef3d1a03876464669b159f4a56d046f79da0b946'],
  ['0012', 'communication', '9e338750796cbd61c182da4fbd6f3b826cb6d52da56502967f512ffd37582282'],
  ['0013', 'disputes_support', 'e82b4f7ff26988a65818f60888d3543b7b03930c77a0bce6a503e195a46aa843'],
  ['0014', 'privacy_ops', 'b303f8055f1516759a2622e3c33d400d0da86341572090691900ccfd2dbf6e56'],
  ['0015', 'analytics_views', 'c1643ac26eaba80e6a510d56f351d65cbbade62c6b4a8fe168f08e7b83cf2a7a'],
  ['0016', 'roles_grants', 'ed1de053c61b742c21d69e8575561df7029180ebf500760119fee070c1c3dd76'],
  ['0017', 'spec_alignment', '2f0a6e8b256bca624577dbf581862e2b143cba8d871142c8c2af394362051097'],
  ['0018', 'outbox_handler_runs', 'e1efd27faf8a99bdc337d9d30453ae584780923a72f095d28e397b8a0f5ac5b4'],
  ['0020', 'identity_runtime', '1935290c384396a468792468ec06b170ed87c22e1181f8e20bc1924faf89739c'],
  ['0030', 'marketplace_capacity', 'a7e542fcd20b4125624c6244e7c94b1b3f2e891bc56936baa5be647d96de448f'],
  ['0040', 'money', '5c7c3234bfecfaac275b81f802243daf07624321a07d9fd676de486ebf7c5827'],
  ['0050', 'engagement', '7e9e94d19f651f15b6b8e9066703a1a25fd10eb84cea78aad75f86be7a3b82b8'],
  ['0060', 'admin', '85b9ca778a381d3b9f55499d08ca819f9f75ad547050d384ae44109b6afed3fb'],
  ['0070', 'legal_public_documents', 'c76428f49f7d550e0191aa6a03172842e0fdb0e0da99306bf4d874a07bbbe14f'],
];
export const migrations = {
  schemaVersion: '0060',
  buildVersion: '0070',
  summary: { applied: 23, pending: 1, checksumDrift: 0, unknownInBuild: 0 },
  inSync: false,
  migrations: MANIFEST.map(([version, name, checksum], i) => {
    const applied = version !== '0070';
    return { version, name, status: applied ? 'APPLIED' : 'PENDING', fileChecksum: checksum, appliedChecksum: applied ? checksum : null, appliedAt: applied ? daysAgo(60 - i * 2.4) : null, executionMs: applied ? 180 + ((i * 137) % 900) : null, appliedBy: applied ? 'jk_***' : null };
  }),
  note: 'Migrasi dijalankan dari CI (db/scripts/migrate.sh), bukan dari admin UI. CHECKSUM_DRIFT = file migrasi yang sudah diterapkan berubah (dilarang; buat migrasi baru).',
};

export const storage = {
  databaseBytes: 486_539_264,
  tables: [
    ['audit_logs', 98_304_000, 71_000_000, 27_304_000, 412_880],
    ['analytics_events', 81_920_000, 60_000_000, 21_920_000, 988_214],
    ['ledger_entries', 44_236_800, 30_000_000, 14_236_800, 181_442],
    ['messages', 30_310_400, 22_000_000, 8_310_400, 96_310],
    ['outbox_events', 22_118_400, 17_000_000, 5_118_400, 64_022],
    ['transaction_events', 15_564_800, 10_000_000, 5_564_800, 51_880],
    ['notification_deliveries', 12_288_000, 9_000_000, 3_288_000, 44_120],
    ['security_events', 9_011_200, 6_500_000, 2_511_200, 23_551],
  ].map(([table, totalBytes, tableBytes, indexBytes, estimatedRows]) => ({ table, totalBytes, tableBytes, indexBytes, estimatedRows, seqScans: 12, indexScans: 48_000 })),
  definition: 'pg_total_relation_size (tabel + indeks + TOAST); jumlah baris = estimasi n_live_tup.',
};

export const backups = {
  provider: 'neon',
  managedOutsideApp: false,
  backups: [
    { id: 'br-nightly-260927', createdAt: hoursAgo(7), kind: 'BRANCH', sizeBytes: 486_000_000, status: 'READY' },
    { id: 'br-pre-0060', createdAt: daysAgo(12), kind: 'BRANCH', sizeBytes: 451_000_000, status: 'READY' },
  ],
  error: null,
  operations: [],
};

const WORKFLOW_ID = 'op-mig-0070';
const step = (stepNo: number, stepName: string, status: string, checklist: [string, string][], extra: Record<string, unknown> = {}) => ({
  stepNo,
  step: stepName,
  status,
  checklist: checklist.map(([key, label]) => ({ key, label, done: status === 'DONE' })),
  requiresApproval: stepName === 'SWITCH' || stepName === 'ROLLBACK',
  notes: null,
  evidence: {},
  completedBy: status === 'DONE' ? OTHER_ADMIN : null,
  completedAt: status === 'DONE' ? hoursAgo(9 - stepNo) : null,
  approvedBy: null,
  approvedAt: null,
  ...extra,
});

export const workflow = {
  id: WORKFLOW_ID,
  type: 'MIGRATION',
  status: 'RUNNING',
  environment: 'STAGING',
  provider: 'neon',
  requestedBy: OTHER_ADMIN,
  approvedBy: ME_ID,
  approvedAt: hoursAgo(10),
  reason: 'Rilis dokumen legal publik (GET /v1/legal/documents)',
  params: { targetVersion: '0070', description: 'legal_public_documents', ciRunUrl: 'https://github.com/erzamadana-ui/jastipkita/actions/runs/1', executedBy: 'CI' },
  result: null,
  error: null,
  startedAt: hoursAgo(9),
  finishedAt: null,
  createdAt: hoursAgo(11),
  updatedAt: hoursAgo(7),
  steps: [
    step(1, 'PRE_CHECK', 'DONE', [['reviewed_ci_green', 'Migrasi sudah direview dan lolos CI (bash db/scripts/test-db.sh)'], ['no_checksum_drift', 'Tidak ada checksum drift (GET /v1/admin/infra/db/migrations)'], ['window_announced', 'Jendela maintenance & komunikasi ke tim disetujui'], ['rollback_plan', 'Rencana rollback (migrasi kompensasi / restore ke branch baru) terdokumentasi']], { evidence: { ci: 'actions/runs/1' } }),
    step(2, 'BACKUP', 'DONE', [['backup_taken', 'Backup/branch dibuat tepat sebelum migrasi'], ['backup_id_recorded', 'ID backup/branch dicatat di evidence']], { evidence: { branch: 'br-pre-0070' } }),
    step(3, 'SCHEMA_MIGRATION', 'PENDING', [['ran_from_ci', 'db/scripts/migrate.sh dijalankan dari pipeline CI (bukan dari admin UI)'], ['verify_passed', 'migrate.sh --verify lulus']]),
    step(4, 'DATA_MIGRATION', 'PENDING', [['backfill_done', 'Backfill/data job selesai (atau tidak diperlukan)'], ['row_counts_checked', 'Jumlah baris / invarian data diperiksa']]),
    step(5, 'VALIDATION', 'PENDING', [['smoke_green', 'Smoke test API hijau (GET /v1/health)'], ['audit_chain_ok', 'verify_audit_chain() OK'], ['ledger_ok', 'Ledger seimbang, tidak ada error JKL0x']]),
    step(6, 'SWITCH', 'PENDING', [['traffic_switched', 'Aplikasi/traffic dialihkan ke versi baru'], ['flags_enabled', 'Feature flag terkait diaktifkan (bila ada)']]),
    step(7, 'MONITORING', 'PENDING', [['errors_normal', 'Error rate & latensi normal minimal 30 menit'], ['no_new_alerts', 'Tidak ada alert HIGH/CRITICAL baru (GET /v1/admin/system/alerts)']]),
    step(8, 'ROLLBACK', 'PENDING', [['compensation_applied', 'Migrasi kompensasi atau restore ke branch baru dijalankan'], ['app_reverted', 'Aplikasi kembali ke versi sebelumnya dan sehat'], ['incident_logged', 'Insiden dicatat (penyebab, dampak, tindak lanjut)']]),
  ],
};

export const operations = {
  data: [
    { ...workflow, steps: undefined },
    { id: 'op-bk-1', type: 'BACKUP', status: 'SUCCEEDED', environment: 'STAGING', provider: 'neon', requestedBy: OTHER_ADMIN, approvedBy: null, approvedAt: null, reason: 'Sebelum migrasi 0070', params: { label: 'pre-0070' }, result: { backupId: 'br-pre-0070' }, error: null, startedAt: hoursAgo(8.5), finishedAt: hoursAgo(8.4), createdAt: hoursAgo(8.5), updatedAt: hoursAgo(8.4) },
    { id: 'op-ct-1', type: 'CONNECTION_TEST', status: 'SUCCEEDED', environment: 'STAGING', provider: 'neon', requestedBy: ME_ID, approvedBy: null, approvedAt: null, reason: 'connection test', params: {}, result: { ok: true, avgMs: 9 }, error: null, startedAt: daysAgo(1), finishedAt: daysAgo(1), createdAt: daysAgo(1), updatedAt: daysAgo(1) },
  ],
  nextCursor: null,
};
