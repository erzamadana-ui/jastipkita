import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../files/data/file_upload_service.dart';

/// Pluggable liveness capture.
///
/// A certified active/passive liveness SDK (vendor TBD by compliance) implements this interface
/// and returns its evidence frames/session artefacts; the KYC flow does not change. The
/// built-in [PhotoSequenceLiveness] is a SANDBOX stand-in: two guided front-camera photos that a
/// reviewer can compare with the selfie. It is labelled "SANDBOX" in the UI and is NOT a
/// presentation-attack guarantee.
abstract class LivenessProvider {
  /// Stable identifier recorded with the submission (analytics / audit).
  String get id;

  /// True for non-certified implementations (shows the SANDBOX badge).
  bool get isSandbox;

  /// Number of guided captures; step texts come from l10n (`livenessStep1`, `livenessStep2`, …).
  int get stepCount;

  /// Captures one step; null when the user cancelled.
  Future<PickedUpload?> capture(int step);
}

class PhotoSequenceLiveness implements LivenessProvider {
  PhotoSequenceLiveness(this._picker);

  final MediaPicker _picker;

  @override
  String get id => 'photo-sequence-v1';

  @override
  bool get isSandbox => true;

  @override
  int get stepCount => 2;

  @override
  Future<PickedUpload?> capture(int step) => _picker.image(camera: true, frontCamera: true);
}

final livenessProvider = Provider<LivenessProvider>((ref) => PhotoSequenceLiveness(ref.watch(mediaPickerProvider)));
