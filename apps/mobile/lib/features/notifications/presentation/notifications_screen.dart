import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/format/dates.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/engagement.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/common.dart';
import '../../../widgets/paged_list.dart';
import '../../../widgets/states.dart';
import '../../engagement/data/engagement_repository.dart';

/// In-app notification center. Tapping an item marks it read and follows its deep link.
class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key});

  @override
  ConsumerState<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  int _reload = 0;
  final Set<String> _readLocally = <String>{};

  Future<void> _open(AppNotification n) async {
    setState(() => _readLocally.add(n.id));
    final link = n.deepLink;
    if (n.isUnread) {
      try {
        await ref.read(engagementRepositoryProvider).markNotificationRead(n.id);
      } on Object {
        // Optimistic (non-financial): the badge corrects itself on the next refresh.
      }
      ref.invalidate(unreadCountProvider);
    }
    if (link == null) return;
    if (!mounted) return;
    final target = normalizeDeepLink(Uri.parse(link));
    if (target != null) context.push(target);
  }

  Future<void> _markAll() async {
    try {
      await ref.read(engagementRepositoryProvider).markAllNotificationsRead();
      ref.invalidate(unreadCountProvider);
      if (!mounted) return;
      setState(() => _reload++);
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.notificationsTitle),
        actions: <Widget>[
          IconButton(tooltip: l10n.notificationsMarkAll, onPressed: _markAll, icon: const Icon(Icons.done_all)),
          IconButton(
            tooltip: l10n.notificationSettingsTitle,
            onPressed: () => context.push(Routes.notificationSettings),
            icon: const Icon(Icons.tune),
          ),
        ],
      ),
      body: PagedListView<AppNotification>(
        reloadToken: _reload,
        spacing: JkSpacing.s2,
        fetch: (String? cursor) => ref.read(engagementRepositoryProvider).notifications(cursor: cursor),
        empty: EmptyState(icon: Icons.notifications_none, title: l10n.notificationsEmptyTitle, message: l10n.notificationsEmptyBody),
        itemBuilder: (BuildContext context, AppNotification n) {
          final jk = context.jk;
          final unread = n.isUnread && !_readLocally.contains(n.id);
          final at = n.createdAt;
          return Semantics(
            label: unread ? l10n.notificationUnreadSemantics(n.title) : n.title,
            button: true,
            child: JkCard(
              padding: const EdgeInsets.all(JkSpacing.s3),
              color: unread ? jk.secondaryContainer : null,
              onTap: () => _open(n),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Icon(_iconFor(n.category), color: unread ? jk.onSecondaryContainer : jk.onSurfaceMuted),
                  const SizedBox(width: JkSpacing.s3),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          n.title,
                          style: JkTypeScale.titleS.copyWith(
                            color: unread ? jk.onSecondaryContainer : jk.onSurface,
                            fontWeight: unread ? FontWeight.w700 : FontWeight.w600,
                          ),
                        ),
                        Text(n.body, style: JkTypeScale.bodyS.copyWith(color: unread ? jk.onSecondaryContainer : jk.onSurfaceMuted)),
                        if (at != null)
                          Text(JkDates.shortDateTime(at, context.localeCode), style: JkTypeScale.labelS.copyWith(color: jk.onSurfaceMuted)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  static IconData _iconFor(String category) {
    switch (category) {
      case 'PAYMENT':
        return Icons.verified_user_outlined;
      case 'CHAT':
        return Icons.chat_bubble_outline;
      case 'PROMOTION':
        return Icons.local_offer_outlined;
      case 'ACCOUNT':
        return Icons.person_outline;
      default:
        return Icons.inventory_2_outlined;
    }
  }
}
