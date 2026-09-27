import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/router/deep_links.dart';
import '../../../core/storage/settings.dart';
import '../../../widgets/jk_button.dart';
import 'splash_screen.dart';

/// Onboarding carousel — trust & clarity first (§6.1): what JastipKita is, verified travelers,
/// money held by SafePay.
class WelcomeScreen extends ConsumerStatefulWidget {
  const WelcomeScreen({super.key});

  @override
  ConsumerState<WelcomeScreen> createState() => _WelcomeScreenState();
}

class _WelcomeScreenState extends ConsumerState<WelcomeScreen> {
  final PageController _controller = PageController();
  int _page = 0;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    await ref.read(settingsProvider.notifier).markOnboardingSeen();
    if (!mounted) return;
    context.go(Routes.login);
  }

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final slides = <(IconData, String, String)>[
      (Icons.shopping_bag_outlined, l10n.onboardingTitle1, l10n.onboardingBody1),
      (Icons.verified_user_outlined, l10n.onboardingTitle2, l10n.onboardingBody2),
      (Icons.shield_outlined, l10n.onboardingTitle3, l10n.onboardingBody3),
    ];
    final last = _page == slides.length - 1;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: <Widget>[
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(onPressed: _start, child: Text(l10n.actionSkip)),
            ),
            BrandLogo(height: 96, label: l10n.appName),
            Expanded(
              child: PageView.builder(
                controller: _controller,
                itemCount: slides.length,
                onPageChanged: (int i) => setState(() => _page = i),
                itemBuilder: (BuildContext context, int index) {
                  final (icon, title, body) = slides[index];
                  return SingleChildScrollView(
                    padding: const EdgeInsets.symmetric(horizontal: JkSpacing.s6, vertical: JkSpacing.s4),
                    child: Column(
                      children: <Widget>[
                        Container(
                          width: 112,
                          height: 112,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(color: jk.secondaryContainer, shape: BoxShape.circle),
                          child: Icon(icon, size: 56, color: jk.secondary),
                        ),
                        const SizedBox(height: JkSpacing.s6),
                        Semantics(
                          header: true,
                          child: Text(
                            title,
                            textAlign: TextAlign.center,
                            style: JkTypeScale.headlineM.copyWith(color: jk.onBackground, fontWeight: FontWeight.w700),
                          ),
                        ),
                        const SizedBox(height: JkSpacing.s3),
                        Text(body, textAlign: TextAlign.center, style: JkTypeScale.bodyL.copyWith(color: jk.onBackgroundMuted)),
                      ],
                    ),
                  );
                },
              ),
            ),
            Semantics(
              label: l10n.onboardingPageSemantics(_page + 1, slides.length),
              excludeSemantics: true,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  for (var i = 0; i < slides.length; i++)
                    AnimatedContainer(
                      duration: context.motion(JkMotion.base),
                      margin: const EdgeInsets.symmetric(horizontal: 4),
                      width: i == _page ? 24 : 8,
                      height: 8,
                      decoration: BoxDecoration(color: i == _page ? jk.cta : jk.border, borderRadius: JkRadii.pillAll),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(JkSpacing.s5),
              child: JkButton(
                label: last ? l10n.onboardingStart : l10n.actionNext,
                onPressed: last
                    ? _start
                    : () => _controller.nextPage(duration: context.motion(JkMotion.slow), curve: JkMotion.emphasizedDecelerate),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
