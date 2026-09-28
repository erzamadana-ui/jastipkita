/**
 * Typed wrappers for the admin + auth endpoints used by the UI. Paths, params and bodies are checked against the
 * generated OpenAPI types; response bodies are cast to the DTOs in ./types (the contract marks them AdminResult).
 * Financial writes take an Idempotency-Key (see IdempotencyKeys); sensitive writes are wrapped by the caller in
 * withStepUp() (MFA_REQUIRED → TOTP → retry).
 */
import { api, call } from './client';
import type { paths } from './schema';
import type * as T from './types';

type Op<P extends keyof paths, M extends 'get' | 'post' | 'patch' | 'delete'> = paths[P] extends Record<M, infer O> ? O : never;
export type QueryOf<P extends keyof paths, M extends 'get' | 'post' = 'get'> = NonNullable<Op<P, M> extends { parameters: { query?: infer Q } } ? Q : never>;
export type BodyOf<P extends keyof paths, M extends 'post' | 'patch' | 'delete' = 'post'> = Op<P, M> extends { requestBody?: { content: { 'application/json': infer B } } } ? B : never;

const c = () => api().client;
const idem = (key: string) => ({ 'idempotency-key': key });

// ------------------------------------------------------------------ auth / me
export const Auth = {
  requestOtp: (email: string) =>
    call<T.Schemas['OtpChallenge']>(c().POST('/v1/auth/otp/request', { body: { channel: 'EMAIL', destination: email.trim().toLowerCase(), purpose: 'LOGIN', locale: 'id' } })),
  verifyOtp: (challengeId: string, code: string, fingerprint: string) =>
    call<T.Schemas['OtpVerifyResult']>(
      c().POST('/v1/auth/otp/verify', { body: { challengeId, code, device: { platform: 'WEB', fingerprint, appVersion: 'admin-web' } } }),
    ),
  me: () => call<T.Profile>(c().GET('/v1/me')),
  logout: () => call<{ ok: true }>(c().POST('/v1/auth/logout')),
  enrollTotp: () => call<T.Schemas['MfaEnrollment']>(c().POST('/v1/auth/mfa/totp/enroll')),
  confirmTotp: (code: string) => call<T.Schemas['MfaConfirmation']>(c().POST('/v1/auth/mfa/totp/confirm', { body: { code } })),
  verifyMfa: (input: { code?: string; recoveryCode?: string }) => call<T.Schemas['MfaStepUp']>(c().POST('/v1/auth/mfa/verify', { body: input })),
};

// ------------------------------------------------------------------ dashboard & system
export const Dashboard = {
  kpis: (q: QueryOf<'/v1/admin/dashboard/kpis'>) => call<T.AdminKpis>(c().GET('/v1/admin/dashboard/kpis', { params: { query: q } })),
  timeseries: (q: QueryOf<'/v1/admin/dashboard/timeseries'>) => call<T.AdminTimeSeries>(c().GET('/v1/admin/dashboard/timeseries', { params: { query: q } })),
  funnel: (q: QueryOf<'/v1/admin/dashboard/funnel'>) => call<T.AdminFunnel>(c().GET('/v1/admin/dashboard/funnel', { params: { query: q } })),
};

export const System = {
  health: () => call<T.SystemHealth>(c().GET('/v1/admin/system/health')),
  alerts: () => call<T.AlertsResponse>(c().GET('/v1/admin/system/alerts')),
};

// ------------------------------------------------------------------ users & rbac
export const Users = {
  search: (q: QueryOf<'/v1/admin/users'>) => call<T.Page<T.MaskedUser>>(c().GET('/v1/admin/users', { params: { query: q } })),
  detail: (id: string) => call<T.UserDetail>(c().GET('/v1/admin/users/{id}', { params: { path: { id } } })),
  reveal: (id: string, reason: string) => call<T.RevealedContact>(c().POST('/v1/admin/users/{id}/reveal-contact', { params: { path: { id } }, body: { reason } })),
  suspend: (id: string, reason: string) =>
    call<{ id: string; status: string; sessionsRevoked: number; openTransactions: number; warning: string | null }>(c().POST('/v1/admin/users/{id}/suspend', { params: { path: { id } }, body: { reason } })),
  reactivate: (id: string, reason: string) => call<{ id: string; status: string }>(c().POST('/v1/admin/users/{id}/reactivate', { params: { path: { id } }, body: { reason } })),
  forceLogout: (id: string, reason: string) => call<{ id: string; sessionsRevoked: number }>(c().POST('/v1/admin/users/{id}/force-logout', { params: { path: { id } }, body: { reason } })),
  grantRole: (id: string, roleCode: string, reason: string) => call<T.RoleGrantResult>(c().POST('/v1/admin/users/{id}/roles', { params: { path: { id } }, body: { roleCode, reason } })),
  revokeRole: (id: string, roleCode: string, reason: string) =>
    call<{ userId: string; roleCode: string; revoked: true }>(c().DELETE('/v1/admin/users/{id}/roles/{roleCode}', { params: { path: { id, roleCode } }, body: { reason } })),
};

export const Rbac = {
  roles: () => call<T.RolesResponse>(c().GET('/v1/admin/rbac/roles')),
  requests: (status?: QueryOf<'/v1/admin/rbac/role-requests'>['status']) => call<T.Page<T.RoleRequest>>(c().GET('/v1/admin/rbac/role-requests', { params: { query: status ? { status } : {} } })),
  approve: (id: string, note?: string) => call<{ id: string; status: string }>(c().POST('/v1/admin/rbac/role-requests/{id}/approve', { params: { path: { id } }, body: note ? { note } : {} })),
  reject: (id: string, note: string) => call<{ id: string; status: string }>(c().POST('/v1/admin/rbac/role-requests/{id}/reject', { params: { path: { id } }, body: { note } })),
};

/** SEC-13 — confirmed TOTP factors are reset only through a maker-checker request (docs/api/admin.md §1). */
export const MfaResets = {
  request: (userId: string, reason: string) =>
    call<T.MfaResetRequest & { message?: string }>(c().POST('/v1/admin/users/{id}/mfa-reset-requests', { params: { path: { id: userId } }, body: { reason } })),
  list: (status?: QueryOf<'/v1/admin/rbac/mfa-reset-requests'>['status']) =>
    call<T.Page<T.MfaResetRequest>>(c().GET('/v1/admin/rbac/mfa-reset-requests', { params: { query: status ? { status } : {} } })),
  approve: (id: string, note?: string) =>
    call<{ id: string; status: string; userId: string; sessionsRevoked: number }>(c().POST('/v1/admin/rbac/mfa-reset-requests/{id}/approve', { params: { path: { id } }, body: note ? { note } : {} })),
  reject: (id: string, note: string) => call<{ id: string; status: string }>(c().POST('/v1/admin/rbac/mfa-reset-requests/{id}/reject', { params: { path: { id } }, body: { note } })),
};

// ------------------------------------------------------------------ kyc & trips
export const Kyc = {
  queue: (q: QueryOf<'/v1/admin/kyc/submissions'>) => call<T.Page<T.KycSubmission>>(c().GET('/v1/admin/kyc/submissions', { params: { query: q } })),
  detail: (id: string) => call<T.KycDetail>(c().GET('/v1/admin/kyc/submissions/{id}', { params: { path: { id } } })),
  approve: (id: string, body: BodyOf<'/v1/admin/kyc/submissions/{id}/approve'>) =>
    call<{ id: string; status: string; kycLevel: number }>(c().POST('/v1/admin/kyc/submissions/{id}/approve', { params: { path: { id } }, body })),
  reject: (id: string, body: BodyOf<'/v1/admin/kyc/submissions/{id}/reject'>) =>
    call<{ id: string; status: string }>(c().POST('/v1/admin/kyc/submissions/{id}/reject', { params: { path: { id } }, body })),
  payoutAccounts: () => call<T.Page<T.PayoutAccountReview>>(c().GET('/v1/admin/kyc/payout-accounts')),
  overridePayoutAccount: (id: string, body: BodyOf<'/v1/admin/kyc/payout-accounts/{id}/verification-override'>) =>
    call<{ id: string; verificationStatus: string }>(c().POST('/v1/admin/kyc/payout-accounts/{id}/verification-override', { params: { path: { id } }, body })),
};

export const Trips = {
  queue: (q: QueryOf<'/v1/admin/trips/verifications'>) => call<T.Page<T.TripSummary>>(c().GET('/v1/admin/trips/verifications', { params: { query: q } })),
  detail: (id: string) => call<T.TripDetail>(c().GET('/v1/admin/trips/{id}', { params: { path: { id } } })),
  approve: (id: string, note?: string) => call<{ id: string; status: string }>(c().POST('/v1/admin/trips/{id}/verification/approve', { params: { path: { id } }, body: note ? { note } : {} })),
  reject: (id: string, reason: string) => call<{ id: string; status: string }>(c().POST('/v1/admin/trips/{id}/verification/reject', { params: { path: { id } }, body: { reason } })),
};

// ------------------------------------------------------------------ transactions / disputes / money
export const Transactions = {
  list: (q: QueryOf<'/v1/admin/transactions'>) => call<T.Page<T.TxListItem>>(c().GET('/v1/admin/transactions', { params: { query: q } })),
  detail: (id: string) => call<T.TransactionDetail>(c().GET('/v1/admin/transactions/{id}', { params: { path: { id } } })),
  cancel: (id: string, body: BodyOf<'/v1/admin/transactions/{id}/cancel'>, key: string) =>
    call<{ status: string }>(c().POST('/v1/admin/transactions/{id}/cancel', { params: { path: { id }, header: idem(key) }, body })),
  refund: (id: string, body: BodyOf<'/v1/admin/transactions/{id}/refund'>, key: string) =>
    call<{ status: string | null; refunds: T.RefundView[]; created: string[]; note: string | null }>(
      c().POST('/v1/admin/transactions/{id}/refund', { params: { path: { id }, header: idem(key) }, body }),
    ),
};

export const Disputes = {
  queue: (q: QueryOf<'/v1/admin/disputes'>) => call<T.Page<T.DisputeListItem>>(c().GET('/v1/admin/disputes', { params: { query: q } })),
  detail: (id: string) => call<T.DisputeDetail>(c().GET('/v1/admin/disputes/{id}', { params: { path: { id } } })),
  assign: (id: string, assigneeId?: string) => call<{ id: string; assigneeId: string }>(c().POST('/v1/admin/disputes/{id}/assign', { params: { path: { id } }, body: assigneeId ? { assigneeId } : {} })),
  requestEvidence: (id: string, note: string, dueHours: number) =>
    call<{ id: string; status: string }>(c().POST('/v1/admin/disputes/{id}/request-evidence', { params: { path: { id } }, body: { note, dueHours } })),
  review: (id: string, body: BodyOf<'/v1/admin/disputes/{id}/review'>) => call<{ id: string; status: string }>(c().POST('/v1/admin/disputes/{id}/review', { params: { path: { id } }, body })),
  resolve: (id: string, body: BodyOf<'/v1/admin/disputes/{id}/resolve'>, key: string) =>
    call<{ id: string; status: string; execution: { status: string; reason?: string }; transactionStatus: string | null }>(
      c().POST('/v1/admin/disputes/{id}/resolve', { params: { path: { id }, header: idem(key) }, body }),
    ),
  close: (id: string, note: string) => call<{ id: string; status: string }>(c().POST('/v1/admin/disputes/{id}/close', { params: { path: { id } }, body: { note } })),
};

/** SEC-12 — refund destinations held for manual review because the holder name ≠ the verified identity. */
export const RefundDestinations = {
  list: (status?: string) => call<T.Page<T.RefundDestinationItem>>(c().GET('/v1/admin/refund-destinations', { params: { query: status ? { status } : {} } })),
  review: (id: string, body: { decision: 'APPROVE' | 'REJECT'; note: string }, key: string) =>
    call<{ id: string; refundId: string; validationStatus: string }>(c().POST('/v1/admin/refund-destinations/{id}/review', { params: { path: { id }, header: idem(key) }, body })),
};

export const Refunds = {
  queue: (q: QueryOf<'/v1/admin/refunds'>) => call<T.Page<T.RefundQueueItem>>(c().GET('/v1/admin/refunds', { params: { query: q } })),
  approve: (id: string, key: string) => call<{ id: string; status: string }>(c().POST('/v1/admin/refunds/{id}/approve', { params: { path: { id }, header: idem(key) } })),
  reject: (id: string, reason: string, key: string) =>
    call<{ id: string; status: string; transactionFollowUp: string; note: string | null }>(c().POST('/v1/admin/refunds/{id}/reject', { params: { path: { id }, header: idem(key) }, body: { reason } })),
};

export const Payouts = {
  list: (q: QueryOf<'/v1/admin/payouts'>) => call<T.Page<T.PayoutItem>>(c().GET('/v1/admin/payouts', { params: { query: q } })),
  hold: (id: string, reason: string, key: string) => call<{ id: string; status: string }>(c().POST('/v1/admin/payouts/{id}/hold', { params: { path: { id }, header: idem(key) }, body: { reason } })),
  release: (id: string, note: string, key: string) =>
    call<{ id: string; status: string; warnings: string[] }>(c().POST('/v1/admin/payouts/{id}/release', { params: { path: { id }, header: idem(key) }, body: { note } })),
  retry: (id: string, note: string, key: string) => call<{ id: string; status: string }>(c().POST('/v1/admin/payouts/{id}/retry', { params: { path: { id }, header: idem(key) }, body: { note } })),
};

export const Reconciliation = {
  runs: (q: QueryOf<'/v1/admin/reconciliation/runs'>) => call<T.Page<T.ReconciliationRun>>(c().GET('/v1/admin/reconciliation/runs', { params: { query: q } })),
  items: (id: string, q: QueryOf<'/v1/admin/reconciliation/runs/{id}/items'>) =>
    call<T.Page<T.ReconciliationItem>>(c().GET('/v1/admin/reconciliation/runs/{id}/items', { params: { path: { id }, query: q } })),
  resolve: (id: string, note: string) =>
    call<{ id: string; runId: string; status: string; previousStatus: string }>(c().POST('/v1/admin/reconciliation/items/{id}/resolve', { params: { path: { id } }, body: { note } })),
  start: (body: { periodStart: string; periodEnd: string; reason: string }, key: string) =>
    call<{ runId: string; status: string; payments: number; mismatches: number }>(c().POST('/v1/admin/reconciliation/runs', { params: { header: idem(key) }, body })),
};

// ------------------------------------------------------------------ config & rules
export const Config = {
  list: () => call<T.ConfigListResponse>(c().GET('/v1/admin/config')),
  detail: (key: string) => call<T.ConfigDetail>(c().GET('/v1/admin/config/{key}', { params: { path: { key } } })),
  diff: (key: string, version: number, against?: number) =>
    call<T.ConfigDiff>(c().GET('/v1/admin/config/{key}/diff', { params: { path: { key }, query: against !== undefined ? { version, against } : { version } } })),
  propose: (key: string, body: BodyOf<'/v1/admin/config/{key}/versions'>) =>
    call<T.ConfigVersion & { diffFromActive: T.DiffEntry[] }>(c().POST('/v1/admin/config/{key}/versions', { params: { path: { key } }, body })),
  approve: (id: string) => call<T.ConfigVersion>(c().POST('/v1/admin/config-versions/{id}/approve', { params: { path: { id } } })),
  reject: (id: string, reason: string) => call<T.ConfigVersion>(c().POST('/v1/admin/config-versions/{id}/reject', { params: { path: { id } }, body: { reason } })),
};

const RULE_BASE = { customs: '/v1/admin/customs-rules', restricted: '/v1/admin/restricted-items' } as const;

/** Customs rules and restricted items share one lifecycle (11 routes each). */
export function Rules(kind: T.RuleKind) {
  const base = RULE_BASE[kind];
  type Body = Record<string, unknown>;
  const post = <R>(path: string, id: string, body?: Body) =>
    // the two route families are structurally identical; one cast keeps the call sites small
    call<R>((c().POST as unknown as (p: string, o: unknown) => Promise<never>)(`${base}${path}`, { params: { path: { id } }, body: body ?? {} }));
  return {
    list: (q: { status?: string; code?: string; limit?: number }) =>
      call<T.Page<T.RuleVersion>>((c().GET as unknown as (p: string, o: unknown) => Promise<never>)(base, { params: { query: { limit: 100, ...q } } })),
    detail: (id: string) => call<T.RuleDetail>((c().GET as unknown as (p: string, o: unknown) => Promise<never>)(`${base}/{id}`, { params: { path: { id } } })),
    create: (body: Body) => call<T.RuleVersion>((c().POST as unknown as (p: string, o: unknown) => Promise<never>)(base, { body })),
    patch: (id: string, body: Body) => call<T.RuleVersion>((c().PATCH as unknown as (p: string, o: unknown) => Promise<never>)(`${base}/{id}`, { params: { path: { id } }, body })),
    discard: (id: string, reason: string) => post<{ id: string; status: string }>('/{id}/discard', id, { reason }),
    submit: (id: string) => post<{ id: string; status: string }>('/{id}/submit', id),
    approve: (id: string) => post<{ id: string; status: string; superseded: unknown[] }>('/{id}/approve', id),
    reject: (id: string, reason: string) => post<{ id: string; status: string }>('/{id}/reject', id, { reason }),
    retire: (id: string, reason: string) => post<{ id: string; status: string }>('/{id}/retire', id, { reason }),
    reverify: (id: string, body: { lastVerifiedAt: string; verifiedBy: string; sourceNote?: string }) => post<{ id: string }>('/{id}/reverify', id, body),
    preview: (id: string, body: BodyOf<'/v1/admin/customs-rules/{id}/preview'>) => post<T.RulePreviewResult>('/{id}/preview', id, body as Body),
  };
}

// ------------------------------------------------------------------ settlement
export const Settlement = {
  accounts: () => call<T.Page<T.SettlementAccount>>(c().GET('/v1/admin/settlement-accounts')),
  changes: (status?: QueryOf<'/v1/admin/settlement-accounts/changes'>['status']) =>
    call<T.Page<T.SettlementChange>>(c().GET('/v1/admin/settlement-accounts/changes', { params: { query: status ? { status } : {} } })),
  request: (body: BodyOf<'/v1/admin/settlement-accounts/changes'>, key: string) =>
    call<T.SettlementChange>(c().POST('/v1/admin/settlement-accounts/changes', { params: { header: idem(key) }, body })),
  approve: (id: string, note: string | undefined, key: string) =>
    call<{ changeId: string; status: string }>(c().POST('/v1/admin/settlement-accounts/changes/{id}/approve', { params: { path: { id }, header: idem(key) }, body: note ? { note } : {} })),
  reject: (id: string, note: string, key: string) =>
    call<{ changeId: string; status: string }>(c().POST('/v1/admin/settlement-accounts/changes/{id}/reject', { params: { path: { id }, header: idem(key) }, body: { note } })),
};

// ------------------------------------------------------------------ growth
export const Promotions = {
  list: (status?: string) => call<T.Page<T.Promotion>>(c().GET('/v1/admin/promotions', { params: { query: status ? { status } : {} } })),
  detail: (id: string) => call<T.Promotion>(c().GET('/v1/admin/promotions/{id}', { params: { path: { id } } })),
  create: (body: BodyOf<'/v1/admin/promotions'>) => call<T.Promotion>(c().POST('/v1/admin/promotions', { body })),
  patch: (id: string, body: BodyOf<'/v1/admin/promotions/{id}', 'patch'>) => call<T.Promotion>(c().PATCH('/v1/admin/promotions/{id}', { params: { path: { id } }, body })),
  activate: (id: string) => call<T.Promotion>(c().POST('/v1/admin/promotions/{id}/activate', { params: { path: { id } } })),
  pause: (id: string, reason: string) => call<T.Promotion>(c().POST('/v1/admin/promotions/{id}/pause', { params: { path: { id } }, body: { reason } })),
  end: (id: string, reason: string) => call<T.Promotion>(c().POST('/v1/admin/promotions/{id}/end', { params: { path: { id } }, body: { reason } })),
};

export const Referrals = {
  stats: () => call<T.ReferralStats>(c().GET('/v1/admin/referrals/stats')),
  list: (status?: string) => call<T.Page<T.Referral>>(c().GET('/v1/admin/referrals', { params: { query: status ? { status } : {} } })),
  reject: (id: string, reason: string) => call<{ id: string; status: string }>(c().POST('/v1/admin/referrals/{id}/reject', { params: { path: { id } }, body: { reason } })),
  hold: (id: string, reason: string) => call<{ id: string; status: string }>(c().POST('/v1/admin/referrals/{id}/hold', { params: { path: { id } }, body: { reason } })),
  release: (id: string, note: string, key: string) =>
    call<{ id: string; status: string }>(c().POST('/v1/admin/referrals/{id}/release', { params: { path: { id }, header: idem(key) }, body: { note } })),
};

// ------------------------------------------------------------------ risk & trust
export const Risk = {
  queue: (q: QueryOf<'/v1/admin/risk/reviews'>) => call<T.Page<T.RiskReview>>(c().GET('/v1/admin/risk/reviews', { params: { query: q } })),
  detail: (id: string) => call<T.RiskReviewDetail>(c().GET('/v1/admin/risk/reviews/{id}', { params: { path: { id } } })),
  assign: (id: string) => call<{ id: string; status: string }>(c().POST('/v1/admin/risk/reviews/{id}/assign', { params: { path: { id } }, body: {} })),
  resolve: (id: string, body: BodyOf<'/v1/admin/risk/reviews/{id}/resolve'>) =>
    call<{ id: string; status: string; effects: string[]; suspension: unknown }>(c().POST('/v1/admin/risk/reviews/{id}/resolve', { params: { path: { id } }, body })),
};

export const Trust = {
  list: (status?: QueryOf<'/v1/admin/trust/overrides'>['status']) => call<T.Page<T.TrustOverride>>(c().GET('/v1/admin/trust/overrides', { params: { query: status ? { status } : {} } })),
  request: (body: BodyOf<'/v1/admin/trust/overrides'>) => call<T.TrustOverride>(c().POST('/v1/admin/trust/overrides', { body })),
  approve: (id: string, note?: string) => call<{ id: string; status: string }>(c().POST('/v1/admin/trust/overrides/{id}/approve', { params: { path: { id } }, body: note ? { note } : {} })),
  reject: (id: string, note: string) => call<{ id: string; status: string }>(c().POST('/v1/admin/trust/overrides/{id}/reject', { params: { path: { id } }, body: { note } })),
};

// ------------------------------------------------------------------ support & chat
export const Support = {
  tickets: (q: QueryOf<'/v1/admin/support/tickets'>) => call<T.Page<T.Ticket>>(c().GET('/v1/admin/support/tickets', { params: { query: q } })),
  sla: () => call<T.SlaView>(c().GET('/v1/admin/support/sla')),
  ticket: (id: string) => call<T.TicketDetail>(c().GET('/v1/admin/support/tickets/{id}', { params: { path: { id } } })),
  assign: (id: string) => call<{ id: string }>(c().POST('/v1/admin/support/tickets/{id}/assign', { params: { path: { id } }, body: {} })),
  reply: (id: string, body: BodyOf<'/v1/admin/support/tickets/{id}/reply'>) => call<{ id: string; status: string }>(c().POST('/v1/admin/support/tickets/{id}/reply', { params: { path: { id } }, body })),
  update: (id: string, body: BodyOf<'/v1/admin/support/tickets/{id}', 'patch'>) => call<{ id: string; status: string }>(c().PATCH('/v1/admin/support/tickets/{id}', { params: { path: { id } }, body })),
};

export const Chat = {
  flagged: (q: QueryOf<'/v1/admin/chat/flagged'>) => call<T.Page<T.FlaggedMessage>>(c().GET('/v1/admin/chat/flagged', { params: { query: q } })),
  reveal: (id: string, reason: string) => call<T.RevealedMessage>(c().POST('/v1/admin/chat/messages/{id}/reveal', { params: { path: { id } }, body: { reason } })),
  hide: (id: string, reason: string) => call<{ id: string }>(c().POST('/v1/admin/chat/messages/{id}/hide', { params: { path: { id } }, body: { reason } })),
  unhide: (id: string, reason: string) => call<{ id: string }>(c().POST('/v1/admin/chat/messages/{id}/unhide', { params: { path: { id } }, body: { reason } })),
  conversation: (id: string, q: QueryOf<'/v1/admin/chat/conversations/{id}/messages'>) =>
    call<T.ConversationView>(c().GET('/v1/admin/chat/conversations/{id}/messages', { params: { path: { id }, query: q } })),
};

// ------------------------------------------------------------------ content & audit
export const Faq = {
  list: (q: QueryOf<'/v1/admin/faq'>) => call<T.Page<T.FaqArticle>>(c().GET('/v1/admin/faq', { params: { query: q } })),
  create: (body: BodyOf<'/v1/admin/faq'>) => call<T.FaqArticle>(c().POST('/v1/admin/faq', { body })),
  patch: (id: string, body: BodyOf<'/v1/admin/faq/{id}', 'patch'>) => call<T.FaqArticle>(c().PATCH('/v1/admin/faq/{id}', { params: { path: { id } }, body })),
  remove: (id: string) => call<{ id: string }>(c().DELETE('/v1/admin/faq/{id}', { params: { path: { id } } })),
  publish: (id: string) => call<T.FaqArticle>(c().POST('/v1/admin/faq/{id}/publish', { params: { path: { id } } })),
  archive: (id: string) => call<T.FaqArticle>(c().POST('/v1/admin/faq/{id}/archive', { params: { path: { id } } })),
  unpublish: (id: string) => call<T.FaqArticle>(c().POST('/v1/admin/faq/{id}/unpublish', { params: { path: { id } } })),
};

export const Legal = {
  list: (q: QueryOf<'/v1/admin/legal-documents'>) => call<T.Page<T.LegalDocument>>(c().GET('/v1/admin/legal-documents', { params: { query: q } })),
  detail: (id: string) => call<T.LegalDocument>(c().GET('/v1/admin/legal-documents/{id}', { params: { path: { id } } })),
  create: (body: BodyOf<'/v1/admin/legal-documents'>) => call<T.LegalDocument>(c().POST('/v1/admin/legal-documents', { body })),
  patch: (id: string, body: BodyOf<'/v1/admin/legal-documents/{id}', 'patch'>) => call<T.LegalDocument>(c().PATCH('/v1/admin/legal-documents/{id}', { params: { path: { id } }, body })),
  publish: (id: string, retirePrevious: boolean) => call<T.LegalDocument>(c().POST('/v1/admin/legal-documents/{id}/publish', { params: { path: { id } }, body: { retirePrevious } })),
  retire: (id: string, reason: string) => call<T.LegalDocument>(c().POST('/v1/admin/legal-documents/{id}/retire', { params: { path: { id } }, body: { reason } })),
};

export const Audit = {
  list: (q: QueryOf<'/v1/admin/audit-logs'>) => call<T.Page<T.AuditRow>>(c().GET('/v1/admin/audit-logs', { params: { query: q } })),
  verify: (q: QueryOf<'/v1/admin/audit-logs/verify'> = {}) => call<T.AuditVerify>(c().GET('/v1/admin/audit-logs/verify', { params: { query: q } })),
};

// ------------------------------------------------------------------ DB & infra
export const Infra = {
  health: () => call<T.DbHealth>(c().GET('/v1/admin/infra/db/health')),
  provider: () => call<T.ProviderInfo>(c().GET('/v1/admin/infra/db/provider')),
  migrations: () => call<T.MigrationsResponse>(c().GET('/v1/admin/infra/db/migrations')),
  storage: (limit = 20) => call<T.StorageResponse>(c().GET('/v1/admin/infra/db/storage', { params: { query: { limit } } })),
  connectionTest: () => call<T.ConnectionTest>(c().POST('/v1/admin/infra/db/connection-test')),
  backups: () => call<T.BackupsResponse>(c().GET('/v1/admin/infra/db/backups')),
  createBackup: (label: string, reason: string) => call<{ operationId: string; status: string }>(c().POST('/v1/admin/infra/db/backups', { body: { label, reason } })),
  restore: (body: BodyOf<'/v1/admin/infra/db/restores'>) => call<{ operationId: string; status: string; note: string }>(c().POST('/v1/admin/infra/db/restores', { body })),
  exportAnalytics: (body: BodyOf<'/v1/admin/infra/db/exports'>) => call<{ operationId: string; status: string; note: string }>(c().POST('/v1/admin/infra/db/exports', { body })),
  operations: (q: QueryOf<'/v1/admin/infra/db/operations'>) => call<T.Page<T.DbOperation>>(c().GET('/v1/admin/infra/db/operations', { params: { query: q } })),
  operation: (id: string) => call<T.DbOperationDetail>(c().GET('/v1/admin/infra/db/operations/{id}', { params: { path: { id } } })),
  approveOperation: (id: string, note?: string) => call<T.DbOperationDetail>(c().POST('/v1/admin/infra/db/operations/{id}/approve', { params: { path: { id } }, body: note ? { note } : {} })),
  cancelOperation: (id: string, reason: string) => call<T.DbOperationDetail>(c().POST('/v1/admin/infra/db/operations/{id}/cancel', { params: { path: { id } }, body: { reason } })),
  startWorkflow: (body: BodyOf<'/v1/admin/infra/db/migration-workflows'>) => call<T.DbOperationDetail>(c().POST('/v1/admin/infra/db/migration-workflows', { body })),
  recordStep: (id: string, step: string, body: BodyOf<'/v1/admin/infra/db/migration-workflows/{id}/steps/{step}'>) =>
    call<T.DbOperationDetail>(c().POST('/v1/admin/infra/db/migration-workflows/{id}/steps/{step}', { params: { path: { id, step: step as never } }, body })),
  approveStep: (id: string, step: string) =>
    call<T.DbOperationDetail>(c().POST('/v1/admin/infra/db/migration-workflows/{id}/steps/{step}/approve', { params: { path: { id, step: step as never } } })),
};

// ------------------------------------------------------------------ files
/** GET /v1/files/{id}/content as a Blob (authenticated, never cached). */
export async function fetchFileBlob(fileId: string): Promise<Blob> {
  const { authFetch } = api();
  const res = await authFetch(`/v1/files/${encodeURIComponent(fileId)}/content`, { method: 'GET' });
  if (!res.ok) {
    const { normalizeError } = await import('./errors');
    throw normalizeError(res.status, await res.json().catch(() => null), res);
  }
  return res.blob();
}

/** GET /v1/files/{id}/url — presigned (plain files) or `requiresAuth` (encrypted files → use fetchFileBlob). */
export const Files = {
  url: (id: string) => call<T.Schemas['FileDownload']>(c().GET('/v1/files/{id}/url', { params: { path: { id } } })),
};
