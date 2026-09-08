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

  private static func all() throws -> [AudioDeviceInfo] {
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

  private static func defaultInputID() throws -> AudioDeviceID {
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
// The app needs two facts about audio input that only CoreAudio can answer: which device the
// machine currently defaults to (read once, at enrol) and what a device UID is called right now
// (read on every poll). Everything above stays internal to the capture target; only these two
// readings cross the module boundary.
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
}
