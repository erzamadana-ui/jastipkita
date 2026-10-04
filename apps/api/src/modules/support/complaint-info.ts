/**
 * Consumer complaint channel ("Layanan Pengaduan Konsumen") — launch checklist L12, Permendag 19/2026 (PMSE) and
 * UU 8/1999 (Perlindungan Konsumen). Published by `GET /v1/support/complaint-info` and mirrored (by hand) on the web
 * pages /pengaduan/ and /en/complaints/ — keep apps/web/src/pages/pengaduan/_data.ts in sync when this changes.
 *
 * Government escalation channel: checked against the sources below on ACCESSED_AT (docs/api/engagement.md §8.1).
 * Contact data of a ministry changes without notice — re-verify before launch and at every content review.
 */
import type { Env } from '../../env';

export const ESCALATION_ACCESSED_AT = '2026-10-04';

export const ESCALATION = {
  authority: 'Direktorat Jenderal Perlindungan Konsumen dan Tertib Niaga (Ditjen PKTN)',
  unit: 'Direktorat Pemberdayaan Konsumen',
  ministry: 'Kementerian Perdagangan Republik Indonesia',
  whatsapp: { number: '6285311111010', display: '0853-1111-1010', url: 'https://wa.me/6285311111010' },
  email: 'pengaduan.konsumen@kemendag.go.id',
  phone: { number: '+62213441839', display: '(021) 3441839' },
  website: 'https://ditjenpktn.kemendag.go.id/konsultasi-online',
  verification: {
    status: 'VERIFIED' as const,
    accessedAt: ESCALATION_ACCESSED_AT,
    sources: [
      'https://ditjenpktn.kemendag.go.id/konsultasi-online',
      'https://www.antaranews.com/berita/4801037/kemendag-catat-1657-layanan-konsumen-sepanjang-januari-maret-2025',
      'https://katadata.co.id/amp/digital/e-commerce/6a0e5f3d6976b/kemendag-panggil-shopee-soal-aduan-barang-tak-sesuai-dan-shopee-paylater',
    ],
  },
  outOfCourt:
    'Badan Penyelesaian Sengketa Konsumen (BPSK) di kabupaten/kota tempat konsumen berdomisili — penyelesaian sengketa di luar pengadilan menurut UU 8/1999.',
} as const;

export const LEGAL_BASIS = [
  'UU No. 8 Tahun 1999 tentang Perlindungan Konsumen',
  'PP No. 80 Tahun 2019 tentang Perdagangan Melalui Sistem Elektronik',
  'Permendag No. 19 Tahun 2026 tentang Penyelenggaraan Usaha Perdagangan Melalui Sistem Elektronik',
] as const;

/** Digits only (`+62 811-7805-600` → `628117805600`); null when unset or too short to be a phone number. */
export function normalizeWhatsapp(raw: string | undefined): string | null {
  const digits = (raw ?? '').replace(/[^0-9]/g, '');
  return digits.length >= 8 ? digits : null;
}

/** Published JastipKita channels (env, never hard-coded). Unset → null so clients show "segera diumumkan". */
export function publishedChannels(env: Pick<Env, 'SUPPORT_WHATSAPP' | 'SUPPORT_EMAIL' | 'WEB_BASE_URL'>) {
  const wa = normalizeWhatsapp(env.SUPPORT_WHATSAPP);
  const email = env.SUPPORT_EMAIL.trim();
  return {
    inApp: { ticketCategory: 'COMPLAINT' as const, endpoint: '/v1/support/tickets' as const },
    whatsapp: wa ? { number: wa, url: `https://wa.me/${wa}` } : null,
    email: email || null,
    webUrl: `${env.WEB_BASE_URL.replace(/\/+$/, '')}/pengaduan/`,
  };
}
