import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/config/app_config.dart';
import '../core/network/api_client.dart';

/// Every file URL the API returns is absolute: either a presigned storage URL (no credentials
/// needed) or `${API_BASE_URL}/v1/files/{id}/content`, which the API serves itself and which
/// needs the bearer token. The URL is used as-is — never prefixed with a base URL.
bool isApiHostedUrl(String url) {
  final target = Uri.tryParse(url);
  final api = Uri.tryParse(AppConfig.apiBaseUrl);
  if (target == null || api == null || !target.hasScheme) return false;
  return target.host == api.host && target.port == api.port;
}

/// Request headers for loading [url] (bearer only for API-hosted files).
Map<String, String>? apiFileHeaders(WidgetRef ref, String url) {
  if (!isApiHostedUrl(url)) return null;
  final token = ref.read(tokenStoreProvider).current?.accessToken;
  return token == null || token.isEmpty ? null : <String, String>{'Authorization': 'Bearer $token'};
}

/// Network image for API file URLs (product photos, receipts, chat photos, avatars).
class ApiImage extends ConsumerWidget {
  const ApiImage(this.url, {super.key, this.width, this.height, this.fit = BoxFit.cover, this.fallback});

  final String url;
  final double? width;
  final double? height;
  final BoxFit fit;

  /// Shown while loading and when the image cannot be loaded.
  final Widget? fallback;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final resolved = AppConfig.rewriteLoopbackUrl(url);
    final placeholder = fallback ?? SizedBox(width: width, height: height);
    return CachedNetworkImage(
      imageUrl: resolved,
      // Presigned URLs carry a fresh signature on every response; cache by path.
      cacheKey: resolved.split('?').first,
      httpHeaders: apiFileHeaders(ref, resolved),
      width: width,
      height: height,
      fit: fit,
      placeholder: (context, url) => placeholder,
      errorWidget: (context, url, error) => placeholder,
    );
  }
}

/// Full-screen zoomable view of an API file image (receipt, product or chat photo).
Future<void> showApiImageDialog(BuildContext context, String url) => showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => Dialog(
        clipBehavior: Clip.antiAlias,
        child: InteractiveViewer(
          child: ApiImage(url, fit: BoxFit.contain, fallback: const SizedBox(height: 240, child: Center(child: Icon(Icons.broken_image_outlined)))),
        ),
      ),
    );
