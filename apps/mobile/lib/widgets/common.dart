import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../core/design/theme.dart';
import '../core/design/tokens.g.dart';
import '../core/l10n/l10n.dart';
import '../core/models/account.dart';

/// Opaque card (`surface`, radius lg, 1px border). Transactional content always sits on this,
/// never on glass.
class JkCard extends StatelessWidget {
  const JkCard({super.key, required this.child, this.padding = const EdgeInsets.all(JkSpacing.s4), this.onTap, this.color});

  final Widget child;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final content = Padding(padding: padding, child: child);
    return Material(
      color: color ?? jk.surface,
      shape: RoundedRectangleBorder(borderRadius: JkRadii.lgAll, side: BorderSide(color: jk.border)),
      clipBehavior: Clip.antiAlias,
      child: onTap == null ? content : InkWell(onTap: onTap, child: content),
    );
  }
}

/// Section title with an optional trailing text action ("Lihat semua").
class SectionHeader extends StatelessWidget {
  const SectionHeader({super.key, required this.title, this.actionLabel, this.onAction});

  final String title;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final label = actionLabel;
    return Padding(
      padding: const EdgeInsets.only(top: JkSpacing.s5, bottom: JkSpacing.s2),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Semantics(
              header: true,
              child: Text(title, style: JkTypeScale.titleM.copyWith(color: context.jk.onBackground)),
            ),
          ),
          if (label != null && onAction != null) TextButton(onPressed: onAction, child: Text(label)),
        ],
      ),
    );
  }
}

/// Tonal status pill: dot + label (status is never colour-only).
class StatusChip extends StatelessWidget {
  const StatusChip({super.key, required this.label, required this.tone, this.icon});

  final String label;
  final JkTone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final glyph = icon;
    return DecoratedBox(
      decoration: BoxDecoration(color: tone.bg, borderRadius: JkRadii.pillAll),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (glyph != null)
              Icon(glyph, size: 14, color: tone.fg)
            else
              DecoratedBox(
                decoration: BoxDecoration(color: tone.dot, shape: BoxShape.circle),
                child: const SizedBox.square(dimension: 8),
              ),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                label,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: JkTypeScale.labelM.copyWith(color: tone.fg, fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Circle avatar with initials (no photo needed).
class InitialsAvatar extends StatelessWidget {
  const InitialsAvatar({super.key, required this.name, this.size = 44, this.verified = false});

  final String name;
  final double size;
  final bool verified;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final avatar = Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: jk.primary, shape: BoxShape.circle),
      child: Text(
        initialsOf(name),
        style: JkTypeScale.titleS.copyWith(color: jk.onPrimary, fontSize: size * 0.36),
        textScaler: TextScaler.noScaling,
      ),
    );
    if (!verified) return ExcludeSemantics(child: avatar);
    return ExcludeSemantics(
      child: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          avatar,
          Positioned(
            right: -2,
            bottom: -2,
            child: DecoratedBox(
              decoration: BoxDecoration(color: jk.surface, shape: BoxShape.circle),
              child: Icon(Icons.verified, size: size * 0.38, color: jk.secondary),
            ),
          ),
        ],
      ),
    );
  }
}

/// Product image (radius md) with a category-icon placeholder.
class ProductThumb extends StatelessWidget {
  const ProductThumb({super.key, this.imageUrl, this.size = 56, this.icon = Icons.shopping_bag_outlined});

  final String? imageUrl;
  final double size;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final placeholder = Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: jk.secondaryContainer, borderRadius: JkRadii.mdAll),
      child: Icon(icon, color: jk.secondary, size: size * 0.45),
    );
    final url = imageUrl;
    if (url == null || url.isEmpty) return ExcludeSemantics(child: placeholder);
    return ExcludeSemantics(
      child: ClipRRect(
        borderRadius: JkRadii.mdAll,
        child: CachedNetworkImage(
          imageUrl: url,
          width: size,
          height: size,
          fit: BoxFit.cover,
          placeholder: (context, url) => placeholder,
          errorWidget: (context, url, error) => placeholder,
        ),
      ),
    );
  }
}

/// Label / value pair used in detail cards ("Harga maks. disetujui  ¥88.000").
class KeyValue extends StatelessWidget {
  const KeyValue({super.key, required this.label, required this.value});

  final String label;
  final Widget value;

  @override
  Widget build(BuildContext context) {
    return MergeSemantics(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(label, style: JkTypeScale.bodyS.copyWith(color: context.jk.onSurfaceMuted)),
          const SizedBox(height: 2),
          value,
        ],
      ),
    );
  }
}

/// Inline notice box (info / warning / success / error container).
enum NoticeTone { info, warning, success, error }

class NoticeBox extends StatelessWidget {
  const NoticeBox({super.key, required this.message, this.tone = NoticeTone.info, this.icon, this.title});

  final String message;
  final NoticeTone tone;
  final IconData? icon;
  final String? title;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final (Color bg, Color fg, IconData defaultIcon) = switch (tone) {
      NoticeTone.info => (jk.infoContainer, jk.onInfoContainer, Icons.info_outline),
      NoticeTone.warning => (jk.warningContainer, jk.onWarningContainer, Icons.warning_amber_rounded),
      NoticeTone.success => (jk.successContainer, jk.onSuccessContainer, Icons.verified_user_outlined),
      NoticeTone.error => (jk.errorContainer, jk.onErrorContainer, Icons.error_outline),
    };
    final heading = title;
    return Semantics(
      container: true,
      liveRegion: tone == NoticeTone.error,
      child: DecoratedBox(
        decoration: BoxDecoration(color: bg, borderRadius: JkRadii.mdAll),
        child: Padding(
          padding: const EdgeInsets.all(JkSpacing.s3),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Icon(icon ?? defaultIcon, color: fg, size: 20),
              const SizedBox(width: JkSpacing.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    if (heading != null)
                      Text(heading, style: JkTypeScale.labelL.copyWith(color: fg, fontWeight: FontWeight.w600)),
                    Text(message, style: JkTypeScale.bodyS.copyWith(color: fg)),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Snackbar helper (§5.20) — never for critical financial information.
void showJkSnack(BuildContext context, String message, {bool error = false, SnackBarAction? action}) {
  final messenger = ScaffoldMessenger.maybeOf(context);
  if (messenger == null) return;
  final jk = context.jk;
  messenger
    ..hideCurrentSnackBar()
    ..showSnackBar(
      SnackBar(
        content: Row(
          children: <Widget>[
            if (error) Icon(Icons.error_outline, color: jk.onSurfaceInverse, size: 20),
            if (error) const SizedBox(width: JkSpacing.s2),
            Expanded(child: Text(message, maxLines: 3, overflow: TextOverflow.ellipsis)),
          ],
        ),
        duration: Duration(seconds: action == null ? 4 : 8),
        action: action,
      ),
    );
}

/// Confirmation dialog (§5.22) with a specific verb for the destructive action.
Future<bool> showJkConfirm(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  String? cancelLabel,
  bool destructive = false,
  Widget? extra,
}) async {
  final l10n = context.l10n;
  final result = await showDialog<bool>(
    context: context,
    builder: (BuildContext dialogContext) {
      final jk = dialogContext.jk;
      final more = extra;
      return AlertDialog(
        title: Text(title),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(message),
              if (more != null) const SizedBox(height: JkSpacing.s3),
              if (more != null) more,
            ],
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(cancelLabel ?? l10n.actionCancel),
          ),
          TextButton(
            style: destructive ? TextButton.styleFrom(foregroundColor: jk.errorText) : null,
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(confirmLabel),
          ),
        ],
      );
    },
  );
  return result ?? false;
}
