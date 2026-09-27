/**
 * Base-aware URL helpers. The site lives under /jastipkita/ with trailingSlash: 'always'.
 * NEVER write href="/..." by hand in components — use url('/kalkulator-bea-cukai/').
 */
const BASE = (import.meta.env.BASE_URL || '/jastipkita/').replace(/\/+$/, '');
const ORIGIN = 'https://antarkitaindonesia.com';

/** Page URL (path relative to the site base) → "/jastipkita/<path>/" (trailing slash enforced for pages). */
export function url(path = '/'): string {
  const [p, hash = ''] = path.split('#', 2) as [string, string?];
  const [pathname = '', query = ''] = p.split('?', 2) as [string, string?];
  let clean = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const isFile = /\.[a-z0-9]{2,5}$/i.test(clean);
  if (!isFile && !clean.endsWith('/')) clean += '/';
  return `${BASE}${clean}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`;
}

/** Static asset in public/ (no trailing slash added). */
export function asset(path: string): string {
  return `${BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Absolute URL for canonical / OG / JSON-LD. */
export function absolute(path = '/'): string {
  return `${ORIGIN}${url(path)}`;
}

export function absoluteAsset(path: string): string {
  return `${ORIGIN}${asset(path)}`;
}

/** Strip the base from a pathname: "/jastipkita/trip/" → "/trip/". */
export function stripBase(pathname: string): string {
  return pathname.startsWith(BASE) ? pathname.slice(BASE.length) || '/' : pathname;
}
