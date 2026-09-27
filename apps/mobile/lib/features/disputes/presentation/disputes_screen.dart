import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/engagement.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/common.dart';
import '../../../widgets/countdown_chip.dart';
import '../../../widgets/paged_list.dart';
import '../../../widgets/states.dart';
import '../../engagement/data/engagement_repository.dart';

JkTone disputeTone(BuildContext context, String status) {
  final jk = context.jk;
  switch (status) {
    case 'RESOLVED':
    case 'CLOSED':
      return jk.status['closed']!;
    case 'UNDER_REVIEW':
    case 'APPEALED':
      return jk.status['inTransit']!;
    default:
      return jk.status['disputed']!;
  }
}

/// Dispute center list (DSP-…), with status and SLA countdown.
class DisputesScreen extends ConsumerWidget {
  const DisputesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.disputesTitle)),
      body: PagedListView<Dispute>(
        fetch: (String? cursor) => ref.read(engagementRepositoryProvider).disputes(cursor: cursor),
        empty: EmptyState(icon: Icons.gavel_outlined, title: l10n.disputesEmptyTitle, message: l10n.disputesEmptyBody),
        itemBuilder: (BuildContext context, Dispute d) {
          final jk = context.jk;
          final sla = d.slaDueAt;
          return JkCard(
            onTap: () => context.push(Routes.dispute(d.id)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Expanded(child: Text(d.number, style: JkTypeScale.titleS.copyWith(color: jk.onSurface))),
                    StatusChip(label: Labels.disputeStatus(l10n, d.status), tone: disputeTone(context, d.status)),
                  ],
                ),
                const SizedBox(height: 4),
                Text('${Labels.disputeType(l10n, d.type)} · ${d.transactionNumber}', style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                if (sla != null && d.status != 'RESOLVED' && d.status != 'CLOSED') ...<Widget>[
                  const SizedBox(height: JkSpacing.s2),
                  CountdownChip(expiresAt: sla, label: l10n.disputeSla, icon: Icons.schedule),
                ],
              ],
            ),
          );
        },
      ),
    );
  }
}
