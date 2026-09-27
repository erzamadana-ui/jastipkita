import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/format/dates.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/engagement.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/common.dart';
import '../../../widgets/countdown_chip.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../../../widgets/money_text.dart';
import '../../../widgets/sheets_and_glass.dart';
import '../../../widgets/states.dart';
import '../../../widgets/status_timeline.dart';
import '../../engagement/data/engagement_repository.dart';
import '../../files/data/file_upload_service.dart';
import 'disputes_screen.dart';

/// Dispute detail: status flow OPEN → EVIDENCE_COLLECTION → UNDER_REVIEW → RESOLVED → (APPEALED)
/// → CLOSED with SLA countdowns, evidence (add), resolution, appeal once, withdraw.
class DisputeDetailScreen extends ConsumerStatefulWidget {
  const DisputeDetailScreen({super.key, required this.disputeId});

  final String disputeId;

  @override
  ConsumerState<DisputeDetailScreen> createState() => _DisputeDetailScreenState();
}

class _DisputeDetailScreenState extends ConsumerState<DisputeDetailScreen> {
  String? _busy;

  void _reload() => ref.invalidate(disputeDetailProvider(widget.disputeId));

  Future<void> _addEvidence() async {
    final l10n = context.l10n;
    final done = await showJkBottomSheet<bool>(
      context,
      title: l10n.disputeAddEvidence,
      builder: (BuildContext sheetContext) => _EvidenceForm(disputeId: widget.disputeId),
    );
    if (done != true) return;
    if (!mounted) return;
    showJkSnack(context, l10n.disputeEvidenceAdded);
    _reload();
  }

  Future<void> _textAction(String key, String title, String label, Future<Object?> Function(String text) action, String success) async {
    final l10n = context.l10n;
    final controller = TextEditingController();
    final ok = await showJkConfirm(
      context,
      title: title,
      message: l10n.disputeActionIntro,
      confirmLabel: label,
      extra: JkTextField(label: l10n.reasonLabel, controller: controller, maxLines: 3),
    );
    final text = controller.text.trim();
    controller.dispose();
    if (!ok) return;
    if (!mounted) return;
    setState(() => _busy = key);
    try {
      await action(text.isEmpty ? l10n.cancelReasonDefault : text);
      if (!mounted) return;
      showJkSnack(context, success);
      _reload();
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  List<TimelineStep> _steps(AppLocalizations l10n, Dispute d, String locale) {
    final flow = List<String>.of(DisputeType.statusFlow);
    final appealed = d.timeline.any((DisputeTimelineEntry e) => e.to == 'APPEALED');
    if (appealed) flow.insert(flow.length - 1, 'APPEALED');
    final currentIndex = flow.indexOf(d.status);
    return <TimelineStep>[
      for (var i = 0; i < flow.length; i++)
        TimelineStep(
          label: Labels.disputeStatus(l10n, flow[i]),
          state: d.status == 'CLOSED' || i < currentIndex
              ? TimelineNodeState.done
              : i == currentIndex
                  ? TimelineNodeState.current
                  : TimelineNodeState.upcoming,
          meta: _firstAt(d, flow[i], locale),
        ),
    ];
  }

  String? _firstAt(Dispute d, String status, String locale) {
    for (final e in d.timeline) {
      final at = e.at;
      if (e.to == status && at != null) return JkDates.shortDateTime(at, locale);
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final value = ref.watch(disputeDetailProvider(widget.disputeId));
    return Scaffold(
      appBar: AppBar(title: Text(l10n.disputeDetailTitle)),
      body: AsyncValueView<Dispute>(
        value: value,
        onRetry: _reload,
        data: (Dispute d) {
          final jk = context.jk;
          final locale = context.localeCode;
          final evidenceDue = d.evidenceDueAt;
          final sla = d.slaDueAt;
          final appealDeadline = d.appealDeadline;
          final resolution = d.resolution;
          final repo = ref.read(engagementRepositoryProvider);
          return JkRefresh(
            onRefresh: () => refreshSafely(() {
              _reload();
              return ref.read(disputeDetailProvider(widget.disputeId).future);
            }),
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(JkSpacing.s5),
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Expanded(child: Text(d.number, style: JkTypeScale.titleM.copyWith(color: jk.onBackground))),
                    StatusChip(label: Labels.disputeStatus(l10n, d.status), tone: disputeTone(context, d.status)),
                  ],
                ),
                const SizedBox(height: 4),
                InkWell(
                  onTap: () => context.push(Routes.transaction(d.transactionId)),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Text(l10n.disputeForTransaction(d.transactionNumber), style: JkTypeScale.bodyS.copyWith(color: jk.link)),
                  ),
                ),
                const SizedBox(height: JkSpacing.s3),
                Wrap(
                  spacing: JkSpacing.s2,
                  runSpacing: JkSpacing.s2,
                  children: <Widget>[
                    if (evidenceDue != null && d.status == 'EVIDENCE_COLLECTION')
                      CountdownChip(expiresAt: evidenceDue, label: l10n.disputeEvidenceDue, icon: Icons.upload_file_outlined),
                    if (sla != null && d.status != 'RESOLVED' && d.status != 'CLOSED')
                      CountdownChip(expiresAt: sla, label: l10n.disputeSla, icon: Icons.schedule),
                    if (appealDeadline != null && d.canAppeal)
                      CountdownChip(expiresAt: appealDeadline, label: l10n.disputeAppealWindow, icon: Icons.gavel_outlined),
                  ],
                ),
                const SizedBox(height: JkSpacing.s4),
                JkCard(child: StatusTimeline(steps: _steps(l10n, d, locale))),
                const SizedBox(height: JkSpacing.s4),
                JkCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      KeyValue(label: l10n.disputeTypeLabel, value: Text(Labels.disputeType(l10n, d.type))),
                      const SizedBox(height: JkSpacing.s2),
                      KeyValue(label: l10n.disputeDescription, value: Text(d.description)),
                      if (d.requestedResolution != null) ...<Widget>[
                        const SizedBox(height: JkSpacing.s2),
                        KeyValue(label: l10n.disputeRequestedResolution, value: Text(Labels.resolution(l10n, d.requestedResolution!))),
                      ],
                    ],
                  ),
                ),
                if (resolution != null) ...<Widget>[
                  const SizedBox(height: JkSpacing.s4),
                  JkCard(
                    color: jk.successContainer,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(l10n.disputeResolution, style: JkTypeScale.titleS.copyWith(color: jk.onSuccessContainer)),
                        const SizedBox(height: 4),
                        Text(Labels.resolution(l10n, resolution), style: JkTypeScale.bodyL.copyWith(color: jk.onSuccessContainer)),
                        if (d.resolutionAmountIdr != null) MoneyText(d.resolutionAmountIdr!, size: MoneySize.m, color: jk.onSuccessContainer),
                        if (d.resolutionNote != null) Text(d.resolutionNote!, style: JkTypeScale.bodyS.copyWith(color: jk.onSuccessContainer)),
                      ],
                    ),
                  ),
                ],
                SectionHeader(title: l10n.disputeEvidence),
                if (d.evidence.isEmpty)
                  Text(l10n.disputeNoEvidence, style: JkTypeScale.bodyM.copyWith(color: jk.onBackgroundMuted))
                else
                  for (final e in d.evidence)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(e.fileId == null ? Icons.notes : Icons.image_outlined, color: jk.secondary),
                      title: Text(Labels.evidenceType(l10n, e.type)),
                      subtitle: Text(
                        <String>[
                          if (e.mine) l10n.evidenceMine else e.party,
                          if (e.note != null) e.note!,
                          if (e.createdAt != null) JkDates.shortDateTime(e.createdAt!, locale),
                        ].join(' · '),
                      ),
                    ),
                const SizedBox(height: JkSpacing.s4),
                if (d.canAddEvidence)
                  JkButton(label: l10n.disputeAddEvidence, icon: Icons.add_photo_alternate_outlined, variant: JkButtonVariant.tonal, onPressed: _addEvidence),
                if (d.canAppeal) ...<Widget>[
                  const SizedBox(height: JkSpacing.s2),
                  JkButton(
                    label: l10n.disputeAppeal,
                    variant: JkButtonVariant.secondary,
                    loading: _busy == 'appeal',
                    onPressed: _busy == null
                        ? () => _textAction('appeal', l10n.disputeAppeal, l10n.disputeAppeal, (String t) => repo.appeal(d.id, t), l10n.disputeAppealed)
                        : null,
                  ),
                ],
                if (d.canWithdraw) ...<Widget>[
                  const SizedBox(height: JkSpacing.s2),
                  JkButton(
                    label: l10n.disputeWithdraw,
                    variant: JkButtonVariant.tertiary,
                    loading: _busy == 'withdraw',
                    onPressed: _busy == null
                        ? () => _textAction(
                              'withdraw',
                              l10n.disputeWithdraw,
                              l10n.disputeWithdraw,
                              (String t) => repo.withdrawDispute(d.id, reason: t),
                              l10n.disputeWithdrawn,
                            )
                        : null,
                  ),
                ],
                const SizedBox(height: JkSpacing.s2),
                JkButton(
                  label: l10n.helpWithTransaction,
                  variant: JkButtonVariant.tertiary,
                  onPressed: () => context.push('${Routes.newTicket}?disputeId=${d.id}'),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _EvidenceForm extends ConsumerStatefulWidget {
  const _EvidenceForm({required this.disputeId});

  final String disputeId;

  @override
  ConsumerState<_EvidenceForm> createState() => _EvidenceFormState();
}

class _EvidenceFormState extends ConsumerState<_EvidenceForm> {
  String _type = 'PHOTO';
  final TextEditingController _note = TextEditingController();
  PickedUpload? _file;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _pick() async {
    final picker = ref.read(mediaPickerProvider);
    final file = _type == 'VIDEO' ? await picker.video() : await picker.image(camera: false);
    if (file == null || !mounted) return;
    setState(() => _file = file);
  }

  Future<void> _submit() async {
    final file = _file;
    if (file == null && _note.text.trim().isEmpty) {
      setState(() => _error = context.l10n.disputeEvidenceEmpty);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final fileId = file == null ? null : await ref.read(fileUploadServiceProvider).upload(file, purpose: FilePurpose.evidence);
      await ref.read(engagementRepositoryProvider).addEvidence(widget.disputeId, type: _type, fileId: fileId, note: _note.text.trim());
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = errorMessage(context.l10n, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final file = _file;
    final error = _error;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Wrap(
          spacing: JkSpacing.s2,
          runSpacing: JkSpacing.s2,
          children: <Widget>[
            for (final t in DisputeType.evidenceTypes)
              ChoiceChip(label: Text(Labels.evidenceType(l10n, t)), selected: _type == t, onSelected: (bool v) => setState(() => _type = t)),
          ],
        ),
        const SizedBox(height: JkSpacing.s3),
        JkButton(label: l10n.pickFile, icon: Icons.attach_file, variant: JkButtonVariant.secondary, onPressed: _busy ? null : _pick),
        if (file != null) Text(l10n.fileSelected(file.name), style: JkTypeScale.bodyS.copyWith(color: context.jk.successText)),
        const SizedBox(height: JkSpacing.s3),
        JkTextField(label: l10n.evidenceNote, controller: _note, maxLines: 3, minLines: 1),
        if (error != null) NoticeBox(tone: NoticeTone.error, message: error),
        const SizedBox(height: JkSpacing.s4),
        JkButton(label: l10n.disputeAddEvidence, loading: _busy, onPressed: _submit),
      ],
    );
  }
}
