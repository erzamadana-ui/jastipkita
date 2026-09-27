/**
 * Bootstrap CLI: grants SUPER_ADMIN (or another admin role) to an EXISTING user. It never creates accounts or
 * passwords — the person signs up normally first (OTP / OAuth), then an operator runs:
 *
 *   cd apps/api && DATABASE_URL=postgres://<migrator>@<host>/<db> npx tsx scripts/create-admin.ts --email ops@jastipkita.id
 *   ... --role OPERATIONS --reason "Tim ops batch 1"      # any role code from the roles table
 *   ... --dry-run                                          # show what would happen, change nothing
 *
 * Safety rules
 *   - Bootstrap only for privileged roles (SUPER_ADMIN / FINANCE_SUPER_ADMIN): refused when an ACTIVE SUPER_ADMIN
 *     already exists — use the maker-checker flow instead (POST /v1/admin/users/{id}/roles + approval by another
 *     SUPER_ADMIN). `--break-glass` overrides this for incident recovery; it is audited and raises a CRITICAL
 *     security event.
 *   - The target must be ACTIVE and have a verified e-mail; the grant is written to user_roles (granted_by NULL = CLI)
 *     and to the hash-chained audit log (actor_type SYSTEM, action rbac.role_granted_cli).
 *   - Nothing secret is printed. DATABASE_URL is read from the environment only.
 *   - Admin routes require a fresh MFA step-up for sensitive actions: the new admin must enrol TOTP
 *     (POST /v1/auth/mfa/totp/enroll → /confirm) before using sensitive admin endpoints.
 */
import postgres from 'postgres';

const PRIVILEGED = new Set(['SUPER_ADMIN', 'FINANCE_SUPER_ADMIN']);

interface Args {
  email: string;
  role: string;
  reason: string;
  dryRun: boolean;
  breakGlass: boolean;
}

export function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const email = (get('--email') ?? argv.find((a) => a.includes('@') && !a.startsWith('--')) ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('usage: create-admin.ts --email <user e-mail> [--role SUPER_ADMIN] [--reason "..."] [--dry-run] [--break-glass]');
  const role = (get('--role') ?? 'SUPER_ADMIN').trim().toUpperCase();
  if (!/^[A-Z][A-Z_]{2,40}$/.test(role)) throw new Error(`invalid role code: ${role}`);
  const reason = (get('--reason') ?? 'bootstrap via scripts/create-admin.ts').trim();
  if (reason.length < 5) throw new Error('--reason must have at least 5 characters');
  return { email, role, reason, dryRun: argv.includes('--dry-run'), breakGlass: argv.includes('--break-glass') };
}

export async function createAdmin(sql: postgres.Sql, a: Args): Promise<{ status: string; userId?: string; message: string }> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('jk.actor_type', 'SYSTEM', true), set_config('jk.request_id', 'cli:create-admin', true)`;
    const [role] = await tx<{ code: string }[]>`SELECT code FROM roles WHERE code = ${a.role}`;
    if (!role) return { status: 'ERROR', message: `role ${a.role} does not exist` };
    const [u] = await tx<{ id: string; status: string; email_verified_at: Date | null }[]>`
      SELECT id, status, email_verified_at FROM users WHERE email = ${a.email} FOR UPDATE`;
    if (!u) return { status: 'ERROR', message: `no user with e-mail ${a.email} — the person must sign up in the app first (this CLI never creates accounts)` };
    if (u.status !== 'ACTIVE') return { status: 'ERROR', userId: u.id, message: `user is ${u.status}; only ACTIVE users can become admins` };
    if (!u.email_verified_at) return { status: 'ERROR', userId: u.id, message: 'e-mail is not verified yet' };
    const [has] = await tx`SELECT 1 FROM user_roles WHERE user_id = ${u.id} AND role_code = ${a.role} AND revoked_at IS NULL`;
    if (has) return { status: 'NOOP', userId: u.id, message: `${a.email} already has ${a.role}` };
    if (PRIVILEGED.has(a.role)) {
      const [n] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM user_roles ur JOIN users x ON x.id = ur.user_id
         WHERE ur.role_code = 'SUPER_ADMIN' AND ur.revoked_at IS NULL AND x.status = 'ACTIVE'`;
      if ((n?.n ?? 0) > 0 && !a.breakGlass) {
        return {
          status: 'REFUSED',
          userId: u.id,
          message: `an active SUPER_ADMIN already exists: grant ${a.role} through the admin UI (maker-checker, second SUPER_ADMIN approves). Use --break-glass only for incident recovery.`,
        };
      }
    }
    if (a.dryRun) return { status: 'DRY_RUN', userId: u.id, message: `would grant ${a.role} to ${a.email}${a.breakGlass ? ' (break-glass)' : ''}` };
    await tx`INSERT INTO user_roles (user_id, role_code, granted_by, reason) VALUES (${u.id}, ${a.role}, NULL, ${`${a.reason} [cli]`})`;
    await tx`SELECT jk_audit('SYSTEM', NULL, 'rbac.role_granted_cli', 'user', ${u.id}, NULL,
                             ${tx.json({ roleCode: a.role } as never)}::jsonb,
                             ${tx.json({ reason: a.reason, breakGlass: a.breakGlass, tool: 'scripts/create-admin.ts' } as never)}::jsonb)`;
    if (a.breakGlass) {
      await tx`INSERT INTO security_events (user_id, type, severity, meta)
               VALUES (${u.id}, 'ADMIN_BREAK_GLASS_GRANT', 'CRITICAL', ${tx.json({ roleCode: a.role, reason: a.reason } as never)})`;
    }
    return { status: 'GRANTED', userId: u.id, message: `granted ${a.role} to ${a.email}` };
  });
}

const isMain = process.argv[1] && import.meta.filename === process.argv[1];
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required (use the migrator/owner role; it is never printed)');
    process.exit(2);
  }
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const out = await createAdmin(sql, args);
    console.log(`[${out.status}] ${out.message}${out.userId ? ` (user ${out.userId})` : ''}`);
    if (out.status === 'GRANTED' || out.status === 'DRY_RUN') {
      console.log('Next: the admin signs in, enrols TOTP (POST /v1/auth/mfa/totp/enroll → /confirm) and steps up with');
      console.log('POST /v1/auth/mfa/verify before sensitive admin actions (fresh MFA ≤ 15 min is enforced).');
    }
    process.exitCode = out.status === 'GRANTED' || out.status === 'NOOP' || out.status === 'DRY_RUN' ? 0 : 1;
  } finally {
    await sql.end({ timeout: 2 });
  }
}
