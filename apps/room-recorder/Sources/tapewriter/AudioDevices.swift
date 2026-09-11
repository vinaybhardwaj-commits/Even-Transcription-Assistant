import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

struct AudioDeviceInfo {
  let id: AudioDeviceID
  let uid: String
  let name: String
}

enum AudioDevices {
  static func selected(uid: String?) throws -> AudioDeviceInfo {
    if let uid {
      guard let match = try all().first(where: { $0.uid == uid }) else {
        throw RecorderError("input device not found: \(uid)")
      }
      return match
    }
    return try info(id: defaultInputID())
  }

  static func isDefaultInput(_ device: AudioDeviceInfo) -> Bool {
    (try? defaultInputID()) == device.id
  }

  static func isAlive(_ device: AudioDeviceInfo) -> Bool {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyDeviceIsAlive,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var alive: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(device.id, &address, 0, nil, &size, &alive) == noErr
      && alive != 0
  }

  static func presence(uid: String) -> Bool? {
    guard let devices = try? all() else { return nil }
    return devices.contains { $0.uid == uid }
  }

  fileprivate static func all() throws -> [AudioDeviceInfo] {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDevices,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var byteCount: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(
      AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &byteCount)
    guard status == noErr else {
      throw RecorderError("cannot enumerate audio devices (OSStatus \(status))")
    }
    var ids = [AudioDeviceID](
      repeating: 0, count: Int(byteCount) / MemoryLayout<AudioDeviceID>.size)
    status = AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &byteCount, &ids)
    guard status == noErr else {
      throw RecorderError("cannot enumerate audio devices (OSStatus \(status))")
    }
    return try ids.compactMap { id in
      let streams = try inputStreamCount(id: id)
      return streams > 0 ? try info(id: id) : nil
    }
  }

  fileprivate static func defaultInputID() throws -> AudioDeviceID {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDefaultInputDevice,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let status = AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id)
    guard status == noErr, id != kAudioObjectUnknown else {
      throw RecorderError("no default input device is available")
    }
    return id
  }

  private static func info(id: AudioDeviceID) throws -> AudioDeviceInfo {
    AudioDeviceInfo(
      id: id,
      uid: try stringProperty(id: id, selector: kAudioDevicePropertyDeviceUID),
      name: try stringProperty(id: id, selector: kAudioObjectPropertyName)
    )
  }

  private static func inputStreamCount(id: AudioDeviceID) throws -> Int {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreams,
      mScope: kAudioDevicePropertyScopeInput,
      mElement: kAudioObjectPropertyElementMain
    )
    var byteCount: UInt32 = 0
    let status = AudioObjectGetPropertyDataSize(id, &address, 0, nil, &byteCount)
    guard status == noErr else { return 0 }
    return Int(byteCount) / MemoryLayout<AudioStreamID>.size
  }

  private static func stringProperty(id: AudioDeviceID, selector: AudioObjectPropertySelector)
    throws -> String
  {
    var address = AudioObjectPropertyAddress(
      mSelector: selector,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value)
    guard status == noErr, let value else {
      throw RecorderError("cannot read audio device property (OSStatus \(status))")
    }
    return value.takeUnretainedValue() as String
  }
}

// MARK: - Input volume (Release R4, D4)
//
// `kAudioDevicePropertyVolumeScalar` on the INPUT scope — never the output scope, never global —
// at the master element, or channel 1 when the device has no master. No `osascript`. A device with
// neither element has no input volume macOS can reach, which is a measured "not settable" (the
// TM20 has a physical gain knob, and the 9 Sep flag was that macOS may not expose it).

extension AudioDevices {
  static func inputVolumeAddress(element: AudioObjectPropertyElement)
    -> AudioObjectPropertyAddress
  {
    AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyVolumeScalar,
      mScope: kAudioDevicePropertyScopeInput,
      mElement: element
    )
  }

  /// The element the input volume lives on: master, else channel 1, else nil.
  static func inputVolumeElement(id: AudioDeviceID) -> AudioObjectPropertyElement? {
    for element: AudioObjectPropertyElement in [kAudioObjectPropertyElementMain, 1] {
      var address = inputVolumeAddress(element: element)
      if AudioObjectHasProperty(id, &address) { return element }
    }
    return nil
  }

  /// 0–1, or nil for a value that is not a number. Nothing outside 0–1 is ever written.
  static func clampedVolume(_ value: Float) -> Float? {
    guard value.isFinite else { return nil }
    return min(max(value, 0), 1)
  }

  /// Nil when the device is not present or CoreAudio would not say whether the volume is
  /// settable. `value` nil with `settable` false: the device is present and has no input volume.
  static func inputVolume(uid: String) -> (value: Float?, settable: Bool)? {
    guard let device = try? selected(uid: uid) else { return nil }
    guard let element = inputVolumeElement(id: device.id) else { return (nil, false) }
    var address = inputVolumeAddress(element: element)
    var settable: DarwinBoolean = false
    guard AudioObjectIsPropertySettable(device.id, &address, &settable) == noErr else {
      return nil
    }
    var scalar: Float32 = 0
    var size = UInt32(MemoryLayout<Float32>.size)
    let status = AudioObjectGetPropertyData(device.id, &address, 0, nil, &size, &scalar)
    let value: Float? =
      status == noErr && scalar.isFinite && (0...1).contains(scalar) ? scalar : nil
    return (value, settable.boolValue)
  }

  static func setInputVolume(uid: String, value: Float) throws {
    guard let clamped = clampedVolume(value) else {
      throw RecorderError("input volume is not a finite number")
    }
    let device = try selected(uid: uid)
    guard let element = inputVolumeElement(id: device.id) else {
      throw RecorderError("input device has no input volume control: \(uid)")
    }
    var address = inputVolumeAddress(element: element)
    var settable: DarwinBoolean = false
    guard AudioObjectIsPropertySettable(device.id, &address, &settable) == noErr,
      settable.boolValue
    else {
      throw RecorderError("input volume is not settable: \(uid)")
    }
    var scalar = Float32(clamped)
    let status = AudioObjectSetPropertyData(
      device.id, &address, 0, nil, UInt32(MemoryLayout<Float32>.size), &scalar)
    guard status == noErr else {
      throw RecorderError("cannot set input volume on \(uid) (OSStatus \(status))")
    }
  }
}

func selectDevice(_ device: AudioDeviceInfo, on engine: AVAudioEngine) throws {
  guard let audioUnit = engine.inputNode.audioUnit else {
    throw RecorderError("audio input unit is unavailable")
  }
  var id = device.id
  let status = AudioUnitSetProperty(
    audioUnit,
    kAudioOutputUnitProperty_CurrentDevice,
    kAudioUnitScope_Global,
    0,
    &id,
    UInt32(MemoryLayout<AudioDeviceID>.size)
  )
  guard status == noErr else {
    throw RecorderError("cannot select input device \(device.uid) (OSStatus \(status))")
  }
}

// MARK: - Public façade for the resident app (Install and Fleet PRD §5.5)
//
// The app needs three facts about audio input that only CoreAudio can answer: which device the
// machine currently defaults to (read once, at enrol), what a device UID is called right now
// (read on every poll), and — Release B2, D10 — every input attached now (also every poll).
// Everything above stays internal to the capture target; only these readings cross the module
// boundary, and none of them selects a device.
//
// BOTH MEASURE, NEITHER DEFAULTS. Nil means "the machine did not answer", which the poll sends as
// absence so the server's COALESCE keeps the last true value. §5.5's invariant, same as the rest.

/// One audio input device, as the machine reports it at the moment of the call.
public struct AudioInputDevice: Equatable, Sendable {
  public let uid: String
  public let name: String

  public init(uid: String, name: String) {
    self.uid = uid
    self.name = name
  }
}

public enum AudioInputDevices {
  /// The machine's CURRENT default audio input. Nil when it has no input device at all.
  ///
  /// V's ruling, 8 Sep: enrol takes this and stores its UID. There is no `--device` argument, no
  /// prompt, and no refusal when several inputs exist — whichever one System Settings points at
  /// is the answer, and an operator changes it there like on any other Mac.
  public static func systemDefault() -> AudioInputDevice? {
    guard let info = try? AudioDevices.selected(uid: nil) else { return nil }
    return AudioInputDevice(uid: info.uid, name: info.name)
  }

  /// The display name of the device with this UID, read now. Nil when it is not currently present
  /// — an unplugged USB mic is not a renamed one, and the poll must not claim otherwise.
  public static func name(forUID uid: String) -> String? {
    guard !uid.isEmpty, let info = try? AudioDevices.selected(uid: uid) else { return nil }
    return info.name
  }

  /// Release B2 (D10). Every input device attached right now, in CoreAudio's order, with the
  /// system default marked. Read-only: nothing here selects a device.
  ///
  /// Nil when the machine could not be asked, which the poll sends as absence. An empty array is
  /// a real answer — a Mac with no input attached — and is reported as one.
  public static func list() -> [AudioInputDeviceEntry]? {
    guard let devices = try? AudioDevices.all() else { return nil }
    let defaultID = try? AudioDevices.defaultInputID()
    return devices.map {
      AudioInputDeviceEntry(name: $0.name, uid: $0.uid, isDefault: $0.id == defaultID)
    }
  }
}

/// Release R4 (D4). A device's input volume, read now. `value` is nil when the device has no input
/// volume control at all; `settable` is what CoreAudio says about that control, false without one.
public struct AudioInputVolume: Equatable, Sendable {
  public let value: Double?
  public let settable: Bool

  public init(value: Double?, settable: Bool) {
    self.value = value
    self.settable = settable
  }
}

extension AudioInputDevices {
  /// Release R4 (D4). Nil when the device is not attached or CoreAudio would not answer — sent as
  /// absence, like every other reading here.
  public static func inputVolume(forUID uid: String) -> AudioInputVolume? {
    guard !uid.isEmpty, let reading = AudioDevices.inputVolume(uid: uid) else { return nil }
    return AudioInputVolume(value: reading.value.map(Double.init), settable: reading.settable)
  }

  /// Release R4 (D4). The ONE write in this façade, and it changes a device's input volume — it
  /// selects nothing. Clamped to 0–1; throws when the device is absent or the volume not settable.
  public static func setInputVolume(forUID uid: String, to value: Double) throws {
    try AudioDevices.setInputVolume(uid: uid, value: Float(value))
  }
}

/// One row of the input-device list the poll reports (Release B2, D10).
public struct AudioInputDeviceEntry: Equatable, Sendable {
  public let name: String
  public let uid: String
  public let isDefault: Bool

  public init(name: String, uid: String, isDefault: Bool) {
    self.name = name
    self.uid = uid
    self.isDefault = isDefault
  }
}
