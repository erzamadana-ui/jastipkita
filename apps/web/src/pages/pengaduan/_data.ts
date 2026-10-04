/**
 * Consumer complaint channel ("Layanan Pengaduan Konsumen", launch checklist L12 — Permendag 19/2026, UU 8/1999).
 * BUILD-TIME data for /pengaduan/ and /en/complaints/ (files starting with "_" are not routes).
 *
 * Mirrors apps/api/src/modules/support/complaint-info.ts (GET /v1/support/complaint-info) — keep both in sync.
 * SLA hours come from DEFAULT_BUSINESS_CONFIG['support.sla'] (packages/core), i.e. the same versioned config the API
 * uses for `sla_due_at`; an admin-approved newer version shows up on each ticket ("Target respons") before the
 * next site build.
 */
import { BUSINESS } from '../../lib/engine.ts';

export type Priority = 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';

export const SLA_HOURS: Readonly<Record<Priority, number>> = BUSINESS['support.sla'].hoursByPriority;

/** Default priority of a complaint ticket (API: defaultPriority('COMPLAINT')). */
export const COMPLAINT_PRIORITY: Priority = 'HIGH';

/** Government escalation channel — checked against the sources on ACCESSED_AT (docs/api/engagement.md §8.1). */
export const ESCALATION = {
  accessedAt: '2026-10-04',
  authority: 'Direktorat Jenderal Perlindungan Konsumen dan Tertib Niaga (Ditjen PKTN)',
  unit: 'Direktorat Pemberdayaan Konsumen',
  ministryId: 'Kementerian Perdagangan Republik Indonesia',
  ministryEn: 'Ministry of Trade of the Republic of Indonesia',
  whatsapp: { display: '0853-1111-1010', url: 'https://wa.me/6285311111010' },
  email: 'pengaduan.konsumen@kemendag.go.id',
  phone: { display: '(021) 3441839', tel: '+62213441839' },
  website: 'https://ditjenpktn.kemendag.go.id/konsultasi-online',
  source: 'https://ditjenpktn.kemendag.go.id/konsultasi-online',
} as const;

export const LEGAL_BASIS = [
  'UU No. 8 Tahun 1999 tentang Perlindungan Konsumen',
  'PP No. 80 Tahun 2019 tentang Perdagangan Melalui Sistem Elektronik',
  'Permendag No. 19 Tahun 2026 tentang Penyelenggaraan Usaha Perdagangan Melalui Sistem Elektronik',
] as const;
