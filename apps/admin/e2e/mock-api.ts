/**
 * In-browser API mock for Playwright: intercepts http://api.test/** with page.route and answers with the
 * OpenAPI-shaped fixtures. Emulates the server rules the UI depends on: bearer auth, refresh rotation, MFA step-up
 * (403 MFA_REQUIRED unless the access token carries a fresh mfa_at), Idempotency-Key required on money writes,
 * maker-checker on approvals.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import * as F from './fixtures';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = JSON.parse(readFileSync(resolve(here, '../../../packages/core/src/config/business-config.defaults.json'), 'utf8')) as Record<string, unknown>;

export const API = 'http://api.test';
const NOW_SEC = Math.floor(F.NOW.getTime() / 1000);

export interface MockState {
  forceMfaStale: boolean;
  approvedRefunds: Set<string>;
  idempotencyKeys: Record<string, string[]>;
  proposals: Record<string, { version: number; value: unknown; createdBy: string; changeReason: string; isAssumption: boolean }>;
  unmatched: string[];
  mfaPrompts: number;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, X-Request-Id',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'X-Request-Id, Retry-After, Idempotent-Replayed',
};

function tokensAt(mfa: boolean) {
  const exp = NOW_SEC + 900;
  return {
    tokenType: 'Bearer',
    accessToken: F.jwt({ sub: F.ME_ID, exp, sid: 'sess-e2e', ...(mfa ? { mfa_at: NOW_SEC } : {}) }),
    accessTokenExpiresAt: new Date(exp * 1000).toISOString(),
    refreshToken: `rt-${Math.random().toString(36).slice(2)}`,
    refreshTokenExpiresAt: new Date((NOW_SEC + 30 * 86400) * 1000).toISOString(),
    sessionId: 'sess-e2e',
  };
}

function claims(auth: string | undefined): Record<string, unknown> | null {
  const t = auth?.replace(/^Bearer\s+/, '');
  const part = t?.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const SENSITIVE = /\/v1\/admin\/.*\/(approve|resolve|reveal-contact|suspend|reactivate|versions|activate|release|hold|retry|cancel|refund)$/;
const MONEY = /\/v1\/admin\/(refunds|payouts|transactions|disputes|settlement-accounts)\//;

export async function installMockApi(page: Page) {
  const state: MockState = { forceMfaStale: false, approvedRefunds: new Set(), idempotencyKeys: {}, proposals: {}, unmatched: [], mfaPrompts: 0 };
  F.configState.approved = false;

  const reply = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', headers: { ...CORS, 'X-Request-Id': `req-${Math.random().toString(36).slice(2, 10)}` }, body: JSON.stringify(body) });
  const error = (route: Route, status: number, code: string, message: string) => reply(route, status, { error: { code, message, details: {}, requestId: `req-${code.toLowerCase()}` } });

  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const auth = req.headers()['authorization'];
    const body = (() => {
      try {
        return req.postDataJSON() as Record<string, unknown>;
      } catch {
        return {};
      }
    })();

    // ---------------------------------------------------------------- auth (public)
    if (method === 'POST' && path === '/v1/auth/otp/request') {
      return reply(route, 200, { challengeId: 'ch-1', expiresAt: new Date((NOW_SEC + 300) * 1000).toISOString(), resendAvailableAt: new Date((NOW_SEC + 60) * 1000).toISOString(), devCode: '424242' });
    }
    if (method === 'POST' && path === '/v1/auth/otp/verify') {
      if (body.code !== '424242') return error(route, 400, 'OTP_INVALID', 'Kode OTP salah');
      return reply(route, 200, { purpose: 'LOGIN', verified: true, user: F.profile, tokens: tokensAt(false), isNewUser: false });
    }
    if (method === 'POST' && path === '/v1/auth/refresh') return reply(route, 200, { tokens: tokensAt(false) });

    // ---------------------------------------------------------------- authenticated
    const c = claims(auth);
    if (!c || typeof c.exp !== 'number' || c.exp < NOW_SEC) return error(route, 401, 'UNAUTHORIZED', 'Sesi berakhir');

    if (method === 'POST' && path === '/v1/auth/mfa/verify') {
      state.mfaPrompts++;
      if (body.code !== '123456' && body.recoveryCode !== 'RECOV-ERY1') return error(route, 400, 'MFA_CODE_INVALID', 'Kode TOTP salah');
      state.forceMfaStale = false;
      const t = tokensAt(true);
      return reply(route, 200, { accessToken: t.accessToken, accessTokenExpiresAt: t.accessTokenExpiresAt, mfaAt: NOW_SEC, method: 'TOTP' });
    }
    if (method === 'POST' && path === '/v1/auth/logout') return reply(route, 200, { ok: true });
    if (method === 'GET' && path === '/v1/me') return reply(route, 200, F.profile);

    if (method !== 'GET' && MONEY.test(path)) {
      // every attempt, including the ones the MFA check rejects before the idempotency middleware runs
      const key = req.headers()['idempotency-key'];
      if (key) (state.idempotencyKeys[path] ??= []).push(key);
    }
    if (method !== 'GET' && SENSITIVE.test(path)) {
      const fresh = typeof c.mfa_at === 'number' && NOW_SEC - c.mfa_at <= 900;
      if (state.forceMfaStale || !fresh) return error(route, 403, 'MFA_REQUIRED', 'Verifikasi MFA diperlukan untuk aksi ini');
    }
    if (method !== 'GET' && MONEY.test(path)) {
      const key = req.headers()['idempotency-key'];
      if (!key) return error(route, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Header Idempotency-Key wajib untuk aksi finansial');
    }

    const q = url.searchParams;
    // dashboard & system
    if (path === '/v1/admin/dashboard/kpis') return reply(route, 200, F.kpis(q.get('from') ?? '2026-08-29', q.get('to') ?? '2026-09-27'));
    if (path === '/v1/admin/dashboard/timeseries') return reply(route, 200, F.timeseries(q.get('metric') ?? 'gmv', q.get('interval') ?? 'day', q.get('from') ?? '2026-08-29', q.get('to') ?? '2026-09-27'));
    if (path === '/v1/admin/dashboard/funnel') return reply(route, 200, F.funnel(q.get('from') ?? '2026-08-29', q.get('to') ?? '2026-09-27'));
    if (path === '/v1/admin/system/health') return reply(route, 200, F.systemHealth);
    if (path === '/v1/admin/system/alerts') return reply(route, 200, F.alerts);

    // transactions & refunds
    if (method === 'GET' && path === '/v1/admin/transactions') return reply(route, 200, F.transactions);
    if (method === 'GET' && path === `/v1/admin/transactions/${F.TX_ID}`) return reply(route, 200, F.transactionDetail);
    if (method === 'GET' && path === '/v1/admin/refunds') return reply(route, 200, F.refunds(state.approvedRefunds));
    const ra = /^\/v1\/admin\/refunds\/([^/]+)\/approve$/.exec(path);
    if (method === 'POST' && ra) {
      const r = F.refunds(new Set()).data.find((x) => x.id === ra[1]);
      if (!r) return error(route, 404, 'REFUND_NOT_FOUND', 'Refund tidak ditemukan');
      if (r.requestedBy === F.ME_ID) return error(route, 403, 'MAKER_CHECKER_VIOLATION', 'Refund harus disetujui oleh admin yang berbeda dari pengaju (maker-checker)');
      state.approvedRefunds.add(r.id);
      return reply(route, 200, { id: r.id, status: 'PROCESSING', approvedBy: F.ME_ID, processed: 1 });
    }

    // config
    if (method === 'GET' && path === '/v1/admin/config') return reply(route, 200, F.configList());
    const cd = /^\/v1\/admin\/config\/([^/]+)(\/diff)?$/.exec(path);
    if (method === 'GET' && cd) {
      const key = decodeURIComponent(cd[1]!);
      if (key === 'pricing.platform_fee') return reply(route, 200, cd[2] ? F.configDiff(Number(q.get('version')), q.get('against') ? Number(q.get('against')) : undefined) : F.configDetail());
      if (!(key in DEFAULTS)) return error(route, 404, 'CONFIG_KEY_UNKNOWN', 'Config key tidak dikenal');
      const active = { id: `cfg-${key}-v1`, key, version: 1, value: DEFAULTS[key], status: 'ACTIVE', effectiveFrom: '2026-06-01T00:00:00Z', changeReason: 'Seed default (business-config.defaults.json)', isAssumption: false, notes: null, createdBy: null, approvedBy: null, approvedAt: null, rejectedReason: null, supersededAt: null, createdAt: '2026-06-01T00:00:00Z' };
      const p = state.proposals[key];
      const history = [
        ...(p ? [{ ...active, id: `cfg-${key}-v${p.version}`, version: p.version, value: p.value, status: 'PENDING_APPROVAL', changeReason: p.changeReason, isAssumption: p.isAssumption, createdBy: p.createdBy, createdAt: F.NOW.toISOString(), diffFromActive: diff(active.value, p.value) }] : []),
        { ...active, diffFromActive: [] },
      ];
      return reply(route, 200, { key, active, history });
    }
    const pv = /^\/v1\/admin\/config\/([^/]+)\/versions$/.exec(path);
    if (method === 'POST' && pv) {
      const key = decodeURIComponent(pv[1]!);
      if (state.proposals[key]) return error(route, 409, 'CONFIG_PROPOSAL_PENDING', 'Versi 2 masih menunggu persetujuan');
      if (!body.changeReason) return error(route, 400, 'VALIDATION_ERROR', 'changeReason wajib');
      state.proposals[key] = { version: 2, value: body.value, createdBy: F.ME_ID, changeReason: String(body.changeReason), isAssumption: !!body.isAssumption };
      return reply(route, 201, { id: `cfg-${key}-v2`, key, version: 2, value: body.value, status: 'PENDING_APPROVAL', effectiveFrom: F.NOW.toISOString(), changeReason: body.changeReason, isAssumption: !!body.isAssumption, notes: null, createdBy: F.ME_ID, approvedBy: null, approvedAt: null, rejectedReason: null, supersededAt: null, createdAt: F.NOW.toISOString(), diffFromActive: diff(DEFAULTS[key], body.value) });
    }
    const ca = /^\/v1\/admin\/config-versions\/([^/]+)\/approve$/.exec(path);
    if (method === 'POST' && ca) {
      if (ca[1] !== 'cfg-platform-fee-v3') return error(route, 403, 'MAKER_CHECKER_VIOLATION', 'Konfigurasi harus disetujui oleh admin yang berbeda dari pengusul (maker-checker)');
      F.configState.approved = true;
      return reply(route, 200, F.configDetail().active);
    }

    // DB & infra
    if (path === '/v1/admin/infra/db/health') return reply(route, 200, F.dbHealth);
    if (path === '/v1/admin/infra/db/provider') return reply(route, 200, F.provider);
    if (path === '/v1/admin/infra/db/migrations') return reply(route, 200, F.migrations);
    if (path === '/v1/admin/infra/db/storage') return reply(route, 200, F.storage);
    if (path === '/v1/admin/infra/db/backups') return reply(route, 200, F.backups);
    if (path === '/v1/admin/infra/db/operations') return reply(route, 200, q.get('type') === 'MIGRATION' ? { data: [F.operations.data[0]], nextCursor: null } : F.operations);
    if (path === `/v1/admin/infra/db/operations/${F.workflow.id}`) return reply(route, 200, F.workflow);

    state.unmatched.push(`${method} ${path}`);
    return error(route, 404, 'NOT_FOUND', `mock: ${method} ${path}`);
  });
  return { state };
}

function diff(a: unknown, b: unknown, path = ''): { path: string; op: string; before?: unknown; after?: unknown }[] {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((k) => {
      const p = path ? `${path}.${k}` : k;
      if (!(k in a)) return [{ path: p, op: 'added', after: b[k] }];
      if (!(k in b)) return [{ path: p, op: 'removed', before: a[k] }];
      return diff(a[k], b[k], p);
    });
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path: path || '$', op: 'changed', before: a, after: b }];
}

/** Starts the SPA already signed in (refresh token + passed TOTP gate in sessionStorage), clock frozen at NOW. */
export async function signedIn(page: Page) {
  await page.clock.setFixedTime(F.NOW);
  await page.addInitScript(() => {
    window.sessionStorage.setItem('jk_admin_rt', 'rt-seed');
    window.sessionStorage.setItem('jk_admin_mfa_gate', '1');
  });
}
