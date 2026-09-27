/**
 * Neon (serverless Postgres) adapter for the DB & Infra Center — Neon API v2 (https://api-docs.neon.tech/reference):
 *   info()          GET  /projects/{project_id}                → region, Postgres version, PITR window (history_retention_seconds)
 *   listBackups()   GET  /projects/{project_id}/branches       → non-default branches are the "backups"
 *   createBackup()  POST /projects/{project_id}/branches       → new branch from the default branch (copy-on-write snapshot)
 *   restoreToNew()  POST /projects/{project_id}/branches       → NEW branch from a backup branch and/or a point in time
 *                                                                (parent_timestamp); never restores in place
 * The API key is only sent in the Authorization header and never appears in errors, logs or return values.
 * `fetch` is injectable (unit tests use a fake; Workers/Node use the global fetch).
 */
import type { DbAdminProvider, DbBackup } from '../types';

export interface NeonOptions {
  apiKey: string;
  projectId: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface NeonBranch {
  id: string;
  name: string;
  parent_id?: string | null;
  parent_timestamp?: string | null;
  current_state?: string;
  created_at: string;
  logical_size?: number | null;
  default?: boolean;
  primary?: boolean;
  protected?: boolean;
}

export class NeonApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`NEON_API_ERROR ${status} ${code}`);
    this.name = 'NeonApiError';
  }
}

const BRANCH_NAME_RE = /[^a-z0-9-]+/g;

export class NeonDbAdminProvider implements DbAdminProvider {
  readonly name = 'neon';
  readonly capabilities = { backups: true, pitr: true, branching: true, replicationInfo: false };
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: NeonOptions) {
    if (!opts.apiKey || !opts.projectId) throw new Error('Neon adapter requires NEON_API_KEY and NEON_PROJECT_ID');
    this.baseUrl = (opts.baseUrl ?? 'https://console.neon.tech/api/v2').replace(/\/+$/, '');
    this.doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      let code = 'UNKNOWN';
      try {
        const j = (await res.json()) as { code?: string };
        if (typeof j.code === 'string') code = j.code.replace(/[^A-Za-z0-9_]/g, '').slice(0, 60) || 'UNKNOWN';
      } catch {
        /* non-JSON error body */
      }
      throw new NeonApiError(res.status, code);
    }
    return (await res.json()) as T;
  }

  private projectPath(suffix = '') {
    return `/projects/${encodeURIComponent(this.opts.projectId)}${suffix}`;
  }

  async info() {
    const { project } = await this.call<{ project: { id: string; name?: string; region_id?: string; pg_version?: number; history_retention_seconds?: number; owner?: { subscription_type?: string } } }>('GET', this.projectPath());
    const pitrWindowHours = typeof project.history_retention_seconds === 'number' ? Math.round((project.history_retention_seconds / 3600) * 10) / 10 : undefined;
    return {
      provider: 'neon',
      ...(project.region_id ? { region: project.region_id } : {}),
      ...(project.owner?.subscription_type ? { plan: project.owner.subscription_type } : {}),
      ...(pitrWindowHours !== undefined ? { pitrWindowHours } : {}),
      notes: [
        ...(project.pg_version ? [`PostgreSQL ${project.pg_version}`] : []),
        'Backup = branch Neon (copy-on-write); restore selalu ke branch BARU, tidak pernah menimpa branch produksi.',
        pitrWindowHours !== undefined ? `Point-in-time restore tersedia ${pitrWindowHours} jam ke belakang (history retention).` : 'History retention tidak dilaporkan API.',
      ],
    };
  }

  private toBackup(b: NeonBranch): DbBackup {
    return {
      id: b.id,
      createdAt: new Date(b.created_at),
      kind: 'BRANCH',
      ...(typeof b.logical_size === 'number' ? { sizeBytes: b.logical_size } : {}),
      status: (b.current_state ?? 'unknown').toUpperCase(),
    };
  }

  async listBackups(): Promise<DbBackup[]> {
    const { branches } = await this.call<{ branches: NeonBranch[] }>('GET', this.projectPath('/branches'));
    return branches
      .filter((b) => !(b.default ?? b.primary ?? false))
      .map((b) => this.toBackup(b))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async createBackup(label: string): Promise<DbBackup> {
    const name = `backup-${label.toLowerCase().replace(BRANCH_NAME_RE, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'manual'}-${Date.now().toString(36)}`;
    const { branch } = await this.call<{ branch: NeonBranch }>('POST', this.projectPath('/branches'), { branch: { name } });
    return this.toBackup(branch);
  }

  async restoreToNew(input: { backupId?: string; pointInTime?: Date; label: string }): Promise<{ targetId: string; status: string }> {
    if (!input.backupId && !input.pointInTime) throw new Error('restoreToNew requires backupId and/or pointInTime');
    const name = `restore-${input.label.toLowerCase().replace(BRANCH_NAME_RE, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'restore'}-${Date.now().toString(36)}`;
    const branch: Record<string, unknown> = { name };
    if (input.backupId) branch.parent_id = input.backupId;
    if (input.pointInTime) branch.parent_timestamp = input.pointInTime.toISOString();
    const res = await this.call<{ branch: NeonBranch }>('POST', this.projectPath('/branches'), { branch });
    return { targetId: res.branch.id, status: (res.branch.current_state ?? 'init').toUpperCase() };
  }
}
