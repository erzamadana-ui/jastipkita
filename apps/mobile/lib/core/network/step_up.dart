import '../models/json.dart';
import 'api_exception.dart';

/// SEC-12 step-up OTP for changes to where money goes (identity.md §3.1): setting a refund
/// destination, adding a payout account, switching the default payout account.
///
/// Flow: the protected call is made without proof → `403 STEP_UP_REQUIRED {purpose, action,
/// targetId}` → the user requests a `SENSITIVE_ACTION` OTP for exactly that action + target (sent
/// only to a verified phone / e-mail, valid 10 min) → the call is repeated once with
/// `stepUp: {challengeId, code}`. The server verifies and consumes the code *before* the action,
/// so a proof is never sent twice (see [StepUpProof.take]).
abstract final class SensitiveAction {
  static const String purpose = 'SENSITIVE_ACTION';
  static const String refundDestinationSet = 'REFUND_DESTINATION_SET';
  static const String payoutAccountAdd = 'PAYOUT_ACCOUNT_ADD';
  static const String payoutAccountSetDefault = 'PAYOUT_ACCOUNT_SET_DEFAULT';
}

/// What the server asked for in `403 STEP_UP_REQUIRED`.
class StepUpRequest {
  const StepUpRequest({required this.action, required this.targetId});

  final String action;
  final String targetId;

  static const String requiredCode = 'STEP_UP_REQUIRED';
  static const String mismatchCode = 'STEP_UP_MISMATCH';

  /// `{action, targetId}` from a `403 STEP_UP_REQUIRED`, or [fallback] when the details are
  /// missing; null for every other error.
  static StepUpRequest? fromError(Object error, {StepUpRequest? fallback}) {
    if (error is! ApiException || error.code != requiredCode) return null;
    final action = readStringOrNull(error.details, 'action');
    final targetId = readStringOrNull(error.details, 'targetId');
    if (action == null || action.isEmpty || targetId == null || targetId.isEmpty) return fallback;
    return StepUpRequest(action: action, targetId: targetId);
  }

  @override
  bool operator ==(Object other) => other is StepUpRequest && other.action == action && other.targetId == targetId;

  @override
  int get hashCode => Object.hash(action, targetId);
}

/// `StepUpProof {challengeId, code}` — single use.
class StepUpProof {
  StepUpProof({required this.challengeId, required this.code});

  final String challengeId;
  final String code;
  bool _spent = false;

  bool get isSpent => _spent;

  /// The `stepUp` body value. Marks the proof spent: the API consumes the code on the first
  /// request even when the action itself then fails, so sending it again is a client bug.
  Json take() {
    if (_spent) throw StateError('Step-up proof for challenge $challengeId was already sent; request a new code.');
    _spent = true;
    return <String, dynamic>{'challengeId': challengeId, 'code': code};
  }
}

/// The user closed the step-up sheet without finishing; callers stay where they are, silently.
class StepUpCancelled implements Exception {
  const StepUpCancelled();

  @override
  String toString() => 'StepUpCancelled';
}

/// Asks the user for a code for [request] and calls [submit] with a fresh proof (possibly more than
/// once, e.g. after a mistyped code — every call gets a new, unused proof). Completes with
/// [submit]'s result, rethrows its non-OTP errors, and throws [StepUpCancelled] when dismissed.
/// The app implementation is the bottom sheet in `features/auth/presentation/step_up_sheet.dart`.
typedef StepUpPrompt = Future<T> Function<T>(StepUpRequest request, Future<T> Function(StepUpProof proof) submit);

/// Runs [call] without proof first; on `403 STEP_UP_REQUIRED` hands the server's
/// `{action, targetId}` to [prompt], which retries [call] with a proof. The first call is made
/// without a code so that checks the server runs before the step-up (duplicate account, "already
/// default", validation) answer without spending an OTP.
Future<T> withStepUp<T>(
  Future<T> Function(StepUpProof? proof) call, {
  required StepUpPrompt prompt,
  StepUpRequest? expected,
}) async {
  try {
    return await call(null);
  } on ApiException catch (e) {
    final request = StepUpRequest.fromError(e, fallback: expected);
    if (request == null) rethrow;
    return prompt<T>(request, (StepUpProof proof) => call(proof));
  }
}
