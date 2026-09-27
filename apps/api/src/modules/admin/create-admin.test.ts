import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers';
import { createAdmin, parseArgs } from '../../../scripts/create-admin';

let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => {
  await t.close();
});

describe('scripts/create-admin.ts (bootstrap CLI)', () => {
  it('parses args and validates input', () => {
    expect(parseArgs(['--email', 'Ops@JastipKita.id'])).toMatchObject({ email: 'ops@jastipkita.id', role: 'SUPER_ADMIN', dryRun: false, breakGlass: false });
    expect(parseArgs(['ops@x.id', '--role', 'operations', '--dry-run'])).toMatchObject({ role: 'OPERATIONS', dryRun: true });
    expect(() => parseArgs([])).toThrow(/usage/);
  });

  it('never creates accounts; bootstraps the first SUPER_ADMIN; refuses a second without --break-glass (maker-checker instead)', async () => {
    const missing = await createAdmin(t.adminSql, parseArgs(['--email', 'nobody@example.com']));
    expect(missing.status).toBe('ERROR');
    const [cnt] = await t.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE email = 'nobody@example.com'`;
    expect(cnt!.n).toBe(0);

    const first = await t.createUser({ kycLevel: 2 });
    const dry = await createAdmin(t.adminSql, parseArgs(['--email', first.email, '--dry-run']));
    expect(dry.status).toBe('DRY_RUN');
    expect(await t.adminSql`SELECT 1 FROM user_roles WHERE user_id = ${first.id}`).toHaveLength(0);

    const ok = await createAdmin(t.adminSql, parseArgs(['--email', first.email, '--reason', 'Pendiri — admin pertama']));
    expect(ok).toMatchObject({ status: 'GRANTED', userId: first.id });
    const [a] = await t.adminSql<{ actor_type: string; after: any }[]>`SELECT actor_type, after FROM audit_logs WHERE action = 'rbac.role_granted_cli' AND entity_id = ${first.id}`;
    expect(a).toMatchObject({ actor_type: 'SYSTEM', after: { roleCode: 'SUPER_ADMIN' } });
    expect((await createAdmin(t.adminSql, parseArgs(['--email', first.email]))).status).toBe('NOOP');

    const second = await t.createUser({ kycLevel: 2 });
    const refused = await createAdmin(t.adminSql, parseArgs(['--email', second.email]));
    expect(refused.status).toBe('REFUSED');
    const bg = await createAdmin(t.adminSql, parseArgs(['--email', second.email, '--break-glass', '--reason', 'Insiden: admin utama terkunci']));
    expect(bg.status).toBe('GRANTED');
    const sec = await t.adminSql`SELECT 1 FROM security_events WHERE type = 'ADMIN_BREAK_GLASS_GRANT' AND user_id = ${second.id} AND severity = 'CRITICAL'`;
    expect(sec).toHaveLength(1);
    // non-privileged roles never need break-glass
    const third = await t.createUser({ kycLevel: 2 });
    expect((await createAdmin(t.adminSql, parseArgs(['--email', third.email, '--role', 'SUPPORT']))).status).toBe('GRANTED');
  });
});
