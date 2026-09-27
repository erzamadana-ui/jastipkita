/**
 * Idempotency-Key helper (CONVENTIONS.md: every financial mutation carries a UUID Idempotency-Key).
 * One key per LOGICAL action: it is created on first use, reused for every retry of that same action (MFA step-up
 * replay, network retry, double submit) so the API replays the stored response instead of moving money twice, and
 * dropped only when the action succeeded or the operator abandoned it (dialog closed) — the next action gets a new key.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // RFC 4122 v4 fallback (older test environments)
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class IdempotencyKeys {
  private keys = new Map<string, string>();

  /** Key for a logical action (e.g. `refund.approve:<id>`), stable until completed/abandoned. */
  get(action: string): string {
    let k = this.keys.get(action);
    if (!k) {
      k = newIdempotencyKey();
      this.keys.set(action, k);
    }
    return k;
  }

  has(action: string): boolean {
    return this.keys.has(action);
  }

  /** The action finished (success or deliberate abandon) — the next attempt is a NEW logical action. */
  complete(action: string): void {
    this.keys.delete(action);
  }
}
