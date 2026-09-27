import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/app_config.dart';
import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/format/dates.dart';
import '../../../core/l10n/l10n.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../../../widgets/money_text.dart';
import '../../../widgets/pickers.dart';
import '../../auth/application/session_controller.dart';
import '../../engagement/data/engagement_repository.dart';
import '../../files/data/file_upload_service.dart';
import '../data/kyc_repository.dart';
import '../data/liveness.dart';

/// Identity verification (level 3) stepper: consent → ID type → ID photo → selfie → liveness →
/// identity data → review & submit. Each step says why the data is needed and how it is stored
/// (encrypted, verification only). Leaving mid-way asks for confirmation (§5.23).
class KycSubmissionScreen extends ConsumerStatefulWidget {
  const KycSubmissionScreen({super.key});

  @override
  ConsumerState<KycSubmissionScreen> createState() => _KycSubmissionScreenState();
}

class _KycSubmissionScreenState extends ConsumerState<KycSubmissionScreen> {
  static const int _stepCount = 7;
  int _step = 0;
  bool _consent = false;
  String _idType = 'KTP';
  PickedUpload? _idFront;
  PickedUpload? _idBack;
  PickedUpload? _selfie;
  final List<PickedUpload?> _liveness = <PickedUpload?>[];
  final TextEditingController _name = TextEditingController();
  final TextEditingController _idNumber = TextEditingController();
  final TextEditingController _nationality = TextEditingController(text: 'ID');
  DateTime? _dob;
  bool _busy = false;
  String? _progress;
  String? _error;

  @override
  void initState() {
    super.initState();
    trackEvent(ref, 'kyc_started');
  }

  @override
  void dispose() {
    _name.dispose();
    _idNumber.dispose();
    _nationality.dispose();
    super.dispose();
  }

  bool get _dirty => _step > 0 || _idFront != null || _selfie != null;

  bool _canContinue() {
    switch (_step) {
      case 0:
        return _consent;
      case 1:
        return true;
      case 2:
        return _idFront != null;
      case 3:
        return _selfie != null;
      case 4:
        final liveness = ref.read(livenessProvider);
        return _liveness.length >= liveness.stepCount && _liveness.every((PickedUpload? p) => p != null);
      case 5:
        return _name.text.trim().length >= 3 && _idNumber.text.trim().length >= 6 && _dob != null;
      default:
        return true;
    }
  }

  Future<void> _capture(void Function(PickedUpload) assign, {bool front = false}) async {
    final picked = await ref.read(mediaPickerProvider).image(camera: true, frontCamera: front);
    if (picked == null || !mounted) return;
    setState(() => assign(picked));
  }

  Future<void> _captureLiveness(int step) async {
    final picked = await ref.read(livenessProvider).capture(step);
    if (picked == null || !mounted) return;
    setState(() {
      while (_liveness.length <= step) {
        _liveness.add(null);
      }
      _liveness[step] = picked;
    });
  }

  Future<void> _next() async {
    if (!_canContinue()) return;
    if (_step == 0) {
      setState(() => _busy = true);
      try {
        await ref.read(kycRepositoryProvider).grantKycConsent(AppConfig.consentVersion);
      } on Object catch (e) {
        if (!mounted) return;
        setState(() {
          _busy = false;
          _error = errorMessage(context.l10n, e);
        });
        return;
      }
      if (!mounted) return;
      setState(() => _busy = false);
    }
    if (_step < _stepCount - 1) {
      setState(() {
        _step++;
        _error = null;
      });
    } else {
      await _submit();
    }
  }

  Future<void> _submit() async {
    final l10n = context.l10n;
    final front = _idFront;
    final selfie = _selfie;
    final dob = _dob;
    if (front == null || selfie == null || dob == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final uploader = ref.read(fileUploadServiceProvider);
      final files = <PickedUpload>[front, if (_idBack != null) _idBack!, selfie, ..._liveness.whereType<PickedUpload>()];
      final ids = <String>[];
      for (var i = 0; i < files.length; i++) {
        if (mounted) setState(() => _progress = l10n.uploadProgress(i + 1, files.length));
        ids.add(await uploader.upload(files[i], purpose: FilePurpose.kyc));
      }
      var index = 0;
      final frontId = ids[index++];
      final backId = _idBack != null ? ids[index++] : null;
      final selfieId = ids[index++];
      final livenessId = index < ids.length ? ids[index] : null;
      await ref.read(kycRepositoryProvider).submit(
            idType: _idType,
            idNumber: _idNumber.text.trim(),
            fullName: _name.text.trim(),
            dateOfBirth: JkDates.toYmd(dob),
            nationality: _idType == 'PASSPORT' ? _nationality.text.trim().toUpperCase() : 'ID',
            idFrontFileId: frontId,
            idBackFileId: backId,
            selfieFileId: selfieId,
            livenessFileId: livenessId,
          );
      ref.invalidate(kycStatusProvider);
      await ref.read(sessionControllerProvider.notifier).refreshProfile();
      if (!mounted) return;
      showJkSnack(context, l10n.kycSubmitted);
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

  Future<void> _confirmLeave() async {
    final l10n = context.l10n;
    final leave = await showJkConfirm(
      context,
      title: l10n.kycLeaveTitle,
      message: l10n.kycLeaveBody,
      confirmLabel: l10n.kycLeave,
      destructive: true,
    );
    if (!leave) return;
    if (!mounted) return;
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final error = _error;
    final progress = _progress;
    return PopScope<Object?>(
      canPop: !_dirty || _busy,
      onPopInvokedWithResult: (bool didPop, Object? result) {
        if (!didPop && !_busy) _confirmLeave();
      },
      child: Scaffold(
        appBar: AppBar(title: Text(l10n.kycSubmitTitle)),
        body: ListView(
          padding: const EdgeInsets.all(JkSpacing.s5),
          children: <Widget>[
            Semantics(
              label: l10n.stepOf(_step + 1, _stepCount),
              child: Text(l10n.stepOf(_step + 1, _stepCount), style: JkTypeScale.labelL.copyWith(color: jk.onBackgroundMuted)),
            ),
            const SizedBox(height: JkSpacing.s2),
            ClipRRect(
              borderRadius: JkRadii.pillAll,
              child: LinearProgressIndicator(value: (_step + 1) / _stepCount, minHeight: 6),
            ),
            const SizedBox(height: JkSpacing.s5),
            ..._stepBody(l10n),
            if (error != null) ...<Widget>[
              const SizedBox(height: JkSpacing.s3),
              NoticeBox(tone: NoticeTone.error, message: error),
            ],
            if (progress != null) ...<Widget>[
              const SizedBox(height: JkSpacing.s3),
              Semantics(liveRegion: true, child: Text(progress)),
            ],
            const SizedBox(height: JkSpacing.s6),
            JkButton(
              label: _step == _stepCount - 1 ? l10n.kycSubmit : l10n.actionNext,
              loading: _busy,
              onPressed: _canContinue() ? _next : null,
            ),
            if (_step > 0) ...<Widget>[
              const SizedBox(height: JkSpacing.s2),
              JkButton(
                label: l10n.actionBack,
                variant: JkButtonVariant.tertiary,
                onPressed: _busy ? null : () => setState(() => _step--),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _why(String text) => NoticeBox(icon: Icons.lock_outline, message: text);

  Widget _photo(String label, PickedUpload? file, VoidCallback onCapture) {
    final jk = context.jk;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(label, style: JkTypeScale.labelL.copyWith(color: jk.onBackground)),
        const SizedBox(height: JkSpacing.s2),
        AspectRatio(
          aspectRatio: 1.58,
          child: DecoratedBox(
            decoration: BoxDecoration(color: jk.surfaceMuted, borderRadius: JkRadii.lgAll, border: Border.all(color: jk.outline, width: 2)),
            child: ClipRRect(
              borderRadius: JkRadii.lgAll,
              child: file == null
                  ? Center(child: Icon(Icons.crop_free, size: 64, color: jk.onSurfaceMuted))
                  : Image.memory(file.bytes, fit: BoxFit.cover, semanticLabel: label),
            ),
          ),
        ),
        const SizedBox(height: JkSpacing.s2),
        JkButton(
          label: file == null ? context.l10n.kycCapture : context.l10n.kycRetake,
          icon: Icons.photo_camera_outlined,
          variant: JkButtonVariant.secondary,
          onPressed: _busy ? null : onCapture,
        ),
      ],
    );
  }

  List<Widget> _stepBody(AppLocalizations l10n) {
    final jk = context.jk;
    final locale = context.localeCode;
    switch (_step) {
      case 0:
        return <Widget>[
          Text(l10n.kycConsentTitle, style: JkTypeScale.titleM.copyWith(color: jk.onBackground)),
          const SizedBox(height: JkSpacing.s2),
          Text(l10n.kycConsentBody, style: JkTypeScale.bodyM.copyWith(color: jk.onBackground)),
          const SizedBox(height: JkSpacing.s3),
          _why(l10n.kycStorageNote),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: _consent,
            onChanged: (bool? v) => setState(() => _consent = v ?? false),
            title: Text(l10n.kycConsentCheck),
          ),
        ];
      case 1:
        return <Widget>[
          Text(l10n.kycIdTypeTitle, style: JkTypeScale.titleM.copyWith(color: jk.onBackground)),
          const SizedBox(height: JkSpacing.s3),
          Wrap(
            spacing: JkSpacing.s2,
            children: <Widget>[
              ChoiceChip(label: Text(l10n.kycIdKtp), selected: _idType == 'KTP', onSelected: (bool v) => setState(() => _idType = 'KTP')),
              ChoiceChip(
                label: Text(l10n.kycIdPassport),
                selected: _idType == 'PASSPORT',
                onSelected: (bool v) => setState(() => _idType = 'PASSPORT'),
              ),
            ],
          ),
          const SizedBox(height: JkSpacing.s3),
          _why(l10n.kycIdTypeWhy),
        ];
      case 2:
        return <Widget>[
          _why(l10n.kycIdPhotoWhy),
          const SizedBox(height: JkSpacing.s3),
          _photo(l10n.kycIdFront, _idFront, () => _capture((PickedUpload p) => _idFront = p)),
          if (_idType == 'KTP') ...<Widget>[
            const SizedBox(height: JkSpacing.s4),
            _photo(l10n.kycIdBackOptional, _idBack, () => _capture((PickedUpload p) => _idBack = p)),
          ],
          const SizedBox(height: JkSpacing.s2),
          Text(l10n.kycPhotoTips, style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted)),
        ];
      case 3:
        return <Widget>[
          _why(l10n.kycSelfieWhy),
          const SizedBox(height: JkSpacing.s3),
          _photo(l10n.kycSelfie, _selfie, () => _capture((PickedUpload p) => _selfie = p, front: true)),
        ];
      case 4:
        final provider = ref.read(livenessProvider);
        final instructions = <String>[l10n.livenessStep1, l10n.livenessStep2];
        return <Widget>[
          Row(
            children: <Widget>[
              Expanded(child: Text(l10n.livenessTitle, style: JkTypeScale.titleM.copyWith(color: jk.onBackground))),
              if (provider.isSandbox) const SandboxBadge(),
            ],
          ),
          const SizedBox(height: JkSpacing.s2),
          _why(l10n.livenessWhy),
          for (var i = 0; i < provider.stepCount; i++) ...<Widget>[
            const SizedBox(height: JkSpacing.s4),
            _photo(
              i < instructions.length ? instructions[i] : l10n.livenessStepGeneric(i + 1),
              i < _liveness.length ? _liveness[i] : null,
              () => _captureLiveness(i),
            ),
          ],
        ];
      case 5:
        return <Widget>[
          _why(l10n.kycDataWhy),
          const SizedBox(height: JkSpacing.s3),
          JkTextField(
            label: l10n.kycFullName,
            controller: _name,
            textCapitalization: TextCapitalization.characters,
            autofillHints: const <String>[AutofillHints.name],
            helper: l10n.kycFullNameHelp,
            onChanged: (String _) => setState(() {}),
          ),
          const SizedBox(height: JkSpacing.s3),
          JkTextField(
            label: _idType == 'KTP' ? l10n.kycNik : l10n.kycPassportNumber,
            controller: _idNumber,
            keyboardType: _idType == 'KTP' ? TextInputType.number : TextInputType.text,
            inputFormatters: _idType == 'KTP' ? JkTextField.digitsOnly : null,
            maxLength: _idType == 'KTP' ? 16 : 20,
            onChanged: (String _) => setState(() {}),
          ),
          const SizedBox(height: JkSpacing.s3),
          DatePickerField(
            label: l10n.kycDob,
            value: _dob,
            firstDate: DateTime(1920),
            lastDate: DateTime.now(),
            display: (DateTime d) => JkDates.calendar(JkDates.toYmd(d), locale),
            onChanged: (DateTime d) => setState(() => _dob = d),
          ),
          if (_idType == 'PASSPORT') ...<Widget>[
            const SizedBox(height: JkSpacing.s3),
            JkTextField(label: l10n.kycNationality, controller: _nationality, maxLength: 2, textCapitalization: TextCapitalization.characters),
          ],
        ];
      default:
        final dob = _dob;
        return <Widget>[
          Text(l10n.kycReviewTitle, style: JkTypeScale.titleM.copyWith(color: jk.onBackground)),
          const SizedBox(height: JkSpacing.s3),
          JkCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                KeyValue(label: l10n.kycIdTypeTitle, value: Text(_idType == 'KTP' ? l10n.kycIdKtp : l10n.kycIdPassport)),
                const SizedBox(height: JkSpacing.s2),
                KeyValue(label: l10n.kycFullName, value: Text(_name.text.trim())),
                const SizedBox(height: JkSpacing.s2),
                KeyValue(label: _idType == 'KTP' ? l10n.kycNik : l10n.kycPassportNumber, value: Text(_maskId(_idNumber.text.trim()))),
                if (dob != null) ...<Widget>[
                  const SizedBox(height: JkSpacing.s2),
                  KeyValue(label: l10n.kycDob, value: Text(JkDates.calendar(JkDates.toYmd(dob), locale))),
                ],
                const SizedBox(height: JkSpacing.s2),
                Text(l10n.kycPhotosReady(1 + (_idBack == null ? 0 : 1) + 1 + _liveness.whereType<PickedUpload>().length)),
              ],
            ),
          ),
          const SizedBox(height: JkSpacing.s3),
          _why(l10n.kycStorageNote),
        ];
    }
  }

  static String _maskId(String id) {
    if (id.length <= 4) return id;
    return '${'•' * (id.length - 4)}${id.substring(id.length - 4)}';
  }
}
