import Foundation
import TapeCapture

/// Arch #22 — which input a room records from, and WHICH RULE said so. Policy text: `docs/capture-input-selection-policy.md`.
///
/// ─── ALERT-ONLY. THIS TYPE NEVER CHANGES THE DEVICE. ──────────────────────────────────────
/// The rule that picks the device at start_day is `configured`: the uid in the room's config.json, which is what `tapewriter record --device` is given.
/// Everything else here is information for the log line and the alert. A configured device that is not attached yields `configured_missing` with a
/// CANDIDATE (the OS default input if it is another device, else the first other attached input) and the recorder still records from the configured
/// uid. Switching is a person's `set_audio_input`, until a policy that allows more is written and ruled on.
public enum InputSelectionRule: String, Equatable, Sendable {
  /// The configured device is attached. It is the device.
  case configured
  /// The configured device is not in the attached list. Still the device; a candidate may be named.
  case configuredMissing = "configured_missing"
  /// CoreAudio could not be asked for the attached list, so attachment is not known.
  case configuredUnverified = "configured_unverified"
}

public struct InputSelectionDecision: Equatable, Sendable {
  public let rule: InputSelectionRule
  /// The uid the recorder records from. Always the configured one.
  public let selectedUID: String
  /// Another attached input worth looking at, or nil.
  public let candidateUID: String?

  /// The one line the start_day path writes. Device uids only; no patient or doctor identity is anywhere in it.
  public var logLine: String {
    "input selection rule=\(rule.rawValue) selected_uid=\(selectedUID) candidate_uid=\(candidateUID ?? "none") auto_switch=false"
  }
}

public enum InputSelectionPolicy {
  public static func decide(
    configuredUID: String,
    attached: [AudioInputDeviceEntry]?
  ) -> InputSelectionDecision {
    guard let attached else {
      return InputSelectionDecision(rule: .configuredUnverified, selectedUID: configuredUID, candidateUID: nil)
    }
    let others = attached.filter { $0.uid != configuredUID }
    let candidate = (others.first { $0.isDefault } ?? others.first)?.uid
    if attached.contains(where: { $0.uid == configuredUID }) {
      return InputSelectionDecision(rule: .configured, selectedUID: configuredUID, candidateUID: candidate)
    }
    return InputSelectionDecision(rule: .configuredMissing, selectedUID: configuredUID, candidateUID: candidate)
  }
}
