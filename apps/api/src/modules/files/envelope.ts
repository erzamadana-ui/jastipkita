/**
 * Object envelope encryption (AES-256-GCM) for KYC / trip documents / privacy exports.
 *
 *   blob = "JKE1" | u16be(len(wrappedDek)) | wrappedDek | iv(12) | ciphertext‖tag
 *
 * A fresh 256-bit data key (DEK) encrypts the object; the DEK is wrapped with the active key-encryption
 * key through deps.crypto.encrypt (which records the KEK id → rotation = re-wrap the DEK only). Both the
 * wrap and the content use AAD "files.object:<fileId>", so a blob cannot be swapped between files.
 */
import type { AppDeps } from '../../context';
import { randomBytes } from '../../lib/crypto';

const MAGIC = [0x4a, 0x4b, 0x45, 0x31]; // "JKE1"
const te = new TextEncoder();

export const objectAad = (fileId: string) => `files.object:${fileId}`;

export async function encryptObject(deps: AppDeps, fileId: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const aad = te.encode(objectAad(fileId));
  const dek = randomBytes(32);
  const key = await crypto.subtle.importKey('raw', dek, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, new Uint8Array(plaintext)));
  const wrapped = await deps.crypto.encrypt(dek, objectAad(fileId));
  dek.fill(0);
  const out = new Uint8Array(4 + 2 + wrapped.length + 12 + ct.length);
  out.set(MAGIC, 0);
  out[4] = (wrapped.length >> 8) & 0xff;
  out[5] = wrapped.length & 0xff;
  out.set(wrapped, 6);
  out.set(iv, 6 + wrapped.length);
  out.set(ct, 6 + wrapped.length + 12);
  return out;
}

export function isEnvelope(blob: Uint8Array): boolean {
  return blob.length > 6 && MAGIC.every((x, i) => blob[i] === x);
}

export async function decryptObject(deps: AppDeps, fileId: string, blob: Uint8Array): Promise<Uint8Array> {
  if (!isEnvelope(blob)) throw new Error('not an envelope-encrypted object');
  const wrappedLen = (blob[4]! << 8) | blob[5]!;
  const wrapped = blob.slice(6, 6 + wrappedLen);
  const iv = blob.slice(6 + wrappedLen, 6 + wrappedLen + 12);
  const ct = blob.slice(6 + wrappedLen + 12);
  const dek = await deps.crypto.decrypt(wrapped, objectAad(fileId));
  const key = await crypto.subtle.importKey('raw', dek, { name: 'AES-GCM' }, false, ['decrypt']);
  dek.fill(0);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: te.encode(objectAad(fileId)) }, key, ct));
}
