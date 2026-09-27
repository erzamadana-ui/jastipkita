/**
 * Notification preference matrix (groups × channels). Rows in notification_preferences store only
 * explicit user choices; everything else falls back to DEFAULTS. LOCKED combinations cannot be
 * switched off (PUT returns 422) and templates may additionally force `critical` channels.
 */
import { CHANNELS, PREF_GROUPS, type Channel, type PrefGroup, type TemplateDef } from './templates/types';

export const DEFAULTS: Record<PrefGroup, Record<Channel, boolean>> = {
  TRANSACTION: { PUSH: true, EMAIL: true, IN_APP: true },
  PAYMENT: { PUSH: true, EMAIL: true, IN_APP: true },
  // chat has its own unread badges; the inbox would flood → IN_APP off by default
  CHAT: { PUSH: true, EMAIL: false, IN_APP: false },
  // marketing: e-mail is opt-in; PUSH/EMAIL additionally require MARKETING consent (UU PDP)
  PROMOTION: { PUSH: true, EMAIL: false, IN_APP: true },
  ACCOUNT: { PUSH: true, EMAIL: true, IN_APP: true },
};

/** Transaction-critical combinations that users cannot disable. */
export const LOCKED: Record<PrefGroup, readonly Channel[]> = {
  TRANSACTION: ['IN_APP'],
  PAYMENT: ['IN_APP', 'EMAIL'], // payment secured / refund / payout e-mails are records of money movements
  CHAT: [],
  PROMOTION: [],
  ACCOUNT: ['IN_APP'],
};

export const GROUP_LABELS: Record<PrefGroup, { id: string; en: string }> = {
  TRANSACTION: { id: 'Status titipan & dispute', en: 'Request status & disputes' },
  PAYMENT: { id: 'Pembayaran, refund & pencairan', en: 'Payments, refunds & payouts' },
  CHAT: { id: 'Pesan chat', en: 'Chat messages' },
  PROMOTION: { id: 'Promo & penawaran', en: 'Promotions & offers' },
  ACCOUNT: { id: 'Akun, verifikasi & keamanan', en: 'Account, verification & security' },
};

export type PrefRows = { category: string; channel: string; enabled: boolean }[];

export interface EffectivePrefs {
  get(group: PrefGroup, channel: Channel): boolean;
}

export function effectivePrefs(rows: PrefRows): EffectivePrefs {
  const map = new Map<string, boolean>();
  for (const r of rows) map.set(`${r.category}:${r.channel}`, r.enabled);
  return {
    get(group, channel) {
      if (LOCKED[group].includes(channel)) return true;
      return map.get(`${group}:${channel}`) ?? DEFAULTS[group][channel];
    },
  };
}

export function isLocked(group: PrefGroup, channel: Channel): boolean {
  return LOCKED[group].includes(channel);
}

export function preferenceMatrix(rows: PrefRows, locale: 'id' | 'en') {
  const prefs = effectivePrefs(rows);
  return PREF_GROUPS.map((group) => ({
    group,
    label: GROUP_LABELS[group][locale],
    channels: CHANNELS.map((channel) => ({ channel, enabled: prefs.get(group, channel), locked: isLocked(group, channel) })),
  }));
}

export type ChannelDecision = { send: true } | { send: false; reason: 'PREFERENCE_DISABLED' | 'NO_MARKETING_CONSENT' | 'NOT_USED' };

/** Which channels a template goes out on for a user. Critical channels ignore preferences. */
export function resolveChannels(def: TemplateDef, prefs: EffectivePrefs, marketingConsent: boolean): Record<Channel, ChannelDecision> {
  const out = {} as Record<Channel, ChannelDecision>;
  for (const ch of CHANNELS) {
    if (!def.channels.includes(ch)) {
      out[ch] = { send: false, reason: 'NOT_USED' };
      continue;
    }
    if (def.critical?.includes(ch)) {
      out[ch] = { send: true };
      continue;
    }
    if (def.marketing && ch !== 'IN_APP' && !marketingConsent) {
      out[ch] = { send: false, reason: 'NO_MARKETING_CONSENT' };
      continue;
    }
    out[ch] = prefs.get(def.group, ch) ? { send: true } : { send: false, reason: 'PREFERENCE_DISABLED' };
  }
  return out;
}
