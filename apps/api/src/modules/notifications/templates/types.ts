import type { Locale } from './format';

/** Preference groups exposed by the API (GET/PUT /notifications/preferences). */
export const PREF_GROUPS = ['TRANSACTION', 'PAYMENT', 'CHAT', 'PROMOTION', 'ACCOUNT'] as const;
export type PrefGroup = (typeof PREF_GROUPS)[number];

export const CHANNELS = ['PUSH', 'EMAIL', 'IN_APP'] as const;
export type Channel = (typeof CHANNELS)[number];

/** notifications.category (DB CHECK, extended in 0050). */
export type NotificationCategory = 'TRANSACTION' | 'PAYMENT' | 'CHAT' | 'TRIP' | 'PROMOTION' | 'REFERRAL' | 'ACCOUNT' | 'SECURITY' | 'SYSTEM';

export type Role = 'BUYER' | 'TRAVELER';

/** Where the CTA points. The e-mail button uses the https fallback (universal link); the app scheme is a secondary link. */
export type LinkTarget =
  | 'transaction'
  | 'receipt'
  | 'dispute'
  | 'conversation'
  | 'referrals'
  | 'wallet'
  | 'verification'
  | 'support'
  | 'account'
  | 'trip'
  | 'request'
  | 'home';

export interface QuoteLineView {
  type: string;
  labelId: string;
  labelEn: string;
  amountIdr: number;
  isEstimate: boolean;
}

/** Transaction facts loaded at render time (never from the event payload — payloads carry ids only). */
export interface TxView {
  id: string;
  number: string;
  status: string;
  buyerId: string;
  travelerId: string | null;
  productName: string;
  quantity: number;
  variant: string | null;
  merchantName: string | null;
  travelerPublicName: string;
  buyerPublicName: string;
  originCountry: string | null;
  originCity: string | null;
  destinationCity: string | null;
  departureDate: string | null;
  arrivalDate: string | null;
  deliveryMethod: string | null;
  totalIdr: number | null;
  lines: QuoteLineView[];
}

export interface Highlight {
  tone: 'success' | 'warning' | 'info' | 'danger';
  text: string;
}

/** Copy for one locale. Plain text only — the layout escapes everything. */
export interface Copy {
  /** push / in-app title */
  title: string;
  /** push / in-app body */
  body: string;
  subject: string;
  heading: string;
  paragraphs: string[];
  highlight?: Highlight;
  cta: string;
  /** extra key/value rows shown under the transaction summary */
  details?: [string, string][];
}

export interface CopyContext {
  locale: Locale;
  role: Role | undefined;
  /** recipient first name for greetings */
  name: string;
  tx: TxView | undefined;
  /** event-specific values (ids, amounts, statuses, ISO dates, short codes) — never raw PII of others */
  v: Record<string, unknown>;
  idr: (n: unknown) => string;
  dt: (d: unknown) => string;
  date: (d: unknown) => string;
  status: (s: unknown) => string;
}

export interface TemplateDef {
  key: string;
  group: PrefGroup;
  category: NotificationCategory;
  /** channels this template can use at all */
  channels: readonly Channel[];
  /** channels delivered regardless of the user's preferences (transaction-critical) */
  critical?: readonly Channel[];
  /** promotional content: needs MARKETING consent for PUSH/EMAIL */
  marketing?: boolean;
  /** price breakdown table in e-mails: buyer FULL, traveler sees item + fee only */
  breakdown?: 'AUTO' | 'NONE';
  link: LinkTarget;
  copy: Record<Locale, (c: CopyContext) => Copy>;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface RenderedNotification {
  key: string;
  group: PrefGroup;
  category: NotificationCategory;
  title: string;
  body: string;
  email: RenderedEmail;
  push: { title: string; body: string; data: Record<string, string> };
  links: { deepLink: string; webUrl: string };
}
