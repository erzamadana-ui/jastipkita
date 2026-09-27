import { getTemplate } from './catalog';
import { firstName, formatDate, formatDateTimeWib, formatIdr, type Locale } from './format';
import { txStatusLabel } from './labels';
import { renderEmailHtml, renderEmailText, type LayoutLinks } from './layout';
import type { LinkTarget, QuoteLineView, RenderedNotification, Role, TxView } from './types';

export interface NotificationRefs {
  transactionId?: string | null;
  disputeId?: string | null;
  conversationId?: string | null;
  ticketId?: string | null;
  tripId?: string | null;
  requestId?: string | null;
}

export interface RenderInput {
  key: string;
  locale: Locale;
  role?: Role | undefined;
  recipientDisplayName: string | null;
  tx?: TxView | undefined;
  vars?: Record<string, unknown>;
  refs?: NotificationRefs;
  webBaseUrl: string;
}

const TRAVELER_LINES = new Set(['ITEM_PRICE', 'TRAVELER_FEE']);

export function buildLinks(target: LinkTarget, refs: NotificationRefs, webBaseUrl: string): { deepLink: string; webUrl: string } {
  const base = webBaseUrl.replace(/\/+$/, '');
  const mk = (webPath: string, appPath: string) => ({ webUrl: `${base}${webPath}`, deepLink: `jastipkita://${appPath}` });
  switch (target) {
    case 'transaction':
      if (refs.transactionId) return mk(`/app/transactions/${refs.transactionId}`, `transactions/${refs.transactionId}`);
      break;
    case 'receipt':
      if (refs.transactionId) return mk(`/app/transactions/${refs.transactionId}/receipt`, `transactions/${refs.transactionId}/receipt`);
      break;
    case 'dispute':
      if (refs.disputeId) return mk(`/app/disputes/${refs.disputeId}`, `disputes/${refs.disputeId}`);
      if (refs.transactionId) return mk(`/app/transactions/${refs.transactionId}`, `transactions/${refs.transactionId}`);
      break;
    case 'conversation':
      if (refs.conversationId) return mk(`/app/chat/${refs.conversationId}`, `conversations/${refs.conversationId}`);
      break;
    case 'referrals':
      return mk('/app/referrals', 'referrals');
    case 'wallet':
      return mk('/app/wallet', 'wallet');
    case 'verification':
      return mk('/app/account/verification', 'account/verification');
    case 'support':
      return refs.ticketId ? mk(`/app/support/tickets/${refs.ticketId}`, `support/tickets/${refs.ticketId}`) : mk('/app/support', 'support');
    case 'account':
      return mk('/app/account', 'account');
    case 'trip':
      if (refs.tripId) return mk(`/app/trips/${refs.tripId}`, `trips/${refs.tripId}`);
      break;
    case 'request':
      if (refs.requestId) return mk(`/app/requests/${refs.requestId}`, `requests/${refs.requestId}`);
      break;
    case 'home':
      break;
  }
  return mk('/app', 'home');
}

export function breakdownFor(tx: TxView | undefined, role: Role | undefined): QuoteLineView[] {
  if (!tx || tx.lines.length === 0) return [];
  if (role === 'TRAVELER') return tx.lines.filter((l) => TRAVELER_LINES.has(l.type));
  return tx.lines;
}

/** Renders every channel of a notification. Pure: all data comes in through `input`. */
export function renderNotification(input: RenderInput): RenderedNotification {
  const def = getTemplate(input.key);
  const locale = input.locale;
  const refs: NotificationRefs = { ...(input.refs ?? {}), ...(input.tx ? { transactionId: input.tx.id } : {}) };
  const v = input.vars ?? {};
  const copy = def.copy[locale]({
    locale,
    role: input.role,
    name: firstName(input.recipientDisplayName, locale),
    tx: input.tx,
    v,
    idr: (n) => formatIdr(Number(n ?? 0), locale),
    dt: (d) => formatDateTimeWib(d, locale),
    date: (d) => formatDate(d, locale),
    status: (st) => txStatusLabel(st, locale),
  });
  const links = buildLinks(def.link, refs, input.webBaseUrl);
  const base = input.webBaseUrl.replace(/\/+$/, '');
  const lines = def.breakdown === 'NONE' ? [] : breakdownFor(input.tx, input.role);
  const layoutLinks: LayoutLinks = {
    ...links,
    receiptUrl: input.tx && lines.length && input.role !== 'TRAVELER' && def.link !== 'receipt' ? `${base}/app/transactions/${input.tx.id}/receipt` : null,
    logoUrl: `${base}/brand/logo-email.png`,
    homeUrl: base,
    supportUrl: `${base}/bantuan`,
    settingsUrl: `${base}/app/settings/notifications`,
    termsUrl: `${base}/legal/syarat-ketentuan`,
    privacyUrl: `${base}/legal/privasi`,
  };
  // vars.txStatus = the status the event moved to (so a late render still shows the right step)
  const statusLabel = input.tx ? txStatusLabel(typeof v.txStatus === 'string' ? v.txStatus : input.tx.status, locale) : null;
  const layout = {
    locale,
    role: input.role,
    name: firstName(input.recipientDisplayName, locale),
    copy,
    tx: input.tx,
    statusLabel,
    lines,
    links: layoutLinks,
  };
  const data: Record<string, string> = { type: def.key, deepLink: links.deepLink, webUrl: links.webUrl };
  for (const [k, val] of Object.entries(refs)) if (typeof val === 'string' && val) data[k] = val;
  return {
    key: def.key,
    group: def.group,
    category: def.category,
    title: copy.title,
    body: copy.body,
    email: { subject: copy.subject, html: renderEmailHtml(layout), text: renderEmailText(layout) },
    push: { title: copy.title, body: copy.body, data },
    links,
  };
}
