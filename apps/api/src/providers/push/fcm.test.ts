import { decodeJwt, exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { FCM_SCOPE, FcmPushProvider, parseServiceAccount, type ServiceAccount } from './fcm';

let sa: ServiceAccount;
let publicKey: CryptoKey;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true });
  publicKey = kp.publicKey as CryptoKey;
  sa = {
    project_id: 'jastipkita-test',
    client_email: 'fcm@jastipkita-test.iam.gserviceaccount.com',
    private_key: await exportPKCS8(kp.privateKey),
    token_uri: 'https://oauth2.googleapis.com/token',
  };
});

type Handler = (token: string) => { status: number; body: unknown };

function fakeFetch(perToken: Handler) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  let tokenRequests = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = String(init?.body ?? '');
    calls.push({ url: u, body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (u === 'https://oauth2.googleapis.com/token') {
      tokenRequests++;
      const params = new URLSearchParams(body);
      expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      const assertion = params.get('assertion')!;
      const iat = decodeJwt(assertion).iat!;
      const { payload, protectedHeader } = await jwtVerify(assertion, publicKey, {
        audience: sa.token_uri,
        issuer: sa.client_email,
        currentDate: new Date((iat + 1) * 1000),
      });
      expect(payload.exp! - iat).toBe(3600);
      expect(protectedHeader.alg).toBe('RS256');
      expect(payload.scope).toBe(FCM_SCOPE);
      return new Response(JSON.stringify({ access_token: `ya29.token-${tokenRequests}`, expires_in: 3600, token_type: 'Bearer' }), { status: 200 });
    }
    const msg = JSON.parse(body).message as { token: string };
    const r = perToken(msg.token);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { fn, calls, tokenRequests: () => tokenRequests };
}

const unregistered = {
  status: 404,
  body: { error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } },
};
const invalidArg = {
  status: 400,
  body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'INVALID_ARGUMENT' }] } },
};

describe('FcmPushProvider (HTTP v1)', () => {
  it('signs a service-account JWT, sends one message per token and maps UNREGISTERED/INVALID_ARGUMENT to invalidTokens', async () => {
    const f = fakeFetch((token) => (token === 'tok-ok' ? { status: 200, body: { name: 'projects/jastipkita-test/messages/1' } } : token === 'tok-gone' ? unregistered : invalidArg));
    let now = new Date('2026-09-27T03:00:00Z');
    const p = new FcmPushProvider({ serviceAccount: sa, fetch: f.fn, now: () => now });
    const res = await p.send({ tokens: ['tok-ok', 'tok-gone', 'tok-bad'], title: 'Pembayaran aman', body: 'Rp 1.000 ditahan', data: { type: 'x', n: '1' }, channelId: 'payments' });
    expect(res).toEqual({ sent: 1, invalidTokens: ['tok-gone', 'tok-bad'] });
    const send = f.calls.find((c) => c.url.endsWith('/messages:send'))!;
    expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/jastipkita-test/messages:send');
    expect(send.headers.authorization).toBe('Bearer ya29.token-1');
    const m = JSON.parse(send.body).message;
    expect(m).toMatchObject({ token: 'tok-ok', notification: { title: 'Pembayaran aman' }, data: { type: 'x', n: '1' }, android: { notification: { channel_id: 'payments' } } });

    // token is cached until shortly before expiry
    await p.send({ tokens: ['tok-ok'], title: 't', body: 'b' });
    expect(f.tokenRequests()).toBe(1);
    now = new Date(now.getTime() + 3590 * 1000);
    await p.send({ tokens: ['tok-ok'], title: 't', body: 'b' });
    expect(f.tokenRequests()).toBe(2);
  });

  it('throws when every message failed transiently (so the delivery is retried)', async () => {
    const f = fakeFetch(() => ({ status: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } }));
    const p = new FcmPushProvider({ serviceAccount: sa, fetch: f.fn });
    await expect(p.send({ tokens: ['a'], title: 't', body: 'b' })).rejects.toThrow(/transiently/);
  });

  it('refreshes the OAuth token once on 401', async () => {
    let first = true;
    const f = fakeFetch(() => {
      if (first) {
        first = false;
        return { status: 401, body: { error: { code: 401, status: 'UNAUTHENTICATED' } } };
      }
      return { status: 200, body: { name: 'm' } };
    });
    const p = new FcmPushProvider({ serviceAccount: sa, fetch: f.fn });
    expect(await p.send({ tokens: ['a'], title: 't', body: 'b' })).toEqual({ sent: 1, invalidTokens: [] });
    expect(f.tokenRequests()).toBe(2);
  });

  it('parses raw or base64 service-account JSON', () => {
    const raw = JSON.stringify(sa);
    expect(parseServiceAccount(raw).client_email).toBe(sa.client_email);
    expect(parseServiceAccount(Buffer.from(raw).toString('base64')).project_id).toBe('jastipkita-test');
    expect(() => parseServiceAccount('{"project_id":"x"}')).toThrow();
  });
});
