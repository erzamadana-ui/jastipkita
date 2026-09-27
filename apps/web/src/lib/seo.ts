import { SITE, CONFIG } from '../config.ts';
import { absolute, absoluteAsset } from './paths.ts';

const ORG_ID = `${SITE.origin}${SITE.base}/#organization`;
const SITE_ID = `${SITE.origin}${SITE.base}/#website`;

export function organizationLd() {
  const sameAs: string[] = [];
  const contact = [];
  if (CONFIG.supportWhatsapp) {
    contact.push({ '@type': 'ContactPoint', contactType: 'customer support', telephone: `+${CONFIG.supportWhatsapp}`, availableLanguage: ['id', 'en'] });
  }
  if (CONFIG.supportEmail) {
    contact.push({ '@type': 'ContactPoint', contactType: 'customer support', email: CONFIG.supportEmail, availableLanguage: ['id', 'en'] });
  }
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': ORG_ID,
    name: SITE.name,
    url: absolute('/'),
    logo: absoluteAsset('/icon-512.png'),
    slogan: SITE.tagline,
    parentOrganization: { '@type': 'Organization', name: SITE.parentBrand, url: SITE.parentUrl },
    ...(contact.length ? { contactPoint: contact } : {}),
    ...(sameAs.length ? { sameAs } : {}),
  };
}

export function websiteLd(lang: 'id' | 'en' = 'id') {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': SITE_ID,
    name: SITE.name,
    url: absolute('/'),
    inLanguage: lang === 'id' ? 'id-ID' : 'en',
    publisher: { '@id': ORG_ID },
  };
}

export interface Crumb {
  name: string;
  path: string;
}

export function breadcrumbLd(crumbs: Crumb[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: absolute(c.path) })),
  };
}

export function faqLd(items: Array<{ q: string; a: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: stripMarkup(f.a) },
    })),
  };
}

export function serviceLd(opts: { name: string; description: string; path: string; areaServed?: string[]; serviceType?: string }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: opts.name,
    description: opts.description,
    url: absolute(opts.path),
    serviceType: opts.serviceType ?? 'Jasa titip belanja luar negeri (personal shopping via traveler)',
    provider: { '@id': ORG_ID },
    areaServed: (opts.areaServed ?? ['Indonesia']).map((n) => ({ '@type': 'Country', name: n })),
  };
}

export function webPageLd(opts: { name: string; description: string; path: string; lang?: 'id' | 'en'; type?: string }) {
  return {
    '@context': 'https://schema.org',
    '@type': opts.type ?? 'WebPage',
    name: opts.name,
    description: opts.description,
    url: absolute(opts.path),
    inLanguage: opts.lang === 'en' ? 'en' : 'id-ID',
    isPartOf: { '@id': SITE_ID },
  };
}

export function stripMarkup(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
