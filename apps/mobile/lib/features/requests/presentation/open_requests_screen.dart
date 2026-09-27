import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens.g.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/marketplace.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/cards.dart';
import '../../../widgets/paged_list.dart';
import '../../../widgets/states.dart';
import '../../trips/data/trip_repository.dart';
import '../data/request_repository.dart';

/// Traveler: OPEN requests matching my ACTIVE trips (no buyer PII), filterable by trip.
class OpenRequestsScreen extends ConsumerStatefulWidget {
  const OpenRequestsScreen({super.key, this.tripId});

  final String? tripId;

  @override
  ConsumerState<OpenRequestsScreen> createState() => _OpenRequestsScreenState();
}

class _OpenRequestsScreenState extends ConsumerState<OpenRequestsScreen> {
  late String? _tripId = widget.tripId;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final trips = ref.watch(myActiveTripsProvider).valueOrNull ?? const <Trip>[];
    return Scaffold(
      appBar: AppBar(title: Text(l10n.openRequestsTitle)),
      body: PagedListView<RequestItem>(
        reloadToken: _tripId,
        fetch: (String? cursor) => ref.read(requestRepositoryProvider).open(cursor: cursor, tripId: _tripId),
        header: trips.isEmpty
            ? null
            : Wrap(
                spacing: JkSpacing.s2,
                runSpacing: JkSpacing.s2,
                children: <Widget>[
                  ChoiceChip(
                    label: Text(l10n.openRequestsAllTrips),
                    selected: _tripId == null,
                    onSelected: (bool v) => setState(() => _tripId = null),
                  ),
                  for (final t in trips)
                    ChoiceChip(
                      label: Text(routeLabel(t.originCity, t.destinationCity)),
                      selected: _tripId == t.id,
                      onSelected: (bool v) => setState(() => _tripId = v ? t.id : null),
                    ),
                ],
              ),
        empty: EmptyState(
          icon: Icons.travel_explore_outlined,
          title: l10n.openRequestsEmptyTitle,
          message: l10n.openRequestsEmptyBody,
          actionLabel: trips.isEmpty ? l10n.tripCreate : null,
          onAction: trips.isEmpty ? () => context.push(Routes.newTrip) : null,
        ),
        itemBuilder: (BuildContext context, RequestItem r) =>
            RequestCard(request: r, onTap: () => context.push(Routes.openRequest(r.id, tripId: _tripId))),
      ),
    );
  }
}
