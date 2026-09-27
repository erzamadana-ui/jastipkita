/// Build-time configuration, injected with `--dart-define=KEY=value`.
///
/// Only public identifiers live here (base URLs, OAuth *client ids*). Secrets never ship in the
/// app: the API owns every key, token and credential.
abstract final class AppConfig {
  /// API origin without `/v1`. Default = Android emulator → host machine (`apps/api` dev server).
  static const String apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:8787');

  /// `development` | `staging` | `production`.
  static const String appEnv = String.fromEnvironment('APP_ENV', defaultValue: 'development');

  /// Google OAuth *web* client id used as `serverClientId` so Android/iOS return an ID token
  /// whose audience the API accepts (`GOOGLE_CLIENT_IDS`).
  static const String googleServerClientId = String.fromEnvironment('GOOGLE_SERVER_CLIENT_ID');

  /// Optional platform client id (iOS / web). Empty = read from the native config.
  static const String googleClientId =
      String.fromEnvironment('GOOGLE_IOS_CLIENT_ID', defaultValue: String.fromEnvironment('GOOGLE_CLIENT_ID'));

  /// Sign in with Apple on Android/web needs a Services ID + redirect URI. When both are empty
  /// the Apple button is only shown on iOS.
  static const String appleServiceId = String.fromEnvironment('APPLE_SERVICE_ID');
  static const String appleRedirectUri = String.fromEnvironment('APPLE_REDIRECT_URI');

  /// Version of ToS / Privacy / Marketing consent documents the app displays.
  static const String consentVersion = String.fromEnvironment('CONSENT_VERSION', defaultValue: '2026-09');

  /// Public web origin (legal pages, share links, universal links).
  static const String webBaseUrl =
      String.fromEnvironment('WEB_BASE_URL', defaultValue: 'https://antarkitaindonesia.com/jastipkita');

  static const String appVersion = String.fromEnvironment('APP_VERSION', defaultValue: '0.1.0');

  static const Duration connectTimeout = Duration(seconds: 15);
  static const Duration receiveTimeout = Duration(seconds: 30);
  static const Duration sendTimeout = Duration(seconds: 60);

  static bool get isProduction => appEnv == 'production';

  static bool get appleConfiguredForWeb => appleServiceId.isNotEmpty && appleRedirectUri.isNotEmpty;

  /// `https://host:port/v1`
  static String get apiV1 => '${_trimSlash(apiBaseUrl)}/v1';

  static const String _termsUrl = String.fromEnvironment('TERMS_URL');
  static const String _privacyUrl = String.fromEnvironment('PRIVACY_POLICY_URL');
  static const String _accountDeletionUrl = String.fromEnvironment('ACCOUNT_DELETION_URL');

  /// Customer-service WhatsApp number, digits only (e.g. `628…`). Empty = hidden.
  static const String supportWhatsApp = String.fromEnvironment('SUPPORT_WHATSAPP');
  static const String supportEmail = String.fromEnvironment('SUPPORT_EMAIL');

  /// Shows the SANDBOX badge next to payment / verification surfaces. Defaults to on outside
  /// production so testers never mistake a mock payment or liveness check for a real one.
  static const String _showSandboxBadge = String.fromEnvironment('SHOW_SANDBOX_BADGE');
  static bool get showSandboxBadge => _showSandboxBadge.isEmpty ? !isProduction : _showSandboxBadge == 'true';

  /// Legal pages published by apps/web (override with TERMS_URL / PRIVACY_POLICY_URL).
  static String get termsUrl => _termsUrl.isNotEmpty ? _termsUrl : '${_trimSlash(webBaseUrl)}/legal/terms-of-service/';
  static String get privacyUrl => _privacyUrl.isNotEmpty ? _privacyUrl : '${_trimSlash(webBaseUrl)}/legal/privacy-policy/';

  /// Public account-deletion page declared to Google Play (works without the app).
  static String get accountDeletionUrl =>
      _accountDeletionUrl.isNotEmpty ? _accountDeletionUrl : '${_trimSlash(webBaseUrl)}/hapus-akun/';

  static String _trimSlash(String value) {
    var out = value;
    while (out.endsWith('/')) {
      out = out.substring(0, out.length - 1);
    }
    return out;
  }

  /// Dev helper: the API builds presigned-upload and mock-checkout URLs from its own
  /// `API_BASE_URL` (usually `http://localhost:8787`), which an emulator cannot reach. Outside
  /// production, rewrite loopback hosts to the host the app is configured with.
  static String rewriteLoopbackUrl(String url) {
    if (isProduction) return url;
    final target = Uri.tryParse(url);
    final base = Uri.tryParse(apiBaseUrl);
    if (target == null || base == null) return url;
    const loopback = <String>{'localhost', '127.0.0.1', '0.0.0.0'};
    if (!loopback.contains(target.host) || loopback.contains(base.host)) return url;
    return target.replace(scheme: base.scheme, host: base.host, port: base.port).toString();
  }
}
