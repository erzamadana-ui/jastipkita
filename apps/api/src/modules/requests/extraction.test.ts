import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext, type TestUser } from '../../../test/helpers';
import { resetRateLimits } from '../../middleware/rate-limit';
import { HeuristicExtractionProvider, normalizePrice } from '../../providers/extraction/heuristic';
import { checkUrlSyntax, ipBlockReason } from '../../providers/extraction/ssrf';
import { insertFile } from '../trips/fixtures';

const NOW = new Date('2026-10-05T03:00:00Z');
let t: TestContext;
let buyer: TestUser;

/** Fake network: URL → response factory. Records every fetched URL. Never touches the real network. */
function fakeNet(routes: Record<string, () => Response>, dns: Record<string, string[]> = {}) {
  const fetched: string[] = [];
  const resolved: string[] = [];
  const provider = new HeuristicExtractionProvider({
    timeoutMs: 200,
    fetch: async (url, init) => {
      fetched.push(url);
      const r = routes[url];
      if (!r) {
        // hang until aborted (simulates a slow origin)
        return new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
      }
      return r();
    },
    resolve: async (host) => {
      resolved.push(host);
      return dns[host] ?? ['93.184.215.14'];
    },
  });
  return { provider, fetched, resolved };
}

const html = (body: string, headers: Record<string, string> = {}) => () =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

const JSONLD_PAGE = `<!doctype html><html><head><title>ignored</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},
{"@type":"Product","name":"AIRism Cotton Oversized T-Shirt","brand":{"@type":"Brand","name":"UNIQLO"},
"image":["https://image.uniqlo.com/UQ/ST3/jp/imagesgoods/465185/item/goods_09_465185.jpg"],
"offers":{"@type":"Offer","price":"1990","priceCurrency":"JPY","availability":"https://schema.org/InStock"}}]}</script>
</head><body>…</body></html>`;

const OG_PAGE = `<html><head>
<meta property="og:title" content="[1+1] COSRX Advanced Snail 96 Mucin Power Essence 100ml &amp; Serum">
<meta property="og:image" content="//image.oliveyoung.co.kr/uploads/images/goods/A000000184151.jpg">
<meta property="og:site_name" content="올리브영">
<meta property="product:price:amount" content="25,000">
<meta property="product:price:currency" content="KRW">
</head></html>`;

const USD_PAGE = `<html><head><script type="application/ld+json">
[{"@type":"Product","name":"Rare Beauty Soft Pinch Liquid Blush","offers":[{"@type":"Offer","price":23.00,"priceCurrency":"USD"}]}]
</script></head></html>`;

beforeAll(async () => {
  t = await createTestContext({ now: NOW });
  buyer = await t.createUser({ kycLevel: 2 });
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  resetRateLimits();
  t.deps.providers.extraction = fakeNet({}).provider;
});

async function extract(body: Record<string, unknown>) {
  return t.request('POST', '/v1/requests/extract', { token: buyer.accessToken, body });
}

describe('POST /v1/requests/extract — heuristic provider (fake fetch)', () => {
  it('requires auth and exactly one input', async () => {
    expect((await t.request('POST', '/v1/requests/extract', { body: { query: 'kitkat' } })).status).toBe(401);
    const two = await extract({ query: 'kitkat', url: 'https://www.amazon.co.jp/dp/B0' });
    expect(two.status).toBe(400);
    expect(two.body.error.code).toBe('EXTRACT_INPUT_INVALID');
  });

  it('parses JSON-LD Product/Offer (UNIQLO JP)', async () => {
    const url = 'https://www.uniqlo.com/jp/ja/products/E465185-000/00';
    const net = fakeNet({ [url]: html(JSONLD_PAGE) });
    t.deps.providers.extraction = net.provider;
    const res = await extract({ url });
    expect(res.status).toBe(200);
    expect(res.body.drafts[0]).toMatchObject({
      sourceType: 'URL',
      productUrl: url,
      productName: 'UNIQLO AIRism Cotton Oversized T-Shirt',
      merchantName: 'UNIQLO',
      merchantCountry: 'JP',
      unitPriceMinor: 1990,
      priceCurrency: 'JPY',
      imageUrl: 'https://image.uniqlo.com/UQ/ST3/jp/imagesgoods/465185/item/goods_09_465185.jpg',
      categoryCode: 'FASHION_APPAREL',
    });
    expect(res.body.needsManualInput).toBe(false);
    expect(res.body.confidence).toBeGreaterThanOrEqual(0.9);
    expect(res.body.mode).toBe('LIVE');
    expect(net.resolved).toContain('www.uniqlo.com');
  });

  it('parses OpenGraph product meta (Olive Young KR) incl. entities, protocol-relative image, thousand separators', async () => {
    const url = 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=A000000184151';
    t.deps.providers.extraction = fakeNet({ [url]: html(OG_PAGE) }).provider;
    const res = await extract({ url });
    expect(res.status).toBe(200);
    expect(res.body.drafts[0]).toMatchObject({
      productName: '[1+1] COSRX Advanced Snail 96 Mucin Power Essence 100ml & Serum',
      merchantName: 'Olive Young',
      merchantCountry: 'KR',
      unitPriceMinor: 25000,
      priceCurrency: 'KRW',
      imageUrl: 'https://image.oliveyoung.co.kr/uploads/images/goods/A000000184151.jpg',
      categoryCode: 'COSMETICS_SKINCARE',
    });
  });

  it('USD prices become cents; amazon.com/sephora map to US', async () => {
    const url = 'https://www.sephora.com/product/soft-pinch-liquid-blush-P97989778';
    t.deps.providers.extraction = fakeNet({ [url]: html(USD_PAGE) }).provider;
    const res = await extract({ url });
    expect(res.body.drafts[0]).toMatchObject({ merchantCountry: 'US', unitPriceMinor: 2300, priceCurrency: 'USD' });
  });

  it('page without price → needsManualInput with warnings; merchant country from domain', async () => {
    const url = 'https://item.rakuten.co.jp/shop/item-1/';
    t.deps.providers.extraction = fakeNet({ [url]: html('<html><head><title>楽天 ポケモンカード 151 BOX</title></head></html>') }).provider;
    const res = await extract({ url });
    expect(res.body.needsManualInput).toBe(true);
    expect(res.body.warnings).toEqual(expect.arrayContaining(['PRICE_NOT_FOUND', 'CURRENCY_NOT_FOUND']));
    expect(res.body.drafts[0]).toMatchObject({ merchantCountry: 'JP', merchantName: 'Rakuten', unitPriceMinor: null });
  });

  it('follows a safe redirect (re-validated) and gives up gracefully on timeout', async () => {
    const a = 'https://amzn.example.com/abc';
    const b = 'https://www.amazon.co.jp/dp/B0CHX1W1XY';
    const net = fakeNet({ [a]: () => new Response(null, { status: 301, headers: { location: b } }), [b]: html(JSONLD_PAGE) });
    t.deps.providers.extraction = net.provider;
    const ok = await extract({ url: a });
    expect(ok.status).toBe(200);
    expect(net.fetched).toEqual([a, b]);
    expect(ok.body.drafts[0].merchantCountry).toBe('JP');

    const slow = 'https://www.target.com/p/slow';
    t.deps.providers.extraction = fakeNet({}).provider; // hangs → 200 ms timeout
    const res = await extract({ url: slow });
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual(expect.arrayContaining(['FETCH_TIMEOUT', 'MANUAL_INPUT_REQUIRED']));
    expect(res.body.drafts[0].merchantCountry).toBe('US');
  });

  it('caps the response at 1 MB (parses the head, flags truncation)', async () => {
    const url = 'https://www.musinsa.com/products/123';
    const big = JSONLD_PAGE.replace('</body>', `${'x'.repeat(1_200_000)}</body>`);
    t.deps.providers.extraction = fakeNet({ [url]: html(big) }).provider;
    const res = await extract({ url });
    expect(res.status).toBe(200);
    expect(res.body.warnings).toContain('CONTENT_TRUNCATED');
    expect(res.body.drafts[0].merchantCountry).toBe('KR');
    expect(res.body.drafts[0].productName).toContain('AIRism');
  });

  it('rejects non-HTML content', async () => {
    const url = 'https://www.bestbuy.com/file.pdf';
    t.deps.providers.extraction = fakeNet({ [url]: () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }) }).provider;
    const res = await extract({ url });
    expect(res.body.warnings).toContain('FETCH_UNSUPPORTED_CONTENT_TYPE');
  });
});

describe('SSRF protection', () => {
  const blocked = [
    'http://127.0.0.1/admin',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://2130706433/', // decimal 127.0.0.1
    'http://0x7f.1/',
    'http://10.1.2.3/',
    'http://192.168.0.1/',
    'http://100.100.100.200/', // Alibaba metadata (CGNAT range)
    'http://localhost:80/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'https://shop.example.com:8443/',
    'https://user:pass@shop.example.com/',
    'http://intranet/',
  ];
  for (const url of blocked) {
    it(`blocks ${url} before any network I/O`, async () => {
      const net = fakeNet({});
      t.deps.providers.extraction = net.provider;
      const res = await extract({ url });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('URL_NOT_ALLOWED');
      expect(net.fetched).toEqual([]);
    });
  }

  it('blocks hostnames whose DNS answer is private', async () => {
    const net = fakeNet({}, { 'evil.example.net': ['93.184.215.14', '192.168.1.10'] });
    t.deps.providers.extraction = net.provider;
    const res = await extract({ url: 'https://evil.example.net/product' });
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('RESOLVES_TO_PRIVATE');
    expect(net.fetched).toEqual([]);
  });

  it('re-validates redirects: public → 169.254.169.254 is refused after one hop', async () => {
    const start = 'https://shop.example.com/p/1';
    const net = fakeNet({ [start]: () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }) });
    t.deps.providers.extraction = net.provider;
    const res = await extract({ url: start });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('URL_NOT_ALLOWED');
    expect(net.fetched).toEqual([start]);
  });

  it('re-validates redirects via DNS and caps redirects at 3', async () => {
    const start = 'https://shop.example.com/r0';
    const net = fakeNet(
      { [start]: () => new Response(null, { status: 302, headers: { location: 'https://internal.example.com/x' } }) },
      { 'internal.example.com': ['10.0.0.5'] },
    );
    t.deps.providers.extraction = net.provider;
    expect((await extract({ url: start })).body.error.details.reason).toBe('RESOLVES_TO_PRIVATE');

    const hops: Record<string, () => Response> = {};
    for (let i = 0; i < 5; i++) hops[`https://shop.example.com/r${i}`] = () => new Response(null, { status: 302, headers: { location: `/r${i + 1}` } });
    const loop = fakeNet(hops);
    t.deps.providers.extraction = loop.provider;
    const res = await extract({ url: 'https://shop.example.com/r0' });
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('TOO_MANY_REDIRECTS');
    expect(loop.fetched).toHaveLength(4); // original + 3 redirects
  });

  it('rejects non-http schemes at validation', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/']) {
      const res = await extract({ url });
      expect(res.status).toBe(400);
    }
  });

  it('ipBlockReason / checkUrlSyntax unit checks', () => {
    expect(ipBlockReason('8.8.8.8')).toBeNull();
    expect(ipBlockReason('2606:4700:4700::1111')).toBeNull();
    expect(ipBlockReason('172.16.5.4')).toBe('PRIVATE');
    expect(ipBlockReason('172.32.0.1')).toBeNull();
    expect(ipBlockReason('fe80::1')).toBe('LINK_LOCAL');
    expect(ipBlockReason('64:ff9b::a9fe:a9fe')).toBe('LINK_LOCAL_OR_METADATA'); // NAT64 of 169.254.169.254
    expect(ipBlockReason('2002:7f00:1::')).toBe('LOOPBACK'); // 6to4 of 127.0.0.1
    expect(ipBlockReason('0.0.0.0')).toBe('THIS_NETWORK');
    expect(() => checkUrlSyntax('http://[::]/')).toThrow();
    expect(checkUrlSyntax('https://www.amazon.co.jp/dp/X').hostname).toBe('www.amazon.co.jp');
  });
});

describe('photo & search drafts', () => {
  it('photo → needs manual input (AI provider pluggable later)', async () => {
    const fileId = await insertFile(t, buyer.id, 'PRODUCT_PHOTO');
    const res = await extract({ fileId, hint: 'Tamiya mini 4WD kit' });
    expect(res.status).toBe(200);
    expect(res.body.needsManualInput).toBe(true);
    expect(res.body.warnings).toEqual(expect.arrayContaining(['MANUAL_INPUT_REQUIRED', 'AI_EXTRACTION_NOT_CONFIGURED']));
    expect(res.body.drafts[0]).toMatchObject({ sourceType: 'PHOTO', productName: 'Tamiya mini 4WD kit', categoryCode: 'TOYS_HOBBIES' });
    const other = await t.createUser();
    const foreign = await insertFile(t, other.id, 'PRODUCT_PHOTO');
    expect((await extract({ fileId: foreign })).status).toBe(404);
  });

  it('search → structured draft with category guess', async () => {
    const res = await extract({ query: 'Nintendo Switch 2 Mario Kart bundle', country: 'JP' });
    expect(res.body.drafts[0]).toMatchObject({ sourceType: 'SEARCH', productName: 'Nintendo Switch 2 Mario Kart bundle', merchantCountry: 'JP', categoryCode: 'GAMING' });
    expect(res.body.needsManualInput).toBe(true);
  });

  it('normalizePrice handles separators per currency', () => {
    expect(normalizePrice('¥12,800', 0)).toBe('12800');
    expect(normalizePrice('12800.00', 0)).toBe('12800');
    expect(normalizePrice('$1,299', 2)).toBe('1299');
    expect(normalizePrice('19.99', 2)).toBe('19.99');
    expect(normalizePrice('1.234,56', 2)).toBe('1234.56');
    expect(normalizePrice('₩ 25,000', 0)).toBe('25000');
    expect(normalizePrice('free', 2)).toBeNull();
  });
});
