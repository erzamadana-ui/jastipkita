import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/format/dates.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/account.dart';
import '../../../core/network/api_exception.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../../../widgets/states.dart';
import '../../auth/application/session_controller.dart';
import '../../auth/data/auth_repository.dart';
import '../../files/data/file_upload_service.dart';

final _privacyRequestsProvider = FutureProvider.autoDispose<List<PrivacyRequest>>(
  (ref) => ref.watch(authRepositoryProvider).privacyRequests(),
);

final _consentsProvider = FutureProvider.autoDispose<ConsentState>((ref) => ref.watch(authRepositoryProvider).consents());

/// Privacy & data (UU PDP; Play / App Store account-deletion requirement): export my data,
/// marketing consent, delete account (14-day grace, cancellable).
class PrivacyScreen extends ConsumerStatefulWidget {
  const PrivacyScreen({super.key});

  @override
  ConsumerState<PrivacyScreen> createState() => _PrivacyScreenState();
}

class _PrivacyScreenState extends ConsumerState<PrivacyScreen> {
  String? _busy;
  final TextEditingController _reason = TextEditingController();

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _run(String key, Future<void> Function() action, String success) async {
    setState(() => _busy = key);
    try {
      await action();
      if (!mounted) return;
      showJkSnack(context, success);
      ref.invalidate(_privacyRequestsProvider);
      ref.invalidate(_consentsProvider);
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _viewExport(String fileId) async {
    setState(() => _busy = 'view');
    try {
      final text = await ref.read(fileUploadServiceProvider).downloadText(fileId);
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (BuildContext dialogContext) {
          final l10n = dialogContext.l10n;
          return AlertDialog(
            title: Text(l10n.privacyExportViewTitle),
            content: SizedBox(
              width: double.maxFinite,
              child: SingleChildScrollView(child: SelectableText(text, style: JkTypeScale.bodyS)),
            ),
            actions: <Widget>[
              TextButton(
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: text));
                  Navigator.of(dialogContext).pop();
                },
                child: Text(l10n.actionCopy),
              ),
              TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: Text(l10n.actionClose)),
            ],
          );
        },
      );
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _deleteAccount() async {
    final l10n = context.l10n;
    _reason.clear();
    final ok = await showJkConfirm(
      context,
      title: l10n.deleteAccountTitle,
      message: l10n.deleteAccountBody,
      confirmLabel: l10n.deleteAccountConfirm,
      destructive: true,
      extra: JkTextField(label: l10n.reasonOptional, controller: _reason, maxLines: 2),
    );
    if (!ok) return;
    if (!mounted) return;
    setState(() => _busy = 'delete');
    try {
      await ref.read(authRepositoryProvider).deleteAccount(reason: _reason.text.trim());
      if (!mounted) return;
      showJkSnack(context, l10n.deleteAccountScheduled);
      await ref.read(sessionControllerProvider.notifier).signOut();
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final locale = context.localeCode;
    final profile = ref.watch(currentProfileProvider);
    final requests = ref.watch(_privacyRequestsProvider);
    final consents = ref.watch(_consentsProvider);
    final repo = ref.read(authRepositoryProvider);
    final scheduled = profile?.deletionScheduledFor;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.privacyTitle)),
      body: ListView(
        padding: const EdgeInsets.all(JkSpacing.s5),
        children: <Widget>[
          Text(l10n.privacyIntro, style: JkTypeScale.bodyM.copyWith(color: jk.onBackground)),
          SectionHeader(title: l10n.privacyConsents),
          consents.when(
            data: (ConsentState c) => SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: c.isGranted('MARKETING'),
              onChanged: _busy != null
                  ? null
                  : (bool v) => _run(
                        'marketing',
                        () async {
                          // Version from `GET /consents/requirements`; the API rejects any other.
                          final requirements = await repo.consentRequirements(locale: locale);
                          final version = requirements.byType('MARKETING')?.versionToSend;
                          if (version == null) throw const ApiException(code: 'CONSENT_VERSION_UNAVAILABLE');
                          await repo.recordConsent(type: 'MARKETING', version: version, granted: v);
                        },
                        l10n.consentSaved,
                      ),
              title: Text(l10n.consentMarketing),
              subtitle: Text(l10n.consentMarketingHelp),
            ),
            loading: () => const Skeleton(height: 56),
            error: (Object e, StackTrace s) => ErrorView(error: e, compact: true, onRetry: () => ref.invalidate(_consentsProvider)),
          ),
          SectionHeader(title: l10n.privacyExportTitle),
          Text(l10n.privacyExportBody, style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted)),
          const SizedBox(height: JkSpacing.s2),
          JkButton(
            label: l10n.privacyExportRequest,
            icon: Icons.download_outlined,
            variant: JkButtonVariant.secondary,
            loading: _busy == 'export',
            onPressed: _busy == null ? () => _run('export', () => repo.requestExport(), l10n.privacyExportRequested) : null,
          ),
          requests.when(
            data: (List<PrivacyRequest> list) => Column(
              children: <Widget>[
                for (final r in list)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(r.type == 'EXPORT' ? Icons.inventory_outlined : Icons.delete_outline),
                    title: Text(r.type == 'EXPORT' ? l10n.privacyExportTitle : l10n.deleteAccountTitle),
                    subtitle: Text(
                      <String>[
                        Labels.privacyStatus(l10n, r.status),
                        if (r.createdAt != null) JkDates.date(r.createdAt!, locale),
                      ].join(' · '),
                    ),
                    trailing: r.exportFileId != null && r.status == 'COMPLETED'
                        ? TextButton(onPressed: _busy == null ? () => _viewExport(r.exportFileId!) : null, child: Text(l10n.privacyExportView))
                        : null,
                  ),
              ],
            ),
            loading: () => const SizedBox.shrink(),
            error: (Object e, StackTrace s) => ErrorView(error: e, compact: true, onRetry: () => ref.invalidate(_privacyRequestsProvider)),
          ),
          SectionHeader(title: l10n.deleteAccountTitle),
          if (scheduled != null) ...<Widget>[
            NoticeBox(tone: NoticeTone.error, message: l10n.deletionScheduledOn(JkDates.date(scheduled, locale))),
            const SizedBox(height: JkSpacing.s2),
            JkButton(
              label: l10n.deletionCancel,
              variant: JkButtonVariant.secondary,
              loading: _busy == 'cancel-deletion',
              onPressed: _busy == null
                  ? () => _run('cancel-deletion', () async {
                        await repo.cancelDeletion();
                        await ref.read(sessionControllerProvider.notifier).refreshProfile();
                      }, l10n.deletionCancelled)
                  : null,
            ),
          ] else ...<Widget>[
            Text(l10n.deleteAccountExplain, style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted)),
            const SizedBox(height: JkSpacing.s2),
            JkButton(
              label: l10n.deleteAccountTitle,
              icon: Icons.delete_forever_outlined,
              variant: JkButtonVariant.destructive,
              loading: _busy == 'delete',
              onPressed: _busy == null ? _deleteAccount : null,
            ),
          ],
        ],
      ),
    );
  }
}
