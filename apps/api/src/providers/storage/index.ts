// OWNER: identity/files module.
import type { Env } from '../../env';
import { MemoryStorageProvider } from '../mock';
import type { StorageProvider } from '../types';
import { S3StorageProvider } from './s3';

export function createStorageProvider(env: Env): StorageProvider {
  switch (env.STORAGE_PROVIDER) {
    case 'memory':
      return new MemoryStorageProvider(env.API_BASE_URL);
    case 's3':
      // env.ts guarantees these are set when STORAGE_PROVIDER=s3
      return new S3StorageProvider({
        endpoint: env.S3_ENDPOINT!,
        bucket: env.S3_BUCKET!,
        region: env.S3_REGION,
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      });
  }
}
