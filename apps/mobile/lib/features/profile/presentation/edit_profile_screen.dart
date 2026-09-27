import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/account.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../../auth/application/session_controller.dart';
import '../../auth/data/auth_repository.dart';
import '../../auth/presentation/otp_screen.dart';

/// Edit display name and the transaction e-mail (receipts & payment notices go there; the login
/// e-mail is separate). A new transaction e-mail is applied only after its OTP is verified.
class EditProfileScreen extends ConsumerStatefulWidget {
  const EditProfileScreen({super.key});

  @override
  ConsumerState<EditProfileScreen> createState() => _EditProfileScreenState();
}

class _EditProfileScreenState extends ConsumerState<EditProfileScreen> {
  late final Profile? _initial = ref.read(currentProfileProvider);
  late final TextEditingController _name = TextEditingController(text: _initial?.displayName ?? '');
  late final TextEditingController _email = TextEditingController(text: _initial?.transactionEmail ?? '');
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final l10n = context.l10n;
    final email = _email.text.trim().toLowerCase();
    if (email.isNotEmpty && !RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(email)) {
      setState(() => _error = l10n.loginEmailInvalid);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final emailChanged = email != (_initial?.transactionEmail ?? '');
      final (profile, challengeId) = await ref.read(authRepositoryProvider).updateProfile(
            displayName: _name.text.trim().isEmpty ? null : _name.text.trim(),
            transactionEmail: emailChanged ? email : null,
          );
      if (!mounted) return;
      ref.read(sessionControllerProvider.notifier).setProfile(profile);
      if (challengeId != null) {
        final verified = await showVerifyOtpSheet(
          context,
          ref,
          challenge: OtpChallenge(challengeId: challengeId),
          destination: email,
          channel: 'EMAIL',
          purpose: 'VERIFY_EMAIL',
        );
        if (!mounted) return;
        showJkSnack(context, verified ? l10n.emailVerified : l10n.emailPendingVerification);
      } else {
        showJkSnack(context, l10n.profileSaved);
      }
      if (!mounted) return;
      context.pop();
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
    final jk = context.jk;
    final profile = ref.watch(currentProfileProvider);
    final error = _error;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.editProfileTitle)),
      body: ListView(
        padding: const EdgeInsets.all(JkSpacing.s5),
        children: <Widget>[
          JkTextField(label: l10n.displayName, controller: _name, textCapitalization: TextCapitalization.words, autofillHints: const <String>[AutofillHints.name]),
          const SizedBox(height: JkSpacing.s4),
          JkTextField(
            label: l10n.transactionEmail,
            controller: _email,
            keyboardType: TextInputType.emailAddress,
            helper: l10n.transactionEmailHelp,
          ),
          const SizedBox(height: JkSpacing.s4),
          if (profile != null)
            JkCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  KeyValue(label: l10n.loginEmailLabel, value: Text(profile.email ?? '-')),
                  const SizedBox(height: JkSpacing.s2),
                  KeyValue(
                    label: l10n.loginPhoneLabel,
                    value: Text('${profile.phone ?? '-'}${profile.phoneVerified ? ' ✓' : ''}'),
                  ),
                  const SizedBox(height: JkSpacing.s2),
                  Text(l10n.loginIdentityNote, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                ],
              ),
            ),
          if (error != null) ...<Widget>[const SizedBox(height: JkSpacing.s3), NoticeBox(tone: NoticeTone.error, message: error)],
          const SizedBox(height: JkSpacing.s5),
          JkButton(label: l10n.actionSave, loading: _busy, onPressed: _save),
        ],
      ),
    );
  }
}
