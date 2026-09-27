import { DEFAULT_BUSINESS_CONFIG, type BusinessConfig } from '@jastipkita/core';
import type { Db } from '../db/sql';
import type { Clock } from '../lib/clock';
import type { Logger } from '../lib/logger';

export type ConfigKey = keyof BusinessConfig;

interface CacheEntry {
  at: number;
  values: Map<string, { value: unknown; version: number }>;
}

/**
 * Reads ACTIVE business_configs (versioned, maker-checker approved in Admin) with a short cache so
 * changes apply without an app release. Falls back to packages/core defaults when a key is missing
 * (logged as a warning — seeds should always provide every key).
 */
/** Holder so several ConfigService instances (e.g. one per Workers request) can share one cache. */
export interface ConfigCacheHolder {
  cache: CacheEntry | null;
}

export class ConfigService {
  private readonly holder: ConfigCacheHolder;
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly ttlMs = 30_000,
    holder?: ConfigCacheHolder,
  ) {
    this.holder = holder ?? { cache: null };
  }

  private get cache(): CacheEntry | null {
    return this.holder.cache;
  }
  private set cache(v: CacheEntry | null) {
    this.holder.cache = v;
  }

  invalidate(): void {
    this.cache = null;
  }

  private async load(): Promise<CacheEntry> {
    const now = this.clock.now().getTime();
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache;
    const rows = await this.db<{ key: string; value: unknown; version: number }[]>`
      SELECT key, value, version FROM business_configs WHERE status = 'ACTIVE'`;
    const values = new Map<string, { value: unknown; version: number }>();
    for (const r of rows) values.set(r.key, { value: r.value, version: r.version });
    this.cache = { at: now, values };
    return this.cache;
  }

  async get<K extends ConfigKey>(key: K): Promise<BusinessConfig[K]> {
    const c = await this.load();
    const hit = c.values.get(key as string);
    if (hit) return hit.value as BusinessConfig[K];
    this.logger.warn('config.fallback_default', { key });
    return (DEFAULT_BUSINESS_CONFIG as BusinessConfig)[key];
  }

  /** Returns {key: version} for the given keys — stored on quotes for reproducibility. */
  async versions(keys: ConfigKey[]): Promise<Record<string, number>> {
    const c = await this.load();
    const out: Record<string, number> = {};
    for (const k of keys) out[k as string] = c.values.get(k as string)?.version ?? 0;
    return out;
  }
}
