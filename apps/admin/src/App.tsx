import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { isApiError } from './api/errors';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { MfaProvider } from './auth/MfaProvider';
import { CAP, homePath, type Capability } from './auth/permissions';
import { ToastProvider } from './components/Toast';
import { Callout, LoadingBlock, PageHeader } from './components/ui';
import { ROUTER_BASENAME } from './env';
import { AppShell } from './layout/AppShell';
import { LoginPage, MfaEnrollPage, MfaVerifyPage, NotAdminPage, SessionErrorPage } from './pages/LoginPage';

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const UsersPage = lazy(() => import('./pages/users/UsersPage'));
const UserDetailPage = lazy(() => import('./pages/users/UserDetailPage'));
const RbacPage = lazy(() => import('./pages/users/RbacPage'));
const KycQueuePage = lazy(() => import('./pages/users/KycPages').then((m) => ({ default: m.KycQueuePage })));
const KycDetailPage = lazy(() => import('./pages/users/KycPages').then((m) => ({ default: m.KycDetailPage })));
const TripsQueuePage = lazy(() => import('./pages/users/TripPages').then((m) => ({ default: m.TripsQueuePage })));
const TripDetailPage = lazy(() => import('./pages/users/TripPages').then((m) => ({ default: m.TripDetailPage })));
const TransactionsPage = lazy(() => import('./pages/transactions/TransactionsPage'));
const TransactionDetailPage = lazy(() => import('./pages/transactions/TransactionDetailPage'));
const DisputesPage = lazy(() => import('./pages/disputes/DisputesPage'));
const DisputeDetailPage = lazy(() => import('./pages/disputes/DisputeDetailPage'));
const RefundsPage = lazy(() => import('./pages/finance/RefundsPage'));
const PayoutsPage = lazy(() => import('./pages/finance/PayoutsPage'));
const SettlementPage = lazy(() => import('./pages/finance/SettlementPage'));
const ReconciliationPage = lazy(() => import('./pages/finance/ReconciliationPage'));
const RiskPage = lazy(() => import('./pages/risk/RiskPage'));
const TrustPage = lazy(() => import('./pages/risk/TrustPage'));
const ReferralsPage = lazy(() => import('./pages/growth/ReferralsPage'));
const PromotionsPage = lazy(() => import('./pages/growth/PromotionsPage'));
const ConfigListPage = lazy(() => import('./pages/config/ConfigListPage'));
const ConfigKeyPage = lazy(() => import('./pages/config/ConfigKeyPage'));
const RulesPage = lazy(() => import('./pages/config/RulesPage'));
const TicketsPage = lazy(() => import('./pages/support/TicketsPage'));
const TicketDetailPage = lazy(() => import('./pages/support/TicketDetailPage'));
const ChatModerationPage = lazy(() => import('./pages/support/ChatModerationPage'));
const FaqPage = lazy(() => import('./pages/content/FaqPage'));
const LegalPage = lazy(() => import('./pages/content/LegalPage'));
const AuditPage = lazy(() => import('./pages/content/AuditPage'));
const InfraPage = lazy(() => import('./pages/infra/InfraPage'));

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: (count, err) => (isApiError(err) && err.status !== 0 && err.status < 500 ? false : count < 1),
      },
      mutations: { retry: false },
    },
  });
}

function RequireCap({ cap, children }: { cap: Capability; children: ReactNode }) {
  const { can, missing } = useAuth();
  if (!can(cap)) {
    return (
      <div className="stack denied">
        <PageHeader title="Akses ditolak" subtitle="Halaman ini tidak tersedia untuk peran Anda." />
        <Callout tone="warning" icon="lock">
          Dibutuhkan: {missing(cap).join(', ')}. Minta SUPER_ADMIN menambahkan peran yang sesuai (docs/api/admin.md §2).
        </Callout>
      </div>
    );
  }
  return <>{children}</>;
}

/** After each navigation move focus to the page title (docs/05 §4.3) without scrolling jumps. */
function RouteFocus() {
  const loc = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => document.querySelector<HTMLElement>('[data-page-title]')?.focus({ preventScroll: true }), 60);
    return () => clearTimeout(t);
  }, [loc.pathname]);
  return null;
}

function Home() {
  const { perms, roles, can } = useAuth();
  if (can({ perms: ['analytics.read'] })) return <DashboardPage />;
  return <Navigate to={homePath(perms, roles)} replace />;
}

const r = (cap: Capability, el: ReactNode) => <RequireCap cap={cap}>{el}</RequireCap>;

function AppRoutes() {
  return (
    <AppShell>
      <RouteFocus />
      <Suspense fallback={<LoadingBlock rows={6} label="Memuat halaman…" />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/users" element={r({ perms: ['users.read'] }, <UsersPage />)} />
          <Route path="/users/:id" element={r({ perms: ['users.read'] }, <UserDetailPage />)} />
          <Route path="/rbac" element={r(CAP.manageRoles, <RbacPage />)} />
          <Route path="/kyc" element={r(CAP.kycReview, <KycQueuePage />)} />
          <Route path="/kyc/:id" element={r(CAP.kycReview, <KycDetailPage />)} />
          <Route path="/trips" element={r(CAP.tripVerify, <TripsQueuePage />)} />
          <Route path="/trips/:id" element={r(CAP.tripVerify, <TripDetailPage />)} />
          <Route path="/transactions" element={r({ perms: ['transactions.read'] }, <TransactionsPage />)} />
          <Route path="/transactions/:id" element={r({ perms: ['transactions.read'] }, <TransactionDetailPage />)} />
          <Route path="/disputes" element={r(CAP.disputes, <DisputesPage />)} />
          <Route path="/disputes/:id" element={r(CAP.disputes, <DisputeDetailPage />)} />
          <Route path="/refunds" element={r(CAP.refundApprove, <RefundsPage />)} />
          <Route path="/payouts" element={r(CAP.payouts, <PayoutsPage />)} />
          <Route path="/finance/settlement" element={r({ perms: ['finance.settlement.read_masked'] }, <SettlementPage />)} />
          <Route path="/finance/reconciliation" element={r({ perms: ['finance.reports.read'] }, <ReconciliationPage />)} />
          <Route path="/risk" element={r({ perms: ['risk.read'] }, <RiskPage />)} />
          <Route path="/risk/:id" element={r({ perms: ['risk.read'] }, <RiskPage />)} />
          <Route path="/trust" element={r({ perms: ['risk.read'] }, <TrustPage />)} />
          <Route path="/referrals" element={r(CAP.referrals, <ReferralsPage />)} />
          <Route path="/promotions" element={r(CAP.promotions, <PromotionsPage />)} />
          <Route path="/config" element={r({ perms: ['config.read'] }, <ConfigListPage />)} />
          <Route path="/config/:key" element={r({ perms: ['config.read'] }, <ConfigKeyPage />)} />
          <Route path="/rules/customs" element={r(CAP.customs, <RulesPage kind="customs" />)} />
          <Route path="/rules/restricted" element={r(CAP.restricted, <RulesPage kind="restricted" />)} />
          <Route path="/support" element={r(CAP.support, <TicketsPage />)} />
          <Route path="/support/:id" element={r(CAP.support, <TicketDetailPage />)} />
          <Route path="/chat-moderation" element={r(CAP.chat, <ChatModerationPage />)} />
          <Route path="/content/faq" element={r(CAP.faq, <FaqPage />)} />
          <Route path="/content/legal" element={r(CAP.legal, <LegalPage />)} />
          <Route path="/audit" element={r(CAP.audit, <AuditPage />)} />
          <Route path="/infra" element={r(CAP.infraRead, <InfraPage />)} />
          <Route path="/no-access" element={<RequireCap cap={{ perms: ['analytics.read'] }}>{null}</RequireCap>} />
          <Route
            path="*"
            element={
              <div className="stack">
                <PageHeader title="Halaman tidak ditemukan" />
              </div>
            }
          />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

function Gate() {
  const { status } = useAuth();
  switch (status) {
    case 'anonymous':
      return <LoginPage />;
    case 'loading':
      return (
        <div style={{ padding: 48 }}>
          <LoadingBlock rows={3} label="Memulihkan sesi…" />
        </div>
      );
    case 'error':
      return <SessionErrorPage />;
    case 'not-admin':
      return <NotAdminPage />;
    case 'mfa-enroll':
      return <MfaEnrollPage />;
    case 'mfa-verify':
      return <MfaVerifyPage />;
    default:
      return <AppRoutes />;
  }
}

export function App({ client, basename = ROUTER_BASENAME }: { client?: QueryClient; basename?: string }) {
  const qc = useRef(client ?? makeQueryClient()).current;
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AuthProvider>
          <MfaProvider>
            <BrowserRouter basename={basename}>
              <Gate />
            </BrowserRouter>
          </MfaProvider>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
