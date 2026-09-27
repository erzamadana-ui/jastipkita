import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/format/dates.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/engagement.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/common.dart';
import '../../../widgets/paged_list.dart';
import '../../../widgets/states.dart';
import '../../engagement/data/engagement_repository.dart';
import '../../shell/presentation/main_shell.dart';

/// Chat tab: one conversation per transaction (created at MATCHED).
class ConversationsScreen extends ConsumerWidget {
  const ConversationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.chatTitle), actions: const <Widget>[NotificationBell()]),
      body: PagedListView<Conversation>(
        fetch: (String? cursor) => ref.read(engagementRepositoryProvider).conversations(cursor: cursor),
        spacing: JkSpacing.s2,
        empty: EmptyState(icon: Icons.chat_bubble_outline, title: l10n.chatEmptyTitle, message: l10n.chatEmptyBody),
        itemBuilder: (BuildContext context, Conversation c) {
          final jk = context.jk;
          final locale = context.localeCode;
          final at = c.lastMessageAt;
          final status = c.transactionStatus;
          return JkCard(
            padding: const EdgeInsets.all(JkSpacing.s3),
            onTap: () => context.push(Routes.conversation(c.id)),
            child: Row(
              children: <Widget>[
                InitialsAvatar(name: c.counterpartName, size: 48),
                const SizedBox(width: JkSpacing.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          Expanded(
                            child: Text(
                              c.counterpartName,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: JkTypeScale.titleS.copyWith(color: jk.onSurface),
                            ),
                          ),
                          if (at != null) Text(JkDates.shortDateTime(at, locale), style: JkTypeScale.labelS.copyWith(color: jk.onSurfaceMuted)),
                        ],
                      ),
                      if (c.productName != null)
                        Text(c.productName!, maxLines: 1, overflow: TextOverflow.ellipsis, style: JkTypeScale.labelM.copyWith(color: jk.onSurfaceMuted)),
                      Row(
                        children: <Widget>[
                          Expanded(
                            child: Text(
                              c.lastMessagePreview ?? '',
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: JkTypeScale.bodyS.copyWith(
                                color: jk.onSurface,
                                fontWeight: c.unreadCount > 0 ? FontWeight.w600 : FontWeight.w400,
                              ),
                            ),
                          ),
                          if (c.unreadCount > 0)
                            Semantics(
                              label: l10n.chatUnread(c.unreadCount),
                              excludeSemantics: true,
                              child: Badge(label: Text('${c.unreadCount}'), backgroundColor: jk.cta, textColor: jk.onCta),
                            ),
                        ],
                      ),
                      if (status != null) ...<Widget>[
                        const SizedBox(height: 4),
                        StatusChip(label: Labels.txStatus(l10n, status), tone: jk.statusTone(status)),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}
