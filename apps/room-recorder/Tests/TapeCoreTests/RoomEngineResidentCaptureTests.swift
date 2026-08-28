import Foundation
import RoomRecorderCore
import Testing

@Suite(.serialized) struct RoomEngineResidentCaptureTests {
  @Test func disabledConfigurationNeverConstructsResidentOwner() async throws {
    let root = try configuredRoot(enabled: false, receipt: nil)
    defer { try? FileManager.default.removeItem(at: root) }
    let probe = ResidentFactoryProbe()

    _ = try await RoomEngine.load(
      rootURL: root,
      residentCaptureFactory: { _, _ in probe.makeOwner() }
    )

    #expect(probe.factoryCalls == 0)
  }

  @Test func enabledConfigurationFailsClosedBeforeConstructingOwner() async throws {
    let missingRoot = try configuredRoot(enabled: true, receipt: nil)
    defer { try? FileManager.default.removeItem(at: missingRoot) }
    let missingProbe = ResidentFactoryProbe()
    do {
      _ = try await RoomEngine.load(
        rootURL: missingRoot,
        residentCaptureFactory: { _, _ in missingProbe.makeOwner() }
      )
      Issue.record("expected missing preflight refusal")
    } catch {
      #expect(error as? RoomEngineError == .residentArchivePreflightRequired)
    }
    #expect(missingProbe.factoryCalls == 0)

    let mismatchRoot = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: mismatchRoot) }
    let receipt = try preflightReceipt(root: URL(fileURLWithPath: "/private/other"))
    try RoomPersistence(root: mismatchRoot).saveConfiguration(
      configuration(enabled: true, receipt: receipt))
    do {
      _ = try await RoomEngine.load(
        rootURL: mismatchRoot,
        residentCaptureFactory: { _, _ in missingProbe.makeOwner() }
      )
      Issue.record("expected mismatched preflight refusal")
    } catch {
      #expect(error as? RoomEngineError == .residentArchivePreflightMismatch)
    }
    #expect(missingProbe.factoryCalls == 0)
  }

  @Test func eligibleConfigurationRequiresConcreteRuntime() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))

    do {
      _ = try await RoomEngine.load(rootURL: root)
      Issue.record("expected unavailable runtime refusal")
    } catch {
      #expect(error as? RoomEngineError == .residentArchiveRuntimeUnavailable)
    }
  }

  @Test func eligibleRuntimeOwnsStartServiceLevelsAndCancellationStop() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    let remote = ResidentCaptureRemote()
    let launcher = RefusingCaptureLauncher()
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: launcher,
      residentCaptureFactory: { _, archiveRoot in
        #expect(archiveRoot == root.standardizedFileURL)
        return probe.makeOwner()
      }
    )

    let task = Task { try await engine.run() }
    try await waitUntil {
      guard probe.owner.startContexts.count == 1 else { return false }
      return await remote.pollCalls() > 0
    }
    task.cancel()
    try await task.value

    #expect(probe.factoryCalls == 1)
    #expect(launcher.launchCalls == 0)
    #expect(
      probe.owner.startContexts == [
        RoomResidentCaptureStartContext(
          roomID: "room_1",
          sessionID: "bs_resident",
          nextPrimaryIndex: 12,
          trigger: .reconciliation)
      ])
    #expect(probe.owner.serviceCalls > 0)
    #expect(probe.owner.stopReasons == [.cancelled])
    #expect(await remote.lastLevels() == BenchLevelPair(peak: 0.75, average: 0.25))
  }

  @Test func residentRuntimeReceivesPauseResumeAndEndLifecycle() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    let remote = ResidentCommandRemote()
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      residentCaptureFactory: { _, _ in probe.makeOwner() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 3 }
    task.cancel()
    try await task.value

    #expect(probe.owner.startContexts.count == 2)
    #expect(probe.owner.startContexts.map(\.nextPrimaryIndex) == [12, 12])
    #expect(probe.owner.startContexts.allSatisfy { $0.nextBackupIndex == nil })
    #expect(
      probe.owner.startContexts.map(\.trigger) == [
        .reconciliation,
        .resumeDay(commandID: "cmd_resume"),
      ])
    #expect(
      probe.owner.stopReasons == [
        .pause(commandID: "cmd_pause"),
        .end(commandID: "cmd_end"),
      ])
    #expect(await remote.patchedActions() == [.pause, .resume, .end])
    #expect(await remote.acknowledgedCommands() == ["cmd_pause", "cmd_resume", "cmd_end"])
  }

  @Test func residentLossFailsTheEngineAndStopsAdvertisingARecording() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.owner.deactivateOnNextServiceAndFailRestart()
    let remote = ResidentCaptureRemote()
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      residentCaptureFactory: { _, _ in probe.makeOwner() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil {
      let recordingSessionID = await remote.lastRecordingSessionID()
      let status = try? RoomPersistence(root: root).loadStatus()
      return probe.owner.serviceCalls > 0 && recordingSessionID == nil && status?.state == .failed
    }
    task.cancel()
    try await task.value

    #expect(probe.owner.serviceCalls > 0)
    #expect(probe.owner.stopReasons == [.startupFailed])
    #expect(probe.owner.startsWhileFinalizationRequired == 0)
  }

  @Test func failedFinalizationRemainsRetryableAndCannotEndTheSessionEarly() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.owner.failNextFinalizationAfterDeactivation()
    let remote = ResidentRetryEndRemote()
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      residentCaptureFactory: { _, _ in probe.makeOwner() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 2 }
    task.cancel()
    try await task.value

    #expect(
      probe.owner.stopReasons == [
        .end(commandID: "cmd_end_1"),
        .end(commandID: "cmd_end_2"),
      ])
    #expect(
      await remote.acknowledgements() == [
        ResidentCommandAck(id: "cmd_end_1", ok: false),
        ResidentCommandAck(id: "cmd_end_2", ok: true),
      ])
    #expect(await remote.patchedActions() == [.end])
  }

  @Test func cancellationSurfacesAnUnfinishedResidentBoundary() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.owner.failNextFinalizationAfterDeactivation()
    let remote = ResidentCaptureRemote()
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      residentCaptureFactory: { _, _ in probe.makeOwner() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.pollCalls() > 0 }
    task.cancel()
    do {
      try await task.value
      Issue.record("expected unfinished resident boundary")
    } catch {
      #expect(error as? ResidentCaptureTestError == .finalizationFailed)
    }

    #expect(try RoomPersistence(root: root).loadStatus().state == .failed)
    #expect(probe.owner.requiresFinalization)
  }

  @Test func supersessionRetriesCleanupWithoutReconciliationOrRestart() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.owner.failNextFinalizationAfterDeactivation()
    let remote = ResidentSupersededRemote()
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      residentCaptureFactory: { _, _ in probe.makeOwner() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil { probe.owner.stopReasons.count == 2 }

    #expect(probe.owner.stopReasons == [.superseded, .superseded])
    #expect(probe.owner.startContexts.count == 1)
    #expect(probe.owner.startsWhileFinalizationRequired == 0)
    #expect(await remote.activeSessionCalls() == 1)

    task.cancel()
    _ = await task.result
  }

  private func configuredRoot(
    enabled: Bool,
    receipt: RoomArchivePreflightReceipt?
  ) throws -> URL {
    let root = try temporaryRoot()
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: enabled, receipt: receipt))
    return root
  }

  private func temporaryRoot() throws -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(
      "room-engine-resident-\(UUID().uuidString)",
      isDirectory: true
    ).standardizedFileURL
  }

  private func configuration(
    enabled: Bool,
    receipt: RoomArchivePreflightReceipt?
  ) throws -> RoomConfiguration {
    try RoomConfiguration(
      origin: #require(URL(string: "https://eta.test/")),
      roomSlug: "home-office",
      deviceUID: "device-stable-1",
      tapewriterPath: "/usr/bin/false",
      ffmpegPath: "/opt/ffmpeg",
      residentArchiveCaptureEnabled: enabled,
      archivePreflightReceipt: receipt
    )
  }

  private func preflightReceipt(root: URL) throws -> RoomArchivePreflightReceipt {
    try RoomArchivePreflightReceipt(
      origin: #require(URL(string: "https://eta.test/")),
      roomSlug: "home-office",
      deviceUID: "device-stable-1",
      ffmpegPath: "/opt/ffmpeg",
      archiveRootPath: root.standardizedFileURL.path,
      archiveProbeSucceeded: true,
      keyProbeSucceeded: true,
      encoderProbeSucceeded: true,
      secureEnclavePublicKeySHA256: String(repeating: "a", count: 64),
      encoderProvenanceID: "ffmpeg-pinned-build-1",
      completedAt: Date(timeIntervalSince1970: 1_777_000_000)
    )
  }

  private func waitUntil(_ condition: @escaping @Sendable () async -> Bool) async throws {
    for _ in 0..<500 {
      if await condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("timed out waiting for resident capture lifecycle")
  }
}

private final class ResidentFactoryProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var calls = 0
  let owner = ResidentCaptureOwner()

  var factoryCalls: Int { lock.withLock { calls } }

  func makeOwner() -> any RoomResidentCaptureOwning {
    lock.withLock { calls += 1 }
    return owner
  }
}

private final class ResidentCaptureOwner: RoomResidentCaptureOwning, @unchecked Sendable {
  private let lock = NSLock()
  private var active = false
  private var primaryIndex = 0
  private var backupIndex: Int?
  private var finalizationRequired = false
  private var shouldDeactivateOnService = false
  private var shouldFailRestart = false
  private var finalizationFailuresRemaining = 0
  private var unsafeStarts = 0
  private var starts: [RoomResidentCaptureStartContext] = []
  private var services = 0
  private var stops: [RoomResidentCaptureStopReason] = []

  var isActive: Bool { lock.withLock { active } }
  var requiresFinalization: Bool { lock.withLock { finalizationRequired } }
  var nextPrimaryIndex: Int { lock.withLock { primaryIndex } }
  var nextBackupIndex: Int? { lock.withLock { backupIndex } }
  var startContexts: [RoomResidentCaptureStartContext] { lock.withLock { starts } }
  var serviceCalls: Int { lock.withLock { services } }
  var stopReasons: [RoomResidentCaptureStopReason] { lock.withLock { stops } }
  var startsWhileFinalizationRequired: Int { lock.withLock { unsafeStarts } }

  func start(context: RoomResidentCaptureStartContext) throws {
    let restartMustFail = lock.withLock {
      if finalizationRequired { unsafeStarts += 1 }
      return shouldFailRestart && !starts.isEmpty
    }
    if restartMustFail { throw ResidentCaptureTestError.restartFailed }
    lock.withLock {
      starts.append(context)
      primaryIndex = context.nextPrimaryIndex
      backupIndex = context.nextBackupIndex
      active = true
      finalizationRequired = true
    }
  }

  func service() throws {
    lock.withLock {
      services += 1
      if shouldDeactivateOnService {
        shouldDeactivateOnService = false
        active = false
      }
    }
  }

  func stopAndFinalize(reason: RoomResidentCaptureStopReason) throws {
    let shouldFail = lock.withLock {
      stops.append(reason)
      active = false
      if finalizationFailuresRemaining > 0 {
        finalizationFailuresRemaining -= 1
        return true
      }
      finalizationRequired = false
      return false
    }
    if shouldFail { throw ResidentCaptureTestError.finalizationFailed }
  }

  func currentLevels() -> BenchLevelPair? {
    BenchLevelPair(peak: 0.75, average: 0.25)
  }

  func deactivateOnNextServiceAndFailRestart() {
    lock.withLock {
      shouldDeactivateOnService = true
      shouldFailRestart = true
    }
  }

  func failNextFinalizationAfterDeactivation() {
    lock.withLock { finalizationFailuresRemaining += 1 }
  }
}

private final class RefusingCaptureLauncher: RoomCaptureLaunching, @unchecked Sendable {
  private let lock = NSLock()
  private var calls = 0
  var launchCalls: Int { lock.withLock { calls } }

  func launch(executable: URL, outputDirectory: URL, deviceUID: String, logURL: URL) throws
    -> any RoomCaptureProcess
  {
    lock.withLock { calls += 1 }
    throw ResidentCaptureTestError.unexpectedLegacyCapture
  }
}

private actor ResidentCaptureRemote: RoomEngineRemote {
  private var polls = 0
  private var levels: BenchLevelPair?
  private var recordingSessionID: String?

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    try JSONDecoder().decode(
      ActiveSessionResponse.self,
      from: Data(
        #"{"ok":true,"resumable":true,"session":{"id":"bs_resident","room_id":"room_1","label":null,"mic_label":"device-stable-1","status":"recording","started_at":null,"last_any_chunk_at":null},"next_idx":{"primary":12,"backup":34},"reason":null,"handover_pending":false,"tab_gone":false}"#
          .utf8
      )
    )
  }

  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func pollCommands(
    tabID: String,
    previousPollAt: String?,
    recordingSessionID: String?,
    paused: Bool,
    primaryLevels: BenchLevelPair?
  ) async throws -> CommandPollResponse {
    polls += 1
    levels = primaryLevels
    self.recordingSessionID = recordingSessionID
    return try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(
        #"{"ok":true,"room_id":"room_1","superseded":false,"commands":[]}"#.utf8)
    )
  }

  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func pollCalls() -> Int { polls }
  func lastLevels() -> BenchLevelPair? { levels }
  func lastRecordingSessionID() -> String? { recordingSessionID }
}

private actor ResidentCommandRemote: RoomEngineRemote {
  private var commandsReturned = false
  private var actions: [BenchSessionAction] = []
  private var acknowledgements: [String] = []

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    try residentActiveSession()
  }

  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  {
    actions.append(action)
    return try JSONDecoder().decode(BenchOKResponse.self, from: Data(#"{"ok":true}"#.utf8))
  }

  func pollCommands(
    tabID: String,
    previousPollAt: String?,
    recordingSessionID: String?,
    paused: Bool,
    primaryLevels: BenchLevelPair?
  ) async throws -> CommandPollResponse {
    let commands: String
    if commandsReturned {
      commands = "[]"
    } else {
      commandsReturned = true
      commands =
        #"[{"id":"cmd_pause","kind":"pause_day","args":{},"created_at":null},{"id":"cmd_resume","kind":"resume_day","args":{},"created_at":null},{"id":"cmd_end","kind":"end_day","args":{},"created_at":null}]"#
    }
    return try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(
        "{\"ok\":true,\"room_id\":\"room_1\",\"superseded\":false,\"commands\":\(commands)}"
          .utf8)
    )
  }

  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  {
    guard ok else { throw ResidentCaptureTestError.unexpectedRemoteCall }
    acknowledgements.append(commandID)
    return try JSONDecoder().decode(
      CommandAcknowledgement.self,
      from: Data("{\"ok\":true,\"id\":\"\(commandID)\",\"status\":\"acked\"}".utf8))
  }

  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func acknowledgementCount() -> Int { acknowledgements.count }
  func acknowledgedCommands() -> [String] { acknowledgements }
  func patchedActions() -> [BenchSessionAction] { actions }
}

private struct ResidentCommandAck: Equatable, Sendable {
  let id: String
  let ok: Bool
}

private actor ResidentRetryEndRemote: RoomEngineRemote {
  private var nextCommand = 0
  private var actions: [BenchSessionAction] = []
  private var commandAcks: [ResidentCommandAck] = []

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    try residentActiveSession()
  }

  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  {
    actions.append(action)
    return try JSONDecoder().decode(BenchOKResponse.self, from: Data(#"{"ok":true}"#.utf8))
  }

  func pollCommands(
    tabID: String,
    previousPollAt: String?,
    recordingSessionID: String?,
    paused: Bool,
    primaryLevels: BenchLevelPair?
  ) async throws -> CommandPollResponse {
    let commands: String
    switch nextCommand {
    case 0:
      commands =
        #"[{"id":"cmd_end_1","kind":"end_day","args":{},"created_at":null}]"#
    case 1:
      commands =
        #"[{"id":"cmd_end_2","kind":"end_day","args":{},"created_at":null}]"#
    default:
      commands = "[]"
    }
    nextCommand += 1
    return try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(
        "{\"ok\":true,\"room_id\":\"room_1\",\"superseded\":false,\"commands\":\(commands)}"
          .utf8)
    )
  }

  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  {
    commandAcks.append(ResidentCommandAck(id: commandID, ok: ok))
    return try JSONDecoder().decode(
      CommandAcknowledgement.self,
      from: Data("{\"ok\":true,\"id\":\"\(commandID)\",\"status\":\"acked\"}".utf8))
  }

  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func acknowledgementCount() -> Int { commandAcks.count }
  func acknowledgements() -> [ResidentCommandAck] { commandAcks }
  func patchedActions() -> [BenchSessionAction] { actions }
}

private actor ResidentSupersededRemote: RoomEngineRemote {
  private var activeCalls = 0

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    activeCalls += 1
    return try residentActiveSession()
  }

  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func pollCommands(
    tabID: String,
    previousPollAt: String?,
    recordingSessionID: String?,
    paused: Bool,
    primaryLevels: BenchLevelPair?
  ) async throws -> CommandPollResponse {
    try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(#"{"ok":true,"room_id":"room_1","superseded":true,"commands":[]}"#.utf8)
    )
  }

  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func activeSessionCalls() -> Int { activeCalls }
}

private func residentActiveSession() throws -> ActiveSessionResponse {
  try JSONDecoder().decode(
    ActiveSessionResponse.self,
    from: Data(
      #"{"ok":true,"resumable":true,"session":{"id":"bs_resident","room_id":"room_1","label":null,"mic_label":"device-stable-1","status":"recording","started_at":null,"last_any_chunk_at":null},"next_idx":{"primary":12,"backup":34},"reason":null,"handover_pending":false,"tab_gone":false}"#
        .utf8
    )
  )
}

private enum ResidentCaptureTestError: Error, Equatable {
  case unexpectedLegacyCapture
  case unexpectedRemoteCall
  case finalizationFailed
  case restartFailed
}
