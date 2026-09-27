import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/config/app_config.dart';
import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/account.dart';
import '../../../core/models/json.dart';
import '../../../core/network/api_exception.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/sheets_and_glass.dart';
import '../application/session_controller.dart';
import '../data/auth_repository.dart';

Future<void> openLegal(String url) async {
  await launchUrl(Uri.parse(url), mode: LaunchMode.inAppBrowserView);
}

/// ToS + Privacy (required) and marketing (optional) — never pre-checked (no dark patterns).
class ConsentForm extends StatefulWidget {
  const ConsentForm({super.key, required this.onSubmit, this.busy = false});

  final ValueChanged<ConsentChoice> onSubmit;
  final bool busy;

  @override
  State<ConsentForm> createState() => _ConsentFormState();
}

class _ConsentFormState extends State<ConsentForm> {
  bool _terms = false;
  bool _privacy = false;
  bool _marketing = false;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    Widget link(String label, String url) => Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: () => openLegal(url),
            icon: const Icon(Icons.open_in_new, size: 18),
            label: Text(label),
          ),
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(l10n.consentIntro, style: JkTypeScale.bodyM.copyWith(color: jk.onSurface)),
        const SizedBox(height: JkSpacing.s2),
        CheckboxListTile(
          value: _terms,
          onChanged: (bool? v) => setState(() => _terms = v ?? false),
          controlAffinity: ListTileControlAffinity.leading,
          contentPadding: EdgeInsets.zero,
          title: Text(l10n.consentTerms),
          subtitle: Text(l10n.consentRequired),
        ),
        link(l10n.consentReadTerms, AppConfig.termsUrl),
        CheckboxListTile(
          value: _privacy,
          onChanged: (bool? v) => setState(() => _privacy = v ?? false),
          controlAffinity: ListTileControlAffinity.leading,
          contentPadding: EdgeInsets.zero,
          title: Text(l10n.consentPrivacy),
          subtitle: Text(l10n.consentRequired),
        ),
        link(l10n.consentReadPrivacy, AppConfig.privacyUrl),
        CheckboxListTile(
          value: _marketing,
          onChanged: (bool? v) => setState(() => _marketing = v ?? false),
          controlAffinity: ListTileControlAffinity.leading,
          contentPadding: EdgeInsets.zero,
          title: Text(l10n.consentMarketing),
          subtitle: Text(l10n.consentOptional),
        ),
        const SizedBox(height: JkSpacing.s2),
        Text(l10n.consentKycSeparate, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
        const SizedBox(height: JkSpacing.s4),
        JkButton(
          label: l10n.consentContinue,
          loading: widget.busy,
          onPressed: _terms && _privacy ? () => widget.onSubmit(ConsentChoice(marketing: _marketing)) : null,
          disabledReason: _terms && _privacy ? null : l10n.consentNeedRequired,
        ),
      ],
    );
  }
}

/// Asks for consent in a sheet; null when dismissed.
Future<ConsentChoice?> askConsent(BuildContext context) {
  return showJkBottomSheet<ConsentChoice>(
    context,
    title: context.l10n.consentTitle,
    builder: (BuildContext sheetContext) => ConsentForm(onSubmit: (ConsentChoice c) => Navigator.of(sheetContext).pop(c)),
  );
}

/// Runs a login attempt; on `422 CONSENT_REQUIRED` (new account) collects consent and retries
/// once with it. A `CONSENT_VERSION_INVALID` answer is retried with the server's current version.
Future<LoginResult?> loginWithConsent(
  BuildContext context,
  Future<LoginResult> Function(List<Json>? consents) attempt,
) async {
  try {
    return await attempt(null);
  } on ApiException catch (e) {
    if (e.code != 'CONSENT_REQUIRED') rethrow;
  }
  if (!context.mounted) return null;
  final choice = await askConsent(context);
  if (choice == null) return null;
  try {
    return await attempt(choice.toPayload(AppConfig.consentVersion));
  } on ApiException catch (e) {
    final allowed = e.details['allowedVersions'];
    if (e.code == 'CONSENT_VERSION_INVALID' && allowed is List && allowed.isNotEmpty) {
      return attempt(choice.toPayload(allowed.first.toString()));
    }
    rethrow;
  }
}

/// `/consents` — a signed-in user whose required consents are missing (e.g. new ToS version).
class ConsentScreen extends ConsumerStatefulWidget {
  const ConsentScreen({super.key});

  @override
  ConsumerState<ConsentScreen> createState() => _ConsentScreenState();
}

class _ConsentScreenState extends ConsumerState<ConsentScreen> {
  bool _busy = false;

  Future<void> _submit(ConsentChoice choice) async {
    setState(() => _busy = true);
    final repo = ref.read(authRepositoryProvider);
    try {
      var version = AppConfig.consentVersion;
      for (final item in choice.toPayload(version)) {
        final type = item['type'].toString();
        final granted = item['granted'] == true;
        try {
          await repo.recordConsent(type: type, version: version, granted: granted);
        } on ApiException catch (e) {
          final allowed = e.details['allowedVersions'];
          if (e.code == 'CONSENT_VERSION_INVALID' && allowed is List && allowed.isNotEmpty) {
            version = allowed.first.toString();
            await repo.recordConsent(type: type, version: version, granted: granted);
          } else {
            rethrow;
          }
        }
      }
      ref.read(sessionControllerProvider.notifier).consentsRecorded();
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.consentTitle), automaticallyImplyLeading: false),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(JkSpacing.s5),
          child: ConsentForm(onSubmit: _submit, busy: _busy),
        ),
      ),
    );
  }
}
