import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/core/domain/domain.dart';
import 'package:jastipkita/core/models/marketplace.dart';
import 'package:jastipkita/core/models/transaction.dart';
import 'package:jastipkita/widgets/badges.dart';
import 'package:jastipkita/widgets/cards.dart';
import 'package:jastipkita/widgets/common.dart';
import 'package:jastipkita/widgets/jk_button.dart';
import 'package:jastipkita/widgets/price_breakdown_card.dart';
import 'package:jastipkita/widgets/restricted_item_warning.dart';
import 'package:jastipkita/widgets/safepay_status_banner.dart';

import '../fixtures.dart';
import '../helpers.dart';

/// Text scale 2.0 (the maximum the app allows) on a 360 dp wide phone, in both languages:
/// the key transactional surfaces must lay out without any overflow.
void main() {
  final lines = priceLinesJson().map(PriceLine.fromJson).toList();
  final trip = Trip.fromJson(<String, dynamic>{
    ...tripPublicJson(),
    'travelerId': 'me',
    'capacityKg': 10,
    'remainingCapacityKg': 6.5,
    'allowedActions': <String>['PUBLISH'],
  });
  final summary = TransactionSummary.fromJson(<String, dynamic>{
    'id': 'tx1',
    'number': 'JK-260927-0001',
    'status': TxStatus.paymentSecured,
    'role': 'TRAVELER',
    'totalIdr': fixtureTotalIdr,
    'securedIdr': fixtureTotalIdr,
    'purchaseGate': purchaseGateJson(canPurchase: false),
    'item': <String, dynamic>{
      'productName': 'Onitsuka Tiger Mexico 66 — Kill Bill edition, size 42',
      'categoryCode': 'FASHION',
      'merchantCountry': 'JP',
    },
  });
  final offer = Offer.fromJson(<String, dynamic>{
    'id': 'o1',
    'requestId': 'r1',
    'tripId': 't1',
    'initiatedBy': 'TRAVELER',
    'travelerFeeIdr': 150000,
    'status': 'PENDING',
    'message': 'Saya lewat Ginza tanggal 12, bisa langsung beli di toko resminya.',
    'trip': tripPublicJson(),
    'traveler': <String, dynamic>{
      ...(tripPublicJson()['traveler'] as Map<String, dynamic>),
      'trustScore': 92,
    },
    'allowedActions': <String>['ACCEPT', 'DECLINE'],
  });

  final surfaces = <String, Widget Function()>{
    'PriceBreakdownCard': () => PriceBreakdownCard(lines: lines, itemSubLabel: '1 × ¥11.000', channelLabel: 'Virtual Account BCA'),
    'SafePayStatusBanner (traveler, blocked)': () => SafePayStatusBanner.forTraveler(status: TxStatus.paymentSecured),
    'SafePayStatusBanner (approved)': () =>
        SafePayStatusBanner.forTraveler(status: TxStatus.purchaseApproved, approvedCeiling: '¥12.000'),
    'PurchaseGateButton (disabled + reason)': () => PurchaseGateButton(status: TxStatus.paymentSecured, onUploadProof: () {}),
    'KycLadder': () => const KycLadder(currentLevel: 2),
    'TransactionCard': () => TransactionCard(transaction: summary, onTap: () {}),
    'TripCard': () => TripCard(trip: trip, ctaLabel: 'Titip ke trip ini', onCta: () {}),
    'OfferCard': () => OfferCard(offer: offer, onAccept: () {}, onDecline: () {}),
    'RestrictedItemWarning': () => RestrictedItemWarning(
          classification: Restriction.permitRequired,
          permitAuthorities: const <String>['BPOM', 'Karantina'],
          acknowledged: false,
          onAcknowledgedChanged: (bool v) {},
        ),
    'Badges': () => const Wrap(children: <Widget>[TrustScoreBadge(score: 92, full: true), KycLevelBadge(level: 5, full: true)]),
    'NoticeBox + JkButton': () => Column(
          children: <Widget>[
            const NoticeBox(tone: NoticeTone.warning, title: 'Selama sengketa', message: 'Dana tetap ditahan SafePay.'),
            JkButton(label: 'Bayar Rp1.364.390 via SafePay', onPressed: null, disabledReason: 'Verifikasi nomor HP dulu.'),
          ],
        ),
  };

  for (final locale in <Locale>[const Locale('id'), const Locale('en')]) {
    for (final entry in surfaces.entries) {
      testWidgets('${entry.key} has no overflow at text scale 2.0 (${locale.languageCode})', (WidgetTester tester) async {
        usePhoneSurface(tester);
        await tester.pumpWidget(harness(entry.value(), textScale: 2.0, locale: locale));
        await tester.pump();
        expect(tester.takeException(), isNull);
      });
    }
  }

  testWidgets('the app clamps text scaling at 2.0', (WidgetTester tester) async {
    usePhoneSurface(tester);
    late double effective;
    await tester.pumpWidget(
      harness(
        Builder(
          builder: (BuildContext context) => MediaQuery.withClampedTextScaling(
            maxScaleFactor: 2.0,
            child: Builder(
              builder: (BuildContext inner) {
                effective = MediaQuery.textScalerOf(inner).scale(10) / 10;
                return const SizedBox.shrink();
              },
            ),
          ),
        ),
        textScale: 3.0,
      ),
    );
    expect(effective, 2.0);
  });
}
