import postgres from 'postgres';

/**
 * Database access. The API talks to PostgreSQL through postgres.js (works on Node and
 * Cloudflare Workers with nodejs_compat). Repositories receive a `Sql` (pool) or a
 * `TxSql` (inside sql.begin) — both expose the same tagged-template interface.
 * Mobile/Web never talk to the DB: Client → API → service → repository → DB.
 */
export type Sql = postgres.Sql<Record<string, never>>;
export type TxSql = postgres.TransactionSql<Record<string, never>>;
export type Db = Sql | TxSql;

export interface CreateSqlOptions {
  max?: number;
  /** Cloudflare Workers: use a fresh connection per request (prepare=false for poolers like Neon/PgBouncer). */
  prepare?: boolean;
  onnotice?: (n: unknown) => void;
  application_name?: string;
}

export function createSql(url: string, opts: CreateSqlOptions = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    prepare: opts.prepare ?? true,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: opts.onnotice ?? (() => {}),
    connection: { application_name: opts.application_name ?? 'jastipkita-api' },
    types: {
      // bigint (int8) → JS number (IDR minor units are < 2^53); throws if unsafe.
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number | bigint) => x.toString(),
        parse: (x: string) => {
          const n = Number(x);
          if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${x} exceeds Number.MAX_SAFE_INTEGER`);
          return n;
        },
      },
    },
    transform: { undefined: null },
  }) as unknown as Sql;
}

/** Runs fn inside a transaction (or reuses the current one). */
export async function withTx<T>(db: Db, fn: (tx: TxSql) => Promise<T>): Promise<T> {
  if ('savepoint' in db && typeof (db as TxSql).savepoint === 'function' && !('begin' in db)) {
    return fn(db as TxSql);
  }
  return (db as Sql).begin((tx) => fn(tx as unknown as TxSql)) as Promise<T>;
}

/** Convert snake_case row keys to camelCase (shallow). */
export function camel<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = v;
  return out as T;
}

export function camelRows<T = Record<string, unknown>>(rows: readonly Record<string, unknown>[]): T[] {
  return rows.map((r) => camel<T>(r));
}

export function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
