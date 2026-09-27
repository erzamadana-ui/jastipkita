import 'dart:async';

import 'package:flutter/material.dart';

import '../core/design/theme.dart';
import '../core/design/tokens.g.dart';
import '../core/format/dates.dart';
import '../core/l10n/l10n.dart';

/// Countdown (§5.8) for FX lock, price-confirmation window, invoice expiry and QR TTL.
/// The deadline comes from the server (`expiresAt`); the client only counts down and recomputes
/// from the wall clock every tick, so drift after resume corrects itself. It never disappears
/// silently: when the time is up it becomes a "Perbarui" action or an expired label.
class CountdownChip extends StatefulWidget {
  const CountdownChip({
    super.key,
    required this.expiresAt,
    this.label,
    this.icon = Icons.lock_outline,
    this.onExpired,
    this.onRenew,
    this.onFinalMinute,
    this.clock,
  });

  final DateTime expiresAt;
  final String? label;
  final IconData icon;
  final VoidCallback? onExpired;
  final VoidCallback? onRenew;

  /// Fired once when ≤ 60 s remain (haptic warning hook).
  final VoidCallback? onFinalMinute;

  /// Injectable for tests.
  final DateTime Function()? clock;

  @override
  State<CountdownChip> createState() => _CountdownChipState();
}

class _CountdownChipState extends State<CountdownChip> {
  Timer? _timer;
  bool _expiredFired = false;
  bool _finalMinuteFired = false;

  DateTime _now() => (widget.clock ?? DateTime.now)().toUtc();

  Duration get _remaining => widget.expiresAt.toUtc().difference(_now());

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (Timer timer) => _tick());
  }

  @override
  void didUpdateWidget(covariant CountdownChip oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.expiresAt != widget.expiresAt) {
      _expiredFired = false;
      _finalMinuteFired = false;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _tick() {
    if (!mounted) return;
    final remaining = _remaining;
    if (!_finalMinuteFired && remaining.inSeconds <= 60 && remaining.inSeconds > 0) {
      _finalMinuteFired = true;
      widget.onFinalMinute?.call();
    }
    if (!_expiredFired && remaining.inSeconds <= 0) {
      _expiredFired = true;
      widget.onExpired?.call();
    }
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final remaining = _remaining;
    final label = widget.label;
    if (remaining.inSeconds <= 0) {
      final renew = widget.onRenew;
      if (renew != null) {
        return ActionChip(
          avatar: Icon(Icons.refresh, size: 18, color: jk.onErrorContainer),
          label: Text(l10n.countdownRenew),
          labelStyle: JkTypeScale.labelL.copyWith(color: jk.onErrorContainer, fontWeight: FontWeight.w600),
          backgroundColor: jk.errorContainer,
          side: BorderSide(color: jk.error),
          onPressed: renew,
        );
      }
      return _chip(jk.errorContainer, jk.onErrorContainer, Icons.timer_off_outlined, l10n.countdownExpired, l10n.countdownExpired);
    }
    final Color bg;
    final Color fg;
    if (remaining.inSeconds <= 60) {
      bg = jk.errorContainer;
      fg = jk.onErrorContainer;
    } else if (remaining.inMinutes < 5) {
      bg = jk.warningContainer;
      fg = jk.onWarningContainer;
    } else {
      bg = jk.infoContainer;
      fg = jk.onInfoContainer;
    }
    final time = JkDates.countdown(remaining);
    final text = label == null ? time : '$label $time';
    final spoken = l10n.countdownSemantics(label ?? '', remaining.inMinutes, remaining.inSeconds.remainder(60));
    return _chip(bg, fg, widget.icon, text, spoken);
  }

  Widget _chip(Color bg, Color fg, IconData icon, String text, String spoken) {
    return Semantics(
      label: spoken,
      excludeSemantics: true,
      child: DecoratedBox(
        decoration: BoxDecoration(color: bg, borderRadius: JkRadii.pillAll),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(icon, size: 16, color: fg),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  text,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: JkTypeScale.moneyS.copyWith(color: fg, fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
