import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/widgets/badges.dart';

import '../helpers.dart';

void main() {
  final l10n = idStrings;

  testWidgets('KYC ladder shows all five levels with achieved / next / locked states', (WidgetTester tester) async {
    usePhoneSurface(tester);
    await tester.pumpWidget(harness(const KycLadder(currentLevel: 2)));
    await tester.pump();

    for (final name in <String>[l10n.kycLevel1, l10n.kycLevel2, l10n.kycLevel3, l10n.kycLevel4, l10n.kycLevel5]) {
      expect(find.text(name), findsOneWidget);
    }
    expect(find.text(l10n.kycLadderAchieved), findsNWidgets(2));
    expect(find.text(l10n.kycLadderNext), findsOneWidget);
    expect(find.text(l10n.kycLadderLocked), findsNWidgets(2));
    // Achieved levels get a check mark; others show their number.
    expect(find.byIcon(Icons.check), findsNWidgets(2));
    expect(find.text('3'), findsOneWidget);
    expect(find.text(l10n.kycBenefit3), findsOneWidget);

    // Levels are listed from 1 to 5.
    final y1 = tester.getTopLeft(find.text(l10n.kycLevel1)).dy;
    final y5 = tester.getTopLeft(find.text(l10n.kycLevel5)).dy;
    expect(y5, greaterThan(y1));
  });

  testWidgets('each rung is announced as one sentence for screen readers', (WidgetTester tester) async {
    usePhoneSurface(tester);
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(harness(const KycLadder(currentLevel: 3)));
    await tester.pump();
    expect(
      find.bySemanticsLabel(l10n.kycLadderSemantics(4, l10n.kycLevel4, l10n.kycLadderNext)),
      findsOneWidget,
    );
    handle.dispose();
  });

  testWidgets('KYC level badge', (WidgetTester tester) async {
    usePhoneSurface(tester);
    await tester.pumpWidget(harness(const KycLevelBadge(level: 3)));
    await tester.pump();
    expect(find.text(l10n.kycLevelShort(3)), findsOneWidget);
  });
}
