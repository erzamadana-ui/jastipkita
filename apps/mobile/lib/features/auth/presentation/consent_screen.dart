import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/account.dart';
import '../../../core/models/json.dart';
import '../../../core/network/api_exception.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/sheets_and_glass.dart';
import '../../../widgets/states.dart';
import '../../legal/presentation/legal_document_screen.dart';
import '../application/session_controller.dart';
import '../data/auth_repository.dart';

export '../../legal/presentation/legal_document_screen.dart' show openLegal, openLegalDocument;

/// Signup consents exactly as `GET /consents/requirements` lists them (types, titles, versions):
/// required ones must be ticked, optional ones (marketing) default to off — never pre-checked.
class ConsentForm extends ConsumerStatefulWidget {
  const ConsentForm({super.key, required this.onSubmit, this.busy = false});

  final ValueChanged<ConsentChoice> onSubmit;
  final bool busy;

  @override
  ConsumerState<ConsentForm> createState() => _ConsentFormState();
}

class _ConsentFormState extends ConsumerState<ConsentForm> {
  final Map<String, bool> _granted = <String, bool>{};

  String _fallbackTitle(AppLocalizations l10n, String type) => switch (type) {
        'TOS' => l10n.consentTerms,
        'PRIVACY' => l10n.consentPrivacy,
        'MARKETING' => l10n.consentMarketing,
        'KYC' => l10n.kycConsentCheck,
        _ => type,
      };

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final locale = context.localeCode;
    final value = ref.watch(consentRequirementsProvider(locale));
    return value.when(
      loading: () => const SkeletonList(count: 3),
      error: (Object e, StackTrace s) => ErrorView(error: e, onRetry: () => ref.invalidate(consentRequirementsProvider(locale))),
      data: (ConsentRequirements requirements) {
        final group = requirements.signup;
        final allRequiredTicked = group.requiredItems.every((ConsentRequirement r) => _granted[r.type] ?? false);
        Widget item(ConsentRequirement r) {
          final title = r.title;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              CheckboxListTile(
                value: _granted[r.type] ?? false,
                onChanged: (bool? v) => setState(() => _granted[r.type] = v ?? false),
                controlAffinity: ListTileControlAffinity.leading,
                contentPadding: EdgeInsets.zero,
                title: Text(title == null || title.isEmpty ? _fallbackTitle(l10n, r.type) : title),
                subtitle: Text(
                  <String>[
                    r.isRequired ? l10n.consentRequired : l10n.consentOptional,
                    if (r.version != null) l10n.legalVersion(r.version!),
                  ].join(' · '),
                ),
              ),
              if (r.type != 'MARKETING')
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: () => openLegalDocument(context, r.type),
                    icon: const Icon(Icons.description_outlined, size: 18),
                    label: Text(l10n.legalReadDocument),
                  ),
                ),
            ],
          );
        }

        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(l10n.consentIntro, style: JkTypeScale.bodyM.copyWith(color: jk.onSurface)),
            const SizedBox(height: JkSpacing.s2),
            for (final r in group.requiredItems) item(r),
            for (final r in group.optionalItems) item(r),
            const SizedBox(height: JkSpacing.s2),
            Text(l10n.consentKycSeparate, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
            const SizedBox(height: JkSpacing.s4),
            JkButton(
              label: l10n.consentContinue,
              loading: widget.busy,
              onPressed: allRequiredTicked
                  ? () => widget.onSubmit(ConsentChoice(group: group, granted: Map<String, bool>.of(_granted)))
                  : null,
              disabledReason: allRequiredTicked ? null : l10n.consentNeedRequired,
            ),
          ],
        );
      },
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

/// The server's accepted version after `422 CONSENT_VERSION_INVALID {allowedVersions}` — only
/// hit when a document is republished while the form is open.
String? _allowedVersion(ApiException e) {
  final allowed = e.details['allowedVersions'];
  if (e.code == 'CONSENT_VERSION_INVALID' && allowed is List && allowed.isNotEmpty) return allowed.first.toString();
  return null;
}

/// Runs a login attempt; on `422 CONSENT_REQUIRED` (new account) collects the signup consents
/// listed by `GET /consents/requirements` and retries once with them.
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
    return await attempt(choice.toPayload());
  } on ApiException catch (e) {
    final version = _allowedVersion(e);
    if (version == null) rethrow;
    return attempt(choice.toPayload(versionOverride: version));
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
      for (final item in choice.toPayload()) {
        final type = item['type'].toString();
        final granted = item['granted'] == true;
        try {
          await repo.recordConsent(type: type, version: item['version'].toString(), granted: granted);
        } on ApiException catch (e) {
          final version = _allowedVersion(e);
          if (version == null) rethrow;
          await repo.recordConsent(type: type, version: version, granted: granted);
        }
      }
      if (!mounted) return;
      ref.invalidate(consentRequirementsProvider);
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
