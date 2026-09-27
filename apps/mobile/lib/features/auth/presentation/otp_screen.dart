import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/config/app_config.dart';
import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/account.dart';
import '../../../core/network/api_exception.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/money_text.dart';
import '../../../widgets/sheets_and_glass.dart';
import '../application/session_controller.dart';
import '../data/auth_repository.dart';
import 'consent_screen.dart';

class OtpArgs {
  const OtpArgs({required this.challenge, required this.channel, required this.destination, this.purpose = 'LOGIN'});

  final OtpChallenge challenge;
  final String channel;
  final String destination;
  final String purpose;
}

/// OTP entry for login (SMS / WhatsApp / e-mail) with resend cooldown from the server.
class OtpScreen extends ConsumerStatefulWidget {
  const OtpScreen({super.key, required this.args});

  final OtpArgs args;

  @override
  ConsumerState<OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends ConsumerState<OtpScreen> {
  late OtpChallenge _challenge = widget.args.challenge;
  final TextEditingController _code = TextEditingController();
  bool _verifying = false;
  String? _error;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _verify(String code) async {
    if (_verifying || code.length != 6) return;
    setState(() {
      _verifying = true;
      _error = null;
    });
    final repo = ref.read(authRepositoryProvider);
    try {
      final result = await loginWithConsent(
        context,
        (consents) => repo.verifyOtp(challengeId: _challenge.challengeId, code: code, consents: consents),
      );
      if (result == null) return;
      await ref.read(sessionControllerProvider.notifier).completeLogin(result);
    } on Object catch (e) {
      if (!mounted) return;
      final l10n = context.l10n;
      setState(() => _error = e is ApiException ? _otpError(l10n, e) : errorMessage(l10n, e));
      _code.clear();
    } finally {
      if (mounted) setState(() => _verifying = false);
    }
  }

  Future<void> _resend() async {
    try {
      final challenge = await ref.read(authRepositoryProvider).requestOtp(
            channel: widget.args.channel,
            destination: widget.args.destination,
            purpose: widget.args.purpose,
            locale: context.localeCode,
          );
      if (!mounted) return;
      setState(() {
        _challenge = challenge;
        _error = null;
      });
      showJkSnack(context, context.l10n.otpResent);
    } on ApiException catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final devCode = _challenge.devCode;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.otpTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(JkSpacing.s5),
          children: <Widget>[
            Text(
              l10n.otpSentTo(widget.args.destination),
              style: JkTypeScale.bodyL.copyWith(color: jk.onBackground),
            ),
            const SizedBox(height: JkSpacing.s5),
            OtpField(
              controller: _code,
              semanticsLabel: l10n.otpFieldLabel,
              errorText: _error,
              enabled: !_verifying,
              onCompleted: _verify,
            ),
            if (devCode != null && !AppConfig.isProduction) ...<Widget>[
              const SizedBox(height: JkSpacing.s3),
              Row(
                children: <Widget>[
                  const SandboxBadge(),
                  const SizedBox(width: JkSpacing.s2),
                  Expanded(child: Text(l10n.otpDevCode(devCode), style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted))),
                ],
              ),
            ],
            const SizedBox(height: JkSpacing.s5),
            JkButton(
              label: l10n.otpVerify,
              loading: _verifying,
              onPressed: () => _verify(_code.text),
            ),
            const SizedBox(height: JkSpacing.s3),
            ResendCodeButton(availableAt: _challenge.resendAvailableAt, onResend: _resend),
          ],
        ),
      ),
    );
  }
}

String _otpError(AppLocalizations l10n, ApiException e) {
  switch (e.code) {
    case 'OTP_INVALID':
      return l10n.otpInvalid;
    case 'OTP_EXPIRED':
      return l10n.otpExpired;
    case 'OTP_LOCKED':
      return l10n.otpLocked;
    default:
      return errorMessage(l10n, e);
  }
}

/// "Kirim ulang kode (0:42)" — disabled until the server's `resendAvailableAt`.
class ResendCodeButton extends StatefulWidget {
  const ResendCodeButton({super.key, required this.availableAt, required this.onResend});

  final DateTime? availableAt;
  final Future<void> Function() onResend;

  @override
  State<ResendCodeButton> createState() => _ResendCodeButtonState();
}

class _ResendCodeButtonState extends State<ResendCodeButton> {
  Timer? _timer;
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (Timer t) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _tap() async {
    setState(() => _sending = true);
    try {
      await widget.onResend();
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final at = widget.availableAt;
    final remaining = at == null ? Duration.zero : at.difference(DateTime.now().toUtc());
    final waiting = remaining.inSeconds > 0;
    return JkButton(
      variant: JkButtonVariant.tertiary,
      label: waiting ? l10n.otpResendIn(remaining.inSeconds) : l10n.otpResend,
      loading: _sending,
      onPressed: waiting || _sending ? null : _tap,
    );
  }
}

/// Signed-in OTP verification in a sheet (VERIFY_PHONE for KYC level 2, VERIFY_EMAIL for the
/// transaction e-mail). Returns true when verified.
Future<bool> showVerifyOtpSheet(
  BuildContext context,
  WidgetRef ref, {
  required OtpChallenge challenge,
  required String destination,
  required String channel,
  required String purpose,
}) async {
  final result = await showJkBottomSheet<bool>(
    context,
    title: context.l10n.otpTitle,
    builder: (BuildContext sheetContext) => _VerifyOtpBody(
      initial: challenge,
      destination: destination,
      channel: channel,
      purpose: purpose,
    ),
  );
  if (result != true) return false;
  if (context.mounted) await ref.read(sessionControllerProvider.notifier).refreshProfile();
  return true;
}

class _VerifyOtpBody extends ConsumerStatefulWidget {
  const _VerifyOtpBody({required this.initial, required this.destination, required this.channel, required this.purpose});

  final OtpChallenge initial;
  final String destination;
  final String channel;
  final String purpose;

  @override
  ConsumerState<_VerifyOtpBody> createState() => _VerifyOtpBodyState();
}

class _VerifyOtpBodyState extends ConsumerState<_VerifyOtpBody> {
  late OtpChallenge _challenge = widget.initial;
  final TextEditingController _code = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _verify(String code) async {
    if (_busy || code.length != 6) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(authRepositoryProvider).verifyOtp(challengeId: _challenge.challengeId, code: code);
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = _otpError(context.l10n, e));
      _code.clear();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resend() async {
    try {
      final challenge = await ref.read(authRepositoryProvider).requestOtp(
            channel: widget.channel,
            destination: widget.destination,
            purpose: widget.purpose,
            locale: context.localeCode,
          );
      if (!mounted) return;
      setState(() => _challenge = challenge);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = errorMessage(context.l10n, e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final devCode = _challenge.devCode;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(l10n.otpSentTo(widget.destination), style: JkTypeScale.bodyM.copyWith(color: context.jk.onSurface)),
        const SizedBox(height: JkSpacing.s4),
        OtpField(controller: _code, semanticsLabel: l10n.otpFieldLabel, errorText: _error, onCompleted: _verify, enabled: !_busy),
        if (devCode != null && !AppConfig.isProduction)
          Padding(
            padding: const EdgeInsets.only(top: JkSpacing.s2),
            child: Text(l10n.otpDevCode(devCode), style: JkTypeScale.bodyS.copyWith(color: context.jk.onSurfaceMuted)),
          ),
        const SizedBox(height: JkSpacing.s4),
        JkButton(label: l10n.otpVerify, loading: _busy, onPressed: () => _verify(_code.text)),
        ResendCodeButton(availableAt: _challenge.resendAvailableAt, onResend: _resend),
      ],
    );
  }
}
