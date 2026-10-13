import Foundation
import Testing

@testable import RoomRecorderCore

/// 0.1.38 — OPD 4 lost days because a 409 RETIRED left the process alive and silent, and because a denied
/// microphone was filed as a generic failure.
///
/// Mutants (each was run by hand against these tests):
///  - restore `break` after the 409 (the loop ends): `aRetiredInstallStaysUpSaysRetiredAndAsksAgain` fails on the re-poll count.
///  - drop `resumeAfterRetired()`: the same test fails on the resumed state.
///  - drop the `retiredByServer` branch in `saveStatus`: the state check fails.
///  - drop the `.micDenied` branch in `saveStatus`: `aDeniedMicrophoneIsReportedAsMicDenied` fails.
@Suite struct RoomRetiredAndMicTests {
  static let installID = "install_retiredprobe"

  static func makeRoot() throws -> URL {
    let root = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("0138 retired \(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try RoomStaleIdentityTests.writeConfiguration(root: root, installID: installID)
    return root
  }

  static func waitFor(_ what: String, timeout: Double = 8, _ condition: () async -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if await condition() { return }
      try await Task.sleep(for: .milliseconds(20))
    }
    Issue.record("timed out waiting for: \(what)")
  }

  static func status(_ root: URL) -> RoomRecorderStatus? {
    try? RoomPersistence(root: root).loadStatus()
  }

  @Test func aRetiredInstallStaysUpSaysRetiredAndAsksAgain() async throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = IdentityRecordingRemote(answers: [.retired(), .retired(), .retired(), .ok])
    let logged = IdentityLoggedLines()
    let engine = try await RoomEngine.load(
      rootURL: root, remoteFactory: { _ in remote }, log: { logged.append($0) })
    await engine.setRetiredRepoll(nanoseconds: 200_000_000)
    await engine.setMicStateProvider { "authorized" }
    let task = Task { try await engine.run() }

    // First 409: status.json says retired, with the new wording and no stale error.
    try await Self.waitFor("status retired") { Self.status(root)?.state == .retired }
    let retired = try #require(Self.status(root))
    #expect(retired.lastError == "retired: this install was retired on the server")
    #expect(retired.micState == "authorized")
    #expect(!logged.all.contains { $0.contains("newer enrolment") })
    #expect(logged.all.contains { $0.contains("this install was retired on the server") })

    // It keeps asking: the third poll is the second re-poll, and the fourth (an .ok) resumes it.
    try await Self.waitFor("three polls while retired") { await remote.polls.count >= 3 }
    #expect(!task.isCancelled)
    try await Self.waitFor("resumed after a 200") { Self.status(root)?.state != .retired }
    let resumed = try #require(Self.status(root))
    #expect(resumed.state == .ready)
    #expect(resumed.lastError == nil)
    #expect(logged.all.contains { $0.contains("no longer retired") })
    #expect(await remote.polls.count >= 4)
    task.cancel()
    _ = await task.result
  }

  @Test func aRetiredInstallPollsAsWhateverConfigNamesNow() async throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = IdentityRecordingRemote(answers: [.retired(), .ok])
    let engine = try await RoomEngine.load(rootURL: root, remoteFactory: { _ in remote }, log: { _ in })
    await engine.setRetiredRepoll(nanoseconds: 400_000_000)
    await engine.setMicStateProvider { "authorized" }
    let task = Task { try await engine.run() }
    try await Self.waitFor("status retired") { Self.status(root)?.state == .retired }
    // The desk re-enrols the Mac while the process is waiting.
    let persistence = RoomPersistence(root: root)
    var configuration = try persistence.loadConfiguration()
    configuration.applyEnrolment(
      origin: configuration.origin, roomSlug: configuration.roomSlug, installID: "install_livenow",
      tapewriterPath: nil, ffmpegPath: nil)
    try persistence.saveConfiguration(configuration)
    try await Self.waitFor("second poll") { await remote.polls.count >= 2 }
    #expect(await remote.polls.last?.installID == "install_livenow")
    task.cancel()
    _ = await task.result
  }

  @Test func aDeniedMicrophoneIsReportedAsMicDenied() async throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = IdentityRecordingRemote(answers: [.ok])
    let engine = try await RoomEngine.load(rootURL: root, remoteFactory: { _ in remote }, log: { _ in })
    await engine.setMicStateProvider { "denied" }
    let task = Task { try await engine.run() }
    try await Self.waitFor("mic_denied status") { Self.status(root)?.state == .micDenied }
    let status = try #require(Self.status(root))
    #expect(status.micState == "denied")
    // On the wire and on disk, the exact words.
    let json = try String(contentsOf: RoomPersistence(root: root).statusURL, encoding: .utf8)
    #expect(json.contains("\"state\" : \"mic_denied\"") || json.contains("\"state\":\"mic_denied\""))
    #expect(json.contains("\"mic_state\""))
    task.cancel()
    _ = await task.result
  }

  @Test func anAuthorizedMicrophoneIsReportedAndDoesNotChangeTheState() async throws {
    let root = try Self.makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = IdentityRecordingRemote(answers: [.ok])
    let engine = try await RoomEngine.load(rootURL: root, remoteFactory: { _ in remote }, log: { _ in })
    await engine.setMicStateProvider { "not_determined" }
    let task = Task { try await engine.run() }
    try await Self.waitFor("a status") { Self.status(root)?.micState == "not_determined" }
    #expect(Self.status(root)?.state == .ready)
    task.cancel()
    _ = await task.result
  }
}
