import Foundation
import Testing

@testable import RoomRecorderCore

/// 0.1.17 — a re-enrolled Mac must never poll as a retired install id.
///
/// ─── THE LOOP THESE TESTS CLOSE (11 Sep, Home Office) ────────────────────────────────────────
/// Bootstrap installs 0.1.8, whose enrol writes the new id into config.json and never touches
/// `room-session.json`. 0.1.8 self-updates; the new build reads the file an EARLIER install left,
/// which outranked config.json, polls as that retired id, takes 409 RETIRED and stops for ever.
/// Four pastes died that way before the id was fixed by hand in the file.
///
/// Every engine test here reads the REAL session file from a temporary root — no injected reader —
/// because the file is the thing that was wrong.
@Suite struct RoomStaleIdentityTests {

  static let retiredID = "install_staleretired"
  static let enrolledID = "install_newlyenrolled"

  static func makeRoot() throws -> URL {
    let root = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("0117 stale identity \(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  static func writeConfiguration(root: URL, installID: String, channel: String = "stable") throws {
    let configuration = try RoomConfiguration(
      origin: #require(URL(string: "https://eta.test")),
      roomSlug: "home-office",
      deviceUID: "device-stale-identity",
      tapewriterPath: "/usr/bin/false",
      ffmpegPath: "/usr/bin/false",
      installID: installID,
      tabID: "app_\(installID)",
      updateChannel: channel)
    try RoomPersistence(root: root).saveConfiguration(configuration)
  }

  static func writeSessionFile(root: URL, installID: String, token: String = "room.session.jwt")
    throws
  {
    try RoomSessionStore.save(
      RoomKeychainRecord(
        session: token, installID: installID, roomSlug: "home-office", roomName: "Home Office",
        origin: "https://eta.test"),
      root: root)
  }

  static func sessionFileRecord(root: URL) -> RoomKeychainRecord? {
    guard case .ok(let record) = RoomSessionStore.readFile(root: root) else { return nil }
    return record
  }

  /// Waits for the engine's polls to reach `count`, then lets it run a little longer so a poll
  /// that should NOT happen has the chance to.
  static func settle(_ remote: IdentityRecordingRemote, polls count: Int) async throws {
    for _ in 0..<300 {
      if await remote.polls.count >= count { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    try await Task.sleep(for: .milliseconds(400))
  }

  // MARK: - (a) enrol owns the session file

  @Test func enrolOverAStaleSessionFileLeavesItNamingTheNewInstall() throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    // What Home Office had on disk before each 11 Sep paste: an earlier install's config and file.
    try Self.writeConfiguration(root: root, installID: Self.retiredID, channel: "test")
    try Self.writeSessionFile(root: root, installID: Self.retiredID, token: "old.session.jwt")

    let response = try JSONDecoder().decode(
      RoomEnrolmentResponse.self,
      from: Data(
        #"{"install_id":"\#(Self.enrolledID)","room_slug":"home-office","room_name":"Home Office","session":{"token":"new.session.jwt","expires_at":"2027-09-11T00:00:00Z"}}"#
          .utf8))
    let configuration = try RoomEnrolment.persist(
      response,
      origin: #require(URL(string: "https://www.evenscribe.app")),
      root: root,
      tapewriterPath: nil,
      ffmpegPath: nil,
      firstEnrolConfiguration: {
        Issue.record("a Mac with a config.json is a re-enrol, not a first enrol")
        throw RoomConfigurationError.invalidDeviceUID
      })

    let file = try #require(Self.sessionFileRecord(root: root))
    #expect(file.installID == Self.enrolledID)
    #expect(file.session == "new.session.jwt")
    let onDisk = try RoomPersistence(root: root).loadConfiguration()
    #expect(onDisk.installID == Self.enrolledID)
    #expect(onDisk.tabID == "app_\(Self.enrolledID)")
    #expect(configuration.installID == file.installID)
  }

  // MARK: - (b) a disagreement means the file is stale, and config wins

  @Test func aSessionFileThatDisagreesWithConfigLosesAndIsRewritten() async throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    // The 11 Sep state after the 0.1.8 enrol: config.json new, the file an earlier install's.
    try Self.writeConfiguration(root: root, installID: Self.enrolledID)
    try Self.writeSessionFile(root: root, installID: Self.retiredID, token: "room.session.jwt")

    let remote = IdentityRecordingRemote(answers: [.ok])
    let logged = IdentityLoggedLines()
    let engine = try await RoomEngine.load(
      rootURL: root, remoteFactory: { _ in remote }, log: { logged.append($0) })
    let task = Task { try await engine.run() }
    try await Self.settle(remote, polls: 1)
    task.cancel()
    _ = await task.result

    let polls = await remote.polls
    #expect(!polls.isEmpty, "the engine never reached a poll")
    #expect(polls.allSatisfy { $0.tabID == "app_\(Self.enrolledID)" })
    #expect(polls.allSatisfy { $0.installID == Self.enrolledID })
    #expect(await remote.activeSessionTabIDs.allSatisfy { $0 == "app_\(Self.enrolledID)" })

    let file = try #require(Self.sessionFileRecord(root: root))
    #expect(file.installID == Self.enrolledID)
    #expect(file.session == "room.session.jwt", "the token is the room's and is kept")
    #expect(
      logged.all.contains(
        "room session install id \(Self.retiredID) disagrees with config \(Self.enrolledID); config wins, session file rewritten"
      ))
  }

  @Test func aSessionFileThatAgreesWithConfigIsLeftExactlyAsItWas() async throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try Self.writeConfiguration(root: root, installID: Self.enrolledID)
    try Self.writeSessionFile(root: root, installID: Self.enrolledID)
    let before = try Data(contentsOf: RoomSessionStore.url(root: root))

    let remote = IdentityRecordingRemote(answers: [.ok])
    let logged = IdentityLoggedLines()
    let engine = try await RoomEngine.load(
      rootURL: root, remoteFactory: { _ in remote }, log: { logged.append($0) })
    let task = Task { try await engine.run() }
    try await Self.settle(remote, polls: 1)
    task.cancel()
    _ = await task.result

    #expect(await remote.polls.allSatisfy { $0.installID == Self.enrolledID })
    #expect(try Data(contentsOf: RoomSessionStore.url(root: root)) == before)
    #expect(!logged.all.contains { $0.contains("disagrees with config") })
  }

  // MARK: - (c) one retry on 409 RETIRED, for a session-file id, and never a second

  @Test func retiredFromTheSessionFileRetriesOnceAsConfigThenStops() async throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    // Launch sees the two agreeing, so the id in use is the session file's. Then a re-enrol
    // rewrites config.json underneath the running process — the case launch cannot see — and the
    // server retires the id the file named.
    try Self.writeConfiguration(root: root, installID: Self.retiredID)
    try Self.writeSessionFile(root: root, installID: Self.retiredID)

    let remote = IdentityRecordingRemote(
      answers: [.retired(thenReEnrolAs: Self.enrolledID, root: root), .retired(), .ok, .ok])
    let logged = IdentityLoggedLines()
    let engine = try await RoomEngine.load(
      rootURL: root, remoteFactory: { _ in remote }, log: { logged.append($0) })
    let task = Task { try await engine.run() }
    try await Self.settle(remote, polls: 2)
    task.cancel()
    _ = await task.result

    let polls = await remote.polls
    // EXACTLY two: the refused one, and the one retry. The `.ok` answers queued behind them are
    // there so a third poll would succeed if the engine tried one — it must not.
    #expect(polls.count == 2)
    #expect(polls.first?.installID == Self.retiredID)
    #expect(polls.last?.installID == Self.enrolledID)
    #expect(polls.last?.tabID == "app_\(Self.enrolledID)")
    // Discarded, because it still named the refused id; and not written back, because the retry
    // was refused too.
    #expect(!FileManager.default.fileExists(atPath: RoomSessionStore.url(root: root).path))
    #expect(
      logged.all.contains(
        "poll refused (409 RETIRED) for install \(Self.retiredID) from room-session.json; file discarded; retrying once as config install \(Self.enrolledID)"
      ))
    #expect(
      logged.all.contains("retry as install \(Self.enrolledID) also refused (409 RETIRED); stopping"))
  }

  @Test func aRetryThatIsAcceptedWritesTheSessionFileBack() async throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try Self.writeConfiguration(root: root, installID: Self.retiredID)
    try Self.writeSessionFile(root: root, installID: Self.retiredID, token: "room.session.jwt")

    let remote = IdentityRecordingRemote(
      answers: [.retired(thenReEnrolAs: Self.enrolledID, root: root), .ok])
    let logged = IdentityLoggedLines()
    let engine = try await RoomEngine.load(
      rootURL: root, remoteFactory: { _ in remote }, log: { logged.append($0) })
    let task = Task { try await engine.run() }
    try await Self.settle(remote, polls: 2)
    task.cancel()
    _ = await task.result

    let polls = await remote.polls
    #expect(polls.count >= 2)
    #expect(polls.dropFirst().allSatisfy { $0.installID == Self.enrolledID })
    // Without this the next launch finds no file, falls back to a keychain it cannot read, and
    // stops at needs_enrol.
    let file = try #require(Self.sessionFileRecord(root: root))
    #expect(file.installID == Self.enrolledID)
    #expect(file.session == "room.session.jwt")
    #expect(
      logged.all.contains("retry as install \(Self.enrolledID) accepted; session file rewritten"))
  }

  @Test func retiredWhenConfigNamesTheSameInstallStopsWithoutRetryingOrDiscarding() async throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    // The Mac really has lost the room: both files name the id the server refuses.
    try Self.writeConfiguration(root: root, installID: Self.retiredID)
    try Self.writeSessionFile(root: root, installID: Self.retiredID)

    let remote = IdentityRecordingRemote(answers: [.retired(), .ok, .ok])
    let logged = IdentityLoggedLines()
    let engine = try await RoomEngine.load(
      rootURL: root, remoteFactory: { _ in remote }, log: { logged.append($0) })
    let task = Task { try await engine.run() }
    try await Self.settle(remote, polls: 1)
    task.cancel()
    _ = await task.result

    #expect(await remote.polls.count == 1)
    #expect(Self.sessionFileRecord(root: root)?.installID == Self.retiredID)
    #expect(!logged.all.contains { $0.contains("retrying once") })
  }

  @Test func retiredWithAConfigSourcedIdIsNeverRetried() async throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    // No session file of its own to blame: the id came from config.json, and that is final.
    try Self.writeConfiguration(root: root, installID: Self.enrolledID)
    try Self.writeSessionFile(root: root, installID: Self.retiredID)

    let remote = IdentityRecordingRemote(answers: [.retired(), .ok, .ok])
    let engine = try await RoomEngine.load(rootURL: root, remoteFactory: { _ in remote })
    let task = Task { try await engine.run() }
    try await Self.settle(remote, polls: 1)
    task.cancel()
    _ = await task.result

    let polls = await remote.polls
    #expect(polls.count == 1)
    #expect(polls.first?.installID == Self.enrolledID)
  }

  // MARK: - The discard is only ever of the stale file

  @Test func discardLeavesAFileThatNamesADifferentInstall() throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    // A concurrent re-enrol has already written a NEW file. Deleting it would strand the Mac.
    try Self.writeSessionFile(root: root, installID: Self.enrolledID, token: "new.session.jwt")
    #expect(!RoomSessionStore.discard(root: root, ifInstallID: Self.retiredID))
    #expect(Self.sessionFileRecord(root: root)?.session == "new.session.jwt")
    #expect(RoomSessionStore.discard(root: root, ifInstallID: Self.enrolledID))
    #expect(!FileManager.default.fileExists(atPath: RoomSessionStore.url(root: root).path))
  }
}

/// What the engine said on each poll, and a scripted answer for each.
actor IdentityRecordingRemote: RoomEngineRemote {
  struct Poll: Equatable {
    let tabID: String
    let installID: String?
  }

  enum Answer {
    case ok
    /// 409 RETIRED. With a re-enrol: config.json is rewritten to the new id first, as a paste on a
    /// running Mac would do in the seconds before the server retires the old install.
    case retired(thenReEnrolAs: String? = nil, root: URL? = nil)
  }

  private(set) var polls: [Poll] = []
  private(set) var activeSessionTabIDs: [String] = []
  private var answers: [Answer]

  init(answers: [Answer]) { self.answers = answers }

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    if let tabID { activeSessionTabIDs.append(tabID) }
    return try JSONDecoder().decode(
      ActiveSessionResponse.self,
      from: Data(
        #"{"ok":true,"resumable":false,"session":null,"next_idx":{"primary":0,"backup":0},"reason":null,"handover_pending":false,"tab_gone":false}"#
          .utf8))
  }

  func pollCommands(
    tabID: String, previousPollAt: String?, recordingSessionID: String?, paused: Bool,
    primaryLevels: BenchLevelPair?, install: InstallPollFields?
  ) async throws -> CommandPollResponse {
    polls.append(Poll(tabID: tabID, installID: install?.installID))
    let answer = answers.isEmpty ? .ok : answers.removeFirst()
    switch answer {
    case .ok:
      return try JSONDecoder().decode(
        CommandPollResponse.self,
        from: Data(#"{"ok":true,"superseded":false,"commands":[]}"#.utf8))
    case .retired(let reEnrolAs, let root):
      if let reEnrolAs, let root {
        let persistence = RoomPersistence(root: root)
        var configuration = try persistence.loadConfiguration()
        configuration.applyEnrolment(
          origin: configuration.origin, roomSlug: configuration.roomSlug, installID: reEnrolAs,
          tapewriterPath: nil, ffmpegPath: nil)
        try persistence.saveConfiguration(configuration)
      }
      throw BenchClientError.http(
        BenchHTTPError(
          statusCode: 409,
          body: #"{"ok":false,"error":{"code":"RETIRED","message":"install retired"}}"#,
          retention: .notApplicable))
    }
  }

  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    throw IdentityStubError.unexpectedCall
  }
  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  { throw IdentityStubError.unexpectedCall }
  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  { throw IdentityStubError.unexpectedCall }
  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw IdentityStubError.unexpectedCall
  }
  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  { throw IdentityStubError.unexpectedCall }
}

private enum IdentityStubError: Error { case unexpectedCall }

/// Collects what the engine logged, across the thread it logged on.
final class IdentityLoggedLines: @unchecked Sendable {
  private let lock = NSLock()
  private var lines: [String] = []

  func append(_ line: String) {
    lock.lock()
    defer { lock.unlock() }
    lines.append(line)
  }

  var all: [String] {
    lock.lock()
    defer { lock.unlock() }
    return lines
  }
}
