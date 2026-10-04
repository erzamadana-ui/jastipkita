/**
 * Response DTOs for /v1/admin/*. The OpenAPI contract types most admin responses as the opaque `AdminResult` /
 * `AdminPage` (looseObject), so these interfaces mirror the service implementations in
 * apps/api/src/modules/admin/** and apps/api/src/modules/infra/** (reported as an API gap: publish typed schemas).
 * Request bodies and query params come from the generated `schema.d.ts`.
 */
import type { components } from './schema';

export type Schemas = components['schemas'];
export type Profile = Schemas['Profile'];
export type Quote = Schemas['Quote'];
export type PriceLine = Schemas['PriceLine'];
export type Payment = Schemas['Payment'];

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------- dashboard
export type AdminKpis = Schemas['AdminKpis'] & {
  systemHealth: {
    status: string;
    outboxBacklog?: number;
    oldestUnpublishedAgeSec?: number | null;
    deadJobs24h?: number;
    webhookFailures24h?: number;
    alertsOpen?: number;
    integrations?: Record<string, string>;
  };
};
export type AdminMetric = Schemas['AdminMetric'];
export type AdminTimeSeries = Schemas['AdminTimeSeries'];
export type AdminFunnel = Schemas['AdminFunnel'];
export type SeriesMetric = AdminTimeSeries['metric'] &
  ('gmv' | 'net_revenue' | 'transactions_created' | 'transactions_completed' | 'payments_secured_idr' | 'signups' | 'disputes_opened' | 'refunds_succeeded_idr');

// ---------------------------------------------------------------- system
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export interface SystemHealth {
  generatedAt: string;
  status: 'OK' | 'DEGRADED' | 'CRITICAL';
  database: { ok: boolean; latencyMs: number | null; schemaVersion: string | null; connections: number; maxConnections: number };
  outbox: { backlog: number; oldestUnpublishedAgeSec: number | null; retryingEvents: number };
  jobs: { queued: number; running: number; overdue: number; dead24h: number; deadTotal: number; expiredLeases: number };
  webhooks: { received24h: number; failed24h: number; unprocessedOlderThan10m: number; invalidSignature24h: number };
  refunds: { failed: number; pendingApproval: number; pendingApprovalOlderThan24h: number; processingOlderThan1h: number };
  payouts: { failed: number; onHold: number; onHoldOlderThan48h: number; processingOlderThan1h: number };
  notifications: { deliveries24h: number; failed24h: number; failureRate: number | null };
  security: { highOrCritical24h: number; critical24h: number; byType: { type: string; severity: string; count: number }[] };
  disputes: { slaBreachedOpen: number };
  support: { firstResponseBreached: number };
  auditChain: { status: string | null; checkedAt: string | null; brokenAtId: number | null };
  integrations: Record<string, string>;
  alertsOpen: number;
}
export interface Alert {
  code: string;
  severity: Severity;
  value: number;
  threshold: number;
  message: string;
  description: string;
  firstSeenAt: string;
  occurrences: number;
  acknowledged: boolean;
}
export interface AlertsResponse {
  generatedAt: string;
  status: 'OK' | 'DEGRADED' | 'CRITICAL';
  alerts: Alert[];
  thresholds: Record<string, { medium?: number; high?: number; critical?: number; unit: string; description: string; minSample?: number }>;
}

// ---------------------------------------------------------------- users & rbac
export interface MaskedUser {
  id: string;
  email: string | null;
  phone: string | null;
  displayName: string | null;
  status: string;
  kycLevel: number;
  kycLevelCode: string | null;
  activeMode: string;
  trustScore: number;
  roles: string[];
  createdAt: string;
  lastLoginAt: string | null;
  piiMasked: true;
}
export interface TxSummary {
  total: number;
  completed: number;
  completedValueIdr: number;
  byStatus: Record<string, number>;
}
export interface UserDetail extends MaskedUser {
  referralCode: string;
  suspendedAt: string | null;
  suspensionReason: string | null;
  deletedAt: string | null;
  roleGrants: { roleCode: string; grantedAt: string; grantedBy: string | null; reason: string | null }[];
  trust: { score: number; components: unknown; computedAt: string | null; overrideId: string | null; history: { score: number; previousScore: number | null; source: string; at: string }[] };
  kyc: {
    level: number;
    levelCode: string | null;
    submissions: { id: string; status: string; targetLevel: number; idType: string | null; createdAt: string; reviewedAt: string | null; decisionReason: string | null }[];
    payoutAccounts: { id: string; bankCode: string; accountMask: string; verificationStatus: string; isDefault: boolean; disabled: boolean }[];
  };
  risk: { openReviews: number; assessments: { id: string; score: number; decision: string; reasons: unknown; rulesVersion: string; createdAt: string }[] };
  transactions: { asBuyer: TxSummary; asTraveler: TxSummary };
  devices: { count: number };
  sessions: { sessionId: string; createdAt: string; expiresAt: string; platform: string | null; appVersion: string | null }[];
  disputes: { open: number };
  security: { events30d: number; highOrCritical30d: number };
}
export interface RevealedContact {
  id: string;
  email: string | null;
  phone: string | null;
  displayName: string | null;
  revealedAt: string;
}
export interface RoleInfo {
  code: string;
  name: string;
  description: string | null;
  permissions: string[];
  holders: number;
  privileged: boolean;
}
export interface RolesResponse {
  roles: RoleInfo[];
  permissions: { code: string; description: string; sensitive: boolean }[];
}
export interface RoleGrantResult {
  status: 'GRANTED' | 'PENDING_APPROVAL';
  requestId: string | null;
  roleCode: string;
  userId: string;
  expiresAt: string | null;
  message: string;
}
/** SEC-13: TOTP factor reset of another admin — maker-checker (requester ≠ approver ≠ subject, approver SUPER_ADMIN). */
export interface MfaResetRequest {
  id: string;
  userId: string;
  factorId: string | null;
  reason: string;
  requestedBy: string;
  approvedBy: string | null;
  rejectedBy: string | null;
  status: 'PENDING' | 'APPLIED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  decisionNote: string | null;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface RoleRequest {
  id: string;
  userId: string;
  roleCode: string;
  reason: string;
  requestedBy: string;
  approvedBy: string | null;
  rejectedBy: string | null;
  status: string;
  decisionNote: string | null;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

// ---------------------------------------------------------------- kyc & trips
export interface ContentRef {
  url: string;
  method: 'GET';
  requiresAuth: boolean;
  audited?: boolean;
}
export interface KycSubmission {
  id: string;
  userId: string;
  userDisplayName: string | null;
  userKycLevel: number | null;
  targetLevel: number;
  idType: string | null;
  status: string;
  provider: string;
  providerEnv: string;
  livenessScore: number | null;
  faceMatchScore: number | null;
  riskFlags: unknown;
  providerResult: unknown;
  submittedAt: string;
  waitingHours: number;
  reviewedBy: string | null;
  reviewedAt: string | null;
  decisionReason: string | null;
  rejectionCode: string | null;
}
export interface KycDetail extends KycSubmission {
  documents: { id: string; type: string; side: string; status: string; fileId: string | null; mime: string | null; sizeBytes: number | null; scanStatus: string | null; purged: boolean; content: ContentRef | null }[];
  identity: { idType: string; nationality: string | null; idNumberMasked: string | null; fullNameMasked: string | null; verifiedAt: string | null } | null;
  checks: { phoneVerified: boolean; duplicateIdentityEvents: number; notDuplicate: boolean };
  previousSubmissions: { id: string; status: string; createdAt: string; decisionReason: string | null }[];
  allowedActions: ('APPROVE' | 'REJECT')[];
}
export interface PayoutAccountReview {
  id: string;
  userId: string;
  userDisplayName: string | null;
  bankCode: string;
  accountMask: string;
  verificationStatus: string;
  createdAt: string;
}
export interface TripSummary {
  id: string;
  travelerId: string;
  travelerDisplayName: string | null;
  travelerKycLevel: number | null;
  route: { originCountry: string; originCity: string; destinationCountry: string; destinationCity: string };
  departureDate: string;
  arrivalDate: string;
  capacityKg: number;
  status: string;
  version: number;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  pendingDocuments?: number;
  submittedAt?: string;
  waitingHours?: number;
}
export interface TripDetail extends TripSummary {
  documents: { id: string; docType: string; fileId: string | null; mime: string | null; flightNumber: string | null; flightDate: string | null; extracted: unknown; status: string; reviewedBy: string | null; reviewedAt: string | null; notes: string | null; createdAt: string; content: ContentRef | null }[];
  timeline: { from: string | null; to: string; actorType: string; reason: string | null; at: string }[];
  allowedActions: ('APPROVE' | 'REJECT')[];
}

// ---------------------------------------------------------------- transactions
export interface TxListItem {
  id: string;
  number: string;
  status: string;
  buyer: { id: string; displayName: string | null };
  traveler: { id: string; displayName: string | null } | null;
  productName: string;
  categoryCode: string | null;
  totalIdr: number | null;
  securedIdr: number;
  payoutHoldReason: string | null;
  openDispute: boolean;
  statusChangedAt: string;
  createdAt: string;
}
export interface Party {
  id: string;
  displayName: string | null;
  kycLevel?: number;
  trustScore: number;
  status?: string;
}
export interface RefundView {
  id: string;
  number: string;
  paymentId: string;
  reasonCode: string;
  reasonNote: string | null;
  amountIdr: number;
  type: string;
  status: string;
  method: string;
  destinationRequired: boolean;
  destination: { bankCode: string | null; accountMask: string | null; validationStatus: string } | null;
  failureReason: string | null;
  processedAt: string | null;
  createdAt: string;
}
export interface LedgerEntry {
  bucket: string;
  ownerUserId: string | null;
  direction: 'DEBIT' | 'CREDIT';
  amountIdr: number;
  memo: string | null;
}
export interface LedgerJournal {
  id: string;
  seq: number;
  kind: string;
  description: string;
  idempotencyKey: string | null;
  postedAt: string;
  refundId: string | null;
  payoutId: string | null;
  paymentId: string | null;
  entries: LedgerEntry[];
}
export interface TxPayout {
  id: string;
  number: string;
  status: string;
  amountIdr: number;
  feeIdr: number;
  netIdr: number;
  holdReason: string | null;
  heldBy: string | null;
  releasedBy: string | null;
  scheduledFor: string | null;
  paidAt: string | null;
  providerEnv: string;
  failureReason: string | null;
  attempts: number;
  destination: { bankCode: string; accountMask: string };
}
export interface TxEvent {
  from: string | null;
  to: string;
  actorType: string;
  actorId?: string | null;
  reason?: string | null;
  at: string;
}
export interface TransactionDetail {
  id: string;
  number: string;
  status: string;
  version: number;
  item: { productName: string; categoryCode: string | null; merchantCountry: string | null; merchantName: string | null; restrictionClass: string | null; quantity: number; unitPriceMinor: number | null; currency: string | null } | null;
  buyer: Party | null;
  traveler: Party | null;
  tripId: string | null;
  totalIdr: number | null;
  securedIdr: number;
  payoutHoldReason: string | null;
  purchaseGate: unknown;
  quote: Quote | null;
  payments: Payment[];
  refunds: RefundView[];
  payouts: TxPayout[];
  ledger: { balanced: boolean; escrow: { bucket: string; netCreditIdr: number }[]; journals: LedgerJournal[] };
  priceConfirmations: unknown[];
  purchaseProofs: { id: string; status: string; merchantName: string; actualPriceMinor: number; currency: string; fraudReasons: unknown; createdAt: string }[];
  delivery: { id: string; method: string; status: string; courierName: string | null; trackingNumber: string | null; addressCity: string | null; meetupPoint: string | null; scheduledAt: string | null; confirmedAt: string | null; confirmedVia: string | null; proofFileIds: string[]; pin: { locked: boolean; attemptsRemaining: number } | null } | null;
  disputes: { id: string; number: string; status: string; type: string; resolution: string | null; resolutionAmountIdr: number | null; createdAt: string }[];
  conversationId: string | null;
  events: TxEvent[];
  adminAllowedTransitions: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- disputes
export type SlaState = 'ON_TRACK' | 'DUE_SOON' | 'BREACHED' | 'DONE' | 'RESPONDED';
export interface DisputeListItem {
  id: string;
  number: string;
  transactionId: string;
  transactionNumber: string;
  transactionStatus: string;
  totalIdr: number | null;
  type: string;
  status: string;
  openedByRole: string;
  requestedResolution: string | null;
  resolution: string | null;
  assigneeId: string | null;
  evidenceDueAt: string | null;
  slaDueAt: string | null;
  slaState: SlaState;
  createdAt: string;
}
export type DisputeAction = 'REQUEST_EVIDENCE' | 'START_REVIEW' | 'RESOLVE' | 'CLOSE';
export interface DisputeDetail {
  id: string;
  number: string;
  type: string;
  status: string;
  version: number;
  description: string | null;
  openedBy: string;
  openedByRole: string;
  requestedResolution: string | null;
  resolution: string | null;
  resolutionAmountIdr: number | null;
  resolutionNote: string | null;
  assigneeId: string | null;
  resolvedBy: string | null;
  evidenceDueAt: string | null;
  slaDueAt: string | null;
  slaBreach: string | null;
  slaState: SlaState;
  resolvedAt: string | null;
  appealedAt: string | null;
  appealDeadline: string | null;
  closedAt: string | null;
  transaction: { id: string; number: string; status: string; preDisputeStatus: string | null; escrowHeldIdr: number; refundableIdr?: number };
  buyer: Party | null;
  traveler: Party | null;
  conversationId: string | null;
  /** fileUrlEndpoint/contentUrl are absolute API URLs; the UI always fetches bytes by fileId via GET /v1/files/{id}/content (bearer). */
  evidence: { id: string; party: string; type: string; fileId: string | null; fileUrlEndpoint: string | null; contentUrl?: string | null; messageId: string | null; note: string | null; submittedBy: string; createdAt: string }[];
  timeline: TxEvent[];
  refunds: RefundView[];
  allowedActions: DisputeAction[];
}

// ---------------------------------------------------------------- refunds & payouts
export interface RefundQueueItem {
  id: string;
  number: string;
  transactionId: string;
  transactionNumber: string;
  transactionStatus: string;
  paymentId: string;
  channel: string | null;
  sandbox: boolean;
  reasonCode: string;
  reasonNote: string | null;
  amountIdr: number;
  type: string;
  status: string;
  method: string;
  requestedBy: string | null;
  approvedBy: string | null;
  canApprove: boolean;
  failureReason: string | null;
  attempts: number;
  waitingHours: number;
  createdAt: string;
}
export interface PayoutItem {
  id: string;
  number: string;
  travelerId: string;
  travelerDisplayName: string | null;
  transactionId: string | null;
  transactionNumber: string | null;
  amountIdr: number;
  feeIdr: number;
  netIdr: number;
  status: string;
  holdReason: string | null;
  heldBy: string | null;
  heldAt: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
  transactionHoldReason: string | null;
  scheduledFor: string | null;
  /**
   * New payout account cooldown (anti account-takeover, money.policy.newPayoutAccountCooldownHours, 2026-10-04): the
   * destination account was added / verified / made default recently — no payout before this time. null = none.
   */
  cooldownUntil?: string | null;
  paidAt: string | null;
  provider: string;
  sandbox: boolean;
  failureReason: string | null;
  attempts: number;
  destination: { bankCode: string; accountMask: string; verificationStatus: string };
  canRelease: boolean;
  createdAt: string;
}

/** SEC-12: refund bank destination whose holder name ≠ the buyer's verified identity (GET /v1/admin/refund-destinations). */
export interface RefundDestinationItem {
  id: string;
  refundId: string;
  refundNumber: string | null;
  transactionId: string;
  buyerId: string;
  buyerDisplayName: string | null;
  bankCode: string;
  accountMask: string;
  validationStatus: 'PENDING_REVIEW' | 'VALID' | 'REJECTED' | string;
  nameMatch: string | null;
  amountIdr: number;
  createdAt: string;
  canReview: boolean;
}

// ---------------------------------------------------------------- config
export interface ConfigVersion {
  id: string;
  key: string;
  version: number;
  value: unknown;
  status: 'ACTIVE' | 'PENDING_APPROVAL' | 'SUPERSEDED' | 'REJECTED' | string;
  effectiveFrom: string;
  changeReason: string;
  isAssumption: boolean;
  notes: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  supersededAt: string | null;
  createdAt: string;
}
export interface DiffEntry {
  path: string;
  op: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}
export interface ConfigListResponse {
  data: { key: string; active: ConfigVersion | null; latestVersion: number | null; pendingApprovals: number; isAssumption: boolean }[];
  assumptions: string[];
}
export interface ConfigDetail {
  key: string;
  active: ConfigVersion | null;
  history: (ConfigVersion & { diffFromActive: DiffEntry[] })[];
}
export interface ConfigDiff {
  key: string;
  from: { version: number; status: string };
  to: { version: number; status: string };
  changes: DiffEntry[];
}

// ---------------------------------------------------------------- rules
export type RuleKind = 'customs' | 'restricted';
export interface RuleVersion {
  id: string;
  kind: RuleKind;
  code: string;
  version: number;
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'ACTIVE' | 'RETIRED';
  needsVerification: boolean;
  originCountry: string | null;
  destinationCountry: string;
  categoryCode: string | null;
  hsCodePrefix: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
  inForceToday: boolean;
  sourceReference: string;
  sourceUrl: string | null;
  lastVerifiedAt: string;
  verificationAgeDays: number;
  verifiedBy: string | null;
  notes: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // customs
  treatment?: string;
  formulaCode?: string;
  exemptionUsd?: string | null;
  dutyRate?: string;
  vatRate?: string;
  vatDppFactor?: string;
  luxuryTaxRate?: string;
  incomeTaxRate?: string;
  incomeTaxRateNoNpwp?: string | null;
  rounding?: string;
  priority?: number;
  // restricted
  keywords?: string[];
  classification?: string;
  maxQuantity?: number | null;
  maxValueUsd?: string | null;
  permitAuthority?: string | null;
  airlineDg?: boolean;
  messageId?: string;
  messageEn?: string;
}
export interface RuleDetail extends RuleVersion {
  versions: { id: string; version: number; status: string; effectiveFrom: string; effectiveUntil: string | null }[];
}
export interface RulePreviewResult {
  kind: RuleKind;
  ruleId: string;
  date: string;
  current: Record<string, unknown>;
  proposed: Record<string, unknown>;
  delta?: { dutyIdr: number; importTaxIdr: number; totalIdr: number } | null;
  proposedRuleSelected?: boolean;
  changed?: boolean;
  fxUsed?: Record<string, unknown>;
  isEstimate: boolean;
}

// ---------------------------------------------------------------- settlement
export interface SettlementAccount {
  id: string;
  label: string;
  purpose: string;
  bankCode: string;
  accountMask: string;
  holderNameMask: string;
  currency: string;
  status: string;
  isPrimary: boolean;
  secretConfigured: boolean;
  createdBy: string | null;
  approvedBy: string | null;
  activatedAt: string | null;
  disabledAt: string | null;
  createdAt: string;
}
export interface SettlementChange {
  id: string;
  settlementAccountId: string | null;
  changeType: string;
  proposed: Record<string, unknown>;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  approvedBy: string | null;
  rejectedBy: string | null;
  status: string;
  decisionNote: string | null;
  decidedAt: string | null;
  appliedAt: string | null;
  expiresAt: string;
  canApprove: boolean;
}

// ---------------------------------------------------------------- growth
export interface Promotion {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  type: string;
  conditions: Record<string, unknown>;
  benefit: Record<string, unknown>;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED' | string;
  fundedBy: string;
  startsAt: string;
  endsAt: string | null;
  budget: { totalIdr: number | null; usedIdr: number; remainingIdr: number | null; usedRatio: number | null };
  usage: { count: number; limitTotal: number | null; limitPerUser: number | null; redemptions: { reserved: number; applied: number; reversed: number; appliedIdr: number } };
  createdBy: string | null;
  approvedBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface MetricValue {
  value: number | null;
  definition: string;
  sampleSize: number;
  dataQuality: string | null;
}
export interface ReferralStats {
  windowDays: number;
  metrics: Record<'cacProxyIdr' | 'ltvProxyIdr' | 'conversion' | 'fraudRate' | 'repeatRate' | 'grossMarginIdr', MetricValue>;
  counts: { total: number; pending: number; qualified: number; rewarded: number; rejected: number; expired: number };
  guardrail: { allowIncrease: boolean; cacToLtv: number | null; reasons: string[]; thresholds: unknown };
  note: string;
}
export interface Referral {
  id: string;
  program: string;
  status: string;
  referrer: { id: string; displayName: string | null };
  referee: { id: string; displayName: string | null };
  qualifyingTransactionId: string | null;
  referrerRewardIdr: number;
  refereeRewardIdr: number;
  fraudReasons: { code?: string; message?: string }[];
  adminHold: boolean;
  openRiskReviews: number;
  createdAt: string;
  qualifiedAt: string | null;
  rewardedAt: string | null;
}

// ---------------------------------------------------------------- risk & trust
export interface RiskReview {
  id: string;
  subjectType: string;
  subjectId: string;
  status: string;
  assigneeId: string | null;
  notes: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  assessment: { id: string; score: number; decision: string; reasons: unknown; signals: unknown; rulesVersion: string };
}
export interface RiskReviewDetail extends RiskReview {
  subject: { type: string; id: string; transactionId: string | null; userId: string | null };
  users: { id: string; displayName: string | null; status: string; kycLevel: number; trustScore: number }[];
  assessmentHistory: { id: string; score: number; decision: string; reasons: unknown; rulesVersion: string; createdAt: string }[];
  allowedActions: ('ASSIGN' | 'RESOLVE')[];
}
export interface TrustOverride {
  id: string;
  userId: string;
  previousScore: number;
  newScore: number;
  reason: string;
  validUntil: string | null;
  requestedBy: string;
  approvedBy: string | null;
  rejectedBy: string | null;
  status: string;
  decisionNote: string | null;
  decidedAt: string | null;
  appliedAt: string | null;
  expiresAt: string;
  createdAt: string;
  canApprove: boolean;
}

// ---------------------------------------------------------------- support & chat
export interface Ticket {
  id: string;
  number: string;
  userId: string | null;
  userDisplayName: string | null;
  category: string;
  channel: string;
  subject: string;
  status: string;
  priority: string;
  transactionId: string | null;
  disputeId: string | null;
  assigneeId: string | null;
  slaDueAt: string | null;
  slaState: SlaState;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface TicketDetail extends Ticket {
  transaction: { id: string; number: string; status: string } | null;
  conversationId: string | null;
  messages: { id: string; authorId: string | null; authorType: string; body: string; attachments: unknown; internal: boolean; createdAt: string }[];
}
export interface SlaView {
  hoursByPriority: Record<string, number>;
  definition: string;
  byPriority: { priority: string; slaHours: number; open: number; awaitingFirstResponse: number; breached: number; dueWithin4h: number }[];
  last30Days: { responded: number; medianFirstResponseHours: number | null; slaMetRatio: number | null; dataQuality: string | null };
}
export interface FlaggedMessage {
  id: string;
  conversationId: string;
  transactionId: string | null;
  transactionNumber: string | null;
  senderId: string | null;
  senderDisplayName: string | null;
  type: string;
  maskedBody: string | null;
  moderationStatus: string;
  reasons: string[];
  moderatedBy: string | null;
  moderatedAt: string | null;
  createdAt: string;
}
export interface RevealedMessage {
  id: string;
  body: string | null;
  attachments: unknown;
  moderationStatus: string;
  reasons: string[];
  revealedAt: string;
}
export interface ConversationView {
  conversationId: string;
  transactionId: string | null;
  basis: { type: 'DISPUTE' | 'TICKET'; id: string };
  data: { id: string; senderId: string | null; senderDisplayName: string | null; type: string; body: string | null; attachments: unknown; moderationStatus: string; reasons: string[]; deleted: boolean; createdAt: string }[];
}

// ---------------------------------------------------------------- content & audit
export interface FaqArticle {
  id: string;
  slug: string;
  locale: 'id' | 'en';
  category: string;
  question: string;
  answerMd: string;
  tags: string[];
  sortOrder: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  publishedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface LegalDocument {
  id: string;
  type: string;
  version: string;
  locale: 'id' | 'en';
  title: string;
  bodyMd?: string;
  summaryOfChanges: string | null;
  /** One-line description shown in the public document list (GET /v1/legal/documents). */
  summary: string | null;
  /** When this version takes effect; null = at publication (the public API then reports publishedAt). */
  effectiveAt: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  current: boolean;
  publishedAt: string | null;
  retiredAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AuditRow {
  id: number;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  requestId: string | null;
  before: unknown;
  after: unknown;
  meta: unknown;
  hash: string;
}
export interface AuditVerify {
  status: 'OK' | 'BROKEN';
  brokenAtId: number | null;
  range: { fromId: number | null; toId: number | null };
  head: { lastId: number; lastHash: string; updatedAt: string } | null;
  lastCheckpoint: { lastId: number; createdAt: string; anchoredTo: string | null } | null;
  checkedAt: string;
  durationMs: number;
  note: string;
}

// ---------------------------------------------------------------- infra
export interface DbTarget {
  host: string | null;
  port: string | null;
  database: string | null;
  ssl: boolean | null;
}
export interface DbHealth {
  checkedAt: string;
  provider: { dbProvider: string; adminProvider: string };
  target: DbTarget;
  server: { version: string; versionString: string; timezone: string; startedAt: string | null; inRecovery: boolean };
  latencyMs: number;
  sizeBytes: number;
  connections: { total: number; max: number; reservedSuperuser: number; utilization: number | null; byState: { state: string; count: number }[] };
  cacheHitRatio: number | null;
  transactions: { commits: number; rollbacks: number; deadlocks: number; tempBytes: number };
  longRunningQueries: { thresholdSec: number; count: number };
  replication: { walSenders: number; walReceiverStatus: string | null; isReplica: boolean };
  dataQuality: string | null;
}
export interface ProviderInfo {
  provider: string;
  dbProvider: string;
  capabilities: Record<string, boolean>;
  info: Record<string, unknown>;
  target: DbTarget;
  backupsManagedOutsideApp: boolean;
  credentials: string;
}
export interface MigrationRow {
  version: string;
  name: string;
  status: 'APPLIED' | 'PENDING' | 'CHECKSUM_DRIFT' | 'UNKNOWN_IN_BUILD';
  fileChecksum: string | null;
  appliedChecksum: string | null;
  appliedAt: string | null;
  executionMs: number | null;
  appliedBy: string | null;
}
export interface MigrationsResponse {
  schemaVersion: string | null;
  buildVersion: string | null;
  summary: { applied: number; pending: number; checksumDrift: number; unknownInBuild: number };
  inSync: boolean;
  migrations: MigrationRow[];
  note: string;
}
export interface StorageResponse {
  databaseBytes: number;
  tables: { table: string; totalBytes: number; tableBytes: number; indexBytes: number; estimatedRows: number; seqScans: number; indexScans: number | null }[];
  definition: string;
}
export interface ConnectionTest {
  operationId: string;
  ok: boolean;
  samplesMs: number[];
  avgMs: number | null;
  error: string | null;
  target: DbTarget;
}
/** GET /v1/admin/infra/audit/checkpoints/verify — T12 audit chain checkpoints (read-only verification). */
export interface AuditCheckpointVerification {
  status: 'OK' | 'BROKEN' | 'NO_CHECKPOINT';
  checkedAt: string;
  durationMs: number;
  checkpoint: {
    id: number;
    day: string;
    lastId: number;
    lastHash: string;
    rowCount: number;
    headUpdatedAt: string;
    createdAt: string;
    ageSec: number;
    storageKey: string;
    storageMode: string;
    objectSha256: string;
  } | null;
  anchor: { hashMatches: boolean; rowCountMatches: boolean; actualRowCount: number } | null;
  segment: { fromId: number; toId: number; rowsSinceCheckpoint: number; brokenAtId: number | null };
  head: { lastId: number; lastHash: string; updatedAt: string } | null;
  history: { checkpoints: number; mismatched: { id: number; day: string; lastId: number }[] };
  storage: { status: 'MATCH' | 'MISMATCH' | 'MISSING' | 'ERROR' | 'SKIPPED'; mode: string; key: string | null; error: string | null };
  findings: string[];
  warnings: string[];
  recent: { day: string; lastId: number; rowCount: number; createdAt: string; storageKey: string; storageMode: string }[];
  note: string;
}
export interface DbOperation {
  id: string;
  type: string;
  status: string;
  environment: string;
  provider: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  reason: string | null;
  params: Record<string, unknown>;
  result: unknown;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface WorkflowStep {
  stepNo: number;
  step: string;
  status: 'PENDING' | 'DONE' | 'SKIPPED' | 'FAILED';
  checklist: { key: string; label: string; done: boolean }[];
  requiresApproval: boolean;
  notes: string | null;
  evidence: Record<string, string> | null;
  completedBy: string | null;
  completedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
}
export interface DbOperationDetail extends DbOperation {
  steps: WorkflowStep[];
}
export interface BackupsResponse {
  provider: string;
  managedOutsideApp: boolean;
  backups: { id: string; createdAt: string; kind: string; sizeBytes: number | null; status: string }[];
  note?: string;
  error?: string | null;
  operations: { id: string; type: string; status: string; createdAt: string; result: unknown }[];
}

/** GET /v1/admin/reconciliation/runs item (admin/reconciliation/service.ts runView). */
export interface ReconciliationRun {
  id: string;
  provider: string;
  sandbox: boolean;
  periodStart: string;
  periodEnd: string;
  status: 'RUNNING' | 'MATCHED' | 'COMPLETED_WITH_DIFFS' | 'FAILED';
  payments: number;
  mismatches: number;
  internalCapturedIdr: number;
  providerSecuredIdr: number;
  openItems: number;
  resolvedItems: number;
  manual: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** GET /v1/admin/reconciliation/runs/{id}/items item. */
export interface ReconciliationItem {
  id: string;
  itemType: string;
  internalRef: string | null;
  providerRef: string | null;
  transactionId: string | null;
  transactionNumber: string | null;
  channel: string | null;
  internalAmountIdr: number | null;
  providerAmountIdr: number | null;
  diffIdr: number;
  status: 'MATCHED' | 'MISMATCH' | 'MISSING_INTERNAL' | 'MISSING_PROVIDER' | 'RESOLVED';
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}
