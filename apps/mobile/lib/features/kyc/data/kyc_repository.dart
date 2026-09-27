import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/account.dart';
import '../../../core/models/json.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/step_up.dart';

/// KYC levels, identity submission (level 3) and payout accounts (masked only).
class KycRepository {
  KycRepository(this._api);

  final ApiClient _api;

  Future<KycStatus> status() async => KycStatus.fromJson(await _api.get('/kyc/status'));

  /// Records the KYC consent (required before a submission).
  Future<void> grantKycConsent(String version) async {
    await _api.post('/me/consents', body: <String, dynamic>{'type': 'KYC', 'version': version, 'granted': true});
  }

  Future<KycSubmission> submit({
    required String idType,
    required String idNumber,
    required String fullName,
    required String dateOfBirth,
    required String idFrontFileId,
    required String selfieFileId,
    String? idBackFileId,
    List<String> livenessFileIds = const <String>[],
    String? nationality,
  }) async {
    final json = await _api.post(
      '/kyc/submissions',
      body: <String, dynamic>{
        'idType': idType,
        'idNumber': idNumber,
        'fullName': fullName,
        'dateOfBirth': dateOfBirth,
        if (nationality != null && nationality.isNotEmpty) 'nationality': nationality,
        'documents': <String, dynamic>{
          'idFront': idFrontFileId,
          if (idBackFileId != null) 'idBack': idBackFileId,
          'selfie': selfieFileId,
          // 1–5 liveness captures; every one is validated and forwarded to the KYC provider.
          if (livenessFileIds.isNotEmpty) 'livenessFileIds': livenessFileIds.take(5).toList(),
        },
      },
    );
    return KycSubmission.fromJson(readObject(json, 'submission'));
  }

  Future<List<PayoutAccount>> payoutAccounts() async =>
      readList(await _api.get('/kyc/payout-accounts'), 'data').map(PayoutAccount.fromJson).toList();

  /// The full account number is sent once over TLS; the API stores it encrypted and only ever
  /// returns the mask (`****0961`). The app does not keep it after this call.
  ///
  /// Needs a step-up OTP (`PAYOUT_ACCOUNT_ADD`, target = own user id) — [stepUp] shows the sheet
  /// when the API answers `403 STEP_UP_REQUIRED`. A holder name that differs from the verified
  /// identity comes back as `NAME_MISMATCH` ([PayoutAccount.isUnderReview]): stored for admin
  /// review, never default.
  Future<PayoutAccount> addPayoutAccount({
    required String bankCode,
    required String accountNumber,
    required String holderName,
    required StepUpPrompt stepUp,
    bool makeDefault = true,
  }) =>
      withStepUp<PayoutAccount>(
        (StepUpProof? proof) async => PayoutAccount.fromJson(
          await _api.post(
            '/kyc/payout-accounts',
            body: <String, dynamic>{
              'bankCode': bankCode,
              'accountNumber': accountNumber,
              'holderName': holderName,
              'makeDefault': makeDefault,
              if (proof != null) 'stepUp': proof.take(),
            },
          ),
        ),
        prompt: stepUp,
      );

  Future<void> removePayoutAccount(String id) async {
    await _api.delete('/kyc/payout-accounts/$id');
  }

  /// Switching the default needs a step-up OTP (`PAYOUT_ACCOUNT_SET_DEFAULT`, target = account id)
  /// unless the account already is the default.
  Future<PayoutAccount> makeDefault(String id, {required StepUpPrompt stepUp}) => withStepUp<PayoutAccount>(
        (StepUpProof? proof) async => PayoutAccount.fromJson(
          await _api.post(
            '/kyc/payout-accounts/$id/default',
            body: proof == null ? null : <String, dynamic>{'stepUp': proof.take()},
          ),
        ),
        prompt: stepUp,
        expected: StepUpRequest(action: SensitiveAction.payoutAccountSetDefault, targetId: id),
      );
}

final kycRepositoryProvider = Provider<KycRepository>((ref) => KycRepository(ref.watch(apiClientProvider)));

final kycStatusProvider = FutureProvider.autoDispose<KycStatus>((ref) => ref.watch(kycRepositoryProvider).status());

final payoutAccountsProvider = FutureProvider.autoDispose<List<PayoutAccount>>(
  (ref) => ref.watch(kycRepositoryProvider).payoutAccounts(),
);
