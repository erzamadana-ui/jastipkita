/**
 * Twilio Programmable Messaging (SMS + WhatsApp) via the Messages API with HTTP Basic auth:
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
 *   form: To, From, Body      (WhatsApp: To/From prefixed with "whatsapp:")
 *
 * WhatsApp note: business-initiated messages outside a 24 h session must use a pre-approved
 * (authentication) template; with the plain Body API Twilio delivers only if the sender is allowed
 * to (sandbox / approved template matching the body). See docs/api/identity.md.
 * Errors never include the destination or message body (OTP) in logs.
 */
import type { SmsProvider } from '../types';

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  /** E.164 sender (SMS). For WhatsApp "whatsapp:" is prefixed automatically unless already present. */
  from: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class TwilioSmsProvider implements SmsProvider {
  readonly mode = 'LIVE' as const;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: TwilioOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async send(input: { to: string; body: string; channel?: 'SMS' | 'WHATSAPP' }): Promise<{ providerRef: string }> {
    const wa = input.channel === 'WHATSAPP';
    const prefix = (v: string) => (wa && !v.startsWith('whatsapp:') ? `whatsapp:${v}` : v);
    const form = new URLSearchParams({ To: prefix(input.to), From: prefix(this.opts.from), Body: input.body });
    const url = `${(this.opts.baseUrl ?? 'https://api.twilio.com').replace(/\/+$/, '')}/2010-04-01/Accounts/${encodeURIComponent(this.opts.accountSid)}/Messages.json`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${this.opts.accountSid}:${this.opts.authToken}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
    });
    let data: { sid?: string; code?: number; message?: string; status?: string } = {};
    try {
      data = (await res.json()) as typeof data;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok || !data.sid) {
      throw new Error(`Twilio ${wa ? 'WhatsApp' : 'SMS'} send failed: HTTP ${res.status}${data.code ? ` code ${data.code}` : ''}${data.message ? ` (${data.message.slice(0, 120)})` : ''}`);
    }
    return { providerRef: data.sid };
  }
}
