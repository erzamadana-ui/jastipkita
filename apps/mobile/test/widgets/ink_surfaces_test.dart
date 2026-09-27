import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/core/domain/domain.dart';
import 'package:jastipkita/core/network/api_client.dart';
import 'package:jastipkita/core/storage/settings.dart';
import 'package:jastipkita/core/storage/token_storage.dart';
import 'package:jastipkita/features/shell/presentation/main_shell.dart';
import 'package:jastipkita/features/transactions/presentation/transaction_detail_screen.dart';
import 'package:jastipkita/widgets/badges.dart';
import 'package:jastipkita/widgets/jk_button.dart';
import 'package:jastipkita/widgets/restricted_item_warning.dart';
import 'package:jastipkita/widgets/sheets_and_glass.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../helpers.dart';

/// Tiles and ink placed on tinted surfaces must sit on their own (transparent) Material, or
/// Flutter asserts "ListTile background color or ink splashes may be invisible" in debug and the
/// ripple is painted underneath the tint. One pump per shared surface that hosts them.
void main() {
  Future<void> pumpClean(WidgetTester tester, Widget child, {double textScale = 1.0}) async {
    usePhoneSurface(tester);
    await tester.pumpWidget(harness(child, textScale: textScale));
    await tester.pump();
    expect(tester.takeException(), isNull);
  }

  for (final classification in <String>[Restriction.restricted, Restriction.declarationRequired, Restriction.permitRequired]) {
    testWidgets('RestrictedItemWarning ($classification) acknowledgement tile', (WidgetTester tester) async {
      var acknowledged = false;
      await pumpClean(
        tester,
        StatefulBuilder(
          builder: (BuildContext context, StateSetter setState) => RestrictedItemWarning(
            classification: classification,
            permitAuthorities: const <String>['BPOM'],
            acknowledged: acknowledged,
            onAcknowledgedChanged: (bool v) => setState(() => acknowledged = v),
          ),
        ),
      );
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pump(const Duration(milliseconds: 300));
      expect(tester.takeException(), isNull);
      expect(acknowledged, isTrue);
    });
  }

  for (final highContrast in <bool>[false, true]) {
    testWidgets('GlassSurface hosts tiles and ink (high contrast: $highContrast)', (WidgetTester tester) async {
      usePhoneSurface(tester);
      var taps = 0;
      await tester.pumpWidget(
        harness(
          Builder(
            builder: (BuildContext context) => MediaQuery(
              data: MediaQuery.of(context).copyWith(highContrast: highContrast),
              child: GlassSurface(
                borderRadius: BorderRadius.circular(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    ListTile(
                      title: const Text('Tile'),
                      onTap: () {
                        taps++;
                      },
                    ),
                    SwitchListTile(value: true, onChanged: (bool v) {}, title: const Text('Switch')),
                    InkWell(
                      onTap: () {
                        taps++;
                      },
                      child: const SizedBox(height: 48, width: 200),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.tap(find.text('Tile'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(tester.takeException(), isNull);
      expect(taps, 1);
    });
  }

  testWidgets('OpaqueActionBar hosts tiles and buttons', (WidgetTester tester) async {
    await pumpClean(
      tester,
      OpaqueActionBar(
        children: <Widget>[
          ListTile(title: const Text('Total'), onTap: () {}),
          JkButton(label: 'Bayar', onPressed: () {}),
        ],
      ),
    );
    await tester.tap(find.text('Total'));
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.takeException(), isNull);
  });

  testWidgets('TrustScoreBadge ripple sits on its own tinted Material', (WidgetTester tester) async {
    await pumpClean(tester, const TrustScoreBadge(score: 92, tier: 'EXCELLENT', full: true));
    final material = tester.widget<Material>(find.descendant(of: find.byType(TrustScoreBadge), matching: find.byType(Material)).first);
    expect(material.color, isNotNull);
    await tester.tap(find.byType(TrustScoreBadge));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text(idStrings.trustExplainTitle), findsOneWidget);
  });

  testWidgets('ModeSwitch segments on the tinted track', (WidgetTester tester) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final prefs = await SharedPreferences.getInstance();
    usePhoneSurface(tester);
    await tester.pumpWidget(
      ProviderScope(
        overrides: <Override>[
          sharedPreferencesProvider.overrideWithValue(prefs),
          tokenStorageProvider.overrideWithValue(MemoryTokenStorage()),
        ],
        child: harness(const ModeSwitch()),
      ),
    );
    await tester.pump();
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(find.text(idStrings.modeBuyer), findsOneWidget);
    expect(find.text(idStrings.modeTraveler), findsOneWidget);
  });
}
