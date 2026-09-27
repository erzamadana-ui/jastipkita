/**
 * Progressive enhancement for legal links/pages: the static pages (built from docs/legal) stay the source of the
 * text, but when the API is reachable we show the LATEST PUBLISHED version and effective date from
 * GET /v1/legal/documents, and flag when the server has a newer version than the static copy.
 *
 * Markup contract (any element):
 *   [data-legal-slug="<slug>"][data-static-version="<v>"]  container
 *     [data-legal-version]    → text replaced with the API version
 *     [data-legal-effective]  → text replaced with the API effective date (WIB)
 *     [data-legal-newer]      → un-hidden (with text) when API version ≠ static version
 *     [data-legal-live]       → un-hidden when data came from the API
 */
import { api } from '../lib/api.ts';
import { formatLegalDate } from '../lib/legal-catalog.ts';

interface LegalSummary {
  type: string;
  version: string;
  locale: 'id' | 'en';
  title: string;
  effectiveAt: string;
  publishedAt: string;
  slug: string;
  isTemplate: boolean;
}

const nodes = [...document.querySelectorAll<HTMLElement>('[data-legal-slug]')];
if (nodes.length) {
  void (async () => {
    let docs: LegalSummary[];
    try {
      docs = (await api<{ data: LegalSummary[] }>('/v1/legal/documents', { query: { locale: 'id' }, timeoutMs: 5000 })).data;
    } catch {
      return; // offline / not deployed: keep the static version & date
    }
    for (const el of nodes) {
      const doc = docs.find((d) => d.slug === el.dataset.legalSlug);
      if (!doc) continue;
      el.querySelectorAll<HTMLElement>('[data-legal-version]').forEach((n) => (n.textContent = doc.version));
      el.querySelectorAll<HTMLElement>('[data-legal-effective]').forEach((n) => (n.textContent = formatLegalDate(doc.effectiveAt)));
      el.querySelectorAll<HTMLElement>('[data-legal-live]').forEach((n) => (n.hidden = false));
      const stat = el.dataset.staticVersion;
      if (stat && stat !== doc.version) {
        el.querySelectorAll<HTMLElement>('[data-legal-newer]').forEach((n) => {
          n.hidden = false;
          const txt = n.querySelector('[data-legal-newer-text]') ?? n;
          txt.textContent = `Versi terbaru yang berlaku di server adalah ${doc.version} (berlaku ${formatLegalDate(doc.effectiveAt)}). Teks di halaman ini masih versi ${stat} dan akan segera diperbarui.`;
        });
      }
    }
  })();
}
