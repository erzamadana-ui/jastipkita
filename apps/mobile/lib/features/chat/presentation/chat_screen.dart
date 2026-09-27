import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/format/dates.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/engagement.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/api_image.dart';
import '../../../widgets/common.dart';
import '../../../widgets/states.dart';
import '../../engagement/data/engagement_repository.dart';
import '../../files/data/file_upload_service.dart';

/// Conversation (per transaction): text, images, product/receipt cards, system/status messages.
/// Off-platform payment & contact details are masked by the API (`moderation.status = FLAGGED`)
/// and the app shows why; a permanent notice reminds both parties to stay on SafePay.
class ChatScreen extends ConsumerStatefulWidget {
  const ChatScreen({super.key, required this.conversationId});

  final String conversationId;

  @override
  ConsumerState<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends ConsumerState<ChatScreen> {
  final List<ChatMessage> _messages = <ChatMessage>[];
  final TextEditingController _input = TextEditingController();
  String? _cursor;
  bool _hasMore = false;
  bool _loading = true;
  bool _loadingMore = false;
  bool _sending = false;
  Object? _error;
  Conversation? _conversation;
  Timer? _poll;
  String? _lastReadId;

  EngagementRepository get _repo => ref.read(engagementRepositoryProvider);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((Duration _) {
      _load();
      _loadConversation();
    });
    _poll = Timer.periodic(const Duration(seconds: 6), (Timer t) => _refreshNewest());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _input.dispose();
    super.dispose();
  }

  Future<void> _loadConversation() async {
    try {
      final conversation = await _repo.conversation(widget.conversationId);
      if (mounted) setState(() => _conversation = conversation);
    } on Object {
      // Header metadata is optional; messages still load.
    }
  }

  Future<void> _load() async {
    try {
      final page = await _repo.messages(widget.conversationId);
      if (!mounted) return;
      setState(() {
        _messages
          ..clear()
          ..addAll(page.items);
        _cursor = page.nextCursor;
        _hasMore = page.hasMore;
        _loading = false;
        _error = null;
      });
      _markRead();
    } on Object catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e;
        _loading = false;
      });
    }
  }

  Future<void> _refreshNewest() async {
    if (!mounted || _loading) return;
    try {
      final page = await _repo.messages(widget.conversationId);
      if (!mounted) return;
      final known = _messages.map((ChatMessage m) => m.id).toSet();
      final fresh = page.items.where((ChatMessage m) => !known.contains(m.id)).toList();
      if (fresh.isEmpty) return;
      setState(() {
        _messages.removeWhere((ChatMessage m) => m.pending);
        _messages.insertAll(0, fresh);
      });
      _markRead();
    } on Object {
      // Polling is best effort.
    }
  }

  Future<void> _loadMore() async {
    if (_loadingMore || !_hasMore) return;
    setState(() => _loadingMore = true);
    try {
      final page = await _repo.messages(widget.conversationId, cursor: _cursor);
      if (!mounted) return;
      setState(() {
        _messages.addAll(page.items);
        _cursor = page.nextCursor;
        _hasMore = page.hasMore;
      });
    } on Object {
      // Keep what we have; the user can scroll again.
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  void _markRead() {
    if (_messages.isEmpty) return;
    final newest = _messages.first.id;
    if (newest == _lastReadId) return;
    _lastReadId = newest;
    _sendRead(newest);
    ref.invalidate(unreadCountProvider);
  }

  Future<void> _sendRead(String messageId) async {
    try {
      await _repo.markConversationRead(widget.conversationId, messageId: messageId);
    } on Object {
      // Read receipts are best effort.
    }
  }

  Future<void> _sendText() async {
    final text = _input.text.trim();
    if (text.isEmpty || _sending) return;
    final optimistic = ChatMessage(id: 'local-${DateTime.now().microsecondsSinceEpoch}', type: 'TEXT', mine: true, body: text, pending: true);
    setState(() {
      _sending = true;
      _messages.insert(0, optimistic);
      _input.clear();
    });
    try {
      final sent = await _repo.sendMessage(widget.conversationId, type: 'TEXT', body: text);
      if (!mounted) return;
      setState(() {
        final index = _messages.indexOf(optimistic);
        if (index >= 0) _messages[index] = sent;
      });
      _markRead();
    } on Object catch (e) {
      if (!mounted) return;
      setState(() {
        _messages.remove(optimistic);
        _input.text = text;
      });
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _sendImage() async {
    final picked = await ref.read(mediaPickerProvider).image(camera: false);
    if (picked == null || !mounted) return;
    setState(() => _sending = true);
    try {
      final fileId = await ref.read(fileUploadServiceProvider).upload(picked, purpose: FilePurpose.chat);
      final sent = await _repo.sendMessage(widget.conversationId, type: 'IMAGE', body: _input.text.trim(), fileIds: <String>[fileId]);
      if (!mounted) return;
      setState(() {
        _messages.insert(0, sent);
        _input.clear();
      });
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// Attachments carry an absolute `contentUrl` (API-served, bearer attached by [ApiImage]).
  Future<void> _openImage(ChatAttachment attachment) async {
    try {
      final url = attachment.contentUrl ?? await ref.read(fileUploadServiceProvider).imageUrl(attachment.fileId);
      if (!mounted) return;
      await showApiImageDialog(context, url);
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final conversation = _conversation;
    final locked = conversation?.isLocked ?? false;
    final error = _error;
    final txId = conversation?.transactionId;
    return Scaffold(
      appBar: AppBar(
        title: FittedBox(
          fit: BoxFit.scaleDown,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: context.isCupertino ? CrossAxisAlignment.center : CrossAxisAlignment.start,
            children: <Widget>[
              Text(conversation?.counterpartName ?? l10n.chatTitle),
              if (conversation?.transactionNumber != null)
                Text(conversation!.transactionNumber!, style: JkTypeScale.labelM.copyWith(color: jk.onSurfaceMuted)),
            ],
          ),
        ),
        actions: <Widget>[
          if (txId != null)
            IconButton(
              tooltip: l10n.txDetailTitle,
              onPressed: () => context.push(Routes.transaction(txId)),
              icon: const Icon(Icons.receipt_long_outlined),
            ),
        ],
      ),
      body: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(JkSpacing.s3, JkSpacing.s2, JkSpacing.s3, 0),
            child: NoticeBox(tone: NoticeTone.warning, icon: Icons.shield_outlined, message: l10n.chatSafetyNotice),
          ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : error != null && _messages.isEmpty
                    ? ListView(children: <Widget>[ErrorView(error: error, onRetry: _load)])
                    : NotificationListener<ScrollNotification>(
                        onNotification: (ScrollNotification n) {
                          if (n.metrics.extentAfter < 300) _loadMore();
                          return false;
                        },
                        child: ListView.builder(
                          reverse: true,
                          padding: const EdgeInsets.all(JkSpacing.s3),
                          itemCount: _messages.length + (_loadingMore ? 1 : 0),
                          itemBuilder: (BuildContext context, int index) {
                            if (index >= _messages.length) {
                              return const Padding(padding: EdgeInsets.all(JkSpacing.s3), child: Center(child: CircularProgressIndicator()));
                            }
                            return _MessageBubble(message: _messages[index], onOpenImage: _openImage);
                          },
                        ),
                      ),
          ),
          if (locked)
            Padding(
              padding: const EdgeInsets.all(JkSpacing.s3),
              child: NoticeBox(message: l10n.chatLocked),
            )
          else
            _Composer(controller: _input, sending: _sending, onSend: _sendText, onAttach: _sendImage),
        ],
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({required this.controller, required this.sending, required this.onSend, required this.onAttach});

  final TextEditingController controller;
  final bool sending;
  final VoidCallback onSend;
  final VoidCallback onAttach;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    return DecoratedBox(
      decoration: BoxDecoration(color: jk.surfaceElevated, border: Border(top: BorderSide(color: jk.divider))),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: JkSpacing.s2, vertical: JkSpacing.s2),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              IconButton(tooltip: l10n.chatAttachPhoto, onPressed: sending ? null : onAttach, icon: const Icon(Icons.add_photo_alternate_outlined)),
              Expanded(
                child: TextField(
                  controller: controller,
                  minLines: 1,
                  maxLines: 5,
                  maxLength: 4000,
                  textCapitalization: TextCapitalization.sentences,
                  decoration: InputDecoration(
                    hintText: l10n.chatInputHint,
                    counterText: '',
                    filled: true,
                    fillColor: jk.surface,
                    contentPadding: const EdgeInsets.symmetric(horizontal: JkSpacing.s4, vertical: JkSpacing.s3),
                    border: OutlineInputBorder(borderRadius: JkRadii.lgAll, borderSide: BorderSide(color: jk.outline)),
                    enabledBorder: OutlineInputBorder(borderRadius: JkRadii.lgAll, borderSide: BorderSide(color: jk.outline)),
                    focusedBorder: OutlineInputBorder(borderRadius: JkRadii.lgAll, borderSide: BorderSide(color: jk.focusRing, width: 2)),
                  ),
                ),
              ),
              IconButton(
                tooltip: l10n.chatSend,
                onPressed: sending ? null : onSend,
                icon: Icon(Icons.send_rounded, color: jk.cta),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message, required this.onOpenImage});

  final ChatMessage message;
  final ValueChanged<ChatAttachment> onOpenImage;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final m = message;
    final at = m.createdAt;
    if (m.isSystem) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: JkSpacing.s2),
        child: Center(
          child: DecoratedBox(
            decoration: BoxDecoration(color: jk.surfaceMuted, borderRadius: JkRadii.pillAll, border: Border.all(color: jk.border)),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: JkSpacing.s3, vertical: 6),
              child: Text(
                at == null ? m.displayBody : '${m.displayBody} · ${JkDates.time(at)}',
                textAlign: TextAlign.center,
                style: JkTypeScale.labelM.copyWith(color: jk.onSurfaceMuted),
              ),
            ),
          ),
        ),
      );
    }
    final mine = m.mine;
    final bg = mine ? jk.secondaryContainer : jk.surface;
    final fg = mine ? jk.onSecondaryContainer : jk.onSurface;
    final radius = BorderRadius.only(
      topLeft: const Radius.circular(JkRadii.lg),
      topRight: const Radius.circular(JkRadii.lg),
      bottomLeft: Radius.circular(mine ? JkRadii.lg : JkRadii.xs),
      bottomRight: Radius.circular(mine ? JkRadii.xs : JkRadii.lg),
    );
    final content = <Widget>[];
    if (m.isHidden) {
      content.add(Text(l10n.chatHidden, style: JkTypeScale.bodyM.copyWith(color: fg, fontStyle: FontStyle.italic)));
    } else {
      if (m.type == 'RECEIPT' || m.type == 'PRODUCT') {
        content.add(
          Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(m.type == 'RECEIPT' ? Icons.receipt_long_outlined : Icons.shopping_bag_outlined, color: fg, size: 18),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  m.type == 'RECEIPT' ? l10n.chatReceiptCard : l10n.chatProductCard,
                  style: JkTypeScale.labelL.copyWith(color: fg, fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ),
        );
        final name = m.meta['productName'] ?? m.meta['merchantName'];
        if (name != null) content.add(Text(name.toString(), style: JkTypeScale.bodyM.copyWith(color: fg)));
      }
      for (final a in m.attachments) {
        content.add(
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: OutlinedButton.icon(
              onPressed: () => onOpenImage(a),
              icon: const Icon(Icons.image_outlined),
              label: Text(l10n.chatViewPhoto),
            ),
          ),
        );
      }
      if (m.displayBody.isNotEmpty) content.add(Text(m.displayBody, style: JkTypeScale.bodyM.copyWith(color: fg)));
      if (m.isFlagged) {
        content.add(
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(Icons.shield_outlined, size: 14, color: jk.warningText),
                const SizedBox(width: 4),
                Flexible(child: Text(l10n.chatMasked, style: JkTypeScale.labelS.copyWith(color: jk.warningText))),
              ],
            ),
          ),
        );
      }
    }
    content.add(
      Text(
        m.pending ? l10n.chatSending : (at == null ? '' : JkDates.time(at).replaceAll(' WIB', '')),
        style: JkTypeScale.labelS.copyWith(color: jk.onSurfaceMuted),
      ),
    );
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.8),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: DecoratedBox(
            decoration: BoxDecoration(color: bg, borderRadius: radius, border: mine ? null : Border.all(color: jk.border)),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: JkSpacing.s3, vertical: JkSpacing.s2),
              child: Column(
                crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: content,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
