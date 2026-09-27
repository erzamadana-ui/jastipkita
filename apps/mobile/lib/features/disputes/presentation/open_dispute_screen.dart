import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../../engagement/data/engagement_repository.dart';
import '../../files/data/file_upload_service.dart';
import '../../transactions/data/transaction_repository.dart';
import '../../transactions/presentation/traveler_action_screens.dart';

/// Open a dispute (§6.12): type (7 domain types) → description → evidence → requested
/// resolution → funds-impact summary → submit. Everything opaque.
class OpenDisputeScreen extends ConsumerStatefulWidget {
  const OpenDisputeScreen({super.key, required this.transactionId});

  final String transactionId;

  @override
  ConsumerState<OpenDisputeScreen> createState() => _OpenDisputeScreenState();
}

class _OpenDisputeScreenState extends ConsumerState<OpenDisputeScreen> {
  String? _type;
  String _resolution = 'REFUND_FULL';
  final TextEditingController _description = TextEditingController();
  final List<PickedUpload> _evidence = <PickedUpload>[];
  bool _busy = false;
  String? _progress;
  String? _error;

  @override
  void dispose() {
    _description.dispose();
    super.dispose();
  }

  Future<void> _addEvidence() async {
    final picked = await ref.read(mediaPickerProvider).image(camera: false);
    if (picked == null || !mounted) return;
    setState(() => _evidence.add(picked));
  }

  Future<void> _submit() async {
    final l10n = context.l10n;
    final type = _type;
    if (type == null || _description.text.trim().length < 10) {
      setState(() => _error = type == null ? l10n.disputeChooseType : l10n.disputeDescribe);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final repo = ref.read(engagementRepositoryProvider);
    try {
      final dispute = await repo.openDispute(
        widget.transactionId,
        type: type,
        description: _description.text.trim(),
        requestedResolution: _resolution,
      );
      final uploader = ref.read(fileUploadServiceProvider);
      for (var i = 0; i < _evidence.length; i++) {
        if (mounted) setState(() => _progress = l10n.uploadProgress(i + 1, _evidence.length));
        final fileId = await uploader.upload(_evidence[i], purpose: FilePurpose.evidence);
        await repo.addEvidence(dispute.id, type: 'PHOTO', fileId: fileId);
      }
      if (!mounted) return;
      ref.invalidate(transactionDetailProvider(widget.transactionId));
      showJkSnack(context, l10n.disputeOpened(dispute.number));
      context.pushReplacement(Routes.dispute(dispute.id));
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = errorMessage(l10n, e));
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _progress = null;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final error = _error;
    final progress = _progress;
    const gap = SizedBox(height: JkSpacing.s4);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.disputeOpen)),
      body: ListView(
        padding: const EdgeInsets.all(JkSpacing.s5),
        children: <Widget>[
          NoticeBox(message: l10n.disputeIntro),
          gap,
          Text(l10n.disputeTypeLabel, style: JkTypeScale.labelL.copyWith(color: jk.onSurface)),
          const SizedBox(height: 6),
          Wrap(
            spacing: JkSpacing.s2,
            runSpacing: JkSpacing.s2,
            children: <Widget>[
              for (final t in DisputeType.all)
                ChoiceChip(label: Text(Labels.disputeType(l10n, t)), selected: _type == t, onSelected: (bool v) => setState(() => _type = t)),
            ],
          ),
          gap,
          JkTextField(label: l10n.disputeDescription, controller: _description, maxLines: 6, minLines: 3, maxLength: 2000),
          gap,
          UploadSlot(
            label: l10n.disputeEvidence,
            files: _evidence,
            max: 8,
            onAdd: _busy ? null : _addEvidence,
            onRemove: (int i) => setState(() => _evidence.removeAt(i)),
            helper: l10n.disputeEvidenceHelp,
          ),
          gap,
          Text(l10n.disputeRequestedResolution, style: JkTypeScale.labelL.copyWith(color: jk.onSurface)),
          const SizedBox(height: 6),
          Wrap(
            spacing: JkSpacing.s2,
            runSpacing: JkSpacing.s2,
            children: <Widget>[
              for (final r in DisputeType.resolutions)
                ChoiceChip(label: Text(Labels.resolution(l10n, r)), selected: _resolution == r, onSelected: (bool v) => setState(() => _resolution = r)),
            ],
          ),
          gap,
          NoticeBox(tone: NoticeTone.warning, title: l10n.disputeImpactTitle, message: l10n.disputeImpactBody),
          if (error != null) ...<Widget>[gap, NoticeBox(tone: NoticeTone.error, message: error)],
          if (progress != null) ...<Widget>[const SizedBox(height: JkSpacing.s2), Text(progress)],
          const SizedBox(height: JkSpacing.s5),
          JkButton(label: l10n.disputeSubmit, variant: JkButtonVariant.destructive, loading: _busy, onPressed: _submit),
        ],
      ),
    );
  }
}
