import 'package:dio/dio.dart';

import '../models/json.dart';
import '../storage/token_storage.dart';
import 'api_exception.dart';

/// Rotates the refresh token (`POST /v1/auth/refresh`). Concurrent callers share one in-flight
/// rotation ("single flight"): the API revokes the whole token family when a rotated refresh
/// token is reused, so two parallel refreshes would log the user out.
class TokenRefresher {
  TokenRefresher({required Dio refreshDio, required TokenStore store})
      : _dio = refreshDio,
        _store = store;

  final Dio _dio;
  final TokenStore _store;
  Future<AuthTokens?>? _inflight;

  /// Number of network rotations performed (diagnostics & tests).
  int rotations = 0;

  /// Called when the refresh token was rejected; the session is over.
  void Function()? onSessionExpired;

  /// New tokens, or `null` when the session is no longer valid (signed out).
  /// Throws [ApiException] on transport errors — the caller keeps the current session.
  Future<AuthTokens?> refresh() async {
    final existing = _inflight;
    if (existing != null) return existing;
    final future = _rotate();
    _inflight = future;
    try {
      return await future;
    } finally {
      if (identical(_inflight, future)) _inflight = null;
    }
  }

  Future<AuthTokens?> _rotate() async {
    final current = await _store.load();
    if (current == null) {
      _expire();
      return null;
    }
    rotations++;
    try {
      final response = await _dio.post<Object?>(
        '/auth/refresh',
        data: <String, dynamic>{'refreshToken': current.refreshToken},
        options: Options(extra: <String, dynamic>{AuthInterceptor.skipAuthKey: true}),
      );
      final tokens = AuthTokens.fromJson(readObject(asJson(response.data), 'tokens'));
      if (!tokens.isValid) {
        await _store.clear();
        _expire();
        return null;
      }
      await _store.save(tokens);
      return tokens;
    } on DioException catch (e) {
      final status = e.response?.statusCode;
      final rejected = status != null && status >= 400 && status < 500 && status != 408 && status != 429;
      if (rejected) {
        await _store.clear();
        _expire();
        return null;
      }
      throw ApiException.fromDio(e);
    }
  }

  void _expire() {
    final callback = onSessionExpired;
    if (callback != null) callback();
  }
}

/// Adds `Authorization: Bearer <access>` and transparently recovers from a 401 by rotating the
/// refresh token once and replaying the request (same headers → same Idempotency-Key).
class AuthInterceptor extends Interceptor {
  AuthInterceptor({
    required TokenStore store,
    required TokenRefresher refresher,
    required Dio retryDio,
    DateTime Function()? clock,
  })  : _store = store,
        _refresher = refresher,
        _retryDio = retryDio,
        _clock = clock ?? DateTime.now;

  static const String skipAuthKey = 'jk.skipAuth';
  static const String retriedKey = 'jk.authRetried';
  static const Duration refreshMargin = Duration(seconds: 30);

  final TokenStore _store;
  final TokenRefresher _refresher;
  final Dio _retryDio;
  final DateTime Function() _clock;

  @override
  Future<void> onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    if (options.extra[skipAuthKey] == true) {
      handler.next(options);
      return;
    }
    var tokens = await _store.load();
    if (tokens != null && tokens.accessExpiresWithin(refreshMargin, _clock().toUtc())) {
      try {
        tokens = await _refresher.refresh();
      } on ApiException {
        // Offline: send the current token; the 401 path retries once connectivity is back.
      }
    }
    if (tokens != null) options.headers['Authorization'] = 'Bearer ${tokens.accessToken}';
    handler.next(options);
  }

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    final options = err.requestOptions;
    final unauthorized = err.response?.statusCode == 401;
    if (!unauthorized || options.extra[skipAuthKey] == true || options.extra[retriedKey] == true) {
      handler.next(err);
      return;
    }
    final current = _store.current;
    if (current == null) {
      handler.next(err);
      return;
    }
    AuthTokens? fresh;
    final Object? sent = options.headers['Authorization'];
    if (sent is String && sent != 'Bearer ${current.accessToken}') {
      // Another request already rotated the tokens while this one was in flight.
      fresh = current;
    } else {
      try {
        fresh = await _refresher.refresh();
      } on ApiException {
        handler.next(err);
        return;
      }
    }
    if (fresh == null) {
      handler.next(err);
      return;
    }
    options.headers['Authorization'] = 'Bearer ${fresh.accessToken}';
    options.extra[retriedKey] = true;
    try {
      final response = await _retryDio.fetch<Object?>(options);
      handler.resolve(response);
    } on DioException catch (e) {
      handler.next(e);
    }
  }
}

/// Sends `Accept-Language` so server messages (restricted items, errors) match the UI locale.
class LocaleHeaderInterceptor extends Interceptor {
  LocaleHeaderInterceptor(this._languageCode);

  final String Function() _languageCode;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    options.headers['Accept-Language'] = _languageCode();
    handler.next(options);
  }
}
