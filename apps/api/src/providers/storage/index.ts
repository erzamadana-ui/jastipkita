// OWNER: identity/files module. Add the S3-compatible adapter here (./s3.ts, aws4fetch).
import type { Env } from '../../env';
import { MemoryStorageProvider } from '../mock';
import type { StorageProvider } from '../types';

export function createStorageProvider(env: Env): StorageProvider {
  switch (env.STORAGE_PROVIDER) {
    case 'memory':
      return new MemoryStorageProvider(env.API_BASE_URL);
    case 's3':
      throw new Error('S3 adapter not wired yet');
  }
}
