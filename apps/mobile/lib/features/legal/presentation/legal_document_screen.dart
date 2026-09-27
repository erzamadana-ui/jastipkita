import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/format/dates.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/account.dart';
import '../../../widgets/common.dart';
import '../../../widgets/states.dart';
import '../../auth/data/auth_repository.dart';
import '../../support/presentation/support_screens.dart';

/// Opens a published legal document (`GET /legal/documents/{type}`) in the app. Pushed on the
/// navigator directly so it also works before sign-in and on the consent screen.
Future<void> openLegalDocument(BuildContext context, String type) {
  return Navigator.of(context).push<void>(
    MaterialPageRoute<void>(builder: (BuildContext context) => LegalDocumentScreen(type: type)),
  );
}

/// Opens a public web page in the in-app browser (fallback when the API is unreachable).
Future<void> openLegal(String url) async {
  await launchUrl(Uri.parse(url), mode: LaunchMode.inAppBrowserView);
}

/// Legal document (ToS, Privacy, KYC consent, …) rendered from its Markdown body, with the exact
/// version the user is agreeing to. Seeded TEMPLATE texts carry a visible notice.
class LegalDocumentScreen extends ConsumerWidget {
  const LegalDocumentScreen({super.key, required this.type});

  /// Type code (TOS, PRIVACY, KYC, MARKETING, …) or slug.
  final String type;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final locale = context.localeCode;
    final value = ref.watch(legalDocumentProvider((type, locale)));
    return Scaffold(
      appBar: AppBar(title: Text(value.valueOrNull?.summary.title ?? l10n.legalDocumentTitle)),
      body: AsyncValueView<LegalDocument>(
        value: value,
        onRetry: () => ref.invalidate(legalDocumentProvider((type, locale))),
        data: (LegalDocument doc) {
          final jk = context.jk;
          final meta = doc.summary;
          final effective = meta.effectiveAt;
          final url = meta.url;
          return ListView(
            padding: const EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s4, JkSpacing.s5, JkSpacing.s8),
            children: <Widget>[
              Text(
                <String>[
                  l10n.legalVersion(meta.version),
                  if (effective != null) l10n.legalEffective(JkDates.date(effective, locale)),
                ].join(' · '),
                style: JkTypeScale.labelM.copyWith(color: jk.onBackgroundMuted),
              ),
              if (meta.isTemplate) ...<Widget>[
                const SizedBox(height: JkSpacing.s3),
                NoticeBox(tone: NoticeTone.warning, message: l10n.legalTemplateNotice),
              ],
              const SizedBox(height: JkSpacing.s4),
              ...MarkdownLite.render(doc.bodyMd, jk),
              if (url != null && url.isNotEmpty) ...<Widget>[
                const SizedBox(height: JkSpacing.s4),
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: () => openLegal(url),
                    icon: const Icon(Icons.open_in_new, size: 18),
                    label: Text(l10n.legalOpenWeb),
                  ),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}
