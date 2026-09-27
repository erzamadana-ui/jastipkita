import 'package:flutter/material.dart';

import '../core/design/tokens.g.dart';
import '../core/models/json.dart';
import 'states.dart';

/// Cursor-paginated list (`?limit=&cursor=` → `{data, nextCursor}`) with pull-to-refresh,
/// infinite scroll, skeleton, empty and error states. Change [reloadToken] to reload from the
/// first page (e.g. after a mutation).
class PagedListView<T> extends StatefulWidget {
  const PagedListView({
    super.key,
    required this.fetch,
    required this.itemBuilder,
    required this.empty,
    this.header,
    this.padding = const EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s4, JkSpacing.s5, JkSpacing.s8),
    this.spacing = JkSpacing.s3,
    this.reloadToken,
  });

  final Future<Paged<T>> Function(String? cursor) fetch;
  final Widget Function(BuildContext context, T item) itemBuilder;
  final Widget empty;
  final Widget? header;
  final EdgeInsets padding;
  final double spacing;
  final Object? reloadToken;

  @override
  State<PagedListView<T>> createState() => _PagedListViewState<T>();
}

class _PagedListViewState<T> extends State<PagedListView<T>> {
  final List<T> _items = <T>[];
  String? _cursor;
  bool _hasMore = true;
  bool _loading = true;
  bool _loadingMore = false;
  Object? _error;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  @override
  void didUpdateWidget(covariant PagedListView<T> oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.reloadToken != widget.reloadToken) _reload();
  }

  Future<void> _reload() async {
    final generation = ++_generation;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await widget.fetch(null);
      if (!mounted || generation != _generation) return;
      setState(() {
        _items
          ..clear()
          ..addAll(page.items);
        _cursor = page.nextCursor;
        _hasMore = page.hasMore;
        _loading = false;
      });
    } on Object catch (e) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _error = e;
        _loading = false;
      });
    }
  }

  Future<void> _loadMore() async {
    if (_loadingMore || !_hasMore || _loading) return;
    final generation = _generation;
    setState(() => _loadingMore = true);
    try {
      final page = await widget.fetch(_cursor);
      if (!mounted || generation != _generation) return;
      setState(() {
        _items.addAll(page.items);
        _cursor = page.nextCursor;
        _hasMore = page.hasMore;
        _loadingMore = false;
      });
    } on Object catch (e) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _error = e;
        _loadingMore = false;
      });
    }
  }

  bool _onScroll(ScrollNotification notification) {
    if (notification.metrics.extentAfter < 400) _loadMore();
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final header = widget.header;
    final error = _error;
    final children = <Widget>[];
    if (header != null) children.add(header);
    if (_loading && _items.isEmpty) {
      for (var i = 0; i < 4; i++) {
        children.add(const Skeleton(height: 96, radius: JkRadii.lg));
      }
    } else if (error != null && _items.isEmpty) {
      children.add(ErrorView(error: error, onRetry: _reload));
    } else if (_items.isEmpty) {
      children.add(widget.empty);
    } else {
      for (final item in _items) {
        children.add(widget.itemBuilder(context, item));
      }
      if (_loadingMore) {
        children.add(const Center(child: Padding(padding: EdgeInsets.all(JkSpacing.s4), child: CircularProgressIndicator())));
      } else if (error != null) {
        children.add(ErrorView(error: error, onRetry: _loadMore, compact: true));
      }
    }
    return NotificationListener<ScrollNotification>(
      onNotification: _onScroll,
      child: JkRefresh(
        onRefresh: _reload,
        child: ListView.separated(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: widget.padding.copyWith(bottom: widget.padding.bottom + MediaQuery.paddingOf(context).bottom),
          itemCount: children.length,
          separatorBuilder: (BuildContext context, int index) => SizedBox(height: widget.spacing),
          itemBuilder: (BuildContext context, int index) => children[index],
        ),
      ),
    );
  }
}
