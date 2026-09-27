import 'package:flutter/widgets.dart';

import '../../l10n/app_localizations.dart';
import '../network/api_exception.dart';

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
  if (error is ApiException) {
    if (error.code == ApiException.network) return l10n.errorNetwork;
    if (error.code == ApiException.timeout) return l10n.errorTimeout;
    if (error.statusCode == 401) return l10n.errorSessionExpired;
    if (error.statusCode == 429) return l10n.errorRateLimited;
    if (error.message.isNotEmpty) return error.message;
    if ((error.statusCode ?? 0) >= 500) return l10n.errorServer;
  }
  return l10n.errorGeneric;
}
