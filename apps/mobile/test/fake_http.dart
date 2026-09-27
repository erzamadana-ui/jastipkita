import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

/// A scripted reply for [FakeAdapter].
class FakeReply {
  const FakeReply(this.status, [this.body, this.delay = Duration.zero]);

  /// Simulates a dropped connection (no response at all).
  const FakeReply.networkError([this.delay = Duration.zero])
      : status = -1,
        body = null;

  final int status;
  final Object? body;
  final Duration delay;
}

/// In-memory [HttpClientAdapter]: records every request and answers from [handler].
class FakeAdapter implements HttpClientAdapter {
  FakeAdapter(this.handler);

  final FakeReply Function(RequestOptions options, int callIndex) handler;
  final List<RequestOptions> requests = <RequestOptions>[];

  List<RequestOptions> requestsTo(String path) => requests.where((RequestOptions r) => r.path == path).toList();

  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<Uint8List>? requestStream, Future<void>? cancelFuture) async {
    final index = requests.length;
    requests.add(options);
    final reply = handler(options, index);
    if (reply.delay > Duration.zero) await Future<void>.delayed(reply.delay);
    if (reply.status < 0) {
      throw DioException(requestOptions: options, type: DioExceptionType.connectionError, message: 'connection reset');
    }
    return ResponseBody.fromString(
      jsonEncode(reply.body ?? <String, dynamic>{}),
      reply.status,
      headers: <String, List<String>>{
        Headers.contentTypeHeader: <String>[Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

Map<String, dynamic> errorBody(String code, [String message = '']) => <String, dynamic>{
      'error': <String, dynamic>{'code': code, 'message': message, 'details': <String, dynamic>{}, 'requestId': 'req_test'},
    };

Dio fakeDio(FakeAdapter adapter) {
  final dio = Dio(BaseOptions(baseUrl: 'https://api.test/v1', responseType: ResponseType.json));
  dio.httpClientAdapter = adapter;
  return dio;
}
