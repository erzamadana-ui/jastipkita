import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../../core/design/haptics.dart';
import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/transaction.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/storage/settings.dart';
import '../../../widgets/common.dart';
import '../../../widgets/countdown_chip.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/sheets_and_glass.dart';
import '../../../widgets/states.dart';
import '../data/transaction_repository.dart';

/// Buyer: one-time handover PIN + QR (rotated on every reveal, never cached) for MEETUP (§5.16).
class HandoverScreen extends ConsumerStatefulWidget {
  const HandoverScreen({super.key, required this.transactionId});

  final String transactionId;

  @override
  ConsumerState<HandoverScreen> createState() => _HandoverScreenState();
}

class _HandoverScreenState extends ConsumerState<HandoverScreen> {
  HandoverPin? _pin;
  Object? _error;
  bool _loading = false;
  bool _qrExpired = false;
  final Set<int> _checked = <int>{};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((Duration _) => _reveal());
  }

  Future<void> _reveal() async {
    if (!mounted) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final pin = await ref.read(transactionRepositoryProvider).revealPin(widget.transactionId);
      if (!mounted) return;
      setState(() {
        _pin = pin;
        _qrExpired = false;
      });
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final pin = _pin;
    final error = _error;
    final checklist = <String>[l10n.handoverCheck1, l10n.handoverCheck2, l10n.handoverCheck3];
    return Scaffold(
      appBar: AppBar(title: Text(l10n.handoverTitle)),
      body: ListView(
        padding: const EdgeInsets.all(JkSpacing.s5),
        children: <Widget>[
          NoticeBox(tone: NoticeTone.warning, icon: Icons.inventory_2_outlined, message: l10n.handoverWarning),
          const SizedBox(height: JkSpacing.s4),
          if (pin == null && _loading) const Center(child: Padding(padding: EdgeInsets.all(JkSpacing.s8), child: CircularProgressIndicator())),
          if (pin == null && error != null)
            error is ApiException && error.code == 'PIN_LOCKED'
                ? NoticeBox(tone: NoticeTone.error, message: l10n.pinLocked)
                : ErrorView(error: error, onRetry: _reveal),
          if (pin != null) ...<Widget>[
            JkCard(
              child: Column(
                children: <Widget>[
                  Text(l10n.handoverPinLabel, style: JkTypeScale.labelL.copyWith(color: jk.onSurfaceMuted)),
                  const SizedBox(height: JkSpacing.s2),
                  Semantics(
                    label: l10n.handoverPinSemantics(pin.pin.split('').join(' ')),
                    excludeSemantics: true,
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text(pin.groupedPin, style: JkTypeScale.display.copyWith(color: jk.onSurface, letterSpacing: 6, fontFeatures: JkTypeScale.moneyL.fontFeatures)),
                    ),
                  ),
                  if (pin.attemptsRemaining != null)
                    Text(l10n.handoverAttempts(pin.attemptsRemaining!), style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                ],
              ),
            ),
            const SizedBox(height: JkSpacing.s4),
            JkCard(
              child: Column(
                children: <Widget>[
                  Opacity(
                    opacity: _qrExpired ? 0.15 : 1,
                    child: DecoratedBox(
                      decoration: const BoxDecoration(color: JkPalette.white, borderRadius: JkRadii.mdAll),
                      child: Padding(
                        padding: const EdgeInsets.all(JkSpacing.s3),
                        child: QrImageView(
                          data: pin.qrPayload,
                          size: 220,
                          backgroundColor: JkPalette.white,
                          semanticsLabel: l10n.handoverQrSemantics,
                          eyeStyle: const QrEyeStyle(eyeShape: QrEyeShape.square, color: JkPalette.navy900),
                          dataModuleStyle: const QrDataModuleStyle(dataModuleShape: QrDataModuleShape.square, color: JkPalette.navy900),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: JkSpacing.s3),
                  if (pin.qrExpiresAt != null)
                    CountdownChip(
                      expiresAt: pin.qrExpiresAt!,
                      label: l10n.handoverQrLabel,
                      icon: Icons.qr_code_2,
                      onExpired: () => setState(() => _qrExpired = true),
                      onRenew: _reveal,
                    ),
                ],
              ),
            ),
            const SizedBox(height: JkSpacing.s3),
            Text(l10n.handoverScreenshotNote, style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted)),
            SectionHeader(title: l10n.handoverChecklistTitle),
            for (var i = 0; i < checklist.length; i++)
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                value: _checked.contains(i),
                onChanged: (bool? v) => setState(() => v == true ? _checked.add(i) : _checked.remove(i)),
                title: Text(checklist[i]),
              ),
            const SizedBox(height: JkSpacing.s3),
            JkButton(label: l10n.handoverRefresh, icon: Icons.refresh, variant: JkButtonVariant.secondary, loading: _loading, onPressed: _reveal),
          ],
        ],
      ),
    );
  }
}

/// Traveler: verify the buyer's handover QR (camera) or 6-digit PIN → DELIVERED.
/// Floating scanner controls may use glass; the scan frame never does.
class VerifyHandoverScreen extends ConsumerStatefulWidget {
  const VerifyHandoverScreen({super.key, required this.transactionId});

  final String transactionId;

  @override
  ConsumerState<VerifyHandoverScreen> createState() => _VerifyHandoverScreenState();
}

class _VerifyHandoverScreenState extends ConsumerState<VerifyHandoverScreen> {
  final MobileScannerController _scanner = MobileScannerController(formats: const <BarcodeFormat>[BarcodeFormat.qrCode]);
  final TextEditingController _pin = TextEditingController();
  bool _scanMode = true;
  bool _busy = false;
  bool _done = false;
  String? _error;

  @override
  void dispose() {
    _scanner.dispose();
    _pin.dispose();
    super.dispose();
  }

  /// `jastipkita://handover/{txId}?t={token}` → token (only for this transaction).
  String? _tokenFrom(String raw) {
    final uri = Uri.tryParse(raw);
    if (uri != null && uri.scheme == 'jastipkita') {
      final segments = <String>[if (uri.host.isNotEmpty) uri.host, ...uri.pathSegments];
      if (segments.length < 2 || segments[0] != 'handover' || segments[1] != widget.transactionId) return null;
      return uri.queryParameters['t'];
    }
    return raw.length >= 16 && !raw.contains(' ') ? raw : null;
  }

  void _onDetect(BarcodeCapture capture) {
    if (_busy || _done || capture.barcodes.isEmpty) return;
    final raw = capture.barcodes.first.rawValue;
    if (raw == null) return;
    final token = _tokenFrom(raw);
    if (token == null) {
      setState(() => _error = context.l10n.verifyWrongQr);
      return;
    }
    _verify(qrToken: token);
  }

  Future<void> _verify({String? pin, String? qrToken}) async {
    if (_busy || _done) return;
    final l10n = context.l10n;
    final haptics = ref.read(settingsProvider).haptics;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(transactionRepositoryProvider).verifyHandover(widget.transactionId, pin: pin, qrToken: qrToken);
      _done = true;
      JkHaptics.success(haptics);
      ref.invalidate(transactionDetailProvider(widget.transactionId));
      ref.invalidate(transactionTimelineProvider(widget.transactionId));
      if (!mounted) return;
      showJkSnack(context, l10n.verifySuccess);
      context.pop();
    } on Object catch (e) {
      JkHaptics.error(haptics);
      if (!mounted) return;
      final code = e is ApiException ? e.code : '';
      final Object? remaining = e is ApiException ? e.details['attemptsRemaining'] : null;
      setState(() {
        _error = code == 'PIN_LOCKED'
            ? l10n.pinLocked
            : code == 'PIN_INVALID'
                ? l10n.verifyWrongPin(remaining is int ? remaining : 0)
                : errorMessage(l10n, e);
      });
      _pin.clear();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final error = _error;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.verifyHandover)),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s4, JkSpacing.s5, JkSpacing.s2),
            child: SegmentedButton<bool>(
              segments: <ButtonSegment<bool>>[
                ButtonSegment<bool>(value: true, label: Text(l10n.verifyScanQr), icon: const Icon(Icons.qr_code_scanner)),
                ButtonSegment<bool>(value: false, label: Text(l10n.verifyEnterPin), icon: const Icon(Icons.pin_outlined)),
              ],
              selected: <bool>{_scanMode},
              onSelectionChanged: (Set<bool> s) => setState(() {
                _scanMode = s.first;
                _error = null;
              }),
            ),
          ),
          if (error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: JkSpacing.s5, vertical: JkSpacing.s2),
              child: NoticeBox(tone: NoticeTone.error, message: error),
            ),
          Expanded(
            child: _scanMode
                ? Padding(
                    padding: const EdgeInsets.all(JkSpacing.s5),
                    child: ClipRRect(
                      borderRadius: JkRadii.lgAll,
                      child: Stack(
                        fit: StackFit.expand,
                        children: <Widget>[
                          MobileScanner(controller: _scanner, onDetect: _onDetect),
                          IgnorePointer(
                            child: Center(
                              child: Container(
                                width: 240,
                                height: 240,
                                decoration: BoxDecoration(
                                  borderRadius: JkRadii.lgAll,
                                  border: Border.all(color: JkPalette.white, width: 3),
                                ),
                              ),
                            ),
                          ),
                          Positioned(
                            left: JkSpacing.s4,
                            right: JkSpacing.s4,
                            bottom: JkSpacing.s4,
                            child: Center(
                              child: GlassSurface(
                                child: Padding(
                                  padding: const EdgeInsets.symmetric(horizontal: JkSpacing.s2, vertical: 4),
                                  child: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: <Widget>[
                                      IconButton(
                                        tooltip: l10n.verifyTorch,
                                        color: jk.onGlass,
                                        onPressed: () => _scanner.toggleTorch(),
                                        icon: const Icon(Icons.flashlight_on_outlined),
                                      ),
                                      IconButton(
                                        tooltip: l10n.verifySwitchCamera,
                                        color: jk.onGlass,
                                        onPressed: () => _scanner.switchCamera(),
                                        icon: const Icon(Icons.cameraswitch_outlined),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            ),
                          ),
                          if (_busy) const Center(child: CircularProgressIndicator()),
                        ],
                      ),
                    ),
                  )
                : ListView(
                    padding: const EdgeInsets.all(JkSpacing.s5),
                    children: <Widget>[
                      Text(l10n.verifyPinIntro, style: JkTypeScale.bodyM.copyWith(color: jk.onBackground)),
                      const SizedBox(height: JkSpacing.s4),
                      OtpField(
                        controller: _pin,
                        semanticsLabel: l10n.verifyEnterPin,
                        enabled: !_busy,
                        onCompleted: (String code) => _verify(pin: code),
                      ),
                      const SizedBox(height: JkSpacing.s4),
                      JkButton(label: l10n.verifySubmit, loading: _busy, onPressed: () => _verify(pin: _pin.text)),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}
