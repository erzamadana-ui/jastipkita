import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/config/app_config.dart';
import '../../../core/models/json.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_exception.dart';

/// Bytes picked on-device, ready for `POST /files/uploads`.
class PickedUpload {
  const PickedUpload({required this.bytes, required this.name, required this.contentType});

  final Uint8List bytes;
  final String name;
  final String contentType;

  int get sizeBytes => bytes.length;
}

/// File purposes accepted by the API (`CreateUpload.purpose`).
abstract final class FilePurpose {
  static const String kyc = 'KYC';
  static const String receipt = 'RECEIPT';
  static const String productPhoto = 'PRODUCT_PHOTO';
  static const String tripDoc = 'TRIP_DOC';
  static const String evidence = 'EVIDENCE';
  static const String avatar = 'AVATAR';
  static const String chat = 'CHAT';
  static const String deliveryProof = 'DELIVERY_PROOF';
}

String contentTypeForName(String name, {String fallback = 'image/jpeg'}) {
  final lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.heic') || lower.endsWith('.heif')) return 'image/heic';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return fallback;
}

/// Picks images / documents (no `dart:io`, so the same code runs on web).
class MediaPicker {
  MediaPicker([ImagePicker? picker]) : _picker = picker ?? ImagePicker();

  final ImagePicker _picker;

  /// Photo from camera or gallery, re-encoded as JPEG (quality 85, max 2048px).
  Future<PickedUpload?> image({required bool camera, bool frontCamera = false}) async {
    final file = await _picker.pickImage(
      source: camera ? ImageSource.camera : ImageSource.gallery,
      preferredCameraDevice: frontCamera ? CameraDevice.front : CameraDevice.rear,
      imageQuality: 85,
      maxWidth: 2048,
      maxHeight: 2048,
    );
    if (file == null) return null;
    final bytes = await file.readAsBytes();
    return PickedUpload(bytes: bytes, name: file.name, contentType: file.mimeType ?? contentTypeForName(file.name));
  }

  Future<PickedUpload?> video() async {
    final file = await _picker.pickVideo(source: ImageSource.camera, maxDuration: const Duration(seconds: 60));
    if (file == null) return null;
    final bytes = await file.readAsBytes();
    return PickedUpload(bytes: bytes, name: file.name, contentType: 'video/mp4');
  }

  /// PDF or image (e-ticket, itinerary, receipt).
  Future<PickedUpload?> document() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: const <String>['pdf', 'jpg', 'jpeg', 'png', 'webp'],
      withData: true,
    );
    if (result == null || result.files.isEmpty) return null;
    final file = result.files.first;
    final bytes = file.bytes;
    if (bytes == null) return null;
    return PickedUpload(bytes: bytes, name: file.name, contentType: contentTypeForName(file.name, fallback: 'application/pdf'));
  }
}

/// Direct-to-storage upload: `POST /files/uploads` → PUT presigned URL → `POST /files/{id}/complete`
/// (magic bytes, SHA-256, malware scan, encryption for KYC/TRIP_DOC). Returns the READY file id.
class FileUploadService {
  FileUploadService(this._api);

  final ApiClient _api;

  Future<String> upload(PickedUpload file, {required String purpose}) async {
    final digest = sha256.convert(file.bytes).toString();
    final ticket = await _api.post(
      '/files/uploads',
      body: <String, dynamic>{
        'purpose': purpose,
        'contentType': file.contentType,
        'sizeBytes': file.sizeBytes,
        'sha256': digest,
      },
    );
    final fileId = readString(ticket, 'fileId');
    final upload = readObject(ticket, 'upload');
    final headers = <String, String>{
      for (final entry in readObject(upload, 'headers').entries) entry.key: entry.value.toString(),
    };
    await _api.uploadBytes(readString(upload, 'url'), file.bytes, contentType: file.contentType, headers: headers);
    final completed = await _api.post('/files/$fileId/complete');
    final status = readString(completed, 'status');
    if (status != 'READY') {
      throw ApiException(code: 'FILE_$status', message: '', details: completed);
    }
    return fileId;
  }

  /// Displayable URL of a plain (non-encrypted) image — chat photos, product photos.
  Future<String> imageUrl(String fileId) async {
    final json = await _api.get('/files/$fileId/url');
    return AppConfig.rewriteLoopbackUrl(readString(json, 'url'));
  }

  /// Downloads a text file (e.g. the UU PDP data export). The URL is always absolute: encrypted
  /// files are streamed and decrypted by the API (`requiresAuth` → bearer attached), plain ones
  /// come from a presigned URL.
  Future<String> downloadText(String fileId) async {
    final json = await _api.get('/files/$fileId/url');
    final url = readString(json, 'url');
    if (readBool(json, 'requiresAuth')) return _api.getText(url);
    return _api.getExternalText(url);
  }
}

final mediaPickerProvider = Provider<MediaPicker>((ref) => MediaPicker());

final fileUploadServiceProvider = Provider<FileUploadService>((ref) => FileUploadService(ref.watch(apiClientProvider)));
