/**
 * Public, build-time site configuration. Values come from PUBLIC_* env vars (see .env.example).
 * Everything here ends up in the static HTML/JS — never read secrets in this file.
 */
const env = import.meta.env;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

const apiBase = str(env.PUBLIC_API_BASE_URL) || 'https://api.antarkitaindonesia.com/jastipkita';

export const SITE = {
  name: 'JastipKita',
  tagline: 'Titip Mudah, Aman, Terpercaya.',
  origin: 'https://antarkitaindonesia.com',
  base: '/jastipkita',
  /** Parent brand — JastipKita is a product line of AntarKita Indonesia. */
  parentBrand: 'AntarKita Indonesia',
  parentUrl: 'https://antarkitaindonesia.com/',
  /** Legal entity is not incorporated yet — keep this placeholder until the deed is signed. */
  companyName: 'PT/CV — menunggu badan usaha',
  companyAddress: 'Alamat terdaftar menyusul setelah badan usaha berdiri',
  locale: 'id_ID',
  lastContentReview: '2026-09-27',
} as const;

export const CONFIG = {
  apiBaseUrl: apiBase.replace(/\/+$/, ''),
  /** True when the default placeholder is used — the API is not deployed yet. */
  apiIsPlaceholder: !str(env.PUBLIC_API_BASE_URL),
  supportWhatsapp: str(env.PUBLIC_SUPPORT_WHATSAPP).replace(/[^0-9]/g, ''),
  supportEmail: str(env.PUBLIC_SUPPORT_EMAIL),
  playStoreUrl: str(env.PUBLIC_PLAY_STORE_URL),
  appStoreUrl: str(env.PUBLIC_APP_STORE_URL),
  enableGoogleLogin: str(env.PUBLIC_ENABLE_GOOGLE_LOGIN) === 'true',
  googleClientId: str(env.PUBLIC_GOOGLE_CLIENT_ID),
  /** Android package / iOS bundle id — used for app links & the deep-link fallback page. */
  androidPackage: 'com.antarkitaindonesia.jastipkita',
  iosBundleId: 'com.antarkitaindonesia.jastipkita',
  appScheme: 'jastipkita',
} as const;

export function whatsappUrl(text?: string): string | null {
  if (!CONFIG.supportWhatsapp) return null;
  const q = text ? `?text=${encodeURIComponent(text)}` : '';
  return `https://wa.me/${CONFIG.supportWhatsapp}${q}`;
}

export function formatWhatsapp(num: string): string {
  // 628117805600 → +62 811-7805-600 (display only)
  if (!num.startsWith('62')) return `+${num}`;
  const rest = num.slice(2);
  return `+62 ${rest.slice(0, 3)}-${rest.slice(3, 7)}-${rest.slice(7)}`;
}
