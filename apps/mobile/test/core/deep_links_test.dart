import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/core/router/deep_links.dart';

void main() {
  group('normalizeDeepLink', () {
    test('custom scheme: the first segment arrives as the host', () {
      expect(normalizeDeepLink(Uri.parse('jastipkita://transactions/0b7f6d7e-5a3b')), '/transactions/0b7f6d7e-5a3b');
      expect(normalizeDeepLink(Uri.parse('jastipkita://transactions/tx1/receipt')), '/transactions/tx1/payment');
      expect(normalizeDeepLink(Uri.parse('jastipkita://disputes/d1')), '/disputes/d1');
      expect(normalizeDeepLink(Uri.parse('jastipkita://conversations/c1')), '/conversations/c1');
      expect(normalizeDeepLink(Uri.parse('jastipkita://account/verification')), '/account/verification');
      expect(normalizeDeepLink(Uri.parse('jastipkita://support/tickets/t1')), '/support/tickets/t1');
      expect(normalizeDeepLink(Uri.parse('jastipkita://support/complaint')), Routes.complaint);
      expect(normalizeDeepLink(Uri.parse('jastipkita://handover/tx9?t=abc')), '/transactions/tx9');
    });

    test('universal / app links under /jastipkita/app/', () {
      expect(
        normalizeDeepLink(Uri.parse('https://antarkitaindonesia.com/jastipkita/app/transactions/0b7f6d7e-5a3b')),
        '/transactions/0b7f6d7e-5a3b',
      );
      expect(normalizeDeepLink(Uri.parse('https://antarkitaindonesia.com/jastipkita/app/trips/t1')), '/trips/t1');
      expect(normalizeDeepLink(Uri.parse('https://antarkitaindonesia.com/jastipkita/app/')), '/home');
    });

    test('referral links prefill the code', () {
      expect(normalizeDeepLink(Uri.parse('https://antarkitaindonesia.com/jastipkita/r/ANDI25/')), '/referrals?code=ANDI25');
    });

    test('notification data.deepLink values (relative paths)', () {
      expect(normalizeDeepLink(Uri.parse('transactions/tx1')), '/transactions/tx1');
      expect(normalizeDeepLink(Uri.parse('/wallet')), '/wallet');
      expect(normalizeDeepLink(Uri.parse('referrals')), '/referrals');
    });

    test('rejects unknown targets, foreign schemes and unsafe ids', () {
      expect(normalizeDeepLink(Uri.parse('jastipkita://admin/users')), isNull);
      expect(normalizeDeepLink(Uri.parse('javascript:alert(1)')), isNull);
      expect(normalizeDeepLink(Uri.parse('jastipkita://transactions/%3Cscript%3E')), '/titipan');
    });
  });

  group('AuthRedirector', () {
    test('a deep link opened while signed out is replayed after sign-in', () {
      final r = AuthRedirector();
      expect(r.redirect(status: 1, needsConsent: false, uri: Uri.parse('/transactions/tx1')), Routes.welcome);
      expect(r.pending, '/transactions/tx1');
      expect(r.redirect(status: 2, needsConsent: false, uri: Uri.parse(Routes.login)), '/transactions/tx1');
      expect(r.pending, isNull);
    });

    test('while the session restores everything waits on the splash', () {
      final r = AuthRedirector();
      expect(r.redirect(status: 0, needsConsent: false, uri: Uri.parse('/orders')), Routes.splash);
      expect(r.redirect(status: 0, needsConsent: false, uri: Uri.parse(Routes.splash)), isNull);
      expect(r.redirect(status: 2, needsConsent: false, uri: Uri.parse(Routes.splash)), '/orders');
    });

    test('missing consents always go to the consent screen first', () {
      final r = AuthRedirector();
      expect(r.redirect(status: 2, needsConsent: true, uri: Uri.parse('/home')), Routes.consents);
      expect(r.redirect(status: 2, needsConsent: true, uri: Uri.parse(Routes.consents)), isNull);
    });

    test('signed-in users are kept out of the public screens', () {
      final r = AuthRedirector();
      expect(r.redirect(status: 2, needsConsent: false, uri: Uri.parse(Routes.welcome)), Routes.home);
      expect(r.redirect(status: 2, needsConsent: false, uri: Uri.parse('/wallet')), isNull);
      expect(r.redirect(status: 1, needsConsent: false, uri: Uri.parse(Routes.login)), isNull);
    });
  });
}
