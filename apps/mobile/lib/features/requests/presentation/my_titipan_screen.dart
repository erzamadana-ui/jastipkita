import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n.dart';
import '../../../core/models/marketplace.dart';
import '../../../core/models/transaction.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/cards.dart';
import '../../../widgets/paged_list.dart';
import '../../../widgets/states.dart';
import '../../shell/presentation/main_shell.dart';
import '../../transactions/data/transaction_repository.dart';
import '../data/request_repository.dart';

/// Buyer "Titipan" tab: transactions (with SafePay progress) and requests (drafts / open).
class MyTitipanScreen extends ConsumerWidget {
  const MyTitipanScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: Text(l10n.titipanTitle),
          actions: const <Widget>[NotificationBell()],
          bottom: TabBar(tabs: <Widget>[Tab(text: l10n.titipanTabTransactions), Tab(text: l10n.titipanTabRequests)]),
        ),
        body: TabBarView(
          children: <Widget>[
            PagedListView<TransactionSummary>(
              fetch: (String? cursor) => ref.read(transactionRepositoryProvider).list(role: 'buyer', cursor: cursor),
              itemBuilder: (BuildContext context, TransactionSummary tx) =>
                  TransactionCard(transaction: tx, onTap: () => context.push(Routes.transaction(tx.id))),
              empty: EmptyState(
                icon: Icons.inventory_2_outlined,
                title: l10n.titipanEmptyTitle,
                message: l10n.titipanEmptyBody,
                actionLabel: l10n.homeCreateRequest,
                onAction: () => context.push(Routes.newRequest),
              ),
            ),
            PagedListView<RequestItem>(
              fetch: (String? cursor) => ref.read(requestRepositoryProvider).mine(cursor: cursor),
              itemBuilder: (BuildContext context, RequestItem r) =>
                  RequestCard(request: r, onTap: () => context.push(Routes.request(r.id))),
              empty: EmptyState(
                icon: Icons.link,
                title: l10n.requestsEmptyTitle,
                message: l10n.requestsEmptyBody,
                actionLabel: l10n.homeCreateRequest,
                onAction: () => context.push(Routes.newRequest),
              ),
            ),
          ],
        ),
        floatingActionButton: FloatingActionButton.extended(
          heroTag: 'titipan-fab',
          onPressed: () => context.push(Routes.newRequest),
          icon: const Icon(Icons.add),
          label: Text(l10n.homeCreateRequest),
        ),
      ),
    );
  }
}
