import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/core/network/api_client.dart';
import 'package:jastipkita/core/network/api_exception.dart';
import 'package:jastipkita/core/network/auth_interceptor.dart';
import 'package:jastipkita/core/storage/token_storage.dart';

import '../fake_http.dart';

AuthTokens _tokens(String access, String refresh, {DateTime? accessExpiresAt}) => AuthTokens(
      accessToken: access,
      refreshToken: refresh,
      accessTokenExpiresAt: accessExpiresAt ?? DateTime.utc(2099),
      refreshTokenExpiresAt: DateTime.utc(2099),
      sessionId: 's1',
    );

Map<String, dynamic> _refreshBody(String access, String refresh) => <String, dynamic>{
      'tokens': <String, dynamic>{
        'tokenType': 'Bearer',
        'accessToken': access,
        'accessTokenExpiresAt': '2099-01-01T00:00:00.000Z',
        'refreshToken': refresh,
        'refreshTokenExpiresAt': '2099-01-31T00:00:00.000Z',
        'sessionId': 's1',
      },
    };

class _Harness {
  _Harness(FakeReply Function(RequestOptions o, int i) handler, AuthTokens initial) {
    adapter = FakeAdapter(handler);
    storage = MemoryTokenStorage(initial);
    store = TokenStore(storage);
    refresher = TokenRefresher(refreshDio: fakeDio(adapter), store: store);
    refresher.onSessionExpired = () => expiredCalls++;
    dio = fakeDio(adapter);
    dio.interceptors.add(AuthInterceptor(store: store, refresher: refresher, retryDio: dio));
    api = ApiClient(dio);
  }

  late final FakeAdapter adapter;
  late final MemoryTokenStorage storage;
  late final TokenStore store;
  late final TokenRefresher refresher;
  late final Dio dio;
  late final ApiClient api;
  int expiredCalls = 0;
}

void main() {
  test('concurrent 401s trigger exactly ONE refresh (single flight) and every request is replayed', () async {
    final h = _Harness((RequestOptions o, int i) {
      if (o.path == '/auth/refresh') {
        expect(o.data, <String, dynamic>{'refreshToken': 'refresh-1'});
        return FakeReply(200, _refreshBody('access-2', 'refresh-2'), const Duration(milliseconds: 20));
      }
      final auth = o.headers['Authorization'];
      if (auth != 'Bearer access-2') return FakeReply(401, errorBody('UNAUTHORIZED'));
      return FakeReply(200, <String, dynamic>{'path': o.path});
    }, _tokens('access-1', 'refresh-1'));

    final results = await Future.wait(<Future<Map<String, dynamic>>>[
      h.api.get('/me'),
      h.api.get('/notifications/unread-count'),
      h.api.get('/transactions'),
      h.api.get('/conversations'),
    ]);

    expect(results.map((Map<String, dynamic> r) => r['path']), <String>['/me', '/notifications/unread-count', '/transactions', '/conversations']);
    expect(h.adapter.requestsTo('/auth/refresh'), hasLength(1), reason: 'a rotated refresh token must never be reused');
    expect(h.refresher.rotations, 1);
    expect(h.store.current?.accessToken, 'access-2');
    expect((await h.storage.read())?.refreshToken, 'refresh-2');
    expect(h.expiredCalls, 0);
  });

  test('parallel refresh() calls share one in-flight rotation', () async {
    final h = _Harness(
      (RequestOptions o, int i) => FakeReply(200, _refreshBody('access-2', 'refresh-2'), const Duration(milliseconds: 20)),
      _tokens('access-1', 'refresh-1'),
    );
    final all = await Future.wait(<Future<AuthTokens?>>[h.refresher.refresh(), h.refresher.refresh(), h.refresher.refresh()]);
    expect(all.map((AuthTokens? t) => t?.accessToken).toSet(), <String?>{'access-2'});
    expect(h.adapter.requests, hasLength(1));
  });

  test('a request is replayed at most once (no refresh loop)', () async {
    final h = _Harness((RequestOptions o, int i) {
      if (o.path == '/auth/refresh') return FakeReply(200, _refreshBody('access-2', 'refresh-2'));
      return FakeReply(401, errorBody('UNAUTHORIZED'));
    }, _tokens('access-1', 'refresh-1'));

    await expectLater(h.api.get('/me'), throwsA(isA<ApiException>().having((ApiException e) => e.statusCode, 'status', 401)));
    expect(h.adapter.requestsTo('/me'), hasLength(2));
    expect(h.adapter.requestsTo('/auth/refresh'), hasLength(1));
  });

  test('a rejected refresh token ends the session', () async {
    final h = _Harness((RequestOptions o, int i) {
      if (o.path == '/auth/refresh') return FakeReply(401, errorBody('REFRESH_TOKEN_REUSED'));
      return FakeReply(401, errorBody('UNAUTHORIZED'));
    }, _tokens('access-1', 'refresh-1'));

    await expectLater(h.api.get('/me'), throwsA(isA<ApiException>()));
    expect(h.expiredCalls, 1);
    expect(h.store.current, isNull);
    expect(await h.storage.read(), isNull);
  });

  test('an access token about to expire is refreshed before the request is sent', () async {
    final h = _Harness((RequestOptions o, int i) {
      if (o.path == '/auth/refresh') return FakeReply(200, _refreshBody('access-2', 'refresh-2'));
      return FakeReply(200, <String, dynamic>{'auth': o.headers['Authorization']});
    }, _tokens('access-1', 'refresh-1', accessExpiresAt: DateTime.now().toUtc().add(const Duration(seconds: 5))));

    final json = await h.api.get('/me');
    expect(json['auth'], 'Bearer access-2');
    expect(h.adapter.requestsTo('/me'), hasLength(1));
  });

  test('offline refresh keeps the session (transport errors are not a logout)', () async {
    final h = _Harness((RequestOptions o, int i) {
      if (o.path == '/auth/refresh') return const FakeReply.networkError();
      return FakeReply(401, errorBody('UNAUTHORIZED'));
    }, _tokens('access-1', 'refresh-1'));

    await expectLater(h.api.get('/me'), throwsA(isA<ApiException>()));
    expect(h.expiredCalls, 0);
    expect(h.store.current?.refreshToken, 'refresh-1');
  });
}
