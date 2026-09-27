import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/core/domain/domain.dart';
import 'package:jastipkita/core/models/transaction.dart';
import 'package:jastipkita/widgets/price_breakdown_card.dart';

import '../fixtures.dart';
import '../helpers.dart';

Finder _row(String type) => find.byKey(ValueKey<String>('price-line-$type'));

List<PriceLine> _lines([List<Map<String, dynamic>>? json]) => (json ?? priceLinesJson()).map(PriceLine.fromJson).toList();

void main() {
  testWidgets('shows all 11 lines in the fixed §10 order, ending with the total', (WidgetTester tester) async {
    usePhoneSurface(tester, width: 420);
    await tester.pumpWidget(harness(PriceBreakdownCard(lines: _lines())));
    await tester.pump();

    final rows = PriceLineType.order.map(_row).toList();
    expect(rows, hasLength(11));
    for (final row in rows) {
      expect(row, findsOneWidget);
    }
    final tops = <double>[for (final row in rows) tester.getTopLeft(row).dy];
    for (var i = 1; i < tops.length; i++) {
      expect(tops[i], greaterThan(tops[i - 1]), reason: '${PriceLineType.order[i]} must come after ${PriceLineType.order[i - 1]}');
    }

    final l10n = idStrings;
    expect(find.descendant(of: _row(PriceLineType.itemPrice), matching: find.text(l10n.priceLineItemPrice)), findsOneWidget);
    expect(find.descendant(of: _row(PriceLineType.total), matching: find.text('Rp1.364.390')), findsOneWidget);
    // Reductions are shown with a true minus sign.
    expect(find.descendant(of: _row(PriceLineType.discount), matching: find.text('−Rp25.000')), findsOneWidget);
    expect(find.descendant(of: _row(PriceLineType.referralCredit), matching: find.text('−Rp10.000')), findsOneWidget);
    // Customs lines carry the ESTIMASI badge.
    expect(find.descendant(of: _row(PriceLineType.customsDuty), matching: find.text(l10n.estimateBadge)), findsOneWidget);
    expect(find.descendant(of: _row(PriceLineType.importTax), matching: find.text(l10n.estimateBadge)), findsOneWidget);
    expect(find.text(l10n.breakdownAllFeesShown), findsOneWidget);
  });

  testWidgets('order does not depend on the order the API sent', (WidgetTester tester) async {
    usePhoneSurface(tester, width: 420);
    final l = priceLinesJson();
    final shuffled = <Map<String, dynamic>>[l[10], l[3], l[0], l[8], l[5], l[1], l[9], l[7], l[2], l[6], l[4]];
    await tester.pumpWidget(harness(PriceBreakdownCard(lines: _lines(shuffled))));
    await tester.pump();

    final tops = <double>[for (final type in PriceLineType.order) tester.getTopLeft(_row(type)).dy];
    final sorted = List<double>.of(tops)..sort();
    expect(tops, sorted);
  });

  testWidgets('empty reductions are hidden; lines 1–8 always show, even when Rp0', (WidgetTester tester) async {
    usePhoneSurface(tester, width: 420);
    final json = priceLinesJson()
        .map((Map<String, dynamic> line) => <String, dynamic>{
              ...line,
              if (line['type'] == 'DISCOUNT' || line['type'] == 'REFERRAL_CREDIT' || line['type'] == 'PAYMENT_FEE') 'amountIdr': 0,
              if (line['type'] == 'TOTAL') 'amountIdr': 1399390 - 4440,
            })
        .toList();
    await tester.pumpWidget(harness(PriceBreakdownCard(lines: _lines(json))));
    await tester.pump();

    expect(_row(PriceLineType.discount), findsNothing);
    expect(_row(PriceLineType.referralCredit), findsNothing);
    expect(_row(PriceLineType.paymentFee), findsOneWidget);
    expect(find.descendant(of: _row(PriceLineType.paymentFee), matching: find.text(idStrings.priceLineWaived)), findsOneWidget);
    expect(PriceBreakdownCard.visibleLines(_lines(json)), hasLength(9));
  });

  test('a missing TOTAL line is computed from the visible lines', () {
    final withoutTotal = priceLinesJson().where((Map<String, dynamic> l) => l['type'] != 'TOTAL').toList();
    final visible = PriceBreakdownCard.visibleLines(_lines(withoutTotal));
    expect(visible.last.type, PriceLineType.total);
    expect(visible.last.amountIdr, fixtureTotalIdr);
  });

  testWidgets('compact mode shows the total and the line count', (WidgetTester tester) async {
    usePhoneSurface(tester, width: 420);
    await tester.pumpWidget(harness(PriceBreakdownCard(lines: _lines(), compact: true, onExpand: () {})));
    await tester.pump();
    expect(find.text('Rp1.364.390'), findsOneWidget);
    expect(find.text(idStrings.breakdownShowLines(11)), findsOneWidget);
  });

  testWidgets('an expired quote asks to refresh the rate', (WidgetTester tester) async {
    usePhoneSurface(tester, width: 420);
    var refreshed = false;
    await tester.pumpWidget(harness(PriceBreakdownCard(lines: _lines(), expired: true, onRefresh: () {
      refreshed = true;
    })));
    await tester.pump();
    expect(find.text(idStrings.breakdownExpired), findsOneWidget);
    await tester.tap(find.text(idStrings.breakdownRefreshRate));
    expect(refreshed, isTrue);
  });
}
