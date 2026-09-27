import 'package:flutter/widgets.dart';

import '../../l10n/app_localizations.dart';
import '../network/api_exception.dart';
import '../network/step_up.dart';

export '../../l10n/app_localizations.dart';

extension L10nContext on BuildContext {
  /// All user-facing strings (`lib/l10n/app_id.arb` default, `app_en.arb`).
  AppLocalizations get l10n => AppLocalizations.of(this);

  /// `id` | `en` — used by money/date formatters.
  String get localeCode => Localizations.localeOf(this).languageCode == 'en' ? 'en' : 'id';
}

/// Human message for any error thrown by repositories. Server messages are already localised
/// (Indonesian by default, `Accept-Language` aware); transport errors use app strings.
String errorMessage(AppLocalizations l10n, Object error) {
  if (error is StepUpCancelled) return l10n.stepUpCancelled;
  if (error is ApiException) {
    if (error.code == ApiException.network) return l10n.errorNetwork;
    if (error.code == ApiException.timeout) return l10n.errorTimeout;
    if (error.statusCode == 401) return l10n.errorSessionExpired;
    if (error.statusCode == 429) return l10n.errorRateLimited;
    final known = _knownCodeMessage(l10n, error);
    if (known != null) return known;
    if (error.message.isNotEmpty) return error.message;
    if ((error.statusCode ?? 0) >= 500) return l10n.errorServer;
  }
  return l10n.errorGeneric;
}

/// Codes whose server text is too technical for the screens that can meet them.
String? _knownCodeMessage(AppLocalizations l10n, ApiException error) {
  switch (error.code) {
    // 422 on quote / checkout: the trip was cancelled or has ended (`details.tripStatus`).
    case 'TRIP_NOT_AVAILABLE':
      return error.details['tripStatus'] == 'COMPLETED' ? l10n.tripNotAvailableCompleted : l10n.tripNotAvailableCancelled;
    // 409 on trip cancel once goods were bought (`details.transactionIds`).
    case 'TRIP_HAS_PURCHASED_TRANSACTIONS':
      final ids = error.details['transactionIds'];
      return l10n.tripHasPurchasedBody(ids is List && ids.isNotEmpty ? ids.length : 1);
    case StepUpRequest.requiredCode:
      return l10n.stepUpRequired;
    case StepUpRequest.mismatchCode:
      return l10n.stepUpMismatch;
    case 'STEP_UP_DESTINATION_NOT_VERIFIED':
      return l10n.stepUpDestinationNotVerified;
    default:
      return null;
  }
}
