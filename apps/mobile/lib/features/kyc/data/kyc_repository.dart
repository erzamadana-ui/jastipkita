import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/account.dart';
import '../../../core/models/json.dart';
import '../../../core/network/api_client.dart';

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
    String? livenessFileId,
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
          if (livenessFileId != null) 'liveness': livenessFileId,
        },
      },
    );
    return KycSubmission.fromJson(readObject(json, 'submission'));
  }

  Future<List<PayoutAccount>> payoutAccounts() async =>
      readList(await _api.get('/kyc/payout-accounts'), 'data').map(PayoutAccount.fromJson).toList();

  /// The full account number is sent once over TLS; the API stores it encrypted and only ever
  /// returns the mask (`****0961`). The app does not keep it after this call.
  Future<PayoutAccount> addPayoutAccount({
    required String bankCode,
    required String accountNumber,
    required String holderName,
    bool makeDefault = true,
  }) async =>
      PayoutAccount.fromJson(
        await _api.post(
          '/kyc/payout-accounts',
          body: <String, dynamic>{
            'bankCode': bankCode,
            'accountNumber': accountNumber,
            'holderName': holderName,
            'makeDefault': makeDefault,
          },
        ),
      );

  Future<void> removePayoutAccount(String id) async {
    await _api.delete('/kyc/payout-accounts/$id');
  }

  Future<PayoutAccount> makeDefault(String id) async =>
      PayoutAccount.fromJson(await _api.post('/kyc/payout-accounts/$id/default'));
}

final kycRepositoryProvider = Provider<KycRepository>((ref) => KycRepository(ref.watch(apiClientProvider)));

final kycStatusProvider = FutureProvider.autoDispose<KycStatus>((ref) => ref.watch(kycRepositoryProvider).status());

final payoutAccountsProvider = FutureProvider.autoDispose<List<PayoutAccount>>(
  (ref) => ref.watch(kycRepositoryProvider).payoutAccounts(),
);
