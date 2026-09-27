import 'package:flutter/services.dart';

/// Haptic moments from docs/05-ui-design-system.md §4.6. Never the only signal, and switchable
/// in Settings (callers pass the user's preference).
abstract final class JkHaptics {
  /// Payment secured, item accepted, handover verified.
  static void success(bool enabled) {
    if (enabled) HapticFeedback.mediumImpact();
  }

  /// DO NOT PURCHASE shown, wrong PIN.
  static void error(bool enabled) {
    if (enabled) HapticFeedback.heavyImpact();
  }

  /// FX lock / confirmation window below 60 seconds.
  static void warning(bool enabled) {
    if (enabled) HapticFeedback.lightImpact();
  }

  /// Toggles and chip selection.
  static void selection(bool enabled) {
    if (enabled) HapticFeedback.selectionClick();
  }
}
