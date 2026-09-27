import 'package:uuid/uuid.dart';

import 'api_exception.dart';

/// One UUID v4 per *logical* financial action (e.g. "checkout of quote Q"), reused for every
/// retry of that action until the server gives a definitive answer. The API stores the key in
/// `idempotency_keys`, so a retried checkout can never create a second payment.
class IdempotencyKeys {
  IdempotencyKeys({String Function()? generator}) : _generate = generator ?? _uuidV4;

  static String _uuidV4() => const Uuid().v4();

  final String Function() _generate;
  final Map<String, String> _keys = <String, String>{};

  String keyFor(String scope) => _keys.putIfAbsent(scope, _generate);

  bool hasPending(String scope) => _keys.containsKey(scope);

  void release(String scope) => _keys.remove(scope);
}

/// Runs a financial mutation with an Idempotency-Key and retry-safe semantics:
/// * transport errors / 5xx / 429 / `IDEMPOTENCY_IN_PROGRESS` → retried with the **same** key
///   (bounded, linear back-off); if still failing, the key is kept so a manual "Coba lagi"
///   also reuses it;
/// * a definitive answer (2xx or business 4xx) releases the key — the next user attempt is a
///   new logical action with a new key.
class FinancialCaller {
  FinancialCaller(this.keys, {this.maxAttempts = 3, this.backoff = const Duration(milliseconds: 700)});

  final IdempotencyKeys keys;
  final int maxAttempts;
  final Duration backoff;

  Future<T> run<T>(String scope, Future<T> Function(String idempotencyKey) action) async {
    final key = keys.keyFor(scope);
    var attempt = 0;
    while (true) {
      attempt++;
      try {
        final result = await action(key);
        keys.release(scope);
        return result;
      } on ApiException catch (e) {
        if (e.isRetryable && attempt < maxAttempts) {
          if (backoff > Duration.zero) await Future<void>.delayed(backoff * attempt);
          continue;
        }
        if (!e.isRetryable) keys.release(scope);
        rethrow;
      }
    }
  }
}
