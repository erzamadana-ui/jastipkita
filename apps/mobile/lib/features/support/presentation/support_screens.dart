import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/config/app_config.dart';
import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/format/dates.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/engagement.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/common.dart';
import '../../../widgets/countdown_chip.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../../../widgets/paged_list.dart';
import '../../../widgets/states.dart';
import '../../engagement/data/engagement_repository.dart';

/// Help center: FAQ search (typo tolerant on the server), categories, tickets.
class SupportScreen extends ConsumerStatefulWidget {
  const SupportScreen({super.key});

  @override
  ConsumerState<SupportScreen> createState() => _SupportScreenState();
}

class _SupportScreenState extends ConsumerState<SupportScreen> {
  final TextEditingController _query = TextEditingController();
  Timer? _debounce;
  String? _category;
  List<FaqItem>? _items;
  Object? _error;
  bool _loading = false;

  static const List<String> _categories = <String>['GENERAL', 'BUYER', 'TRAVELER', 'PAYMENT', 'CUSTOMS', 'DELIVERY', 'DISPUTE', 'ACCOUNT', 'REFERRAL'];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((Duration _) => _search());
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _query.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    if (!mounted) return;
    final locale = context.localeCode;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final items = await ref.read(engagementRepositoryProvider).faq(query: _query.text.trim(), category: _category, locale: locale);
      if (!mounted) return;
      setState(() => _items = items);
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _onQuery(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), _search);
  }

  String _categoryLabel(AppLocalizations l10n, String c) => switch (c) {
        'BUYER' => l10n.faqCatBuyer,
        'TRAVELER' => l10n.faqCatTraveler,
        'PAYMENT' => l10n.faqCatPayment,
        'CUSTOMS' => l10n.faqCatCustoms,
        'DELIVERY' => l10n.faqCatDelivery,
        'DISPUTE' => l10n.faqCatDispute,
        'ACCOUNT' => l10n.faqCatAccount,
        'REFERRAL' => l10n.faqCatReferral,
        _ => l10n.faqCatGeneral,
      };

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final items = _items;
    final error = _error;
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.supportTitle),
        actions: <Widget>[
          IconButton(tooltip: l10n.ticketsTitle, onPressed: () => context.push(Routes.tickets), icon: const Icon(Icons.confirmation_number_outlined)),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'support-fab',
        onPressed: () => context.push(Routes.newTicket),
        icon: const Icon(Icons.support_agent),
        label: Text(l10n.ticketCreate),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s4, JkSpacing.s5, JkSpacing.s16),
        children: <Widget>[
          JkTextField(
            label: l10n.faqSearchLabel,
            controller: _query,
            hint: l10n.faqSearchHint,
            prefixIcon: const Icon(Icons.search),
            onChanged: _onQuery,
            textInputAction: TextInputAction.search,
            onSubmitted: (String _) => _search(),
          ),
          const SizedBox(height: JkSpacing.s3),
          Wrap(
            spacing: JkSpacing.s2,
            runSpacing: JkSpacing.s2,
            children: <Widget>[
              ChoiceChip(
                label: Text(l10n.faqCatAll),
                selected: _category == null,
                onSelected: (bool v) {
                  setState(() => _category = null);
                  _search();
                },
              ),
              for (final c in _categories)
                ChoiceChip(
                  label: Text(_categoryLabel(l10n, c)),
                  selected: _category == c,
                  onSelected: (bool v) {
                    setState(() => _category = v ? c : null);
                    _search();
                  },
                ),
            ],
          ),
          const SizedBox(height: JkSpacing.s4),
          if (_loading && items == null) const Center(child: CircularProgressIndicator()),
          if (error != null) ErrorView(error: error, onRetry: _search, compact: true),
          if (items != null && items.isEmpty)
            EmptyState(icon: Icons.help_outline, title: l10n.faqEmpty, actionLabel: l10n.ticketCreate, onAction: () => context.push(Routes.newTicket)),
          if (items != null)
            for (final f in items)
              Padding(
                padding: const EdgeInsets.only(bottom: JkSpacing.s2),
                child: JkCard(
                  onTap: () => context.push(Routes.faq(f.slug)),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(f.question, style: JkTypeScale.titleS.copyWith(color: jk.onSurface)),
                      const SizedBox(height: 4),
                      Text(f.excerpt, maxLines: 3, overflow: TextOverflow.ellipsis, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                    ],
                  ),
                ),
              ),
          if (AppConfig.supportWhatsApp.isNotEmpty || AppConfig.supportEmail.isNotEmpty) ...<Widget>[
            SectionHeader(title: l10n.supportContactTitle),
            if (AppConfig.supportWhatsApp.isNotEmpty)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.chat_outlined),
                title: Text(l10n.supportWhatsApp),
                trailing: const Icon(Icons.open_in_new),
                onTap: () => launchUrl(Uri.parse('https://wa.me/${AppConfig.supportWhatsApp}'), mode: LaunchMode.externalApplication),
              ),
            if (AppConfig.supportEmail.isNotEmpty)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.mail_outline),
                title: Text(AppConfig.supportEmail),
                trailing: const Icon(Icons.open_in_new),
                onTap: () => launchUrl(Uri(scheme: 'mailto', path: AppConfig.supportEmail)),
              ),
          ],
        ],
      ),
    );
  }
}

final _faqArticleProvider = FutureProvider.autoDispose.family<FaqArticle, (String, String)>(
  (ref, key) => ref.watch(engagementRepositoryProvider).faqArticle(key.$1, locale: key.$2),
);

/// FAQ article. The Markdown answer is rendered as readable paragraphs (headings, bullets).
class FaqArticleScreen extends ConsumerWidget {
  const FaqArticleScreen({super.key, required this.slug});

  final String slug;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final value = ref.watch(_faqArticleProvider((slug, context.localeCode)));
    return Scaffold(
      appBar: AppBar(title: Text(l10n.supportTitle)),
      body: AsyncValueView<FaqArticle>(
        value: value,
        onRetry: () => ref.invalidate(_faqArticleProvider((slug, context.localeCode))),
        data: (FaqArticle a) {
          final jk = context.jk;
          return ListView(
            padding: const EdgeInsets.all(JkSpacing.s5),
            children: <Widget>[
              Semantics(header: true, child: Text(a.question, style: JkTypeScale.headlineS.copyWith(color: jk.onBackground))),
              const SizedBox(height: JkSpacing.s4),
              ...MarkdownLite.render(a.answerMd, jk),
              const SizedBox(height: JkSpacing.s6),
              JkButton(
                label: l10n.faqStillNeedHelp,
                variant: JkButtonVariant.secondary,
                onPressed: () => context.push(Routes.newTicket),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// Minimal Markdown → widgets (headings, bullets, paragraphs, **bold** stripped) without a package.
abstract final class MarkdownLite {
  static String _inline(String s) => s.replaceAll('**', '').replaceAll('__', '').replaceAll('`', '');

  static List<Widget> render(String markdown, JkColors jk) {
    final widgets = <Widget>[];
    for (final raw in markdown.split('\n')) {
      final line = raw.trimRight();
      if (line.trim().isEmpty) {
        widgets.add(const SizedBox(height: JkSpacing.s2));
      } else if (line.startsWith('#')) {
        final text = _inline(line.replaceFirst(RegExp(r'^#+\s*'), ''));
        widgets.add(Semantics(header: true, child: Text(text, style: JkTypeScale.titleS.copyWith(color: jk.onBackground))));
      } else if (RegExp(r'^\s*([-*]|\d+\.)\s+').hasMatch(line)) {
        final text = _inline(line.replaceFirst(RegExp(r'^\s*([-*]|\d+\.)\s+'), ''));
        widgets.add(
          Padding(
            padding: const EdgeInsets.only(left: JkSpacing.s2, bottom: 4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('•  ', style: JkTypeScale.bodyM.copyWith(color: jk.onBackground)),
                Expanded(child: Text(text, style: JkTypeScale.bodyM.copyWith(color: jk.onBackground))),
              ],
            ),
          ),
        );
      } else {
        widgets.add(Text(_inline(line), style: JkTypeScale.bodyM.copyWith(color: jk.onBackground)));
      }
    }
    return widgets;
  }
}

/// My support tickets (TKT-…).
class TicketsScreen extends ConsumerWidget {
  const TicketsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.ticketsTitle)),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'tickets-fab',
        onPressed: () => context.push(Routes.newTicket),
        icon: const Icon(Icons.add),
        label: Text(l10n.ticketCreate),
      ),
      body: PagedListView<SupportTicket>(
        fetch: (String? cursor) => ref.read(engagementRepositoryProvider).tickets(cursor: cursor),
        empty: EmptyState(icon: Icons.confirmation_number_outlined, title: l10n.ticketsEmpty),
        itemBuilder: (BuildContext context, SupportTicket t) {
          final jk = context.jk;
          final at = t.updatedAt ?? t.createdAt;
          return JkCard(
            onTap: () => context.push(Routes.ticket(t.id)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Expanded(child: Text(t.subject, style: JkTypeScale.titleS.copyWith(color: jk.onSurface))),
                    StatusChip(label: Labels.ticketStatus(l10n, t.status), tone: jk.status[t.isClosed ? 'closed' : 'open']!),
                  ],
                ),
                Text(
                  <String>[t.number, Labels.ticketCategory(l10n, t.category), if (at != null) JkDates.shortDateTime(at, context.localeCode)].join(' · '),
                  style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// Ticket thread + reply (re-opens RESOLVED / PENDING_USER; CLOSED cannot be replied to).
class TicketDetailScreen extends ConsumerStatefulWidget {
  const TicketDetailScreen({super.key, required this.ticketId});

  final String ticketId;

  @override
  ConsumerState<TicketDetailScreen> createState() => _TicketDetailScreenState();
}

class _TicketDetailScreenState extends ConsumerState<TicketDetailScreen> {
  final TextEditingController _reply = TextEditingController();
  bool _sending = false;

  @override
  void dispose() {
    _reply.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _reply.text.trim();
    if (text.isEmpty) return;
    setState(() => _sending = true);
    try {
      await ref.read(engagementRepositoryProvider).replyTicket(widget.ticketId, text);
      if (!mounted) return;
      _reply.clear();
      ref.invalidate(ticketDetailProvider(widget.ticketId));
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final value = ref.watch(ticketDetailProvider(widget.ticketId));
    return Scaffold(
      appBar: AppBar(title: Text(value.valueOrNull?.number ?? l10n.ticketsTitle)),
      body: AsyncValueView<SupportTicket>(
        value: value,
        onRetry: () => ref.invalidate(ticketDetailProvider(widget.ticketId)),
        data: (SupportTicket t) {
          final jk = context.jk;
          final locale = context.localeCode;
          final sla = t.slaDueAt;
          return Column(
            children: <Widget>[
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.all(JkSpacing.s5),
                  children: <Widget>[
                    Text(t.subject, style: JkTypeScale.titleM.copyWith(color: jk.onBackground)),
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: JkSpacing.s2,
                      runSpacing: JkSpacing.s2,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: <Widget>[
                        StatusChip(label: Labels.ticketStatus(l10n, t.status), tone: jk.status[t.isClosed ? 'closed' : 'open']!),
                        Text(Labels.ticketCategory(l10n, t.category), style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted)),
                        if (sla != null && !t.isClosed) CountdownChip(expiresAt: sla, label: l10n.ticketSla, icon: Icons.schedule),
                      ],
                    ),
                    const SizedBox(height: JkSpacing.s4),
                    for (final m in t.messages)
                      Align(
                        alignment: m.mine ? Alignment.centerRight : Alignment.centerLeft,
                        child: Padding(
                          padding: const EdgeInsets.only(bottom: JkSpacing.s2),
                          child: ConstrainedBox(
                            constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.8),
                            child: DecoratedBox(
                              decoration: BoxDecoration(
                                color: m.mine ? jk.secondaryContainer : jk.surface,
                                borderRadius: JkRadii.lgAll,
                                border: m.mine ? null : Border.all(color: jk.border),
                              ),
                              child: Padding(
                                padding: const EdgeInsets.all(JkSpacing.s3),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: <Widget>[
                                    if (!m.mine)
                                      Text(
                                        m.authorType == 'AGENT' ? l10n.ticketAgent : l10n.ticketSystem,
                                        style: JkTypeScale.labelM.copyWith(color: jk.onSurfaceMuted),
                                      ),
                                    Text(m.body, style: JkTypeScale.bodyM.copyWith(color: m.mine ? jk.onSecondaryContainer : jk.onSurface)),
                                    if (m.createdAt != null)
                                      Text(JkDates.shortDateTime(m.createdAt!, locale), style: JkTypeScale.labelS.copyWith(color: jk.onSurfaceMuted)),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              if (t.isClosed)
                Padding(padding: const EdgeInsets.all(JkSpacing.s4), child: NoticeBox(message: l10n.ticketClosedNote))
              else
                SafeArea(
                  top: false,
                  child: Padding(
                    padding: const EdgeInsets.all(JkSpacing.s3),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: <Widget>[
                        Expanded(child: JkTextField(label: l10n.ticketReply, controller: _reply, maxLines: 4, minLines: 1)),
                        IconButton(tooltip: l10n.chatSend, onPressed: _sending ? null : _send, icon: Icon(Icons.send_rounded, color: jk.cta)),
                      ],
                    ),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

/// New ticket, optionally linked to one of my transactions or disputes.
class CreateTicketScreen extends ConsumerStatefulWidget {
  const CreateTicketScreen({super.key, this.transactionId, this.disputeId});

  final String? transactionId;
  final String? disputeId;

  @override
  ConsumerState<CreateTicketScreen> createState() => _CreateTicketScreenState();
}

class _CreateTicketScreenState extends ConsumerState<CreateTicketScreen> {
  late String _category = widget.disputeId != null ? 'DISPUTE' : (widget.transactionId != null ? 'TRANSACTION' : 'OTHER');
  final TextEditingController _subject = TextEditingController();
  final TextEditingController _message = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _subject.dispose();
    _message.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final l10n = context.l10n;
    if (_subject.text.trim().length < 3 || _message.text.trim().length < 10) {
      setState(() => _error = l10n.ticketValidation);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final ticket = await ref.read(engagementRepositoryProvider).createTicket(
            category: _category,
            subject: _subject.text.trim(),
            message: _message.text.trim(),
            transactionId: widget.transactionId,
            disputeId: widget.disputeId,
          );
      if (!mounted) return;
      showJkSnack(context, l10n.ticketCreated(ticket.number));
      context.pushReplacement(Routes.ticket(ticket.id));
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = errorMessage(l10n, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final error = _error;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.ticketCreate)),
      body: ListView(
        padding: const EdgeInsets.all(JkSpacing.s5),
        children: <Widget>[
          Text(l10n.ticketCategoryLabel, style: JkTypeScale.labelL.copyWith(color: jk.onSurface)),
          const SizedBox(height: 6),
          Wrap(
            spacing: JkSpacing.s2,
            runSpacing: JkSpacing.s2,
            children: <Widget>[
              for (final c in Labels.ticketCategories)
                ChoiceChip(label: Text(Labels.ticketCategory(l10n, c)), selected: _category == c, onSelected: (bool v) => setState(() => _category = c)),
            ],
          ),
          const SizedBox(height: JkSpacing.s4),
          JkTextField(label: l10n.ticketSubject, controller: _subject, maxLength: 120),
          const SizedBox(height: JkSpacing.s2),
          JkTextField(label: l10n.ticketMessage, controller: _message, maxLines: 6, minLines: 3, maxLength: 4000),
          if (widget.transactionId != null || widget.disputeId != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            NoticeBox(message: l10n.ticketLinked),
          ],
          if (error != null) ...<Widget>[const SizedBox(height: JkSpacing.s2), NoticeBox(tone: NoticeTone.error, message: error)],
          const SizedBox(height: JkSpacing.s4),
          JkButton(label: l10n.ticketSubmit, loading: _busy, onPressed: _submit),
          const SizedBox(height: JkSpacing.s2),
          Text(l10n.ticketSlaNote, style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted)),
        ],
      ),
    );
  }
}
