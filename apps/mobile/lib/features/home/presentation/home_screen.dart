import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/marketplace.dart';
import '../../../core/models/transaction.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/cards.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/money_text.dart';
import '../../../widgets/states.dart';
import '../../auth/application/session_controller.dart';
import '../../catalog/data/catalog_repository.dart';
import '../../engagement/data/engagement_repository.dart';
import '../../requests/data/request_repository.dart';
import '../../shell/presentation/main_shell.dart';
import '../../transactions/data/transaction_repository.dart';
import '../../trips/data/trip_repository.dart';

/// Trips from public discovery shown as "Traveler untuk kamu".
final discoveryTripsProvider = FutureProvider.autoDispose<List<Trip>>((ref) async {
  final page = await ref.watch(tripRepositoryProvider).discover(limit: 10);
  return page.items;
});

final travelerEarningsProvider = FutureProvider.autoDispose<PayoutSummary>((ref) async {
  final page = await ref.watch(transactionRepositoryProvider).payouts();
  return page.summary;
});

final matchingRequestsProvider = FutureProvider.autoDispose<List<RequestItem>>((ref) async {
  final page = await ref.watch(requestRepositoryProvider).open();
  return page.items.take(5).toList();
});

/// Home tab: buyer (Penitip) or traveler home depending on `activeMode`.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final traveler = ref.watch(currentProfileProvider)?.isTraveler ?? false;
    return traveler ? const _TravelerHome() : const _BuyerHome();
  }
}

class _HomeHeader extends ConsumerWidget {
  const _HomeHeader();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final jk = context.jk;
    final l10n = context.l10n;
    final profile = ref.watch(currentProfileProvider);
    final name = profile?.displayName ?? profile?.nameOrContact ?? '';
    return Row(
      children: <Widget>[
        InitialsAvatar(name: name.isEmpty ? '?' : name, size: 52),
        const SizedBox(width: JkSpacing.s3),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(l10n.homeGreeting, style: JkTypeScale.bodyM.copyWith(color: jk.onBackgroundMuted)),
              Text(
                name.isEmpty ? l10n.appName : name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: JkTypeScale.headlineS.copyWith(color: jk.onBackground, fontWeight: FontWeight.w700),
              ),
            ],
          ),
        ),
        const NotificationBell(),
      ],
    );
  }
}

EdgeInsets _pagePadding(BuildContext context) =>
    EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s3, JkSpacing.s5, JkSpacing.s12 + MediaQuery.paddingOf(context).bottom);

class _BuyerHome extends ConsumerWidget {
  const _BuyerHome();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final jk = context.jk;
    final l10n = context.l10n;
    final active = ref.watch(activeTransactionsProvider('buyer'));
    final trips = ref.watch(discoveryTripsProvider);
    final catalog = ref.watch(catalogProvider).valueOrNull;
    final locale = context.localeCode;

    Future<void> reload() => refreshSafely(() async {
          ref.invalidate(activeTransactionsProvider('buyer'));
          ref.invalidate(discoveryTripsProvider);
          ref.invalidate(unreadCountProvider);
          await ref.read(activeTransactionsProvider('buyer').future);
          return null;
        });

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: JkRefresh(
          onRefresh: reload,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: _pagePadding(context),
            children: <Widget>[
              const _HomeHeader(),
              const SizedBox(height: JkSpacing.s4),
              const ModeSwitch(),
              const SizedBox(height: JkSpacing.s4),
              const _SearchBox(),
              const SizedBox(height: JkSpacing.s4),
              const _QuickActions(),
              const SizedBox(height: JkSpacing.s4),
              NoticeBox(tone: NoticeTone.success, icon: Icons.shield_outlined, message: l10n.homeSafepayStrip),
              SectionHeader(title: l10n.homeTitipFrom),
              SizedBox(
                height: 48,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: PopularOrigins.codes.length,
                  separatorBuilder: (BuildContext context, int index) => const SizedBox(width: JkSpacing.s2),
                  itemBuilder: (BuildContext context, int index) {
                    final code = PopularOrigins.codes[index];
                    final name = catalog?.countryName(code, locale) ?? code;
                    return ActionChip(
                      avatar: Text(PopularOrigins.flag(code)),
                      label: Text(name),
                      onPressed: () => context.push('${Routes.newRequest}?tab=url&country=$code'),
                    );
                  },
                ),
              ),
              SectionHeader(
                title: l10n.homeActiveTitipan,
                actionLabel: l10n.actionSeeAll,
                onAction: () => context.go(Routes.titipan),
              ),
              active.when(
                data: (List<TransactionSummary> list) => list.isEmpty
                    ? JkCard(
                        child: EmptyState(
                          icon: Icons.inventory_2_outlined,
                          title: l10n.homeNoActiveTitle,
                          message: l10n.homeNoActiveBody,
                          actionLabel: l10n.homeCreateRequest,
                          onAction: () => context.push(Routes.newRequest),
                        ),
                      )
                    : Column(
                        children: <Widget>[
                          for (final tx in list.take(3))
                            Padding(
                              padding: const EdgeInsets.only(bottom: JkSpacing.s3),
                              child: TransactionCard(transaction: tx, onTap: () => context.push(Routes.transaction(tx.id))),
                            ),
                        ],
                      ),
                loading: () => const Skeleton(height: 160, radius: JkRadii.lg),
                error: (Object e, StackTrace s) => ErrorView(error: e, compact: true, onRetry: reload),
              ),
              SectionHeader(
                title: l10n.homeTravelersForYou,
                actionLabel: l10n.homeAllRoutes,
                onAction: () => context.push(Routes.travelers),
              ),
              trips.when(
                data: (List<Trip> list) => list.isEmpty
                    ? Text(l10n.homeNoTravelers, style: JkTypeScale.bodyM.copyWith(color: jk.onBackgroundMuted))
                    : SizedBox(
                        height: 330,
                        child: ListView.separated(
                          scrollDirection: Axis.horizontal,
                          itemCount: list.length,
                          separatorBuilder: (BuildContext context, int index) => const SizedBox(width: JkSpacing.s3),
                          itemBuilder: (BuildContext context, int index) {
                            final trip = list[index];
                            return SingleChildScrollView(
                              child: TravelerCard(
                                width: 268,
                                recommendation: RecommendedTrip(trip: trip, score: 0, reasons: const <String>[], estimatedTravelerFeeIdr: 0),
                                onTap: () => context.push(Routes.trip(trip.id)),
                              ),
                            );
                          },
                        ),
                      ),
                loading: () => const Skeleton(height: 200, radius: JkRadii.lg),
                error: (Object e, StackTrace s) => ErrorView(error: e, compact: true, onRetry: reload),
              ),
              const SizedBox(height: JkSpacing.s5),
              const _TrustCard(),
            ],
          ),
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'buyer-fab',
        onPressed: () => context.push(Routes.newRequest),
        icon: const Icon(Icons.add),
        label: Text(l10n.homeCreateRequest),
      ),
    );
  }
}

class _TrustCard extends StatelessWidget {
  const _TrustCard();

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final points = <(IconData, String)>[
      (Icons.verified_user_outlined, l10n.trustPointSafepay),
      (Icons.badge_outlined, l10n.trustPointVerified),
      (Icons.receipt_long_outlined, l10n.trustPointTransparent),
    ];
    return JkCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(l10n.tagline, style: JkTypeScale.titleS.copyWith(color: jk.onSurface)),
          const SizedBox(height: JkSpacing.s2),
          for (final (icon, text) in points)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Icon(icon, size: 20, color: jk.secondary),
                  const SizedBox(width: JkSpacing.s2),
                  Expanded(child: Text(text, style: JkTypeScale.bodyM.copyWith(color: jk.onSurface))),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _SearchBox extends StatefulWidget {
  const _SearchBox();

  @override
  State<_SearchBox> createState() => _SearchBoxState();
}

class _SearchBoxState extends State<_SearchBox> {
  final TextEditingController _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit(String value) {
    final text = value.trim();
    if (text.isEmpty) return;
    final uri = Uri.tryParse(text);
    final isUrl = uri != null && (uri.scheme == 'http' || uri.scheme == 'https') && uri.host.isNotEmpty;
    final query = Uri.encodeQueryComponent(text);
    context.push(isUrl ? '${Routes.newRequest}?tab=url&url=$query' : '${Routes.newRequest}?tab=search&q=$query');
  }

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    return Semantics(
      textField: true,
      label: l10n.homeSearchHint,
      child: TextField(
        controller: _controller,
        textInputAction: TextInputAction.go,
        keyboardType: TextInputType.url,
        onSubmitted: _submit,
        style: JkTypeScale.bodyL.copyWith(color: jk.onSurface),
        decoration: InputDecoration(
          hintText: l10n.homeSearchHint,
          hintStyle: JkTypeScale.bodyL.copyWith(color: jk.onSurfaceMuted),
          filled: true,
          fillColor: jk.surface,
          prefixIcon: Icon(Icons.link, color: jk.onSurfaceMuted),
          suffixIcon: IconButton(
            tooltip: l10n.homeActionPhoto,
            icon: Icon(Icons.photo_camera_outlined, color: jk.secondary),
            onPressed: () => context.push('${Routes.newRequest}?tab=photo'),
          ),
          contentPadding: const EdgeInsets.symmetric(vertical: JkSpacing.s4),
          border: OutlineInputBorder(borderRadius: JkRadii.lgAll, borderSide: BorderSide(color: jk.outline)),
          enabledBorder: OutlineInputBorder(borderRadius: JkRadii.lgAll, borderSide: BorderSide(color: jk.outline)),
          focusedBorder: OutlineInputBorder(borderRadius: JkRadii.lgAll, borderSide: BorderSide(color: jk.focusRing, width: 2)),
        ),
      ),
    );
  }
}

class _QuickActions extends StatelessWidget {
  const _QuickActions();

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final actions = <(IconData, String, String)>[
      (Icons.link, l10n.homeActionUrl, '${Routes.newRequest}?tab=url'),
      (Icons.document_scanner_outlined, l10n.homeActionPhoto, '${Routes.newRequest}?tab=photo'),
      (Icons.search, l10n.homeActionTraveler, Routes.travelers),
      (Icons.edit_note, l10n.homeActionManual, '${Routes.newRequest}?tab=manual'),
    ];
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        for (final (icon, label, path) in actions)
          Expanded(child: _QuickAction(icon: icon, label: label, onTap: () => context.push(path))),
      ],
    );
  }
}

class _QuickAction extends StatelessWidget {
  const _QuickAction({required this.icon, required this.label, required this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: InkWell(
        borderRadius: JkRadii.lgAll,
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: JkSpacing.s1, horizontal: 2),
          child: Column(
            children: <Widget>[
              Container(
                width: 56,
                height: 56,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: jk.surface,
                  borderRadius: JkRadii.lgAll,
                  border: Border.all(color: jk.border),
                  boxShadow: context.elevation(1),
                ),
                child: Icon(icon, color: jk.secondary, size: 26),
              ),
              const SizedBox(height: 6),
              Text(
                label,
                textAlign: TextAlign.center,
                maxLines: 2,
                style: JkTypeScale.labelM.copyWith(color: jk.onBackground),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TravelerHome extends ConsumerWidget {
  const _TravelerHome();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final jk = context.jk;
    final l10n = context.l10n;
    final profile = ref.watch(currentProfileProvider);
    final trips = ref.watch(myActiveTripsProvider);
    final orders = ref.watch(activeTransactionsProvider('traveler'));
    final requests = ref.watch(matchingRequestsProvider);
    final earnings = ref.watch(travelerEarningsProvider);
    final level = profile?.kycLevel ?? 1;

    Future<void> reload() => refreshSafely(() async {
          ref.invalidate(myActiveTripsProvider);
          ref.invalidate(activeTransactionsProvider('traveler'));
          ref.invalidate(matchingRequestsProvider);
          ref.invalidate(travelerEarningsProvider);
          ref.invalidate(unreadCountProvider);
          await ref.read(activeTransactionsProvider('traveler').future);
          return null;
        });

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: JkRefresh(
          onRefresh: reload,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: _pagePadding(context),
            children: <Widget>[
              const _HomeHeader(),
              const SizedBox(height: JkSpacing.s4),
              const ModeSwitch(),
              if (level < KycLevel.identityVerified) ...<Widget>[
                const SizedBox(height: JkSpacing.s4),
                JkCard(
                  color: jk.warningContainer,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(l10n.travelerKycCardTitle, style: JkTypeScale.titleS.copyWith(color: jk.onWarningContainer)),
                      const SizedBox(height: 4),
                      Text(l10n.travelerKycCardBody, style: JkTypeScale.bodyM.copyWith(color: jk.onWarningContainer)),
                      const SizedBox(height: JkSpacing.s3),
                      JkButton(label: l10n.travelerKycCardCta, onPressed: () => context.push(Routes.kyc), expand: false),
                    ],
                  ),
                ),
              ],
              SectionHeader(title: l10n.travelerEarnings, actionLabel: l10n.actionSeeAll, onAction: () => context.push(Routes.payouts)),
              earnings.when(
                data: (PayoutSummary s) => JkCard(
                  child: Row(
                    children: <Widget>[
                      Expanded(child: KeyValue(label: l10n.payoutScheduled, value: MoneyText(s.scheduledIdr + s.processingIdr, size: MoneySize.m))),
                      Expanded(child: KeyValue(label: l10n.payoutHeld, value: MoneyText(s.heldIdr, size: MoneySize.m))),
                      Expanded(child: KeyValue(label: l10n.payoutPaid, value: MoneyText(s.paidIdr, size: MoneySize.m))),
                    ],
                  ),
                ),
                loading: () => const Skeleton(height: 72, radius: JkRadii.lg),
                error: (Object e, StackTrace s) => ErrorView(error: e, compact: true, onRetry: reload),
              ),
              SectionHeader(title: l10n.travelerActiveTrips, actionLabel: l10n.actionSeeAll, onAction: () => context.go(Routes.trips)),
              trips.when(
                data: (List<Trip> list) => list.isEmpty
                    ? JkCard(
                        child: EmptyState(
                          icon: Icons.flight_takeoff,
                          title: l10n.travelerNoTripsTitle,
                          message: l10n.travelerNoTripsBody,
                          actionLabel: l10n.tripCreate,
                          onAction: () => context.push(Routes.newTrip),
                        ),
                      )
                    : Column(
                        children: <Widget>[
                          for (final trip in list)
                            Padding(
                              padding: const EdgeInsets.only(bottom: JkSpacing.s3),
                              child: TripCard(trip: trip, onTap: () => context.push(Routes.trip(trip.id))),
                            ),
                        ],
                      ),
                loading: () => const Skeleton(height: 140, radius: JkRadii.lg),
                error: (Object e, StackTrace s) => ErrorView(error: e, compact: true, onRetry: reload),
              ),
              SectionHeader(title: l10n.travelerOrdersToAct, actionLabel: l10n.actionSeeAll, onAction: () => context.go(Routes.orders)),
              orders.when(
                data: (List<TransactionSummary> list) {
                  if (list.isEmpty) {
                    return Text(l10n.travelerNoOrders, style: JkTypeScale.bodyM.copyWith(color: jk.onBackgroundMuted));
                  }
                  final sorted = List<TransactionSummary>.of(list)
                    ..sort((TransactionSummary a, TransactionSummary b) =>
                        TxStatus.all.indexOf(a.status).compareTo(TxStatus.all.indexOf(b.status)));
                  return Column(
                    children: <Widget>[
                      for (final tx in sorted.take(5))
                        Padding(
                          padding: const EdgeInsets.only(bottom: JkSpacing.s3),
                          child: TransactionCard(transaction: tx, onTap: () => context.push(Routes.transaction(tx.id))),
                        ),
                    ],
                  );
                },
                loading: () => const Skeleton(height: 160, radius: JkRadii.lg),
                error: (Object e, StackTrace s) => ErrorView(error: e, compact: true, onRetry: reload),
              ),
              SectionHeader(
                title: l10n.travelerMatchingRequests,
                actionLabel: l10n.actionSeeAll,
                onAction: () => context.push(Routes.openRequests),
              ),
              requests.when(
                data: (List<RequestItem> list) => list.isEmpty
                    ? Text(l10n.travelerNoMatchingRequests, style: JkTypeScale.bodyM.copyWith(color: jk.onBackgroundMuted))
                    : Column(
                        children: <Widget>[
                          for (final r in list)
                            Padding(
                              padding: const EdgeInsets.only(bottom: JkSpacing.s3),
                              child: RequestCard(request: r, onTap: () => context.push(Routes.openRequest(r.id))),
                            ),
                        ],
                      ),
                loading: () => const Skeleton(height: 120, radius: JkRadii.lg),
                error: (Object e, StackTrace s) => ErrorView(error: e, compact: true, onRetry: reload),
              ),
            ],
          ),
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'traveler-fab',
        onPressed: () => context.push(Routes.newTrip),
        icon: const Icon(Icons.add),
        label: Text(l10n.tripCreate),
      ),
    );
  }
}
