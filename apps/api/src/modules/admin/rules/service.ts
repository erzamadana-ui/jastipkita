/**
 * Admin · Versioned regulatory rules: customs_rules (customs.rules.manage) and restricted_items
 * (restricted.rules.manage). ACTIVE rows are never edited — every change is a NEW version:
 *   DRAFT (editable, deletable) → PENDING_APPROVAL (submit) → ACTIVE (approve: different admin, fresh MFA) | back to
 *   DRAFT (reject); ACTIVE → RETIRED (retire). On activation, the previous ACTIVE version of the same code is closed the
 *   day before the new effective_from (§16 inclusive dates) or RETIRED when fully superseded.
 * Source reference is mandatory; last_verified_at is shown and can be re-verified on ACTIVE rows (metadata only).
 * Preview: runs the core estimate/classifier for a sample item with the rules in force vs. the same set with this
 * version replacing its code.
 */
import { classifyItem, type CustomsRule, estimateCustoms, type RestrictedItemRule } from '@jastipkita/core';
import type { Db, TxSql } from '../../../db/sql';
import { Errors } from '../../../lib/errors';
import { core, wibDate } from '../../catalog/shared';
import { mapCustomsRule, rulesInForce as customsInForce } from '../../customs/repository';
import { getSpotRate } from '../../fx/service';
import { mapRestrictedRule, rulesInForce as restrictedInForce } from '../../restricted/repository';
import { type AdminCtx, adminAudit, inAdminTx, iso, makerChecker, parseCsv } from '../common';

export type RuleKind = 'customs' | 'restricted';
const TABLE: Record<RuleKind, string> = { customs: 'customs_rules', restricted: 'restricted_items' };
const ENTITY: Record<RuleKind, string> = { customs: 'customs_rule', restricted: 'restricted_item' };
const STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RETIRED'] as const;

const CUSTOMS_COLS = (db: Db) => db`
  id, code, version, origin_country, destination_country, hs_code_prefix, category_code, treatment, formula_code,
  exemption_usd::text AS exemption_usd, duty_rate::text AS duty_rate, vat_rate::text AS vat_rate, vat_dpp_factor::text AS vat_dpp_factor,
  luxury_tax_rate::text AS luxury_tax_rate, income_tax_rate::text AS income_tax_rate, income_tax_rate_no_npwp::text AS income_tax_rate_no_npwp,
  rounding, priority, effective_from::text AS effective_from, effective_until::text AS effective_until, source_reference, source_url,
  last_verified_at::text AS last_verified_at, verified_by, notes, status, created_by, approved_by, approved_at, created_at, updated_at`;
const RESTRICTED_COLS = (db: Db) => db`
  id, code, version, origin_country, destination_country, category_code, hs_code_prefix, keywords, classification, max_quantity,
  max_value_usd::text AS max_value_usd, permit_authority, airline_dg, message_id, message_en, source_reference, source_url,
  effective_from::text AS effective_from, effective_until::text AS effective_until, last_verified_at::text AS last_verified_at,
  verified_by, notes, status, created_by, approved_by, approved_at, created_at, updated_at`;

type Row = Record<string, unknown> & { id: string; code: string; version: number; status: string; created_by: string | null; effective_from: string; effective_until: string | null };

function cols(db: Db, kind: RuleKind) {
  return kind === 'customs' ? CUSTOMS_COLS(db) : RESTRICTED_COLS(db);
}

function dto(kind: RuleKind, r: Row, today: string) {
  const base = {
    id: r.id,
    kind,
    code: r.code,
    version: r.version,
    status: r.status,
    needsVerification: r.status === 'DRAFT' || r.status === 'PENDING_APPROVAL',
    originCountry: (r.origin_country as string | null)?.trim() ?? null,
    destinationCountry: String(r.destination_country).trim(),
    categoryCode: (r.category_code as string | null) ?? null,
    hsCodePrefix: (r.hs_code_prefix as string | null) ?? null,
    effectiveFrom: r.effective_from,
    effectiveUntil: r.effective_until,
    inForceToday: r.status === 'ACTIVE' && r.effective_from <= today && (r.effective_until === null || r.effective_until >= today),
    sourceReference: String(r.source_reference),
    sourceUrl: (r.source_url as string | null) ?? null,
    lastVerifiedAt: String(r.last_verified_at),
    verificationAgeDays: Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${String(r.last_verified_at)}T00:00:00Z`)) / 86400_000),
    verifiedBy: (r.verified_by as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    createdBy: r.created_by,
    approvedBy: (r.approved_by as string | null) ?? null,
    approvedAt: iso(r.approved_at as Date | null),
    createdAt: iso(r.created_at as Date)!,
    updatedAt: iso(r.updated_at as Date)!,
  };
  if (kind === 'customs') {
    return {
      ...base,
      treatment: r.treatment,
      formulaCode: r.formula_code,
      exemptionUsd: r.exemption_usd,
      dutyRate: r.duty_rate,
      vatRate: r.vat_rate,
      vatDppFactor: r.vat_dpp_factor,
      luxuryTaxRate: r.luxury_tax_rate,
      incomeTaxRate: r.income_tax_rate,
      incomeTaxRateNoNpwp: r.income_tax_rate_no_npwp,
      rounding: r.rounding,
      priority: r.priority,
    };
  }
  return {
    ...base,
    keywords: r.keywords,
    classification: r.classification,
    maxQuantity: r.max_quantity,
    maxValueUsd: r.max_value_usd,
    permitAuthority: r.permit_authority,
    airlineDg: r.airline_dg,
    messageId: r.message_id,
    messageEn: r.message_en,
  };
}

export async function listRules(ctx: AdminCtx, kind: RuleKind, q: { status?: string | undefined; code?: string | undefined; limit: number }) {
  const db = ctx.deps.sql;
  const statuses = parseCsv(q.status, STATUSES, 'status');
  const r = await db<Row[]>`
    SELECT ${cols(db, kind)} FROM ${db(TABLE[kind])}
     WHERE true ${statuses ? db`AND status = ANY(${statuses}::text[])` : db``} ${q.code ? db`AND code = ${q.code.toUpperCase()}` : db``}
     ORDER BY code, version DESC LIMIT ${q.limit}`;
  const today = wibDate(ctx.deps.clock.now());
  return { data: r.map((x) => dto(kind, x, today)), nextCursor: null };
}

async function loadRule(db: Db, kind: RuleKind, id: string, forUpdate = false): Promise<Row> {
  const [r] = forUpdate
    ? await db<Row[]>`SELECT ${cols(db, kind)} FROM ${db(TABLE[kind])} WHERE id = ${id} FOR UPDATE`
    : await db<Row[]>`SELECT ${cols(db, kind)} FROM ${db(TABLE[kind])} WHERE id = ${id}`;
  if (!r) throw Errors.notFound('Rule', 'RULE_NOT_FOUND');
  return r;
}

export async function ruleDetail(ctx: AdminCtx, kind: RuleKind, id: string) {
  const db = ctx.deps.sql;
  const r = await loadRule(db, kind, id);
  const versions = await db<{ id: string; version: number; status: string; effective_from: string; effective_until: string | null }[]>`
    SELECT id, version, status, effective_from::text AS effective_from, effective_until::text AS effective_until FROM ${db(TABLE[kind])}
     WHERE code = ${r.code} ORDER BY version DESC`;
  const today = wibDate(ctx.deps.clock.now());
  return { ...dto(kind, r, today), versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status, effectiveFrom: v.effective_from, effectiveUntil: v.effective_until })) };
}

// ------------------------------------------------------------------ create / update (DRAFT)

const CUSTOMS_FIELDS: Record<string, string> = {
  originCountry: 'origin_country', destinationCountry: 'destination_country', hsCodePrefix: 'hs_code_prefix', categoryCode: 'category_code',
  treatment: 'treatment', formulaCode: 'formula_code', exemptionUsd: 'exemption_usd', dutyRate: 'duty_rate', vatRate: 'vat_rate',
  vatDppFactor: 'vat_dpp_factor', luxuryTaxRate: 'luxury_tax_rate', incomeTaxRate: 'income_tax_rate', incomeTaxRateNoNpwp: 'income_tax_rate_no_npwp',
  rounding: 'rounding', priority: 'priority', effectiveFrom: 'effective_from', effectiveUntil: 'effective_until', sourceReference: 'source_reference',
  sourceUrl: 'source_url', lastVerifiedAt: 'last_verified_at', verifiedBy: 'verified_by', notes: 'notes',
};
const RESTRICTED_FIELDS: Record<string, string> = {
  originCountry: 'origin_country', destinationCountry: 'destination_country', categoryCode: 'category_code', hsCodePrefix: 'hs_code_prefix',
  keywords: 'keywords', classification: 'classification', maxQuantity: 'max_quantity', maxValueUsd: 'max_value_usd', permitAuthority: 'permit_authority',
  airlineDg: 'airline_dg', messageId: 'message_id', messageEn: 'message_en', sourceReference: 'source_reference', sourceUrl: 'source_url',
  effectiveFrom: 'effective_from', effectiveUntil: 'effective_until', lastVerifiedAt: 'last_verified_at', verifiedBy: 'verified_by', notes: 'notes',
};

function toColumns(kind: RuleKind, input: Record<string, unknown>): Record<string, unknown> {
  const map = kind === 'customs' ? CUSTOMS_FIELDS : RESTRICTED_FIELDS;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || !(k in map)) continue;
    out[map[k]!] = v;
  }
  return out;
}

function assertDates(from: string, until: string | null | undefined) {
  if (until && until < from) throw Errors.unprocessable('RULE_DATES_INVALID', 'effectiveUntil harus ≥ effectiveFrom (tanggal inklusif, §16)');
}

export async function createRule(ctx: AdminCtx, kind: RuleKind, input: Record<string, unknown> & { code: string; effectiveFrom: string; effectiveUntil?: string | null }) {
  assertDates(input.effectiveFrom, input.effectiveUntil ?? null);
  const code = input.code.toUpperCase();
  const row = await inAdminTx(ctx, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${TABLE[kind]}:${code}`}, 0))`;
    const [mx] = await tx<{ v: number }[]>`SELECT coalesce(max(version), 0)::int AS v FROM ${tx(TABLE[kind])} WHERE code = ${code}`;
    const values = { ...toColumns(kind, input), code, version: (mx?.v ?? 0) + 1, status: 'DRAFT', created_by: ctx.auth.userId };
    const [ins] = await tx<{ id: string }[]>`INSERT INTO ${tx(TABLE[kind])} ${tx(values as never)} RETURNING id`;
    const r = await loadRule(tx, kind, ins!.id);
    await adminAudit(tx, ctx, { action: `${kind === 'customs' ? 'customs' : 'restricted'}.rule_drafted`, entityType: ENTITY[kind], entityId: ins!.id, after: { code, version: r.version, status: 'DRAFT' }, meta: { sourceReference: input.sourceReference ?? null } });
    return r;
  });
  return dto(kind, row, wibDate(ctx.deps.clock.now()));
}

export async function updateRule(ctx: AdminCtx, kind: RuleKind, id: string, patch: Record<string, unknown>) {
  const row = await inAdminTx(ctx, async (tx) => {
    const cur = await loadRule(tx, kind, id, true);
    if (cur.status !== 'DRAFT') throw Errors.unprocessable('RULE_NOT_EDITABLE', 'Hanya versi DRAFT yang dapat diubah; buat versi baru', { status: cur.status });
    const values = toColumns(kind, patch);
    if (Object.keys(values).length === 0) throw Errors.validation({ issues: [{ path: '', message: 'no fields' }] });
    const from = (values.effective_from as string | undefined) ?? cur.effective_from;
    const until = values.effective_until !== undefined ? (values.effective_until as string | null) : cur.effective_until;
    assertDates(from, until);
    await tx`UPDATE ${tx(TABLE[kind])} SET ${tx(values as never, ...Object.keys(values))} WHERE id = ${id}`;
    const r = await loadRule(tx, kind, id);
    await adminAudit(tx, ctx, { action: `${kind === 'customs' ? 'customs' : 'restricted'}.rule_updated`, entityType: ENTITY[kind], entityId: id, before: pick(cur, Object.keys(values)), after: pick(r, Object.keys(values)) });
    return r;
  });
  return dto(kind, row, wibDate(ctx.deps.clock.now()));
}

function pick(r: Row, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, r[k] ?? null]));
}

/**
 * Discards a DRAFT version. Rule tables are NO_DELETE for the app role (versioned regulatory history), so a
 * discarded draft is RETIRED (never in force, immutable) with the reason in its notes.
 */
export async function discardDraft(ctx: AdminCtx, kind: RuleKind, id: string, reason: string) {
  await inAdminTx(ctx, async (tx) => {
    const cur = await loadRule(tx, kind, id, true);
    if (cur.status !== 'DRAFT') throw Errors.unprocessable('RULE_NOT_EDITABLE', 'Hanya DRAFT yang dapat dibuang', { status: cur.status });
    const notes = `[DISCARDED DRAFT] ${reason}${cur.notes ? `\n${String(cur.notes)}` : ''}`.slice(0, 4000);
    await tx`UPDATE ${tx(TABLE[kind])} SET status = 'RETIRED', notes = ${notes} WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: `${kind === 'customs' ? 'customs' : 'restricted'}.rule_draft_discarded`, entityType: ENTITY[kind], entityId: id, before: { code: cur.code, version: cur.version, status: 'DRAFT' }, after: { status: 'RETIRED' }, meta: { reason } });
  });
  return { id, status: 'RETIRED', discarded: true };
}

// ------------------------------------------------------------------ lifecycle

async function setStatus(tx: TxSql, kind: RuleKind, id: string, status: string) {
  await tx`UPDATE ${tx(TABLE[kind])} SET status = ${status} WHERE id = ${id}`;
}

export async function submitRule(ctx: AdminCtx, kind: RuleKind, id: string) {
  await inAdminTx(ctx, async (tx) => {
    const cur = await loadRule(tx, kind, id, true);
    if (cur.status !== 'DRAFT') throw Errors.unprocessable('RULE_NOT_DRAFT', 'Hanya DRAFT yang dapat diajukan', { status: cur.status });
    if (!String(cur.source_reference ?? '').trim()) throw Errors.unprocessable('SOURCE_REFERENCE_REQUIRED', 'Referensi sumber wajib diisi');
    await setStatus(tx, kind, id, 'PENDING_APPROVAL');
    await adminAudit(tx, ctx, { action: `${kind === 'customs' ? 'customs' : 'restricted'}.rule_submitted`, entityType: ENTITY[kind], entityId: id, before: { status: 'DRAFT' }, after: { status: 'PENDING_APPROVAL' } });
  });
  return { id, status: 'PENDING_APPROVAL' };
}

function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
}

export async function approveRule(ctx: AdminCtx, kind: RuleKind, id: string) {
  const now = ctx.deps.clock.now();
  const out = await inAdminTx(ctx, async (tx) => {
    const cur = await loadRule(tx, kind, id, true);
    makerChecker(cur.created_by, ctx.auth.userId, 'Rule harus disetujui oleh admin yang berbeda dari pembuatnya (maker-checker)');
    if (cur.status !== 'PENDING_APPROVAL') throw Errors.unprocessable('RULE_NOT_PENDING', 'Rule tidak menunggu persetujuan', { status: cur.status });
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${TABLE[kind]}:${cur.code}`}, 0))`;
    const actives = await tx<{ id: string; version: number; effective_from: string; effective_until: string | null }[]>`
      SELECT id, version, effective_from::text AS effective_from, effective_until::text AS effective_until FROM ${tx(TABLE[kind])}
       WHERE code = ${cur.code} AND status = 'ACTIVE' AND id <> ${id} FOR UPDATE`;
    const superseded: Record<string, unknown>[] = [];
    for (const a of actives) {
      const overlaps = (cur.effective_until === null || a.effective_from <= cur.effective_until) && (a.effective_until === null || a.effective_until >= cur.effective_from);
      if (!overlaps) continue;
      if (a.effective_from < cur.effective_from) {
        const until = dayBefore(cur.effective_from);
        await tx`UPDATE ${tx(TABLE[kind])} SET effective_until = ${until}::date WHERE id = ${a.id}`;
        superseded.push({ id: a.id, version: a.version, effectiveUntil: { from: a.effective_until, to: until } });
      } else {
        await tx`UPDATE ${tx(TABLE[kind])} SET status = 'RETIRED' WHERE id = ${a.id}`;
        superseded.push({ id: a.id, version: a.version, status: 'RETIRED' });
      }
    }
    await tx`UPDATE ${tx(TABLE[kind])} SET status = 'ACTIVE', approved_by = ${ctx.auth.userId}, approved_at = ${now} WHERE id = ${id}`;
    await adminAudit(tx, ctx, {
      action: `${kind === 'customs' ? 'customs' : 'restricted'}.rule_activated`,
      entityType: ENTITY[kind],
      entityId: id,
      before: { status: 'PENDING_APPROVAL' },
      after: { status: 'ACTIVE', code: cur.code, version: cur.version, effectiveFrom: cur.effective_from, effectiveUntil: cur.effective_until },
      meta: { makerId: cur.created_by, superseded },
    });
    return superseded;
  });
  return { id, status: 'ACTIVE', superseded: out };
}

export async function rejectRule(ctx: AdminCtx, kind: RuleKind, id: string, reason: string) {
  await inAdminTx(ctx, async (tx) => {
    const cur = await loadRule(tx, kind, id, true);
    if (cur.status !== 'PENDING_APPROVAL') throw Errors.unprocessable('RULE_NOT_PENDING', 'Rule tidak menunggu persetujuan', { status: cur.status });
    const note = `${cur.notes ? `${String(cur.notes)}\n` : ''}[ditolak ${now(ctx)}] ${reason}`.slice(-4000);
    await tx`UPDATE ${tx(TABLE[kind])} SET status = 'DRAFT', notes = ${note} WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: `${kind === 'customs' ? 'customs' : 'restricted'}.rule_rejected`, entityType: ENTITY[kind], entityId: id, before: { status: 'PENDING_APPROVAL' }, after: { status: 'DRAFT' }, meta: { reason } });
  });
  return { id, status: 'DRAFT' };
}

function now(ctx: AdminCtx) {
  return ctx.deps.clock.now().toISOString().slice(0, 10);
}

export async function retireRule(ctx: AdminCtx, kind: RuleKind, id: string, reason: string) {
  await inAdminTx(ctx, async (tx) => {
    const cur = await loadRule(tx, kind, id, true);
    if (cur.status !== 'ACTIVE') throw Errors.unprocessable('RULE_NOT_ACTIVE', 'Hanya rule ACTIVE yang dapat dipensiunkan', { status: cur.status });
    await tx`UPDATE ${tx(TABLE[kind])} SET status = 'RETIRED', notes = ${`${cur.notes ? `${String(cur.notes)}\n` : ''}[retired ${now(ctx)}] ${reason}`.slice(-4000)} WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: `${kind === 'customs' ? 'customs' : 'restricted'}.rule_retired`, entityType: ENTITY[kind], entityId: id, before: { status: 'ACTIVE' }, after: { status: 'RETIRED' }, meta: { reason } });
  });
  return { id, status: 'RETIRED' };
}

export async function reverifyRule(ctx: AdminCtx, kind: RuleKind, id: string, input: { lastVerifiedAt: string; verifiedBy: string; sourceNote?: string | undefined }) {
  await inAdminTx(ctx, async (tx) => {
    const cur = await loadRule(tx, kind, id, true);
    if (cur.status === 'RETIRED') throw Errors.unprocessable('RULE_RETIRED', 'Rule sudah pensiun');
    await tx`UPDATE ${tx(TABLE[kind])} SET last_verified_at = ${input.lastVerifiedAt}::date, verified_by = ${input.verifiedBy}
              ${input.sourceNote ? tx`, notes = ${`${cur.notes ? `${String(cur.notes)}\n` : ''}[verified ${input.lastVerifiedAt}] ${input.sourceNote}`.slice(-4000)}` : tx``}
             WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: `${kind === 'customs' ? 'customs' : 'restricted'}.rule_reverified`, entityType: ENTITY[kind], entityId: id, before: { lastVerifiedAt: cur.last_verified_at }, after: { lastVerifiedAt: input.lastVerifiedAt, verifiedBy: input.verifiedBy } });
  });
  return { id, lastVerifiedAt: input.lastVerifiedAt };
}

// ------------------------------------------------------------------ preview

export interface PreviewInput {
  originCountry: string;
  destinationCountry?: string | undefined;
  categoryCode: string;
  hsCode?: string | null | undefined;
  productName?: string | undefined;
  unitPriceMinor: number;
  currency: string;
  quantity: number;
  date?: string | undefined;
  fx?: { itemToIdr?: string | undefined; usdToIdr?: string | undefined; itemToUsd?: string | undefined } | undefined;
}

export async function previewRule(ctx: AdminCtx, kind: RuleKind, id: string, input: PreviewInput) {
  const db = ctx.deps.sql;
  const r = await loadRule(db, kind, id);
  const today = wibDate(ctx.deps.clock.now());
  const date = input.date ?? (r.effective_from > today ? r.effective_from : today);
  const at = new Date(`${date}T12:00:00+07:00`);
  const destination = input.destinationCountry ?? String(r.destination_country).trim();
  if (kind === 'customs') {
    const current = await customsInForce(db, date, destination);
    const candidate: CustomsRule = { ...mapCustomsRule(r as never), status: 'ACTIVE' };
    const proposed = [...current.filter((x) => x.code !== r.code), candidate];
    const fx = {
      itemToIdr: input.currency === 'IDR' ? undefined : (input.fx?.itemToIdr ?? (await getSpotRate(db, ctx.deps, input.currency, 'IDR')).spotRate),
      usdToIdr: input.fx?.usdToIdr ?? (await getSpotRate(db, ctx.deps, 'USD', 'IDR')).spotRate,
    };
    const run = (rules: readonly CustomsRule[]) =>
      core(() =>
        estimateCustoms({
          originCountry: input.originCountry,
          destinationCountry: destination,
          hsCode: input.hsCode ?? null,
          categoryCode: input.categoryCode,
          itemValueMinor: input.unitPriceMinor,
          currency: input.currency,
          quantity: input.quantity,
          treatment: 'NON_PERSONAL',
          fx: { ...(fx.itemToIdr ? { itemToIdr: fx.itemToIdr } : {}), usdToIdr: fx.usdToIdr },
          date: at,
          rules,
        }),
      );
    const before = current.length ? await run(current).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })) : { error: 'NO_RULES_IN_FORCE' };
    const after = await run(proposed);
    const slim = (e: typeof after | { error: string }) =>
      'error' in e ? e : { ruleCode: e.ruleCode, ruleVersion: e.ruleVersion, dutyIdr: e.dutyIdr, importTaxIdr: e.importTaxIdr, totalIdr: e.totalIdr, customsValueIdr: e.customsValueIdr, warnings: e.warnings };
    const b = slim(before);
    const a = slim(after);
    return {
      kind,
      ruleId: id,
      date,
      sample: input,
      fxUsed: fx,
      current: b,
      proposed: a,
      delta: 'error' in b ? null : { dutyIdr: after.dutyIdr - (before as typeof after).dutyIdr, importTaxIdr: after.importTaxIdr - (before as typeof after).importTaxIdr, totalIdr: after.totalIdr - (before as typeof after).totalIdr },
      proposedRuleSelected: after.ruleCode === r.code && after.ruleVersion === r.version,
      isEstimate: true,
    };
  }
  const current = await restrictedInForce(db, date, destination);
  const candidate: RestrictedItemRule = { ...mapRestrictedRule(r as never), status: 'ACTIVE' };
  const proposed = [...current.filter((x) => x.code !== r.code), candidate];
  let valueUsd: string | null = null;
  if (input.currency === 'USD') valueUsd = String((input.unitPriceMinor * input.quantity) / 100);
  else if (input.fx?.itemToUsd) valueUsd = String(Number(input.fx.itemToUsd) * input.unitPriceMinor * input.quantity);
  const item = { origin: input.originCountry, destination, categoryCode: input.categoryCode, hsCode: input.hsCode ?? null, productName: input.productName ?? '', quantity: input.quantity, valueUsd };
  const before = await core(() => classifyItem(item, current, at));
  const after = await core(() => classifyItem(item, proposed, at));
  const slim = (c: typeof after) => ({ classification: c.classification, blocksCheckout: c.blocksCheckout, requiresAcknowledgement: c.requiresAcknowledgement, matches: c.matches.map((m) => ({ code: m.code, version: m.version, classification: m.classification })) });
  return { kind, ruleId: id, date, sample: input, current: slim(before), proposed: slim(after), changed: before.classification !== after.classification, isEstimate: false };
}
