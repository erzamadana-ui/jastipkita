import 'package:flutter/material.dart';

import '../core/design/theme.dart';
import '../core/design/tokens.g.dart';
import '../core/domain/domain.dart';
import '../core/format/dates.dart';
import '../core/l10n/l10n.dart';
import '../core/l10n/labels.dart';
import '../core/models/transaction.dart';

enum TimelineNodeState { done, current, currentAction, upcoming, error }

class TimelineStep {
  const TimelineStep({required this.label, required this.state, this.meta});

  final String label;
  final TimelineNodeState state;
  final String? meta;
}

/// Vertical status timeline (§5.7). Node states: done (filled success + check), current (ring:
/// warning when the user must act, secondary when waiting for the other party), upcoming
/// (outline ring), error (filled error, for CANCELLED/DISPUTED/refund).
class StatusTimeline extends StatelessWidget {
  const StatusTimeline({super.key, required this.steps});

  final List<TimelineStep> steps;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final rows = <Widget>[];
    for (var i = 0; i < steps.length; i++) {
      rows.add(
        _TimelineRow(
          step: steps[i],
          isLast: i == steps.length - 1,
          nextDone: i + 1 < steps.length && steps[i + 1].state == TimelineNodeState.done,
          semantics: l10n.timelineStepSemantics(i + 1, steps.length, _stateLabel(l10n, steps[i].state), steps[i].label),
        ),
      );
    }
    return Semantics(
      container: true,
      explicitChildNodes: true,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows),
    );
  }

  static String _stateLabel(AppLocalizations l10n, TimelineNodeState state) => switch (state) {
        TimelineNodeState.done => l10n.timelineDone,
        TimelineNodeState.current => l10n.timelineCurrent,
        TimelineNodeState.currentAction => l10n.timelineActionNeeded,
        TimelineNodeState.upcoming => l10n.timelineUpcoming,
        TimelineNodeState.error => l10n.timelineStopped,
      };
}

class _TimelineRow extends StatelessWidget {
  const _TimelineRow({required this.step, required this.isLast, required this.nextDone, required this.semantics});

  final TimelineStep step;
  final bool isLast;
  final bool nextDone;
  final String semantics;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final state = step.state;
    final meta = step.meta;
    final isUpcoming = state == TimelineNodeState.upcoming;
    final lineColor = state == TimelineNodeState.done && nextDone ? jk.success : jk.border;
    return Semantics(
      label: semantics,
      excludeSemantics: true,
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            SizedBox(
              width: 24,
              child: Column(
                children: <Widget>[
                  _Node(state: state),
                  if (!isLast)
                    Expanded(
                      child: Center(child: SizedBox(width: 2, child: ColoredBox(color: lineColor))),
                    ),
                ],
              ),
            ),
            const SizedBox(width: JkSpacing.s3),
            Expanded(
              child: Padding(
                padding: EdgeInsets.only(bottom: isLast ? 0 : JkSpacing.s4),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      step.label,
                      style: JkTypeScale.bodyL.copyWith(
                        color: isUpcoming ? jk.onSurfaceMuted : jk.onSurface,
                        fontWeight: state == TimelineNodeState.current || state == TimelineNodeState.currentAction
                            ? FontWeight.w600
                            : FontWeight.w400,
                      ),
                    ),
                    if (meta != null) Text(meta, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Node extends StatelessWidget {
  const _Node({required this.state});

  final TimelineNodeState state;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    const size = 22.0;
    switch (state) {
      case TimelineNodeState.done:
        return Container(
          width: size,
          height: size,
          decoration: BoxDecoration(color: jk.success, shape: BoxShape.circle),
          child: Icon(Icons.check, size: 14, color: jk.onSuccess),
        );
      case TimelineNodeState.error:
        return Container(
          width: size,
          height: size,
          decoration: BoxDecoration(color: jk.error, shape: BoxShape.circle),
          child: Icon(Icons.close, size: 14, color: jk.onError),
        );
      case TimelineNodeState.current:
      case TimelineNodeState.currentAction:
        final ring = state == TimelineNodeState.currentAction ? jk.warning : jk.secondary;
        return Container(
          width: size,
          height: size,
          alignment: Alignment.center,
          decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: ring, width: 2.5), color: jk.surface),
          child: Container(width: 9, height: 9, decoration: BoxDecoration(color: ring, shape: BoxShape.circle)),
        );
      case TimelineNodeState.upcoming:
        return Container(
          width: size,
          height: size,
          decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: jk.outline, width: 2), color: jk.surface),
        );
    }
  }
}

/// Maps the 19 domain statuses onto 10 friendly steps (buyer or traveler wording).
abstract final class TxTimeline {
  static const List<Set<String>> _stepStatuses = <Set<String>>[
    <String>{TxStatus.requestCreated},
    <String>{TxStatus.matched},
    <String>{TxStatus.awaitingPayment},
    <String>{TxStatus.paymentSecured},
    <String>{TxStatus.priceChangePending, TxStatus.purchaseApproved},
    <String>{TxStatus.purchased},
    <String>{TxStatus.traveling},
    <String>{TxStatus.arrived, TxStatus.customsProcess},
    <String>{TxStatus.readyForHandover, TxStatus.outForDelivery, TxStatus.delivered, TxStatus.buyerConfirmed},
    <String>{TxStatus.completed},
  ];

  static int get stepCount => _stepStatuses.length;

  /// Index of the step in progress for [status]; `stepCount` when everything is done.
  static int currentIndex(String status) {
    switch (status) {
      case TxStatus.requestCreated:
        return 1;
      case TxStatus.matched:
      case TxStatus.awaitingPayment:
        return 2;
      case TxStatus.paymentSecured:
      case TxStatus.priceChangePending:
        return 4;
      case TxStatus.purchaseApproved:
        return 5;
      case TxStatus.purchased:
      case TxStatus.traveling:
        return 6;
      case TxStatus.arrived:
      case TxStatus.customsProcess:
        return 7;
      case TxStatus.readyForHandover:
      case TxStatus.outForDelivery:
      case TxStatus.delivered:
        return 8;
      case TxStatus.buyerConfirmed:
        return 9;
      case TxStatus.completed:
        return 10;
      default:
        return 0;
    }
  }

  static List<String> _labels(AppLocalizations l10n, bool traveler) => <String>[
        l10n.stepCreated,
        traveler ? l10n.stepMatchedTraveler : l10n.stepMatched,
        traveler ? l10n.stepAwaitBuyerPayment : l10n.stepPay,
        l10n.stepSecured,
        traveler ? l10n.stepPriceConfirmTraveler : l10n.stepPriceConfirm,
        traveler ? l10n.stepPurchaseTraveler : l10n.stepPurchased,
        l10n.stepTraveling,
        l10n.stepArrived,
        l10n.stepHandover,
        l10n.stepCompleted,
      ];

  static List<TimelineStep> build({
    required AppLocalizations l10n,
    required String status,
    required String locale,
    List<TimelineEvent> events = const <TimelineEvent>[],
    bool traveler = false,
    bool actionNeeded = false,
  }) {
    final labels = _labels(l10n, traveler);
    var current = currentIndex(status);
    var errorIndex = -1;
    if (TxStatus.errorStates.contains(status)) {
      String? previous;
      for (final e in events.reversed) {
        if (e.to == status) {
          previous = e.from;
          break;
        }
      }
      current = previous == null ? 0 : currentIndex(previous);
      if (current >= stepCount) current = stepCount - 1;
      errorIndex = current;
    }
    final steps = <TimelineStep>[];
    for (var i = 0; i < stepCount; i++) {
      final reachedAt = _firstAt(events, _stepStatuses[i]);
      final meta = reachedAt == null ? null : JkDates.shortDateTime(reachedAt, locale);
      if (i == errorIndex) {
        steps.add(TimelineStep(label: Labels.txStatus(l10n, status), state: TimelineNodeState.error, meta: meta));
      } else if (i < current) {
        steps.add(TimelineStep(label: labels[i], state: TimelineNodeState.done, meta: meta));
      } else if (i == current && errorIndex < 0) {
        steps.add(
          TimelineStep(
            label: labels[i],
            state: actionNeeded ? TimelineNodeState.currentAction : TimelineNodeState.current,
          ),
        );
      } else {
        steps.add(TimelineStep(label: labels[i], state: TimelineNodeState.upcoming));
      }
    }
    return steps;
  }

  static DateTime? _firstAt(List<TimelineEvent> events, Set<String> statuses) {
    for (final e in events) {
      if (statuses.contains(e.to)) return e.at;
    }
    return null;
  }
}

/// Five-segment progress for cards on the home screen (Aman · Dibeli · Terbang · Tiba · Serah).
class CompactProgress extends StatelessWidget {
  const CompactProgress({super.key, required this.status});

  final String status;

  /// (completed segments, segment in progress or -1).
  static (int, int) progressOf(String status) {
    switch (status) {
      case TxStatus.paymentSecured:
      case TxStatus.priceChangePending:
      case TxStatus.purchaseApproved:
        return (1, 1);
      case TxStatus.purchased:
      case TxStatus.traveling:
        return (2, 2);
      case TxStatus.arrived:
      case TxStatus.customsProcess:
        return (3, 3);
      case TxStatus.readyForHandover:
      case TxStatus.outForDelivery:
        return (4, 4);
      case TxStatus.delivered:
      case TxStatus.buyerConfirmed:
      case TxStatus.completed:
        return (5, -1);
      default:
        return (0, 0);
    }
  }

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final labels = <String>[l10n.segSecured, l10n.segPurchased, l10n.segFlying, l10n.segArrived, l10n.segHandover];
    final (done, active) = progressOf(status);
    final tone = jk.statusTone(status);
    final bars = <Widget>[];
    final texts = <Widget>[];
    for (var i = 0; i < labels.length; i++) {
      if (i > 0) {
        bars.add(const SizedBox(width: 4));
        texts.add(const SizedBox(width: 4));
      }
      final filled = i < done;
      final partial = i == active && !filled;
      bars.add(
        Expanded(
          child: ClipRRect(
            borderRadius: JkRadii.pillAll,
            child: SizedBox(
              height: 6,
              child: LinearProgressIndicator(
                value: filled ? 1 : (partial ? 0.5 : 0),
                color: tone.dot,
                backgroundColor: jk.surfaceMuted,
              ),
            ),
          ),
        ),
      );
      texts.add(
        Expanded(
          child: Text(
            labels[i],
            textAlign: TextAlign.center,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: JkTypeScale.labelS.copyWith(
              color: i == active ? tone.fg : jk.onSurfaceMuted,
              fontWeight: i == active ? FontWeight.w600 : FontWeight.w500,
            ),
          ),
        ),
      );
    }
    final activeLabel = active >= 0 && active < labels.length ? labels[active] : l10n.segHandover;
    return Semantics(
      label: l10n.compactProgressSemantics(done, labels.length, activeLabel),
      excludeSemantics: true,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(children: bars),
          const SizedBox(height: 6),
          Row(children: texts),
        ],
      ),
    );
  }
}
