import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:jastipkita/core/design/theme.dart';
import 'package:jastipkita/core/format/dates.dart';
import 'package:jastipkita/core/l10n/l10n.dart';
import 'package:jastipkita/core/network/api_client.dart';
import 'package:jastipkita/features/support/presentation/complaint_screen.dart';

import '../fake_http.dart';
import '../helpers.dart';

Map<String, dynamic> _complaintInfo() => <String, dynamic>{
      'channels': <String, dynamic>{
        'inApp': <String, dynamic>{'ticketCategory': 'COMPLAINT', 'endpoint': '/v1/support/tickets'},
        'whatsapp': null,
        'email': null,
        'webUrl': 'https://antarkitaindonesia.com/jastipkita/pengaduan/',
      },
      'sla': <String, dynamic>{
        'basis': 'FIRST_RESPONSE',
        'complaintPriority': 'HIGH',
        'complaintFirstResponseHours': 12,
        'hoursByPriority': <String, dynamic>{'URGENT': 4, 'HIGH': 12, 'NORMAL': 24, 'LOW': 72},
        'configKey': 'support.sla',
        'isAssumption': true,
      },
      'escalation': <String, dynamic>{
        'authority': 'Direktorat Jenderal Perlindungan Konsumen dan Tertib Niaga (Ditjen PKTN)',
        'unit': 'Direktorat Pemberdayaan Konsumen',
        'ministry': 'Kementerian Perdagangan Republik Indonesia',
        'whatsapp': <String, dynamic>{'number': '6285311111010', 'display': '0853-1111-1010', 'url': 'https://wa.me/6285311111010'},
        'email': 'pengaduan.konsumen@kemendag.go.id',
        'phone': <String, dynamic>{'number': '+62213441839', 'display': '(021) 3441839'},
        'website': 'https://ditjenpktn.kemendag.go.id/konsultasi-online',
        'verification': <String, dynamic>{
          'status': 'VERIFIED',
          'accessedAt': '2026-10-04',
          'sources': <String>['https://ditjenpktn.kemendag.go.id/konsultasi-online'],
        },
        'outOfCourt': 'BPSK',
      },
      'disputeFlow': <String, dynamic>{'endpoint': '/v1/transactions/{id}/disputes', 'note': '-'},
      'legalBasis': <String>['UU No. 8 Tahun 1999 tentang Perlindungan Konsumen'],
    };

Map<String, dynamic> _ticket() => <String, dynamic>{
      'id': 't-1',
      'number': 'TKT-261004-ABC123',
      'category': 'COMPLAINT',
      'subject': 'Traveler tidak membalas',
      'status': 'OPEN',
      'priority': 'HIGH',
      'transactionId': 'tx-1',
      'disputeId': null,
      'slaDueAt': '2026-10-04T15:00:00.000Z',
      'firstResponseAt': null,
      'resolvedAt': null,
      'createdAt': '2026-10-04T03:00:00.000Z',
      'updatedAt': '2026-10-04T03:00:00.000Z',
      'messages': <Map<String, dynamic>>[],
    };

/// The screen inside a minimal router: `/` = complaint form, `/support/tickets/:id` = stub.
Widget _app(FakeAdapter adapter) {
  final router = GoRouter(
    routes: <RouteBase>[
      GoRoute(path: '/', builder: (BuildContext context, GoRouterState state) => const ComplaintScreen(transactionId: 'tx-1')),
      GoRoute(
        path: '/support/tickets/:id',
        builder: (BuildContext context, GoRouterState state) => Scaffold(body: Text('ticket ${state.pathParameters['id']}')),
      ),
    ],
  );
  return ProviderScope(
    overrides: <Override>[apiClientProvider.overrideWithValue(ApiClient(fakeDio(adapter)))],
    child: MaterialApp.router(
      debugShowCheckedModeBanner: false,
      theme: buildJkTheme(Brightness.light),
      locale: const Locale('id'),
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      routerConfig: router,
    ),
  );
}

void main() {
  final l10n = idStrings;

  testWidgets('shows the published SLA + escalation and files a COMPLAINT ticket linked to the order', (WidgetTester tester) async {
    usePhoneSurface(tester);
    final adapter = FakeAdapter((RequestOptions o, int i) {
      if (o.path == '/support/complaint-info') return FakeReply(200, _complaintInfo());
      if (o.path == '/support/tickets' && o.method == 'POST') return FakeReply(201, _ticket());
      return const FakeReply(404);
    });
    await tester.pumpWidget(_app(adapter));
    await tester.pumpAndSettle();

    expect(find.text(l10n.complaintTitle), findsWidgets);
    expect(find.text(l10n.complaintSlaHours(12)), findsOneWidget);
    expect(find.text('${l10n.ticketPriorityHigh} · ${l10n.complaintTitle}'), findsOneWidget, reason: 'complaints are HIGH priority');
    expect(find.text(l10n.complaintHoursShort(4)), findsOneWidget);
    expect(find.text(l10n.complaintHoursShort(72)), findsOneWidget);
    expect(find.text('WhatsApp 0853-1111-1010'), findsOneWidget);
    expect(find.text('pengaduan.konsumen@kemendag.go.id'), findsOneWidget);
    expect(find.text('(021) 3441839'), findsOneWidget);
    expect(find.text(l10n.complaintEscalationVerified(JkDates.calendar('2026-10-04', 'id'))), findsOneWidget);
    expect(find.text(l10n.ticketLinked), findsOneWidget);

    // validation happens before any call
    await tester.tap(find.text(l10n.complaintSubmit));
    await tester.pumpAndSettle();
    expect(find.text(l10n.ticketValidation), findsOneWidget);
    expect(adapter.requestsTo('/support/tickets'), isEmpty);

    await tester.enterText(find.byType(TextField).at(0), 'Traveler tidak membalas');
    await tester.enterText(find.byType(TextField).at(1), 'Sudah tiga hari traveler tidak membalas chat setelah saya membayar.');
    await tester.tap(find.text(l10n.complaintSubmit));
    await tester.pumpAndSettle();

    expect(sentBody(adapter.requestsTo('/support/tickets').single), <String, dynamic>{
      'category': 'COMPLAINT',
      'subject': 'Traveler tidak membalas',
      'message': 'Sudah tiga hari traveler tidak membalas chat setelah saya membayar.',
      'transactionId': 'tx-1',
    });
    expect(find.text('ticket t-1'), findsOneWidget, reason: 'opens the new ticket (SLA countdown lives there)');
    expect(find.text(l10n.ticketCreated('TKT-261004-ABC123')), findsOneWidget);
    // let the snackbar time out so no timer outlives the test
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('the form still works when the complaint info cannot be loaded', (WidgetTester tester) async {
    usePhoneSurface(tester);
    final adapter = FakeAdapter((RequestOptions o, int i) {
      if (o.path == '/support/complaint-info') return FakeReply(500, errorBody('INTERNAL'));
      return FakeReply(201, _ticket());
    });
    await tester.pumpWidget(_app(adapter));
    await tester.pumpAndSettle();

    expect(find.text(l10n.complaintSlaUnavailable), findsOneWidget);
    expect(find.text(l10n.actionRetry), findsOneWidget);
    expect(find.text(l10n.complaintEscalationTitle), findsNothing);
    expect(find.text(l10n.complaintSubmit), findsOneWidget);

    await tester.tap(find.text(l10n.actionRetry));
    await tester.pumpAndSettle();
    expect(adapter.requestsTo('/support/complaint-info'), hasLength(2));
    expect(tester.takeException(), isNull);
  });
}
