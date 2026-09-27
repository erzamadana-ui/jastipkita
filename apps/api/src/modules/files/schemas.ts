import { z } from '@hono/zod-openapi';
import { UPLOAD_PURPOSES } from './policy';

export const FileStatus = z.enum(['PENDING_UPLOAD', 'READY', 'REJECTED', 'INFECTED', 'DELETED']);

export const FileSchema = z
  .object({
    id: z.string().uuid(),
    purpose: z.enum([...UPLOAD_PURPOSES, 'EXPORT']),
    contentType: z.string(),
    sizeBytes: z.number().int(),
    status: FileStatus,
    encrypted: z.boolean().openapi({ description: 'Encrypted at rest (KYC, TRIP_DOC, EXPORT) — streamed only through the API' }),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
  })
  .openapi('File');

export const CreateUploadBody = z
  .object({
    purpose: z.enum(UPLOAD_PURPOSES),
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf', 'video/mp4']),
    sizeBytes: z.number().int().min(1).max(50 * 1024 * 1024),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .openapi({ description: 'Optional hex SHA-256 of the file; verified on complete' }),
  })
  .openapi('CreateUpload');

export const CreateUploadResponse = z
  .object({
    fileId: z.string().uuid(),
    upload: z.object({
      url: z.string(),
      method: z.literal('PUT'),
      headers: z.record(z.string(), z.string()).openapi({ description: 'Send exactly these headers with the PUT' }),
    }),
    expiresAt: z.string(),
    maxBytes: z.number().int(),
  })
  .openapi('UploadTicket');

export const DownloadResponse = z
  .object({
    url: z.string(),
    method: z.literal('GET'),
    requiresAuth: z.boolean().openapi({ description: 'true → call the URL with the bearer token (encrypted files are streamed by the API)' }),
    expiresAt: z.string().nullable(),
  })
  .openapi('FileDownload');
