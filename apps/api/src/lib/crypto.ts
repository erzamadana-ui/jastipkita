/**
 * Crypto primitives built only on WebCrypto (works on Node 22+ and Cloudflare Workers).
 * - AES-256-GCM envelope encryption for PII/KYC (versioned blob: v1 | kid | iv | ciphertext+tag)
 * - HMAC-SHA256 with a server pepper for searchable hashes of identifiers (phone, e-mail, ID numbers, IPs)
 * - CSPRNG tokens, SHA-256, constant-time comparison, TOTP (RFC 6238) for admin MFA
 * Passwords are intentionally NOT supported: e-mail and phone login are passwordless (OTP / magic code).
 */

const te = new TextEncoder();
const td = new TextDecoder();

export type Bytes = Uint8Array<ArrayBuffer>;

export function toBytes(v: string | Uint8Array): Bytes {
  return typeof v === "string" ? te.encode(v) : (new Uint8Array(v) as Bytes);
}

export function bytesToHex(b: Bytes): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Bytes {
  if (hex.length % 2 !== 0) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function base64UrlEncode(b: Bytes): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Bytes {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64Decode(s: string): Bytes {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Bytes {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** URL-safe random token (default 32 bytes = 256 bits). */
export function randomToken(bytes = 32): string {
  return base64UrlEncode(randomBytes(bytes));
}

export async function sha256(data: string | Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toBytes(data)));
}

export async function sha256Hex(data: string | Bytes): Promise<string> {
  return bytesToHex(await sha256(data));
}

export function timingSafeEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  return timingSafeEqual(te.encode(a), te.encode(b));
}

async function hmacKey(secret: Bytes, hash: 'SHA-256' | 'SHA-1' = 'SHA-256'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash }, false, ['sign']);
}

export async function hmac(secret: string | Bytes, data: string | Bytes, hash: 'SHA-256' | 'SHA-1' = 'SHA-256'): Promise<Bytes> {
  const key = await hmacKey(toBytes(secret), hash);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, toBytes(data)));
}

interface KeyEntry {
  kid: string;
  key: CryptoKey;
}

/**
 * Service wrapping the configured keys. Construct once per process/isolate.
 * Blob format: [0x01][kidLen:1][kid bytes][iv:12][ciphertext||tag]
 */
export class CryptoService {
  private constructor(
    private readonly keys: KeyEntry[],
    private readonly pepper: Bytes,
  ) {}

  static async create(dataEncryptionKeys: string, hmacPepper: string): Promise<CryptoService> {
    const entries = dataEncryptionKeys
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (entries.length === 0) throw new Error('DATA_ENCRYPTION_KEYS is empty');
    const keys: KeyEntry[] = [];
    for (const e of entries) {
      const idx = e.indexOf(':');
      if (idx <= 0) throw new Error('DATA_ENCRYPTION_KEYS entries must be kid:base64key');
      const kid = e.slice(0, idx);
      const raw = base64Decode(e.slice(idx + 1));
      if (raw.length !== 32) throw new Error(`encryption key ${kid} must be 32 bytes (AES-256)`);
      if (kid.length > 32) throw new Error('kid too long');
      const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      keys.push({ kid, key });
    }
    return new CryptoService(keys, te.encode(hmacPepper));
  }

  get activeKeyId(): string {
    return this.keys[0]!.kid;
  }

  /** Encrypts with the active key. `aad` binds ciphertext to context (e.g., "users.phone:<userId>"). */
  async encrypt(plaintext: string | Bytes, aad?: string): Promise<Bytes> {
    const { kid, key } = this.keys[0]!;
    const iv = randomBytes(12);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv, ...(aad ? { additionalData: te.encode(aad) } : {}) }, key, toBytes(plaintext)),
    );
    const kidBytes = te.encode(kid);
    const out = new Uint8Array(2 + kidBytes.length + 12 + ct.length);
    out[0] = 1;
    out[1] = kidBytes.length;
    out.set(kidBytes, 2);
    out.set(iv, 2 + kidBytes.length);
    out.set(ct, 2 + kidBytes.length + 12);
    return out;
  }

  async decrypt(blob: Bytes, aad?: string): Promise<Bytes> {
    if (blob[0] !== 1) throw new Error('unsupported ciphertext version');
    const kidLen = blob[1]!;
    const kid = td.decode(blob.slice(2, 2 + kidLen));
    const entry = this.keys.find((k) => k.kid === kid);
    if (!entry) throw new Error(`unknown encryption key ${kid}`);
    const iv = blob.slice(2 + kidLen, 2 + kidLen + 12);
    const ct = blob.slice(2 + kidLen + 12);
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv, ...(aad ? { additionalData: te.encode(aad) } : {}) }, entry.key, ct),
    );
  }

  async encryptString(plaintext: string, aad?: string): Promise<Bytes> {
    return this.encrypt(plaintext, aad);
  }

  async decryptString(blob: Bytes, aad?: string): Promise<string> {
    return td.decode(await this.decrypt(blob, aad));
  }

  /** Deterministic, peppered hash for lookups/dedupe. Normalize input before hashing. */
  async hashIdentifier(kind: string, value: string): Promise<Bytes> {
    return hmac(this.pepper, `${kind}:${value}`);
  }
}

// ---------------------------------------------------------------- TOTP (RFC 6238)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(b: Bytes): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of b) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Bytes {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export async function totpAt(secretB32: string, step: number, digits = 6): Promise<string> {
  const msg = new Uint8Array(8);
  let s = step;
  for (let i = 7; i >= 0; i--) {
    msg[i] = s & 0xff;
    s = Math.floor(s / 256);
  }
  const mac = await hmac(base32Decode(secretB32), msg, 'SHA-1');
  const offset = mac[mac.length - 1]! & 0x0f;
  const code =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) | ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

/**
 * Verifies a TOTP code within ±window steps. Returns the matched step (store it to prevent replay:
 * reject any code whose step ≤ last used step) or null.
 */
export async function verifyTotp(secretB32: string, code: string, now: Date, window = 1, periodSec = 30): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now.getTime() / 1000 / periodSec);
  for (let w = -window; w <= window; w++) {
    const candidate = await totpAt(secretB32, current + w);
    if (timingSafeEqualStr(candidate, code)) return current + w;
  }
  return null;
}

export function totpUri(secretB32: string, account: string, issuer: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** Numeric one-time code with rejection sampling (unbiased). */
export function numericCode(length = 6): string {
  let out = '';
  while (out.length < length) {
    const b = randomBytes(1)[0]!;
    if (b < 250) out += String(b % 10);
  }
  return out;
}
