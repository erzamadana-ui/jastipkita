import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/application/session_controller.dart';
import '../../features/auth/presentation/consent_screen.dart';
import '../../features/auth/presentation/login_screen.dart';
import '../../features/auth/presentation/otp_screen.dart';
import '../../features/auth/presentation/splash_screen.dart';
import '../../features/auth/presentation/welcome_screen.dart';
import '../../features/chat/presentation/chat_screen.dart';
import '../../features/chat/presentation/conversations_screen.dart';
import '../../features/disputes/presentation/dispute_detail_screen.dart';
import '../../features/disputes/presentation/disputes_screen.dart';
import '../../features/disputes/presentation/open_dispute_screen.dart';
import '../../features/home/presentation/home_screen.dart';
import '../../features/home/presentation/traveler_discovery_screen.dart';
import '../../features/kyc/presentation/kyc_status_screen.dart';
import '../../features/kyc/presentation/kyc_submission_screen.dart';
import '../../features/kyc/presentation/payout_accounts_screen.dart';
import '../../features/notifications/presentation/notifications_screen.dart';
import '../../features/profile/presentation/edit_profile_screen.dart';
import '../../features/profile/presentation/notification_settings_screen.dart';
import '../../features/profile/presentation/privacy_screen.dart';
import '../../features/profile/presentation/profile_screen.dart';
import '../../features/profile/presentation/sessions_screen.dart';
import '../../features/profile/presentation/settings_screen.dart';
import '../../features/referral/presentation/referral_screen.dart';
import '../../features/referral/presentation/wallet_screen.dart';
import '../../features/requests/presentation/create_request_screen.dart';
import '../../features/requests/presentation/my_titipan_screen.dart';
import '../../features/requests/presentation/open_requests_screen.dart';
import '../../features/requests/presentation/request_detail_screen.dart';
import '../../features/shell/presentation/main_shell.dart';
import '../../features/support/presentation/support_screens.dart';
import '../../features/transactions/presentation/checkout_screen.dart';
import '../../features/transactions/presentation/handover_screens.dart';
import '../../features/transactions/presentation/orders_screen.dart';
import '../../features/transactions/presentation/payment_status_screen.dart';
import '../../features/transactions/presentation/payouts_screen.dart';
import '../../features/transactions/presentation/transaction_detail_screen.dart';
import '../../features/transactions/presentation/traveler_action_screens.dart';
import '../../features/trips/presentation/create_trip_screen.dart';
import '../../features/trips/presentation/my_trips_screen.dart';
import '../../features/trips/presentation/trip_detail_screen.dart';
import '../design/tokens.g.dart';
import 'deep_links.dart';

final GlobalKey<NavigatorState> rootNavigatorKey = GlobalKey<NavigatorState>(debugLabel: 'root');
final GlobalKey<NavigatorState> _shellNavigatorKey = GlobalKey<NavigatorState>(debugLabel: 'shell');

/// Standard page; with OS "reduce motion" the transition becomes a 120 ms cross-fade.
Page<void> _page(BuildContext context, GoRouterState state, Widget child) {
  final reduce = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
  if (!reduce) return MaterialPage<void>(key: state.pageKey, child: child);
  return CustomTransitionPage<void>(
    key: state.pageKey,
    child: child,
    transitionDuration: JkMotion.reducedCrossfade,
    reverseTransitionDuration: JkMotion.reducedCrossfade,
    transitionsBuilder: (BuildContext context, Animation<double> animation, Animation<double> secondary, Widget child) =>
        FadeTransition(opacity: animation, child: child),
  );
}

GoRoute _route(String path, Widget Function(GoRouterState state) build) => GoRoute(
      path: path,
      parentNavigatorKey: rootNavigatorKey,
      pageBuilder: (BuildContext context, GoRouterState state) => _page(context, state, build(state)),
    );

GoRoute _tab(String path, Widget child) => GoRoute(
      path: path,
      pageBuilder: (BuildContext context, GoRouterState state) => NoTransitionPage<void>(key: state.pageKey, child: child),
    );

String _id(GoRouterState state, [String name = 'id']) => state.pathParameters[name] ?? '';

int _statusCode(AuthStatus status) => switch (status) {
      AuthStatus.unknown => 0,
      AuthStatus.signedOut => 1,
      AuthStatus.signedIn => 2,
    };

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = ValueNotifier<int>(0);
  final redirector = AuthRedirector();
  ref.listen<SessionState>(sessionControllerProvider, (SessionState? previous, SessionState next) {
    if (previous?.status != next.status || previous?.needsConsent != next.needsConsent) refresh.value++;
  });

  final router = GoRouter(
    navigatorKey: rootNavigatorKey,
    initialLocation: Routes.splash,
    refreshListenable: refresh,
    debugLogDiagnostics: false,
    redirect: (BuildContext context, GoRouterState state) {
      final session = ref.read(sessionControllerProvider);
      return redirector.redirect(status: _statusCode(session.status), needsConsent: session.needsConsent, uri: state.uri);
    },
    onException: (BuildContext context, GoRouterState state, GoRouter router) {
      router.go(normalizeDeepLink(state.uri) ?? Routes.home);
    },
    routes: <RouteBase>[
      _route(Routes.splash, (GoRouterState s) => const SplashScreen()),
      _route(Routes.welcome, (GoRouterState s) => const WelcomeScreen()),
      _route(Routes.login, (GoRouterState s) => const LoginScreen()),
      _route(Routes.loginOtp, (GoRouterState s) {
        final args = s.extra;
        return args is OtpArgs ? OtpScreen(args: args) : const LoginScreen();
      }),
      _route(Routes.consents, (GoRouterState s) => const ConsentScreen()),
      ShellRoute(
        navigatorKey: _shellNavigatorKey,
        builder: (BuildContext context, GoRouterState state, Widget child) => MainShell(location: state.uri.path, child: child),
        routes: <RouteBase>[
          _tab(Routes.home, const HomeScreen()),
          _tab(Routes.titipan, const MyTitipanScreen()),
          _tab(Routes.trips, const MyTripsScreen()),
          _tab(Routes.orders, const OrdersScreen()),
          _tab(Routes.chat, const ConversationsScreen()),
          _tab(Routes.wallet, const WalletScreen()),
          _tab(Routes.profile, const ProfileScreen()),
        ],
      ),
      _route(Routes.travelers, (GoRouterState s) => TravelerDiscoveryScreen(originCountry: s.uri.queryParameters['country'])),
      _route(
        Routes.newRequest,
        (GoRouterState s) => CreateRequestScreen(
          initialTab: s.uri.queryParameters['tab'],
          initialUrl: s.uri.queryParameters['url'],
          initialQuery: s.uri.queryParameters['q'],
          initialCountry: s.uri.queryParameters['country'],
        ),
      ),
      _route('/requests/:id', (GoRouterState s) => RequestDetailScreen(requestId: _id(s))),
      _route(Routes.openRequests, (GoRouterState s) => OpenRequestsScreen(tripId: s.uri.queryParameters['tripId'])),
      _route(
        '/open-requests/:id',
        (GoRouterState s) => RequestDetailScreen(requestId: _id(s), tripId: s.uri.queryParameters['tripId']),
      ),
      _route(Routes.newTrip, (GoRouterState s) => const CreateTripScreen()),
      _route('/trips/:id', (GoRouterState s) => TripDetailScreen(tripId: _id(s))),
      _route('/transactions/:id', (GoRouterState s) => TransactionDetailScreen(transactionId: _id(s))),
      _route('/transactions/:id/checkout', (GoRouterState s) => CheckoutScreen(transactionId: _id(s))),
      _route('/transactions/:id/payment', (GoRouterState s) => PaymentStatusScreen(transactionId: _id(s))),
      _route('/transactions/:id/receipt', (GoRouterState s) => PaymentStatusScreen(transactionId: _id(s))),
      _route('/transactions/:id/handover', (GoRouterState s) => HandoverScreen(transactionId: _id(s))),
      _route('/transactions/:id/verify-handover', (GoRouterState s) => VerifyHandoverScreen(transactionId: _id(s))),
      _route('/transactions/:id/price-check', (GoRouterState s) => PriceCheckScreen(transactionId: _id(s))),
      _route('/transactions/:id/purchase-proof', (GoRouterState s) => PurchaseProofScreen(transactionId: _id(s))),
      _route('/transactions/:id/customs', (GoRouterState s) => CustomsDeclarationScreen(transactionId: _id(s))),
      _route('/transactions/:id/delivery', (GoRouterState s) => DeliveryMethodScreen(transactionId: _id(s))),
      _route('/transactions/:id/dispute', (GoRouterState s) => OpenDisputeScreen(transactionId: _id(s))),
      _route('/conversations/:id', (GoRouterState s) => ChatScreen(conversationId: _id(s))),
      _route(Routes.notifications, (GoRouterState s) => const NotificationsScreen()),
      _route(Routes.disputes, (GoRouterState s) => const DisputesScreen()),
      _route('/disputes/:id', (GoRouterState s) => DisputeDetailScreen(disputeId: _id(s))),
      _route(Routes.kyc, (GoRouterState s) => const KycStatusScreen()),
      _route(Routes.kycSubmit, (GoRouterState s) => const KycSubmissionScreen()),
      _route(Routes.payoutAccounts, (GoRouterState s) => const PayoutAccountsScreen()),
      _route(Routes.referrals, (GoRouterState s) => ReferralScreen(initialCode: s.uri.queryParameters['code'])),
      _route(Routes.payouts, (GoRouterState s) => const PayoutsScreen()),
      _route(Routes.support, (GoRouterState s) => const SupportScreen()),
      _route('/support/faq/:slug', (GoRouterState s) => FaqArticleScreen(slug: _id(s, 'slug'))),
      _route(Routes.tickets, (GoRouterState s) => const TicketsScreen()),
      _route(
        Routes.newTicket,
        (GoRouterState s) => CreateTicketScreen(
          transactionId: s.uri.queryParameters['transactionId'],
          disputeId: s.uri.queryParameters['disputeId'],
        ),
      ),
      _route('/support/tickets/:id', (GoRouterState s) => TicketDetailScreen(ticketId: _id(s))),
      _route(Routes.settings, (GoRouterState s) => const SettingsScreen()),
      _route(Routes.editProfile, (GoRouterState s) => const EditProfileScreen()),
      _route(Routes.notificationSettings, (GoRouterState s) => const NotificationSettingsScreen()),
      _route(Routes.sessions, (GoRouterState s) => const SessionsScreen()),
      _route(Routes.privacy, (GoRouterState s) => const PrivacyScreen()),
    ],
  );
  ref.onDispose(() {
    router.dispose();
    refresh.dispose();
  });
  return router;
});
