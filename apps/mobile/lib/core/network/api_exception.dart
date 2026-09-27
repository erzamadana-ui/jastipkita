import 'package:dio/dio.dart';

import '../models/json.dart';

/// Every failure surfaced to the UI. Server errors follow
/// `{ "error": { "code", "message", "details", "requestId" } }`; transport failures get a
/// synthetic code so screens can offer "Coba lagi".
class ApiException implements Exception {
  const ApiException({
    required this.code,
    this.message = '',
    this.statusCode,
    this.details = const <String, dynamic>{},
    this.requestId,
  });

  /// Parses the API error envelope. Anything else becomes `HTTP_<status>`.
  factory ApiException.fromResponse(int? statusCode, Object? body) {
    final envelope = asJson(body);
    final error = readObjectOrNull(envelope, 'error');
    if (error != null) {
      return ApiException(
        code: readString(error, 'code', 'HTTP_${statusCode ?? 0}'),
        message: readString(error, 'message'),
        statusCode: statusCode,
        details: readObject(error, 'details'),
        requestId: readStringOrNull(error, 'requestId'),
      );
    }
    return ApiException(code: 'HTTP_${statusCode ?? 0}', statusCode: statusCode);
  }

  factory ApiException.fromDio(DioException e) {
    final Object? inner = e.error;
    if (inner is ApiException) return inner;
    final type = e.type;
    if (type == DioExceptionType.connectionTimeout ||
        type == DioExceptionType.sendTimeout ||
        type == DioExceptionType.receiveTimeout) {
      return const ApiException(code: timeout);
    }
    if (type == DioExceptionType.cancel) return const ApiException(code: cancelled);
    if (type == DioExceptionType.badResponse || e.response != null) {
      return ApiException.fromResponse(e.response?.statusCode, e.response?.data);
    }
    return const ApiException(code: network);
  }

  final String code;
  final String message;
  final int? statusCode;
  final Json details;
  final String? requestId;

  static const String network = 'NETWORK_ERROR';
  static const String timeout = 'TIMEOUT';
  static const String cancelled = 'CANCELLED';
  static const String idempotencyInProgress = 'IDEMPOTENCY_IN_PROGRESS';

  bool get isNetwork => code == network || code == timeout;

  bool get isUnauthorized => statusCode == 401;

  /// Safe to repeat with the *same* Idempotency-Key: the server either replays the stored
  /// response or finishes the first attempt.
  bool get isRetryable {
    if (isNetwork || code == idempotencyInProgress) return true;
    final s = statusCode;
    return s == 408 || s == 429 || (s != null && s >= 500);
  }

  @override
  String toString() => 'ApiException($code, $statusCode, $message${requestId == null ? '' : ', requestId=$requestId'})';
}
