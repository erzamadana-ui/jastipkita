import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../models/json.dart';

/// Access (15 min) + refresh (30 days, rotated) tokens from `POST /auth/*`.
class AuthTokens {
  const AuthTokens({
    required this.accessToken,
    required this.refreshToken,
    this.accessTokenExpiresAt,
    this.refreshTokenExpiresAt,
    this.sessionId,
  });

  factory AuthTokens.fromJson(Json json) => AuthTokens(
        accessToken: readString(json, 'accessToken'),
        refreshToken: readString(json, 'refreshToken'),
        accessTokenExpiresAt: readDate(json, 'accessTokenExpiresAt'),
        refreshTokenExpiresAt: readDate(json, 'refreshTokenExpiresAt'),
        sessionId: readStringOrNull(json, 'sessionId'),
      );

  final String accessToken;
  final String refreshToken;
  final DateTime? accessTokenExpiresAt;
  final DateTime? refreshTokenExpiresAt;
  final String? sessionId;

  bool get isValid => accessToken.isNotEmpty && refreshToken.isNotEmpty;

  bool accessExpiresWithin(Duration margin, DateTime nowUtc) {
    final exp = accessTokenExpiresAt;
    return exp != null && exp.isBefore(nowUtc.add(margin));
  }

  Json toJson() => <String, dynamic>{
        'accessToken': accessToken,
        'refreshToken': refreshToken,
        'accessTokenExpiresAt': accessTokenExpiresAt?.toIso8601String(),
        'refreshTokenExpiresAt': refreshTokenExpiresAt?.toIso8601String(),
        'sessionId': sessionId,
      };
}

/// Persistence for [AuthTokens]. Production uses the platform keystore (Keychain / Android
/// Keystore-backed storage); nothing sensitive goes to shared_preferences.
abstract class TokenStorage {
  Future<AuthTokens?> read();
  Future<void> write(AuthTokens tokens);
  Future<void> clear();
}

class SecureTokenStorage implements TokenStorage {
  SecureTokenStorage([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();

  static const String _key = 'jk.auth.tokens.v1';
  final FlutterSecureStorage _storage;

  @override
  Future<AuthTokens?> read() async {
    try {
      final raw = await _storage.read(key: _key);
      if (raw == null || raw.isEmpty) return null;
      final tokens = AuthTokens.fromJson(asJson(jsonDecode(raw)));
      return tokens.isValid ? tokens : null;
    } on Object {
      // Corrupted or inaccessible keystore entry → treat as signed out.
      return null;
    }
  }

  @override
  Future<void> write(AuthTokens tokens) => _storage.write(key: _key, value: jsonEncode(tokens.toJson()));

  @override
  Future<void> clear() => _storage.delete(key: _key);
}

/// Used by tests and as a fallback when the keystore is unavailable.
class MemoryTokenStorage implements TokenStorage {
  MemoryTokenStorage([this._tokens]);

  AuthTokens? _tokens;

  @override
  Future<AuthTokens?> read() async => _tokens;

  @override
  Future<void> write(AuthTokens tokens) async {
    _tokens = tokens;
  }

  @override
  Future<void> clear() async {
    _tokens = null;
  }
}

/// In-memory cache in front of [TokenStorage] so requests do not hit the keystore each time.
class TokenStore {
  TokenStore(this._storage);

  final TokenStorage _storage;
  AuthTokens? _current;
  bool _loaded = false;

  AuthTokens? get current => _current;

  Future<AuthTokens?> load() async {
    if (!_loaded) {
      _current = await _storage.read();
      _loaded = true;
    }
    return _current;
  }

  Future<void> save(AuthTokens tokens) async {
    _current = tokens;
    _loaded = true;
    await _storage.write(tokens);
  }

  Future<void> clear() async {
    _current = null;
    _loaded = true;
    await _storage.clear();
  }
}
