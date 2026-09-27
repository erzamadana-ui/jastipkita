/// App paths, plus the normaliser for incoming links:
/// * `jastipkita://transactions/{id}` (custom scheme: the first segment arrives as the host);
/// * `https://antarkitaindonesia.com/jastipkita/app/transactions/{id}` (universal/app links);
/// * `https://antarkitaindonesia.com/jastipkita/r/{code}` (referral links, prefilled on the referral screen);
/// * notification `data.deepLink` values produced by the API (`transactions/{id}/receipt`,
///   `disputes/{id}`, `conversations/{id}`, `account/verification`, `support/tickets/{id}`, …).
abstract final class Routes {
  static const String splash = '/splash';
  static const String welcome = '/welcome';
  static const String login = '/login';
  static const String loginOtp = '/login/otp';
  static const String consents = '/consents';

  static const String home = '/home';
  static const String titipan = '/titipan';
  static const String trips = '/trips';
  static const String orders = '/orders';
  static const String chat = '/chat';
  static const String wallet = '/wallet';
  static const String profile = '/profile';

  static const String travelers = '/travelers';
  static const String newRequest = '/requests/new';
  static const String openRequests = '/open-requests';
  static const String newTrip = '/trips/new';
  static const String notifications = '/notifications';
  static const String disputes = '/disputes';
  static const String kyc = '/account/verification';
  static const String kycSubmit = '/account/verification/submit';
  static const String payoutAccounts = '/account/payout-accounts';
  static const String referrals = '/referrals';
  static const String payouts = '/payouts';
  static const String support = '/support';
  static const String tickets = '/support/tickets';
  static const String newTicket = '/support/tickets/new';
  static const String settings = '/settings';
  static const String editProfile = '/profile/edit';
  static const String notificationSettings = '/settings/notifications';
  static const String sessions = '/settings/sessions';
  static const String privacy = '/settings/privacy';

  static String transaction(String id) => '/transactions/$id';
  static String checkout(String id) => '/transactions/$id/checkout';
  static String payment(String id) => '/transactions/$id/payment';
  static String handover(String id) => '/transactions/$id/handover';
  static String verifyHandover(String id) => '/transactions/$id/verify-handover';
  static String priceCheck(String id) => '/transactions/$id/price-check';
  static String purchaseProof(String id) => '/transactions/$id/purchase-proof';
  static String customs(String id) => '/transactions/$id/customs';
  static String delivery(String id) => '/transactions/$id/delivery';
  static String openDispute(String id) => '/transactions/$id/dispute';
  static String request(String id) => '/requests/$id';
  static String openRequest(String id, {String? tripId}) =>
      tripId == null ? '/open-requests/$id' : '/open-requests/$id?tripId=$tripId';
  static String trip(String id) => '/trips/$id';
  static String conversation(String id) => '/conversations/$id';
  static String dispute(String id) => '/disputes/$id';
  static String faq(String slug) => '/support/faq/$slug';
  static String ticket(String id) => '/support/tickets/$id';
  static String referralWithCode(String code) => '/referrals?code=${Uri.encodeQueryComponent(code)}';

  /// Screens reachable without a session.
  static bool isPublic(String path) => path == welcome || path == login || path.startsWith('$login/');
}

final RegExp _safeId = RegExp(r'^[A-Za-z0-9_-]{1,64}$');

/// Maps an external link to an in-app path, or null when it is not one of ours.
String? normalizeDeepLink(Uri uri) {
  final scheme = uri.scheme.toLowerCase();
  List<String> segments;
  if (scheme == 'jastipkita') {
    segments = <String>[if (uri.host.isNotEmpty) uri.host, ...uri.pathSegments];
  } else if (scheme == 'http' || scheme == 'https' || scheme.isEmpty) {
    segments = List<String>.of(uri.pathSegments);
    if (segments.isNotEmpty && segments.first == 'jastipkita') segments = segments.sublist(1);
    if (segments.isNotEmpty && segments.first == 'app') segments = segments.sublist(1);
  } else {
    return null;
  }
  segments = segments.where((String s) => s.isNotEmpty).toList();
  if (segments.isEmpty) return Routes.home;

  String? idAt(int index) {
    if (segments.length <= index) return null;
    final value = segments[index];
    return _safeId.hasMatch(value) ? value : null;
  }

  final id = idAt(1);
  switch (segments.first) {
    case 'home':
      return Routes.home;
    case 'transactions':
    case 'handover':
      if (id == null) return Routes.titipan;
      if (segments.length >= 3 && segments[2] == 'receipt') return Routes.payment(id);
      return Routes.transaction(id);
    case 'disputes':
      return id == null ? Routes.disputes : Routes.dispute(id);
    case 'conversations':
    case 'chat':
      return id == null ? Routes.chat : Routes.conversation(id);
    case 'referrals':
      return Routes.referrals;
    case 'r':
      // Public referral link https://antarkitaindonesia.com/jastipkita/r/{CODE}/
      return id == null ? Routes.referrals : Routes.referralWithCode(id);
    case 'wallet':
      return Routes.wallet;
    case 'account':
      return segments.length >= 2 && segments[1] == 'verification' ? Routes.kyc : Routes.profile;
    case 'support':
      final ticketId = idAt(2);
      if (segments.length >= 3 && segments[1] == 'tickets' && ticketId != null) return Routes.ticket(ticketId);
      return Routes.support;
    case 'trips':
      return id == null ? Routes.trips : Routes.trip(id);
    case 'requests':
      return id == null ? Routes.titipan : Routes.request(id);
    default:
      return null;
  }
}

/// Auth redirect with a remembered target: a deep link opened while signed out (or while the
/// session is restoring) is replayed after sign-in.
class AuthRedirector {
  String? _pending;

  String? get pending => _pending;

  /// [status]: 0 unknown/restoring, 1 signed out, 2 signed in.
  String? redirect({required int status, required bool needsConsent, required Uri uri}) {
    final path = uri.path;
    final customScheme = uri.scheme.isNotEmpty && uri.scheme != 'http' && uri.scheme != 'https';
    final isExternal = customScheme || path.startsWith('/jastipkita/');
    if (isExternal) {
      final normalized = normalizeDeepLink(uri);
      if (normalized != null) return normalized;
    }
    if (status == 0) {
      if (path != Routes.splash) {
        _remember(uri);
        return Routes.splash;
      }
      return null;
    }
    if (status == 1) {
      if (Routes.isPublic(path)) return null;
      _remember(uri);
      return Routes.welcome;
    }
    if (needsConsent) return path == Routes.consents ? null : Routes.consents;
    if (Routes.isPublic(path) || path == Routes.splash || path == Routes.consents || path == '/' || path.isEmpty) {
      final target = _pending;
      _pending = null;
      return target ?? Routes.home;
    }
    return null;
  }

  void _remember(Uri uri) {
    final path = uri.path;
    if (path.isEmpty || path == '/' || path == Routes.splash || Routes.isPublic(path) || path == Routes.consents) return;
    _pending = uri.hasQuery ? '$path?${uri.query}' : path;
  }
}
