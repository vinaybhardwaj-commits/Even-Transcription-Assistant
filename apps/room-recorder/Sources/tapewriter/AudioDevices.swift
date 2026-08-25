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
    return try info(id: id)
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
