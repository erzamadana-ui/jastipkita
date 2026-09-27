import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/format/dates.dart';
import '../../../core/format/money.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/transaction.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../../../widgets/pickers.dart';
import '../../../widgets/safepay_status_banner.dart';
import '../../../widgets/states.dart';
import '../../catalog/data/catalog_repository.dart';
import '../../files/data/file_upload_service.dart';
import '../data/transaction_repository.dart';

/// Picked-file slot with a thumbnail (images) and remove action.
class UploadSlot extends StatelessWidget {
  const UploadSlot({super.key, required this.label, required this.files, required this.onAdd, required this.onRemove, this.isRequired = false, this.max = 1, this.helper});

  final String label;
  final List<PickedUpload> files;
  final VoidCallback? onAdd;
  final ValueChanged<int> onRemove;
  final bool isRequired;
  final int max;
  final String? helper;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final note = helper;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(isRequired ? '$label *' : label, style: JkTypeScale.labelL.copyWith(color: jk.onSurface)),
        if (note != null) Text(note, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
        const SizedBox(height: JkSpacing.s2),
        Wrap(
          spacing: JkSpacing.s2,
          runSpacing: JkSpacing.s2,
          children: <Widget>[
            for (var i = 0; i < files.length; i++)
              Stack(
                clipBehavior: Clip.none,
                children: <Widget>[
                  ClipRRect(
                    borderRadius: JkRadii.mdAll,
                    child: files[i].contentType.startsWith('image/')
                        ? Image.memory(files[i].bytes, width: 72, height: 72, fit: BoxFit.cover, semanticLabel: files[i].name)
                        : Container(
                            width: 72,
                            height: 72,
                            color: jk.surfaceMuted,
                            alignment: Alignment.center,
                            child: Icon(Icons.description_outlined, color: jk.secondary),
                          ),
                  ),
                  Positioned(
                    right: -12,
                    top: -12,
                    child: IconButton(
                      tooltip: l10n.actionRemove,
                      onPressed: () => onRemove(i),
                      icon: Icon(Icons.cancel, color: jk.error),
                    ),
                  ),
                ],
              ),
            if (files.length < max)
              Semantics(
                button: true,
                label: l10n.addFileFor(label),
                excludeSemantics: true,
                child: InkWell(
                  borderRadius: JkRadii.mdAll,
                  onTap: onAdd,
                  child: Container(
                    width: 72,
                    height: 72,
                    decoration: BoxDecoration(borderRadius: JkRadii.mdAll, border: Border.all(color: jk.outline)),
                    child: Icon(Icons.add_a_photo_outlined, color: jk.secondary),
                  ),
                ),
              ),
          ],
        ),
      ],
    );
  }
}

Future<List<String>> _uploadAll(WidgetRef ref, List<PickedUpload> files, String purpose, void Function(int done, int total) progress) async {
  final uploader = ref.read(fileUploadServiceProvider);
  final ids = <String>[];
  for (var i = 0; i < files.length; i++) {
    progress(i, files.length);
    ids.add(await uploader.upload(files[i], purpose: purpose));
  }
  progress(files.length, files.length);
  return ids;
}

/// Traveler reports the actual shelf price in PAYMENT_SECURED. Within tolerance → the server
/// moves to PURCHASE_APPROVED; otherwise the buyer gets a 15-minute price confirmation.
class PriceCheckScreen extends ConsumerStatefulWidget {
  const PriceCheckScreen({super.key, required this.transactionId});

  final String transactionId;

  @override
  ConsumerState<PriceCheckScreen> createState() => _PriceCheckScreenState();
}

class _PriceCheckScreenState extends ConsumerState<PriceCheckScreen> {
  final TextEditingController _price = TextEditingController();
  final TextEditingController _notes = TextEditingController();
  final List<PickedUpload> _receipt = <PickedUpload>[];
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _price.dispose();
    _notes.dispose();
    super.dispose();
  }

  Future<void> _addReceipt() async {
    final picked = await ref.read(mediaPickerProvider).image(camera: true);
    if (picked == null || !mounted) return;
    setState(() => _receipt
      ..clear()
      ..add(picked));
  }

  Future<void> _submit(TransactionDetail d, String currency) async {
    final l10n = context.l10n;
    final units = ref.read(catalogProvider).valueOrNull?.minorUnits(currency);
    final price = Money.parseMinor(_price.text, currency, minorUnits: units);
    if (price == null || price <= 0) {
      setState(() => _error = l10n.validationAmount);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final receiptIds = await _uploadAll(ref, _receipt, FilePurpose.receipt, (int done, int total) {});
      final result = await ref.read(transactionRepositoryProvider).priceCheck(
            d.id,
            actualUnitPriceMinor: price,
            currency: currency,
            receiptFileId: receiptIds.isEmpty ? null : receiptIds.first,
            notes: _notes.text.trim(),
          );
      ref.invalidate(transactionDetailProvider(d.id));
      ref.invalidate(transactionTimelineProvider(d.id));
      if (!mounted) return;
      final approved = result.transactionStatus == TxStatus.purchaseApproved;
      await showJkConfirm(
        context,
        title: approved ? l10n.priceCheckApprovedTitle : l10n.priceCheckPendingTitle,
        message: approved ? l10n.priceCheckApprovedBody : l10n.priceCheckPendingBody,
        confirmLabel: l10n.actionOk,
        cancelLabel: l10n.actionClose,
      );
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
    final locale = context.localeCode;
    final value = ref.watch(transactionDetailProvider(widget.transactionId));
    return Scaffold(
      appBar: AppBar(title: Text(l10n.priceCheckTitle)),
      body: AsyncValueView<TransactionDetail>(
        value: value,
        onRetry: () => ref.invalidate(transactionDetailProvider(widget.transactionId)),
        data: (TransactionDetail d) {
          final quote = d.quote;
          final currency = d.itemCurrency ?? quote?.itemCurrency ?? 'IDR';
          final unit = quote?.itemUnitPriceMinor;
          final error = _error;
          return ListView(
            padding: const EdgeInsets.all(JkSpacing.s5),
            children: <Widget>[
              SafePayStatusBanner.forTraveler(status: d.status),
              const SizedBox(height: JkSpacing.s4),
              Text(l10n.priceCheckIntro, style: JkTypeScale.bodyM.copyWith(color: jk.onBackground)),
              const SizedBox(height: JkSpacing.s4),
              if (unit != null)
                JkCard(
                  child: KeyValue(
                    label: l10n.pcSecuredPrice,
                    value: Text(Money.minor(unit, currency, locale: locale), style: JkTypeScale.moneyM.copyWith(color: jk.onSurface)),
                  ),
                ),
              const SizedBox(height: JkSpacing.s4),
              JkTextField(
                label: l10n.priceCheckActual(currency),
                controller: _price,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                inputFormatters: JkTextField.moneyFormatters,
                helper: l10n.priceCheckPerUnit,
              ),
              const SizedBox(height: JkSpacing.s4),
              UploadSlot(
                label: l10n.priceCheckReceipt,
                files: _receipt,
                onAdd: _busy ? null : _addReceipt,
                onRemove: (int i) => setState(() => _receipt.removeAt(i)),
                helper: l10n.priceCheckReceiptHelp,
              ),
              const SizedBox(height: JkSpacing.s4),
              JkTextField(label: l10n.fieldNotes, controller: _notes, maxLines: 3, minLines: 1),
              if (error != null) ...<Widget>[
                const SizedBox(height: JkSpacing.s3),
                NoticeBox(tone: NoticeTone.error, message: error),
              ],
              const SizedBox(height: JkSpacing.s5),
              JkButton(
                label: l10n.priceCheckSubmit,
                loading: _busy,
                onPressed: d.can('PRICE_CHECK') ? () => _submit(d, currency) : null,
                disabledReason: d.can('PRICE_CHECK') ? null : l10n.actionNotAvailable,
              ),
            ],
          );
        },
      ),
    );
  }
}

/// Purchase proof — only in PURCHASE_APPROVED (golden rule, re-checked by the API): receipt,
/// product photos, merchant, actual price ≤ approved ceiling, purchase time, and serial/video
/// when the category requires them (§6.10).
class PurchaseProofScreen extends ConsumerStatefulWidget {
  const PurchaseProofScreen({super.key, required this.transactionId});

  final String transactionId;

  @override
  ConsumerState<PurchaseProofScreen> createState() => _PurchaseProofScreenState();
}

class _PurchaseProofScreenState extends ConsumerState<PurchaseProofScreen> {
  final List<PickedUpload> _receipt = <PickedUpload>[];
  final List<PickedUpload> _photos = <PickedUpload>[];
  final List<PickedUpload> _video = <PickedUpload>[];
  final TextEditingController _merchant = TextEditingController();
  final TextEditingController _price = TextEditingController();
  final TextEditingController _serial = TextEditingController();
  final TextEditingController _receiptNumber = TextEditingController();
  DateTime _purchasedAt = DateTime.now();
  bool _prefilled = false;
  bool _busy = false;
  String? _progress;
  String? _error;

  @override
  void dispose() {
    for (final c in <TextEditingController>[_merchant, _price, _serial, _receiptNumber]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _addImage(List<PickedUpload> target, {int max = 10}) async {
    if (target.length >= max) return;
    final picked = await ref.read(mediaPickerProvider).image(camera: true);
    if (picked == null || !mounted) return;
    setState(() => target.add(picked));
  }

  Future<void> _addVideo() async {
    final picked = await ref.read(mediaPickerProvider).video();
    if (picked == null || !mounted) return;
    setState(() => _video
      ..clear()
      ..add(picked));
  }

  Future<void> _pickTime() async {
    final date = await showDatePicker(
      context: context,
      initialDate: _purchasedAt,
      firstDate: DateTime.now().subtract(const Duration(days: 60)),
      lastDate: DateTime.now(),
    );
    if (date == null) return;
    if (!mounted) return;
    final time = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(_purchasedAt));
    if (!mounted) return;
    setState(() {
      _purchasedAt = DateTime(date.year, date.month, date.day, time?.hour ?? _purchasedAt.hour, time?.minute ?? _purchasedAt.minute);
    });
  }

  Future<void> _submit(TransactionDetail d, String currency, {required bool needsSerial, required bool needsVideo}) async {
    final l10n = context.l10n;
    final units = ref.read(catalogProvider).valueOrNull?.minorUnits(currency);
    final price = Money.parseMinor(_price.text, currency, minorUnits: units);
    String? problem;
    if (_receipt.isEmpty) problem = l10n.proofNeedsReceipt;
    if (_photos.isEmpty) problem ??= l10n.proofNeedsPhotos;
    if (needsVideo && _video.isEmpty) problem ??= l10n.proofNeedsVideo;
    if (needsSerial && _serial.text.trim().isEmpty) problem ??= l10n.proofNeedsSerial;
    if (_merchant.text.trim().isEmpty) problem ??= l10n.validationRequired;
    if (price == null || price <= 0) problem ??= l10n.validationAmount;
    final ceiling = d.purchaseCeilingMinor;
    if (price != null && ceiling != null && price > ceiling) problem ??= l10n.proofOverCeiling;
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      void report(int done, int total) {
        if (mounted) setState(() => _progress = l10n.uploadProgress(done, total));
      }

      final all = <PickedUpload>[..._receipt, ..._photos, ..._video];
      final ids = <String>[];
      final uploader = ref.read(fileUploadServiceProvider);
      for (var i = 0; i < all.length; i++) {
        report(i + 1, all.length);
        final purpose = i < _receipt.length ? FilePurpose.receipt : (i < _receipt.length + _photos.length ? FilePurpose.productPhoto : FilePurpose.evidence);
        ids.add(await uploader.upload(all[i], purpose: purpose));
      }
      report(all.length, all.length);
      final receiptId = ids.first;
      final photoIds = ids.sublist(_receipt.length, _receipt.length + _photos.length);
      final videoId = _video.isEmpty ? null : ids.last;
      await ref.read(transactionRepositoryProvider).submitPurchaseProof(
            d.id,
            receiptFileId: receiptId,
            productPhotoFileIds: photoIds,
            videoFileId: videoId,
            serialNumber: _serial.text.trim(),
            receiptNumber: _receiptNumber.text.trim(),
            merchantName: _merchant.text.trim(),
            actualPriceMinor: price!,
            currency: currency,
            purchasedAt: _purchasedAt,
          );
      ref.invalidate(transactionDetailProvider(d.id));
      ref.invalidate(transactionTimelineProvider(d.id));
      if (!mounted) return;
      showJkSnack(context, l10n.proofSubmitted);
      context.pop();
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
    final locale = context.localeCode;
    final value = ref.watch(transactionDetailProvider(widget.transactionId));
    final catalog = ref.watch(catalogProvider).valueOrNull;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.uploadPurchaseProof)),
      body: AsyncValueView<TransactionDetail>(
        value: value,
        onRetry: () => ref.invalidate(transactionDetailProvider(widget.transactionId)),
        data: (TransactionDetail d) {
          if (!d.travelerMayPurchase) {
            return ListView(
              padding: const EdgeInsets.all(JkSpacing.s5),
              children: <Widget>[
                SafePayStatusBanner.forTraveler(status: d.status),
                const SizedBox(height: JkSpacing.s4),
                PurchaseGateButton(status: d.status, gate: d.purchaseGate, onUploadProof: () {}),
              ],
            );
          }
          final currency = d.itemCurrency ?? d.quote?.itemCurrency ?? 'IDR';
          final category = catalog?.category(d.item?.categoryCode);
          final needsSerial = category?.requiresSerial ?? false;
          final needsVideo = category?.requiresVideo ?? false;
          if (!_prefilled) {
            _prefilled = true;
            _merchant.text = d.item?.merchantName ?? '';
          }
          final ceiling = d.purchaseCeilingMinor;
          final error = _error;
          final progress = _progress;
          return ListView(
            padding: const EdgeInsets.all(JkSpacing.s5),
            children: <Widget>[
              SafePayStatusBanner.forTraveler(
                status: d.status,
                approvedCeiling: ceiling == null ? null : Money.minor(ceiling, currency, locale: locale, minorUnits: catalog?.minorUnits(currency)),
              ),
              const SizedBox(height: JkSpacing.s4),
              UploadSlot(
                label: l10n.proofReceipt,
                isRequired: true,
                files: _receipt,
                onAdd: _busy ? null : () => _addImage(_receipt, max: 1),
                onRemove: (int i) => setState(() => _receipt.removeAt(i)),
              ),
              const SizedBox(height: JkSpacing.s4),
              UploadSlot(
                label: l10n.proofPhotosLabel,
                isRequired: true,
                max: 10,
                files: _photos,
                onAdd: _busy ? null : () => _addImage(_photos),
                onRemove: (int i) => setState(() => _photos.removeAt(i)),
              ),
              if (needsVideo) ...<Widget>[
                const SizedBox(height: JkSpacing.s4),
                UploadSlot(
                  label: l10n.proofVideo,
                  isRequired: true,
                  files: _video,
                  onAdd: _busy ? null : _addVideo,
                  onRemove: (int i) => setState(() => _video.removeAt(i)),
                  helper: l10n.proofVideoHelp,
                ),
              ],
              const SizedBox(height: JkSpacing.s4),
              JkTextField(label: l10n.fieldMerchant, controller: _merchant),
              const SizedBox(height: JkSpacing.s4),
              JkTextField(
                label: l10n.proofActualTotal(currency),
                controller: _price,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                inputFormatters: JkTextField.moneyFormatters,
                helper: ceiling == null ? null : l10n.proofCeilingHelp(Money.minor(ceiling, currency, locale: locale)),
              ),
              if (needsSerial) ...<Widget>[
                const SizedBox(height: JkSpacing.s4),
                JkTextField(label: l10n.proofSerial, controller: _serial, textCapitalization: TextCapitalization.characters),
              ],
              const SizedBox(height: JkSpacing.s4),
              JkTextField(label: l10n.proofReceiptNumber, controller: _receiptNumber, hint: l10n.optional),
              const SizedBox(height: JkSpacing.s4),
              Text(l10n.proofPurchasedAt, style: JkTypeScale.labelL.copyWith(color: jk.onSurface)),
              const SizedBox(height: 6),
              JkCard(
                onTap: _busy ? null : _pickTime,
                child: Row(
                  children: <Widget>[
                    Icon(Icons.event, color: jk.secondary),
                    const SizedBox(width: JkSpacing.s3),
                    Expanded(child: Text(JkDates.dateTime(_purchasedAt, locale))),
                    Text(l10n.actionChange, style: JkTypeScale.labelL.copyWith(color: jk.link)),
                  ],
                ),
              ),
              if (error != null) ...<Widget>[
                const SizedBox(height: JkSpacing.s3),
                NoticeBox(tone: NoticeTone.error, message: error),
              ],
              if (progress != null) ...<Widget>[
                const SizedBox(height: JkSpacing.s3),
                Semantics(liveRegion: true, child: Text(progress, style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted))),
              ],
              const SizedBox(height: JkSpacing.s5),
              JkButton(
                label: l10n.proofSubmit,
                icon: Icons.upload_outlined,
                loading: _busy,
                onPressed: () => _submit(d, currency, needsSerial: needsSerial, needsVideo: needsVideo),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// Traveler records duty & taxes actually paid (+ official receipt when > 0).
class CustomsDeclarationScreen extends ConsumerStatefulWidget {
  const CustomsDeclarationScreen({super.key, required this.transactionId});

  final String transactionId;

  @override
  ConsumerState<CustomsDeclarationScreen> createState() => _CustomsDeclarationScreenState();
}

class _CustomsDeclarationScreenState extends ConsumerState<CustomsDeclarationScreen> {
  final TextEditingController _duty = TextEditingController();
  final TextEditingController _vat = TextEditingController();
  final TextEditingController _income = TextEditingController();
  final TextEditingController _luxury = TextEditingController();
  final TextEditingController _ref = TextEditingController();
  final TextEditingController _notes = TextEditingController();
  final List<PickedUpload> _receipt = <PickedUpload>[];
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    for (final c in <TextEditingController>[_duty, _vat, _income, _luxury, _ref, _notes]) {
      c.dispose();
    }
    super.dispose();
  }

  int _idr(TextEditingController c) => int.tryParse(c.text.replaceAll(RegExp(r'[^0-9]'), '')) ?? 0;

  Future<void> _submit() async {
    final l10n = context.l10n;
    final total = _idr(_duty) + _idr(_vat) + _idr(_income) + _idr(_luxury);
    if (total > 0 && _receipt.isEmpty) {
      setState(() => _error = l10n.customsNeedsReceipt);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final ids = await _uploadAll(ref, _receipt, FilePurpose.receipt, (int done, int all) {});
      await ref.read(transactionRepositoryProvider).customsDeclaration(
            widget.transactionId,
            dutyPaidIdr: _idr(_duty),
            vatPaidIdr: _idr(_vat),
            incomeTaxPaidIdr: _idr(_income),
            luxuryTaxPaidIdr: _idr(_luxury),
            declarationRef: _ref.text.trim(),
            receiptFileId: ids.isEmpty ? null : ids.first,
            notes: _notes.text.trim(),
          );
      ref.invalidate(transactionDetailProvider(widget.transactionId));
      if (!mounted) return;
      showJkSnack(context, l10n.customsSaved);
      context.pop();
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = errorMessage(l10n, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _money(String label, TextEditingController c) => JkTextField(
        label: label,
        controller: c,
        prefixText: 'Rp ',
        keyboardType: TextInputType.number,
        inputFormatters: JkTextField.digitsOnly,
      );

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final error = _error;
    const gap = SizedBox(height: JkSpacing.s4);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.customsTitle)),
      body: ListView(
        padding: const EdgeInsets.all(JkSpacing.s5),
        children: <Widget>[
          NoticeBox(message: l10n.customsIntro),
          gap,
          _money(l10n.customsDuty, _duty),
          gap,
          _money(l10n.customsVat, _vat),
          gap,
          _money(l10n.customsIncomeTax, _income),
          gap,
          _money(l10n.customsLuxuryTax, _luxury),
          gap,
          JkTextField(label: l10n.customsRef, controller: _ref, hint: l10n.optional),
          gap,
          UploadSlot(
            label: l10n.customsReceipt,
            files: _receipt,
            onAdd: _busy
                ? null
                : () async {
                    final picked = await ref.read(mediaPickerProvider).image(camera: true);
                    if (picked == null || !mounted) return;
                    setState(() => _receipt
                      ..clear()
                      ..add(picked));
                  },
            onRemove: (int i) => setState(() => _receipt.removeAt(i)),
          ),
          gap,
          JkTextField(label: l10n.fieldNotes, controller: _notes, maxLines: 3, minLines: 1),
          if (error != null) ...<Widget>[gap, NoticeBox(tone: NoticeTone.error, message: error)],
          const SizedBox(height: JkSpacing.s5),
          JkButton(label: l10n.customsSubmit, loading: _busy, onPressed: _submit),
        ],
      ),
    );
  }
}

/// Traveler chooses how the item is handed over: MEETUP (PIN/QR), COURIER or PARTNER_LOGISTICS.
class DeliveryMethodScreen extends ConsumerStatefulWidget {
  const DeliveryMethodScreen({super.key, required this.transactionId});

  final String transactionId;

  @override
  ConsumerState<DeliveryMethodScreen> createState() => _DeliveryMethodScreenState();
}

class _DeliveryMethodScreenState extends ConsumerState<DeliveryMethodScreen> {
  String _method = DeliveryMethod.meetup;
  final TextEditingController _meetup = TextEditingController();
  final TextEditingController _courier = TextEditingController();
  final TextEditingController _tracking = TextEditingController();
  final TextEditingController _city = TextEditingController();
  DateTime? _scheduledDate;
  TimeOfDay? _scheduledTime;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    for (final c in <TextEditingController>[_meetup, _courier, _tracking, _city]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _pickTime() async {
    final time = await showTimePicker(context: context, initialTime: _scheduledTime ?? const TimeOfDay(hour: 10, minute: 0));
    if (time == null || !mounted) return;
    setState(() => _scheduledTime = time);
  }

  Future<void> _submit() async {
    final l10n = context.l10n;
    if (_method == DeliveryMethod.meetup && _meetup.text.trim().isEmpty) {
      setState(() => _error = l10n.deliveryMeetupRequired);
      return;
    }
    final date = _scheduledDate;
    final time = _scheduledTime;
    final scheduled = date == null ? null : DateTime(date.year, date.month, date.day, time?.hour ?? 10, time?.minute ?? 0);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(transactionRepositoryProvider).setDelivery(
            widget.transactionId,
            method: _method,
            meetupPoint: _meetup.text.trim(),
            courierName: _courier.text.trim(),
            trackingNumber: _tracking.text.trim(),
            addressCity: _city.text.trim(),
            scheduledAt: scheduled,
          );
      ref.invalidate(transactionDetailProvider(widget.transactionId));
      if (!mounted) return;
      showJkSnack(context, l10n.deliverySaved);
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
    final locale = context.localeCode;
    final error = _error;
    final time = _scheduledTime;
    const gap = SizedBox(height: JkSpacing.s4);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.deliverySetTitle)),
      body: ListView(
        padding: const EdgeInsets.all(JkSpacing.s5),
        children: <Widget>[
          Wrap(
            spacing: JkSpacing.s2,
            runSpacing: JkSpacing.s2,
            children: <Widget>[
              for (final m in DeliveryMethod.all)
                ChoiceChip(
                  label: Text(Labels.deliveryMethod(l10n, m)),
                  selected: _method == m,
                  onSelected: (bool v) => setState(() => _method = m),
                ),
            ],
          ),
          gap,
          if (_method == DeliveryMethod.meetup) ...<Widget>[
            NoticeBox(message: l10n.deliveryMeetupNote),
            gap,
            JkTextField(label: l10n.meetupPoint, controller: _meetup, hint: l10n.meetupPointHint),
            gap,
            DatePickerField(
              label: l10n.meetupDate,
              value: _scheduledDate,
              display: (DateTime d) => JkDates.calendar(JkDates.toYmd(d), locale),
              onChanged: (DateTime d) => setState(() => _scheduledDate = d),
            ),
            gap,
            JkButton(
              label: time == null ? l10n.meetupPickTime : l10n.meetupTimeValue(time.format(context)),
              icon: Icons.schedule,
              variant: JkButtonVariant.secondary,
              onPressed: _pickTime,
            ),
          ] else ...<Widget>[
            NoticeBox(message: l10n.deliveryCourierNote),
            gap,
            JkTextField(label: l10n.courierName, controller: _courier),
            gap,
            JkTextField(label: l10n.trackingNumber, controller: _tracking, hint: l10n.optional),
            gap,
            JkTextField(label: l10n.fieldDestinationCity, controller: _city),
          ],
          if (error != null) ...<Widget>[gap, NoticeBox(tone: NoticeTone.error, message: error)],
          const SizedBox(height: JkSpacing.s5),
          JkButton(label: l10n.deliverySave, loading: _busy, onPressed: _submit),
        ],
      ),
    );
  }
}
