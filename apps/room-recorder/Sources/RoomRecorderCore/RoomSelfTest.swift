import AVFoundation
import CoreAudio
import CryptoKit
import Foundation

/// 0.1.25 item 6 — the acoustic SELF-TEST. A bench command `self_test` plays a fixed, pinned
/// stimulus pack through the Mac's BUILT-IN speaker at a fixed, logged volume and records it
/// through the room's configured mic into a SEPARATE self-test segment (never a patient session).
/// The lab scores the recording; nothing here judges it.
///
/// The pieces are separated so the rules are testable without a speaker: the pack loader and its
/// hash pinning, the gate, the manifest, and a runner over an injected player and capture launcher.

// MARK: - The pack

public struct SelfTestStimulus: Equatable, Sendable {
  public let id: String
  public let kind: String
  public let file: URL
  public let sha256: String
  public let durationS: Double?
  public let lang: String?
  public let truth: String?
}

public enum SelfTestPackError: Error, Equatable {
  case missingPack
  case unreadablePack
  case unknownPackVersion(Int)
  case emptyPack
  case badEntry(String)
  case hashMismatch(String)
}

public enum SelfTestPack {
  public static let supportedVersion = 1
  /// Kinds the scorer knows. Anything else refuses the whole pack: a stimulus nobody scores is
  /// noise played into a room.
  public static let kinds: Set<String> = ["tone", "sweep", "canary", "phrase"]

  /// Load `pack.json` from `directory` and VERIFY every file's sha256 before returning. Nothing is
  /// played from a pack that fails any check.
  public static func load(directory: URL) throws -> [SelfTestStimulus] {
    let manifestURL = directory.appendingPathComponent("pack.json")
    guard FileManager.default.fileExists(atPath: manifestURL.path) else {
      throw SelfTestPackError.missingPack
    }
    guard let data = try? Data(contentsOf: manifestURL),
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { throw SelfTestPackError.unreadablePack }
    let version = root["pack_version"] as? Int ?? -1
    guard version == supportedVersion else { throw SelfTestPackError.unknownPackVersion(version) }
    guard let entries = root["stimuli"] as? [[String: Any]], !entries.isEmpty else {
      throw SelfTestPackError.emptyPack
    }
    var out: [SelfTestStimulus] = []
    var seen = Set<String>()
    for entry in entries {
      guard let id = entry["id"] as? String, !id.isEmpty, seen.insert(id).inserted,
        let kind = entry["kind"] as? String, kinds.contains(kind),
        let name = entry["file"] as? String, !name.isEmpty, !name.contains("/"),
        !name.contains(".."), let sha = (entry["sha256"] as? String)?.lowercased(),
        sha.count == 64, sha.allSatisfy({ $0.isHexDigit })
      else { throw SelfTestPackError.badEntry(entry["id"] as? String ?? "?") }
      let file = directory.appendingPathComponent(name)
      guard let bytes = try? Data(contentsOf: file) else { throw SelfTestPackError.hashMismatch(id) }
      let actual = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
      guard actual == sha else { throw SelfTestPackError.hashMismatch(id) }
      out.append(
        SelfTestStimulus(
          id: id, kind: kind, file: file, sha256: sha,
          durationS: (entry["duration_s"] as? NSNumber)?.doubleValue,
          lang: entry["lang"] as? String, truth: entry["truth"] as? String))
    }
    return out
  }

  /// sha256 of `pack.json` itself, for the manifest.
  public static func packHash(directory: URL) -> String? {
    guard let data = try? Data(contentsOf: directory.appendingPathComponent("pack.json")) else {
      return nil
    }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}

// MARK: - The gate

public enum SelfTestGate {
  /// Why a self-test may NOT run now, or nil when it may.
  ///
  /// A session open always refuses (a patient may be in the room). Inside the room's clinic window
  /// refuses too, EXCEPT for the Home Office test kiosk, which V made a test room at any hour
  /// (26/27 Sep). Nothing else is ever an exception.
  public static func refusal(
    sessionOpen: Bool, alreadyRunning: Bool, ready: Bool = true, now: Date, schedule: RoomSchedule,
    roomSlug: String
  ) -> String? {
    if sessionOpen { return "session_open" }
    if alreadyRunning { return "self_test_running" }
    // `ready` = phase .ready, no capture, no reconciliation pending. A `.failed` room can still hold
    // a session that the next loop re-adopts (eta-refuter B2): never test over it.
    if !ready { return "not_ready" }
    if schedule.activeWindow(at: now) != nil && !isTestRoom(roomSlug) { return "clinic_hours" }
    return nil
  }

  public static func isTestRoom(_ slug: String) -> Bool { slug.lowercased().hasPrefix("home-office") }
}

// MARK: - The manifest

public struct SelfTestManifest: Codable, Equatable, Sendable {
  public struct Played: Codable, Equatable, Sendable {
    public var id: String
    public var kind: String
    public var sha256: String
    public var startWallNS: UInt64
    public var endWallNS: UInt64
    public var lang: String?
    public var truth: String?
    enum CodingKeys: String, CodingKey {
      case id, kind, sha256, lang, truth
      case startWallNS = "start_wall_ns"
      case endWallNS = "end_wall_ns"
    }
  }
  public var runID: String
  public var appVersion: String?
  public var roomSlug: String
  public var micDeviceUID: String
  public var speakerDeviceUID: String?
  public var speakerVolume: Double
  public var previousSpeakerVolume: Double?
  public var packSHA256: String?
  public var captureStartWallNS: UInt64
  public var captureEndWallNS: UInt64
  public var stimuli: [Played]
  public var pcmBytes: UInt64
  public var outcome: String

  enum CodingKeys: String, CodingKey {
    case runID = "run_id"
    case appVersion = "app_version"
    case roomSlug = "room_slug"
    case micDeviceUID = "mic_device_uid"
    case speakerDeviceUID = "speaker_device_uid"
    case speakerVolume = "speaker_volume"
    case previousSpeakerVolume = "previous_speaker_volume"
    case packSHA256 = "pack_sha256"
    case captureStartWallNS = "capture_start_wall_ns"
    case captureEndWallNS = "capture_end_wall_ns"
    case stimuli
    case pcmBytes = "pcm_bytes"
    case outcome
  }
}

// MARK: - The speaker

public struct SelfTestSpeakerState: Equatable, Sendable {
  public var deviceUID: String?
  public var previousVolume: Double?
}

public protocol SelfTestPlaying: Sendable {
  /// Route to the built-in speaker and set its output volume. Returns what it changed.
  func prepare(volume: Double) throws -> SelfTestSpeakerState
  /// Play one file to the end.
  func play(file: URL) async throws
  /// Put the output volume back.
  func restore(_ state: SelfTestSpeakerState)
}

public enum SelfTestError: Error, Equatable {
  case noBuiltInSpeaker
  case volumeNotSettable
  case captureDidNotStart
  case timedOut
}

/// The real speaker: the built-in output device, chosen by CoreAudio transport type, volume set as
/// the device's output scalar and restored afterwards, played with `AVAudioPlayer` pinned to that
/// device. Hardware-bound: exercised by the opt-in probe, not by the unit tests.
public struct BuiltInSpeakerPlayer: SelfTestPlaying {
  public init() {}

  private static func builtInOutput() -> (id: AudioDeviceID, uid: String)? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard
      AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
        == noErr
    else { return nil }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard
      AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids)
        == noErr
    else { return nil }
    for id in ids {
      var transport: UInt32 = 0
      var tsize = UInt32(MemoryLayout<UInt32>.size)
      var taddr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
      guard AudioObjectGetPropertyData(id, &taddr, 0, nil, &tsize, &transport) == noErr,
        transport == kAudioDeviceTransportTypeBuiltIn
      else { continue }
      var saddr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain)
      var ssize: UInt32 = 0
      guard AudioObjectGetPropertyDataSize(id, &saddr, 0, nil, &ssize) == noErr, ssize > 0 else {
        continue
      }
      var uidRef: Unmanaged<CFString>?
      var usize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
      var uaddr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
      guard AudioObjectGetPropertyData(id, &uaddr, 0, nil, &usize, &uidRef) == noErr,
        let uid = uidRef?.takeRetainedValue() as String?
      else { continue }
      return (id, uid)
    }
    return nil
  }

  private static var volumeAddress: AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyVolumeScalar, mScope: kAudioObjectPropertyScopeOutput,
      mElement: kAudioObjectPropertyElementMain)
  }

  private static func volume(of id: AudioDeviceID) -> Double? {
    var address = volumeAddress
    var value: Float32 = 0
    var size = UInt32(MemoryLayout<Float32>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return nil }
    return Double(value)
  }

  private static func setVolume(_ value: Double, of id: AudioDeviceID) -> Bool {
    var address = volumeAddress
    var settable: DarwinBoolean = false
    guard AudioObjectIsPropertySettable(id, &address, &settable) == noErr, settable.boolValue else {
      return false
    }
    var v = Float32(min(max(value, 0), 1))
    return AudioObjectSetPropertyData(id, &address, 0, nil, UInt32(MemoryLayout<Float32>.size), &v)
      == noErr
  }

  public func prepare(volume: Double) throws -> SelfTestSpeakerState {
    guard let device = Self.builtInOutput() else { throw SelfTestError.noBuiltInSpeaker }
    let previous = Self.volume(of: device.id)
    guard Self.setVolume(volume, of: device.id) else { throw SelfTestError.volumeNotSettable }
    return SelfTestSpeakerState(deviceUID: device.uid, previousVolume: previous)
  }

  public func play(file: URL) async throws {
    guard let device = Self.builtInOutput() else { throw SelfTestError.noBuiltInSpeaker }
    let player = try AVAudioPlayer(contentsOf: file)
    player.currentDevice = device.uid
    player.volume = 1.0  // the OUTPUT device volume is the fixed, logged one
    guard player.prepareToPlay(), player.play() else { throw SelfTestError.noBuiltInSpeaker }
    defer { player.stop() }  // also on cancellation (the run's deadline)
    while player.isPlaying { try await Task.sleep(nanoseconds: 50_000_000) }
  }

  public func restore(_ state: SelfTestSpeakerState) {
    guard let previous = state.previousVolume, let device = Self.builtInOutput() else { return }
    _ = Self.setVolume(previous, of: device.id)
  }
}

// MARK: - The runner

/// What has been played so far. Kept outside the run's task group so a failure or a deadline still
/// reports every stimulus that DID finish.
final class SelfTestPlayLog: @unchecked Sendable {
  private let lock = NSLock()
  private var played: [SelfTestManifest.Played] = []
  func append(_ item: SelfTestManifest.Played) { lock.withLock { played.append(item) } }
  var items: [SelfTestManifest.Played] { lock.withLock { played } }
}

public struct SelfTestRunner: Sendable {
  public let pack: [SelfTestStimulus]
  public let packSHA256: String?
  public let player: any SelfTestPlaying
  public let launcher: any RoomCaptureLaunching
  public let tapewriter: URL
  public let micDeviceUID: String
  public let roomSlug: String
  public let appVersion: String?
  public let volume: Double
  /// Silence before the first and after the last stimulus, and between two.
  public let leadSeconds: Double
  public let gapSeconds: Double
  public let log: @Sendable (String) -> Void
  /// Hard cap on a whole run (eta-refuter B3). A hung speaker or capture can never hold the room.
  public let maxSeconds: Double

  public init(
    pack: [SelfTestStimulus], packSHA256: String?, player: any SelfTestPlaying,
    launcher: any RoomCaptureLaunching, tapewriter: URL, micDeviceUID: String, roomSlug: String,
    appVersion: String?, volume: Double = 0.5, leadSeconds: Double = 1.5,
    gapSeconds: Double = 0.5, maxSeconds: Double = 180,
    log: @escaping @Sendable (String) -> Void
  ) {
    self.maxSeconds = maxSeconds
    self.pack = pack
    self.packSHA256 = packSHA256
    self.player = player
    self.launcher = launcher
    self.tapewriter = tapewriter
    self.micDeviceUID = micDeviceUID
    self.roomSlug = roomSlug
    self.appVersion = appVersion
    self.volume = volume
    self.leadSeconds = leadSeconds
    self.gapSeconds = gapSeconds
    self.log = log
  }

  static func wallNS() -> UInt64 {
    UInt64((Date().timeIntervalSince1970 * 1_000_000_000).rounded())
  }

  /// Run once into `directory` (created by the caller, private). Always stops the capture and
  /// restores the speaker volume, whatever fails. The manifest is written whatever happens, with
  /// its `outcome` saying what did.
  public func run(runID: String, directory: URL) async -> SelfTestManifest {
    var manifest = SelfTestManifest(
      runID: runID, appVersion: appVersion, roomSlug: roomSlug, micDeviceUID: micDeviceUID,
      speakerDeviceUID: nil, speakerVolume: volume, previousSpeakerVolume: nil,
      packSHA256: packSHA256, captureStartWallNS: 0, captureEndWallNS: 0, stimuli: [],
      pcmBytes: 0, outcome: "started")
    let pcm = directory.appendingPathComponent("tape.pcm")
    let playLog = SelfTestPlayLog()
    var speaker: SelfTestSpeakerState?
    var process: (any RoomCaptureProcess)?
    do {
      let state = try player.prepare(volume: volume)
      speaker = state
      manifest.speakerDeviceUID = state.deviceUID
      manifest.previousSpeakerVolume = state.previousVolume
      log("self-test \(runID): speaker \(state.deviceUID ?? "?") volume \(volume) (was \(state.previousVolume.map { String($0) } ?? "?"))")
      let launched = try launcher.launch(
        executable: tapewriter, outputDirectory: directory, deviceUID: micDeviceUID,
        logURL: directory.appendingPathComponent("tapewriter.log"))
      process = launched
      manifest.captureStartWallNS = Self.wallNS()
      guard await Self.waitForGrowth(pcm, seconds: 10) else { throw SelfTestError.captureDidNotStart }
      try await withThrowingTaskGroup(of: Bool.self) { group in
        group.addTask {
          try await self.playAll(into: playLog)
          return true
        }
        group.addTask {
          try await Task.sleep(nanoseconds: UInt64(self.maxSeconds * 1e9))
          return false  // the deadline: whichever finishes first wins
        }
        let finished = try await group.next() ?? false
        group.cancelAll()
        if !finished { throw SelfTestError.timedOut }
      }
      manifest.outcome = "complete"
    } catch {
      manifest.outcome = "failed: \(String(describing: error).prefix(120))"
    }
    manifest.stimuli = playLog.items
    if let process {
      process.interrupt()
      // Bounded: a capture that will not exit is logged and left, never waited on for ever.
      let deadline = Date().addingTimeInterval(5)
      while process.isRunning && Date() < deadline { try? await Task.sleep(nanoseconds: 50_000_000) }
      if process.isRunning { log("self-test \(runID): capture did not exit within 5 s") }
    }
    manifest.captureEndWallNS = Self.wallNS()
    if let speaker { player.restore(speaker) }
    manifest.pcmBytes =
      ((try? FileManager.default.attributesOfItem(atPath: pcm.path))?[.size] as? NSNumber)?.uint64Value ?? 0
    if let data = try? JSONEncoder.sortedPretty.encode(manifest) {
      try? data.write(to: directory.appendingPathComponent("manifest.json"), options: .atomic)
    }
    log("self-test \(runID): \(manifest.outcome); \(manifest.stimuli.count)/\(pack.count) played, \(manifest.pcmBytes) bytes")
    return manifest
  }

  private func playAll(into log: SelfTestPlayLog) async throws {
    try await Task.sleep(nanoseconds: UInt64(leadSeconds * 1e9))
    for stimulus in pack {
      let start = Self.wallNS()
      try await player.play(file: stimulus.file)
      let end = Self.wallNS()
      log.append(
        .init(
          id: stimulus.id, kind: stimulus.kind, sha256: stimulus.sha256, startWallNS: start,
          endWallNS: end, lang: stimulus.lang, truth: stimulus.truth))
      try await Task.sleep(nanoseconds: UInt64(gapSeconds * 1e9))
    }
    try await Task.sleep(nanoseconds: UInt64(leadSeconds * 1e9))
  }

  private static func waitForGrowth(_ url: URL, seconds: Double) async -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
      let size = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.uint64Value ?? 0
      if size > 0 { return true }
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    return false
  }
}

extension JSONEncoder {
  fileprivate static var sortedPretty: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
    return encoder
  }
}
