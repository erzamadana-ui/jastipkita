import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/l10n/l10n.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../../../widgets/sheets_and_glass.dart';
import '../../auth/data/auth_repository.dart';
import '../../auth/presentation/login_screen.dart';
import '../../auth/presentation/otp_screen.dart';

class _PhoneRequest {
  const _PhoneRequest(this.destination, this.channel, this.args);

  final String destination;
  final String channel;
  final OtpArgs args;
}

/// Level 2 (PHONE_VERIFIED): phone number → OTP (SMS/WhatsApp, purpose VERIFY_PHONE).
/// Required before checkout (KYC ≥ 2).
Future<bool> startPhoneVerification(BuildContext context, WidgetRef ref) async {
  final request = await showJkBottomSheet<_PhoneRequest>(
    context,
    title: context.l10n.verifyPhone,
    builder: (BuildContext sheetContext) => const _PhoneEntry(),
  );
  if (request == null) return false;
  if (!context.mounted) return false;
  final ok = await showVerifyOtpSheet(
    context,
    ref,
    challenge: request.args.challenge,
    destination: request.destination,
    channel: request.channel,
    purpose: 'VERIFY_PHONE',
  );
  if (!ok) return false;
  if (!context.mounted) return true;
  showJkSnack(context, context.l10n.phoneVerified);
  return true;
}

class _PhoneEntry extends ConsumerStatefulWidget {
  const _PhoneEntry();

  @override
  ConsumerState<_PhoneEntry> createState() => _PhoneEntryState();
}

class _PhoneEntryState extends ConsumerState<_PhoneEntry> {
  final TextEditingController _phone = TextEditingController();
  String _channel = 'WHATSAPP';
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _phone.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final l10n = context.l10n;
    final destination = normalizePhone(_phone.text.trim());
    if (!RegExp(r'^\+[1-9][0-9]{7,14}$').hasMatch(destination)) {
      setState(() => _error = l10n.loginPhoneInvalid);
      return;
    }
    final locale = context.localeCode;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final challenge = await ref
          .read(authRepositoryProvider)
          .requestOtp(channel: _channel, destination: destination, purpose: 'VERIFY_PHONE', locale: locale);
      if (!mounted) return;
      Navigator.of(context).pop(
        _PhoneRequest(
          destination,
          _channel,
          OtpArgs(challenge: challenge, channel: _channel, destination: destination, purpose: 'VERIFY_PHONE'),
        ),
      );
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = errorMessage(l10n, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final error = _error;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(l10n.verifyPhoneIntro, style: JkTypeScale.bodyM.copyWith(color: context.jk.onSurface)),
        const SizedBox(height: JkSpacing.s3),
        JkTextField(
          label: l10n.loginPhoneLabel,
          controller: _phone,
          hint: l10n.loginPhoneHint,
          keyboardType: TextInputType.phone,
          autofillHints: const <String>[AutofillHints.telephoneNumber],
          errorText: error,
        ),
        const SizedBox(height: JkSpacing.s3),
        Wrap(
          spacing: JkSpacing.s2,
          children: <Widget>[
            ChoiceChip(label: Text(l10n.loginViaWhatsapp), selected: _channel == 'WHATSAPP', onSelected: (bool v) => setState(() => _channel = 'WHATSAPP')),
            ChoiceChip(label: Text(l10n.loginViaSms), selected: _channel == 'SMS', onSelected: (bool v) => setState(() => _channel = 'SMS')),
          ],
        ),
        const SizedBox(height: JkSpacing.s4),
        JkButton(label: l10n.loginSendCode, loading: _busy, onPressed: _send),
      ],
    );
  }
}
