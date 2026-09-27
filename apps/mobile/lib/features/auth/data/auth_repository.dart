import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/config/app_config.dart';
import '../../../core/models/account.dart';
import '../../../core/models/json.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/network/step_up.dart';
import '../../../core/storage/settings.dart';
import '../../../core/storage/token_storage.dart';

/// Consent decisions collected before an account is created. Which consents exist and their
/// versions come from `GET /consents/requirements` (signup: ToS + Privacy required, marketing
/// optional) — nothing is hard-coded. Registration is separate from KYC.
class ConsentChoice {
  const ConsentChoice({required this.group, required this.granted});

  final ConsentGroup group;

  /// type → granted (what the user ticked; required boxes must be ticked before submitting).
  final Map<String, bool> granted;

  /// `consents[]` for signup / `POST /me/consents`. [versionOverride] replaces the published
  /// version after a `CONSENT_VERSION_INVALID {allowedVersions}` answer.
  List<Json> toPayload({String? versionOverride}) => <Json>[
        for (final r in group.all)
          if ((versionOverride ?? r.versionToSend) != null)
            <String, dynamic>{
              'type': r.type,
              'version': versionOverride ?? r.versionToSend,
              'granted': granted[r.type] ?? false,
            },
      ];
}

/// Identity endpoints: `/auth/*`, `/me*`, `/privacy/*`.
class AuthRepository {
  AuthRepository(this._api, this._tokens, this._installationId);

  final ApiClient _api;
  final TokenStore _tokens;
  final String _installationId;

  Json get _device => <String, dynamic>{
        'platform': _platformCode,
        'fingerprint': _installationId,
        'appVersion': AppConfig.appVersion,
      };

  static String get _platformCode {
    if (kIsWeb) return 'WEB';
    return defaultTargetPlatform == TargetPlatform.iOS ? 'IOS' : 'ANDROID';
  }

  Future<OtpChallenge> requestOtp({
    required String channel,
    required String destination,
    String purpose = 'LOGIN',
    String locale = 'id',
  }) async {
    final json = await _api.post(
      '/auth/otp/request',
      body: <String, dynamic>{'channel': channel, 'destination': destination, 'purpose': purpose, 'locale': locale},
    );
    return OtpChallenge.fromJson(json);
  }

  /// SEC-12 step-up code for [request] (`purpose: SENSITIVE_ACTION`, bearer). [destination] must be
  /// the user's verified phone (SMS / WhatsApp) or verified e-mail, else
  /// `422 STEP_UP_DESTINATION_NOT_VERIFIED`. The code is not verified here: it goes into the
  /// protected request as `stepUp` (see core/network/step_up.dart).
  Future<OtpChallenge> requestStepUpOtp({
    required StepUpRequest request,
    required String channel,
    required String destination,
    String locale = 'id',
  }) async {
    final json = await _api.post(
      '/auth/otp/request',
      body: <String, dynamic>{
        'channel': channel,
        'destination': destination,
        'purpose': SensitiveAction.purpose,
        'action': request.action,
        'targetId': request.targetId,
        'locale': locale,
      },
    );
    return OtpChallenge.fromJson(json);
  }

  Future<LoginResult> verifyOtp({required String challengeId, required String code, List<Json>? consents}) async {
    final json = await _api.post(
      '/auth/otp/verify',
      body: <String, dynamic>{
        'challengeId': challengeId,
        'code': code,
        'device': _device,
        if (consents != null) 'consents': consents,
      },
    );
    return _persist(LoginResult.fromJson(json));
  }

  Future<LoginResult> signInWithGoogle({required String idToken, List<Json>? consents}) async {
    final json = await _api.post(
      '/auth/google',
      body: <String, dynamic>{'idToken': idToken, 'device': _device, if (consents != null) 'consents': consents},
    );
    return _persist(LoginResult.fromJson(json));
  }

  /// [rawNonce]: the API checks `sha256hex(rawNonce)` against the token's `nonce` claim.
  Future<LoginResult> signInWithApple({
    required String identityToken,
    required String rawNonce,
    String? givenName,
    String? familyName,
    List<Json>? consents,
  }) async {
    final json = await _api.post(
      '/auth/apple',
      body: <String, dynamic>{
        'identityToken': identityToken,
        'rawNonce': rawNonce,
        if (givenName != null || familyName != null)
          'fullName': <String, dynamic>{
            if (givenName != null) 'givenName': givenName,
            if (familyName != null) 'familyName': familyName,
          },
        'device': _device,
        if (consents != null) 'consents': consents,
      },
    );
    return _persist(LoginResult.fromJson(json));
  }

  Future<LoginResult> _persist(LoginResult result) async {
    final tokens = result.tokens;
    if (tokens != null && tokens.isValid) await _tokens.save(tokens);
    return result;
  }

  Future<void> logout() async {
    try {
      await _api.post('/auth/logout');
    } on ApiException {
      // The local session ends regardless; the server session expires on its own.
    } finally {
      await _tokens.clear();
    }
  }

  Future<AuthTokens?> storedTokens() => _tokens.load();

  Future<Profile> me() async => Profile.fromJson(await _api.get('/me'));

  /// `PATCH /me`. A new transaction e-mail returns a pending e-mail OTP challenge id.
  Future<(Profile, String?)> updateProfile({String? displayName, String? locale, String? transactionEmail}) async {
    final json = await _api.patch(
      '/me',
      body: <String, dynamic>{
        if (displayName != null) 'displayName': displayName,
        if (locale != null) 'locale': locale,
        if (transactionEmail != null) 'transactionEmail': transactionEmail.isEmpty ? null : transactionEmail,
      },
    );
    final pending = readObjectOrNull(json, 'pendingVerification');
    return (Profile.fromJson(readObject(json, 'user')), pending == null ? null : readStringOrNull(pending, 'challengeId'));
  }

  Future<Profile> switchMode(String mode) async =>
      Profile.fromJson(await _api.post('/me/mode', body: <String, dynamic>{'mode': mode}));

  Future<ConsentState> consents() async => ConsentState.fromJson(await _api.get('/me/consents'));

  /// Consent types + exact versions to collect at signup and before KYC (public; with a token
  /// it also says what is already granted).
  Future<ConsentRequirements> consentRequirements({String locale = 'id'}) async =>
      ConsentRequirements.fromJson(await _api.get('/consents/requirements', query: <String, Object?>{'locale': locale}));

  /// Current published legal documents (latest version per type & locale).
  Future<List<LegalDocumentSummary>> legalDocuments({String locale = 'id', String? type}) async =>
      readList(await _api.get('/legal/documents', query: <String, Object?>{'locale': locale, 'type': type}), 'data')
          .map(LegalDocumentSummary.fromJson)
          .toList();

  /// One legal document with its Markdown body.
  Future<LegalDocument> legalDocument(String type, {String locale = 'id', String? version}) async =>
      LegalDocument.fromJson(await _api.get('/legal/documents/$type', query: <String, Object?>{'locale': locale, 'version': version}));

  Future<void> recordConsent({required String type, required String version, required bool granted}) async {
    await _api.post('/me/consents', body: <String, dynamic>{'type': type, 'version': version, 'granted': granted});
  }

  Future<List<SessionInfo>> sessions() async =>
      readList(await _api.get('/auth/sessions'), 'data').map(SessionInfo.fromJson).toList();

  Future<void> revokeSession(String id) async {
    await _api.delete('/auth/sessions/$id');
  }

  Future<void> registerPushToken(String? pushToken) async {
    await _api.post('/me/devices', body: <String, dynamic>{..._device, 'pushToken': pushToken});
  }

  Future<PrivacyRequest> requestExport() async => PrivacyRequest.fromJson(await _api.post('/privacy/export'));

  Future<List<PrivacyRequest>> privacyRequests() async =>
      readList(await _api.get('/privacy/requests'), 'data').map(PrivacyRequest.fromJson).toList();

  Future<PrivacyRequest> deleteAccount({String? reason}) async {
    final json = await _api.post(
      '/privacy/delete-account',
      body: <String, dynamic>{'confirm': true, if (reason != null && reason.isNotEmpty) 'reason': reason},
    );
    return PrivacyRequest.fromJson(readObject(json, 'request'));
  }

  Future<PrivacyRequest> cancelDeletion() async => PrivacyRequest.fromJson(await _api.post('/privacy/cancel-deletion'));
}

final authRepositoryProvider = Provider<AuthRepository>(
  (ref) => AuthRepository(ref.watch(apiClientProvider), ref.watch(tokenStoreProvider), ref.watch(installationIdProvider)),
);

/// Consent requirements per locale (`id` | `en`).
final consentRequirementsProvider = FutureProvider.autoDispose.family<ConsentRequirements, String>(
  (ref, locale) => ref.watch(authRepositoryProvider).consentRequirements(locale: locale),
);

/// Legal document by (type, locale).
final legalDocumentProvider = FutureProvider.autoDispose.family<LegalDocument, (String, String)>(
  (ref, key) => ref.watch(authRepositoryProvider).legalDocument(key.$1, locale: key.$2),
);
