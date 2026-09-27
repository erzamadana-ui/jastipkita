import { describe, expect, it } from 'vitest';
import { computeManifest } from '../../../scripts/gen-migration-manifest';
import { MIGRATION_MANIFEST } from './migration-manifest';

describe('build migration manifest', () => {
  it('is in sync with db/migrations (regenerate: cd apps/api && npx tsx scripts/gen-migration-manifest.ts)', () => {
    expect(MIGRATION_MANIFEST).toEqual(computeManifest());
  });

  it('versions are unique and ordered', () => {
    const v = MIGRATION_MANIFEST.map((m) => m.version);
    expect(new Set(v).size).toBe(v.length);
    expect([...v].sort()).toEqual(v);
    for (const m of MIGRATION_MANIFEST) expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
