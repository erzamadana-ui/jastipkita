import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/config/app_config.dart';
import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/account.dart';
import '../../../core/models/json.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/network/step_up.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/sheets_and_glass.dart';
import '../../kyc/presentation/phone_verification.dart';
import '../application/session_controller.dart';
import '../data/auth_repository.dart';
import 'otp_screen.dart';

/// The app's [StepUpPrompt]: `repository.addPayoutAccount(..., stepUp: stepUpPrompt(context))`.
/// [context] must stay mounted while the protected call runs (the sheet opens from it).
StepUpPrompt stepUpPrompt(BuildContext context) {
  Future<T> prompt<T>(StepUpRequest request, Future<T> Function(StepUpProof proof) submit) =>
      showStepUpSheet<T>(context, request: request, submit: submit);
  return prompt;
}

/// Step-up sheet (SEC-12): pick a verified phone / e-mail → `SENSITIVE_ACTION` OTP bound to
/// [request] → enter the code → [submit] repeats the protected call with a fresh
/// [StepUpProof]. A mistyped code keeps the sheet open (same challenge, new code); an expired,
/// locked or mismatched code asks for a new one. Any other error means the server already
/// consumed the proof (or the action itself failed): the sheet closes and the error is rethrown
/// to the caller's form. Throws [StepUpCancelled] when the user closes the sheet.
Future<T> showStepUpSheet<T>(
  BuildContext context, {
  required StepUpRequest request,
  required Future<T> Function(StepUpProof proof) submit,
}) async {
  if (!context.mounted) throw const StepUpCancelled();
  final outcome = await showJkBottomSheet<_StepUpOutcome<T>>(
    context,
    title: context.l10n.stepUpTitle,
    builder: (BuildContext sheetContext) => _StepUpBody<T>(request: request, submit: submit),
  );
  if (outcome == null) throw const StepUpCancelled();
  final error = outcome.error;
  if (error != null) Error.throwWithStackTrace(error, outcome.stackTrace ?? StackTrace.current);
  return outcome.value as T;
}

/// Where a step-up code can go: only verified contacts (the API refuses others with
/// `422 STEP_UP_DESTINATION_NOT_VERIFIED`).
class StepUpDestination {
  const StepUpDestination(this.channel, this.destination);

  /// `WHATSAPP` | `SMS` | `EMAIL`.
  final String channel;
  final String destination;

  @override
  bool operator ==(Object other) => other is StepUpDestination && other.channel == channel && other.destination == destination;

  @override
  int get hashCode => Object.hash(channel, destination);
}

List<StepUpDestination> stepUpDestinations(Profile? profile) {
  if (profile == null) return const <StepUpDestination>[];
  final out = <StepUpDestination>[];
  final phone = profile.phone;
  if (profile.phoneVerified && phone != null && phone.isNotEmpty) {
    out
      ..add(StepUpDestination('WHATSAPP', phone))
      ..add(StepUpDestination('SMS', phone));
  }
  final email = profile.email;
  if (profile.emailVerified && email != null && email.isNotEmpty) out.add(StepUpDestination('EMAIL', email));
  // The transaction e-mail is only stored after its own VERIFY_EMAIL.
  final txEmail = profile.transactionEmail;
  if (txEmail != null && txEmail.isNotEmpty && txEmail.toLowerCase() != email?.toLowerCase()) {
    out.add(StepUpDestination('EMAIL', txEmail));
  }
  return out;
}

/// `+6281••••7890`, `an•••@mail.com` — enough to recognise, not to copy.
String maskContact(String value) {
  final at = value.indexOf('@');
  if (at > 0) {
    final local = value.substring(0, at);
    return '${local.substring(0, local.length > 2 ? 2 : 1)}•••${value.substring(at)}';
  }
  if (value.length <= 8) return value;
  return '${value.substring(0, 5)}••••${value.substring(value.length - 4)}';
}

class _StepUpOutcome<T> {
  _StepUpOutcome.done(this.value)
      : error = null,
        stackTrace = null;

  _StepUpOutcome.failed(Object this.error, StackTrace this.stackTrace) : value = null;

  final T? value;
  final Object? error;
  final StackTrace? stackTrace;
}

class _StepUpBody<T> extends ConsumerStatefulWidget {
  const _StepUpBody({required this.request, required this.submit});

  final StepUpRequest request;
  final Future<T> Function(StepUpProof proof) submit;

  @override
  ConsumerState<_StepUpBody<T>> createState() => _StepUpBodyState<T>();
}

class _StepUpBodyState<T> extends ConsumerState<_StepUpBody<T>> {
  final TextEditingController _code = TextEditingController();

  /// `challengeId:code` pairs already sent — a proof is never sent twice.
  final Set<String> _tried = <String>{};
  StepUpDestination? _selected;
  StepUpDestination? _sentTo;
  OtpChallenge? _challenge;
  bool _sending = false;
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _send(StepUpDestination target) async {
    if (_sending) return;
    final l10n = context.l10n;
    final locale = context.localeCode;
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      final challenge = await ref.read(authRepositoryProvider).requestStepUpOtp(
            request: widget.request,
            channel: target.channel,
            destination: target.destination,
            locale: locale,
          );
      if (!mounted) return;
      _code.clear();
      setState(() {
        _challenge = challenge;
        _sentTo = target;
      });
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = errorMessage(l10n, e));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _submit(String code) async {
    final challenge = _challenge;
    if (challenge == null || _submitting || code.length != 6) return;
    final l10n = context.l10n;
    if (!_tried.add('${challenge.challengeId}:$code')) {
      // Runs inside the field's change listener: only report, the user edits the code.
      setState(() => _error = l10n.stepUpCodeUsed);
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final value = await widget.submit(StepUpProof(challengeId: challenge.challengeId, code: code));
      if (!mounted) return;
      Navigator.of(context).pop(_StepUpOutcome<T>.done(value));
    } on ApiException catch (e, stackTrace) {
      if (!mounted) return;
      final retry = _retryableCodeError(l10n, e);
      if (retry == null) {
        Navigator.of(context).pop(_StepUpOutcome<T>.failed(e, stackTrace));
        return;
      }
      _code.clear();
      setState(() {
        _error = retry.message;
        if (!retry.keepChallenge) _challenge = null;
      });
    } on Object catch (e, stackTrace) {
      if (!mounted) return;
      Navigator.of(context).pop(_StepUpOutcome<T>.failed(e, stackTrace));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _verifyPhone() async {
    await startPhoneVerification(context, ref);
  }

  String _intro(AppLocalizations l10n) => switch (widget.request.action) {
        SensitiveAction.refundDestinationSet => l10n.stepUpIntroRefund,
        SensitiveAction.payoutAccountAdd => l10n.stepUpIntroPayoutAdd,
        SensitiveAction.payoutAccountSetDefault => l10n.stepUpIntroPayoutDefault,
        _ => l10n.stepUpIntroGeneric,
      };

  static String _channelName(AppLocalizations l10n, String channel) => switch (channel) {
        'WHATSAPP' => 'WhatsApp',
        'SMS' => 'SMS',
        _ => l10n.stepUpChannelEmail,
      };

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final options = stepUpDestinations(ref.watch(currentProfileProvider));
    final picked = _selected;
    final selected = picked != null && options.contains(picked) ? picked : (options.isEmpty ? null : options.first);
    final challenge = _challenge;
    final sentTo = _sentTo;
    final error = _error;
    final devCode = challenge?.devCode;
    return PopScope(
      canPop: !_submitting,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(_intro(l10n), style: JkTypeScale.bodyM.copyWith(color: jk.onSurface)),
          const SizedBox(height: JkSpacing.s4),
          if (challenge == null || sentTo == null) ...<Widget>[
            if (selected == null) ...<Widget>[
              NoticeBox(tone: NoticeTone.warning, message: l10n.stepUpNoVerifiedContact),
              const SizedBox(height: JkSpacing.s3),
              JkButton(label: l10n.verifyPhone, variant: JkButtonVariant.tonal, onPressed: _verifyPhone),
            ] else ...<Widget>[
              Text(l10n.stepUpChooseDestination, style: JkTypeScale.labelL.copyWith(color: jk.onSurface)),
              const SizedBox(height: JkSpacing.s2),
              Wrap(
                spacing: JkSpacing.s2,
                runSpacing: JkSpacing.s2,
                children: <Widget>[
                  for (final option in options)
                    ChoiceChip(
                      label: Text(l10n.stepUpDestinationOption(_channelName(l10n, option.channel), maskContact(option.destination))),
                      selected: option == selected,
                      onSelected: (bool v) => setState(() => _selected = option),
                    ),
                ],
              ),
              if (error != null) ...<Widget>[
                const SizedBox(height: JkSpacing.s3),
                NoticeBox(tone: NoticeTone.error, message: error),
              ],
              const SizedBox(height: JkSpacing.s4),
              JkButton(label: l10n.loginSendCode, loading: _sending, onPressed: _sending ? null : () => _send(selected)),
            ],
          ] else ...<Widget>[
            Text(l10n.otpSentTo(maskContact(sentTo.destination)), style: JkTypeScale.bodyM.copyWith(color: jk.onSurface)),
            const SizedBox(height: JkSpacing.s1),
            Text(l10n.stepUpExpiryNote, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
            const SizedBox(height: JkSpacing.s4),
            OtpField(
              controller: _code,
              semanticsLabel: l10n.otpFieldLabel,
              errorText: error,
              onCompleted: _submit,
              enabled: !_submitting,
            ),
            if (devCode != null && !AppConfig.isProduction)
              Padding(
                padding: const EdgeInsets.only(top: JkSpacing.s2),
                child: Text(l10n.otpDevCode(devCode), style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
              ),
            const SizedBox(height: JkSpacing.s4),
            JkButton(label: l10n.stepUpConfirm, loading: _submitting, onPressed: _submitting ? null : () => _submit(_code.text)),
            ResendCodeButton(availableAt: challenge.resendAvailableAt, onResend: () => _send(sentTo)),
            JkButton(
              label: l10n.stepUpChangeDestination,
              variant: JkButtonVariant.tertiary,
              onPressed: _submitting
                  ? null
                  : () => setState(() {
                        _challenge = null;
                        _error = null;
                      }),
            ),
          ],
        ],
      ),
    );
  }
}

class _CodeRetry {
  const _CodeRetry(this.message, {required this.keepChallenge});

  final String message;

  /// Only a wrong code (with attempts left) keeps the challenge; the user types another code.
  final bool keepChallenge;
}

/// Errors after which the user can try again inside the sheet; null = close and rethrow.
_CodeRetry? _retryableCodeError(AppLocalizations l10n, ApiException e) {
  switch (e.code) {
    case 'OTP_INVALID':
      // With `remainingAttempts` the code was wrong and the challenge is still open; without it the
      // challenge is unknown or already consumed, so a new code is needed.
      final left = readIntOrNull(e.details, 'remainingAttempts');
      return left == null ? _CodeRetry(l10n.otpInvalid, keepChallenge: false) : _CodeRetry(l10n.stepUpAttemptsLeft(left), keepChallenge: left > 0);
    case 'OTP_EXPIRED':
      return _CodeRetry(l10n.otpExpired, keepChallenge: false);
    case 'OTP_LOCKED':
      return _CodeRetry(l10n.otpLocked, keepChallenge: false);
    case StepUpRequest.mismatchCode:
      return _CodeRetry(l10n.stepUpMismatch, keepChallenge: false);
    case StepUpRequest.requiredCode:
      return _CodeRetry(l10n.stepUpRequired, keepChallenge: false);
    default:
      return null;
  }
}
