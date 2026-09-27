import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/account.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../application/session_controller.dart';
import '../data/auth_repository.dart';
import '../data/social_sign_in.dart';
import 'consent_screen.dart';
import 'otp_screen.dart';
import 'splash_screen.dart';

enum _OtpMethod { phone, email }

/// `08…` / `628…` / `8…` → `+628…` (E.164). Other `+CC` numbers are kept.
String normalizePhone(String input) {
  final digits = input.replaceAll(RegExp(r'[^0-9+]'), '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('62')) return '+$digits';
  if (digits.startsWith('0')) return '+62${digits.substring(1)}';
  if (digits.startsWith('8')) return '+62$digits';
  return digits;
}

/// Login / sign-up (the first successful login creates the account; KYC is separate):
/// Google, Apple (iOS, or where configured), phone OTP via SMS/WhatsApp, or e-mail OTP.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final TextEditingController _phone = TextEditingController();
  final TextEditingController _email = TextEditingController();
  _OtpMethod _method = _OtpMethod.phone;
  String _channel = 'WHATSAPP';
  String? _busy;
  String? _fieldError;

  @override
  void dispose() {
    _phone.dispose();
    _email.dispose();
    super.dispose();
  }

  Future<void> _finish(LoginResult? result) async {
    if (result == null) return;
    await ref.read(sessionControllerProvider.notifier).completeLogin(result);
  }

  Future<void> _run(String key, Future<void> Function() action) async {
    if (_busy != null) return;
    setState(() => _busy = key);
    try {
      await action();
    } on Object catch (e) {
      if (!mounted) return;
      final l10n = context.l10n;
      final message = e is ApiException && e.code == 'GOOGLE_NOT_CONFIGURED' ? l10n.loginGoogleNotConfigured : errorMessage(l10n, e);
      showJkSnack(context, message, error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _google() => _run('google', () async {
        final token = await ref.read(socialSignInProvider).googleIdToken();
        if (token == null) return;
        if (!mounted) return;
        final repo = ref.read(authRepositoryProvider);
        final result = await loginWithConsent(context, (consents) => repo.signInWithGoogle(idToken: token, consents: consents));
        await _finish(result);
      });

  Future<void> _apple() => _run('apple', () async {
        final credential = await ref.read(socialSignInProvider).apple();
        if (credential == null) return;
        if (!mounted) return;
        final repo = ref.read(authRepositoryProvider);
        final result = await loginWithConsent(
          context,
          (consents) => repo.signInWithApple(
            identityToken: credential.identityToken,
            rawNonce: credential.rawNonce,
            givenName: credential.givenName,
            familyName: credential.familyName,
            consents: consents,
          ),
        );
        await _finish(result);
      });

  Future<void> _sendCode() async {
    final l10n = context.l10n;
    final isPhone = _method == _OtpMethod.phone;
    final raw = isPhone ? _phone.text.trim() : _email.text.trim().toLowerCase();
    final destination = isPhone ? normalizePhone(raw) : raw;
    final valid = isPhone ? RegExp(r'^\+[1-9][0-9]{7,14}$').hasMatch(destination) : RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(destination);
    if (!valid) {
      setState(() => _fieldError = isPhone ? l10n.loginPhoneInvalid : l10n.loginEmailInvalid);
      return;
    }
    setState(() => _fieldError = null);
    final channel = isPhone ? _channel : 'EMAIL';
    final locale = context.localeCode;
    await _run('otp', () async {
      final challenge = await ref.read(authRepositoryProvider).requestOtp(channel: channel, destination: destination, locale: locale);
      if (!mounted) return;
      context.push(Routes.loginOtp, extra: OtpArgs(challenge: challenge, channel: channel, destination: destination));
    });
  }

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final isPhone = _method == _OtpMethod.phone;
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s4, JkSpacing.s5, JkSpacing.s8),
          children: <Widget>[
            BrandLogo(height: 120, label: l10n.appName),
            const SizedBox(height: JkSpacing.s2),
            Semantics(
              header: true,
              child: Text(
                l10n.loginTitle,
                textAlign: TextAlign.center,
                style: JkTypeScale.headlineS.copyWith(color: jk.onBackground),
              ),
            ),
            const SizedBox(height: JkSpacing.s1),
            Text(l10n.loginSubtitle, textAlign: TextAlign.center, style: JkTypeScale.bodyM.copyWith(color: jk.onBackgroundMuted)),
            const SizedBox(height: JkSpacing.s6),
            JkButton(
              label: l10n.loginGoogle,
              icon: Icons.account_circle_outlined,
              variant: JkButtonVariant.secondary,
              loading: _busy == 'google',
              onPressed: _busy == null ? _google : null,
            ),
            if (SocialSignIn.appleOffered) ...<Widget>[
              const SizedBox(height: JkSpacing.s3),
              JkButton(
                label: l10n.loginApple,
                icon: Icons.apple,
                variant: JkButtonVariant.secondary,
                loading: _busy == 'apple',
                onPressed: _busy == null ? _apple : null,
              ),
            ],
            const SizedBox(height: JkSpacing.s5),
            Row(
              children: <Widget>[
                const Expanded(child: Divider()),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: JkSpacing.s3),
                  child: Text(l10n.loginOr, style: JkTypeScale.labelM.copyWith(color: jk.onBackgroundMuted)),
                ),
                const Expanded(child: Divider()),
              ],
            ),
            const SizedBox(height: JkSpacing.s5),
            SegmentedButton<_OtpMethod>(
              segments: <ButtonSegment<_OtpMethod>>[
                ButtonSegment<_OtpMethod>(value: _OtpMethod.phone, label: Text(l10n.loginPhone), icon: const Icon(Icons.phone_iphone)),
                ButtonSegment<_OtpMethod>(value: _OtpMethod.email, label: Text(l10n.loginEmail), icon: const Icon(Icons.alternate_email)),
              ],
              selected: <_OtpMethod>{_method},
              onSelectionChanged: (Set<_OtpMethod> s) => setState(() {
                _method = s.first;
                _fieldError = null;
              }),
            ),
            const SizedBox(height: JkSpacing.s4),
            if (isPhone) ...<Widget>[
              JkTextField(
                label: l10n.loginPhoneLabel,
                controller: _phone,
                hint: l10n.loginPhoneHint,
                keyboardType: TextInputType.phone,
                autofillHints: const <String>[AutofillHints.telephoneNumber],
                prefixIcon: const Icon(Icons.phone_outlined),
                errorText: _fieldError,
                textInputAction: TextInputAction.done,
                onSubmitted: (String _) => _sendCode(),
              ),
              const SizedBox(height: JkSpacing.s3),
              Wrap(
                spacing: JkSpacing.s2,
                children: <Widget>[
                  ChoiceChip(
                    label: Text(l10n.loginViaWhatsapp),
                    selected: _channel == 'WHATSAPP',
                    onSelected: (bool v) => setState(() => _channel = 'WHATSAPP'),
                  ),
                  ChoiceChip(
                    label: Text(l10n.loginViaSms),
                    selected: _channel == 'SMS',
                    onSelected: (bool v) => setState(() => _channel = 'SMS'),
                  ),
                ],
              ),
            ] else
              JkTextField(
                label: l10n.loginEmailLabel,
                controller: _email,
                hint: l10n.loginEmailHint,
                keyboardType: TextInputType.emailAddress,
                autofillHints: const <String>[AutofillHints.email],
                prefixIcon: const Icon(Icons.mail_outline),
                errorText: _fieldError,
                textInputAction: TextInputAction.done,
                onSubmitted: (String _) => _sendCode(),
              ),
            const SizedBox(height: JkSpacing.s5),
            JkButton(
              label: l10n.loginSendCode,
              loading: _busy == 'otp',
              onPressed: _busy == null ? _sendCode : null,
            ),
            const SizedBox(height: JkSpacing.s5),
            Text(l10n.loginLegal, textAlign: TextAlign.center, style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted)),
            Wrap(
              alignment: WrapAlignment.center,
              children: <Widget>[
                TextButton(onPressed: () => openLegalDocument(context, 'TOS'), child: Text(l10n.consentReadTerms)),
                TextButton(onPressed: () => openLegalDocument(context, 'PRIVACY'), child: Text(l10n.consentReadPrivacy)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
