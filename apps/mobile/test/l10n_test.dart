import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/core/l10n/l10n.dart';

void main() {
  final id = lookupAppLocalizations(const Locale('id'));
  final en = lookupAppLocalizations(const Locale('en'));

  test('Indonesian is the default and English is available', () {
    expect(AppLocalizations.supportedLocales.map((Locale l) => l.languageCode), containsAll(<String>['id', 'en']));
    expect(id.localeName, 'id');
    expect(en.localeName, 'en');
    expect(id.tagline, 'Titip Mudah, Aman, Terpercaya.');
    expect(id.navHome, isNot(en.navHome));
  });

  test('placeholders and plurals', () {
    expect(id.requestOffersCount(3), '3 tawaran');
    expect(en.requestOffersCount(1), '1 offer');
    expect(en.requestOffersCount(3), '3 offers');
    expect(id.stepOf(2, 5), 'Langkah 2 dari 5');
    expect(en.timelineStepSemantics(2, 8, 'done', 'Funds secured'), 'Step 2 of 8, done: Funds secured');
    expect(id.referralBuyerTerms('Rp25.000', 'Rp25.000', 'Rp300.000', 'Rp250.000', 90), contains('90 hari'));
  });

  test('golden-rule wording', () {
    expect(id.safepayBlockedTitle, 'JANGAN BELI DULU');
    expect(en.safepayBlockedTitle, 'DO NOT PURCHASE YET');
    expect(id.txStatusPurchaseApproved, 'Boleh dibeli');
  });
}
