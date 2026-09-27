#!/usr/bin/env node
// Generates db/seeds/0001_reference.sql from:
//   packages/core/src/config/{currencies,countries,product-categories,business-config.defaults}.json
//   docs/00-domain-model.md — state machines are PARSED from the markdown tables:
//     §4 transaction, §15.1 trip, §15.2 price confirmation, §15.3 dispute, §15.4 KYC,
//     §15.5 payment, §15.6 refund, §15.7 payout  (the doc is the source of truth)
//   §15.8 quote & FX lock are prose in the doc and hard-coded below.
// plus static reference data declared below (RBAC, ledger system accounts, FAQ, retention policies).
//
// Usage:  node db/scripts/gen-reference-seed.mjs          # (re)write the seed file
//         node db/scripts/gen-reference-seed.mjs --check  # exit 1 if the committed file differs from
//                                                         # what the current doc/JSON produce (CI drift check)
// Plain Node >= 18, no dependencies. Output is deterministic (no timestamps).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG = join(ROOT, 'packages', 'core', 'src', 'config');
const OUT = join(ROOT, 'db', 'seeds', '0001_reference.sql');

const readJson = (f) => JSON.parse(readFileSync(join(CONFIG, f), 'utf8'));

// ---------------------------------------------------------------- SQL helpers
const q = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`non-finite number ${v}`);
    return String(v);
  }
  return `'${String(v).replace(/'/g, "''")}'`;
};
const qArr = (arr) => `ARRAY[${arr.map(q).join(', ')}]::text[]`;
const qJson = (obj) => `${q(JSON.stringify(obj))}::jsonb`;
const rows = (list) => list.map((r) => `  (${r.join(', ')})`).join(',\n');

// ------------------------------------------------------------- JSON sources
const currencies = readJson('currencies.json');
const countries = readJson('countries.json');
const categories = readJson('product-categories.json');
const businessConfig = readJson('business-config.defaults.json');

// --------------------------------------------- state machines from the doc
const DOMAIN_MD = readFileSync(join(ROOT, 'docs', '00-domain-model.md'), 'utf8');

// Statuses/actors each DB table accepts (mirror of the CHECK constraints in db/migrations).
// A status in the doc that is missing here means: write a migration first, then extend this map.
const ALL_ACTORS = ['BUYER', 'TRAVELER', 'SYSTEM', 'ADMIN'];
const MACHINES = {
  TRANSACTION: { heading: '## 4.', min: 30, actors: ALL_ACTORS, statuses: [
    'REQUEST_CREATED', 'MATCHED', 'AWAITING_PAYMENT', 'PAYMENT_SECURED', 'PRICE_CHANGE_PENDING', 'PURCHASE_APPROVED',
    'PURCHASED', 'TRAVELING', 'ARRIVED', 'CUSTOMS_PROCESS', 'READY_FOR_HANDOVER', 'OUT_FOR_DELIVERY', 'DELIVERED',
    'BUYER_CONFIRMED', 'COMPLETED', 'CANCELLED', 'DISPUTED', 'REFUND_PENDING', 'REFUNDED'] },
  TRIP: { heading: '### 15.1', min: 10, actors: ['TRAVELER', 'SYSTEM', 'ADMIN'], statuses: [
    'DRAFT', 'VERIFICATION_PENDING', 'VERIFIED', 'ACTIVE', 'FULL', 'TRAVELING', 'COMPLETED', 'CANCELLED'] },
  PRICE_CONFIRMATION: { heading: '### 15.2', min: 5, actors: ALL_ACTORS, statuses: [
    'PENDING', 'APPROVED', 'REJECTED', 'CLARIFICATION_REQUESTED', 'EXPIRED'] },
  DISPUTE: { heading: '### 15.3', min: 8, actors: ALL_ACTORS, statuses: [
    'OPEN', 'EVIDENCE_COLLECTION', 'UNDER_REVIEW', 'RESOLVED', 'APPEALED', 'CLOSED'] },
  KYC: { heading: '### 15.4', min: 4, actors: ALL_ACTORS, statuses: ['PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED'] },
  PAYMENT: { heading: '### 15.5', min: 6, actors: ALL_ACTORS, statuses: [
    'PENDING', 'SECURED', 'EXPIRED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'] },
  REFUND: { heading: '### 15.6', min: 10, actors: ALL_ACTORS, statuses: [
    'REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REJECTED', 'CANCELLED'] },
  PAYOUT: { heading: '### 15.7', min: 8, actors: ALL_ACTORS, statuses: [
    'SCHEDULED', 'ON_HOLD', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED'] },
};

// Parses a "| Dari | Ke | Aktor | Guard |" table under the heading that starts with `heading`,
// up to the next markdown heading. Supports "{A, B, C}" multi-source cells.
function parseFsm(name, { heading, min, actors: allowedActors, statuses }) {
  const lines = DOMAIN_MD.split('\n');
  const at = lines.findIndex((l) => l.startsWith(heading));
  if (at < 0) throw new Error(`docs/00-domain-model.md: heading "${heading}" (${name}) not found`);
  const out = [];
  for (let i = at + 1; i < lines.length && !lines[i].startsWith('#'); i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4 || cells[0] === 'Dari' || /^[-: ]+$/.test(cells[0])) continue;
    const froms = cells[0].startsWith('{') ? cells[0].replace(/[{}]/g, '').split(',').map((x) => x.trim()) : [cells[0]];
    const to = cells[1];
    const actors = cells[2].split(',').map((x) => x.trim()).filter(Boolean);
    const guard = cells.slice(3).join(' | ').replace(/`/g, '').trim();
    for (const st of [...froms, to]) {
      if (!statuses.includes(st)) throw new Error(`${name} (${heading}): status "${st}" is not accepted by the DB — add a migration first`);
    }
    for (const a of actors) {
      if (!allowedActors.includes(a)) throw new Error(`${name} (${heading}): actor "${a}" not allowed (${allowedActors.join(',')})`);
    }
    if (actors.length === 0) throw new Error(`${name} (${heading}): row "${line}" has no actors`);
    for (const from of froms) out.push({ from, to, actors, guard: guard === '—' || guard === '' ? null : guard });
  }
  if (out.length < min) throw new Error(`${name}: parsed only ${out.length} transitions under "${heading}" — table format changed?`);
  const seen = new Set();
  for (const t of out) {
    const k = `${t.from}->${t.to}`;
    if (t.from === t.to) throw new Error(`${name}: self-transition ${k}`);
    if (seen.has(k)) throw new Error(`${name}: duplicate transition ${k}`);
    seen.add(k);
  }
  return out;
}
const fsm = Object.fromEntries(Object.entries(MACHINES).map(([n, m]) => [n, parseFsm(n, m)]));
const txTransitions = fsm.TRANSACTION;

// §15.8 (prose): Quote ACTIVE → ACCEPTED | EXPIRED | SUPERSEDED, ACCEPTED → SUPERSEDED; FX lock ACTIVE → CONSUMED | EXPIRED (SYSTEM)
const SEC_15_8 = {
  QUOTE: [['ACTIVE', 'ACCEPTED'], ['ACTIVE', 'EXPIRED'], ['ACTIVE', 'SUPERSEDED'], ['ACCEPTED', 'SUPERSEDED']],
  FX_LOCK: [['ACTIVE', 'CONSUMED'], ['ACTIVE', 'EXPIRED']],
};
if (!/### 15\.8/.test(DOMAIN_MD)) throw new Error('docs/00-domain-model.md: §15.8 Quote & FX lock not found');

// Secondary machines stored in status_transitions(machine, from, to, actor_types, note)
const statusTransitions = {
  ...Object.fromEntries(['PRICE_CONFIRMATION', 'KYC', 'PAYMENT', 'REFUND', 'PAYOUT'].map((m) => [m, fsm[m]])),
  ...Object.fromEntries(Object.entries(SEC_15_8).map(([m, list]) =>
    [m, list.map(([from, to]) => ({ from, to, actors: ['SYSTEM'], guard: '§15.8' }))])),
};

// ------------------------------------------------------------ static: RBAC
const roles = [
  ['SUPER_ADMIN', 'Super Admin', 'All permissions except approving settlement account changes'],
  ['OPERATIONS', 'Operations', 'KYC & trip verification, transaction operations, disputes'],
  ['FINANCE', 'Finance', 'Refunds, payouts, finance reports, settlement change requests'],
  ['FINANCE_SUPER_ADMIN', 'Finance Super Admin', 'Finance + approves settlement account changes and config'],
  ['RISK', 'Risk', 'Fraud review, suspensions, trust score override requests'],
  ['SUPPORT', 'Support', 'Tickets, chat moderation, refund requests'],
  ['MARKETING', 'Marketing', 'Promotions, referrals, FAQ'],
  ['COMPLIANCE', 'Compliance', 'Customs & restricted item rules, legal documents, audit'],
];
const permissions = [
  ['users.read', 'View user profiles (masked PII)', false],
  ['users.suspend', 'Suspend / reactivate users', true],
  ['kyc.review', 'Review KYC submissions', true],
  ['trips.verify', 'Verify trip travel documents', false],
  ['transactions.read', 'View transactions', false],
  ['transactions.override', 'Force transaction transitions as ADMIN', true],
  ['disputes.manage', 'Handle and resolve disputes', true],
  ['refunds.request', 'Request refunds', true],
  ['refunds.approve', 'Approve refunds (maker-checker)', true],
  ['payouts.manage', 'Schedule, hold and release payouts', true],
  ['finance.reports.read', 'Read finance reports & ledger', false],
  ['finance.settlement.read_masked', 'Read settlement accounts (masked)', false],
  ['finance.settlement.request_change', 'Request settlement account change', true],
  ['finance.settlement.approve_change', 'Approve settlement account change (requires FINANCE_SUPER_ADMIN)', true],
  ['config.read', 'Read business configuration', false],
  ['config.propose', 'Propose business configuration versions', true],
  ['config.approve', 'Approve & activate business configuration', true],
  ['customs.rules.manage', 'Manage customs rules', true],
  ['restricted.rules.manage', 'Manage restricted item rules', true],
  ['promotions.manage', 'Manage promotions', true],
  ['referrals.manage', 'Manage referral programs & rewards', true],
  ['risk.read', 'Read risk assessments', false],
  ['risk.review', 'Resolve risk reviews', true],
  ['trust.override.request', 'Request trust score override', true],
  ['trust.override.approve', 'Approve trust score override', true],
  ['support.tickets.manage', 'Manage support tickets', false],
  ['chat.moderate', 'Moderate chat messages', true],
  ['audit.read', 'Read audit logs', false],
  ['infra.db.read', 'View database operations & health', false],
  ['infra.db.operate', 'Request/approve database operations', true],
  ['analytics.read', 'Read analytics dashboards', false],
  ['legal.documents.manage', 'Publish legal documents', true],
  ['faq.manage', 'Manage FAQ articles', false],
  ['rbac.manage', 'Grant / revoke admin roles', true],
];
const allPerms = permissions.map((p) => p[0]);
const financePerms = [
  'users.read', 'transactions.read', 'refunds.request', 'refunds.approve', 'payouts.manage',
  'finance.reports.read', 'finance.settlement.read_masked', 'finance.settlement.request_change',
  'config.read', 'audit.read', 'analytics.read',
];
const rolePermissions = {
  SUPER_ADMIN: allPerms.filter((p) => p !== 'finance.settlement.approve_change'),
  OPERATIONS: [
    'users.read', 'kyc.review', 'trips.verify', 'transactions.read', 'transactions.override', 'disputes.manage',
    'refunds.request', 'support.tickets.manage', 'chat.moderate', 'config.read', 'risk.read', 'analytics.read',
  ],
  FINANCE: financePerms,
  FINANCE_SUPER_ADMIN: [...financePerms, 'finance.settlement.approve_change', 'config.approve'],
  RISK: [
    'users.read', 'users.suspend', 'kyc.review', 'transactions.read', 'risk.read', 'risk.review',
    'trust.override.request', 'audit.read', 'config.read', 'analytics.read',
  ],
  SUPPORT: ['users.read', 'transactions.read', 'support.tickets.manage', 'chat.moderate', 'refunds.request', 'faq.manage'],
  MARKETING: ['promotions.manage', 'referrals.manage', 'analytics.read', 'faq.manage', 'config.read', 'config.propose'],
  COMPLIANCE: [
    'users.read', 'transactions.read', 'kyc.review', 'customs.rules.manage', 'restricted.rules.manage',
    'legal.documents.manage', 'audit.read', 'config.read', 'config.propose', 'risk.read',
  ],
};
for (const [role, perms] of Object.entries(rolePermissions)) {
  for (const p of perms) if (!allPerms.includes(p)) throw new Error(`unknown permission ${p} in ${role}`);
}

// ------------------------------------------------- static: ledger accounts
// normal side: assets/expenses DEBIT, liabilities/revenue CREDIT
const ledgerAccounts = [
  ['PRODUCT_FUND', 'Product fund held for buyers (item price)', 'CREDIT'],
  ['CUSTOMS_RESERVE', 'Reserve for estimated duty & import tax', 'CREDIT'],
  ['PLATFORM_REVENUE', 'Platform & protection fee revenue', 'CREDIT'],
  ['TAX_PAYABLE', 'Tax payable (PPN on platform services)', 'CREDIT'],
  ['PAYMENT_FEE', 'Payment gateway fees', 'DEBIT'],
  ['REFUND', 'Refunds payable to buyers', 'CREDIT'],
  ['PROMOTION_CREDIT', 'Platform-funded promotions & credit redemptions', 'DEBIT'],
  ['CLEARING', 'Clearing / suspense', 'DEBIT'],
  ['PROVIDER_CASH', 'Cash held at payment provider (external)', 'DEBIT'],
];

// ------------------------------------------------------------- static: FAQ
const bc = businessConfig;
const rupiah = (n) => 'Rp' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); // locale-independent
// Refund wording for a rejected price change, derived from the cancellation matrix row with
// cause PRICE_CHANGE_REJECTED (§5) so the FAQ cannot contradict the config.
function priceRejectRefundText() {
  const row = (bc['cancellation.matrix'] ?? []).find((r) => r.cause === 'PRICE_CHANGE_REJECTED');
  if (!row) throw new Error('cancellation.matrix has no row with cause PRICE_CHANGE_REJECTED (§5)');
  const pct = Object.values(row.refund ?? {});
  const full = pct.length > 0 && pct.every((v) => v === 10000);
  if (!full) throw new Error('PRICE_CHANGE_REJECTED row no longer refunds 100% — update the FAQ wording in the generator');
  return (row.refund.PAYMENT_FEE === 10000) ? 'penuh, termasuk biaya pembayaran' : 'penuh (kecuali biaya pembayaran)';
}
const faq = [
  ['apa-itu-jastipkita', 'GENERAL', 10, 'Apa itu JastipKita?',
    'JastipKita mempertemukan **Penitip** yang ingin membeli barang dari luar negeri dengan **Traveler** yang sedang bepergian. ' +
    'Penitip membuat request, Traveler mengajukan penawaran, dan seluruh pembayaran berjalan melalui SafePay. ' +
    'Rincian harga (harga barang, fee traveler, estimasi bea masuk & pajak, biaya layanan) selalu ditampilkan sebelum membayar.',
    ['umum', 'cara kerja']],
  ['apa-itu-safepay', 'PAYMENT', 20, 'Apa itu SafePay dan kapan dana diteruskan ke Traveler?',
    'SafePay adalah alur pembayaran JastipKita. Dana Penitip diterima melalui mitra payment gateway dan dicatat terpisah untuk setiap transaksi. ' +
    'Dana **tidak** diteruskan ke Traveler sebelum barang diterima dan dikonfirmasi Penitip, atau dikonfirmasi otomatis ' +
    `${bc.delivery.autoConfirmHours} jam setelah status *Terkirim* bila tidak ada dispute.`,
    ['safepay', 'pembayaran', 'dana']],
  ['kapan-traveler-boleh-membeli', 'TRAVELER', 30, 'Kapan Traveler boleh membeli barang titipan?',
    'Hanya setelah status transaksi **Pembelian Disetujui** (PURCHASE_APPROVED), yang mensyaratkan pembayaran Penitip sudah diamankan SafePay. ' +
    'Sebelum status itu aplikasi Traveler menampilkan banner merah **DO NOT PURCHASE**. Pembelian sebelum waktunya menjadi risiko Traveler sendiri.',
    ['traveler', 'pembelian', 'do not purchase']],
  ['estimasi-bea-masuk', 'CUSTOMS', 40, 'Bagaimana bea masuk dan pajak impor dihitung?',
    'Bea masuk dan pajak impor pada rincian harga adalah **estimasi** berdasarkan aturan kepabeanan yang berlaku saat penawaran dibuat; ' +
    'versi aturan yang dipakai dicatat pada setiap penawaran harga. Jumlah final ditetapkan petugas Bea dan Cukai. ' +
    'Bila Traveler membayar bea masuk, bukti pembayaran resmi wajib diunggah. Selisih antara estimasi dan tagihan resmi diproses sesuai Syarat & Ketentuan.',
    ['bea cukai', 'pajak', 'estimasi']],
  ['harga-barang-berubah', 'BUYER', 50, 'Bagaimana jika harga barang di toko berbeda?',
    `Jika harga aktual berbeda lebih dari toleransi (${bc.price_confirmation.toleranceBps / 100}% atau maksimal ${rupiah(bc.price_confirmation.toleranceMaxIdr)}), ` +
    `Traveler mengirim konfirmasi harga beserta foto struk/label. Penitip punya waktu ${bc.price_confirmation.windowSeconds / 60} menit untuk menyetujui, menolak, atau meminta klarifikasi. ` +
    `Menolak kenaikan harga tidak dianggap kesalahan Penitip: transaksi dibatalkan dan dana dikembalikan ${priceRejectRefundText()}, tanpa penalti Trust Score. ` +
    'Jika tidak ada respons sampai batas waktu, konfirmasi dianggap ditolak.',
    ['harga', 'konfirmasi harga']],
  ['cara-membuka-dispute', 'DISPUTE', 60, 'Bagaimana cara membuka dispute?',
    `Dispute dapat dibuka dari halaman transaksi paling lambat ${bc['dispute.sla'].openWindowHoursAfterDelivery} jam setelah barang berstatus terkirim. ` +
    `Kedua pihak mengunggah bukti dalam ${bc['dispute.sla'].evidenceHours} jam; tim JastipKita menargetkan keputusan dalam ${bc['dispute.sla'].reviewHours} jam setelah bukti lengkap. ` +
    `Keputusan dapat diajukan banding satu kali dalam ${bc['dispute.sla'].appealWindowHours} jam.`,
    ['dispute', 'komplain', 'refund']],
  ['jastipkita-credit', 'REFERRAL', 70, 'Apa itu JastipKita Credit?',
    `JastipKita Credit adalah saldo potongan yang didapat dari program referral atau promo. Credit berlaku ${bc['referral.buyer'].creditExpiryDays} hari, ` +
    'hanya dapat dipakai sebagai potongan saat checkout, dan tidak dapat dicairkan menjadi uang.',
    ['credit', 'referral']],
];

// ----------------------------------------------- static: retention policies
// ALL values are research-free defaults (is_assumption = true) to be validated by counsel.
const retention = [
  ['identity_records', 1825, 'ACCOUNT_CLOSED', 'DELETE', 'ASUMSI: retensi data CDD/KYC 5 tahun setelah hubungan usaha berakhir (praktik APU-PPT). Verifikasi dengan konsultan hukum.'],
  ['kyc_documents', 1825, 'ACCOUNT_CLOSED', 'DELETE', 'ASUMSI: sama dengan identity_records (gambar KTP/paspor/selfie terenkripsi).'],
  ['financial_records', 3650, 'CREATED', 'DELETE', 'ASUMSI: kewajiban penyimpanan pembukuan/dokumen 10 tahun (UU KUP). Mencakup transactions, payments, refunds, payouts, ledger_*, quotes, credit_entries.'],
  ['payment_webhook_events', 1825, 'CREATED', 'DELETE', 'ASUMSI: bukti rekonsiliasi dengan payment provider.'],
  ['audit_logs', 3650, 'CREATED', 'DELETE', 'ASUMSI: mengikuti catatan keuangan; purge hanya setelah checkpoint hash chain disimpan.'],
  ['messages', 730, 'TRANSACTION_CLOSED', 'ANONYMIZE', 'ASUMSI: bukti sengketa 2 tahun; pesan yang dirujuk dispute_evidence ditahan (legal hold).'],
  ['deliveries.address', 90, 'TRANSACTION_CLOSED', 'ANONYMIZE', 'Minimisasi data (UU PDP): alamat tidak diperlukan setelah transaksi selesai. Durasi = asumsi.'],
  ['trip_verifications.file', 180, 'TRIP_COMPLETED', 'DELETE', 'Minimisasi data: e-ticket/boarding pass hanya untuk verifikasi trip. Durasi = asumsi.'],
  ['files.chat', 730, 'TRANSACTION_CLOSED', 'DELETE', 'ASUMSI: mengikuti retensi pesan.'],
  ['analytics_events', 395, 'CREATED', 'DELETE', 'ASUMSI: 13 bulan untuk perbandingan year-over-year.'],
  ['security_events', 365, 'CREATED', 'DELETE', 'ASUMSI: investigasi keamanan 12 bulan.'],
  ['notifications', 180, 'CREATED', 'DELETE', 'Minimisasi data. Durasi = asumsi.'],
  ['otp_challenges', 30, 'CREATED', 'DELETE', 'Rate-limit & investigasi penyalahgunaan OTP. Durasi = asumsi.'],
  ['refresh_tokens', 30, 'EXPIRED', 'DELETE', 'Sesi kedaluwarsa tidak diperlukan. Durasi = asumsi.'],
  ['idempotency_keys', 1, 'EXPIRED', 'DELETE', 'Teknis: kunci idempotensi berlaku 24 jam.'],
  ['outbox_events', 14, 'PROCESSED', 'DELETE', 'Teknis: event sudah dipublikasikan.'],
  ['jobs', 30, 'PROCESSED', 'DELETE', 'Teknis: job selesai.'],
];

// ----------------------------------------------------------------- render
const out = [];
const emit = (s = '') => out.push(s);

emit('-- 0001_reference.sql — GENERATED by db/scripts/gen-reference-seed.mjs. DO NOT EDIT BY HAND.');
emit('-- Sources: packages/core/src/config/*.json, docs/00-domain-model.md §3/§4/§5/§6, static data in the generator.');
emit('-- Idempotent: safe to re-run on every deploy (upserts; ACTIVE business_configs are never modified).');
emit('BEGIN;');
emit();

emit('-- currencies');
emit('INSERT INTO currencies (code, minor_units, name, symbol, ecb_reference) VALUES');
emit(rows(currencies.map((c) => [q(c.code), q(c.minorUnits), q(c.name), q(c.symbol), q(c.ecbReference ?? true)])));
emit('ON CONFLICT (code) DO UPDATE SET minor_units = EXCLUDED.minor_units, name = EXCLUDED.name, symbol = EXCLUDED.symbol,');
emit('  ecb_reference = EXCLUDED.ecb_reference;');
emit();

emit('-- countries');
emit('INSERT INTO countries (code, name_id, name_en, currency_code, is_origin, is_destination, risk_level, activation, slug, sort_order) VALUES');
emit(rows(countries.map((c) => [q(c.code), q(c.nameId), q(c.nameEn), q(c.currency), q(c.origin), q(c.destination),
  q(c.risk), q(c.activation), q(c.slug), q(c.sort)])));
emit('ON CONFLICT (code) DO UPDATE SET name_id = EXCLUDED.name_id, name_en = EXCLUDED.name_en, currency_code = EXCLUDED.currency_code,');
emit('  is_origin = EXCLUDED.is_origin, is_destination = EXCLUDED.is_destination, risk_level = EXCLUDED.risk_level,');
emit('  activation = EXCLUDED.activation, slug = EXCLUDED.slug, sort_order = EXCLUDED.sort_order;');
emit();

emit('-- product_categories');
emit('INSERT INTO product_categories (code, name_id, name_en, risk_level, requires_serial, requires_video, default_weight_kg, default_hs_code, sort_order) VALUES');
emit(rows(categories.map((c, i) => [q(c.code), q(c.nameId), q(c.nameEn), q(c.risk), q(c.requiresSerial), q(c.requiresVideo),
  q(c.defaultWeightKg), q(c.defaultHs), q((i + 1) * 10)])));
emit('ON CONFLICT (code) DO UPDATE SET name_id = EXCLUDED.name_id, name_en = EXCLUDED.name_en, risk_level = EXCLUDED.risk_level,');
emit('  requires_serial = EXCLUDED.requires_serial, requires_video = EXCLUDED.requires_video,');
emit('  default_weight_kg = EXCLUDED.default_weight_kg, default_hs_code = EXCLUDED.default_hs_code, sort_order = EXCLUDED.sort_order;');
emit();

emit('-- RBAC: roles & permissions (least privilege; settlement approval only via FINANCE_SUPER_ADMIN)');
emit('INSERT INTO roles (code, name, description) VALUES');
emit(rows(roles.map((r) => r.map(q))));
emit('ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;');
emit('INSERT INTO permissions (code, description, is_sensitive) VALUES');
emit(rows(permissions.map((p) => p.map(q))));
emit('ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, is_sensitive = EXCLUDED.is_sensitive;');
const rp = Object.entries(rolePermissions).flatMap(([r, ps]) => ps.map((p) => [q(r), q(p)]));
emit(`DELETE FROM role_permissions WHERE role_code IN (${roles.map((r) => q(r[0])).join(', ')})`);
emit(`  AND (role_code, permission_code) NOT IN (VALUES\n${rows(rp)});`);
emit('INSERT INTO role_permissions (role_code, permission_code) VALUES');
emit(rows(rp));
emit('ON CONFLICT DO NOTHING;');
emit();

const emitFsm = (table, list, descCol) => {
  emit(`INSERT INTO ${table} (from_status, to_status, actor_types, ${descCol}) VALUES`);
  emit(rows(list.map((t) => [q(t.from), q(t.to), qArr(t.actors), q(t.guard)])));
  emit(`ON CONFLICT (from_status, to_status) DO UPDATE SET actor_types = EXCLUDED.actor_types, ${descCol} = EXCLUDED.${descCol};`);
  emit(`DELETE FROM ${table} WHERE (from_status, to_status) NOT IN (VALUES\n${rows(list.map((t) => [q(t.from), q(t.to)]))});`);
  emit();
};
emit(`-- transaction_transitions: parsed from docs/00-domain-model.md §4 (${fsm.TRANSACTION.length} rows)`);
emitFsm('transaction_transitions', fsm.TRANSACTION, 'guard');
emit(`-- trip_transitions: parsed from §15.1 (${fsm.TRIP.length} rows)`);
emitFsm('trip_transitions', fsm.TRIP, 'description');
emit(`-- dispute_transitions: parsed from §15.3 (${fsm.DISPUTE.length} rows)`);
emitFsm('dispute_transitions', fsm.DISPUTE, 'description');

emit('-- status_transitions: §15.2 price confirmation, §15.4 KYC, §15.5 payment, §15.6 refund, §15.7 payout (parsed);');
emit('-- §15.8 quote & FX lock (prose, hard-coded). Pairs are enforced by jk_enforce_fsm(); actors by the service layer.');
const st = Object.entries(statusTransitions).flatMap(([m, list]) => list.map((t) => [q(m), q(t.from), q(t.to), qArr(t.actors), q(t.guard)]));
emit('INSERT INTO status_transitions (machine, from_status, to_status, actor_types, note) VALUES');
emit(rows(st));
emit('ON CONFLICT (machine, from_status, to_status) DO UPDATE SET actor_types = EXCLUDED.actor_types, note = EXCLUDED.note;');
emit(`DELETE FROM status_transitions WHERE machine IN (${Object.keys(statusTransitions).map(q).join(', ')})`);
emit(`  AND (machine, from_status, to_status) NOT IN (VALUES\n${rows(st.map((r) => r.slice(0, 3)))});`);
emit();

emit('-- business_configs v1 ACTIVE from business-config.defaults.json (never overwritten once present)');
const assumptions = new Map(
  (bc._meta?.assumptions ?? []).map((a) => {
    const [key, ...rest] = a.split(' — ');
    return [key.trim(), rest.join(' — ').trim()];
  }),
);
const cfgRows = Object.entries(bc)
  .filter(([k]) => k !== '_meta')
  .map(([k, v]) => [q(k), '1', qJson(v), q('ACTIVE'), q('Initial defaults from business-config.defaults.json'),
    q(assumptions.has(k)), q(assumptions.get(k) ?? null), 'now()']);
emit('INSERT INTO business_configs (key, version, value, status, change_reason, is_assumption, notes, approved_at) VALUES');
emit(rows(cfgRows));
emit('ON CONFLICT (key, version) DO NOTHING;');
emit();

emit('-- ledger system accounts (IDR)');
emit('INSERT INTO ledger_accounts (code, name, bucket, owner_user_id, currency, normal_side, is_system) VALUES');
emit(rows(ledgerAccounts.map(([b, n, s]) => [q(`SYS:${b}:IDR`), q(n), q(b), 'NULL', q('IDR'), q(s), 'true'])));
emit('ON CONFLICT DO NOTHING;');
emit();

emit('-- FAQ (Bahasa Indonesia; numbers rendered from business-config defaults)');
emit('INSERT INTO faq_articles (slug, locale, category, sort_order, question, answer_md, tags, status, published_at) VALUES');
emit(rows(faq.map(([slug, cat, sort, qn, ans, tags]) => [q(slug), q('id'), q(cat), q(sort), q(qn), q(ans), qArr(tags), q('PUBLISHED'), 'now()'])));
emit('ON CONFLICT (slug, locale) DO UPDATE SET category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,');
emit('  question = EXCLUDED.question, answer_md = EXCLUDED.answer_md, tags = EXCLUDED.tags;');
emit();

emit('-- data_retention_policies — ALL are assumptions (is_assumption = true), configurable from Admin');
emit('INSERT INTO data_retention_policies (entity, retention_days, trigger_event, action, legal_basis, is_assumption) VALUES');
emit(rows(retention.map(([e, d, t, a, l]) => [q(e), q(d), q(t), q(a), q(l), 'true'])));
emit('ON CONFLICT (entity) DO NOTHING;');
emit();
emit('COMMIT;');
emit();

const sql = out.join('\n');
if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== sql) {
    console.error('db/seeds/0001_reference.sql is stale — run: node db/scripts/gen-reference-seed.mjs');
    process.exit(1);
  }
  console.log('db/seeds/0001_reference.sql is up to date');
} else {
  writeFileSync(OUT, sql);
  console.log(`wrote ${OUT} (${Object.entries(fsm).map(([k, v]) => `${k} ${v.length}`).join(', ')}; ${cfgRows.length} config keys)`);
}
