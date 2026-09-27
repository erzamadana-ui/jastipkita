/**
 * SSRF guard for product-URL extraction (security review 2026-09, scope item 4).
 * SEC-05: DNS resolution failures used to fail OPEN (resolver returned [] → nothing to check) on Node deployments.
 */
import { describe, expect, it } from 'vitest';
import { HeuristicExtractionProvider } from '../../src/providers/extraction/heuristic';
import { assertPublicUrl, checkUrlSyntax, ipBlockReason, makeResolver, UrlNotAllowedError } from '../../src/providers/extraction/ssrf';

const publicResolver = async () => ['93.184.216.34'];

describe('SSRF guard', () => {
  it('rejects private / metadata / loopback targets in every literal encoding', () => {
    const bad = [
      'http://127.0.0.1/',
      'http://2130706433/', // decimal 127.0.0.1 (WHATWG URL normalizes it)
      'http://0177.0.0.1/', // octal
      'http://0x7f.1/', // hex + short form
      'http://127.1/',
      'http://0/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:0:7f00:1]/', // IPv4-translated
      'http://[64:ff9b::a9fe:a9fe]/', // NAT64 of metadata
      'http://[64:ff9b:1::a00:1]/', // NAT64 local-use
      'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', // Teredo
      'http://[2002:a9fe:a9fe::]/', // 6to4 of metadata
      'http://[fd00:ec2::254]/',
      'http://[fe80::1%25eth0]/',
      'http://localhost./',
      'http://api.internal/',
      'http://router.lan/',
      'http://intranet/',
      'http://user:pass@example.com/',
      'http://example.com:8080/',
      'file:///etc/passwd',
      'gopher://example.com/',
    ];
    for (const u of bad) expect(() => checkUrlSyntax(u), u).toThrow(UrlNotAllowedError);
    expect(ipBlockReason('::ffff:0:7f00:1')).toBe('LOOPBACK');
    expect(ipBlockReason('::ffff:0:8.8.8.8')).toBe('IPV4_TRANSLATED');
    expect(ipBlockReason('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe('TEREDO');
    expect(ipBlockReason('2001:4860:4860::8888')).toBeNull();
    expect(checkUrlSyntax('https://www.yodobashi.com/product/123').hostname).toBe('www.yodobashi.com');
  });

  it('every DNS answer must be public (mixed public/private answer = rebinding attempt)', async () => {
    await expect(assertPublicUrl('https://shop.example.com/', async () => ['93.184.216.34', '10.0.0.5'])).rejects.toMatchObject({ reason: 'RESOLVES_TO_PRIVATE' });
    await expect(assertPublicUrl('https://shop.example.com/', async () => ['::ffff:169.254.169.254'])).rejects.toMatchObject({ reason: 'RESOLVES_TO_LINK_LOCAL_OR_METADATA' });
    await expect(assertPublicUrl('https://shop.example.com/', publicResolver)).resolves.toBeInstanceOf(URL);
  });

  it('SEC-05: resolver errors fail closed (SERVFAIL / timeout / refused / empty answer)', async () => {
    for (const code of ['ESERVFAIL', 'ETIMEOUT', 'EREFUSED', 'ECONNREFUSED', 'EBADRESP', undefined]) {
      const resolve = makeResolver(async () => async () => {
        throw Object.assign(new Error('dns failure'), code ? { code } : {});
      });
      await expect(assertPublicUrl('https://rebind.attacker.example/', resolve), String(code)).rejects.toMatchObject({ reason: 'DNS_RESOLUTION_FAILED' });
    }
    const empty = makeResolver(async () => async () => []);
    await expect(assertPublicUrl('https://empty.example/', empty)).rejects.toMatchObject({ reason: 'DNS_RESOLUTION_FAILED' });
    // only a runtime WITHOUT a DNS API (Workers: no private network reachable) skips the address check
    const none = makeResolver(async () => null);
    await expect(assertPublicUrl('https://shop.example.com/', none)).resolves.toBeInstanceOf(URL);
    const shim = makeResolver(async () => async () => {
      throw Object.assign(new Error('not implemented'), { code: 'ERR_METHOD_NOT_IMPLEMENTED' });
    });
    await expect(assertPublicUrl('https://shop.example.com/', shim)).resolves.toBeInstanceOf(URL);
  });

  it('redirects are re-validated hop by hop (public page → 302 to metadata is refused before fetching it)', async () => {
    const fetched: string[] = [];
    const provider = new HeuristicExtractionProvider({
      resolve: async (h) => (h === 'evil.example' ? ['93.184.216.34'] : ['169.254.169.254']),
      fetch: async (u) => {
        fetched.push(u);
        if (u.startsWith('https://evil.example')) return new Response(null, { status: 302, headers: { location: 'http://metadata.attacker.example/latest/meta-data/' } });
        return new Response('<html>secret</html>', { headers: { 'content-type': 'text/html' } });
      },
    });
    await expect(provider.fetchPage('https://evil.example/p/1')).rejects.toBeInstanceOf(UrlNotAllowedError);
    expect(fetched).toEqual(['https://evil.example/p/1']);

    const direct = new HeuristicExtractionProvider({
      resolve: publicResolver,
      fetch: async () => new Response(null, { status: 301, headers: { location: 'http://[::1]:80/admin' } }),
    });
    await expect(direct.fetchPage('https://ok.example/')).rejects.toBeInstanceOf(UrlNotAllowedError);
  });

  it('responses are capped (1 MB) and non-HTML is refused', async () => {
    const big = new HeuristicExtractionProvider({
      resolve: publicResolver,
      maxBytes: 1024,
      fetch: async () => new Response('<html>' + 'x'.repeat(10_000) + '</html>', { headers: { 'content-type': 'text/html' } }),
    });
    const page = await big.fetchPage('https://shop.example.com/');
    expect(page.truncated).toBe(true);
    expect(page.html.length).toBeLessThanOrEqual(1024);
    const bin = new HeuristicExtractionProvider({
      resolve: publicResolver,
      fetch: async () => new Response('\x7fELF', { headers: { 'content-type': 'application/octet-stream' } }),
    });
    await expect(bin.fetchPage('https://shop.example.com/')).rejects.toThrow();
  });
});
