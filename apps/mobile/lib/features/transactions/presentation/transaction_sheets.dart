import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/haptics.dart';
import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/format/money.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/transaction.dart';
import '../../../core/storage/settings.dart';
import '../../../widgets/common.dart';
import '../../../widgets/countdown_chip.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../../../widgets/money_text.dart';
import '../../../widgets/sheets_and_glass.dart';
import '../../files/data/file_upload_service.dart';
import '../data/transaction_repository.dart';

void _refreshTransaction(WidgetRef ref, String id) {
  ref.invalidate(transactionDetailProvider(id));
  ref.invalidate(transactionTimelineProvider(id));
  ref.invalidate(activeTransactionsProvider('buyer'));
  ref.invalidate(activeTransactionsProvider('traveler'));
}

/// Price confirmation (§6.7 ★): secured vs actual price, countdown (expired = reject),
/// Approve / Ask traveler (clarify) / Reject & refund (no-fault full refund).
Future<void> showPriceConfirmationSheet(BuildContext context, WidgetRef ref, TransactionDetail detail, PriceConfirmation pc) async {
  await showJkBottomSheet<void>(
    context,
    title: context.l10n.pcTitle,
    builder: (BuildContext sheetContext) => _PriceConfirmationBody(detail: detail, pc: pc),
  );
  _refreshTransaction(ref, detail.id);
}

class _PriceConfirmationBody extends ConsumerStatefulWidget {
  const _PriceConfirmationBody({required this.detail, required this.pc});

  final TransactionDetail detail;
  final PriceConfirmation pc;

  @override
  ConsumerState<_PriceConfirmationBody> createState() => _PriceConfirmationBodyState();
}

class _PriceConfirmationBodyState extends ConsumerState<_PriceConfirmationBody> {
  final TextEditingController _note = TextEditingController();
  String? _busy;
  String? _error;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _respond(String action) async {
    final l10n = context.l10n;
    if (action == 'REJECT') {
      final ok = await showJkConfirm(
        context,
        title: l10n.pcRejectTitle,
        message: l10n.pcRejectBody,
        confirmLabel: l10n.pcReject,
        destructive: true,
      );
      if (!ok) return;
    }
    if (action == 'CLARIFY' && _note.text.trim().isEmpty) {
      setState(() => _error = l10n.pcClarifyNeedsNote);
      return;
    }
    if (!mounted) return;
    setState(() {
      _busy = action;
      _error = null;
    });
    final haptics = ref.read(settingsProvider).haptics;
    try {
      final result = await ref.read(transactionRepositoryProvider).respondPriceConfirmation(
            widget.detail.id,
            widget.pc.id,
            action: action,
            note: _note.text.trim(),
          );
      if (!mounted) return;
      if (action == 'APPROVE') JkHaptics.success(haptics);
      final supplemental = result.supplementalPayment;
      final message = action == 'APPROVE'
          ? (supplemental != null ? l10n.pcApprovedSupplemental : l10n.pcApproved)
          : action == 'REJECT'
              ? l10n.pcRejected
              : l10n.pcClarifySent;
      showJkSnack(context, message);
      Navigator.of(context).pop();
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = errorMessage(l10n, e));
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final pc = widget.pc;
    final locale = context.localeCode;
    final expires = pc.expiresAt;
    final waitingTraveler = pc.status == 'CLARIFICATION_REQUESTED';
    final diff = pc.differenceIdr;
    final pct = (pc.differenceBps / 100).toStringAsFixed(1);
    final error = _error;
    final notes = pc.notes;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (expires != null)
          Align(
            alignment: Alignment.centerLeft,
            child: CountdownChip(expiresAt: expires, label: l10n.pcWindowLabel, icon: Icons.timer_outlined),
          ),
        const SizedBox(height: JkSpacing.s3),
        Text(l10n.pcExplain, style: JkTypeScale.bodyM.copyWith(color: jk.onSurface)),
        const SizedBox(height: JkSpacing.s3),
        JkCard(
          child: Column(
            children: <Widget>[
              _cmp(context, l10n.pcSecuredPrice, pc.originalIdr, Money.minor(pc.originalPriceMinor, pc.currency, locale: locale)),
              const Divider(height: JkSpacing.s5),
              _cmp(context, l10n.pcActualPrice, pc.actualIdr, Money.minor(pc.actualPriceMinor, pc.currency, locale: locale)),
              const Divider(height: JkSpacing.s5),
              LabeledAmount(
                label: Text(l10n.pcDifference(pct), style: JkTypeScale.bodyM.copyWith(color: jk.onSurface)),
                amount: MoneyText(diff, color: diff > 0 ? jk.warningText : jk.successText, emphasized: true, semanticsPrefix: l10n.pcDifference(pct)),
              ),
            ],
          ),
        ),
        if (pc.supplementalRequiredIdr > 0) ...<Widget>[
          const SizedBox(height: JkSpacing.s3),
          NoticeBox(tone: NoticeTone.warning, message: l10n.pcSupplemental(Money.idr(pc.supplementalRequiredIdr, locale: locale))),
        ],
        if (notes != null && notes.isNotEmpty) ...<Widget>[
          const SizedBox(height: JkSpacing.s3),
          NoticeBox(title: l10n.pcTravelerNote, message: notes),
        ],
        if (pc.receiptFileId != null) ...<Widget>[
          const SizedBox(height: JkSpacing.s2),
          Text(l10n.pcReceiptAttached, style: JkTypeScale.bodyS.copyWith(color: jk.successText)),
        ],
        const SizedBox(height: JkSpacing.s3),
        if (waitingTraveler)
          NoticeBox(message: l10n.pcWaitingTraveler)
        else
          JkTextField(label: l10n.pcNoteLabel, controller: _note, maxLines: 3, minLines: 1, hint: l10n.pcNoteHint),
        if (error != null) ...<Widget>[
          const SizedBox(height: JkSpacing.s2),
          NoticeBox(tone: NoticeTone.error, message: error),
        ],
        const SizedBox(height: JkSpacing.s4),
        if (!waitingTraveler) ...<Widget>[
          JkButton(
            label: l10n.pcApprove,
            icon: Icons.check_circle_outline,
            loading: _busy == 'APPROVE',
            onPressed: _busy == null ? () => _respond('APPROVE') : null,
          ),
          const SizedBox(height: JkSpacing.s2),
          JkButton(
            label: l10n.pcAskTraveler,
            variant: JkButtonVariant.secondary,
            loading: _busy == 'CLARIFY',
            onPressed: _busy == null ? () => _respond('CLARIFY') : null,
          ),
          const SizedBox(height: JkSpacing.s2),
        ],
        JkButton(
          label: l10n.pcReject,
          variant: JkButtonVariant.destructive,
          loading: _busy == 'REJECT',
          onPressed: _busy == null ? () => _respond('REJECT') : null,
        ),
        const SizedBox(height: JkSpacing.s2),
        Text(l10n.pcNoFault, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
      ],
    );
  }

  Widget _cmp(BuildContext context, String label, int idr, String original) {
    final jk = context.jk;
    return LabeledAmount(
      label: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(label, style: JkTypeScale.bodyM.copyWith(color: jk.onSurface)),
          Text(original, style: JkTypeScale.moneyS.copyWith(color: jk.onSurfaceMuted)),
        ],
      ),
      amount: MoneyText(idr, size: MoneySize.m, semanticsPrefix: label),
    );
  }
}

/// Cancellation with a pre-confirmation preview of the matrix stage; the exact refund /
/// compensation / Trust-Score impact returned by the API is shown afterwards.
Future<void> cancelTransactionFlow(BuildContext context, WidgetRef ref, TransactionDetail detail) async {
  final l10n = context.l10n;
  final stage = TxStatus.cancellationStage(detail.status);
  final reason = TextEditingController();
  final ok = await showJkConfirm(
    context,
    title: l10n.cancelTitle,
    message: l10n.cancelStageIntro(Labels.cancellationStage(l10n, stage)),
    confirmLabel: l10n.cancelConfirm,
    destructive: true,
    extra: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        NoticeBox(tone: NoticeTone.warning, message: Labels.cancellationStageHint(l10n, stage)),
        const SizedBox(height: JkSpacing.s3),
        JkTextField(label: l10n.cancelReasonLabel, controller: reason, maxLines: 2),
      ],
    ),
  );
  final text = reason.text.trim();
  reason.dispose();
  if (!ok) return;
  try {
    final result = await ref.read(transactionRepositoryProvider).cancel(
          detail.id,
          reason: text.isEmpty ? l10n.cancelReasonDefault : text,
        );
    _refreshTransaction(ref, detail.id);
    if (!context.mounted) return;
    final outcome = result.cancellation;
    await showJkBottomSheet<void>(
      context,
      title: l10n.cancelDoneTitle,
      builder: (BuildContext sheetContext) {
        final jk = sheetContext.jk;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              l10n.cancelDoneStatus(Labels.txStatus(l10n, result.transactionStatus ?? TxStatus.cancelled)),
              style: JkTypeScale.bodyM.copyWith(color: jk.onSurface),
            ),
            if (outcome != null) ...<Widget>[
              const SizedBox(height: JkSpacing.s3),
              KeyValue(label: l10n.cancelStageLabel, value: Text(Labels.cancellationStage(l10n, outcome.stage))),
              const SizedBox(height: JkSpacing.s2),
              KeyValue(label: l10n.cancelRefund, value: MoneyText(outcome.refundIdr, size: MoneySize.m)),
              if (outcome.travelerCompensationIdr > 0) ...<Widget>[
                const SizedBox(height: JkSpacing.s2),
                KeyValue(label: l10n.cancelCompensation, value: MoneyText(outcome.travelerCompensationIdr)),
              ],
              const SizedBox(height: JkSpacing.s2),
              KeyValue(label: l10n.cancelTrustPenalty, value: Text('${outcome.trustPenalty}')),
            ],
            const SizedBox(height: JkSpacing.s3),
            Text(l10n.cancelRefundNote, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
          ],
        );
      },
    );
  } on Object catch (e) {
    if (!context.mounted) return;
    showJkSnack(context, errorMessage(l10n, e), error: true);
  }
}

/// Rating after COMPLETED (once per side, within 14 days).
Future<void> showRatingSheet(BuildContext context, String transactionId) {
  return showJkBottomSheet<void>(
    context,
    title: context.l10n.ratingTitle,
    builder: (BuildContext sheetContext) => _RatingBody(transactionId: transactionId),
  );
}

class _RatingBody extends ConsumerStatefulWidget {
  const _RatingBody({required this.transactionId});

  final String transactionId;

  @override
  ConsumerState<_RatingBody> createState() => _RatingBodyState();
}

class _RatingBodyState extends ConsumerState<_RatingBody> {
  int _overall = 0;
  int _communication = 0;
  int _accuracy = 0;
  int _timeliness = 0;
  final TextEditingController _comment = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(transactionRepositoryProvider).rate(
            widget.transactionId,
            overall: _overall,
            communication: _communication == 0 ? null : _communication,
            accuracy: _accuracy == 0 ? null : _accuracy,
            timeliness: _timeliness == 0 ? null : _timeliness,
            comment: _comment.text.trim(),
          );
      if (!mounted) return;
      showJkSnack(context, context.l10n.ratingThanks);
      Navigator.of(context).pop();
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = errorMessage(context.l10n, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _stars(String label, int value, ValueChanged<int> onChanged) {
    final jk = context.jk;
    final l10n = context.l10n;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(label, style: JkTypeScale.labelL.copyWith(color: jk.onSurface)),
        Wrap(
          children: <Widget>[
            for (var i = 1; i <= 5; i++)
              IconButton(
                tooltip: l10n.ratingStars(i),
                onPressed: () => onChanged(i),
                icon: Icon(i <= value ? Icons.star_rounded : Icons.star_outline_rounded, color: jk.warning, size: 32),
              ),
          ],
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final error = _error;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        _stars(l10n.ratingOverall, _overall, (int v) => setState(() => _overall = v)),
        _stars(l10n.ratingCommunication, _communication, (int v) => setState(() => _communication = v)),
        _stars(l10n.ratingAccuracy, _accuracy, (int v) => setState(() => _accuracy = v)),
        _stars(l10n.ratingTimeliness, _timeliness, (int v) => setState(() => _timeliness = v)),
        JkTextField(label: l10n.ratingComment, controller: _comment, maxLines: 3, minLines: 2, maxLength: 1000),
        if (error != null) NoticeBox(tone: NoticeTone.error, message: error),
        const SizedBox(height: JkSpacing.s3),
        JkButton(label: l10n.ratingSubmit, loading: _busy, onPressed: _overall == 0 ? null : _submit),
      ],
    );
  }
}

/// Bank account for a refund on a channel that cannot be refunded automatically (e.g. VA).
Future<void> showRefundDestinationSheet(BuildContext context, WidgetRef ref, String transactionId, RefundInfo refund) async {
  await showJkBottomSheet<void>(
    context,
    title: context.l10n.refundDestinationTitle,
    builder: (BuildContext sheetContext) => _BankForm(
      submitLabel: sheetContext.l10n.refundDestinationSubmit,
      intro: sheetContext.l10n.refundDestinationIntro(Money.idr(refund.amountIdr, locale: sheetContext.localeCode)),
      onSubmit: (String bank, String number, String holder) async {
        await ref.read(transactionRepositoryProvider).setRefundDestination(
              refund.id,
              bankCode: bank,
              accountNumber: number,
              accountHolderName: holder,
            );
      },
    ),
  );
  _refreshTransaction(ref, transactionId);
}

/// Bank-account form shared by refund destination and payout accounts. The number is sent once
/// and never kept by the app; afterwards only the API's mask is shown.
class BankAccountForm extends StatelessWidget {
  const BankAccountForm({super.key, required this.submitLabel, required this.onSubmit, this.intro});

  final String submitLabel;
  final String? intro;
  final Future<void> Function(String bankCode, String accountNumber, String holderName) onSubmit;

  @override
  Widget build(BuildContext context) => _BankForm(submitLabel: submitLabel, onSubmit: onSubmit, intro: intro);
}

const List<String> kBankCodes = <String>['BCA', 'MANDIRI', 'BNI', 'BRI', 'BSI', 'CIMB', 'PERMATA', 'DANAMON', 'BTN', 'JAGO', 'SEABANK'];

class _BankForm extends StatefulWidget {
  const _BankForm({required this.submitLabel, required this.onSubmit, this.intro});

  final String submitLabel;
  final String? intro;
  final Future<void> Function(String bankCode, String accountNumber, String holderName) onSubmit;

  @override
  State<_BankForm> createState() => _BankFormState();
}

class _BankFormState extends State<_BankForm> {
  String _bank = kBankCodes.first;
  final TextEditingController _number = TextEditingController();
  final TextEditingController _holder = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _number.dispose();
    _holder.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final number = _number.text.replaceAll(RegExp(r'[^0-9]'), '');
    final holder = _holder.text.trim();
    if (number.length < 6 || holder.length < 2) {
      setState(() => _error = context.l10n.bankFormInvalid);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.onSubmit(_bank, number, holder);
      if (!mounted) return;
      _number.clear();
      Navigator.of(context).pop();
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
    final intro = widget.intro;
    final error = _error;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (intro != null) ...<Widget>[
          Text(intro, style: JkTypeScale.bodyM.copyWith(color: context.jk.onSurface)),
          const SizedBox(height: JkSpacing.s3),
        ],
        Text(l10n.bankLabel, style: JkTypeScale.labelL.copyWith(color: context.jk.onSurface)),
        const SizedBox(height: 6),
        Wrap(
          spacing: JkSpacing.s2,
          runSpacing: JkSpacing.s2,
          children: <Widget>[
            for (final b in kBankCodes)
              ChoiceChip(label: Text(b), selected: _bank == b, onSelected: (bool v) => setState(() => _bank = b)),
          ],
        ),
        const SizedBox(height: JkSpacing.s3),
        JkTextField(
          label: l10n.bankAccountNumber,
          controller: _number,
          keyboardType: TextInputType.number,
          inputFormatters: JkTextField.digitsOnly,
          maxLength: 20,
        ),
        const SizedBox(height: JkSpacing.s2),
        JkTextField(
          label: l10n.bankHolderName,
          controller: _holder,
          textCapitalization: TextCapitalization.words,
          autofillHints: const <String>[AutofillHints.name],
          helper: l10n.bankHolderHelp,
        ),
        const SizedBox(height: JkSpacing.s2),
        Text(l10n.bankMaskNote, style: JkTypeScale.bodyS.copyWith(color: context.jk.onSurfaceMuted)),
        if (error != null) ...<Widget>[
          const SizedBox(height: JkSpacing.s2),
          NoticeBox(tone: NoticeTone.error, message: error),
        ],
        const SizedBox(height: JkSpacing.s4),
        JkButton(label: widget.submitLabel, loading: _busy, onPressed: _submit),
      ],
    );
  }
}

/// Traveler: answer the buyer's clarification (window resets; the price may be revised).
Future<void> showClarifySheet(BuildContext context, WidgetRef ref, TransactionDetail detail, PriceConfirmation pc) async {
  await showJkBottomSheet<void>(
    context,
    title: context.l10n.clarifyTitle,
    builder: (BuildContext sheetContext) => _ClarifyBody(detail: detail, pc: pc),
  );
  _refreshTransaction(ref, detail.id);
}

class _ClarifyBody extends ConsumerStatefulWidget {
  const _ClarifyBody({required this.detail, required this.pc});

  final TransactionDetail detail;
  final PriceConfirmation pc;

  @override
  ConsumerState<_ClarifyBody> createState() => _ClarifyBodyState();
}

class _ClarifyBodyState extends ConsumerState<_ClarifyBody> {
  final TextEditingController _note = TextEditingController();
  final TextEditingController _price = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _note.dispose();
    _price.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final note = _note.text.trim();
    if (note.isEmpty) {
      setState(() => _error = context.l10n.pcClarifyNeedsNote);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final revised = _price.text.trim().isEmpty ? null : Money.parseMinor(_price.text, widget.pc.currency);
      await ref.read(transactionRepositoryProvider).clarifyPrice(
            widget.detail.id,
            widget.pc.id,
            note: note,
            actualUnitPriceMinor: revised,
          );
      if (!mounted) return;
      Navigator.of(context).pop();
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
    final question = widget.pc.responseNote;
    final error = _error;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (question != null && question.isNotEmpty) NoticeBox(title: l10n.clarifyBuyerAsked, message: question),
        const SizedBox(height: JkSpacing.s3),
        JkTextField(label: l10n.clarifyAnswer, controller: _note, maxLines: 4, minLines: 2),
        const SizedBox(height: JkSpacing.s3),
        JkTextField(
          label: l10n.clarifyRevisedPrice(widget.pc.currency),
          controller: _price,
          hint: l10n.optional,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          inputFormatters: JkTextField.moneyFormatters,
        ),
        if (error != null) NoticeBox(tone: NoticeTone.error, message: error),
        const SizedBox(height: JkSpacing.s4),
        JkButton(label: l10n.clarifySubmit, loading: _busy, onPressed: _submit),
      ],
    );
  }
}

/// Traveler: courier hand-off (tracking number) → OUT_FOR_DELIVERY.
Future<void> showShippedSheet(BuildContext context, WidgetRef ref, String transactionId) async {
  await showJkBottomSheet<void>(
    context,
    title: context.l10n.shippedTitle,
    builder: (BuildContext sheetContext) => _ShippedBody(transactionId: transactionId),
  );
  _refreshTransaction(ref, transactionId);
}

class _ShippedBody extends ConsumerStatefulWidget {
  const _ShippedBody({required this.transactionId});

  final String transactionId;

  @override
  ConsumerState<_ShippedBody> createState() => _ShippedBodyState();
}

class _ShippedBodyState extends ConsumerState<_ShippedBody> {
  final TextEditingController _tracking = TextEditingController();
  final TextEditingController _courier = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _tracking.dispose();
    _courier.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_tracking.text.trim().isEmpty) {
      setState(() => _error = context.l10n.validationRequired);
      return;
    }
    setState(() => _busy = true);
    try {
      await ref.read(transactionRepositoryProvider).markShipped(
            widget.transactionId,
            trackingNumber: _tracking.text.trim(),
            courierName: _courier.text.trim(),
          );
      if (!mounted) return;
      Navigator.of(context).pop();
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
    final error = _error;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        JkTextField(label: l10n.courierName, controller: _courier),
        const SizedBox(height: JkSpacing.s3),
        JkTextField(label: l10n.trackingNumber, controller: _tracking, errorText: error),
        const SizedBox(height: JkSpacing.s4),
        JkButton(label: l10n.shippedSubmit, loading: _busy, onPressed: _submit),
      ],
    );
  }
}

/// Traveler: courier delivered, with proof photos → DELIVERED.
Future<void> showDeliveredSheet(BuildContext context, WidgetRef ref, String transactionId) async {
  await showJkBottomSheet<void>(
    context,
    title: context.l10n.deliveredTitle,
    builder: (BuildContext sheetContext) => _DeliveredBody(transactionId: transactionId),
  );
  _refreshTransaction(ref, transactionId);
}

class _DeliveredBody extends ConsumerStatefulWidget {
  const _DeliveredBody({required this.transactionId});

  final String transactionId;

  @override
  ConsumerState<_DeliveredBody> createState() => _DeliveredBodyState();
}

class _DeliveredBodyState extends ConsumerState<_DeliveredBody> {
  final List<PickedUpload> _photos = <PickedUpload>[];
  bool _busy = false;
  String? _error;

  Future<void> _add() async {
    final picked = await ref.read(mediaPickerProvider).image(camera: true);
    if (picked == null || !mounted) return;
    setState(() => _photos.add(picked));
  }

  Future<void> _submit() async {
    if (_photos.isEmpty) {
      setState(() => _error = context.l10n.deliveredNeedsProof);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final uploader = ref.read(fileUploadServiceProvider);
      final ids = <String>[];
      for (final p in _photos) {
        ids.add(await uploader.upload(p, purpose: FilePurpose.deliveryProof));
      }
      await ref.read(transactionRepositoryProvider).markDelivered(widget.transactionId, proofFileIds: ids);
      if (!mounted) return;
      Navigator.of(context).pop();
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
    final error = _error;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(l10n.deliveredIntro, style: JkTypeScale.bodyM.copyWith(color: context.jk.onSurface)),
        const SizedBox(height: JkSpacing.s3),
        Text(l10n.photosSelected(_photos.length), style: JkTypeScale.labelL.copyWith(color: context.jk.onSurface)),
        const SizedBox(height: JkSpacing.s2),
        JkButton(label: l10n.addPhoto, icon: Icons.add_a_photo_outlined, variant: JkButtonVariant.secondary, onPressed: _busy ? null : _add),
        if (error != null) NoticeBox(tone: NoticeTone.error, message: error),
        const SizedBox(height: JkSpacing.s4),
        JkButton(label: l10n.deliveredSubmit, loading: _busy, onPressed: _submit),
      ],
    );
  }
}
