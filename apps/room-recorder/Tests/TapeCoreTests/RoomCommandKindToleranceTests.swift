import Foundation
import Testing

@testable import RoomRecorderCore
@testable import TapeCore

/// Release R4 (D2) — a command kind this build does not know must never cost the poll.
///
/// Before 0.1.21 `BenchCommandKind` was a `String`-backed `Codable` enum, so one unknown `kind` in
/// `commands` failed the whole `CommandPollResponse` decode: the `start_day` beside it never ran,
/// and the Mac stayed deaf to the bus until the stranger expired. That is 0.1.7's failure mode.
///
/// This file uses only API that existed before R4, so it compiles against the old source and
/// fails there at run time. It also holds the plain-capture fakes the R4 engine tests share.
@Suite(.serialized) struct RoomCommandKindToleranceTests {
  @Test func anUnknownKindBesideAStartStillDecodesThePoll() throws {
    let response = try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(
        #"{"ok":true,"room_id":"room_1","superseded":false,"commands":[{"id":"cmd_frob","kind":"frobnicate","args":{},"created_at":null},{"id":"cmd_start","kind":"start_day","args":{},"created_at":null}]}"#
          .utf8))
    #expect(response.commands.map(\.id) == ["cmd_frob", "cmd_start"])
    #expect(response.commands.last?.kind == .startDay)
  }

  @Test func aCommandThatCannotBeReadIsDroppedAndTheRestRun() throws {
    // No id; a kind that is not a string; and a start with no `args` key at all.
    let response = try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(
        #"{"ok":true,"room_id":"room_1","commands":[{"kind":"start_day","args":{}},{"id":"cmd_num","kind":5,"args":{}},{"id":"cmd_start","kind":"start_day"}]}"#
          .utf8))
    #expect(response.commands.map(\.id) == ["cmd_start"])
    #expect(response.commands.first?.args == .null)
  }

  /// The kickoff's test: a poll carrying `"kind":"frobnicate"` beside a `start_day` still
  /// dispatches the `start_day`, and acks the stranger failed.
  @Test func anUnknownKindIsAckedFailedAndTheStartBesideItRuns() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(try R4Fixture.configuration())
    let remote = R4Remote(
      activeSessionJSON: R4Fixture.idleActiveJSON,
      polls: [
        #"[{"id":"cmd_frob","kind":"frobnicate","args":{},"created_at":null},{"id":"cmd_start","kind":"start_day","args":{},"created_at":null}]"#
      ])
    let launcher = R4FakeLauncher()
    let engine = try await RoomEngine.load(
      rootURL: root,
      enrolmentReader: R4Fixture.enrolled,
      remoteFactory: { _ in remote },
      captureLauncher: launcher,
      pieceRunner: R4FakeEncoder(),
      updaterFactory: { _, _, _ in nil },
      log: { _ in })

    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.acknowledgementCount() == 2 }
    task.cancel()
    try await task.value

    let acks = await remote.acknowledgements()
    #expect(acks.map(\.id) == ["cmd_frob", "cmd_start"])
    #expect(acks.first?.ok == false)
    #expect(acks.first?.error == "unsupported_kind")
    #expect(acks.last?.ok == true)
    #expect(acks.last?.sessionID == "bs_new")
    #expect(await remote.createCalls() == 1)
    #expect(launcher.launchedDevices == ["device-a"])
  }
}

// MARK: - Plain-capture fixtures shared with RoomAudioInputCommandTests

enum R4Fixture {
  static let idleActiveJSON =
    #"{"ok":true,"resumable":false,"session":null,"next_idx":{"primary":0,"backup":0},"reason":null,"handover_pending":false,"tab_gone":false}"#
  static let recordingActiveJSON =
    #"{"ok":true,"resumable":true,"session":{"id":"bs_r4","room_id":"room_1","label":null,"mic_label":"device-a","status":"recording","started_at":null,"last_any_chunk_at":null},"next_idx":{"primary":3,"backup":0},"reason":null,"handover_pending":false,"tab_gone":false}"#

  static let enrolled: @Sendable () -> RoomKeychainRecord? = {
    RoomKeychainRecord(
      session: "test.session.jwt",
      installID: "install_testfixture",
      roomSlug: "home-office",
      roomName: "Home Office",
      origin: "https://eta.test")
  }

  static func temporaryRoot() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(
      "room-r4-\(UUID().uuidString)", isDirectory: true
    ).standardizedFileURL
  }

  static func configuration() throws -> RoomConfiguration {
    try RoomConfiguration(
      origin: #require(URL(string: "https://eta.test/")),
      roomSlug: "home-office",
      deviceUID: "device-a",
      tapewriterPath: "/usr/bin/false",
      ffmpegPath: "/opt/ffmpeg",
      installID: "install_testfixture",
      tabID: "app_install_testfixture",
      updateChannel: "test")
  }

  static func waitUntil(_ condition: @escaping @Sendable () async -> Bool) async throws {
    for _ in 0..<1_000 {
      if await condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("timed out waiting for the engine")
  }
}

/// A tapewriter stand-in that writes what the real one writes: a `samples: 0` anchor, then a
/// checkpoint every 50 ms (800 samples at 16 kHz, PCM appended before its index line), then a
/// `stopped` discontinuity on interrupt. `exitStatus` set means it dies at once, writing nothing —
/// a device that will not open.
final class R4FakeTapewriter: RoomCaptureProcess, @unchecked Sendable {
  let directory: URL
  let deviceUID: String
  private let lock = NSLock()
  private var running: Bool
  private var status: Int32?
  private var stopRequested = false

  init(directory: URL, deviceUID: String, peak: Double, exitStatus: Int32?) {
    self.directory = directory
    self.deviceUID = deviceUID
    running = exitStatus == nil
    status = exitStatus
    guard exitStatus == nil else { return }
    let thread = Thread { [self] in self.write(peak: peak) }
    thread.start()
  }

  var isRunning: Bool { lock.withLock { running } }
  var terminationStatus: Int32? { lock.withLock { running ? nil : status } }
  func interrupt() { lock.withLock { stopRequested = true } }
  func waitUntilExit() {
    while isRunning { Thread.sleep(forTimeInterval: 0.002) }
  }

  private func write(peak: Double) {
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let indexURL = directory.appendingPathComponent("tape.idx")
    FileManager.default.createFile(atPath: pcmURL.path, contents: nil)
    FileManager.default.createFile(atPath: indexURL.path, contents: nil)
    guard let pcm = try? FileHandle(forWritingTo: pcmURL),
      let index = try? FileHandle(forWritingTo: indexURL)
    else {
      lock.withLock {
        running = false
        status = 70
      }
      return
    }
    func append(_ record: IndexRecord) {
      if let line = try? IndexLog.encodedLine(record) { try? index.write(contentsOf: line) }
    }
    let rms = peak / 2
    let zeroRatio = peak == 0 ? 1.0 : 0.0
    var samples: Int64 = 0
    append(
      IndexRecord(
        byteOffset: 0, samples: 0, monoNS: Self.mono(), wallNS: Self.wall(), device: deviceUID,
        rms: 0))
    while !lock.withLock({ stopRequested }) {
      Thread.sleep(forTimeInterval: 0.05)
      try? pcm.write(contentsOf: Data(count: 800 * 2))
      samples += 800
      append(
        IndexRecord(
          byteOffset: samples * 2, samples: samples, monoNS: Self.mono(), wallNS: Self.wall(),
          device: deviceUID, rms: rms, peak: peak, zeroRatio: zeroRatio))
    }
    append(
      IndexRecord(
        byteOffset: samples * 2, samples: samples, monoNS: Self.mono(), wallNS: Self.wall(),
        device: deviceUID, discontinuity: "stopped"))
    try? pcm.close()
    try? index.close()
    lock.withLock {
      running = false
      status = 0
    }
  }

  static func mono() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
  static func wall() -> UInt64 { UInt64(Date().timeIntervalSince1970 * 1_000_000_000) }
}

/// Launches `R4FakeTapewriter`s and remembers every launch, and the most that were ever running at
/// the moment a new one was launched — which must be zero for a switch to be one capture at a time.
final class R4FakeLauncher: RoomCaptureLaunching, @unchecked Sendable {
  private let lock = NSLock()
  private let deadDevices: Set<String>
  private let peaks: [String: Double]
  private var processes: [R4FakeTapewriter] = []
  private var runningAtLaunch: [Int] = []

  init(deadDevices: Set<String> = [], peaks: [String: Double] = ["device-a": 0, "device-b": 0.6])
  {
    self.deadDevices = deadDevices
    self.peaks = peaks
  }

  func launch(executable: URL, outputDirectory: URL, deviceUID: String, logURL: URL) throws
    -> any RoomCaptureProcess
  {
    lock.withLock {
      runningAtLaunch.append(processes.filter(\.isRunning).count)
      let process = R4FakeTapewriter(
        directory: outputDirectory, deviceUID: deviceUID, peak: peaks[deviceUID] ?? 0.3,
        exitStatus: deadDevices.contains(deviceUID) ? 1 : nil)
      processes.append(process)
      return process
    }
  }

  var launchedDevices: [String] { lock.withLock { processes.map(\.deviceUID) } }
  var launchedDirectories: [URL] { lock.withLock { processes.map(\.directory) } }
  var mostRunningAtALaunch: Int { lock.withLock { runningAtLaunch.max() ?? 0 } }
  var runningDevices: [String] {
    lock.withLock { processes.filter(\.isRunning).map(\.deviceUID) }
  }
}

/// ffmpeg's stand-in: a three-byte "piece" at the path the encoder asked for.
struct R4FakeEncoder: RoomPieceProcessRunning {
  func run(_ invocation: FFmpegEncoderInvocation) throws -> RoomPieceProcessResult {
    try Data([0x1A, 0x45, 0xDF]).write(to: invocation.outputURL)
    return RoomPieceProcessResult(terminationStatus: 0)
  }
}

/// One ack as the server received it. The three audio fields are plain values so this file
/// compiles against source that has no `AudioInputAcknowledgement`; the R4 file fills them.
struct R4Ack: Sendable {
  let id: String
  let ok: Bool
  let sessionID: String?
  let error: String?
  var appliedDeviceUID: String? = nil
  var appliedInputVolume: Double? = nil
  var inputVolumeSettable: Bool? = nil
}

struct R4Poll: Sendable {
  let recordingSessionID: String?
  let install: InstallPollFields?
}

/// The server, as the plain path meets it. `polls` is the `commands` array for each poll in turn;
/// every poll after the last is `[]`. Pieces are answered `already_verified`.
actor R4Remote: RoomEngineRemote {
  private let activeSessionJSON: String
  private var polls: [String]
  var acks: [R4Ack] = []
  private var seenPolls: [R4Poll] = []
  private var creates = 0
  private var patches: [BenchSessionAction] = []
  private var uploaded: [BenchPiece] = []

  init(activeSessionJSON: String, polls: [String]) {
    self.activeSessionJSON = activeSessionJSON
    self.polls = polls
  }

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    try JSONDecoder().decode(ActiveSessionResponse.self, from: Data(activeSessionJSON.utf8))
  }

  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    creates += 1
    return try JSONDecoder().decode(
      CreateSessionResponse.self,
      from: Data(
        #"{"session":{"id":"bs_new","room_id":"room_1","label":null,"mic_label":"device-a","status":"recording"}}"#
          .utf8))
  }

  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  {
    patches.append(action)
    return try JSONDecoder().decode(BenchOKResponse.self, from: Data(#"{"ok":true}"#.utf8))
  }

  func pollCommands(
    tabID: String,
    previousPollAt: String?,
    recordingSessionID: String?,
    paused: Bool,
    primaryLevels: BenchLevelPair?,
    install: InstallPollFields?
  ) async throws -> CommandPollResponse {
    seenPolls.append(R4Poll(recordingSessionID: recordingSessionID, install: install))
    let commands = polls.isEmpty ? "[]" : polls.removeFirst()
    return try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(
        "{\"ok\":true,\"room_id\":\"room_1\",\"superseded\":false,\"commands\":\(commands)}".utf8))
  }

  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  {
    acks.append(R4Ack(id: commandID, ok: ok, sessionID: sessionID, error: error))
    return Self.acknowledgement(commandID, ok)
  }

  static func acknowledgement(_ commandID: String, _ ok: Bool) -> CommandAcknowledgement {
    try! JSONDecoder().decode(
      CommandAcknowledgement.self,
      from: Data(
        "{\"ok\":true,\"id\":\"\(commandID)\",\"status\":\"\(ok ? "acked" : "failed")\"}".utf8))
  }

  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw CancellationError()
  }

  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  {
    uploaded.append(piece)
    return .alreadyVerified
  }

  func acknowledgementCount() -> Int { acks.count }
  /// True once `acks` acks and at least `polls` polls have arrived.
  func reached(acks expected: Int, polls minimum: Int) -> Bool {
    acks.count == expected && seenPolls.count >= minimum
  }
  func acknowledgements() -> [R4Ack] { acks }
  func pollCount() -> Int { seenPolls.count }
  func observedPolls() -> [R4Poll] { seenPolls }
  func createCalls() -> Int { creates }
  func patchedActions() -> [BenchSessionAction] { patches }
  func uploadedPieces() -> [BenchPiece] { uploaded }
}
