import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/core/l10n/l10n.dart';
import 'package:jastipkita/core/models/account.dart';
import 'package:jastipkita/core/models/transaction.dart';
import 'package:jastipkita/core/network/api_client.dart';
import 'package:jastipkita/core/network/api_exception.dart';
import 'package:jastipkita/core/network/idempotency.dart';
import 'package:jastipkita/core/network/step_up.dart';
import 'package:jastipkita/features/kyc/data/kyc_repository.dart';
import 'package:jastipkita/features/transactions/data/transaction_repository.dart';

import '../fake_http.dart';
import '../fixtures.dart';
import '../helpers.dart';

Map<String, dynamic> _stepUpRequired(String action, String targetId) =>
    errorBodyWith('STEP_UP_REQUIRED', <String, dynamic>{'purpose': 'SENSITIVE_ACTION', 'action': action, 'targetId': targetId});

Map<String, dynamic> _account({String status = 'VERIFIED', bool isDefault = true}) => <String, dynamic>{
      'id': 'acc-1',
      'bankCode': 'BCA',
      'accountMask': '****7890',
      'holderName': 'BUDI SANTOSO',
      'verificationStatus': status,
      'isDefault': isDefault,
      'verifiedAt': null,
      'createdAt': '2026-09-28T02:00:00.000Z',
    };

/// A scripted [StepUpPrompt]: records the request and answers with the next code.
class _FakePrompt {
  _FakePrompt(this.codes);

  final List<String> codes;
  final List<StepUpRequest> requests = <StepUpRequest>[];
  final List<StepUpProof> proofs = <StepUpProof>[];
  var _challenges = 0;

  Future<T> ask<T>(StepUpRequest request, Future<T> Function(StepUpProof proof) submit) {
    requests.add(request);
    _challenges++;
    final proof = StepUpProof(challengeId: 'ch-$_challenges', code: codes[proofs.length]);
    proofs.add(proof);
    return submit(proof);
  }
}

void main() {
  group('StepUpProof', () {
    test('is single use: take() marks it spent and a second take() throws', () {
      final proof = StepUpProof(challengeId: 'ch-1', code: '123456');
      expect(proof.take(), <String, dynamic>{'challengeId': 'ch-1', 'code': '123456'});
      expect(proof.isSpent, isTrue);
      expect(proof.take, throwsStateError);
    });

    test('StepUpRequest comes from 403 STEP_UP_REQUIRED details only', () {
      final e = ApiException.fromResponse(403, _stepUpRequired('REFUND_DESTINATION_SET', 'rf-1'));
      expect(StepUpRequest.fromError(e), const StepUpRequest(action: 'REFUND_DESTINATION_SET', targetId: 'rf-1'));
      expect(StepUpRequest.fromError(ApiException.fromResponse(403, errorBody('FORBIDDEN'))), isNull);
      const fallback = StepUpRequest(action: 'PAYOUT_ACCOUNT_SET_DEFAULT', targetId: 'acc-1');
      expect(StepUpRequest.fromError(ApiException.fromResponse(403, errorBody('STEP_UP_REQUIRED')), fallback: fallback), fallback);
    });
  });

  group('payout accounts (kyc_repository)', () {
    test('403 STEP_UP_REQUIRED → prompt → the retry carries stepUp and succeeds', () async {
      final adapter = FakeAdapter((RequestOptions o, int i) {
        final stepUp = sentBody(o)['stepUp'];
        if (stepUp == null) return FakeReply(403, _stepUpRequired('PAYOUT_ACCOUNT_ADD', 'user-1'));
        return FakeReply(201, _account());
      });
      final prompt = _FakePrompt(<String>['123456']);
      final account = await KycRepository(ApiClient(fakeDio(adapter))).addPayoutAccount(
        bankCode: 'BCA',
        accountNumber: '1234567890',
        holderName: 'Budi Santoso',
        stepUp: prompt.ask,
      );
      expect(account.isVerified, isTrue);
      expect(prompt.requests.single, const StepUpRequest(action: 'PAYOUT_ACCOUNT_ADD', targetId: 'user-1'));
      expect(adapter.requests, hasLength(2));
      expect(sentBody(adapter.requests[0]).containsKey('stepUp'), isFalse, reason: 'the first call never spends an OTP');
      expect(sentBody(adapter.requests[1])['stepUp'], <String, dynamic>{'challengeId': 'ch-1', 'code': '123456'});
      expect(sentBody(adapter.requests[1])['holderName'], 'Budi Santoso');
    });

    test('a consumed proof is never sent again: the next attempt starts without proof and gets a new code', () async {
      var protectedCalls = 0;
      final adapter = FakeAdapter((RequestOptions o, int i) {
        protectedCalls++;
        final stepUp = sentBody(o)['stepUp'];
        if (stepUp == null) return FakeReply(403, _stepUpRequired('PAYOUT_ACCOUNT_ADD', 'user-1'));
        // The server consumes the code first, then the bank inquiry fails on the first try.
        if ((stepUp as Map<String, dynamic>)['challengeId'] == 'ch-1') return FakeReply(422, errorBody('BANK_ACCOUNT_INVALID'));
        return FakeReply(201, _account());
      });
      final prompt = _FakePrompt(<String>['111111', '222222']);
      final repo = KycRepository(ApiClient(fakeDio(adapter)));
      await expectLater(
        repo.addPayoutAccount(bankCode: 'BCA', accountNumber: '1234567890', holderName: 'Budi Santoso', stepUp: prompt.ask),
        throwsA(isA<ApiException>().having((ApiException e) => e.code, 'code', 'BANK_ACCOUNT_INVALID')),
      );
      final account = await repo.addPayoutAccount(bankCode: 'BCA', accountNumber: '1234567899', holderName: 'Budi Santoso', stepUp: prompt.ask);
      expect(account.id, 'acc-1');
      expect(protectedCalls, 4);
      final proofsSent = adapter.requests.map((RequestOptions r) => sentBody(r)['stepUp']).whereType<Map<String, dynamic>>().toList();
      expect(proofsSent.map((Map<String, dynamic> p) => p['challengeId']).toList(), <String>['ch-1', 'ch-2']);
      expect(sentBody(adapter.requests[2]).containsKey('stepUp'), isFalse);
      expect(prompt.proofs.every((StepUpProof p) => p.isSpent), isTrue);
    });

    test('reusing a spent proof fails in the client before any request', () async {
      final adapter = FakeAdapter((RequestOptions o, int i) => FakeReply(403, _stepUpRequired('PAYOUT_ACCOUNT_ADD', 'user-1')));
      final spent = StepUpProof(challengeId: 'ch-9', code: '999999')..take();
      Future<T> replay<T>(StepUpRequest request, Future<T> Function(StepUpProof proof) submit) => submit(spent);
      await expectLater(
        KycRepository(ApiClient(fakeDio(adapter)))
            .addPayoutAccount(bankCode: 'BCA', accountNumber: '1234567890', holderName: 'Budi Santoso', stepUp: replay),
        throwsStateError,
      );
      expect(adapter.requests, hasLength(1), reason: 'only the proof-less first call reached the API');
    });

    test('other errors pass straight through without asking for a code', () async {
      final adapter = FakeAdapter((RequestOptions o, int i) => FakeReply(409, errorBody('PAYOUT_ACCOUNT_DUPLICATE')));
      final prompt = _FakePrompt(<String>['123456']);
      await expectLater(
        KycRepository(ApiClient(fakeDio(adapter)))
            .addPayoutAccount(bankCode: 'BCA', accountNumber: '1234567890', holderName: 'Budi Santoso', stepUp: prompt.ask),
        throwsA(isA<ApiException>()),
      );
      expect(prompt.requests, isEmpty);
    });

    test('holder name ≠ verified identity comes back NAME_MISMATCH: under review, never default', () async {
      final adapter = FakeAdapter((RequestOptions o, int i) {
        if (sentBody(o)['stepUp'] == null) return FakeReply(403, _stepUpRequired('PAYOUT_ACCOUNT_ADD', 'user-1'));
        return FakeReply(201, _account(status: 'NAME_MISMATCH', isDefault: false));
      });
      final account = await KycRepository(ApiClient(fakeDio(adapter)))
          .addPayoutAccount(bankCode: 'BCA', accountNumber: '1234567890', holderName: 'Budi', stepUp: _FakePrompt(<String>['123456']).ask);
      expect(account.isUnderReview, isTrue);
      expect(account.isVerified, isFalse);
      expect(account.isDefault, isFalse);
    });

    test('make default: step-up bound to the account id; no body without proof', () async {
      final adapter = FakeAdapter((RequestOptions o, int i) {
        if (o.data == null) return FakeReply(403, errorBody('STEP_UP_REQUIRED'));
        return FakeReply(200, _account());
      });
      final prompt = _FakePrompt(<String>['123456']);
      await KycRepository(ApiClient(fakeDio(adapter))).makeDefault('acc-1', stepUp: prompt.ask);
      expect(adapter.requests.first.data, isNull);
      expect(prompt.requests.single, const StepUpRequest(action: 'PAYOUT_ACCOUNT_SET_DEFAULT', targetId: 'acc-1'));
      expect(sentBody(adapter.requests.last)['stepUp'], <String, dynamic>{'challengeId': 'ch-1', 'code': '123456'});
    });
  });

  group('refund destination (transaction_repository)', () {
    test('step-up bound to the refund id; PENDING_REVIEW is reported as under review', () async {
      final adapter = FakeAdapter((RequestOptions o, int i) {
        if (sentBody(o)['stepUp'] == null) return FakeReply(403, _stepUpRequired('REFUND_DESTINATION_SET', 'rf-1'));
        return const FakeReply(200, <String, dynamic>{
          'refundId': 'rf-1',
          'bankCode': 'BCA',
          'accountMask': '****7890',
          'validationStatus': 'PENDING_REVIEW',
          'reviewRequired': true,
          'validatedAt': null,
        });
      });
      final prompt = _FakePrompt(<String>['123456']);
      final repo = TransactionRepository(ApiClient(fakeDio(adapter)), FinancialCaller(IdempotencyKeys()));
      final result = await repo.setRefundDestination(
        'rf-1',
        bankCode: 'BCA',
        accountNumber: '1234567890',
        accountHolderName: 'Budi',
        stepUp: prompt.ask,
      );
      expect(result.reviewRequired, isTrue);
      expect(result.accountMask, '****7890');
      expect(prompt.requests.single, const StepUpRequest(action: 'REFUND_DESTINATION_SET', targetId: 'rf-1'));
      expect(adapter.requests.map((RequestOptions r) => r.path).toSet(), <String>{'/refunds/rf-1/destination'});
    });

    test('refund rows expose review / rejected destinations', () {
      Map<String, dynamic> refund(String? status) => <String, dynamic>{
            'id': 'rf-1',
            'status': 'PENDING',
            'amountIdr': 1250000,
            'method': 'PAYOUT_TO_BUYER',
            'destinationRequired': status == null,
            'destination': status == null ? null : <String, dynamic>{'bankCode': 'BCA', 'accountMask': '****7890', 'validationStatus': status},
          };
      expect(RefundInfo.fromJson(refund(null)).needsDestination, isTrue);
      expect(RefundInfo.fromJson(refund('PENDING_REVIEW')).destinationUnderReview, isTrue);
      expect(RefundInfo.fromJson(refund('PENDING_REVIEW')).needsDestination, isFalse);
      expect(RefundInfo.fromJson(refund('REJECTED')).needsDestination, isTrue, reason: 'FINANCE rejected it: ask again');
      expect(RefundInfo.fromJson(refund('VALID')).needsDestination, isFalse);
    });
  });

  group('purchase ceiling', () {
    test('prefers purchaseCeilingMinor, falls back to the deprecated purchaseCeiling.minor', () {
      final json = transactionDetailJson()..['purchaseCeilingMinor'] = 10500;
      expect(TransactionDetail.fromJson(json).purchaseCeilingMinor, 10500);
      final legacy = transactionDetailJson()..remove('purchaseCeilingMinor');
      expect(TransactionDetail.fromJson(legacy).purchaseCeilingMinor, 11000);
    });
  });

  group('friendly messages', () {
    final AppLocalizations l10n = idStrings;

    test('trip no longer available on quote / checkout', () {
      final cancelled = ApiException.fromResponse(422, errorBodyWith('TRIP_NOT_AVAILABLE', <String, dynamic>{'tripStatus': 'CANCELLED'}));
      final completed = ApiException.fromResponse(422, errorBodyWith('TRIP_NOT_AVAILABLE', <String, dynamic>{'tripStatus': 'COMPLETED'}));
      expect(errorMessage(l10n, cancelled), l10n.tripNotAvailableCancelled);
      expect(errorMessage(l10n, completed), l10n.tripNotAvailableCompleted);
    });

    test('trip cancel refused once goods were bought', () {
      final e = ApiException.fromResponse(
        409,
        errorBodyWith('TRIP_HAS_PURCHASED_TRANSACTIONS', <String, dynamic>{
          'transactionIds': <String>['tx-1', 'tx-2'],
        }),
      );
      expect(errorMessage(l10n, e), l10n.tripHasPurchasedBody(2));
    });

    test('step-up errors and cancellation', () {
      expect(errorMessage(l10n, const StepUpCancelled()), l10n.stepUpCancelled);
      expect(errorMessage(l10n, ApiException.fromResponse(403, errorBody('STEP_UP_MISMATCH', 'raw'))), l10n.stepUpMismatch);
      expect(
        errorMessage(l10n, ApiException.fromResponse(422, errorBody('STEP_UP_DESTINATION_NOT_VERIFIED', 'raw'))),
        l10n.stepUpDestinationNotVerified,
      );
    });

    test('PayoutAccount NAME_MISMATCH reads as under review', () {
      final a = PayoutAccount.fromJson(_account(status: 'NAME_MISMATCH', isDefault: false));
      expect(a.isUnderReview, isTrue);
      expect(l10n.payoutAccountNameMismatch, l10n.statusUnderReview);
    });
  });
}
