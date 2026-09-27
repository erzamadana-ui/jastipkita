import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/l10n/l10n.dart';
import '../../../widgets/states.dart';
import '../application/session_controller.dart';

/// Shown while the stored session is restored (the router leaves it automatically).
class SplashScreen extends ConsumerWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final session = ref.watch(sessionControllerProvider);
    final error = session.restoreError;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(JkSpacing.s6),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                BrandLogo(height: 180, label: l10n.appName),
                const SizedBox(height: JkSpacing.s3),
                Text(l10n.tagline, textAlign: TextAlign.center, style: JkTypeScale.titleS.copyWith(color: context.jk.onBackgroundMuted)),
                const SizedBox(height: JkSpacing.s8),
                if (error == null)
                  Semantics(label: l10n.loading, child: const CircularProgressIndicator())
                else
                  ErrorView(
                    error: error,
                    onRetry: () => ref.read(sessionControllerProvider.notifier).restore(),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Brand lockup (PNG from brand/splash, light/dark variant — never re-typed as live text).
class BrandLogo extends StatelessWidget {
  const BrandLogo({super.key, required this.height, required this.label});

  final double height;
  final String label;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Image.asset(
      dark ? 'assets/splash/splash-logo-dark.png' : 'assets/splash/splash-logo-light.png',
      height: height,
      fit: BoxFit.contain,
      semanticLabel: label,
      errorBuilder: (BuildContext context, Object error, StackTrace? stackTrace) => SizedBox(height: height),
    );
  }
}
