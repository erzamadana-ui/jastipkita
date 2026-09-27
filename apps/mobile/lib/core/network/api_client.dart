import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/app_config.dart';
import '../models/json.dart';
import '../storage/settings.dart';
import '../storage/token_storage.dart';
import 'api_exception.dart';
import 'auth_interceptor.dart';
import 'idempotency.dart';

/// Thin JSON client over Dio for `/v1`. All failures are rethrown as [ApiException].
class ApiClient {
  ApiClient(this.dio, {Dio? uploadDio}) : _uploadDio = uploadDio ?? Dio();

  static const String idempotencyHeader = 'Idempotency-Key';

  final Dio dio;
  final Dio _uploadDio;

  Future<Json> get(String path, {Map<String, Object?>? query}) =>
      _send(() => dio.get<Object?>(path, queryParameters: _query(query)));

  Future<Json> post(String path, {Object? body, String? idempotencyKey, Map<String, Object?>? query}) => _send(
        () => dio.post<Object?>(path, data: body, queryParameters: _query(query), options: _options(idempotencyKey)),
      );

  Future<Json> put(String path, {Object? body}) => _send(() => dio.put<Object?>(path, data: body));

  Future<Json> patch(String path, {Object? body}) => _send(() => dio.patch<Object?>(path, data: body));

  Future<Json> delete(String path) => _send(() => dio.delete<Object?>(path));

  /// Direct upload to a presigned URL from `POST /files/uploads` (no bearer token: the URL is
  /// the credential). Headers are sent exactly as issued (the signature covers content-type).
  Future<void> uploadBytes(
    String url,
    Uint8List bytes, {
    required String contentType,
    Map<String, String> headers = const <String, String>{},
  }) async {
    final sendHeaders = <String, dynamic>{};
    for (final entry in headers.entries) {
      final lower = entry.key.toLowerCase();
      if (lower != 'content-length' && lower != 'host' && lower != 'content-type') sendHeaders[entry.key] = entry.value;
    }
    try {
      await _uploadDio.put<Object?>(
        AppConfig.rewriteLoopbackUrl(url),
        data: bytes,
        options: Options(
          headers: sendHeaders,
          contentType: headers['content-type'] ?? headers['Content-Type'] ?? contentType,
          sendTimeout: const Duration(minutes: 3),
          receiveTimeout: AppConfig.receiveTimeout,
        ),
      );
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  /// Plain-text GET of an absolute API URL (bearer attached) — e.g. the
  /// `${API_BASE_URL}/v1/files/{id}/content` links the API returns. Used as-is, never re-prefixed.
  Future<String> getText(String url) async {
    try {
      final response = await dio.get<String>(AppConfig.rewriteLoopbackUrl(url), options: Options(responseType: ResponseType.plain));
      return response.data ?? '';
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  /// Plain-text GET of a presigned (credential-in-URL) link, without the bearer token.
  Future<String> getExternalText(String url) async {
    try {
      final response = await _uploadDio.get<String>(
        AppConfig.rewriteLoopbackUrl(url),
        options: Options(responseType: ResponseType.plain),
      );
      return response.data ?? '';
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  Future<Json> _send(Future<Response<Object?>> Function() call) async {
    try {
      final response = await call();
      return asJson(response.data);
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  static Map<String, dynamic>? _query(Map<String, Object?>? query) {
    if (query == null) return null;
    final out = <String, dynamic>{};
    for (final entry in query.entries) {
      final value = entry.value;
      if (value != null && value.toString().isNotEmpty) out[entry.key] = value;
    }
    return out;
  }

  static Options? _options(String? idempotencyKey) =>
      idempotencyKey == null ? null : Options(headers: <String, dynamic>{idempotencyHeader: idempotencyKey});
}

Dio createApiDio() => Dio(
      BaseOptions(
        baseUrl: AppConfig.apiV1,
        connectTimeout: AppConfig.connectTimeout,
        receiveTimeout: AppConfig.receiveTimeout,
        contentType: Headers.jsonContentType,
        responseType: ResponseType.json,
        headers: <String, dynamic>{'Accept': 'application/json'},
      ),
    );

final tokenStorageProvider = Provider<TokenStorage>((ref) => SecureTokenStorage());

final tokenStoreProvider = Provider<TokenStore>((ref) => TokenStore(ref.watch(tokenStorageProvider)));

final tokenRefresherProvider = Provider<TokenRefresher>(
  (ref) => TokenRefresher(refreshDio: createApiDio(), store: ref.watch(tokenStoreProvider)),
);

final dioProvider = Provider<Dio>((ref) {
  final dio = createApiDio();
  dio.interceptors.add(LocaleHeaderInterceptor(() => ref.read(settingsProvider).languageCode));
  dio.interceptors.add(
    AuthInterceptor(store: ref.watch(tokenStoreProvider), refresher: ref.watch(tokenRefresherProvider), retryDio: dio),
  );
  return dio;
});

final apiClientProvider = Provider<ApiClient>((ref) => ApiClient(ref.watch(dioProvider)));

final idempotencyKeysProvider = Provider<IdempotencyKeys>((ref) => IdempotencyKeys());

final financialCallerProvider = Provider<FinancialCaller>((ref) => FinancialCaller(ref.watch(idempotencyKeysProvider)));
