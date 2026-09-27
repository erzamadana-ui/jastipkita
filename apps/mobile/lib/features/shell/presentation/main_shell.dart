import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/haptics.dart';
import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/router/deep_links.dart';
import '../../../core/storage/settings.dart';
import '../../../widgets/common.dart';
import '../../../widgets/sheets_and_glass.dart';
import '../../auth/application/session_controller.dart';
import '../../engagement/data/engagement_repository.dart';

class _NavItem {
  const _NavItem(this.path, this.label, this.icon, this.selectedIcon);

  final String path;
  final String label;
  final IconData icon;
  final IconData selectedIcon;
}

List<_NavItem> _items(AppLocalizations l10n, bool traveler) => traveler
    ? <_NavItem>[
        _NavItem(Routes.home, l10n.navHome, Icons.home_outlined, Icons.home),
        _NavItem(Routes.trips, l10n.navTrips, Icons.flight_outlined, Icons.flight),
        _NavItem(Routes.orders, l10n.navOrders, Icons.inventory_2_outlined, Icons.inventory_2),
        _NavItem(Routes.chat, l10n.navChat, Icons.chat_bubble_outline, Icons.chat_bubble),
        _NavItem(Routes.profile, l10n.navProfile, Icons.person_outline, Icons.person),
      ]
    : <_NavItem>[
        _NavItem(Routes.home, l10n.navHome, Icons.home_outlined, Icons.home),
        _NavItem(Routes.titipan, l10n.navTitipan, Icons.inventory_2_outlined, Icons.inventory_2),
        _NavItem(Routes.chat, l10n.navChat, Icons.chat_bubble_outline, Icons.chat_bubble),
        _NavItem(Routes.wallet, l10n.navWallet, Icons.account_balance_wallet_outlined, Icons.account_balance_wallet),
        _NavItem(Routes.profile, l10n.navProfile, Icons.person_outline, Icons.person),
      ];

/// Tab shell. Buyer: Beranda · Titipan · Chat · Dompet · Profil. Traveler: Beranda · Trip ·
/// Pesanan · Chat · Profil (§5.1). iOS: floating Liquid-Glass capsule over non-transactional
/// content; Android: opaque Material 3 NavigationBar.
class MainShell extends ConsumerWidget {
  const MainShell({super.key, required this.location, required this.child});

  final String location;
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final traveler = ref.watch(currentProfileProvider)?.isTraveler ?? false;
    final items = _items(l10n, traveler);
    var index = items.indexWhere((_NavItem i) => location == i.path || location.startsWith('${i.path}/'));
    if (index < 0) index = 0;
    final haptics = ref.watch(settingsProvider).haptics;
    void onSelect(int i) {
      JkHaptics.selection(haptics);
      context.go(items[i].path);
    }

    if (context.isCupertino) {
      return Scaffold(
        extendBody: true,
        body: child,
        bottomNavigationBar: _GlassTabBar(items: items, selected: index, onSelect: onSelect),
      );
    }
    return Scaffold(
      body: child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: index,
        onDestinationSelected: onSelect,
        destinations: <Widget>[
          for (final item in items)
            NavigationDestination(icon: Icon(item.icon), selectedIcon: Icon(item.selectedIcon), label: item.label),
        ],
      ),
    );
  }
}

class _GlassTabBar extends StatelessWidget {
  const _GlassTabBar({required this.items, required this.selected, required this.onSelect});

  final List<_NavItem> items;
  final int selected;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final iconsOnly = MediaQuery.textScalerOf(context).scale(11) > 16.5;
    return SafeArea(
      minimum: const EdgeInsets.fromLTRB(14, 0, 14, 8),
      child: GlassSurface(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
          child: Row(
            children: <Widget>[
              for (var i = 0; i < items.length; i++)
                Expanded(
                  child: _GlassTabItem(
                    item: items[i],
                    selected: i == selected,
                    iconsOnly: iconsOnly,
                    activeColor: jk.onGlassActive,
                    mutedColor: jk.onGlassMuted,
                    tint: jk.secondary.withValues(alpha: 0.14),
                    onTap: () => onSelect(i),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _GlassTabItem extends StatelessWidget {
  const _GlassTabItem({
    required this.item,
    required this.selected,
    required this.iconsOnly,
    required this.activeColor,
    required this.mutedColor,
    required this.tint,
    required this.onTap,
  });

  final _NavItem item;
  final bool selected;
  final bool iconsOnly;
  final Color activeColor;
  final Color mutedColor;
  final Color tint;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = selected ? activeColor : mutedColor;
    final content = Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Icon(selected ? item.selectedIcon : item.icon, color: color),
        if (!iconsOnly)
          Text(
            item.label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: JkTypeScale.labelS.copyWith(color: color, fontWeight: selected ? FontWeight.w600 : FontWeight.w500),
          ),
      ],
    );
    return Semantics(
      selected: selected,
      button: true,
      label: item.label,
      excludeSemantics: true,
      child: Tooltip(
        message: item.label,
        child: InkWell(
          borderRadius: JkRadii.pillAll,
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 52),
            alignment: Alignment.center,
            decoration: BoxDecoration(color: selected ? tint : null, borderRadius: JkRadii.pillAll),
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: content,
          ),
        ),
      ),
    );
  }
}

/// Penitip ↔ Traveler segmented switch (`POST /me/mode`); switching changes tabs and home.
class ModeSwitch extends ConsumerStatefulWidget {
  const ModeSwitch({super.key});

  @override
  ConsumerState<ModeSwitch> createState() => _ModeSwitchState();
}

class _ModeSwitchState extends ConsumerState<ModeSwitch> {
  bool _busy = false;

  Future<void> _switch(String mode) async {
    final current = ref.read(currentProfileProvider)?.activeMode;
    if (_busy || current == mode) return;
    setState(() => _busy = true);
    JkHaptics.selection(ref.read(settingsProvider).haptics);
    try {
      await ref.read(sessionControllerProvider.notifier).switchMode(mode);
      if (!mounted) return;
      context.go(Routes.home);
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final mode = ref.watch(currentProfileProvider)?.activeMode ?? UserMode.buyer;
    Widget segment(String value, String label, IconData icon) {
      final selected = mode == value;
      return Expanded(
        child: Semantics(
          selected: selected,
          button: true,
          label: l10n.modeSwitchSemantics(label),
          excludeSemantics: true,
          child: InkWell(
            borderRadius: JkRadii.pillAll,
            onTap: _busy ? null : () => _switch(value),
            child: AnimatedContainer(
              duration: context.motion(JkMotion.base),
              curve: JkMotion.standard,
              constraints: const BoxConstraints(minHeight: 48),
              alignment: Alignment.center,
              decoration: BoxDecoration(color: selected ? jk.primary : null, borderRadius: JkRadii.pillAll),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Icon(icon, size: 20, color: selected ? jk.onPrimary : jk.onSurfaceMuted),
                  const SizedBox(width: JkSpacing.s2),
                  Flexible(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: JkTypeScale.titleS.copyWith(color: selected ? jk.onPrimary : jk.onSurfaceMuted),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    }

    return DecoratedBox(
      decoration: BoxDecoration(color: jk.surface, borderRadius: JkRadii.pillAll, border: Border.all(color: jk.border)),
      child: Material(
        type: MaterialType.transparency,
        child: Padding(
          padding: const EdgeInsets.all(4),
          child: Row(
            children: <Widget>[
              segment(UserMode.buyer, l10n.modeBuyer, Icons.shopping_bag_outlined),
              segment(UserMode.traveler, l10n.modeTraveler, Icons.flight_takeoff),
            ],
          ),
        ),
      ),
    );
  }
}

/// Bell with unread badge ("Notifikasi, 3 baru").
class NotificationBell extends ConsumerWidget {
  const NotificationBell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final count = ref.watch(unreadCountProvider).valueOrNull ?? 0;
    return IconButton(
      tooltip: count > 0 ? l10n.notificationsBadge(count) : l10n.notificationsTitle,
      onPressed: () => context.push(Routes.notifications),
      icon: Badge(
        isLabelVisible: count > 0,
        label: Text(count > 99 ? '99+' : '$count'),
        child: const Icon(Icons.notifications_none),
      ),
    );
  }
}
