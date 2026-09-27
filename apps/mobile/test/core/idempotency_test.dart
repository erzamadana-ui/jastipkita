import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/core/network/api_client.dart';
import 'package:jastipkita/core/network/api_exception.dart';
import 'package:jastipkita/core/network/idempotency.dart';

import '../fake_http.dart';

void main() {
  late int generated;
  late IdempotencyKeys keys;
  late FinancialCaller caller;

  setUp(() {
    generated = 0;
    keys = IdempotencyKeys(generator: () => 'key-${++generated}');
    caller = FinancialCaller(keys, backoff: Duration.zero);
  });

  group('FinancialCaller (unit)', () {
    test('retries a transport failure with the SAME key, then releases it on success', () async {
      final seen = <String>[];
      final result = await caller.run<String>('checkout:tx1:q1', (String key) async {
        seen.add(key);
        if (seen.length < 3) throw const ApiException(code: ApiException.network);
        return 'ok';
      });
      expect(result, 'ok');
      expect(seen, <String>['key-1', 'key-1', 'key-1']);
      expect(keys.hasPending('checkout:tx1:q1'), isFalse);
    });

    test('keeps the key when retries are exhausted so a manual retry reuses it', () async {
      final seen = <String>[];
      Future<String> failing(String key) async {
        seen.add(key);
        throw const ApiException(code: 'HTTP_503', statusCode: 503);
      }

      await expectLater(caller.run<String>('checkout:tx1:q1', failing), throwsA(isA<ApiException>()));
      expect(keys.hasPending('checkout:tx1:q1'), isTrue);

      final again = await caller.run<String>('checkout:tx1:q1', (String key) async {
        seen.add(key);
        return 'paid';
      });
      expect(again, 'paid');
      expect(seen.toSet(), <String>{'key-1'}, reason: 'every attempt of one logical action shares one key');
      expect(seen.length, 4);
    });

    test('a definitive business error releases the key: the next attempt is a new action', () async {
      await expectLater(
        caller.run<void>('confirm:tx1', (String key) async => throw const ApiException(code: 'INVALID_STATE', statusCode: 409)),
        throwsA(isA<ApiException>()),
      );
      expect(keys.hasPending('confirm:tx1'), isFalse);
      String? next;
      await caller.run<void>('confirm:tx1', (String key) async {
        next = key;
      });
      expect(next, 'key-2');
    });

    test('different logical actions get different keys', () async {
      String? a;
      String? b;
      await caller.run<void>('checkout:tx1:q1', (String key) async {
        a = key;
      });
      await caller.run<void>('checkout:tx1:q2', (String key) async {
        b = key;
      });
      expect(a, isNot(b));
    });

    test('IDEMPOTENCY_IN_PROGRESS is retried with the same key', () async {
      final seen = <String>[];
      await caller.run<void>('pc:1:APPROVE', (String key) async {
        seen.add(key);
        if (seen.length == 1) throw const ApiException(code: ApiException.idempotencyInProgress, statusCode: 409);
      });
      expect(seen, <String>['key-1', 'key-1']);
    });
  });

  group('FinancialCaller + ApiClient over HTTP', () {
    test('every HTTP attempt carries the same Idempotency-Key header', () async {
      final adapter = FakeAdapter((RequestOptions o, int i) {
        if (i == 0) return const FakeReply.networkError();
        if (i == 1) return FakeReply(503, errorBody('UPSTREAM_UNAVAILABLE'));
        return const FakeReply(201, <String, dynamic>{
          'paymentId': 'p1',
          'status': 'PENDING',
          'checkoutUrl': 'https://checkout.test/p1',
        });
      });
      final api = ApiClient(fakeDio(adapter));
      final json = await caller.run<Map<String, dynamic>>(
        'checkout:tx1:q1',
        (String key) => api.post('/transactions/tx1/checkout', body: <String, dynamic>{'quoteId': 'q1'}, idempotencyKey: key),
      );
      expect(json['paymentId'], 'p1');
      expect(adapter.requests, hasLength(3));
      final sent = adapter.requests.map((RequestOptions r) => r.headers[ApiClient.idempotencyHeader]).toSet();
      expect(sent, <Object?>{'key-1'});
    });

    test('a 4xx business error is not retried', () async {
      final adapter = FakeAdapter((RequestOptions o, int i) => FakeReply(409, errorBody('QUOTE_EXPIRED')));
      final api = ApiClient(fakeDio(adapter));
      await expectLater(
        caller.run<Map<String, dynamic>>(
          'checkout:tx1:q1',
          (String key) => api.post('/transactions/tx1/checkout', idempotencyKey: key),
        ),
        throwsA(isA<ApiException>().having((ApiException e) => e.code, 'code', 'QUOTE_EXPIRED')),
      );
      expect(adapter.requests, hasLength(1));
    });
  });
}
