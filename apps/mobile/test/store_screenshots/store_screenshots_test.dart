@Tags(<String>['store'])
library;

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/features/auth/presentation/welcome_screen.dart';
import 'package:jastipkita/features/home/presentation/home_screen.dart';
import 'package:jastipkita/features/requests/presentation/create_request_screen.dart';
import 'package:jastipkita/features/shell/presentation/main_shell.dart';
import 'package:jastipkita/features/transactions/presentation/checkout_screen.dart';
import 'package:jastipkita/features/transactions/presentation/handover_screens.dart';
import 'package:jastipkita/features/transactions/presentation/transaction_detail_screen.dart';
import 'package:jastipkita/widgets/price_breakdown_card.dart';

import '../helpers.dart';
import 'store_data.dart';
import 'store_harness.dart';

/// Store screenshots (Google Play 1080×1920 + 1440×2560, App Store iPhone 6.7" 1290×2796):
/// real screens, real Poppins, fake API data, Indonesian copy, navy caption band.
///
///   flutter test --tags store --update-goldens --dart-define=STORE_SCREENSHOTS=true test/store_screenshots
///
/// Output: `build/store_screenshots/<device>/NN_name.png`. Skipped in the normal `flutter test`.
void main() {
  final l10n = idStrings;

  Map<String, Object Function(RequestOptions)> common({String mode = 'BUYER'}) => <String, Object Function(RequestOptions)>{
        'GET /me': (RequestOptions r) => storeProfile(mode: mode),
        'GET /me/consents': (RequestOptions r) => storeConsents(),
        'GET /catalog/countries': (RequestOptions r) => storeCountries(),
        'GET /catalog/categories': (RequestOptions r) => storeCategories(),
        'GET /catalog/currencies': (RequestOptions r) => storeCurrencies(),
        'GET /notifications/unread-count': (RequestOptions r) => <String, dynamic>{'count': 2},
      };

  Map<String, Object Function(RequestOptions)> detailRoutes(String role, String status, List<String> actions) =>
      <String, Object Function(RequestOptions)>{
        ...common(mode: role),
        'GET /transactions/$storeTxId': (RequestOptions r) => storeDetail(role: role, status: status, actions: actions),
        'GET /transactions/$storeTxId/timeline': (RequestOptions r) => storeTimeline(status),
      };

  // ListView children are built lazily: a target below the cache extent does not exist yet, so drag the page's main
  // scrollable until it does, then align it.
  Future<void> scrollTo(WidgetTester tester, Finder finder) async {
    if (finder.evaluate().isEmpty) {
      await tester.dragUntilVisible(finder, find.byType(Scrollable).first, const Offset(0, -200), maxIteration: 80);
    }
    await tester.ensureVisible(finder.first);
    await tester.pump(const Duration(milliseconds: 300));
  }

  final shots = <StoreShot>[
    StoreShot(
      file: '01_onboarding',
      caption: 'Titip barang dari luar negeri, mudah & aman',
      subcaption: 'Traveler terverifikasi membawakan barang impianmu ke Indonesia.',
      phones: <StorePhone>[StorePhone(screen: () => const WelcomeScreen(), routes: common())],
    ),
    StoreShot(
      file: '02_buyer_home',
      caption: 'Temukan traveler terverifikasi di rute favoritmu',
      subcaption: 'Lihat Trust Score, level verifikasi, dan ulasan sebelum menitip.',
      phones: <StorePhone>[
        StorePhone(
          screen: () => const MainShell(location: '/home', child: HomeScreen()),
          routes: <String, Object Function(RequestOptions)>{
            ...common(),
            'GET /transactions': (RequestOptions r) => storeBuyerTransactions(),
            'GET /trips': (RequestOptions r) => storeDiscoveryTrips(),
          },
        ),
      ],
    ),
    StoreShot(
      file: '03_create_request',
      caption: 'Tempel link produk, estimasi bea & pajak langsung muncul',
      subcaption: 'Aturan barang dicek otomatis sebelum kamu menitip.',
      phones: <StorePhone>[
        StorePhone(
          screen: () => const CreateRequestScreen(initialTab: 'url', initialUrl: 'https://www.coachjapan.jp/tabby-shoulder-bag-26'),
          routes: <String, Object Function(RequestOptions)>{
            ...common(),
            'POST /requests/extract': (RequestOptions r) => storeExtraction(),
            'POST /restricted/check': (RequestOptions r) => storeRestrictedCheck(),
            'POST /customs/estimate': (RequestOptions r) => storeCustomsEstimate(),
          },
        ),
      ],
      interact: (WidgetTester tester) async {
        await scrollTo(tester, find.text(l10n.requestCheckRules));
        await tester.tap(find.text(l10n.requestCheckRules).first);
        for (var i = 0; i < 6; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        await scrollTo(tester, find.text(l10n.customsEstimateTotal));
      },
    ),
    StoreShot(
      file: '04_checkout_safepay',
      caption: 'Semua biaya terlihat sebelum bayar',
      subcaption: 'Bayar lewat SafePay — dana ditahan sampai barang kamu terima.',
      phones: <StorePhone>[
        StorePhone(
          screen: () => const CheckoutScreen(transactionId: storeTxId),
          routes: <String, Object Function(RequestOptions)>{
            ...detailRoutes('BUYER', 'AWAITING_PAYMENT', const <String>['QUOTE', 'CHECKOUT']),
            'POST /transactions/$storeTxId/quote': (RequestOptions r) => storeQuote(),
          },
        ),
      ],
      interact: (WidgetTester tester) async {
        // Show the full 11-line breakdown down to the chosen payment option.
        await scrollTo(tester, find.byType(PriceBreakdownCard));
        await scrollTo(tester, find.text(l10n.channelTitle));
      },
    ),
    StoreShot(
      file: '05_traveler_purchase_gate',
      caption: 'Traveler baru boleh membeli setelah harga disetujui',
      subcaption: 'Dana aman di SafePay tidak berarti boleh beli — gerbangnya jelas.',
      phones: <StorePhone>[
        StorePhone(
          label: 'JANGAN BELI DULU',
          labelColor: const Color(0xFFB91C1C),
          screen: () => const TransactionDetailScreen(transactionId: storeTxId),
          routes: detailRoutes('TRAVELER', 'PAYMENT_SECURED', const <String>['PRICE_CHECK', 'CANCEL']),
        ),
        StorePhone(
          label: 'BOLEH DIBELI',
          labelColor: const Color(0xFF047857),
          screen: () => const TransactionDetailScreen(transactionId: storeTxId),
          routes: detailRoutes('TRAVELER', 'PURCHASE_APPROVED', const <String>['SUBMIT_PURCHASE_PROOF', 'CANCEL']),
        ),
      ],
    ),
    StoreShot(
      file: '06_handover_pin_qr',
      caption: 'Serah terima pakai PIN & QR',
      subcaption: 'Dana baru diteruskan ke traveler setelah barang kamu terima.',
      phones: <StorePhone>[
        StorePhone(
          screen: () => const HandoverScreen(transactionId: storeTxId),
          routes: <String, Object Function(RequestOptions)>{
            ...detailRoutes('BUYER', 'READY_FOR_HANDOVER', const <String>['VIEW_HANDOVER_PIN', 'OPEN_DISPUTE']),
            'GET /transactions/$storeTxId/delivery/pin': (RequestOptions r) => storeHandoverPin(),
          },
        ),
      ],
    ),
    StoreShot(
      file: '07_buyer_home_dark',
      dark: true,
      caption: 'Nyaman dipakai siang maupun malam',
      subcaption: 'Tema gelap, teks besar, dan pembaca layar didukung penuh.',
      phones: <StorePhone>[
        StorePhone(
          screen: () => const MainShell(location: '/home', child: HomeScreen()),
          routes: <String, Object Function(RequestOptions)>{
            ...common(),
            'GET /transactions': (RequestOptions r) => storeBuyerTransactions(),
            'GET /trips': (RequestOptions r) => storeDiscoveryTrips(),
          },
        ),
      ],
    ),
  ];

  for (final device in StoreDevice.all) {
    for (final shot in shots) {
      testWidgets(
        '${device.name} ${shot.file}',
        (WidgetTester tester) => captureStoreShot(tester, device, shot),
        skip: !storeScreenshotsEnabled,
        // a stuck shot must fail fast instead of blocking the CI job for the 10-minute default
        timeout: const Timeout(Duration(minutes: 2)),
      );
    }
  }
}
