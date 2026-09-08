import Foundation
import Testing

@testable import RoomRecorderCore

/// `run` must READ the session back out of the keychain (Install and Fleet PRD §5.4; V's ruling
/// of 8 September 2026).
///
/// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────
/// §5.4 says the session lives in the keychain and `config.json` holds no token. Half of that was
/// implemented. `enrol` wrote the keychain and nilled the config field — and nothing ever read it
/// back, so every poll went out with no `eta_room_session` cookie and returned
/// `missingSessionCookie`. Home Office sat enrolled, with a valid 365-day session on the machine,
/// and never polled once.
///
/// The existing suite covered `enrol` WRITING the item. Nothing covered anything READING it. A
/// stated guarantee is not an implemented one, and only the half with a test was real.
@Suite struct RoomSessionFromKeychainTests {

  // MARK: - Fixtures

  /// A root with a valid configuration and no session on disk — what `enrol` leaves behind.
  private func makeRoot() throws -> URL {
    let root = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("rr-session-\(UUID().uuidString)", isDirectory: true)
    let persistence = RoomPersistence(root: root)
    let configuration = try RoomConfiguration(
      origin: #require(URL(string: "https://www.evenscribe.app")),
      roomSlug: "home-office-w8fb",
      deviceUID: "AppleUSBAudioEngine:test",
      tapewriterPath: "/usr/bin/true",
      ffmpegPath: "/usr/bin/true"
    )
    try persistence.saveConfiguration(configuration)
    return root
  }

  private func record(session: String) -> RoomKeychainRecord {
    RoomKeychainRecord(
      session: session,
      installID: "install_ufbyh5h6j8c6",
      roomSlug: "home-office-w8fb",
      roomName: "Home Office",
      origin: "https://www.evenscribe.app"
    )
  }

  // MARK: - The read

  /// THE TEST THE MISSING ONE WOULD HAVE BEEN. The configuration handed to the client factory
  /// carries the session that came out of the keychain.
  @Test func loadHandsTheKeychainSessionToTheClientItBuilds() async throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }

    // Proof that the starting point is the real one: nothing on disk carries a session.
    #expect(try RoomPersistence(root: root).loadConfiguration().etaRoomSession == nil)

    let seen = SeenConfiguration()
    _ = try await RoomEngine.load(
      rootURL: root,
      enrolmentReader: { self.record(session: "a.session.jwt") },
      remoteFactory: { configuration in
        seen.store(configuration)
        return SilentRemote()
      })

    #expect(await seen.value?.etaRoomSession == "a.session.jwt")
    // The rest of the configuration is the one from disk, unchanged — the hydration adds the
    // session and touches nothing else.
    #expect(await seen.value?.roomSlug == "home-office-w8fb")
    #expect(await seen.value?.deviceUID == "AppleUSBAudioEngine:test")
  }

  /// No session means REFUSE, not retry. The client is never even built, so there is no path on
  /// which the app can poll unauthenticated in a loop.
  @Test func loadRefusesWhenTheKeychainHasNoSession() async throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }

    let seen = SeenConfiguration()
    await #expect(throws: RoomEngineError.needsEnrolment) {
      _ = try await RoomEngine.load(
        rootURL: root,
        enrolmentReader: { nil },
        remoteFactory: { configuration in
          seen.store(configuration)
          return SilentRemote()
        })
    }
    #expect(await seen.value == nil, "a client must not be constructed without a session")

    // And it says so where an operator can see it: a distinct state, not `offline`.
    let status = try RoomPersistence(root: root).loadStatus()
    #expect(status.state == .needsEnrol)
    #expect(status.lastError?.contains("keychain") == true)
  }

  /// An empty string is not a session. It would otherwise sail through as a cookie value and turn
  /// a loud refusal into a silent 401 loop.
  @Test func anEmptySessionIsTreatedAsNoSession() async throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    await #expect(throws: RoomEngineError.needsEnrolment) {
      _ = try await RoomEngine.load(
        rootURL: root,
        enrolmentReader: { self.record(session: "") },
        remoteFactory: { _ in SilentRemote() })
    }
  }

  // MARK: - The other half of the ruling: config never holds it

  /// The session is stripped at the persistence boundary, so no future writer can put a token on
  /// disk by forgetting to nil it.
  @Test func savingAConfigurationNeverWritesTheSessionToDisk() throws {
    let root = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("rr-strip-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let persistence = RoomPersistence(root: root)

    var configuration = try RoomConfiguration(
      origin: #require(URL(string: "https://www.evenscribe.app")),
      roomSlug: "home-office-w8fb",
      deviceUID: "AppleUSBAudioEngine:test",
      tapewriterPath: "/usr/bin/true",
      ffmpegPath: "/usr/bin/true"
    )
    configuration.etaRoomSession = "a.session.jwt"
    try persistence.saveConfiguration(configuration)

    #expect(try persistence.loadConfiguration().etaRoomSession == nil)
    // Not merely absent from the decoded value — absent from the BYTES.
    let raw = try String(contentsOf: persistence.configurationURL, encoding: .utf8)
    #expect(!raw.contains("a.session.jwt"))
    #expect(!raw.contains("eta_room_session"))

    // The caller's own copy is untouched: the engine needs it in memory for the client.
    #expect(configuration.etaRoomSession == "a.session.jwt")
  }
}

// MARK: - Doubles

/// Records the configuration the engine handed the factory.
private final class SeenConfiguration: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: RoomConfiguration?
  func store(_ c: RoomConfiguration) {
    lock.lock()
    defer { lock.unlock() }
    stored = c
  }
  var value: RoomConfiguration? {
    get async {
      lock.lock()
      defer { lock.unlock() }
      return stored
    }
  }
}

/// A remote that is never expected to be called. Every method traps, because this suite is about
/// what happens BEFORE any request is made.
private struct SilentRemote: RoomEngineRemote {
  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    fatalError("no request should be made in these tests")
  }
  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    fatalError("no request should be made in these tests")
  }
  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  { fatalError("no request should be made in these tests") }
  func pollCommands(
    tabID: String, previousPollAt: String?, recordingSessionID: String?, paused: Bool,
    primaryLevels: BenchLevelPair?, install: InstallPollFields?
  ) async throws -> CommandPollResponse {
    fatalError("no request should be made in these tests")
  }
  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  { fatalError("no request should be made in these tests") }
  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    fatalError("no request should be made in these tests")
  }
  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  { fatalError("no request should be made in these tests") }
}
