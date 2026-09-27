/**
 * Firebase Cloud Messaging HTTP v1 adapter.
 *   1. Service-account JWT (RS256, jose) → OAuth2 access token (cached until ~1 min before expiry)
 *   2. POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send, one request per token
 * UNREGISTERED / INVALID_ARGUMENT (and 404 NOT_FOUND) → token reported in `invalidTokens` so the
 * caller removes it. Transient failures (429/5xx/network) with nothing delivered → throws (retry).
 */
import { importPKCS8, SignJWT } from 'jose';
import type { ProviderMode, PushMessage, PushProvider } from '../types';

export interface ServiceAccount {
  project_id?: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface FcmOptions {
  projectId?: string | undefined;
  serviceAccount: ServiceAccount;
  fetch?: typeof fetch;
  now?: () => Date;
  baseUrl?: string;
  timeoutMs?: number;
}

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const INVALID_CODES = new Set(['UNREGISTERED', 'INVALID_ARGUMENT']);

/** Accepts the raw service-account JSON or its base64 encoding (env-friendly). */
export function parseServiceAccount(raw: string): ServiceAccount {
  const text = raw.trim().startsWith('{') ? raw : new TextDecoder().decode(Uint8Array.from(atob(raw.trim()), (c) => c.charCodeAt(0)));
  const sa = JSON.parse(text) as ServiceAccount;
  if (!sa.client_email || !sa.private_key) throw new Error('FCM service account must contain client_email and private_key');
  return sa;
}

interface FcmErrorBody {
  error?: { code?: number; status?: string; message?: string; details?: { '@type'?: string; errorCode?: string }[] };
}

export class FcmPushProvider implements PushProvider {
  readonly mode: ProviderMode = 'LIVE';
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly projectId: string;
  private cached: { token: string; expiresAt: number } | null = null;
  private keyPromise: ReturnType<typeof importPKCS8> | null = null;

  constructor(private readonly opts: FcmOptions) {
    const projectId = opts.projectId ?? opts.serviceAccount.project_id;
    if (!projectId) throw new Error('FCM_PROJECT_ID (or service account project_id) is required');
    this.projectId = projectId;
    this.fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.now = opts.now ?? (() => new Date());
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      return await this.fetchImpl(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** OAuth2 access token for the service account (JWT bearer grant), cached until expiry − 60 s. */
  async accessToken(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.cached && this.cached.expiresAt - 60_000 > nowMs) return this.cached.token;
    const sa = this.opts.serviceAccount;
    const tokenUri = sa.token_uri ?? DEFAULT_TOKEN_URI;
    this.keyPromise ??= importPKCS8(sa.private_key, 'RS256');
    const key = await this.keyPromise;
    const iat = Math.floor(nowMs / 1000);
    const assertion = await new SignJWT({ scope: FCM_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(sa.client_email)
      .setSubject(sa.client_email)
      .setAudience(tokenUri)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(key);
    const res = await this.request(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !json.access_token) throw new Error(`FCM OAuth token request failed (${res.status}): ${json.error ?? 'no access_token'}`);
    this.cached = { token: json.access_token, expiresAt: nowMs + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  private buildMessage(token: string, msg: PushMessage) {
    return {
      message: {
        token,
        notification: { title: msg.title, body: msg.body },
        ...(msg.data ? { data: Object.fromEntries(Object.entries(msg.data).map(([k, v]) => [k, String(v)])) } : {}),
        android: { priority: 'HIGH', notification: { channel_id: msg.channelId ?? 'default' } },
        apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
      },
    };
  }

  private async sendOne(token: string, msg: PushMessage, retryAuth = true): Promise<'SENT' | 'INVALID' | 'TRANSIENT'> {
    let res: Response;
    try {
      const access = await this.accessToken();
      res = await this.request(`${(this.opts.baseUrl ?? 'https://fcm.googleapis.com').replace(/\/+$/, '')}/v1/projects/${this.projectId}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify(this.buildMessage(token, msg)),
      });
    } catch {
      return 'TRANSIENT';
    }
    if (res.ok) return 'SENT';
    const body = (await res.json().catch(() => ({}))) as FcmErrorBody;
    if (res.status === 401 && retryAuth) {
      this.cached = null;
      return this.sendOne(token, msg, false);
    }
    const codes = (body.error?.details ?? []).map((d) => d.errorCode).filter((c): c is string => !!c);
    if (codes.some((c) => INVALID_CODES.has(c)) || body.error?.status === 'NOT_FOUND' || res.status === 404 || body.error?.status === 'INVALID_ARGUMENT') {
      return 'INVALID';
    }
    return 'TRANSIENT';
  }

  async send(msg: PushMessage): Promise<{ sent: number; invalidTokens: string[] }> {
    let sent = 0;
    let transient = 0;
    const invalidTokens: string[] = [];
    for (const token of [...new Set(msg.tokens)]) {
      const r = await this.sendOne(token, msg);
      if (r === 'SENT') sent++;
      else if (r === 'INVALID') invalidTokens.push(token);
      else transient++;
    }
    if (sent === 0 && transient > 0) throw new Error(`FCM: ${transient} message(s) failed transiently`);
    return { sent, invalidTokens };
  }
}
