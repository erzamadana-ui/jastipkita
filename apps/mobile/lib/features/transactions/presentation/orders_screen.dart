import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens.g.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/marketplace.dart';
import '../../../core/models/transaction.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/cards.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/paged_list.dart';
import '../../../widgets/states.dart';
import '../../requests/data/request_repository.dart';
import '../../shell/presentation/main_shell.dart';
import '../data/transaction_repository.dart';

/// Traveler "Pesanan" tab: my transactions (with the purchase gate on every row) and my offers.
class OrdersScreen extends ConsumerStatefulWidget {
  const OrdersScreen({super.key});

  @override
  ConsumerState<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends ConsumerState<OrdersScreen> {
  int _offersReload = 0;
  String? _withdrawing;

  Future<void> _withdraw(Offer offer) async {
    final l10n = context.l10n;
    final ok = await showJkConfirm(
      context,
      title: l10n.offerWithdrawTitle,
      message: l10n.offerWithdrawBody,
      confirmLabel: l10n.offerWithdraw,
      destructive: true,
    );
    if (!ok) return;
    if (!mounted) return;
    setState(() => _withdrawing = offer.id);
    try {
      await ref.read(requestRepositoryProvider).withdraw(offer.id);
      if (!mounted) return;
      showJkSnack(context, l10n.offerWithdrawn);
      setState(() => _offersReload++);
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _withdrawing = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: Text(l10n.ordersTitle),
          actions: <Widget>[
            IconButton(
              tooltip: l10n.openRequestsTitle,
              onPressed: () => context.push(Routes.openRequests),
              icon: const Icon(Icons.travel_explore_outlined),
            ),
            const NotificationBell(),
          ],
          bottom: TabBar(tabs: <Widget>[Tab(text: l10n.ordersTabOrders), Tab(text: l10n.ordersTabOffers)]),
        ),
        body: TabBarView(
          children: <Widget>[
            PagedListView<TransactionSummary>(
              fetch: (String? cursor) => ref.read(transactionRepositoryProvider).list(role: 'traveler', cursor: cursor),
              itemBuilder: (BuildContext context, TransactionSummary tx) =>
                  TransactionCard(transaction: tx, onTap: () => context.push(Routes.transaction(tx.id))),
              empty: EmptyState(
                icon: Icons.inventory_2_outlined,
                title: l10n.ordersEmptyTitle,
                message: l10n.ordersEmptyBody,
                actionLabel: l10n.openRequestsTitle,
                onAction: () => context.push(Routes.openRequests),
              ),
            ),
            PagedListView<Offer>(
              reloadToken: _offersReload,
              fetch: (String? cursor) => ref.read(requestRepositoryProvider).offersMine(role: 'traveler', cursor: cursor),
              itemBuilder: (BuildContext context, Offer offer) => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  if (offer.request != null)
                    RequestCard(
                      request: offer.request!,
                      onTap: () {
                        final txId = offer.transactionId;
                        context.push(txId != null ? Routes.transaction(txId) : Routes.openRequest(offer.requestId));
                      },
                    ),
                  const SizedBox(height: JkSpacing.s2),
                  OfferCard(offer: offer),
                  if (offer.canWithdraw)
                    JkButton(
                      label: l10n.offerWithdraw,
                      variant: JkButtonVariant.tertiary,
                      loading: _withdrawing == offer.id,
                      onPressed: _withdrawing == null ? () => _withdraw(offer) : null,
                    ),
                ],
              ),
              empty: EmptyState(icon: Icons.local_offer_outlined, title: l10n.offersMineEmpty),
            ),
          ],
        ),
      ),
    );
  }
}
