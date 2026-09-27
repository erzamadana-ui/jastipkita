/**
 * SSRF guard for server-side fetches of user-supplied URLs (product extraction).
 *
 * Policy (docs/api/marketplace.md §SSRF):
 *  - scheme http/https only; no userinfo (user:pass@); ports 80/443 only (default ports)
 *  - hostnames: reject localhost / *.localhost / *.local / *.internal / *.home.arpa / single-label names
 *  - IP literals and EVERY DNS answer must be public: loopback, private (RFC1918), CGNAT, link-local
 *    (incl. cloud metadata 169.254.169.254 / fd00:ec2::254), multicast, reserved, documentation,
 *    benchmarking, ULA, IPv4-mapped/NAT64/6to4 forms of blocked IPv4 are refused
 *  - every redirect target is re-validated (max 3), response capped at 1 MB, overall timeout 5 s
 * Limitation: the resolved address is not pinned for the actual connection (fetch resolves again),
 * so a DNS-rebinding attacker with TTL 0 could still race us; production deployments should also
 * egress through a proxy that enforces the same deny-list (Cloudflare Workers cannot reach private
 * networks at all).
 */

export class UrlNotAllowedError extends Error {
  constructor(
    readonly reason: string,
    message = 'URL tidak diizinkan',
  ) {
    super(message);
    this.name = 'UrlNotAllowedError';
  }
}

export type Resolver = (hostname: string) => Promise<string[]>;

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet', '.corp'];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data', 'kubernetes.default']);

function parseIPv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

function ipv4Blocked([a, b, c]: number[]): string | null {
  if (a === undefined || b === undefined || c === undefined) return 'INVALID_IP';
  if (a === 0) return 'THIS_NETWORK';
  if (a === 10) return 'PRIVATE';
  if (a === 100 && b >= 64 && b <= 127) return 'CGNAT';
  if (a === 127) return 'LOOPBACK';
  if (a === 169 && b === 254) return 'LINK_LOCAL_OR_METADATA';
  if (a === 172 && b >= 16 && b <= 31) return 'PRIVATE';
  if (a === 192 && b === 0 && c === 0) return 'IETF_PROTOCOL';
  if (a === 192 && b === 0 && c === 2) return 'DOCUMENTATION';
  if (a === 192 && b === 88 && c === 99) return '6TO4_RELAY';
  if (a === 192 && b === 168) return 'PRIVATE';
  if (a === 198 && (b === 18 || b === 19)) return 'BENCHMARKING';
  if (a === 198 && b === 51 && c === 100) return 'DOCUMENTATION';
  if (a === 203 && b === 0 && c === 113) return 'DOCUMENTATION';
  if (a >= 224) return 'MULTICAST_OR_RESERVED';
  return null;
}

/** Expands an IPv6 literal (with optional embedded IPv4) to 8 16-bit groups. */
function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    s = s.slice(0, lastColon + 1) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) => (h === '' ? [] : h.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if ([...head, ...rest].some((n) => Number.isNaN(n))) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail.length) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

function ipv6Blocked(g: number[]): string | null {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const embedded = () => [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  if (g.every((x) => x === 0)) return 'UNSPECIFIED';
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return 'LOOPBACK';
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return ipv4Blocked(embedded()) ?? (g5 === 0 ? 'IPV4_COMPATIBLE' : null);
  }
  // IPv4-translated ::ffff:0:a.b.c.d (RFC 2765)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return ipv4Blocked(embedded()) ?? 'IPV4_TRANSLATED';
  // NAT64 64:ff9b::/96 (well-known) and 64:ff9b:1::/48 (local-use, RFC 8215 — always internal)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return ipv4Blocked(embedded());
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return 'NAT64_LOCAL_USE';
  // Teredo 2001:0::/32 tunnels to an (obfuscated) IPv4 — never a legitimate merchant address
  if (g0 === 0x2001 && g1 === 0) return 'TEREDO';
  // 6to4 2002::/16 embeds an IPv4 in g1..g2
  if (g0 === 0x2002) return ipv4Blocked([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]);
  if ((g0 & 0xfe00) === 0xfc00) return 'UNIQUE_LOCAL'; // fc00::/7 (incl. fd00:ec2::254 AWS metadata)
  if ((g0 & 0xffc0) === 0xfe80) return 'LINK_LOCAL';
  if ((g0 & 0xffc0) === 0xfec0) return 'SITE_LOCAL';
  if ((g0 & 0xff00) === 0xff00) return 'MULTICAST';
  if (g0 === 0x2001 && g1 === 0x0db8) return 'DOCUMENTATION';
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return 'DISCARD';
  return null;
}

/** Returns the reason an IP literal is blocked, or null when it is a public unicast address. */
export function ipBlockReason(ip: string): string | null {
  const v4 = parseIPv4(ip);
  if (v4) return ipv4Blocked(v4);
  const v6 = parseIPv6(ip);
  if (v6) return ipv6Blocked(v6);
  return 'NOT_AN_IP';
}

export function isIpLiteral(host: string): boolean {
  return parseIPv4(host) !== null || parseIPv6(host) !== null;
}

/** Syntactic checks (no DNS). Returns the parsed URL or throws UrlNotAllowedError. */
export function checkUrlSyntax(raw: string | URL): URL {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    throw new UrlNotAllowedError('INVALID_URL', 'URL tidak valid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UrlNotAllowedError('SCHEME_NOT_ALLOWED', 'Hanya URL http/https yang didukung');
  if (url.username || url.password) throw new UrlNotAllowedError('CREDENTIALS_IN_URL');
  if (url.port && url.port !== '80' && url.port !== '443') throw new UrlNotAllowedError('PORT_NOT_ALLOWED');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new UrlNotAllowedError('INVALID_URL');
  if (isIpLiteral(host)) {
    const reason = ipBlockReason(host);
    if (reason) throw new UrlNotAllowedError(`IP_${reason}`);
    return url;
  }
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) throw new UrlNotAllowedError('HOST_NOT_ALLOWED');
  if (!host.includes('.')) throw new UrlNotAllowedError('HOST_NOT_ALLOWED');
  return url;
}

type LookupFn = (hostname: string, opts: { all: true; verbatim: true }) => Promise<{ address: string }[]>;

/**
 * Resolver factory (exported for tests). `loadLookup` returns null when the runtime has no DNS API at all
 * (Cloudflare Workers without node:dns — those isolates cannot reach private networks anyway).
 * SEC-05: every resolution FAILURE is fatal (fail closed). Before, any error other than ENOTFOUND/EAI_AGAIN/ENODATA
 * returned [] — "no addresses to check" — so an attacker's DNS answering SERVFAIL/timeout to our check and a private
 * address to fetch()'s own lookup slipped through on Node deployments.
 */
export function makeResolver(loadLookup: () => Promise<LookupFn | null>): Resolver {
  return async (hostname) => {
    let lookup: LookupFn | null;
    try {
      lookup = await loadLookup();
    } catch {
      lookup = null;
    }
    if (!lookup) return [];
    let res: { address: string }[];
    try {
      res = await lookup(hostname, { all: true, verbatim: true });
    } catch (err) {
      const code = String((err as { code?: string }).code ?? '');
      // a runtime shim that does not implement lookup() is "no DNS API", not a resolution failure
      if (code === 'ERR_METHOD_NOT_IMPLEMENTED' || code === 'ERR_NOT_IMPLEMENTED') return [];
      throw new UrlNotAllowedError('DNS_RESOLUTION_FAILED', 'Domain tidak ditemukan');
    }
    if (!res.length) throw new UrlNotAllowedError('DNS_RESOLUTION_FAILED', 'Domain tidak ditemukan');
    return res.map((r) => r.address);
  };
}

/** Default resolver: node:dns when available (Node); on runtimes without DNS APIs returns []. */
export const defaultResolver: Resolver = makeResolver(async () => {
  const dns = await import('node:dns');
  return typeof dns.promises?.lookup === 'function' ? (dns.promises.lookup as unknown as LookupFn) : null;
});

/** Full check: syntax + every resolved address must be public. */
export async function assertPublicUrl(raw: string | URL, resolve: Resolver): Promise<URL> {
  const url = checkUrlSyntax(raw);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIpLiteral(host)) return url;
  const addrs = await resolve(host);
  for (const a of addrs) {
    const reason = ipBlockReason(a);
    if (reason) throw new UrlNotAllowedError(`RESOLVES_TO_${reason}`);
  }
  return url;
}
