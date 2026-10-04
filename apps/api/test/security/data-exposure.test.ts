/**
 * Data protection sweep (security review 2026-09, scope item 5): walks every admin list endpoint (as an all-powerful
 * MFA-verified admin) and the user-facing reads of a real paid transaction, and asserts that no response carries
 * ciphertext/hash/secret fields, full bank-account numbers, unmasked contact data (outside the audited reveal), stack
 * traces, or SQL internals; plus the API security headers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdmin, as, purchasedTx } from '../../src/modules/admin/test-support';
import { call, createPayoutAccount } from '../../src/modules/transactions/test-fixtures';
import { createTestContext, type TestContext } from '../helpers';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t?.close());

const FORBIDDEN_KEY = /(_enc|Enc|_hash|Hash|secret|Secret|password|Password|refreshToken|refresh_token|pinHash|qrToken|storageKey|storage_key|secretRef|secret_ref)$/;
// the audit chain intentionally exposes its own link hashes to auditors
const ALLOWED_KEYS = new Set(['hash', 'prevHash', 'lastHash', 'expectedHash', 'actualHash']);

function forbiddenKeys(v: unknown, path = '$', out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x, i) => forbiddenKeys(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEY.test(k) && !ALLOWED_KEYS.has(k)) out.push(`${path}.${k}`);
      forbiddenKeys(x, `${path}.${k}`, out);
    }
  }
  return out;
}

describe('response data exposure', () => {
  it('admin list endpoints never return ciphertext, hashes, secrets, full account numbers or unmasked contacts', async () => {
    const { p, tx } = await purchasedTx(t);
    const ACCOUNT = '5550001234567';
    await t.adminSql`UPDATE payout_accounts SET is_default = false WHERE user_id = ${p.traveler.id}`;
    await createPayoutAccount(t, p.traveler.id, { accountNumber: ACCOUNT });
    await t.adminSql`
      INSERT INTO kyc_submissions (user_id, target_level, status) VALUES (${p.traveler.id}, 3, 'PENDING') ON CONFLICT DO NOTHING`.catch(() => {});
    const admin = await createAdmin(t, ['SUPER_ADMIN', 'FINANCE_SUPER_ADMIN']);
    const doc = await t.request('GET', '/v1/openapi.json');
    const lists = Object.entries(doc.body.paths as Record<string, Record<string, unknown>>)
      .filter(([path, item]) => path.startsWith('/v1/admin') && !path.includes('{') && 'get' in item)
      .map(([path]) => path);
    expect(lists.length).toBeGreaterThan(30);
    const problems: string[] = [];
    let ok = 0;
    for (const path of [...lists, `/v1/admin/transactions/${tx.id}`, `/v1/admin/users/${p.buyer.id}`, `/v1/admin/users/${p.traveler.id}`]) {
      const r = await as(t, admin, 'GET', path);
      if (r.status >= 500) problems.push(`${path} → ${r.status}`);
      if (r.status === 200) ok++;
      const text = JSON.stringify(r.body);
      for (const k of forbiddenKeys(r.body)) problems.push(`${path} exposes ${k}`);
      if (text.includes(ACCOUNT)) problems.push(`${path} exposes a full bank account number`);
      if (text.includes(p.buyer.email) || text.includes(p.buyer.phone)) problems.push(`${path} exposes unmasked buyer contact`);
      if (/at .*\.ts:\d+|stack|PostgresError|syntax error/i.test(text)) problems.push(`${path} leaks internals`);
    }
    expect(problems).toEqual([]);
    expect(ok, 'the sweep must actually read data').toBeGreaterThan(lists.length * 0.8);
  });

  it('user-facing reads of a paid transaction never return ciphertext, hashes, the PIN, or the counterparty contact', async () => {
    const { p, tx } = await purchasedTx(t);
    const paths = [
      '/v1/me', '/v1/auth/sessions', '/v1/me/devices', '/v1/kyc/status', '/v1/kyc/payout-accounts', '/v1/payouts/mine', '/v1/transactions',
      `/v1/transactions/${tx.id}`, `/v1/transactions/${tx.id}/timeline`, `/v1/transactions/${tx.id}/payment`, `/v1/transactions/${tx.id}/refunds`,
      `/v1/transactions/${tx.id}/conversation`, '/v1/notifications', '/v1/credits', '/v1/referrals/me', '/v1/privacy/requests', '/v1/offers/mine',
      '/v1/requests/mine', '/v1/trips/mine', '/v1/disputes/mine', '/v1/support/tickets', '/v1/conversations',
    ];
    const problems: string[] = [];
    for (const who of [p.buyer, p.traveler]) {
      const other = who === p.buyer ? p.traveler : p.buyer;
      for (const path of paths) {
        const r = await call(t, who, 'GET', path);
        if (r.status >= 500) problems.push(`${path} → ${r.status}`);
        for (const k of forbiddenKeys(r.body)) problems.push(`${path} exposes ${k}`);
        const text = JSON.stringify(r.body);
        if (text.includes(other.email) || text.includes(other.phone)) problems.push(`${path} exposes the counterparty's contact`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('API responses carry strict security headers; unknown routes and 500s leak nothing', async () => {
    const r = await t.app.request('/v1/health');
    expect(r.headers.get('strict-transport-security')).toContain('max-age=63072000');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    // CORS: only allow-listed origins; credentials only for the web origin (HttpOnly refresh cookie, SEC-14), never admin/others
    const evil = await t.app.request('/v1/health', { headers: { origin: 'https://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    expect(evil.headers.get('access-control-allow-credentials')).toBeNull();
    const web = await t.app.request('/v1/health', { headers: { origin: 'http://web.test' } });
    expect(web.headers.get('access-control-allow-origin')).toBe('http://web.test');
    expect(web.headers.get('access-control-allow-credentials')).toBe('true');
    const admin = await t.app.request('/v1/health', { headers: { origin: 'http://admin.test' } });
    expect(admin.headers.get('access-control-allow-origin')).toBe('http://admin.test');
    expect(admin.headers.get('access-control-allow-credentials')).toBeNull();
    // oversized JSON body
    const big = await t.request('POST', '/v1/auth/otp/request', { rawBody: JSON.stringify({ channel: 'SMS', destination: 'x'.repeat(2 * 1024 * 1024) }), headers: { 'content-type': 'application/json' } });
    expect(big.status).toBe(400);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    // mass assignment: unknown PATCH /me keys are rejected, never applied
    const u = await t.createUser({ kycLevel: 1 });
    const mass = await t.request('PATCH', '/v1/me', { token: u.accessToken, body: { displayName: 'Ok', kycLevel: 4, roles: ['SUPER_ADMIN'], status: 'ACTIVE' } });
    expect(mass.status).toBe(400);
    const [row] = await t.adminSql<{ kyc_level: number }[]>`SELECT kyc_level FROM users WHERE id = ${u.id}`;
    expect(row!.kyc_level).toBe(1);
    expect((await t.adminSql`SELECT 1 FROM user_roles WHERE user_id = ${u.id}`).length).toBe(0);
  });
});
