import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n.dart';
import '../../../core/models/marketplace.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/cards.dart';
import '../../../widgets/paged_list.dart';
import '../../../widgets/states.dart';
import '../../shell/presentation/main_shell.dart';
import '../data/trip_repository.dart';

/// Traveler "Trip" tab: all my trips (DRAFT … COMPLETED).
class MyTripsScreen extends ConsumerWidget {
  const MyTripsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.myTripsTitle),
        actions: <Widget>[
          IconButton(
            tooltip: l10n.openRequestsTitle,
            onPressed: () => context.push(Routes.openRequests),
            icon: const Icon(Icons.travel_explore_outlined),
          ),
          const NotificationBell(),
        ],
      ),
      body: PagedListView<Trip>(
        fetch: (String? cursor) => ref.read(tripRepositoryProvider).mine(cursor: cursor),
        itemBuilder: (BuildContext context, Trip trip) => TripCard(trip: trip, onTap: () => context.push(Routes.trip(trip.id))),
        empty: EmptyState(
          icon: Icons.flight_takeoff,
          title: l10n.travelerNoTripsTitle,
          message: l10n.travelerNoTripsBody,
          actionLabel: l10n.tripCreate,
          onAction: () => context.push(Routes.newTrip),
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'trips-fab',
        onPressed: () => context.push(Routes.newTrip),
        icon: const Icon(Icons.add),
        label: Text(l10n.tripCreate),
      ),
    );
  }
}
