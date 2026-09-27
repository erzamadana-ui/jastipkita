import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/core/domain/domain.dart';
import 'package:jastipkita/core/models/transaction.dart';
import 'package:jastipkita/widgets/safepay_status_banner.dart';

import '../fixtures.dart';
import '../helpers.dart';

void main() {
  final l10n = idStrings;

  testWidgets('traveler at PAYMENT_SECURED sees the red DO NOT PURCHASE banner', (WidgetTester tester) async {
    usePhoneSurface(tester);
    await tester.pumpWidget(harness(SafePayStatusBanner.forTraveler(status: TxStatus.paymentSecured)));
    await tester.pump();

    expect(find.text(l10n.safepayBlockedTitle), findsOneWidget);
    expect(find.text(l10n.safepayBlockedConfirmPrice), findsOneWidget);
    expect(find.text(l10n.safepayBlockedRule), findsOneWidget);
    expect(find.text(l10n.safepayApprovedTitle), findsNothing);
    // Funds being secured is NOT permission to buy.
    expect(find.text(l10n.safepaySecuredTitle), findsNothing);
  });

  testWidgets('traveler at PRICE_CHANGE_PENDING is still blocked, waiting for the buyer', (WidgetTester tester) async {
    usePhoneSurface(tester);
    await tester.pumpWidget(harness(SafePayStatusBanner.forTraveler(status: TxStatus.priceChangePending)));
    await tester.pump();
    expect(find.text(l10n.safepayBlockedTitle), findsOneWidget);
    expect(find.text(l10n.safepayBlockedAwaitingBuyer), findsOneWidget);
  });

  testWidgets('only PURCHASE_APPROVED shows the green approval with the ceiling', (WidgetTester tester) async {
    usePhoneSurface(tester);
    await tester.pumpWidget(
      harness(SafePayStatusBanner.forTraveler(status: TxStatus.purchaseApproved, approvedCeiling: '¥12.000')),
    );
    await tester.pump();
    expect(find.text(l10n.safepayApprovedTitle), findsOneWidget);
    expect(find.text(l10n.safepayApprovedBodyWithMax('¥12.000')), findsOneWidget);
    expect(find.text(l10n.safepayBlockedTitle), findsNothing);
  });

  test('traveler banner variant for every one of the 19 statuses', () {
    expect(TxStatus.all, hasLength(19));
    for (final status in TxStatus.all) {
      final variant = SafePayStatusBanner.travelerVariant(status);
      if (status == TxStatus.purchaseApproved) {
        expect(variant, SafePayVariant.approved, reason: status);
      } else {
        expect(variant, isNot(SafePayVariant.approved), reason: '$status must never look like permission to buy');
      }
      if (TxStatus.prePurchase.contains(status)) expect(variant, SafePayVariant.blocked, reason: status);
    }
    expect(SafePayStatusBanner.travelerVariant(TxStatus.completed), SafePayVariant.closed);
    expect(SafePayStatusBanner.travelerVariant(TxStatus.refundPending), SafePayVariant.closed);
    expect(SafePayStatusBanner.travelerVariant(TxStatus.traveling), SafePayVariant.secured);
  });

  test('buyer banner: pending while awaiting payment, secured while SafePay holds the funds', () {
    expect(SafePayStatusBanner.buyerVariant(TxStatus.awaitingPayment), SafePayVariant.pending);
    expect(SafePayStatusBanner.buyerVariant(TxStatus.paymentSecured), SafePayVariant.secured);
    expect(SafePayStatusBanner.buyerVariant(TxStatus.delivered), SafePayVariant.secured);
    expect(SafePayStatusBanner.buyerVariant(TxStatus.matched), isNull);
    expect(SafePayStatusBanner.buyerVariant(TxStatus.completed), isNull);
  });

  testWidgets('buyer at PAYMENT_SECURED sees the green secured banner', (WidgetTester tester) async {
    usePhoneSurface(tester);
    await tester.pumpWidget(harness(SafePayStatusBanner(variant: SafePayStatusBanner.buyerVariant(TxStatus.paymentSecured)!)));
    await tester.pump();
    expect(find.text(l10n.safepaySecuredTitle), findsOneWidget);
    expect(find.text(l10n.safepaySecuredBody), findsOneWidget);
  });

  testWidgets('purchase button is enabled ONLY in PURCHASE_APPROVED', (WidgetTester tester) async {
    usePhoneSurface(tester);
    final approvedGate = PurchaseGate.fromJson(purchaseGateJson(canPurchase: true));
    for (final status in TxStatus.all) {
      await tester.pumpWidget(harness(PurchaseGateButton(status: status, gate: approvedGate, onUploadProof: () {})));
      await tester.pump();
      final button = tester.widget<FilledButton>(find.byType(FilledButton));
      if (status == TxStatus.purchaseApproved) {
        expect(button.onPressed, isNotNull, reason: status);
        expect(find.text(l10n.purchaseGateDisabledReason), findsNothing);
      } else {
        expect(button.onPressed, isNull, reason: '$status must not allow purchasing');
        expect(find.text(l10n.purchaseGateDisabledReason), findsOneWidget, reason: status);
      }
    }
  });

  testWidgets('a server gate that says no disables the button even in PURCHASE_APPROVED', (WidgetTester tester) async {
    usePhoneSurface(tester);
    final closedGate = PurchaseGate.fromJson(purchaseGateJson(canPurchase: false));
    await tester.pumpWidget(harness(PurchaseGateButton(status: TxStatus.purchaseApproved, gate: closedGate, onUploadProof: () {})));
    await tester.pump();
    expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNull);
    expect(PurchaseGateButton.allowed(TxStatus.purchaseApproved, closedGate), isFalse);
    expect(PurchaseGateButton.allowed(TxStatus.purchaseApproved, null), isTrue);
    expect(PurchaseGateButton.allowed(TxStatus.paymentSecured, null), isFalse);
  });

  testWidgets('tapping the enabled button opens the proof flow', (WidgetTester tester) async {
    usePhoneSurface(tester);
    var opened = 0;
    await tester.pumpWidget(
      harness(PurchaseGateButton(status: TxStatus.purchaseApproved, onUploadProof: () {
        opened++;
      })),
    );
    await tester.pump();
    await tester.tap(find.text(l10n.uploadPurchaseProof));
    expect(opened, 1);
  });
}
