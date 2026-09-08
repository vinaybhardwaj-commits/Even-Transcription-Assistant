import Foundation
import RoomRecorderCore
import Testing

@Suite(.serialized) struct RoomEngineRecoveryBarrierTests {
  @Test func pendingRecoveryBlocksInitialSessionAdoption() async throws {
    let root = try configuredRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = RecoveryBarrierRemote()
    let recovery = PendingRecovery()
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      retainedArchiveRecovery: recovery
    )

    let task = Task { try await engine.run() }
    try await waitForPoll(remote)
    task.cancel()
    try await task.value

    #expect(await remote.activeSessionCalls() == 0)
    #expect(await recovery.wasCancelled())
  }

  @Test func disabledRecoveryKeepsLegacyInitialAdoption() async throws {
    let root = try configuredRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = RecoveryBarrierRemote()
    let engine = try await RoomEngine.load(rootURL: root, remoteFactory: { _ in remote })

    let task = Task { try await engine.run() }
    try await waitForPoll(remote)
    task.cancel()
    try await task.value

    #expect(await remote.activeSessionCalls() == 1)
  }

  private func configuredRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "room-engine-recovery-\(UUID().uuidString)",
      isDirectory: true
    )
    let configuration = try RoomConfiguration(
      origin: #require(URL(string: "https://eta.test")),
      roomSlug: "home-office",
      deviceUID: "device-stable-1",
      tapewriterPath: "/usr/bin/false",
      ffmpegPath: "/usr/bin/false"
    )
    try RoomPersistence(root: root).saveConfiguration(configuration)
    return root
  }

  private func waitForPoll(_ remote: RecoveryBarrierRemote) async throws {
    for _ in 0..<100 {
      if await remote.pollCalls() > 0 { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("engine did not reach command polling")
  }
}

private actor PendingRecovery: RoomRetainedArchiveRecovering {
  private var cancelled = false

  func run() async {
    do {
      try await Task.sleep(for: .seconds(60))
    } catch is CancellationError {
      cancelled = true
    } catch {}
  }

  func state() -> RoomRetainedArchiveRecoveryState { .pending }
  func wasCancelled() -> Bool { cancelled }
}

private actor RecoveryBarrierRemote: RoomEngineRemote {
  private var activeCalls = 0
  private var polls = 0

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    activeCalls += 1
    return try JSONDecoder().decode(
      ActiveSessionResponse.self,
      from: Data(
        #"{"ok":true,"resumable":false,"session":null,"next_idx":{"primary":0,"backup":0},"reason":null,"handover_pending":false,"tab_gone":false}"#
          .utf8
      )
    )
  }

  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    throw RecoveryBarrierStubError.unexpectedCall
  }

  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  {
    throw RecoveryBarrierStubError.unexpectedCall
  }

  func pollCommands(
    tabID: String,
    previousPollAt: String?,
    recordingSessionID: String?,
    paused: Bool,
    primaryLevels: BenchLevelPair?,
    install: InstallPollFields?
  ) async throws -> CommandPollResponse {
    polls += 1
    return try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(#"{"ok":true,"superseded":false,"commands":[]}"#.utf8)
    )
  }

  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  {
    throw RecoveryBarrierStubError.unexpectedCall
  }

  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw RecoveryBarrierStubError.unexpectedCall
  }

  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  {
    throw RecoveryBarrierStubError.unexpectedCall
  }

  func activeSessionCalls() -> Int { activeCalls }
  func pollCalls() -> Int { polls }
}

private enum RecoveryBarrierStubError: Error {
  case unexpectedCall
}
