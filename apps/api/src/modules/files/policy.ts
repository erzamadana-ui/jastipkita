/**
 * Upload policy per purpose (allowlisted content types, size limits, at-rest encryption) and
 * magic-byte sniffing. The declared Content-Type is never trusted: `complete` compares it with
 * the sniffed type of the stored bytes.
 */
export const MB = 1024 * 1024;

export const UPLOAD_PURPOSES = ['KYC', 'RECEIPT', 'PRODUCT_PHOTO', 'TRIP_DOC', 'EVIDENCE', 'AVATAR', 'CHAT', 'DELIVERY_PROOF'] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];
export type FilePurpose = UploadPurpose | 'EXPORT';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
export type AllowedType = (typeof IMAGE_TYPES)[number] | 'application/pdf' | 'video/mp4';

interface PurposePolicy {
  types: readonly AllowedType[];
  /** Encrypted with the AES-256-GCM envelope and only streamed through the API. */
  encrypted: boolean;
}

export const PURPOSE_POLICY: Record<UploadPurpose, PurposePolicy> = {
  KYC: { types: IMAGE_TYPES, encrypted: true },
  AVATAR: { types: IMAGE_TYPES, encrypted: false },
  PRODUCT_PHOTO: { types: IMAGE_TYPES, encrypted: false },
  CHAT: { types: IMAGE_TYPES, encrypted: false },
  DELIVERY_PROOF: { types: IMAGE_TYPES, encrypted: false },
  RECEIPT: { types: [...IMAGE_TYPES, 'application/pdf'], encrypted: false },
  // the DB requires TRIP_DOC (e-tickets, boarding passes) to be encrypted like KYC
  TRIP_DOC: { types: [...IMAGE_TYPES, 'application/pdf'], encrypted: true },
  EVIDENCE: { types: [...IMAGE_TYPES, 'video/mp4'], encrypted: false },
};

export function maxBytesFor(type: AllowedType): number {
  return type === 'video/mp4' ? 50 * MB : 10 * MB;
}

export function isEncryptedPurpose(p: FilePurpose): boolean {
  return p === 'EXPORT' ? true : PURPOSE_POLICY[p].encrypted;
}

/** Purposes whose files counterparties of a transaction may see. */
export const COUNTERPARTY_PURPOSES: readonly FilePurpose[] = ['RECEIPT', 'PRODUCT_PHOTO', 'DELIVERY_PROOF', 'CHAT', 'EVIDENCE'];

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'M4A ', 'f4v ', 'mmp4', 'MSNV', 'NDAS', '3gp4', '3gp5']);

const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.subarray(start, end));

/** Returns the content type implied by the file signature, or null if unknown/not allowed. */
export function sniffContentType(b: Uint8Array): AllowedType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return 'image/png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 5 && ascii(b, 0, 5) === '%PDF-') return 'application/pdf';
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const major = ascii(b, 8, 12);
    if (HEIC_BRANDS.has(major)) return 'image/heic';
    if (MP4_BRANDS.has(major)) return 'video/mp4';
    // compatible brands (after minor version) decide ambiguous majors
    const boxSize = (b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!;
    const end = Math.min(b.length, Math.max(16, boxSize));
    for (let i = 16; i + 4 <= end; i += 4) {
      const brand = ascii(b, i, i + 4);
      if (HEIC_BRANDS.has(brand)) return 'image/heic';
      if (MP4_BRANDS.has(brand)) return 'video/mp4';
    }
  }
  return null;
}

export function extensionFor(type: string): string {
  switch (type) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/heic':
      return 'heic';
    case 'application/pdf':
      return 'pdf';
    case 'video/mp4':
      return 'mp4';
    case 'application/json':
      return 'json';
    default:
      return 'bin';
  }
}
