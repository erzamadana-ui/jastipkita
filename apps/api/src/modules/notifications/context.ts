/**
 * Loads the facts a notification needs at render time. Outbox payloads carry ids only (no PII), so
 * names, product and the price breakdown always come from the database.
 */
import type { Db } from '../../db/sql';
import { publicName } from './templates/format';
import type { QuoteLineView, TxView } from './templates/types';

export interface Recipient {
  id: string;
  displayName: string | null;
  locale: 'id' | 'en';
  status: string;
  email: string | null;
  emailVerified: boolean;
  transactionEmail: string | null;
  anonymized: boolean;
}

export async function loadRecipient(db: Db, userId: string): Promise<Recipient | null> {
  const [u] = await db<
    { id: string; display_name: string | null; locale: string; status: string; email: string | null; email_verified_at: Date | null; transaction_email: string | null; anonymized_at: Date | null }[]
  >`SELECT id, display_name, locale, status, email, email_verified_at, transaction_email, anonymized_at FROM users WHERE id = ${userId}`;
  if (!u) return null;
  return {
    id: u.id,
    displayName: u.display_name,
    locale: u.locale === 'en' ? 'en' : 'id',
    status: u.status,
    email: u.email,
    emailVerified: !!u.email_verified_at,
    transactionEmail: u.transaction_email,
    anonymized: !!u.anonymized_at,
  };
}

/** Transactional e-mail destination: `users.transaction_email` if set, else the verified login e-mail. */
export function emailDestination(r: Recipient): string | null {
  if (r.transactionEmail) return r.transactionEmail;
  if (r.email && r.emailVerified) return r.email;
  return null;
}

export async function loadQuoteLines(db: Db, transactionId: string, activeQuoteId: string | null): Promise<QuoteLineView[]> {
  // Active quote first; otherwise the accepted quote; otherwise the newest quote.
  const [q] = await db<{ id: string }[]>`
    SELECT id FROM quotes
     WHERE transaction_id = ${transactionId}
     ORDER BY (id = ${activeQuoteId}::uuid) DESC NULLS LAST, (status = 'ACCEPTED') DESC, created_at DESC
     LIMIT 1`;
  if (!q) return [];
  const rows = await db<{ line_type: string; label_id: string; label_en: string; amount_idr: number; is_estimate: boolean }[]>`
    SELECT line_type, label_id, label_en, amount_idr, is_estimate FROM quote_lines WHERE quote_id = ${q.id} ORDER BY sort`;
  return rows.map((r) => ({ type: r.line_type, labelId: r.label_id, labelEn: r.label_en, amountIdr: Number(r.amount_idr), isEstimate: r.is_estimate }));
}

export async function loadTxView(db: Db, transactionId: string): Promise<TxView | null> {
  const [t] = await db<
    {
      id: string;
      number: string;
      status: string;
      buyer_id: string;
      traveler_id: string | null;
      active_quote_id: string | null;
      total_idr: number | null;
      quantity: number;
      delivery_method: string | null;
      product_name: string;
      variant: string | null;
      merchant_name: string | null;
      origin_country: string | null;
      origin_city: string | null;
      destination_city: string | null;
      departure_date: string | null;
      arrival_date: string | null;
      traveler_name: string | null;
      buyer_name: string | null;
    }[]
  >`
    SELECT t.id, t.number, t.status, t.buyer_id, t.traveler_id, t.active_quote_id, t.total_idr, t.quantity, t.delivery_method,
           r.product_name, r.variant, r.merchant_name,
           tr.origin_country, tr.origin_city, tr.destination_city,
           to_char(tr.departure_date, 'YYYY-MM-DD') AS departure_date, to_char(tr.arrival_date, 'YYYY-MM-DD') AS arrival_date,
           tu.display_name AS traveler_name, bu.display_name AS buyer_name
      FROM transactions t
      JOIN requests r ON r.id = t.request_id
      JOIN users bu ON bu.id = t.buyer_id
      LEFT JOIN trips tr ON tr.id = t.trip_id
      LEFT JOIN users tu ON tu.id = t.traveler_id
     WHERE t.id = ${transactionId}`;
  if (!t) return null;
  return {
    id: t.id,
    number: t.number,
    status: t.status,
    buyerId: t.buyer_id,
    travelerId: t.traveler_id,
    productName: t.product_name,
    quantity: t.quantity,
    variant: t.variant,
    merchantName: t.merchant_name,
    travelerPublicName: publicName(t.traveler_name, 'Traveler JastipKita'),
    buyerPublicName: publicName(t.buyer_name, 'Penitip JastipKita'),
    originCountry: t.origin_country,
    originCity: t.origin_city,
    destinationCity: t.destination_city,
    departureDate: t.departure_date,
    arrivalDate: t.arrival_date,
    deliveryMethod: t.delivery_method,
    totalIdr: t.total_idr === null ? null : Number(t.total_idr),
    lines: await loadQuoteLines(db, t.id, t.active_quote_id),
  };
}
