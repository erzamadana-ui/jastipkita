import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/core/l10n/l10n.dart';
import 'package:jastipkita/core/network/api_exception.dart';

import '../helpers.dart';

void main() {
  final request = RequestOptions(path: '/transactions/1/checkout');

  group('ApiException.fromResponse', () {
    test('parses the API error envelope', () {
      final e = ApiException.fromResponse(409, <String, dynamic>{
        'error': <String, dynamic>{
          'code': 'QUOTE_EXPIRED',
          'message': 'Kurs sudah kedaluwarsa. Perbarui rincian harga.',
          'details': <String, dynamic>{'quoteId': 'q1'},
          'requestId': 'req_123',
        },
      });
      expect(e.code, 'QUOTE_EXPIRED');
      expect(e.message, startsWith('Kurs'));
      expect(e.statusCode, 409);
      expect(e.details['quoteId'], 'q1');
      expect(e.requestId, 'req_123');
      expect(e.isRetryable, isFalse);
    });

    test('non-envelope bodies become HTTP_<status>', () {
      final e = ApiException.fromResponse(502, '<html>Bad gateway</html>');
      expect(e.code, 'HTTP_502');
      expect(e.statusCode, 502);
      expect(e.isRetryable, isTrue);
    });

    test('envelope without a code keeps the status code', () {
      final e = ApiException.fromResponse(400, <String, dynamic>{'error': <String, dynamic>{'message': 'x'}});
      expect(e.code, 'HTTP_400');
      expect(e.message, 'x');
    });
  });

  group('ApiException.fromDio', () {
    test('timeouts', () {
      for (final type in <DioExceptionType>[
        DioExceptionType.connectionTimeout,
        DioExceptionType.sendTimeout,
        DioExceptionType.receiveTimeout,
      ]) {
        final e = ApiException.fromDio(DioException(requestOptions: request, type: type));
        expect(e.code, ApiException.timeout);
        expect(e.isNetwork, isTrue);
        expect(e.isRetryable, isTrue);
      }
    });

    test('connection errors are network errors', () {
      final e = ApiException.fromDio(DioException(requestOptions: request, type: DioExceptionType.connectionError));
      expect(e.code, ApiException.network);
      expect(e.isRetryable, isTrue);
    });

    test('bad responses keep the server envelope', () {
      final e = ApiException.fromDio(
        DioException(
          requestOptions: request,
          type: DioExceptionType.badResponse,
          response: Response<Object?>(
            requestOptions: request,
            statusCode: 422,
            data: <String, dynamic>{
              'error': <String, dynamic>{'code': 'CONSENT_REQUIRED', 'message': 'Persetujuan diperlukan', 'details': <String, dynamic>{}},
            },
          ),
        ),
      );
      expect(e.code, 'CONSENT_REQUIRED');
      expect(e.statusCode, 422);
      expect(e.isRetryable, isFalse);
    });

    test('cancelled requests', () {
      final e = ApiException.fromDio(DioException(requestOptions: request, type: DioExceptionType.cancel));
      expect(e.code, ApiException.cancelled);
      expect(e.isRetryable, isFalse);
    });
  });

  test('retry matrix: only transport errors, 408, 429, 5xx and IDEMPOTENCY_IN_PROGRESS', () {
    expect(const ApiException(code: 'X', statusCode: 500).isRetryable, isTrue);
    expect(const ApiException(code: 'X', statusCode: 503).isRetryable, isTrue);
    expect(const ApiException(code: 'X', statusCode: 429).isRetryable, isTrue);
    expect(const ApiException(code: 'X', statusCode: 408).isRetryable, isTrue);
    expect(const ApiException(code: ApiException.idempotencyInProgress, statusCode: 409).isRetryable, isTrue);
    expect(const ApiException(code: 'PAYMENT_NOT_SECURED', statusCode: 409).isRetryable, isFalse);
    expect(const ApiException(code: 'VALIDATION_ERROR', statusCode: 400).isRetryable, isFalse);
    expect(const ApiException(code: 'UNAUTHORIZED', statusCode: 401).isRetryable, isFalse);
  });

  test('user-facing messages', () {
    final l10n = idStrings;
    expect(errorMessage(l10n, const ApiException(code: ApiException.network)), l10n.errorNetwork);
    expect(errorMessage(l10n, const ApiException(code: ApiException.timeout)), l10n.errorTimeout);
    expect(errorMessage(l10n, const ApiException(code: 'X', statusCode: 401)), l10n.errorSessionExpired);
    expect(errorMessage(l10n, const ApiException(code: 'X', statusCode: 429)), l10n.errorRateLimited);
    expect(errorMessage(l10n, const ApiException(code: 'X', statusCode: 409, message: 'Pesan server')), 'Pesan server');
    expect(errorMessage(l10n, const ApiException(code: 'X', statusCode: 500)), l10n.errorServer);
    expect(errorMessage(l10n, StateError('boom')), l10n.errorGeneric);
  });
}
