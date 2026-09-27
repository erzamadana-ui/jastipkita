/**
 * Admin · Content: FAQ articles (faq.manage) and legal documents (legal.documents.manage).
 * Legal documents are versioned per (type, locale); a published version is immutable evidence of what users consented
 * to (DB guard). Publishing a new version makes it the latest published one (what users see) and, by default, retires
 * the previous published version so new consents must reference the new text.
 */
import type { TxSql } from '../../../db/sql';
import { Errors } from '../../../lib/errors';
import { type AdminCtx, adminAudit, inAdminTx, iso } from '../common';

interface FaqRow {
  id: string;
  slug: string;
  locale: string;
  category: string;
  question: string;
  answer_md: string;
  tags: string[];
  sort_order: number;
  status: string;
  published_at: Date | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function faqDto(f: FaqRow) {
  return {
    id: f.id,
    slug: f.slug,
    locale: f.locale,
    category: f.category,
    question: f.question,
    answerMd: f.answer_md,
    tags: f.tags,
    sortOrder: f.sort_order,
    status: f.status,
    publishedAt: iso(f.published_at),
    createdBy: f.created_by,
    updatedBy: f.updated_by,
    createdAt: iso(f.created_at)!,
    updatedAt: iso(f.updated_at)!,
  };
}

export async function listFaq(ctx: AdminCtx, q: { status?: string | undefined; locale?: string | undefined; category?: string | undefined }) {
  const db = ctx.deps.sql;
  const r = await db<FaqRow[]>`
    SELECT * FROM faq_articles WHERE true
      ${q.status ? db`AND status = ${q.status}` : db``} ${q.locale ? db`AND locale = ${q.locale}` : db``} ${q.category ? db`AND category = ${q.category}` : db``}
     ORDER BY category, sort_order, slug, locale LIMIT 500`;
  return { data: r.map(faqDto), nextCursor: null };
}

async function lockFaq(tx: TxSql, id: string): Promise<FaqRow> {
  const [f] = await tx<FaqRow[]>`SELECT * FROM faq_articles WHERE id = ${id} FOR UPDATE`;
  if (!f) throw Errors.notFound('Artikel FAQ', 'FAQ_NOT_FOUND');
  return f;
}

export async function faqDetail(ctx: AdminCtx, id: string) {
  const [f] = await ctx.deps.sql<FaqRow[]>`SELECT * FROM faq_articles WHERE id = ${id}`;
  if (!f) throw Errors.notFound('Artikel FAQ', 'FAQ_NOT_FOUND');
  return faqDto(f);
}

export interface FaqInput {
  slug?: string | undefined;
  locale?: 'id' | 'en' | undefined;
  category?: string | undefined;
  question?: string | undefined;
  answerMd?: string | undefined;
  tags?: string[] | undefined;
  sortOrder?: number | undefined;
}

function faqCols(i: FaqInput): Record<string, unknown> {
  const map: [keyof FaqInput, string][] = [['slug', 'slug'], ['locale', 'locale'], ['category', 'category'], ['question', 'question'], ['answerMd', 'answer_md'], ['tags', 'tags'], ['sortOrder', 'sort_order']];
  const out: Record<string, unknown> = {};
  for (const [k, c] of map) if (i[k] !== undefined) out[c] = i[k];
  return out;
}

export async function createFaq(ctx: AdminCtx, input: FaqInput) {
  const f = await inAdminTx(ctx, async (tx) => {
    const values = { ...faqCols(input), status: 'DRAFT', created_by: ctx.auth.userId, updated_by: ctx.auth.userId };
    const [row] = await tx<FaqRow[]>`INSERT INTO faq_articles ${tx(values as never)} RETURNING *`;
    await adminAudit(tx, ctx, { action: 'faq.created', entityType: 'faq_article', entityId: row!.id, after: { slug: row!.slug, locale: row!.locale, status: 'DRAFT' } });
    return row!;
  });
  return faqDto(f);
}

export async function updateFaq(ctx: AdminCtx, id: string, patch: FaqInput) {
  const f = await inAdminTx(ctx, async (tx) => {
    const cur = await lockFaq(tx, id);
    const values = { ...faqCols(patch), updated_by: ctx.auth.userId };
    await tx`UPDATE faq_articles SET ${tx(values as never, ...Object.keys(values))} WHERE id = ${id}`;
    const [row] = await tx<FaqRow[]>`SELECT * FROM faq_articles WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'faq.updated', entityType: 'faq_article', entityId: id, before: { slug: cur.slug, question: cur.question, status: cur.status }, after: { slug: row!.slug, question: row!.question, status: row!.status }, meta: { fields: Object.keys(values) } });
    return row!;
  });
  return faqDto(f);
}

export async function setFaqStatus(ctx: AdminCtx, id: string, to: 'PUBLISHED' | 'ARCHIVED' | 'DRAFT') {
  const now = ctx.deps.clock.now();
  const f = await inAdminTx(ctx, async (tx) => {
    const cur = await lockFaq(tx, id);
    if (cur.status === to) throw Errors.conflict('NO_CHANGE', `Artikel sudah ${to}`);
    await tx`UPDATE faq_articles SET status = ${to}, published_at = ${to === 'PUBLISHED' ? now : cur.published_at}, updated_by = ${ctx.auth.userId} WHERE id = ${id}`;
    const [row] = await tx<FaqRow[]>`SELECT * FROM faq_articles WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: `faq.${to === 'PUBLISHED' ? 'published' : to === 'ARCHIVED' ? 'archived' : 'unpublished'}`, entityType: 'faq_article', entityId: id, before: { status: cur.status }, after: { status: to } });
    return row!;
  });
  return faqDto(f);
}

export async function deleteFaq(ctx: AdminCtx, id: string) {
  await inAdminTx(ctx, async (tx) => {
    const cur = await lockFaq(tx, id);
    if (cur.status !== 'DRAFT') throw Errors.unprocessable('FAQ_NOT_DRAFT', 'Hanya DRAFT yang dapat dihapus; arsipkan artikel yang pernah terbit');
    await tx`DELETE FROM faq_articles WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'faq.deleted', entityType: 'faq_article', entityId: id, before: { slug: cur.slug, locale: cur.locale } });
  });
  return { id, deleted: true };
}

// ------------------------------------------------------------------ legal documents

interface LegalRow {
  id: string;
  type: string;
  version: string;
  locale: string;
  title: string;
  body_md: string;
  summary_of_changes: string | null;
  summary: string | null;
  effective_at: Date | null;
  published_at: Date | null;
  retired_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  is_current?: boolean;
}

function legalDto(l: LegalRow, withBody: boolean) {
  return {
    id: l.id,
    type: l.type,
    version: l.version,
    locale: l.locale,
    title: l.title,
    ...(withBody ? { bodyMd: l.body_md } : {}),
    summaryOfChanges: l.summary_of_changes,
    summary: l.summary,
    effectiveAt: iso(l.effective_at),
    status: l.retired_at ? 'RETIRED' : l.published_at ? 'PUBLISHED' : 'DRAFT',
    current: !!l.is_current,
    publishedAt: iso(l.published_at),
    retiredAt: iso(l.retired_at),
    createdBy: l.created_by,
    createdAt: iso(l.created_at)!,
    updatedAt: iso(l.updated_at)!,
  };
}

const LEGAL_SELECT = (db: AdminCtx['deps']['sql']) => db`
  SELECT l.*, (l.published_at IS NOT NULL AND l.retired_at IS NULL AND l.published_at = (
           SELECT max(x.published_at) FROM legal_documents x WHERE x.type = l.type AND x.locale = l.locale AND x.published_at IS NOT NULL AND x.retired_at IS NULL)) AS is_current
    FROM legal_documents l`;

export async function listLegal(ctx: AdminCtx, q: { type?: string | undefined; locale?: string | undefined }) {
  const db = ctx.deps.sql;
  const r = await db<LegalRow[]>`${LEGAL_SELECT(db)} WHERE true ${q.type ? db`AND l.type = ${q.type}` : db``} ${q.locale ? db`AND l.locale = ${q.locale}` : db``}
    ORDER BY l.type, l.locale, l.created_at DESC LIMIT 500`;
  return { data: r.map((l) => legalDto(l, false)), nextCursor: null };
}

export async function legalDetail(ctx: AdminCtx, id: string) {
  const db = ctx.deps.sql;
  const [l] = await db<LegalRow[]>`${LEGAL_SELECT(db)} WHERE l.id = ${id}`;
  if (!l) throw Errors.notFound('Dokumen legal', 'LEGAL_DOCUMENT_NOT_FOUND');
  return legalDto(l, true);
}

export async function createLegal(
  ctx: AdminCtx,
  input: { type: string; version: string; locale: 'id' | 'en'; title: string; bodyMd: string; summaryOfChanges?: string | undefined; summary?: string | undefined; effectiveAt?: string | undefined },
) {
  const l = await inAdminTx(ctx, async (tx) => {
    const [row] = await tx<LegalRow[]>`
      INSERT INTO legal_documents (type, version, locale, title, body_md, summary_of_changes, summary, effective_at, created_by)
      VALUES (${input.type}, ${input.version}, ${input.locale}, ${input.title}, ${input.bodyMd}, ${input.summaryOfChanges ?? null},
              ${input.summary ?? null}, ${input.effectiveAt ? new Date(input.effectiveAt) : null}, ${ctx.auth.userId})
      RETURNING *`;
    await adminAudit(tx, ctx, { action: 'legal.document_drafted', entityType: 'legal_document', entityId: row!.id, after: { type: input.type, version: input.version, locale: input.locale } });
    return row!;
  });
  return legalDto(l, true);
}

export async function updateLegal(
  ctx: AdminCtx,
  id: string,
  patch: { title?: string | undefined; bodyMd?: string | undefined; summaryOfChanges?: string | undefined; summary?: string | undefined; effectiveAt?: string | null | undefined },
) {
  const l = await inAdminTx(ctx, async (tx) => {
    const [cur] = await tx<LegalRow[]>`SELECT * FROM legal_documents WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw Errors.notFound('Dokumen legal', 'LEGAL_DOCUMENT_NOT_FOUND');
    if (cur.published_at) throw Errors.unprocessable('LEGAL_DOCUMENT_PUBLISHED', 'Dokumen yang sudah terbit tidak dapat diubah; buat versi baru');
    const values: Record<string, unknown> = {};
    if (patch.title !== undefined) values.title = patch.title;
    if (patch.bodyMd !== undefined) values.body_md = patch.bodyMd;
    if (patch.summaryOfChanges !== undefined) values.summary_of_changes = patch.summaryOfChanges;
    if (patch.summary !== undefined) values.summary = patch.summary;
    if (patch.effectiveAt !== undefined) values.effective_at = patch.effectiveAt ? new Date(patch.effectiveAt) : null;
    if (!Object.keys(values).length) throw Errors.validation({ issues: [{ path: '', message: 'tidak ada perubahan' }] });
    const [row] = await tx<LegalRow[]>`UPDATE legal_documents SET ${tx(values as never, ...Object.keys(values))} WHERE id = ${id} RETURNING *`;
    await adminAudit(tx, ctx, { action: 'legal.document_updated', entityType: 'legal_document', entityId: id, meta: { fields: Object.keys(values) } });
    return row!;
  });
  return legalDto(l, true);
}

export async function publishLegal(ctx: AdminCtx, id: string, retirePrevious: boolean) {
  const now = ctx.deps.clock.now();
  const out = await inAdminTx(ctx, async (tx) => {
    const [cur] = await tx<LegalRow[]>`SELECT * FROM legal_documents WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw Errors.notFound('Dokumen legal', 'LEGAL_DOCUMENT_NOT_FOUND');
    if (cur.published_at) throw Errors.conflict('LEGAL_DOCUMENT_PUBLISHED', 'Dokumen sudah terbit');
    const previous = retirePrevious
      ? await tx<{ id: string; version: string }[]>`
          UPDATE legal_documents SET retired_at = ${now}
           WHERE type = ${cur.type} AND locale = ${cur.locale} AND published_at IS NOT NULL AND retired_at IS NULL RETURNING id, version`
      : [];
    await tx`UPDATE legal_documents SET published_at = ${now} WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'legal.document_published', entityType: 'legal_document', entityId: id, after: { type: cur.type, version: cur.version, locale: cur.locale }, meta: { retired: previous.map((p) => ({ id: p.id, version: p.version })) } });
    return previous;
  });
  return { ...(await legalDetail(ctx, id)), retiredPrevious: out.map((p) => ({ id: p.id, version: p.version })) };
}

export async function retireLegal(ctx: AdminCtx, id: string, reason: string) {
  const now = ctx.deps.clock.now();
  await inAdminTx(ctx, async (tx) => {
    const [cur] = await tx<LegalRow[]>`SELECT * FROM legal_documents WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw Errors.notFound('Dokumen legal', 'LEGAL_DOCUMENT_NOT_FOUND');
    if (!cur.published_at || cur.retired_at) throw Errors.unprocessable('LEGAL_DOCUMENT_NOT_ACTIVE', 'Hanya dokumen terbit yang belum dipensiunkan');
    await tx`UPDATE legal_documents SET retired_at = ${now} WHERE id = ${id}`;
    await adminAudit(tx, ctx, { action: 'legal.document_retired', entityType: 'legal_document', entityId: id, meta: { reason, type: cur.type, version: cur.version } });
  });
  return legalDetail(ctx, id);
}
