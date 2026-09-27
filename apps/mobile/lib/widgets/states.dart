import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/design/theme.dart';
import '../core/design/tokens.g.dart';
import '../core/l10n/l10n.dart';
import 'jk_button.dart';

/// Empty state (§5.18): icon · title · short message · one CTA.
class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.title,
    this.message,
    this.icon = Icons.travel_explore_outlined,
    this.actionLabel,
    this.onAction,
  });

  final String title;
  final String? message;
  final IconData icon;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final body = message;
    final label = actionLabel;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: JkSpacing.s6, vertical: JkSpacing.s8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          ExcludeSemantics(child: Icon(icon, size: 72, color: jk.onSurfaceMuted)),
          const SizedBox(height: JkSpacing.s4),
          Text(title, textAlign: TextAlign.center, style: JkTypeScale.titleM.copyWith(color: jk.onBackground)),
          if (body != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            Text(body, textAlign: TextAlign.center, style: JkTypeScale.bodyM.copyWith(color: jk.onBackgroundMuted)),
          ],
          if (label != null && onAction != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s5),
            JkButton(label: label, onPressed: onAction, expand: false),
          ],
        ],
      ),
    );
  }
}

/// Error state with retry (same pattern as [EmptyState]).
class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.error, this.onRetry, this.compact = false});

  final Object error;
  final VoidCallback? onRetry;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final message = errorMessage(l10n, error);
    if (compact) {
      return Padding(
        padding: const EdgeInsets.all(JkSpacing.s3),
        child: Row(
          children: <Widget>[
            Icon(Icons.error_outline, color: jk.errorText),
            const SizedBox(width: JkSpacing.s2),
            Expanded(child: Text(message, style: JkTypeScale.bodyS.copyWith(color: jk.errorText))),
            if (onRetry != null) TextButton(onPressed: onRetry, child: Text(l10n.actionRetry)),
          ],
        ),
      );
    }
    return Semantics(
      liveRegion: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: JkSpacing.s6, vertical: JkSpacing.s8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.cloud_off_outlined, size: 64, color: jk.errorText),
            const SizedBox(height: JkSpacing.s4),
            Text(l10n.errorTitle, textAlign: TextAlign.center, style: JkTypeScale.titleM.copyWith(color: jk.onBackground)),
            const SizedBox(height: JkSpacing.s2),
            Text(message, textAlign: TextAlign.center, style: JkTypeScale.bodyM.copyWith(color: jk.onBackgroundMuted)),
            if (onRetry != null) ...<Widget>[
              const SizedBox(height: JkSpacing.s5),
              JkButton(label: l10n.actionRetry, icon: Icons.refresh, onPressed: onRetry, expand: false),
            ],
          ],
        ),
      ),
    );
  }
}

/// Skeleton block (§5.19): `surfaceMuted`, shimmer 1.2s, static when reduce-motion is on.
class Skeleton extends StatefulWidget {
  const Skeleton({super.key, this.width, this.height = 16, this.radius = JkRadii.sm});

  final double? width;
  final double height;
  final double radius;

  @override
  State<Skeleton> createState() => _SkeletonState();
}

class _SkeletonState extends State<Skeleton> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (context.reduceMotion) {
      _controller.stop();
    } else if (!_controller.isAnimating) {
      _controller.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    return ExcludeSemantics(
      child: FadeTransition(
        opacity: Tween<double>(begin: 1, end: 0.55).animate(_controller),
        child: Container(
          width: widget.width,
          height: widget.height,
          decoration: BoxDecoration(color: jk.surfaceMuted, borderRadius: BorderRadius.circular(widget.radius), border: Border.all(color: jk.border)),
        ),
      ),
    );
  }
}

/// A list of skeleton cards used while a screen loads.
class SkeletonList extends StatelessWidget {
  const SkeletonList({super.key, this.count = 4, this.itemHeight = 96});

  final int count;
  final double itemHeight;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: context.l10n.loading,
      child: ListView.separated(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(JkSpacing.s5),
        itemCount: count,
        separatorBuilder: (BuildContext context, int index) => const SizedBox(height: JkSpacing.s3),
        itemBuilder: (BuildContext context, int index) => Skeleton(height: itemHeight, radius: JkRadii.lg),
      ),
    );
  }
}

/// Renders an [AsyncValue] with the standard loading / error / data states.
class AsyncValueView<T> extends StatelessWidget {
  const AsyncValueView({
    super.key,
    required this.value,
    required this.data,
    this.onRetry,
    this.loading,
  });

  final AsyncValue<T> value;
  final Widget Function(T data) data;
  final VoidCallback? onRetry;
  final Widget? loading;

  @override
  Widget build(BuildContext context) {
    return value.when(
      data: data,
      loading: () => loading ?? const SkeletonList(),
      error: (Object error, StackTrace stackTrace) => ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: <Widget>[ErrorView(error: error, onRetry: onRetry)],
      ),
    );
  }
}

/// Pull-to-refresh wrapper that awaits [onRefresh].
class JkRefresh extends StatelessWidget {
  const JkRefresh({super.key, required this.onRefresh, required this.child});

  final Future<void> Function() onRefresh;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      color: context.jk.cta,
      backgroundColor: context.jk.surface,
      onRefresh: onRefresh,
      child: child,
    );
  }
}

/// Pull-to-refresh helper: runs [reload] (typically `invalidate` + `read(provider.future)`) and
/// swallows its error — the screen renders the error state from its AsyncValue instead.
Future<void> refreshSafely(Future<Object?> Function() reload) async {
  try {
    await reload();
  } on Object {
    // Rendered by the screen's error state.
  }
}

/// Polls [action] every [interval] until [stop] returns true or the widget is disposed.
class Poller {
  Poller({required this.interval, required this.action});

  final Duration interval;
  final Future<bool> Function() action;
  Timer? _timer;
  bool _busy = false;

  void start() {
    _timer?.cancel();
    _timer = Timer.periodic(interval, (Timer timer) async {
      if (_busy) return;
      _busy = true;
      try {
        final done = await action();
        if (done) stop();
      } on Object {
        // Keep polling on transient failures.
      } finally {
        _busy = false;
      }
    });
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }
}
