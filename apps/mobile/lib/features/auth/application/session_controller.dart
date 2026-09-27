import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/account.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_exception.dart';
import '../data/auth_repository.dart';

enum AuthStatus { unknown, signedOut, signedIn }

class SessionState {
  const SessionState({
    required this.status,
    this.profile,
    this.needsConsent = false,
    this.restoreError,
    this.expired = false,
  });

  final AuthStatus status;
  final Profile? profile;

  /// Signed in but a required consent (ToS / Privacy) is missing for the current version.
  final bool needsConsent;

  /// Set while [AuthStatus.unknown] when the restore failed for a transport reason.
  final Object? restoreError;

  /// The refresh token was rejected (signed out by the server, not by the user).
  final bool expired;

  bool get isSignedIn => status == AuthStatus.signedIn;

  SessionState copyWith({AuthStatus? status, Profile? profile, bool? needsConsent}) => SessionState(
        status: status ?? this.status,
        profile: profile ?? this.profile,
        needsConsent: needsConsent ?? this.needsConsent,
        restoreError: restoreError,
        expired: expired,
      );
}

/// Single source of truth for "who is signed in". The router listens to it for redirects.
class SessionController extends Notifier<SessionState> {
  AuthRepository get _repo => ref.read(authRepositoryProvider);

  @override
  SessionState build() {
    ref.watch(tokenRefresherProvider).onSessionExpired = _onExpired;
    Future<void>.microtask(restore);
    return const SessionState(status: AuthStatus.unknown);
  }

  /// Loads stored tokens and the profile. Transport errors keep the app on the splash with a
  /// retry instead of signing the user out.
  Future<void> restore() async {
    state = const SessionState(status: AuthStatus.unknown);
    final tokens = await _repo.storedTokens();
    if (tokens == null) {
      state = const SessionState(status: AuthStatus.signedOut);
      return;
    }
    try {
      final profile = await _repo.me();
      final needsConsent = await _missingConsent();
      state = SessionState(status: AuthStatus.signedIn, profile: profile, needsConsent: needsConsent);
    } on ApiException catch (e) {
      if (e.isUnauthorized) {
        state = const SessionState(status: AuthStatus.signedOut, expired: true);
      } else {
        state = SessionState(status: AuthStatus.unknown, restoreError: e);
      }
    }
  }

  Future<void> completeLogin(LoginResult result) async {
    final needsConsent = await _missingConsent();
    state = SessionState(status: AuthStatus.signedIn, profile: result.user, needsConsent: needsConsent);
  }

  Future<bool> _missingConsent() async {
    try {
      final consents = await _repo.consents();
      return consents.missingRequired.isNotEmpty;
    } on ApiException {
      return false;
    }
  }

  void consentsRecorded() {
    state = state.copyWith(needsConsent: false);
  }

  Future<void> refreshProfile() async {
    try {
      final profile = await _repo.me();
      state = state.copyWith(profile: profile);
    } on ApiException {
      // Keep the cached profile; screens show their own errors.
    }
  }

  void setProfile(Profile profile) {
    state = state.copyWith(profile: profile);
  }

  /// `POST /me/mode` — Penitip ↔ Traveler.
  Future<void> switchMode(String mode) async {
    final profile = await _repo.switchMode(mode);
    state = state.copyWith(profile: profile);
  }

  Future<void> signOut() async {
    await _repo.logout();
    state = const SessionState(status: AuthStatus.signedOut);
  }

  void _onExpired() {
    if (state.status != AuthStatus.signedOut) {
      state = const SessionState(status: AuthStatus.signedOut, expired: true);
    }
  }
}

final sessionControllerProvider = NotifierProvider<SessionController, SessionState>(SessionController.new);

/// Convenience: the signed-in profile (null while signed out / restoring).
final currentProfileProvider = Provider<Profile?>((ref) => ref.watch(sessionControllerProvider).profile);
