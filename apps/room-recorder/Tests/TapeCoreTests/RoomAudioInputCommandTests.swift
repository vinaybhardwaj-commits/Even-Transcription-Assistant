import CoreAudio
import Foundation
import Testing

@testable import RoomRecorderCore
@testable import TapeCapture
@testable import TapeCore

/// Release R4 (D1, D3, D4) — `set_audio_input`: switch the recording device from the desk without
/// a relaunch and without ending the session, and read / set its input volume.
///
/// The engine runs the PLAIN capture path here, the one every clinic Mac runs: each segment is a
/// tapewriter process (`R4FakeTapewriter`, which writes real index lines) in its own `seg_`
/// directory. The device table is `R4AudioInputs`; nothing here touches CoreAudio except the
/// opt-in hardware probe at the bottom.
@Suite(.serialized) struct RoomAudioInputCommandTests {

  // -------------------------------------------------------------------------
  // The wire
  // -------------------------------------------------------------------------

  @Test func kindsRoundTripAndAnUnknownOneKeepsItsName() throws {
    #expect(BenchCommandKind(rawValue: "set_audio_input") == .setAudioInput)
    #expect(BenchCommandKind(rawValue: "frobnicate") == .unknown("frobnicate"))
    #expect(BenchCommandKind.unknown("frobnicate").rawValue == "frobnicate")
    for kind: BenchCommandKind in [.startDay, .pauseDay, .resumeDay, .endDay, .setAudioInput] {
      #expect(BenchCommandKind(rawValue: kind.rawValue) == kind)
      let encoded = try JSONEncoder().encode(kind)
      #expect(String(decoding: encoded, as: UTF8.self) == "\"\(kind.rawValue)\"")
    }
    let response = try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(
        #"{"ok":true,"commands":[{"id":"c1","kind":"set_audio_input","args":{"device_uid":"device-b","input_volume":1}},{"id":"c2","kind":"frobnicate","args":[1,2]}]}"#
          .utf8))
    #expect(response.commands.map(\.kind) == [.setAudioInput, .unknown("frobnicate")])
    #expect(
      response.commands.first?.args
        == .object(["device_uid": .string("device-b"), "input_volume": .number(1)]))
  }

  @Test func argsParseToARequestOrToBadArgs() {
    typealias Request = RoomEngine.AudioInputRequest
    #expect(
      Request.parse(.object(["device_uid": .string("device-b")]))
        == Request(deviceUID: "device-b", inputVolume: nil))
    #expect(
      Request.parse(.object(["input_volume": .number(0.5), "device_uid": .null]))
        == Request(deviceUID: nil, inputVolume: 0.5))
    // Clamped, never refused, and never written outside 0–1.
    #expect(Request.parse(.object(["input_volume": .number(1.7)]))?.inputVolume == 1)
    #expect(Request.parse(.object(["input_volume": .number(-0.2)]))?.inputVolume == 0)
    let bad: [JSONValue] = [
      .null, .array([]), .string("device-b"), .object([:]),
      .object(["device_uid": .null, "input_volume": .null]),
      .object(["device_uid": .string("")]),
      .object(["device_uid": .string(String(repeating: "x", count: 257))]),
      .object(["device_uid": .number(3)]),
      .object(["input_volume": .string("0.5")]),
      .object(["input_volume": .bool(true)]),
      .object(["device_uid": .string("device-b"), "input_volume": .string("loud")]),
    ]
    for args in bad { #expect(Request.parse(args) == nil, "\(args)") }
  }

  @Test func theAckCarriesTheAudioFieldsOnlyWhenThereAreSome() async throws {
    let client = try R4StubHTTP.client()
    var bodies: [[String: Any]] = []
    R4StubHTTP.handler = { request in
      let body = try R4StubHTTP.body(request)
      bodies.append(try #require(JSONSerialization.jsonObject(with: body) as? [String: Any]))
      let id = request.url!.pathComponents.dropLast().last!
      return R4StubHTTP.stub(request, body: "{\"ok\":true,\"id\":\"\(id)\",\"status\":\"acked\"}")
    }
    defer { R4StubHTTP.handler = nil }

    _ = try await client.acknowledge(
      commandID: "cmd_1", ok: true, sessionID: "bs_r4", error: nil,
      audioInput: AudioInputAcknowledgement(
        appliedDeviceUID: "device-b", appliedInputVolume: 0.5, inputVolumeSettable: true))
    _ = try await client.acknowledge(commandID: "cmd_2", ok: true, sessionID: "bs_r4")

    #expect(bodies.count == 2)
    #expect(bodies[0]["applied_device_uid"] as? String == "device-b")
    #expect(bodies[0]["applied_input_volume"] as? Double == 0.5)
    #expect(bodies[0]["input_volume_settable"] as? Bool == true)
    #expect(bodies[0]["session_id"] as? String == "bs_r4")
    #expect(Set(bodies[1].keys) == ["ok", "session_id"])
  }

  // -------------------------------------------------------------------------
  // The config write (D3)
  // -------------------------------------------------------------------------

  @Test func theConfigMethodMovesOnlyTheDeviceAndRefusesWhatCouldNotLoad() throws {
    var configuration = try R4Fixture.configuration()
    let before = configuration
    #expect(try configuration.applyAudioInputDevice("device-a") == false)
    #expect(configuration == before)
    #expect(try configuration.applyAudioInputDevice("device-b"))
    var expected = before
    expected.deviceUID = "device-b"
    #expect(configuration == expected)
    for invalid in ["", String(repeating: "x", count: 257)] {
      #expect(throws: RoomConfigurationError.invalidDeviceUID) {
        try configuration.applyAudioInputDevice(invalid)
      }
    }
    #expect(configuration == expected)
  }

  // -------------------------------------------------------------------------
  // The device switch (D3) — the kickoff's tests (a), (b), (c), and the rollback
  // -------------------------------------------------------------------------

  /// (a) Idle: config.json is rewritten — that key and no other, still 0600 — nothing is launched,
  /// and the next poll's `input_device_name` is the new device.
  @Test func anIdleSwitchRewritesConfigAndTheNextPollNamesTheNewDevice() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = R4Remote(
      activeSessionJSON: R4Fixture.idleActiveJSON,
      polls: [Self.setAudio("cmd_switch", #"{"device_uid":"device-b"}"#)])
    let launcher = R4FakeLauncher()
    let audio = R4AudioInputs.standard()
    let engine = try await Self.engine(root: root, remote: remote, launcher: launcher, audio: audio)

    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.reached(acks: 1, polls: 2) }
    task.cancel()
    try await task.value

    let ack = try #require(await remote.acknowledgements().first)
    #expect(ack.ok)
    #expect(ack.error == nil)
    #expect(ack.appliedDeviceUID == "device-b")
    #expect(ack.inputVolumeSettable == true)
    var expected = try R4Fixture.configuration()
    expected.deviceUID = "device-b"
    #expect(try RoomPersistence(root: root).loadConfiguration() == expected)
    #expect(Self.mode(root.appendingPathComponent("config.json")) == 0o600)
    #expect(launcher.launchedDevices.isEmpty)
    let names = await remote.observedPolls().map { $0.install?.inputDeviceName }
    #expect(names.first == "Device A")
    #expect(names.last == "Device B")
  }

  /// (b) Recording: a second `seg_` directory of the SAME session, opened on the new device after
  /// the old capture stopped; no session call of any kind; the piece index carries on; no gap
  /// between the two segments' audio longer than one checkpoint (1.25 s); and `peak` follows.
  @Test func aRecordingSwitchOpensANewSegmentOfTheSameSession() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = R4Remote(
      activeSessionJSON: R4Fixture.recordingActiveJSON,
      polls: [Self.setAudio("cmd_switch", #"{"device_uid":"device-b"}"#)])
    let launcher = R4FakeLauncher()
    let engine = try await Self.engine(
      root: root, remote: remote, launcher: launcher, audio: R4AudioInputs.standard())

    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.reached(acks: 1, polls: 2) }
    let directories = launcher.launchedDirectories
    let runningDuring = launcher.runningDevices
    task.cancel()
    try await task.value

    let ack = try #require(await remote.acknowledgements().first)
    #expect(ack.ok)
    #expect(ack.sessionID == "bs_r4")
    #expect(ack.appliedDeviceUID == "device-b")
    #expect(launcher.launchedDevices == ["device-a", "device-b"])
    #expect(launcher.mostRunningAtALaunch == 0)
    #expect(runningDuring == ["device-b"])
    #expect(await remote.patchedActions().isEmpty)
    #expect(await remote.createCalls() == 0)
    #expect(await remote.observedPolls().allSatisfy { $0.recordingSessionID == "bs_r4" })

    // Two segments, one session directory.
    #expect(directories.count == 2)
    let sessionDirectory = root.appendingPathComponent("captures/bs_r4").standardizedFileURL
    #expect(directories.allSatisfy { $0.deletingLastPathComponent().standardizedFileURL == sessionDirectory })
    #expect(directories.allSatisfy { $0.lastPathComponent.hasPrefix("seg_") })
    #expect(Set(directories).count == 2)

    // The gap between the old device's last audio and the new device's first.
    let first = try IndexLog.read(url: directories[0].appendingPathComponent("tape.idx")).records
    let second = try IndexLog.read(url: directories[1].appendingPathComponent("tape.idx")).records
    let lastAudio = try #require(first.last(where: { $0.discontinuity == nil })).wallNS
    let firstAudio = try #require(second.first).wallNS
    let gapNS = Int64(firstAudio) - Int64(lastAudio)
    #expect(gapNS >= 0)
    #expect(gapNS <= 1_250_000_000)
    #expect(first.allSatisfy { $0.device == "device-a" })
    #expect(second.allSatisfy { $0.device == "device-b" })

    // The closed segment's audio was cut and delivered under the same session, indices contiguous
    // from the server's next index (3).
    let pieces = await remote.uploadedPieces()
    #expect(pieces.allSatisfy { $0.sessionID == "bs_r4" })
    #expect(pieces.map(\.index) == Array(3..<(3 + pieces.count)))
    #expect(pieces.count >= 2)

    // `peak` follows the device: the dead one read 0 before, the new one 0.6 after.
    let peaks = await remote.observedPolls().compactMap { $0.install?.peak }
    #expect(peaks.first == 0)
    #expect(peaks.last == 0.6)
    #expect(try RoomPersistence(root: root).loadConfiguration().deviceUID == "device-b")
  }

  /// (c) A uid that is not attached: `device_not_present`, config.json byte-for-byte untouched,
  /// and the running capture never stopped.
  @Test func anAbsentDeviceIsRefusedAndNothingMoves() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = R4Remote(
      activeSessionJSON: R4Fixture.recordingActiveJSON,
      polls: [Self.setAudio("cmd_switch", #"{"device_uid":"device-zzz"}"#)])
    let launcher = R4FakeLauncher()
    let engine = try await Self.engine(
      root: root, remote: remote, launcher: launcher, audio: R4AudioInputs.standard())
    let configBefore = try Data(contentsOf: root.appendingPathComponent("config.json"))

    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.acknowledgementCount() == 1 }
    let runningDuring = launcher.runningDevices
    task.cancel()
    try await task.value

    let ack = try #require(await remote.acknowledgements().first)
    #expect(!ack.ok)
    #expect(ack.error == "device_not_present")
    #expect(ack.appliedDeviceUID == nil)
    #expect(try Data(contentsOf: root.appendingPathComponent("config.json")) == configBefore)
    #expect(launcher.launchedDevices == ["device-a"])
    #expect(runningDuring == ["device-a"])
  }

  /// The new device will not open (unplugged mid-switch): config goes back, the capture reopens on
  /// the old device in the same session, and the ack says the switch failed.
  @Test func aSwitchThatCannotOpenPutsTheRoomBackOnItsDevice() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = R4Remote(
      activeSessionJSON: R4Fixture.recordingActiveJSON,
      polls: [Self.setAudio("cmd_switch", #"{"device_uid":"device-dead"}"#)])
    let launcher = R4FakeLauncher(deadDevices: ["device-dead"])
    let engine = try await Self.engine(
      root: root, remote: remote, launcher: launcher, audio: R4AudioInputs.standard())
    let configBefore = try RoomPersistence(root: root).loadConfiguration()

    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.reached(acks: 1, polls: 2) }
    let runningDuring = launcher.runningDevices
    task.cancel()
    try await task.value

    let ack = try #require(await remote.acknowledgements().first)
    #expect(!ack.ok)
    #expect(ack.error?.hasPrefix("device_switch_failed") == true)
    #expect(try RoomPersistence(root: root).loadConfiguration() == configBefore)
    #expect(launcher.launchedDevices == ["device-a", "device-dead", "device-a"])
    #expect(launcher.mostRunningAtALaunch == 0)
    #expect(runningDuring == ["device-a"])
    #expect(await remote.patchedActions().isEmpty)
    #expect(await remote.createCalls() == 0)
    #expect(await remote.observedPolls().allSatisfy { $0.recordingSessionID == "bs_r4" })
  }

  // -------------------------------------------------------------------------
  // Volume (D4) — both branches against the device table
  // -------------------------------------------------------------------------

  @Test func aSettableVolumeIsSetAndTheReReadValueIsAcked() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let audio = R4AudioInputs.standard(deviceA: .init(volume: 0.3, settable: true))
    let remote = R4Remote(
      activeSessionJSON: R4Fixture.idleActiveJSON,
      polls: [Self.setAudio("cmd_volume", #"{"input_volume":0.5}"#)])
    let engine = try await Self.engine(
      root: root, remote: remote, launcher: R4FakeLauncher(), audio: audio)

    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.reached(acks: 1, polls: 2) }
    task.cancel()
    try await task.value

    let ack = try #require(await remote.acknowledgements().first)
    #expect(ack.ok)
    #expect(ack.appliedInputVolume == 0.5)
    #expect(ack.inputVolumeSettable == true)
    #expect(ack.appliedDeviceUID == nil)
    #expect(audio.volumeSets.map(\.uid) == ["device-a"])
    #expect(audio.volumeSets.map(\.value) == [0.5])
    let polled = await remote.observedPolls().map { $0.install?.inputVolume }
    #expect(polled.first == 0.3)
    #expect(polled.last == 0.5)
  }

  @Test func aVolumeThatIsNotSettableIsRefusedAndNothingIsWritten() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let audio = R4AudioInputs.standard(deviceA: .init(volume: nil, settable: false))
    let remote = R4Remote(
      activeSessionJSON: R4Fixture.idleActiveJSON,
      polls: [Self.setAudio("cmd_volume", #"{"input_volume":0.5}"#)])
    let engine = try await Self.engine(
      root: root, remote: remote, launcher: R4FakeLauncher(), audio: audio)

    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value

    let ack = try #require(await remote.acknowledgements().first)
    #expect(!ack.ok)
    #expect(ack.error == "volume_not_settable")
    #expect(ack.inputVolumeSettable == false)
    #expect(audio.volumeSets.isEmpty)
    let first = try #require(await remote.observedPolls().first?.install)
    #expect(first.inputVolume == nil)
    #expect(first.inputVolumeSettable == false)
  }

  /// Both at once, onto a device whose volume cannot be set: refused BEFORE the device moves.
  @Test func aDeviceAndAnUnsettableVolumeTogetherMoveNothing() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let audio = R4AudioInputs.standard(deviceB: .init(volume: nil, settable: false))
    let remote = R4Remote(
      activeSessionJSON: R4Fixture.recordingActiveJSON,
      polls: [
        Self.setAudio("cmd_both", #"{"device_uid":"device-b","input_volume":0.5}"#)
      ])
    let launcher = R4FakeLauncher()
    let engine = try await Self.engine(
      root: root, remote: remote, launcher: launcher, audio: audio)
    let configBefore = try Data(contentsOf: root.appendingPathComponent("config.json"))

    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value

    let ack = try #require(await remote.acknowledgements().first)
    #expect(ack.error == "volume_not_settable")
    #expect(try Data(contentsOf: root.appendingPathComponent("config.json")) == configBefore)
    #expect(launcher.launchedDevices == ["device-a"])
    #expect(audio.volumeSets.isEmpty)
  }

  @Test func badArgsAreRefusedByName() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let audio = R4AudioInputs.standard()
    let remote = R4Remote(
      activeSessionJSON: R4Fixture.idleActiveJSON,
      polls: [Self.setAudio("cmd_bad", #"{"device_uid":42}"#)])
    let engine = try await Self.engine(
      root: root, remote: remote, launcher: R4FakeLauncher(), audio: audio)

    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value

    let ack = try #require(await remote.acknowledgements().first)
    #expect(!ack.ok)
    #expect(ack.error == "bad_args")
    #expect(audio.volumeSets.isEmpty)
  }

  // -------------------------------------------------------------------------
  // The CoreAudio half (D4): scope, element, bounds
  // -------------------------------------------------------------------------

  @Test func theVolumePropertyIsTheInputScopeScalarAndNothingElse() {
    for element: AudioObjectPropertyElement in [kAudioObjectPropertyElementMain, 1] {
      let address = AudioDevices.inputVolumeAddress(element: element)
      #expect(address.mSelector == kAudioDevicePropertyVolumeScalar)
      #expect(address.mScope == kAudioDevicePropertyScopeInput)
      #expect(address.mScope != kAudioDevicePropertyScopeOutput)
      #expect(address.mElement == element)
    }
    #expect(AudioDevices.clampedVolume(0.5) == 0.5)
    #expect(AudioDevices.clampedVolume(1.5) == 1)
    #expect(AudioDevices.clampedVolume(-1) == 0)
    #expect(AudioDevices.clampedVolume(.nan) == nil)
    #expect(AudioDevices.clampedVolume(.infinity) == nil)
    #expect(AudioInputDevices.inputVolume(forUID: "") == nil)
    #expect(AudioInputDevices.inputVolume(forUID: "no-such-device-\(UUID().uuidString)") == nil)
  }

  /// Opt-in, read-only: what this Mac's attached inputs say about their volume. Run with
  /// `ETA_AUDIO_HARDWARE_PROBE=1`; the build report quotes it. Nothing is written.
  @Test(.enabled(if: ProcessInfo.processInfo.environment["ETA_AUDIO_HARDWARE_PROBE"] == "1"))
  func hardwareProbeReadsEachAttachedInput() throws {
    let devices = try #require(AudioInputDevices.list())
    for device in devices {
      let reading = AudioInputDevices.inputVolume(forUID: device.uid)
      let value = reading?.value.map { String(format: "%.4f", $0) } ?? "none"
      print(
        "R4 probe: \(device.name) | input_volume=\(value) | settable=\(reading.map { String($0.settable) } ?? "unread")"
      )
      if let value = reading?.value { #expect((0...1).contains(value)) }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  static func setAudio(_ id: String, _ args: String) -> String {
    "[{\"id\":\"\(id)\",\"kind\":\"set_audio_input\",\"args\":\(args),\"created_at\":null}]"
  }

  static func engine(
    root: URL, remote: R4Remote, launcher: R4FakeLauncher, audio: R4AudioInputs
  ) async throws -> RoomEngine {
    try RoomPersistence(root: root).saveConfiguration(try R4Fixture.configuration())
    return try await RoomEngine.load(
      rootURL: root,
      enrolmentReader: R4Fixture.enrolled,
      remoteFactory: { _ in remote },
      captureLauncher: launcher,
      pieceRunner: R4FakeEncoder(),
      updaterFactory: { _, _, _ in nil },
      log: { _ in },
      audioInputs: audio,
      machineFacts: { uid in audio.facts(forUID: uid) })
  }

  static func mode(_ url: URL) -> Int? {
    let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes?[.posixPermissions] as? NSNumber)?.intValue
  }
}

// MARK: - The R4 half of the shared remote

extension R4Remote {
  /// The witness the engine calls. Records the audio fields beside the plain ones.
  func acknowledge(
    commandID: String, ok: Bool, sessionID: String?, error: String?,
    audioInput: AudioInputAcknowledgement?
  ) async throws -> CommandAcknowledgement {
    acks.append(
      R4Ack(
        id: commandID, ok: ok, sessionID: sessionID, error: error,
        appliedDeviceUID: audioInput?.appliedDeviceUID,
        appliedInputVolume: audioInput?.appliedInputVolume,
        inputVolumeSettable: audioInput?.inputVolumeSettable))
    return Self.acknowledgement(commandID, ok)
  }
}

/// A device table standing in for CoreAudio. `device-a` is the configured device.
final class R4AudioInputs: RoomAudioInputControlling, @unchecked Sendable {
  struct Control {
    var volume: Double?
    var settable: Bool
  }

  private let lock = NSLock()
  private let devices: [(uid: String, name: String)]
  private var controls: [String: Control]
  private var sets: [(uid: String, value: Double)] = []

  init(devices: [(uid: String, name: String)], controls: [String: Control]) {
    self.devices = devices
    self.controls = controls
  }

  static func standard(
    deviceA: Control = Control(volume: nil, settable: false),
    deviceB: Control = Control(volume: 0.4, settable: true)
  ) -> R4AudioInputs {
    R4AudioInputs(
      devices: [
        ("device-a", "Device A"), ("device-b", "Device B"), ("device-dead", "Device Dead"),
      ],
      controls: [
        "device-a": deviceA, "device-b": deviceB,
        "device-dead": Control(volume: nil, settable: false),
      ])
  }

  func inputDevices() -> [AudioInputDeviceEntry]? {
    devices.map { AudioInputDeviceEntry(name: $0.name, uid: $0.uid, isDefault: $0.uid == "device-a") }
  }

  func inputVolume(uid: String) -> AudioInputVolume? {
    lock.withLock {
      guard devices.contains(where: { $0.uid == uid }), let control = controls[uid] else {
        return nil
      }
      return AudioInputVolume(value: control.volume, settable: control.settable)
    }
  }

  func setInputVolume(uid: String, value: Double) throws {
    try lock.withLock {
      guard var control = controls[uid], control.settable else {
        throw RecorderError("input volume is not settable: \(uid)")
      }
      control.volume = min(max(value, 0), 1)
      controls[uid] = control
      sets.append((uid, value))
    }
  }

  var volumeSets: [(uid: String, value: Double)] { lock.withLock { sets } }

  func facts(forUID uid: String?) -> MachineFacts {
    let reading = uid.flatMap { inputVolume(uid: $0) }
    return MachineFacts(
      micState: "authorized",
      neverSleep: true,
      launchedBy: "launchd",
      launchAgentLoaded: true,
      hostname: "r4-test",
      hardwareModel: "Mac mini",
      osVersion: "macOS 27",
      inputDeviceName: devices.first(where: { $0.uid == uid })?.name,
      inputDevices: inputDevices(),
      inputVolume: reading?.value,
      inputVolumeSettable: reading?.settable)
  }
}

/// A URLProtocol stub for the one BenchClient wire test above.
enum R4StubHTTP {
  nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

  final class StubProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
      do {
        let handler = try #require(R4StubHTTP.handler)
        let (response, data) = try handler(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !data.isEmpty { client?.urlProtocol(self, didLoad: data) }
        client?.urlProtocolDidFinishLoading(self)
      } catch {
        client?.urlProtocol(self, didFailWithError: error)
      }
    }
    override func stopLoading() {}
  }

  static func client() throws -> BenchClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubProtocol.self]
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    var room = try R4Fixture.configuration()
    room.etaRoomSession = "signed.jwt"
    return BenchClient(configuration: room, session: URLSession(configuration: configuration))
  }

  static func body(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody { return body }
    let stream = try #require(request.httpBodyStream)
    stream.open()
    defer { stream.close() }
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count <= 0 { break }
      result.append(contentsOf: buffer.prefix(count))
    }
    return result
  }

  static func stub(_ request: URLRequest, body: String) -> (HTTPURLResponse, Data) {
    (
      HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [:])!,
      Data(body.utf8)
    )
  }
}
