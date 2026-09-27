import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/core/models/account.dart';
import 'package:jastipkita/core/network/api_client.dart';
import 'package:jastipkita/core/network/api_exception.dart';
import 'package:jastipkita/core/network/step_up.dart';
import 'package:jastipkita/core/storage/settings.dart';
import 'package:jastipkita/core/storage/token_storage.dart';
import 'package:jastipkita/features/auth/application/session_controller.dart';
import 'package:jastipkita/features/auth/presentation/step_up_sheet.dart';
import 'package:jastipkita/features/kyc/data/kyc_repository.dart';
import 'package:jastipkita/widgets/sheets_and_glass.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../fake_http.dart';
import '../helpers.dart';

const Profile _traveler = Profile(
  id: 'user-1',
  kycLevel: 3,
  activeMode: 'TRAVELER',
  trustScore: 80,
  locale: 'id',
  phone: '+6281234567890',
  phoneVerified: true,
  email: 'budi@example.com',
  emailVerified: true,
);

Map<String, dynamic> _account() => <String, dynamic>{
      'id': 'acc-1',
      'bankCode': 'BCA',
      'accountMask': '****7890',
      'holderName': 'BUDI SANTOSO',
      'verificationStatus': 'VERIFIED',
      'isDefault': true,
      'verifiedAt': '2026-09-28T02:00:00.000Z',
      'createdAt': '2026-09-28T02:00:00.000Z',
    };

/// Fake API: `/kyc/payout-accounts` asks for a step-up until a proof arrives, then answers with
/// [onProof]; `/auth/otp/request` issues `ch-1`, `ch-2`, … (dev code echoed like non-production).
class _Api {
  _Api(this.onProof) {
    adapter = FakeAdapter((RequestOptions o, int i) {
      final body = sentBody(o);
      if (o.path == '/auth/otp/request') {
        otpRequests.add(body);
        return FakeReply(200, <String, dynamic>{
          'challengeId': 'ch-${otpRequests.length}',
          'expiresAt': '2099-01-01T00:10:00.000Z',
          'resendAvailableAt': '2000-01-01T00:00:00.000Z',
          'devCode': '123456',
        });
      }
      final stepUp = body['stepUp'];
      if (stepUp == null) {
        return FakeReply(
          403,
          errorBodyWith('STEP_UP_REQUIRED', <String, dynamic>{'purpose': 'SENSITIVE_ACTION', 'action': 'PAYOUT_ACCOUNT_ADD', 'targetId': 'user-1'}),
        );
      }
      final proof = Map<String, dynamic>.from(stepUp as Map);
      proofs.add(proof);
      return onProof(proof);
    });
  }

  final FakeReply Function(Map<String, dynamic> proof) onProof;
  late final FakeAdapter adapter;
  final List<Map<String, dynamic>> otpRequests = <Map<String, dynamic>>[];
  final List<Map<String, dynamic>> proofs = <Map<String, dynamic>>[];

  List<RequestOptions> get protectedCalls => adapter.requestsTo('/kyc/payout-accounts');
}

/// A button that adds a payout account the way the payout screen does and logs the outcome.
class _AddAccountButton extends ConsumerWidget {
  const _AddAccountButton(this.log);

  final List<String> log;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ElevatedButton(
      onPressed: () async {
        try {
          final account = await ref.read(kycRepositoryProvider).addPayoutAccount(
                bankCode: 'BCA',
                accountNumber: '1234567890',
                holderName: 'Budi Santoso',
                stepUp: stepUpPrompt(context),
              );
          log.add('added ${account.accountMask}');
        } on StepUpCancelled {
          log.add('cancelled');
        } on ApiException catch (e) {
          log.add('error ${e.code}');
        }
      },
      child: const Text('Tambah'),
    );
  }
}

void main() {
  final l10n = idStrings;
  final codeField = find.descendant(of: find.byType(OtpField), matching: find.byType(TextField));

  Future<List<String>> openSheet(WidgetTester tester, _Api api) async {
    usePhoneSurface(tester, height: 1200);
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final prefs = await SharedPreferences.getInstance();
    final log = <String>[];
    await tester.pumpWidget(
      ProviderScope(
        overrides: <Override>[
          sharedPreferencesProvider.overrideWithValue(prefs),
          tokenStorageProvider.overrideWithValue(MemoryTokenStorage()),
          apiClientProvider.overrideWithValue(ApiClient(fakeDio(api.adapter))),
          currentProfileProvider.overrideWithValue(_traveler),
        ],
        child: harness(_AddAccountButton(log)),
      ),
    );
    await tester.tap(find.text('Tambah'));
    await tester.pumpAndSettle();
    return log;
  }

  Future<void> sendCode(WidgetTester tester) async {
    await tester.tap(find.text(l10n.loginSendCode));
    await tester.pumpAndSettle();
  }

  Future<void> typeCode(WidgetTester tester, String code) async {
    await tester.enterText(codeField, code);
    await tester.pumpAndSettle();
  }

  testWidgets('403 STEP_UP_REQUIRED → sheet → OTP bound to action + target → retry with proof succeeds', (WidgetTester tester) async {
    final api = _Api((Map<String, dynamic> proof) => FakeReply(201, _account()));
    final log = await openSheet(tester, api);

    expect(find.text(l10n.stepUpTitle), findsOneWidget);
    expect(find.text(l10n.stepUpIntroPayoutAdd), findsOneWidget);
    // Only verified contacts are offered, masked.
    expect(find.text(l10n.stepUpDestinationOption('WhatsApp', '+6281••••7890')), findsOneWidget);
    expect(find.text(l10n.stepUpDestinationOption(l10n.stepUpChannelEmail, 'bu•••@example.com')), findsOneWidget);

    await sendCode(tester);
    expect(api.otpRequests.single, <String, dynamic>{
      'channel': 'WHATSAPP',
      'destination': '+6281234567890',
      'purpose': 'SENSITIVE_ACTION',
      'action': 'PAYOUT_ACCOUNT_ADD',
      'targetId': 'user-1',
      'locale': 'id',
    });
    expect(find.text(l10n.stepUpExpiryNote), findsOneWidget);

    await typeCode(tester, '123456');
    expect(api.proofs.single, <String, dynamic>{'challengeId': 'ch-1', 'code': '123456'});
    expect(api.protectedCalls, hasLength(2));
    expect(find.text(l10n.stepUpTitle), findsNothing, reason: 'the sheet closes on success');
    expect(log, <String>['added ****7890']);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a wrong code keeps the sheet open; the same code is never sent twice', (WidgetTester tester) async {
    final api = _Api(
      (Map<String, dynamic> proof) => proof['code'] == '654321'
          ? FakeReply(201, _account())
          : FakeReply(400, errorBodyWith('OTP_INVALID', <String, dynamic>{'remainingAttempts': 4})),
    );
    final log = await openSheet(tester, api);
    await sendCode(tester);

    await typeCode(tester, '123456');
    expect(find.text(l10n.stepUpAttemptsLeft(4)), findsOneWidget);
    expect(log, isEmpty);

    await typeCode(tester, '123456');
    expect(find.text(l10n.stepUpCodeUsed), findsOneWidget);
    expect(api.proofs, hasLength(1), reason: 'an already-tried challenge/code pair is not sent again');

    await typeCode(tester, '654321');
    expect(api.proofs.map((Map<String, dynamic> p) => '${p['challengeId']}:${p['code']}').toList(), <String>['ch-1:123456', 'ch-1:654321']);
    expect(log, <String>['added ****7890']);
  });

  testWidgets('an error after the code was consumed closes the sheet; the next try needs a new code', (WidgetTester tester) async {
    final api = _Api(
      (Map<String, dynamic> proof) =>
          proof['challengeId'] == 'ch-1' ? FakeReply(422, errorBody('BANK_ACCOUNT_INVALID')) : FakeReply(201, _account()),
    );
    final log = await openSheet(tester, api);
    await sendCode(tester);
    await typeCode(tester, '123456');
    expect(log, <String>['error BANK_ACCOUNT_INVALID']);
    expect(find.text(l10n.stepUpTitle), findsNothing);

    // Second attempt: starts without proof, gets a fresh challenge, never replays ch-1.
    await tester.tap(find.text('Tambah'));
    await tester.pumpAndSettle();
    await sendCode(tester);
    await typeCode(tester, '123456');
    expect(api.proofs.map((Map<String, dynamic> p) => p['challengeId']).toList(), <String>['ch-1', 'ch-2']);
    expect(sentBody(api.protectedCalls[2]).containsKey('stepUp'), isFalse);
    expect(log.last, 'added ****7890');
  });

  testWidgets('closing the sheet cancels quietly and sends nothing else', (WidgetTester tester) async {
    final api = _Api((Map<String, dynamic> proof) => FakeReply(201, _account()));
    final log = await openSheet(tester, api);
    await tester.tapAt(const Offset(20, 20)); // modal barrier above the sheet
    await tester.pumpAndSettle();
    expect(log, <String>['cancelled']);
    expect(api.protectedCalls, hasLength(1));
    expect(api.otpRequests, isEmpty);
  });

  test('stepUpDestinations offers verified contacts only', () {
    const unverified = Profile(
      id: 'u',
      kycLevel: 1,
      activeMode: 'BUYER',
      trustScore: 0,
      locale: 'id',
      phone: '+6281234567890',
      email: 'a@b.co',
    );
    expect(stepUpDestinations(unverified), isEmpty);
    expect(stepUpDestinations(_traveler).map((StepUpDestination d) => d.channel).toList(), <String>['WHATSAPP', 'SMS', 'EMAIL']);
    expect(maskContact('+6281234567890'), '+6281••••7890');
    expect(maskContact('budi@example.com'), 'bu•••@example.com');
  });
}
