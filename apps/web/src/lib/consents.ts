/**
 * Signup consents (browser). The API only accepts consent versions that match a published legal document
 * (docs/api/CHANGELOG.md 2026-09-27: 422 CONSENT_VERSION_INVALID otherwise), so versions are NEVER hard-coded:
 *   1. GET /v1/consents/requirements → signup.required / signup.optional (type, version, acceptedVersions, title, url);
 *   2. offline fallback → versions read at build time from the docs/legal/*.md front-matter (embedded in the page).
 */
import { api } from './api.ts';
import { SIGNUP_OPTIONAL, SIGNUP_REQUIRED, type ConsentItem, type LegalType } from './legal-catalog.ts';

interface ApiRequirement {
  type: LegalType;
  required: boolean;
  version: string | null;
  acceptedVersions: string[];
  title: string | null;
  url: string | null;
}
interface ApiRequirements {
  signup: { required: ApiRequirement[]; optional: ApiRequirement[] };
}

export interface FallbackDoc {
  version: string;
  title: string;
  url: string;
}

export interface SignupRequirements {
  source: 'api' | 'static';
  items: ConsentItem[];
}

/** Build-time fallback embedded as JSON: { TOS: {version,title,url}, PRIVACY: …, MARKETING: … }. */
export function readFallback(el: HTMLElement | null): Partial<Record<LegalType, FallbackDoc>> {
  try {
    return JSON.parse(el?.textContent ?? '{}') as Partial<Record<LegalType, FallbackDoc>>;
  } catch {
    return {};
  }
}

function fromFallback(fb: Partial<Record<LegalType, FallbackDoc>>): ConsentItem[] {
  const mk = (type: LegalType, required: boolean): ConsentItem | null => {
    const d = fb[type];
    return d ? { type, required, version: d.version, acceptedVersions: [d.version], title: d.title, url: d.url } : null;
  };
  return [...SIGNUP_REQUIRED.map((t) => mk(t, true)), ...SIGNUP_OPTIONAL.map((t) => mk(t, false))].filter((x): x is ConsentItem => !!x);
}

let cache: SignupRequirements | null = null;

/** Current signup requirements; `fresh` bypasses the in-memory cache (used after a 422). */
export async function loadSignupRequirements(fb: Partial<Record<LegalType, FallbackDoc>>, fresh = false): Promise<SignupRequirements> {
  if (cache && !fresh) return cache;
  try {
    const res = await api<ApiRequirements>('/v1/consents/requirements', { query: { locale: 'id' }, timeoutMs: 5000 });
    const map = (r: ApiRequirement, required: boolean): ConsentItem => ({
      type: r.type,
      required,
      version: r.version ?? r.acceptedVersions[0] ?? fb[r.type]?.version ?? null,
      acceptedVersions: r.acceptedVersions,
      title: r.title ?? fb[r.type]?.title ?? r.type,
      url: r.url ?? fb[r.type]?.url ?? '#',
    });
    cache = { source: 'api', items: [...res.signup.required.map((r) => map(r, true)), ...res.signup.optional.map((r) => map(r, false))] };
  } catch {
    // Requirements are public: any failure (network, CORS, 5xx, unexpected shape) → build-time fallback.
    cache = { source: 'static', items: fromFallback(fb) };
  }
  return cache;
}

/**
 * Apply `details.allowedVersions` from a 422 CONSENT_VERSION_INVALID to the cached requirements (used when the
 * requirements endpoint itself is unreachable but the verify endpoint told us what it accepts).
 */
export function applyAllowedVersions(reqs: SignupRequirements, details: Record<string, unknown>): boolean {
  const type = details.type as LegalType | undefined;
  const allowed = Array.isArray(details.allowedVersions) ? (details.allowedVersions as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  const item = reqs.items.find((i) => i.type === type);
  if (!item || !allowed.length || (item.version && allowed.includes(item.version))) return false;
  item.version = allowed[0] ?? item.version;
  item.acceptedVersions = allowed;
  return true;
}

/** ConsentInput[] for the API. Required items must be granted by the caller before this is used. */
export function toConsentInputs(reqs: SignupRequirements, granted: Partial<Record<LegalType, boolean>>) {
  return reqs.items
    .filter((i) => i.version !== null || i.required || granted[i.type])
    .map((i) => ({ type: i.type, version: i.version ?? 'unversioned', granted: i.required ? true : !!granted[i.type] }));
}
