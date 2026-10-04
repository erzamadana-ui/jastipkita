import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/format/dates.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/engagement.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../../engagement/data/engagement_repository.dart';

/// "Pengaduan konsumen" (Permendag 19/2026, UU 8/1999): files a support ticket with category
/// COMPLAINT (priority HIGH by default on the server) and shows the published first-response
/// SLA plus the government escalation channel from `GET /support/complaint-info`.
class ComplaintScreen extends ConsumerStatefulWidget {
  const ComplaintScreen({super.key, this.transactionId});

  final String? transactionId;

  @override
  ConsumerState<ComplaintScreen> createState() => _ComplaintScreenState();
}

class _ComplaintScreenState extends ConsumerState<ComplaintScreen> {
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
            category: 'COMPLAINT',
            subject: _subject.text.trim(),
            message: _message.text.trim(),
            transactionId: widget.transactionId,
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
    final info = ref.watch(complaintInfoProvider);
    final loaded = info.valueOrNull;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.complaintTitle)),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s4, JkSpacing.s5, JkSpacing.s12),
        children: <Widget>[
          Text(l10n.complaintIntro, style: JkTypeScale.bodyM.copyWith(color: jk.onBackgroundMuted)),
          const SizedBox(height: JkSpacing.s4),
          if (loaded != null)
            _SlaCard(info: loaded)
          else if (info.hasError)
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                NoticeBox(message: l10n.complaintSlaUnavailable),
                TextButton(onPressed: () => ref.invalidate(complaintInfoProvider), child: Text(l10n.actionRetry)),
              ],
            )
          else
            const LinearProgressIndicator(),
          SectionHeader(title: l10n.complaintFormTitle),
          JkTextField(label: l10n.ticketSubject, controller: _subject, maxLength: 120),
          const SizedBox(height: JkSpacing.s2),
          JkTextField(
            label: l10n.ticketMessage,
            controller: _message,
            maxLines: 6,
            minLines: 3,
            maxLength: 4000,
            helper: l10n.complaintIncludeHint,
          ),
          if (widget.transactionId != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            NoticeBox(message: l10n.ticketLinked),
          ],
          if (error != null) ...<Widget>[const SizedBox(height: JkSpacing.s2), NoticeBox(tone: NoticeTone.error, message: error)],
          const SizedBox(height: JkSpacing.s4),
          JkButton(label: l10n.complaintSubmit, icon: Icons.send_outlined, loading: _busy, onPressed: _submit),
          const SizedBox(height: JkSpacing.s2),
          Text(l10n.complaintNoSecrets, style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted)),
          const SizedBox(height: JkSpacing.s4),
          NoticeBox(icon: Icons.shield_outlined, message: l10n.complaintDisputeNote),
          if (loaded != null) _EscalationCard(info: loaded),
        ],
      ),
    );
  }
}

/// First-response target of a complaint + the whole table by priority (config `support.sla`).
class _SlaCard extends StatelessWidget {
  const _SlaCard({required this.info});

  final ComplaintInfo info;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    return JkCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.schedule, color: jk.secondary),
              const SizedBox(width: JkSpacing.s2),
              Expanded(child: Text(l10n.complaintSlaTitle, style: JkTypeScale.titleS.copyWith(color: jk.onSurface))),
            ],
          ),
          const SizedBox(height: JkSpacing.s2),
          Text(l10n.complaintSlaHours(info.complaintFirstResponseHours), style: JkTypeScale.bodyL.copyWith(color: jk.onSurface)),
          const SizedBox(height: JkSpacing.s3),
          for (final p in ComplaintInfo.priorities)
            if (info.hoursByPriority.containsKey(p))
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  children: <Widget>[
                    Expanded(
                      child: Text(
                        p == info.complaintPriority ? '${Labels.ticketPriority(l10n, p)} · ${l10n.complaintTitle}' : Labels.ticketPriority(l10n, p),
                        style: (p == info.complaintPriority ? JkTypeScale.labelL : JkTypeScale.bodyS).copyWith(color: jk.onSurface),
                      ),
                    ),
                    Text(l10n.complaintHoursShort(info.hoursByPriority[p] ?? 0), style: JkTypeScale.bodyS.copyWith(color: jk.onSurface)),
                  ],
                ),
              ),
          const SizedBox(height: JkSpacing.s2),
          Text(l10n.complaintSlaNote, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
        ],
      ),
    );
  }
}

/// Government escalation channel (Ditjen PKTN, Kementerian Perdagangan) and BPSK.
class _EscalationCard extends StatelessWidget {
  const _EscalationCard({required this.info});

  final ComplaintInfo info;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final whatsapp = info.escalationWhatsappUrl;
    final email = info.escalationEmail;
    final phone = info.escalationPhoneNumber;
    final website = info.escalationWebsite;
    final verifiedAt = info.escalationVerifiedAt;
    return Padding(
      padding: const EdgeInsets.only(top: JkSpacing.s4),
      child: JkCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Semantics(header: true, child: Text(l10n.complaintEscalationTitle, style: JkTypeScale.titleS.copyWith(color: jk.onSurface))),
            const SizedBox(height: 4),
            Text(l10n.complaintEscalationBody, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
            const SizedBox(height: JkSpacing.s2),
            Text(info.escalationAuthority, style: JkTypeScale.labelL.copyWith(color: jk.onSurface)),
            Text('${info.escalationUnit} — ${info.escalationMinistry}', style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
            if (whatsapp != null)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.chat_outlined),
                title: Text('WhatsApp ${info.escalationWhatsappDisplay ?? ''}'.trim()),
                trailing: const Icon(Icons.open_in_new),
                onTap: () => launchUrl(Uri.parse(whatsapp), mode: LaunchMode.externalApplication),
              ),
            if (email != null)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.mail_outline),
                title: Text(email),
                onTap: () => launchUrl(Uri(scheme: 'mailto', path: email)),
              ),
            if (phone != null)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.phone_outlined),
                title: Text(info.escalationPhoneDisplay ?? phone),
                onTap: () => launchUrl(Uri(scheme: 'tel', path: phone)),
              ),
            if (website != null)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.language),
                title: Text(Uri.tryParse(website)?.host ?? website),
                trailing: const Icon(Icons.open_in_new),
                onTap: () => launchUrl(Uri.parse(website), mode: LaunchMode.externalApplication),
              ),
            Text(l10n.complaintBpsk, style: JkTypeScale.bodyS.copyWith(color: jk.onSurface)),
            if (verifiedAt.isNotEmpty) ...<Widget>[
              const SizedBox(height: JkSpacing.s2),
              Text(
                l10n.complaintEscalationVerified(JkDates.calendar(verifiedAt, context.localeCode)),
                style: JkTypeScale.labelS.copyWith(color: jk.onSurfaceMuted),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
