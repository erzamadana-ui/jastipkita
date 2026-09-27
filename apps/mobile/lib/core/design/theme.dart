import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';

import 'tokens.g.dart';

/// Material 3 theme built only from design tokens (`tokens.g.dart`).
///
/// * Android: Material 3 with Expressive touches — larger shapes (pill buttons, 20px cards,
///   28px sheets), emphasized weights, short springy motion (see [JkMotion]).
/// * iOS: same brand, Cupertino-flavoured — no ink splash, Cupertino page transitions,
///   centred titles.
/// * Dynamic colour (Material You) is intentionally NOT used for brand/transaction surfaces.
ThemeData buildJkTheme(Brightness brightness, {TargetPlatform? platform}) {
  final c = brightness == Brightness.dark ? JkColors.dark : JkColors.light;
  final isIOS = platform == TargetPlatform.iOS || platform == TargetPlatform.macOS;

  final scheme = ColorScheme(
    brightness: brightness,
    primary: c.primary,
    onPrimary: c.onPrimary,
    primaryContainer: c.primaryContainer,
    onPrimaryContainer: c.onPrimaryContainer,
    secondary: c.secondary,
    onSecondary: c.onSecondary,
    secondaryContainer: c.secondaryContainer,
    onSecondaryContainer: c.onSecondaryContainer,
    tertiary: c.cta,
    onTertiary: c.onCta,
    error: c.error,
    onError: c.onError,
    errorContainer: c.errorContainer,
    onErrorContainer: c.onErrorContainer,
    surface: c.surface,
    onSurface: c.onSurface,
    onSurfaceVariant: c.onSurfaceMuted,
    surfaceContainerLowest: c.surface,
    surfaceContainerLow: c.surface,
    surfaceContainer: c.surfaceMuted,
    surfaceContainerHigh: c.surfaceElevated,
    surfaceContainerHighest: c.surfaceMuted,
    outline: c.outline,
    outlineVariant: c.border,
    shadow: JkPalette.black,
    scrim: c.scrim,
    inverseSurface: c.surfaceInverse,
    onInverseSurface: c.onSurfaceInverse,
    inversePrimary: c.link,
    surfaceTint: Colors.transparent,
  );

  final textTheme = const TextTheme(
    displayLarge: JkTypeScale.display,
    displayMedium: JkTypeScale.display,
    displaySmall: JkTypeScale.display,
    headlineLarge: JkTypeScale.headlineL,
    headlineMedium: JkTypeScale.headlineM,
    headlineSmall: JkTypeScale.headlineS,
    titleLarge: JkTypeScale.titleL,
    titleMedium: JkTypeScale.titleM,
    titleSmall: JkTypeScale.titleS,
    bodyLarge: JkTypeScale.bodyL,
    bodyMedium: JkTypeScale.bodyM,
    bodySmall: JkTypeScale.bodyS,
    labelLarge: JkTypeScale.labelL,
    labelMedium: JkTypeScale.labelM,
    labelSmall: JkTypeScale.labelS,
  ).apply(bodyColor: c.onSurface, displayColor: c.onSurface);

  final buttonLabel = JkTypeScale.labelL.copyWith(fontSize: 16, fontWeight: FontWeight.w600);

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    fontFamily: JkTypeScale.fontFamily,
    textTheme: textTheme,
    scaffoldBackgroundColor: c.background,
    canvasColor: c.background,
    extensions: <ThemeExtension<dynamic>>[c],
    materialTapTargetSize: MaterialTapTargetSize.padded,
    splashFactory: isIOS ? NoSplash.splashFactory : InkRipple.splashFactory,
    pageTransitionsTheme: const PageTransitionsTheme(
      builders: <TargetPlatform, PageTransitionsBuilder>{
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.android: ZoomPageTransitionsBuilder(),
      },
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: c.cta,
        foregroundColor: c.onCta,
        disabledBackgroundColor: c.disabledContainer,
        disabledForegroundColor: c.disabledContent,
        minimumSize: const Size(64, 52),
        padding: const EdgeInsets.symmetric(horizontal: JkSpacing.s6, vertical: JkSpacing.s3),
        shape: const StadiumBorder(),
        textStyle: buttonLabel,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: c.onSurface,
        backgroundColor: c.surface,
        disabledForegroundColor: c.disabledContent,
        minimumSize: const Size(64, 52),
        padding: const EdgeInsets.symmetric(horizontal: JkSpacing.s6, vertical: JkSpacing.s3),
        side: BorderSide(color: c.outline),
        shape: const StadiumBorder(),
        textStyle: buttonLabel,
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: c.link,
        minimumSize: const Size(48, 48),
        textStyle: JkTypeScale.labelL.copyWith(fontWeight: FontWeight.w600),
      ),
    ),
    iconButtonTheme: IconButtonThemeData(
      style: IconButton.styleFrom(foregroundColor: c.onSurface, minimumSize: const Size(48, 48)),
    ),
    floatingActionButtonTheme: FloatingActionButtonThemeData(
      backgroundColor: c.cta,
      foregroundColor: c.onCta,
      shape: const RoundedRectangleBorder(borderRadius: JkRadii.lgAll),
      extendedTextStyle: buttonLabel,
    ),
    cardTheme: CardThemeData(
      color: c.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: JkRadii.lgAll, side: BorderSide(color: c.border)),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: c.surfaceElevated,
      surfaceTintColor: Colors.transparent,
      shape: const RoundedRectangleBorder(borderRadius: JkRadii.xlAll),
      titleTextStyle: JkTypeScale.titleL.copyWith(color: c.onSurface),
      contentTextStyle: JkTypeScale.bodyM.copyWith(color: c.onSurface),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: c.surfaceElevated,
      surfaceTintColor: Colors.transparent,
      modalBackgroundColor: c.surfaceElevated,
      modalBarrierColor: c.scrim,
      showDragHandle: true,
      dragHandleColor: c.outline,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(JkRadii.xl))),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: c.surfaceInverse,
      contentTextStyle: JkTypeScale.bodyM.copyWith(color: c.onSurfaceInverse),
      actionTextColor: brightness == Brightness.dark ? c.cta : JkPalette.cobalt300,
      shape: const RoundedRectangleBorder(borderRadius: JkRadii.mdAll),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: c.surface,
      selectedColor: c.secondaryContainer,
      disabledColor: c.disabledContainer,
      labelStyle: JkTypeScale.labelL.copyWith(color: c.onSurface),
      secondaryLabelStyle: JkTypeScale.labelL.copyWith(color: c.onSecondaryContainer),
      side: BorderSide(color: c.border),
      shape: const StadiumBorder(),
      checkmarkColor: c.onSecondaryContainer,
      padding: const EdgeInsets.symmetric(horizontal: JkSpacing.s2, vertical: JkSpacing.s1),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: c.surface,
      surfaceTintColor: Colors.transparent,
      indicatorColor: c.secondaryContainer,
      elevation: 0,
      height: 72,
      labelTextStyle: WidgetStateProperty.resolveWith<TextStyle?>((Set<WidgetState> states) {
        final selected = states.contains(WidgetState.selected);
        return JkTypeScale.labelS.copyWith(
          color: selected ? c.onSecondaryContainer : c.onSurfaceMuted,
          fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
        );
      }),
      iconTheme: WidgetStateProperty.resolveWith<IconThemeData?>((Set<WidgetState> states) {
        final selected = states.contains(WidgetState.selected);
        return IconThemeData(color: selected ? c.onSecondaryContainer : c.onSurfaceMuted, size: 24);
      }),
    ),
    checkboxTheme: CheckboxThemeData(
      fillColor: WidgetStateProperty.resolveWith<Color?>((Set<WidgetState> states) {
        if (states.contains(WidgetState.disabled)) return c.disabledContainer;
        if (states.contains(WidgetState.selected)) return c.cta;
        return null;
      }),
      checkColor: WidgetStateProperty.all<Color>(c.onCta),
      side: BorderSide(color: c.outline, width: 1.5),
      shape: const RoundedRectangleBorder(borderRadius: JkRadii.xsAll),
    ),
    dividerTheme: DividerThemeData(color: c.divider, thickness: 1, space: 1),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: c.cta, linearTrackColor: c.surfaceMuted),
    listTileTheme: ListTileThemeData(
      iconColor: c.onSurfaceMuted,
      textColor: c.onSurface,
      titleTextStyle: JkTypeScale.bodyL.copyWith(color: c.onSurface, fontWeight: FontWeight.w500),
      subtitleTextStyle: JkTypeScale.bodyS.copyWith(color: c.onSurfaceMuted),
      minVerticalPadding: JkSpacing.s3,
    ),
    tooltipTheme: TooltipThemeData(
      decoration: BoxDecoration(color: c.surfaceInverse, borderRadius: JkRadii.smAll),
      textStyle: JkTypeScale.bodyS.copyWith(color: c.onSurfaceInverse),
    ),
  );
}

extension JkThemeContext on BuildContext {
  /// Semantic colour tokens for the current theme.
  JkColors get jk => Theme.of(this).extension<JkColors>() ?? JkColors.light;

  bool get isCupertino {
    final p = Theme.of(this).platform;
    return p == TargetPlatform.iOS || p == TargetPlatform.macOS;
  }

  /// OS "reduce motion": spatial motion is replaced by a short cross-fade.
  bool get reduceMotion => MediaQuery.disableAnimationsOf(this);

  Duration motion(Duration normal) => reduceMotion ? JkMotion.reducedCrossfade : normal;

  List<BoxShadow> elevation(int level) {
    final dark = Theme.of(this).brightness == Brightness.dark;
    switch (level) {
      case 0:
        return dark ? JkElevation.level0Dark : JkElevation.level0Light;
      case 1:
        return dark ? JkElevation.level1Dark : JkElevation.level1Light;
      case 2:
        return dark ? JkElevation.level2Dark : JkElevation.level2Light;
      case 3:
        return dark ? JkElevation.level3Dark : JkElevation.level3Light;
      default:
        return dark ? JkElevation.level4Dark : JkElevation.level4Light;
    }
  }
}
