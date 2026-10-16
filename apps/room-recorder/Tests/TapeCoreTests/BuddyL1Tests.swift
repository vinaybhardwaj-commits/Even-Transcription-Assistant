import Darwin
import Foundation
import Testing

@testable import FleetCore
@testable import HelperCore
@testable import RoomRecorderCore
@testable import TapeCapture
@testable import TapeCore

/// Encounter Buddy, L1 (0.1.41): the recorder's tap, window and page, and the FU/ADDENDUM items built beside them.
///
/// Nothing here opens a real window or CoreAudio. The tap is the real server on the loopback; the window is a spy; the
/// capture is a fixture tapewriter that writes known PCM.
@Suite(.serialized) struct BuddyL1Tests {

  // MARK: - Doubles

  final class SpyPresenter: BuddyWindowPresenting, @unchecked Sendable {
    private let lock = NSLock()
    private var calls: [String] = []
    private var urls: [URL] = []
    var all: [String] { lock.withLock { calls } }
    var openedURLs: [URL] { lock.withLock { urls } }
    func open(url: URL, opaqueID: String) { lock.withLock { calls.append("open:\(opaqueID)"); urls.append(url) } }
    func close(opaqueID: String) { lock.withLock { calls.append("close:\(opaqueID)") } }
  }

  /// A tapewriter that has already written `pcm` when it starts, then waits to be interrupted.
  final class BurstTapewriter: RoomCaptureProcess, @unchecked Sendable {
    private let lock = NSLock()
    private var running = true
    init(directory: URL, deviceUID: String, pcm: Data) {
      let pcmURL = directory.appendingPathComponent("tape.pcm")
      let indexURL = directory.appendingPathComponent("tape.idx")
      FileManager.default.createFile(atPath: pcmURL.path, contents: nil)
      FileManager.default.createFile(atPath: indexURL.path, contents: nil)
      let index = try! FileHandle(forWritingTo: indexURL)
      let wall = UInt64(Date().timeIntervalSince1970 * 1_000_000_000)
      func line(_ record: IndexRecord) { try? index.write(contentsOf: try! IndexLog.encodedLine(record)) }
      line(IndexRecord(byteOffset: 0, samples: 0, monoNS: DispatchTime.now().uptimeNanoseconds, wallNS: wall, device: deviceUID, rms: 0))
      try! pcm.write(to: pcmURL)
      let samples = Int64(pcm.count / 2)
      line(
        IndexRecord(
          byteOffset: samples * 2, samples: samples, monoNS: DispatchTime.now().uptimeNanoseconds, wallNS: wall + 1,
          device: deviceUID, rms: 0.2, peak: 0.5, zeroRatio: 0))
      self.index = index
      self.directory = directory
      self.deviceUID = deviceUID
      self.samples = samples
    }
    private let index: FileHandle
    let directory: URL
    let deviceUID: String
    private let samples: Int64
    var isRunning: Bool { lock.withLock { running } }
    var terminationStatus: Int32? { lock.withLock { running ? nil : 0 } }
    func interrupt() {
      lock.withLock {
        guard running else { return }
        running = false
        let record = IndexRecord(
          byteOffset: samples * 2, samples: samples, monoNS: DispatchTime.now().uptimeNanoseconds,
          wallNS: UInt64(Date().timeIntervalSince1970 * 1_000_000_000) + 2, device: deviceUID, discontinuity: "stopped")
        try? index.write(contentsOf: try! IndexLog.encodedLine(record))
        try? index.close()
      }
    }
    func waitUntilExit() {}
  }

  final class BurstLauncher: RoomCaptureLaunching, @unchecked Sendable {
    let pcm: Data
    private let lock = NSLock()
    private var launches = 0
    private var processes: [BurstTapewriter] = []
    init(pcm: Data) { self.pcm = pcm }
    var launchCount: Int { lock.withLock { launches } }
    func launch(executable: URL, outputDirectory: URL, deviceUID: String, logURL: URL) throws -> any RoomCaptureProcess {
      lock.withLock {
        launches += 1
        let process = BurstTapewriter(directory: outputDirectory, deviceUID: deviceUID, pcm: pcm)
        processes.append(process)
        return process
      }
    }
  }

  /// Copies the PCM ffmpeg would have been given into the "piece", so the bytes that go to the cloud ARE the tape bytes.
  final class EchoEncoder: RoomPieceProcessRunning, @unchecked Sendable {
    private let lock = NSLock()
    private var inputs: [Data] = []
    func run(_ invocation: FFmpegEncoderInvocation) throws -> RoomPieceProcessResult {
      let arguments = invocation.arguments
      let input = URL(fileURLWithPath: arguments[arguments.firstIndex(of: "-i")! + 1])
      let bytes = try Data(contentsOf: input)
      lock.withLock { inputs.append(bytes) }
      try bytes.write(to: invocation.outputURL)
      return RoomPieceProcessResult(terminationStatus: 0)
    }
    var pieces: [Data] { lock.withLock { inputs } }
  }

  /// A server the test can push commands into, and read the acks of.
  actor PushRemote: RoomEngineRemote {
    private var queue: [String] = []
    private(set) var acks: [R4Ack] = []
    private(set) var pollCount = 0

    func push(_ commandJSON: String) { queue.append(commandJSON) }

    func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
      try JSONDecoder().decode(ActiveSessionResponse.self, from: Data(R4Fixture.idleActiveJSON.utf8))
    }
    func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
      try JSONDecoder().decode(
        CreateSessionResponse.self,
        from: Data(#"{"session":{"id":"bs_new","room_id":"room_1","label":null,"mic_label":"device-a","status":"recording"}}"#.utf8))
    }
    func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws -> BenchOKResponse {
      try JSONDecoder().decode(BenchOKResponse.self, from: Data(#"{"ok":true}"#.utf8))
    }
    func pollCommands(
      tabID: String, previousPollAt: String?, recordingSessionID: String?, paused: Bool,
      primaryLevels: BenchLevelPair?, install: InstallPollFields?
    ) async throws -> CommandPollResponse {
      pollCount += 1
      let commands = queue.isEmpty ? "[]" : "[" + queue.removeFirst() + "]"
      return try JSONDecoder().decode(
        CommandPollResponse.self,
        from: Data("{\"ok\":true,\"room_id\":\"room_1\",\"superseded\":false,\"assigned_channel\":null,\"commands\":\(commands)}".utf8))
    }
    func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws -> CommandAcknowledgement {
      acks.append(R4Ack(id: commandID, ok: ok, sessionID: sessionID, error: error))
      return R4Remote.acknowledgement(commandID, ok)
    }
    func acknowledge(
      commandID: String, ok: Bool, sessionID: String?, error: String?, audioInput: AudioInputAcknowledgement?
    ) async throws -> CommandAcknowledgement {
      try await acknowledge(commandID: commandID, ok: ok, sessionID: sessionID, error: error)
    }
    func acknowledge(
      commandID: String, ok: Bool, sessionID: String?, error: String?, audioInput: AudioInputAcknowledgement?,
      verb: OperatorVerbAcknowledgement?
    ) async throws -> CommandAcknowledgement {
      try await acknowledge(commandID: commandID, ok: ok, sessionID: sessionID, error: error)
    }
    func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse { throw CancellationError() }
    func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws -> ImmutablePieceUploadResult { .alreadyVerified }
  }

  struct Rig {
    let root: URL
    let engine: RoomEngine
    let remote: PushRemote
    let presenter: SpyPresenter
    let launcher: BurstLauncher
    let encoder: EchoEncoder
    let audio: R4AudioInputs
    let logs: LockedList<String>
  }

  /// The fixture tape: 2 s of a non-zero ramp, known byte for byte.
  static let fixturePCM: Data = {
    var data = Data()
    for index in 0..<32_000 {
      var sample = Int16(truncatingIfNeeded: (index * 37) % 20_000 - 10_000).littleEndian
      withUnsafeBytes(of: &sample) { data.append(contentsOf: $0) }
    }
    return data
  }()

  static func rig(
    attachBuddy: Bool = true, mic: String = "authorized", audio: R4AudioInputs = R4AudioInputs.standard(),
    configuration: RoomConfiguration? = nil
  ) async throws -> Rig {
    let root = R4Fixture.temporaryRoot()
    try RoomPersistence(root: root).saveConfiguration(try configuration ?? R4Fixture.configuration())
    let remote = PushRemote()
    let presenter = SpyPresenter()
    let launcher = BurstLauncher(pcm: fixturePCM)
    let encoder = EchoEncoder()
    let logs = LockedList<String>()
    let engine = try await RoomEngine.load(
      rootURL: root, enrolmentReader: R4Fixture.enrolled, remoteFactory: { _ in remote },
      captureLauncher: launcher, pieceRunner: encoder, updaterFactory: { _, _, _ in nil },
      log: { logs.append($0) }, audioInputs: audio, inputReadyWait: .disabled,
      machineFacts: { uid in audio.facts(forUID: uid) })
    await engine.setMicStateProvider { mic }
    if attachBuddy { await engine.attachBuddy(presenter: presenter) }
    return Rig(root: root, engine: engine, remote: remote, presenter: presenter, launcher: launcher, encoder: encoder, audio: audio, logs: logs)
  }

  static func command(_ id: String, _ kind: String, _ args: String = "{}") -> String {
    "{\"id\":\"\(id)\",\"kind\":\"\(kind)\",\"args\":\(args),\"created_at\":null}"
  }

  static func tapFile(_ root: URL) -> (port: Int, token: String)? {
    guard let data = try? Data(contentsOf: root.appendingPathComponent(BuddyConsultController.tapFileName)),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let port = object["port"] as? Int, let token = object["token"] as? String
    else { return nil }
    return (port, token)
  }

  /// A raw HTTP/1.1 GET over a plain socket, so the test controls the Host header and the token header exactly.
  struct Reply { var status = 0; var headers: [String: String] = [:]; var body = Data() }
  static func get(
    port: Int, path: String, token: String? = nil, host: String? = nil, host4: String = "127.0.0.1"
  ) -> Reply? {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = UInt16(port).bigEndian
    guard inet_pton(AF_INET, host4, &address.sin_addr) == 1 else { return nil }
    let connected = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard connected == 0 else { return nil }
    var timeout = timeval(tv_sec: 3, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var request = "GET \(path) HTTP/1.1\r\nHost: \(host ?? "127.0.0.1:\(port)")\r\n"
    if let token { request += "Authorization: Bearer \(token)\r\n" }
    request += "\r\n"
    _ = request.withCString { send(fd, $0, strlen($0), 0) }
    var data = Data()
    var chunk = [UInt8](repeating: 0, count: 65_536)
    while true {
      let n = recv(fd, &chunk, chunk.count, 0)
      if n <= 0 { break }
      data.append(contentsOf: chunk[0..<n])
    }
    guard let split = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
    let head = String(decoding: data[..<split.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
    var reply = Reply()
    reply.status = Int(head[0].split(separator: " ")[1]) ?? 0
    for line in head.dropFirst() {
      if let colon = line.firstIndex(of: ":") {
        reply.headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      }
    }
    reply.body = data[split.upperBound...]
    return reply
  }

  static func tree(_ root: URL) -> [String] {
    let keys: [URLResourceKey] = [.fileSizeKey]
    let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys)
    var seen: [String] = []
    while let url = enumerator?.nextObject() as? URL {
      let size = (try? url.resourceValues(forKeys: Set(keys)).fileSize) ?? 0
      seen.append("\(url.path.replacingOccurrences(of: root.path, with: "")) \(size)")
    }
    return seen.sorted()
  }

  // MARK: - The wire

  @Test func theConsultKindsRoundTripAndAreNotTheDay() throws {
    for (raw, kind) in [("consult_started", BenchCommandKind.consultStarted), ("consult_ended", .consultEnded)] {
      #expect(BenchCommandKind(rawValue: raw) == kind)
      #expect(kind.rawValue == raw)
    }
    #expect(RoomCommandDecider.decide(kind: .consultStarted, phase: .ready, overridePause: false) == .refuse("unsupported_kind"))
    #expect(RoomCommandDecider.decide(kind: .consultEnded, phase: .recording, overridePause: false) == .refuse("unsupported_kind"))
  }

  // MARK: - The tap

  @Test func theTapRefusesAMissingOrWrongTokenAndServesTheRightOne() async throws {
    let rig = try await Self.rig()
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    await rig.remote.push(Self.command("c1", "start_day"))
    try await R4Fixture.waitUntil { rig.launcher.launchCount == 1 }
    await rig.remote.push(Self.command("c2", "consult_started", #"{"opaque_id":"opq_abc123"}"#))
    try await R4Fixture.waitUntil { Self.tapFile(rig.root) != nil }
    let tap = try #require(Self.tapFile(rig.root))
    // The state box is refreshed on the engine's loop; wait until the capture is visible to the tap.
    try await R4Fixture.waitUntil { Self.get(port: tap.port, path: "/tap/pcm?from=0&max=64", token: tap.token)?.status == 200 }

    #expect(Self.get(port: tap.port, path: "/tap/pcm?from=0&max=64")?.status == 401, "no token")
    #expect(Self.get(port: tap.port, path: "/tap/pcm?from=0&max=64", token: "")?.status == 401, "empty token")
    #expect(Self.get(port: tap.port, path: "/tap/pcm?from=0&max=64", token: String(repeating: "0", count: 64))?.status == 401, "wrong token")
    #expect(Self.get(port: tap.port, path: "/tap/pcm?from=0&max=64", token: tap.token + "0")?.status == 401, "longer token")
    #expect(Self.get(port: tap.port, path: "/tap/pcm?from=0&max=64", token: String(tap.token.dropLast()))?.status == 401, "shorter token")
    let good = try #require(Self.get(port: tap.port, path: "/tap/pcm?from=10&max=64", token: tap.token))
    #expect(good.status == 200)
    #expect(good.body == Self.fixturePCM.subdata(in: 10..<74), "the tap serves the tape's own bytes")
    #expect(good.headers["x-tape-offset"] == "10")
    // A request under another name is a DNS-rebinding attempt.
    #expect(Self.get(port: tap.port, path: "/tap/pcm?from=0&max=8", token: tap.token, host: "evil.example:\(tap.port)")?.status == 403)

    await rig.remote.push(Self.command("c3", "end_day"))
    try await R4Fixture.waitUntil { await rig.remote.acks.count == 3 }
    task.cancel()
    try await task.value
  }

  @Test func theTokenIs256BitsPerBootFilePrivateAndNeverLoggedOrInStatus() async throws {
    let first = BuddyToken.make(), second = BuddyToken.make()
    #expect(first?.count == 64 && first?.allSatisfy { $0.isHexDigit } == true)
    #expect(first != second)

    let rig = try await Self.rig()
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    await rig.remote.push(Self.command("c1", "consult_started", #"{"opaque_id":"opq_tok"}"#))
    try await R4Fixture.waitUntil { Self.tapFile(rig.root) != nil }
    let tap = try #require(Self.tapFile(rig.root))
    #expect(tap.token.count == 64)
    var info = stat()
    stat(rig.root.appendingPathComponent(BuddyConsultController.tapFileName).path, &info)
    #expect(info.st_mode & 0o777 == 0o600, "owner-only")
    // Force a status write and then look for the token everywhere the app writes.
    await rig.remote.push(Self.command("c2", "report_diag"))
    try await R4Fixture.waitUntil { await rig.remote.acks.count == 2 }
    task.cancel()
    try await task.value
    #expect(!rig.logs.all.contains { $0.contains(tap.token) }, "never logged")
    let status = try String(contentsOf: rig.root.appendingPathComponent(RoomPersistence.statusFileName), encoding: .utf8)
    #expect(!status.contains(tap.token) && !status.contains("port") && !status.contains("buddy"))
    let walker = FileManager.default.enumerator(at: rig.root, includingPropertiesForKeys: nil)
    while let url = walker?.nextObject() as? URL {
      if url.lastPathComponent == BuddyConsultController.tapFileName { continue }
      if let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) {
        #expect(!text.contains(tap.token), "the token is only in the 0600 tap file: \(url.lastPathComponent)")
      }
    }
  }

  @Test func theTapBindsTheLoopbackAndNothingElse() async throws {
    let rig = try await Self.rig()
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    await rig.remote.push(Self.command("c1", "consult_started", #"{"opaque_id":"opq_lo"}"#))
    try await R4Fixture.waitUntil { Self.tapFile(rig.root) != nil }
    let tap = try #require(Self.tapFile(rig.root))
    #expect(Self.get(port: tap.port, path: "/encounter/opq_lo/state")?.status == 200, "the loopback answers")
    // Every other IPv4 address this Mac has must refuse the connection: the listener is not on 0.0.0.0.
    var others: [String] = []
    var list: UnsafeMutablePointer<ifaddrs>?
    if getifaddrs(&list) == 0 {
      var cursor = list
      while let entry = cursor?.pointee {
        if let address = entry.ifa_addr, address.pointee.sa_family == sa_family_t(AF_INET) {
          var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
          address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
            var sin = $0.pointee.sin_addr
            inet_ntop(AF_INET, &sin, &buffer, socklen_t(INET_ADDRSTRLEN))
          }
          let text = String(cString: buffer)
          if text != "127.0.0.1" { others.append(text) }
        }
        cursor = entry.ifa_next
      }
      freeifaddrs(list)
    }
    for address in others {
      #expect(Self.get(port: tap.port, path: "/encounter/opq_lo/state", host4: address) == nil, "\(address) must refuse")
    }
    task.cancel()
    try await task.value
  }

  @Test func theTapWritesNoAudioAndLeavesNoFileBehind() async throws {
    let rig = try await Self.rig()
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    await rig.remote.push(Self.command("c1", "start_day"))
    try await R4Fixture.waitUntil { rig.launcher.launchCount == 1 }
    let before = Self.tree(rig.root).filter { !$0.contains("status.json") && !$0.contains("tape.") }
    await rig.remote.push(Self.command("c2", "consult_started", #"{"opaque_id":"opq_files"}"#))
    try await R4Fixture.waitUntil { Self.tapFile(rig.root) != nil }
    let tap = try #require(Self.tapFile(rig.root))
    try await R4Fixture.waitUntil { Self.get(port: tap.port, path: "/tap/pcm?from=0&max=4096", token: tap.token)?.status == 200 }
    for offset in stride(from: 0, to: 60_000, by: 8_192) {
      _ = Self.get(port: tap.port, path: "/tap/pcm?from=\(offset)&max=8192", token: tap.token)
    }
    let during = Self.tree(rig.root).filter { !$0.contains("status.json") && !$0.contains("tape.") }
    let added = Set(during).subtracting(before)
    #expect(added.count == 1 && added.first?.contains("/\(BuddyConsultController.tapFileName) ") == true, "only the token file: \(added) before \(before)")
    await rig.remote.push(Self.command("c3", "consult_ended", #"{"opaque_id":"opq_files"}"#))
    try await R4Fixture.waitUntil { await rig.remote.acks.count == 3 }
    #expect(Self.tapFile(rig.root) == nil, "the token file goes with the consult")
    let pcmFiles = Self.tree(rig.root).filter { $0.contains(".pcm") }
    #expect(pcmFiles.count == 1, "one tape.pcm, the recorder's own: \(pcmFiles)")
    await rig.remote.push(Self.command("c4", "end_day"))
    try await R4Fixture.waitUntil { await rig.remote.acks.count == 4 }
    task.cancel()
    try await task.value
  }

  @Test func theCloudChunksAreByteIdenticalWithTheTapOnAndOff() async throws {
    func run(tapOn: Bool) async throws -> [Data] {
      let rig = try await Self.rig()
      defer { try? FileManager.default.removeItem(at: rig.root) }
      let task = Task { try await rig.engine.run() }
      await rig.remote.push(Self.command("c1", "start_day"))
      try await R4Fixture.waitUntil { rig.launcher.launchCount == 1 }
      var reader: Task<Void, Never>?
      if tapOn {
        await rig.remote.push(Self.command("c2", "consult_started", #"{"opaque_id":"opq_same"}"#))
        try await R4Fixture.waitUntil { Self.tapFile(rig.root) != nil }
        let tap = try #require(Self.tapFile(rig.root))
        // A client that reads the tape the whole time the recorder is cutting pieces.
        reader = Task.detached {
          while !Task.isCancelled {
            _ = Self.get(port: tap.port, path: "/tap/pcm?from=0&max=65536", token: tap.token)
            try? await Task.sleep(nanoseconds: 5_000_000)
          }
        }
        try await Task.sleep(nanoseconds: 300_000_000)
      }
      await rig.remote.push(Self.command("c9", "end_day"))
      try await R4Fixture.waitUntil { await rig.remote.acks.contains { $0.id == "c9" } }
      reader?.cancel()
      task.cancel()
      try await task.value
      return rig.encoder.pieces
    }
    let off = try await run(tapOn: false)
    let on = try await run(tapOn: true)
    #expect(!off.isEmpty)
    #expect(off.reduce(Data(), +) == Self.fixturePCM, "with the tap off the chunks are the tape")
    #expect(on == off, "the same pieces, byte for byte, with the tap on")
  }

  // MARK: - The window

  @Test func theWindowOpensOnConsultStartedAndClosesOnConsultEnded() async throws {
    let rig = try await Self.rig()
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    await rig.remote.push(Self.command("c1", "consult_started", #"{"opaque_id":"opq_win"}"#))
    try await R4Fixture.waitUntil { rig.presenter.all == ["open:opq_win"] }
    let url = try #require(rig.presenter.openedURLs.first)
    #expect(url.host == "127.0.0.1" && url.path == "/encounter/opq_win" && url.scheme == "http")
    // The same consult again does not reopen it (A2-C3).
    await rig.remote.push(Self.command("c2", "consult_started", #"{"opaque_id":"opq_win"}"#))
    try await R4Fixture.waitUntil { await rig.remote.acks.count == 2 }
    #expect(rig.presenter.all == ["open:opq_win"])
    await rig.remote.push(Self.command("c3", "consult_ended", #"{"opaque_id":"opq_win"}"#))
    try await R4Fixture.waitUntil { rig.presenter.all.count == 2 }
    #expect(rig.presenter.all == ["open:opq_win", "close:opq_win"])
    #expect(await rig.remote.acks.allSatisfy { $0.ok })
    // The server is gone with the window.
    #expect(Self.get(port: url.port ?? 0, path: "/encounter/opq_win/state") == nil)
    task.cancel()
    try await task.value
    #expect(rig.logs.all.filter { $0.hasPrefix("encounter buddy: window") } == [
      "encounter buddy: window open (opaque_id opq_win)", "encounter buddy: window closed (opaque_id opq_win) (consult_ended)",
    ])
  }

  @Test func aBadOrMissingOpaqueIDIsRefusedAndOpensNothing() async throws {
    let rig = try await Self.rig()
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    await rig.remote.push(Self.command("c1", "consult_started", "{}"))
    await rig.remote.push(Self.command("c2", "consult_started", #"{"opaque_id":"<script>"}"#))
    await rig.remote.push(Self.command("c3", "consult_started", #"{"opaque_id":"\#(String(repeating: "a", count: 65))"}"#))
    try await R4Fixture.waitUntil { await rig.remote.acks.count == 3 }
    #expect(await rig.remote.acks.map(\.ok) == [false, false, false])
    #expect(await rig.remote.acks.map(\.error) == ["bad_args", "bad_args", "bad_args"])
    #expect(rig.presenter.all.isEmpty && Self.tapFile(rig.root) == nil)
    task.cancel()
    try await task.value
  }

  @Test func withoutBuddyAttachedTheCommandsAreRefusedByNameAndNothingHappens() async throws {
    let rig = try await Self.rig(attachBuddy: false)
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    await rig.remote.push(Self.command("c1", "consult_started", #"{"opaque_id":"opq_none"}"#))
    try await R4Fixture.waitUntil { await rig.remote.acks.count == 1 }
    #expect(await rig.remote.acks.first?.error == "buddy_unavailable")
    #expect(rig.presenter.all.isEmpty)
    task.cancel()
    try await task.value
  }

  // MARK: - The kill switch (C10)

  @Test func buddyOffOpensNoWindowAndTheTapServesNothing() async throws {
    let rig = try await Self.rig()
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    await rig.remote.push(Self.command("c1", "start_day"))
    try await R4Fixture.waitUntil { rig.launcher.launchCount == 1 }
    await rig.remote.push(Self.command("c2", "consult_started", #"{"opaque_id":"opq_off","buddy_off":true}"#))
    try await R4Fixture.waitUntil { await rig.remote.acks.count == 2 }
    #expect(await rig.remote.acks.last?.ok == true, "refused quietly: the consult itself is fine")
    #expect(rig.presenter.all.isEmpty, "no window")
    #expect(Self.tapFile(rig.root) == nil, "no token file, so nothing to read the tap with")
    // A live consult that is then switched off is closed, and its tap is gone.
    await rig.remote.push(Self.command("c3", "consult_started", #"{"opaque_id":"opq_on"}"#))
    try await R4Fixture.waitUntil { Self.tapFile(rig.root) != nil }
    let tap = try #require(Self.tapFile(rig.root))
    await rig.remote.push(Self.command("c4", "consult_started", #"{"opaque_id":"opq_on","buddy_off":true}"#))
    try await R4Fixture.waitUntil { rig.presenter.all.contains("close:opq_on") }
    #expect(Self.get(port: tap.port, path: "/tap/pcm?from=0&max=8", token: tap.token) == nil, "nothing is listening")
    #expect(Self.tapFile(rig.root) == nil)
    await rig.remote.push(Self.command("c5", "end_day"))
    try await R4Fixture.waitUntil { await rig.remote.acks.count == 5 }
    task.cancel()
    try await task.value
  }

  @Test func theServerStopsServingTheMomentTheKillSwitchLands() throws {
    let state = BuddyStateBox()
    let server = BuddyTapServer(token: String(repeating: "a", count: 64), opaqueID: "opq_x", state: state)
    let port = Int(try server.start())
    defer { server.stop() }
    let pcm = FileManager.default.temporaryDirectory.appendingPathComponent("buddy-kill-\(UUID().uuidString).pcm")
    try Self.fixturePCM.write(to: pcm)
    defer { try? FileManager.default.removeItem(at: pcm) }
    state.set(.init(recording: true, micState: "authorized", pcmURL: pcm, segmentID: "seg_1"))
    #expect(Self.get(port: port, path: "/tap/pcm?from=0&max=16", token: String(repeating: "a", count: 64))?.status == 200)
    server.stopServing()
    let refused = Self.get(port: port, path: "/tap/pcm?from=0&max=16", token: String(repeating: "a", count: 64))
    #expect(refused?.status == 403 && String(decoding: refused?.body ?? Data(), as: UTF8.self).contains("buddy_off"))
    #expect(Self.get(port: port, path: "/tap/pcm?from=0&max=16")?.status == 401, "a stranger still learns nothing")
  }

  // MARK: - The page

  @Test func thePageSaysRecordingAndMicSeparatelyWithTheOpaqueIDAndNothingElse() async throws {
    let rig = try await Self.rig(mic: "denied")
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    await rig.remote.push(Self.command("c1", "consult_started", #"{"opaque_id":"opq_page"}"#))
    try await R4Fixture.waitUntil { Self.tapFile(rig.root) != nil }
    let tap = try #require(Self.tapFile(rig.root))
    let page = try #require(Self.get(port: tap.port, path: "/encounter/opq_page"))
    #expect(page.status == 200)
    let html = String(decoding: page.body, as: UTF8.self)
    #expect(html.contains("Encounter Buddy") && html.contains("opq_page") && html.contains("not recording"))
    #expect(!html.lowercased().contains("copilot"))
    #expect(Self.get(port: tap.port, path: "/encounter/other_id")?.status == 404, "only the live consult has a page")
    try await R4Fixture.waitUntil {
      let reply = Self.get(port: tap.port, path: "/encounter/opq_page/state")
      return reply.flatMap { try? JSONSerialization.jsonObject(with: $0.body) as? [String: Any] }?["mic_state"] as? String == "denied"
    }
    let state = try #require(Self.get(port: tap.port, path: "/encounter/opq_page/state"))
    let object = try #require(try JSONSerialization.jsonObject(with: state.body) as? [String: Any])
    #expect(Set(object.keys) == ["opaque_id", "recording", "mic_state"], "nothing else: \(object.keys)")
    #expect(object["recording"] as? Bool == false && object["mic_state"] as? String == "denied" && object["opaque_id"] as? String == "opq_page")

    // Recording is true only with an open session.
    await rig.remote.push(Self.command("c2", "start_day"))
    try await R4Fixture.waitUntil {
      let reply = Self.get(port: tap.port, path: "/encounter/opq_page/state")
      return reply.flatMap { try? JSONSerialization.jsonObject(with: $0.body) as? [String: Any] }?["recording"] as? Bool == true
    }
    await rig.remote.push(Self.command("c3", "end_day"))
    try await R4Fixture.waitUntil {
      let reply = Self.get(port: tap.port, path: "/encounter/opq_page/state")
      return reply.flatMap { try? JSONSerialization.jsonObject(with: $0.body) as? [String: Any] }?["recording"] as? Bool == false
    }
    task.cancel()
    try await task.value
  }

  @Test func aMissingDeviceReadsAsInputDeviceNotReadyNotAsDenied() async throws {
    let missing = try RoomConfiguration(
      origin: #require(URL(string: "https://eta.test/")), roomSlug: "home-office", deviceUID: "device-unplugged",
      tapewriterPath: "/usr/bin/false", ffmpegPath: "/opt/ffmpeg", installID: "install_testfixture",
      tabID: "app_install_testfixture", updateChannel: "test")
    let rig = try await Self.rig(configuration: missing)
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    await rig.remote.push(Self.command("c1", "consult_started", #"{"opaque_id":"opq_dev"}"#))
    try await R4Fixture.waitUntil { Self.tapFile(rig.root) != nil }
    let tap = try #require(Self.tapFile(rig.root))
    try await R4Fixture.waitUntil {
      let reply = Self.get(port: tap.port, path: "/encounter/opq_dev/state")
      return reply.flatMap { try? JSONSerialization.jsonObject(with: $0.body) as? [String: Any] }?["mic_state"] as? String == "input_device_not_ready"
    }
    task.cancel()
    try await task.value
  }

  // MARK: - Never touch the room (A2-C17)

  @Test func theConsultCommandsLeaveTheRoomExactlyAsFound() async throws {
    let rig = try await Self.rig(mic: "denied")
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    try await R4Fixture.waitUntil { await rig.remote.pollCount >= 2 }
    func statusFacts() throws -> [String: String] {
      let data = try Data(contentsOf: rig.root.appendingPathComponent(RoomPersistence.statusFileName))
      var object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
      object.removeValue(forKey: "updated_at")
      object.removeValue(forKey: "last_poll_ok_at")
      return object.mapValues { "\($0)" }
    }
    let configBefore = try Data(contentsOf: rig.root.appendingPathComponent("config.json"))
    let statusBefore = try statusFacts()
    await rig.remote.push(Self.command("c1", "consult_started", #"{"opaque_id":"opq_room"}"#))
    await rig.remote.push(Self.command("c2", "consult_ended", #"{"opaque_id":"opq_room"}"#))
    try await R4Fixture.waitUntil { await rig.remote.acks.count == 2 }
    // One more status write after the commands.
    await rig.remote.push(Self.command("c3", "report_diag"))
    try await R4Fixture.waitUntil { await rig.remote.acks.count == 3 }
    let statusAfter = try statusFacts()
    #expect(statusAfter == statusBefore, "status.json says the same thing: \(statusBefore) vs \(statusAfter)")
    #expect(try Data(contentsOf: rig.root.appendingPathComponent("config.json")) == configBefore)
    #expect(rig.launcher.launchCount == 0, "no capture was started")
    #expect(rig.audio.volumeSets.isEmpty, "the input device was not touched")
    #expect(!FileManager.default.fileExists(atPath: rig.root.appendingPathComponent("auto-start-on").path))
    task.cancel()
    try await task.value
  }

  @Test func aRecordingIsNeitherStartedNorStoppedByTheConsult() async throws {
    let rig = try await Self.rig()
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    await rig.remote.push(Self.command("c1", "start_day"))
    try await R4Fixture.waitUntil { rig.launcher.launchCount == 1 }
    await rig.remote.push(Self.command("c2", "consult_started", #"{"opaque_id":"opq_rec"}"#))
    await rig.remote.push(Self.command("c3", "consult_ended", #"{"opaque_id":"opq_rec"}"#))
    try await R4Fixture.waitUntil { await rig.remote.acks.count == 3 }
    #expect(rig.launcher.launchCount == 1, "the capture was not restarted")
    let status = try Data(contentsOf: rig.root.appendingPathComponent(RoomPersistence.statusFileName))
    #expect(String(decoding: status, as: UTF8.self).contains("\"recording\""))
    task.cancel()
    try await task.value
  }

  // MARK: - Focus, uids, naming (source-level, because the window server is not here)

  static func sourceWithoutComments(_ name: String) throws -> String {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/RoomRecorderCore/\(name)")
    return try String(contentsOf: url, encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: false)
      .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
  }

  @Test func theWindowPolicyNeverStealsFocus() throws {
    #expect(!BuddyWindowPolicy.becomesKey && !BuddyWindowPolicy.activatesApp && !BuddyWindowPolicy.floatsAboveOtherApps)
    #expect(BuddyWindowPolicy.hasCloseControl, "the hide control")
    #expect(BuddyWindowPolicy.title == "Encounter Buddy")
    let code = try Self.sourceWithoutComments("BuddyWindow.swift")
    for forbidden in [".activate(", "activateIgnoringOtherApps", "orderFrontRegardless", "makeKey", "makeMain", "becomeKey", ".floating", ".statusBar", ".modalPanel", "NSWorkspace", "Process(", "osascript", "python3", "open -a"] {
      #expect(!code.contains(forbidden), "BuddyWindow.swift must not use \(forbidden)")
    }
    #expect(code.contains("nonactivatingPanel") && code.contains("canBecomeKey"))
  }

  @Test func noUidAndNoCopilotAnywhereInTheBuddySources() throws {
    for name in ["BuddyTap.swift", "BuddyConsult.swift", "BuddyWindow.swift"] {
      let code = try Self.sourceWithoutComments(name).lowercased()
      for forbidden in ["doctor_uid", "consult_uid", "presc_uid", "copilot", "sarvam"] {
        #expect(!code.contains(forbidden), "\(name) mentions \(forbidden)")
      }
    }
  }

  // MARK: - FU-RR0140-VOL and ADDENDUM 2

  @Test func everyDeviceOpenPutsTheStoredVolumeBackAndLogsBeforeAndAfter() async throws {
    let audio = R4AudioInputs.standard(deviceA: .init(volume: 0.02, settable: true))
    let rig = try await Self.rig(audio: audio)
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    await rig.remote.push(Self.command("c1", "start_day"))
    try await R4Fixture.waitUntil { rig.launcher.launchCount == 1 }
    #expect(audio.volumeSets.map(\.value) == [1.0], "default is 1.0")
    #expect(rig.logs.all.contains("input volume on open: before 0.020, after 1.000, stored 1.000"))
    // Pause and resume reopens the device: applied again, and from the stored value once the desk has set one.
    audio.setVolume(0.05, uid: "device-a")
    RoomInputVolumeStore(root: rig.root).remember(0.7, forUID: "device-a")
    await rig.remote.push(Self.command("c2", "pause_day"))
    try await R4Fixture.waitUntil { await rig.remote.acks.count == 2 }
    await rig.remote.push(Self.command("c3", "resume_day"))
    try await R4Fixture.waitUntil { rig.launcher.launchCount == 2 }
    #expect(audio.volumeSets.map(\.value) == [1.0, 0.7])
    #expect(rig.logs.all.contains("input volume on open: before 0.050, after 0.700, stored 0.700"))
    await rig.remote.push(Self.command("c4", "end_day"))
    try await R4Fixture.waitUntil { await rig.remote.acks.count == 4 }
    task.cancel()
    try await task.value
  }

  @Test func aVolumeTheDeviceWillNotTakeIsLeftAsFound() async throws {
    let audio = R4AudioInputs.standard(deviceA: .init(volume: 0.3, settable: false))
    let rig = try await Self.rig(audio: audio)
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    await rig.remote.push(Self.command("c1", "start_day"))
    try await R4Fixture.waitUntil { rig.launcher.launchCount == 1 }
    #expect(audio.volumeSets.isEmpty)
    #expect(rig.logs.all.contains("input volume on open: 0.300 not settable; left as found"))
    await rig.remote.push(Self.command("c2", "end_day"))
    try await R4Fixture.waitUntil { await rig.remote.acks.count == 2 }
    task.cancel()
    try await task.value
  }

  @Test func theZeroWatchdogNamesTheEpisodeOnceAndRearms() {
    var watchdog = CoreAudioZeroWatchdog()
    let t0 = Date(timeIntervalSince1970: 1_000_000)
    func step(_ ratio: Double?, _ recording: Bool, at seconds: TimeInterval) -> Bool {
      watchdog.observe(zeroRatio: ratio, recording: recording, now: t0.addingTimeInterval(seconds))
    }
    #expect(!step(1, true, at: 0))
    #expect(!step(1, true, at: 119))
    #expect(step(1, true, at: 120), "named at 120 s")
    #expect(!step(1, true, at: 400), "once per episode")
    #expect(!step(0.2, true, at: 401), "audio ends the episode")
    #expect(!step(1, true, at: 402))
    #expect(step(1, true, at: 522), "a new episode names again")
    // Not a measurement, or not recording: never.
    watchdog = CoreAudioZeroWatchdog()
    #expect(!step(nil, true, at: 0))
    #expect(!step(nil, true, at: 500))
    #expect(!step(1, false, at: 900))
    #expect(CoreAudioZeroWatchdog.eventName == "capture_zero_coreaudio_suspect")
  }

  @Test func exactZerosWithTheMicAuthorisedAndTheDeviceAttachedAreLoggedDistinctly() async throws {
    // R4FakeLauncher's device-a writes exact zeros (peak 0, zero_ratio 1).
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(try R4Fixture.configuration())
    let remote = PushRemote()
    let logs = LockedList<String>()
    let audio = R4AudioInputs.standard()
    let engine = try await RoomEngine.load(
      rootURL: root, enrolmentReader: R4Fixture.enrolled, remoteFactory: { _ in remote },
      captureLauncher: R4FakeLauncher(), pieceRunner: R4FakeEncoder(), updaterFactory: { _, _, _ in nil },
      log: { logs.append($0) }, audioInputs: audio, inputReadyWait: .disabled,
      machineFacts: { uid in audio.facts(forUID: uid) })
    await engine.setMicStateProvider { "authorized" }
    final class Clock: @unchecked Sendable {
      private let lock = NSLock(); private var offset: TimeInterval = 0
      var now: Date { lock.withLock { Date().addingTimeInterval(offset) } }
      func jump(_ seconds: TimeInterval) { lock.withLock { offset += seconds } }
    }
    let clock = Clock()
    await engine.setRecoveryClock { clock.now }
    let task = Task { try await engine.run() }
    await remote.push(Self.command("c1", "start_day"))
    try await R4Fixture.waitUntil { await remote.acks.count == 1 }
    // Two engine passes see the zeros first, so the episode has a start before the clock moves.
    try await Task.sleep(nanoseconds: 4_000_000_000)
    clock.jump(130)
    try await R4Fixture.waitUntil { logs.all.contains { $0.hasPrefix("capture_zero_coreaudio_suspect") } }
    clock.jump(300)
    try await Task.sleep(nanoseconds: 400_000_000)
    #expect(logs.all.filter { $0.hasPrefix("capture_zero_coreaudio_suspect") }.count == 1, "once")
    await remote.push(Self.command("c2", "end_day"))
    try await R4Fixture.waitUntil { await remote.acks.count == 2 }
    task.cancel()
    try await task.value
  }

  // MARK: - displays_count (ADDENDUM 4)

  @Test func displaysCountRidesThePollAsAnIntegerAndNothingAboutTheDisplays() {
    func items(_ fields: InstallPollFields) -> [String: String] {
      Dictionary(uniqueKeysWithValues: fields.queryItems().map { ($0.name, $0.value ?? "") })
    }
    var facts = R4AudioInputs.standard().facts(forUID: "device-a")
    facts.displaysCount = 2
    let measured = InstallPollFields(installID: "install_x", facts: facts, tapeAdvancing: false)
    #expect(items(measured)["displays_count"] == "2")
    facts.displaysCount = nil
    #expect(items(InstallPollFields(installID: "install_x", facts: facts, tapeAdvancing: false))["displays_count"] == nil, "absent when not measured")
    #expect(!items(measured).keys.contains { $0.contains("display") && $0 != "displays_count" })
    let count = MachineFactsReader.displaysCount()
    #expect(count == nil || count! >= 0)
  }
}
