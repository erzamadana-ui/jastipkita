import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/marketplace.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/cards.dart';
import '../../../widgets/paged_list.dart';
import '../../../widgets/states.dart';
import '../../catalog/data/catalog_repository.dart';
import '../../trips/data/trip_repository.dart';

/// "Cari traveler" — public trip discovery (ACTIVE trips, no PII), filterable by origin.
class TravelerDiscoveryScreen extends ConsumerStatefulWidget {
  const TravelerDiscoveryScreen({super.key, this.originCountry});

  final String? originCountry;

  @override
  ConsumerState<TravelerDiscoveryScreen> createState() => _TravelerDiscoveryScreenState();
}

class _TravelerDiscoveryScreenState extends ConsumerState<TravelerDiscoveryScreen> {
  late String? _origin = widget.originCountry;
  bool _verifiedOnly = false;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final locale = context.localeCode;
    final catalog = ref.watch(catalogProvider).valueOrNull;
    final origins = catalog?.origins.map((c) => c.code).toList() ?? PopularOrigins.codes;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.discoveryTitle)),
      body: PagedListView<Trip>(
        reloadToken: '$_origin|$_verifiedOnly',
        fetch: (String? cursor) => ref
            .read(tripRepositoryProvider)
            .discover(cursor: cursor, originCountry: _origin, verifiedOnly: _verifiedOnly),
        header: Wrap(
          spacing: JkSpacing.s2,
          runSpacing: JkSpacing.s2,
          children: <Widget>[
            FilterChip(
              label: Text(l10n.discoveryVerifiedOnly),
              selected: _verifiedOnly,
              onSelected: (bool v) => setState(() => _verifiedOnly = v),
            ),
            ChoiceChip(
              label: Text(l10n.discoveryAllOrigins),
              selected: _origin == null,
              onSelected: (bool v) => setState(() => _origin = null),
            ),
            for (final code in origins)
              ChoiceChip(
                label: Text('${PopularOrigins.flag(code)} ${catalog?.countryName(code, locale) ?? code}'),
                selected: _origin == code,
                onSelected: (bool v) => setState(() => _origin = v ? code : null),
              ),
          ],
        ),
        empty: EmptyState(title: l10n.discoveryEmptyTitle, message: l10n.discoveryEmptyBody),
        itemBuilder: (BuildContext context, Trip trip) => TravelerCard(
          recommendation: RecommendedTrip(trip: trip, score: 0, reasons: const <String>[], estimatedTravelerFeeIdr: 0),
          onTap: () => context.push(Routes.trip(trip.id)),
        ),
      ),
    );
  }
}
