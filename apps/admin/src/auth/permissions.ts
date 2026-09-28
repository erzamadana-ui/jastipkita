/**
 * Permission model for the UI. `/v1/me.permissions` carries the effective permission codes from the DB
 * (role_permissions) and is the source of truth; the role → permission matrix below mirrors the RBAC seed
 * (db/scripts/gen-reference-seed.mjs, docs/api/admin.md §2) only as a fallback for an older API.
 * The UI uses permissions ONLY to hide/disable controls — the API re-checks every route (PERMISSION_DENIED / ROLE_REQUIRED).
 */
export const PERMISSIONS = [
  'users.read', 'users.suspend', 'kyc.review', 'trips.verify', 'transactions.read', 'transactions.override',
  'disputes.manage', 'refunds.request', 'refunds.approve', 'payouts.manage', 'finance.reports.read',
  'finance.settlement.read_masked', 'finance.settlement.request_change', 'finance.settlement.approve_change',
  'config.read', 'config.propose', 'config.approve', 'customs.rules.manage', 'restricted.rules.manage',
  'promotions.manage', 'referrals.manage', 'risk.read', 'risk.review', 'trust.override.request',
  'trust.override.approve', 'support.tickets.manage', 'chat.moderate', 'audit.read', 'infra.db.read',
  'infra.db.operate', 'analytics.read', 'legal.documents.manage', 'faq.manage', 'rbac.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ADMIN_ROLES = ['SUPER_ADMIN', 'OPERATIONS', 'FINANCE', 'FINANCE_SUPER_ADMIN', 'RISK', 'SUPPORT', 'MARKETING', 'COMPLIANCE'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

const FINANCE: Permission[] = [
  'users.read', 'transactions.read', 'refunds.request', 'refunds.approve', 'payouts.manage', 'finance.reports.read',
  'finance.settlement.read_masked', 'finance.settlement.request_change', 'config.read', 'audit.read', 'analytics.read',
];

export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS.filter((p) => p !== 'finance.settlement.approve_change'),
  OPERATIONS: [
    'users.read', 'kyc.review', 'trips.verify', 'transactions.read', 'transactions.override', 'disputes.manage',
    'refunds.request', 'support.tickets.manage', 'chat.moderate', 'config.read', 'risk.read', 'analytics.read',
  ],
  FINANCE,
  FINANCE_SUPER_ADMIN: [...FINANCE, 'finance.settlement.approve_change', 'config.approve'],
  RISK: [
    'users.read', 'users.suspend', 'kyc.review', 'transactions.read', 'risk.read', 'risk.review',
    'trust.override.request', 'audit.read', 'config.read', 'analytics.read',
  ],
  SUPPORT: ['users.read', 'transactions.read', 'support.tickets.manage', 'chat.moderate', 'refunds.request', 'faq.manage'],
  MARKETING: ['promotions.manage', 'referrals.manage', 'analytics.read', 'faq.manage', 'config.read', 'config.propose'],
  COMPLIANCE: [
    'users.read', 'transactions.read', 'kyc.review', 'customs.rules.manage', 'restricted.rules.manage',
    'legal.documents.manage', 'audit.read', 'config.read', 'config.propose', 'risk.read',
  ],
};

export function permissionsFor(roles: readonly string[], serverPermissions?: readonly string[] | null): Set<Permission> {
  const known = new Set<string>(PERMISSIONS);
  if (Array.isArray(serverPermissions)) return new Set(serverPermissions.filter((p): p is Permission => known.has(p)));
  const out = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r as AdminRole] ?? []) out.add(p);
  return out;
}

export function isAdmin(roles: readonly string[]): boolean {
  return roles.some((r) => (ADMIN_ROLES as readonly string[]).includes(r));
}

/** A capability = permissions (all required) + optionally a role the API additionally demands (ROLE_REQUIRED). */
export interface Capability {
  perms: readonly Permission[];
  role?: AdminRole;
}

export function hasCapability(perms: Set<Permission>, roles: readonly string[], cap: Capability): boolean {
  return cap.perms.every((p) => perms.has(p)) && (!cap.role || roles.includes(cap.role));
}

export function missingFor(perms: Set<Permission>, roles: readonly string[], cap: Capability): string[] {
  const miss: string[] = cap.perms.filter((p) => !perms.has(p));
  if (cap.role && !roles.includes(cap.role)) miss.push(`peran ${cap.role}`);
  return miss;
}

// ------------------------------------------------------------------ navigation

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  cap: Capability;
}
export interface NavSection {
  title: string;
  items: NavItem[];
}
export type IconName =
  | 'dashboard' | 'users' | 'kyc' | 'trip' | 'tx' | 'dispute' | 'refund' | 'payout' | 'bank' | 'recon' | 'risk'
  | 'trust' | 'referral' | 'promo' | 'config' | 'customs' | 'restricted' | 'ticket' | 'chat' | 'faq' | 'legal'
  | 'audit' | 'rbac' | 'db' | 'shield';

export const NAV: NavSection[] = [
  { title: 'Ringkasan', items: [{ to: '/', label: 'Dashboard', icon: 'dashboard', cap: { perms: ['analytics.read'] } }] },
  {
    title: 'Operasional',
    items: [
      { to: '/users', label: 'Pengguna', icon: 'users', cap: { perms: ['users.read'] } },
      { to: '/kyc', label: 'Review KYC', icon: 'kyc', cap: { perms: ['kyc.review'] } },
      { to: '/trips', label: 'Verifikasi trip', icon: 'trip', cap: { perms: ['trips.verify'] } },
      { to: '/transactions', label: 'Transaksi', icon: 'tx', cap: { perms: ['transactions.read'] } },
      { to: '/disputes', label: 'Dispute', icon: 'dispute', cap: { perms: ['disputes.manage'] } },
    ],
  },
  {
    title: 'Keuangan',
    items: [
      { to: '/refunds', label: 'Persetujuan refund', icon: 'refund', cap: { perms: ['refunds.approve'] } },
      { to: '/refund-destinations', label: 'Review rekening refund', icon: 'shield', cap: { perms: ['refunds.approve'] } },
      { to: '/payouts', label: 'Payout traveler', icon: 'payout', cap: { perms: ['payouts.manage'] } },
      { to: '/finance/settlement', label: 'Rekening settlement', icon: 'bank', cap: { perms: ['finance.settlement.read_masked'] } },
      { to: '/finance/reconciliation', label: 'Rekonsiliasi', icon: 'recon', cap: { perms: ['finance.reports.read'] } },
    ],
  },
  {
    title: 'Risiko & growth',
    items: [
      { to: '/risk', label: 'Review risiko', icon: 'risk', cap: { perms: ['risk.read'] } },
      { to: '/trust', label: 'Override Trust Score', icon: 'trust', cap: { perms: ['risk.read'] } },
      { to: '/referrals', label: 'Referral', icon: 'referral', cap: { perms: ['referrals.manage'] } },
      { to: '/promotions', label: 'Promo', icon: 'promo', cap: { perms: ['promotions.manage'] } },
    ],
  },
  {
    title: 'Konfigurasi',
    items: [
      { to: '/config', label: 'Business config', icon: 'config', cap: { perms: ['config.read'] } },
      { to: '/rules/customs', label: 'Aturan bea cukai', icon: 'customs', cap: { perms: ['customs.rules.manage'] } },
      { to: '/rules/restricted', label: 'Barang terbatas', icon: 'restricted', cap: { perms: ['restricted.rules.manage'] } },
    ],
  },
  {
    title: 'Support',
    items: [
      { to: '/support', label: 'Tiket support', icon: 'ticket', cap: { perms: ['support.tickets.manage'] } },
      { to: '/chat-moderation', label: 'Moderasi chat', icon: 'chat', cap: { perms: ['chat.moderate'] } },
    ],
  },
  {
    title: 'Konten & audit',
    items: [
      { to: '/content/faq', label: 'FAQ', icon: 'faq', cap: { perms: ['faq.manage'] } },
      { to: '/content/legal', label: 'Dokumen legal', icon: 'legal', cap: { perms: ['legal.documents.manage'] } },
      { to: '/audit', label: 'Audit log', icon: 'audit', cap: { perms: ['audit.read'] } },
    ],
  },
  {
    title: 'Sistem',
    items: [
      { to: '/rbac', label: 'Peran & akses', icon: 'rbac', cap: { perms: ['rbac.manage'] } },
      { to: '/infra', label: 'DB & Infra Center', icon: 'db', cap: { perms: ['infra.db.read'] } },
    ],
  },
];

/** Sections/items the admin may open (items without the capability are hidden, empty sections dropped). */
export function visibleNav(perms: Set<Permission>, roles: readonly string[]): NavSection[] {
  return NAV.map((s) => ({ ...s, items: s.items.filter((i) => hasCapability(perms, roles, i.cap)) })).filter((s) => s.items.length > 0);
}

/** First page the admin can open (dashboard needs analytics.read, which SUPPORT/COMPLIANCE lack). */
export function homePath(perms: Set<Permission>, roles: readonly string[]): string {
  return visibleNav(perms, roles)[0]?.items[0]?.to ?? '/no-access';
}

/** Capabilities of sensitive actions used across pages (single source for button gating). */
export const CAP = {
  revealPii: { perms: ['users.read'] },
  suspendUser: { perms: ['users.suspend'] },
  manageRoles: { perms: ['rbac.manage'] },
  approveRoleRequest: { perms: ['rbac.manage'], role: 'SUPER_ADMIN' },
  mfaResetRequest: { perms: ['rbac.manage'] },
  mfaResetApprove: { perms: ['rbac.manage'], role: 'SUPER_ADMIN' },
  kycReview: { perms: ['kyc.review'] },
  tripVerify: { perms: ['trips.verify'] },
  txCancel: { perms: ['transactions.override'] },
  txRefund: { perms: ['transactions.override', 'refunds.request'] },
  disputes: { perms: ['disputes.manage'] },
  refundApprove: { perms: ['refunds.approve'] },
  refundDestinationReview: { perms: ['refunds.approve'] },
  payouts: { perms: ['payouts.manage'] },
  settlementRequest: { perms: ['finance.settlement.request_change'] },
  settlementApprove: { perms: ['finance.settlement.approve_change'], role: 'FINANCE_SUPER_ADMIN' },
  configPropose: { perms: ['config.propose'] },
  configApprove: { perms: ['config.approve'] },
  promotions: { perms: ['promotions.manage'] },
  referrals: { perms: ['referrals.manage'] },
  riskReview: { perms: ['risk.review'] },
  trustRequest: { perms: ['trust.override.request'] },
  trustApprove: { perms: ['trust.override.approve'] },
  support: { perms: ['support.tickets.manage'] },
  chat: { perms: ['chat.moderate'] },
  faq: { perms: ['faq.manage'] },
  legal: { perms: ['legal.documents.manage'] },
  audit: { perms: ['audit.read'] },
  infraRead: { perms: ['infra.db.read'] },
  infraOperate: { perms: ['infra.db.read', 'infra.db.operate'], role: 'SUPER_ADMIN' },
  customs: { perms: ['customs.rules.manage'] },
  restricted: { perms: ['restricted.rules.manage'] },
} satisfies Record<string, Capability>;
