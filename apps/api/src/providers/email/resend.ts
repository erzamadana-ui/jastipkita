/**
 * Resend e-mail adapter (https://resend.com/docs/api-reference/emails/send-email).
 * POST https://api.resend.com/emails with `Idempotency-Key` so a retried delivery never sends twice
 * (Resend keeps keys for 24 h). Only `fetch` — works on Node and Workers.
 */
import type { EmailMessage, EmailProvider, ProviderMode } from '../types';

export interface ResendOptions {
  apiKey: string;
  from: string;
  replyTo?: string | undefined;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class ResendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ResendError';
  }
}

/** Resend tag names/values: ASCII letters, numbers, underscores, dashes; ≤ 256 chars. */
function tagSafe(v: string): string {
  return v.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);
}

export class ResendEmailProvider implements EmailProvider {
  readonly mode: ProviderMode = 'LIVE';
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly opts: ResendOptions) {
    if (!opts.apiKey) throw new Error('RESEND_API_KEY is required for EMAIL_PROVIDER=resend');
    this.fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.baseUrl = (opts.baseUrl ?? 'https://api.resend.com').replace(/\/+$/, '');
  }

  async send(msg: EmailMessage): Promise<{ providerRef: string }> {
    const body: Record<string, unknown> = {
      from: this.opts.from,
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    };
    const replyTo = msg.replyTo ?? this.opts.replyTo;
    if (replyTo) body.reply_to = replyTo;
    if (msg.tags) body.tags = Object.entries(msg.tags).map(([name, value]) => ({ name: tagSafe(name), value: tagSafe(value) }));

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.apiKey}`,
      'content-type': 'application/json',
      'user-agent': 'jastipkita-api',
    };
    if (msg.idempotencyKey) headers['idempotency-key'] = msg.idempotencyKey.slice(0, 256);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/emails`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (err) {
      throw new ResendError(`Resend request failed: ${err instanceof Error ? err.message : String(err)}`, 0, true);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: { id?: string; name?: string; message?: string } = {};
    try {
      json = text ? (JSON.parse(text) as typeof json) : {};
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok || !json.id) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new ResendError(`Resend ${res.status}: ${json.name ?? ''} ${json.message ?? text.slice(0, 200)}`.trim(), res.status, retryable, json.name);
    }
    return { providerRef: json.id };
  }
}
