import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:sign_in_with_apple/sign_in_with_apple.dart';

import '../../../core/config/app_config.dart';
import '../../../core/network/api_exception.dart';

class AppleCredential {
  const AppleCredential({required this.identityToken, required this.rawNonce, this.givenName, this.familyName});

  final String identityToken;

  /// The random nonce generated on the device. Apple received SHA-256(rawNonce); the API
  /// verifies `sha256hex(rawNonce)` against the token's `nonce` claim (replay protection).
  final String rawNonce;
  final String? givenName;
  final String? familyName;
}

/// Native Google / Apple sign-in → ID token for `POST /auth/google|apple`. The API verifies the
/// token against the provider JWKS; the app never sees a client secret.
class SocialSignIn {
  /// Apple is offered on iOS/macOS, or elsewhere only when a Services ID is configured.
  static bool get appleOffered {
    if (kIsWeb) return AppConfig.appleConfiguredForWeb;
    final platform = defaultTargetPlatform;
    if (platform == TargetPlatform.iOS || platform == TargetPlatform.macOS) return true;
    return AppConfig.appleConfiguredForWeb;
  }

  /// Returns the Google ID token, or null when the user cancelled.
  Future<String?> googleIdToken() async {
    final serverClientId = AppConfig.googleServerClientId;
    final clientId = AppConfig.googleClientId;
    final google = GoogleSignIn(
      scopes: const <String>['email'],
      serverClientId: kIsWeb || serverClientId.isEmpty ? null : serverClientId,
      clientId: clientId.isEmpty ? null : clientId,
    );
    try {
      final account = await google.signIn();
      if (account == null) return null;
      final auth = await account.authentication;
      final token = auth.idToken;
      if (token == null || token.isEmpty) {
        throw const ApiException(code: 'GOOGLE_NOT_CONFIGURED');
      }
      return token;
    } on ApiException {
      rethrow;
    } on Object {
      throw const ApiException(code: 'GOOGLE_SIGN_IN_FAILED');
    }
  }

  /// Returns the Apple credential, or null when the user cancelled.
  Future<AppleCredential?> apple() async {
    final rawNonce = _randomNonce();
    final hashed = sha256.convert(utf8.encode(rawNonce)).toString();
    try {
      final credential = await SignInWithApple.getAppleIDCredential(
        scopes: const <AppleIDAuthorizationScopes>[
          AppleIDAuthorizationScopes.email,
          AppleIDAuthorizationScopes.fullName,
        ],
        nonce: hashed,
        webAuthenticationOptions: AppConfig.appleConfiguredForWeb
            ? WebAuthenticationOptions(
                clientId: AppConfig.appleServiceId,
                redirectUri: Uri.parse(AppConfig.appleRedirectUri),
              )
            : null,
      );
      final token = credential.identityToken;
      if (token == null || token.isEmpty) throw const ApiException(code: 'APPLE_SIGN_IN_FAILED');
      return AppleCredential(
        identityToken: token,
        rawNonce: rawNonce,
        givenName: credential.givenName,
        familyName: credential.familyName,
      );
    } on SignInWithAppleAuthorizationException catch (e) {
      if (e.code == AuthorizationErrorCode.canceled) return null;
      throw const ApiException(code: 'APPLE_SIGN_IN_FAILED');
    } on ApiException {
      rethrow;
    } on Object {
      throw const ApiException(code: 'APPLE_SIGN_IN_FAILED');
    }
  }

  static String _randomNonce([int length = 32]) {
    const charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._';
    final random = Random.secure();
    return List<String>.generate(length, (int _) => charset[random.nextInt(charset.length)]).join();
  }
}

final socialSignInProvider = Provider<SocialSignIn>((ref) => SocialSignIn());
