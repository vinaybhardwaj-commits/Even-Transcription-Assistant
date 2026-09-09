import CryptoKit
import Foundation
import Testing

@testable import RoomRecorderCore

/// Build R3 §13.3 — self-update, proved rather than argued.
///
/// ─── THE SWAP SCRIPT IS ACTUALLY RUN ─────────────────────────────────────────────────────────
/// Half of this file executes the generated shell against a real temporary directory, with stub
/// `launchctl` and `codesign` executables on PATH. That is deliberate. R3-1 exists because §7's
/// original steps 7 to 9 left the resident path empty if the process died between two moves, and
/// acceptance item 6 says the fix "must be proven, not argued". A test that only inspected the
/// script's TEXT would be the same kind of argument.
@Suite struct RoomSelfUpdateTests {

  // MARK: - Fixtures

  /// A temporary tree with a fake resident bundle in it, torn down by the caller.
  struct Fixture {
    let root: URL
    let applications: URL
    var resident: URL { applications.appendingPathComponent("EvenScribe Room Recorder.app") }
    var previous: URL { applications.appendingPathComponent("EvenScribe Room Recorder.app.previous") }
    var staging: URL { RoomSelfUpdate.stagingURL(root: root) }
    var result: URL { RoomSelfUpdate.resultURL(root: root) }

    static func make() throws -> Fixture {
      // A path WITH A SPACE IN IT, on purpose, and one with a quote too. The real resident path is
      // `~/Applications/EvenScribe Room Recorder.app` under
      // `~/Library/Application Support/...`, and an unquoted path in the swap script would split
      // into arguments and `rm -rf` something nobody named.
      let base = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("r3 self update \(UUID().uuidString)", isDirectory: true)
      let root = base.appendingPathComponent("Application Support/RoomRecorder", isDirectory: true)
      let applications = base.appendingPathComponent("Applications", isDirectory: true)
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      try FileManager.default.createDirectory(at: applications, withIntermediateDirectories: true)
      let fixture = Fixture(root: root, applications: applications)
      try fixture.writeBundle(at: fixture.resident, version: "0.1.7")
      return fixture
    }

    func writeBundle(at url: URL, version: String) throws {
      let macos = url.appendingPathComponent("Contents/MacOS", isDirectory: true)
      try FileManager.default.createDirectory(at: macos, withIntermediateDirectories: true)
      let binary = macos.appendingPathComponent("room-recorder", isDirectory: false)
      // The swap script runs `install-launch-agent` against whatever ends up resident, so the fake
      // binary has to be runnable and has to record that it was asked.
      try """
        #!/bin/bash
        echo "\(version) $*" >> "$(dirname "$0")/../../../install-launch-agent.log"
        exit 0
        """.write(to: binary, atomically: true, encoding: .utf8)
      try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
      try version.write(
        to: url.appendingPathComponent("version.txt", isDirectory: false),
        atomically: true, encoding: .utf8)
    }

    func version(of bundle: URL) -> String? {
      try? String(contentsOf: bundle.appendingPathComponent("version.txt"), encoding: .utf8)
    }

    func tearDown() {
      try? FileManager.default.removeItem(
        at: root.deletingLastPathComponent().deletingLastPathComponent())
    }
  }

  /// A directory of stub tools that go on PATH ahead of the real ones, so no test can boot a real
  /// LaunchAgent out or need a real signing certificate.
  static func stubTools(codesignExit: Int32, log: URL) throws -> URL {
    let bin = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("r3-stubs-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
    for (name, exit) in [("launchctl", Int32(0)), ("codesign", codesignExit)] {
      let tool = bin.appendingPathComponent(name, isDirectory: false)
      try """
        #!/bin/bash
        echo "\(name) $*" >> '\(log.path)'
        exit \(exit)
        """.write(to: tool, atomically: true, encoding: .utf8)
      try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tool.path)
    }
    return bin
  }

  /// Run the generated swap script to completion, with the stubs shadowing /bin and /usr/bin.
  @discardableResult
  static func runSwapScript(
    _ fixture: Fixture,
    stagedBundle: URL,
    version: String,
    codesignExit: Int32 = 0,
    signal: Int32? = nil
  ) throws -> (status: Int32, toolLog: String) {
    let toolLog = fixture.root.appendingPathComponent("tools.log", isDirectory: false)
    FileManager.default.createFile(atPath: toolLog.path, contents: nil)
    let stubs = try stubTools(codesignExit: codesignExit, log: toolLog)
    defer { try? FileManager.default.removeItem(at: stubs) }

    var script = RoomSwapScript.render(
      residentBundleURL: fixture.resident,
      stagedBundleURL: stagedBundle,
      rootURL: fixture.root,
      version: version)
    // The script names /bin/launchctl and /usr/bin/codesign absolutely — correctly, since a swap
    // script must not depend on a PATH it did not set. Point those two at the stubs; everything
    // else (mv, rm, cat, date, sleep) runs for real, which is the point.
    script = script.replacingOccurrences(
      of: "/bin/launchctl", with: stubs.appendingPathComponent("launchctl").path)
    script = script.replacingOccurrences(
      of: "/usr/bin/codesign", with: stubs.appendingPathComponent("codesign").path)
    // Three seconds of `sleep` per test is real time nobody needs; the wait exists for launchd.
    script = script.replacingOccurrences(of: "/bin/sleep 3", with: "/bin/sleep 0")

    let scriptURL = fixture.root.appendingPathComponent("swap.sh", isDirectory: false)
    try script.write(to: scriptURL, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: scriptURL.path)

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [scriptURL.path]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    if let signal {
      // Give the script time to get past the moves, then signal it where acceptance item 6 does.
      Thread.sleep(forTimeInterval: 0.35)
      kill(process.processIdentifier, signal)
    }
    process.waitUntilExit()
    let log = (try? String(contentsOf: toolLog, encoding: .utf8)) ?? ""
    return (process.terminationStatus, log)
  }

  static func readResult(_ fixture: Fixture) -> RoomUpdateResult? {
    RoomUpdateResult.read(root: fixture.root)
  }

  // MARK: - Step 2: what counts as an update

  @Test func aLowerVersionIsAnUpdate_becauseThatIsHowWithdrawRollsBack() {
    // NOT `>`. `latestRelease` orders by published_at, so withdrawing the newest row makes the
    // route answer with the one BEFORE it — a lower version — and every Mac walks backwards at its
    // next check. A greater-than here would leave withdraw with nothing to do.
    #expect(roomUpdateIsAvailable(running: "0.1.8", offered: "0.1.7"))
    #expect(roomUpdateIsAvailable(running: "0.1.7", offered: "0.1.8"))
    #expect(roomUpdateIsAvailable(running: "0.1.8", offered: "0.1.9-test"))
    #expect(!roomUpdateIsAvailable(running: "0.1.8", offered: "0.1.8"))
  }

  @Test func anUnbundledBinaryNeverUpdatesItself() {
    // A `swift run` binary has no CFBundleShortVersionString. It has no release identity, must not
    // claim one, and must never swap a bundle it is not running from.
    #expect(!roomUpdateIsAvailable(running: nil, offered: "0.1.8"))
    #expect(!roomUpdateIsAvailable(running: "", offered: "0.1.8"))
  }

  // MARK: - Steps 1 and 3: when to look, and when not to

  @Test func theFirstCheckIsOnLaunchAndTheNextIsSixHoursLater() {
    let start = Date(timeIntervalSince1970: 1_757_400_000)
    var schedule = RoomUpdateSchedule()
    #expect(schedule.isDue(now: start, sessionJustEnded: false))  // on launch

    schedule.lastCheckedAt = start
    #expect(!schedule.isDue(now: start.addingTimeInterval(3600), sessionJustEnded: false))
    #expect(!schedule.isDue(now: start.addingTimeInterval(6 * 3600 - 1), sessionJustEnded: false))
    #expect(schedule.isDue(now: start.addingTimeInterval(6 * 3600), sessionJustEnded: false))
  }

  @Test func aDeferredCheckReRunsWhenTheSessionEnds_notSixHoursLater() {
    // R3-10. A clinic day is close to continuous recording, so a check deferred at 09:10 would
    // otherwise wait until 15:10 — most of a day after the last patient left.
    let start = Date(timeIntervalSince1970: 1_757_400_000)
    var schedule = RoomUpdateSchedule(lastCheckedAt: start, deferredWhileRecording: true)
    let oneMinuteLater = start.addingTimeInterval(60)
    #expect(!schedule.isDue(now: oneMinuteLater, sessionJustEnded: false))
    #expect(schedule.isDue(now: oneMinuteLater, sessionJustEnded: true))

    // A check that was NOT deferred does not get the early re-run; a session ending is not by
    // itself a reason to ask again.
    schedule.deferredWhileRecording = false
    #expect(!schedule.isDue(now: oneMinuteLater, sessionJustEnded: true))
  }

  @Test func aSessionInProgressDefersBeforeAnythingIsDownloaded() async throws {
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let downloader = CountingDownloader()
    let updater = RoomUpdater(
      rootURL: fixture.root, residentBundleURL: fixture.resident, runningVersion: "0.1.7",
      channel: "stable",
      fetcher: StubFetcher(release: descriptor(version: "0.1.8", bytes: Data([0x01]))),
      downloader: downloader, runner: RecordingRunner(), log: { _ in })

    let attempt = await updater.check(sessionIsOpen: true)
    #expect(attempt == .deferredWhileRecording(version: "0.1.8"))
    // A Mac recording a consultation must not spend its disk and its network on ~90 MB it has
    // already decided not to install.
    #expect(await downloader.count == 0)
    #expect(!FileManager.default.fileExists(atPath: fixture.staging.path))
    #expect(Self.readResult(fixture) == nil)
  }

  // MARK: - R3-9: every answer that is not a 200

  @Test func aNon200LeavesTheDiskCompletelyUntouched() async throws {
    // 404 NO_RELEASE, 401, a timeout, a dead network: `BenchClient.fetchRelease` answers nil for all
    // four, and nil means DO NOTHING. Not an outcome, not a result file, not a card line. A missing
    // release is never a reason to remove software from a room.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let downloader = CountingDownloader()
    let updater = RoomUpdater(
      rootURL: fixture.root, residentBundleURL: fixture.resident, runningVersion: "0.1.7",
      channel: "stable", fetcher: StubFetcher(release: nil), downloader: downloader,
      runner: RecordingRunner(), log: { _ in })

    #expect(await updater.check(sessionIsOpen: false) == .upToDate)
    #expect(await downloader.count == 0)
    #expect(!FileManager.default.fileExists(atPath: fixture.staging.path))
    #expect(Self.readResult(fixture) == nil)
    #expect(fixture.version(of: fixture.resident) == "0.1.7")
  }

  // MARK: - Steps 4 to 6: the three ways staging stops

  @Test func aChecksumMismatchStopsTheUpdateAndReportsIt() async throws {
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let bytes = Data("not the bundle you were promised".utf8)
    let updater = RoomUpdater(
      rootURL: fixture.root, residentBundleURL: fixture.resident, runningVersion: "0.1.7",
      channel: "stable",
      fetcher: StubFetcher(
        release: RoomReleaseDescriptor(
          version: "0.1.8", sha256: String(repeating: "a", count: 64),
          sizeBytes: Int64(bytes.count), blobURL: "https://blob.example/app.zip")),
      downloader: StubDownloader(bytes: bytes), runner: RecordingRunner(), log: { _ in })

    let attempt = await updater.check(sessionIsOpen: false)
    guard case .stopped(let outcome, _) = attempt else {
      Issue.record("expected the update to stop, got \(attempt)")
      return
    }
    #expect(outcome == .checksumMismatch)
    // Acceptance item 5: the resident copy is unchanged, and the card can name the reason.
    #expect(fixture.version(of: fixture.resident) == "0.1.7")
    #expect(!FileManager.default.fileExists(atPath: fixture.staging.path))
    let result = try #require(Self.readResult(fixture))
    #expect(result.outcome == .checksumMismatch)
    #expect(result.version == "0.1.8")
    #expect(result.reportedErrorLine?.hasPrefix("0.1.8 — ") == true)
  }

  @Test func aTruncatedDownloadIsCaughtByWeightBeforeItIsHashed() async throws {
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let bytes = Data("short".utf8)
    let updater = RoomUpdater(
      rootURL: fixture.root, residentBundleURL: fixture.resident, runningVersion: "0.1.7",
      channel: "stable",
      fetcher: StubFetcher(
        release: RoomReleaseDescriptor(
          version: "0.1.8", sha256: String(repeating: "a", count: 64), sizeBytes: 90_000_000,
          blobURL: "https://blob.example/app.zip")),
      downloader: StubDownloader(bytes: bytes), runner: RecordingRunner(), log: { _ in })

    guard case .stopped(let outcome, let reason) = await updater.check(sessionIsOpen: false) else {
      Issue.record("expected the update to stop")
      return
    }
    #expect(outcome == .downloadFailed)
    #expect(reason.contains("5 bytes"))
    #expect(fixture.version(of: fixture.resident) == "0.1.7")
  }

  @Test func aSignatureMismatchStopsTheUpdateAndNothingIsSpawned() async throws {
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let bytes = Data("a plausible zip".utf8)
    // ditto succeeds and produces a bundle; codesign refuses it. That is the shape of a build
    // signed by somebody who is not Even.
    let runner = RecordingRunner(exitCodes: ["/usr/bin/ditto": 0, "/usr/bin/codesign": 1])
    runner.dittoProducesBundleNamed = "EvenScribe Room Recorder.app"
    let updater = RoomUpdater(
      rootURL: fixture.root, residentBundleURL: fixture.resident, runningVersion: "0.1.7",
      channel: "stable",
      fetcher: StubFetcher(release: descriptor(version: "0.1.8", bytes: bytes)),
      downloader: StubDownloader(bytes: bytes), runner: runner, log: { _ in })

    guard case .stopped(let outcome, _) = await updater.check(sessionIsOpen: false) else {
      Issue.record("expected the update to stop")
      return
    }
    #expect(outcome == .signatureMismatch)
    #expect(await runner.spawned.isEmpty)
    #expect(fixture.version(of: fixture.resident) == "0.1.7")
    #expect(Self.readResult(fixture)?.outcome == RoomUpdateOutcome.signatureMismatch)
  }

  @Test func theSignatureCheckPinsTheCompiledInCertificateAndNothingFromTheServer() async throws {
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let bytes = Data("a plausible zip".utf8)
    let runner = RecordingRunner(exitCodes: ["/usr/bin/ditto": 0, "/usr/bin/codesign": 0])
    runner.dittoProducesBundleNamed = "EvenScribe Room Recorder.app"
    let updater = RoomUpdater(
      rootURL: fixture.root, residentBundleURL: fixture.resident, runningVersion: "0.1.7",
      channel: "stable",
      fetcher: StubFetcher(release: descriptor(version: "0.1.8", bytes: bytes)),
      downloader: StubDownloader(bytes: bytes), runner: runner, log: { _ in })

    _ = await updater.check(sessionIsOpen: false)
    let codesign = try #require(await runner.calls.first { $0.0 == "/usr/bin/codesign" })
    #expect(codesign.1.contains("--verify"))
    #expect(codesign.1.contains("--strict"))
    // R3-5: the requirement is a compile-time constant, and it is the SAME string
    // Packaging/build-bundle.sh has always pinned — including the leading `= `, without which
    // codesign reads the argument as a FILENAME and the check passes everything.
    #expect(codesign.1.contains(RoomSelfUpdate.pinnedRequirement))
    #expect(RoomSelfUpdate.pinnedRequirement.hasPrefix("= anchor trusted"))
    #expect(RoomSelfUpdate.pinnedLeafSHA1 == "187dd424fb866204111113d60c6f88a21d098edb")
  }

  @Test func aCleanStagingEndsInADetachedSpawnAndAHandover() async throws {
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let bytes = Data("a plausible zip".utf8)
    let runner = RecordingRunner(exitCodes: ["/usr/bin/ditto": 0, "/usr/bin/codesign": 0])
    runner.dittoProducesBundleNamed = "EvenScribe Room Recorder.app"
    let updater = RoomUpdater(
      rootURL: fixture.root, residentBundleURL: fixture.resident, runningVersion: "0.1.7",
      channel: "stable",
      fetcher: StubFetcher(release: descriptor(version: "0.1.8", bytes: bytes)),
      downloader: StubDownloader(bytes: bytes), runner: runner, log: { _ in })

    #expect(await updater.check(sessionIsOpen: false) == .handedOver(version: "0.1.8"))
    let spawned = try #require(await runner.spawned.first)
    #expect(spawned.0 == "/bin/bash")
    #expect(spawned.1.first?.hasSuffix("swap.sh") == true)
    // THE APP HAS NOT TOUCHED THE RESIDENT BUNDLE (R3-1). The script does that, after this process
    // is gone.
    #expect(fixture.version(of: fixture.resident) == "0.1.7")
    #expect(!FileManager.default.fileExists(atPath: fixture.previous.path))
  }

  // MARK: - The swap script, actually executed (§13.3 step 8)

  @Test func theScriptSwapsTheBundlesAndBootstrapsTheAgentBack() throws {
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let staged = fixture.root.appendingPathComponent("staged/EvenScribe Room Recorder.app")
    try fixture.writeBundle(at: staged, version: "0.1.8")

    let run = try Self.runSwapScript(fixture, stagedBundle: staged, version: "0.1.8")
    #expect(run.status == 0)
    #expect(fixture.version(of: fixture.resident) == "0.1.8")
    #expect(fixture.version(of: fixture.previous) == "0.1.7")
    // 8.1 out, 8.8 back in. Both, in that order.
    #expect(run.toolLog.contains("launchctl bootout"))
    #expect(run.toolLog.contains("launchctl bootstrap"))
    let result = try #require(Self.readResult(fixture))
    #expect(result.outcome == .ok)
    #expect(result.version == "0.1.8")
    #expect(result.reason == nil)
  }

  @Test func theNewBundleWritesThePlistBeforeTheAgentIsBootstrapped() throws {
    // R3-11. The swap script runs the RESIDENT (new) bundle's install-launch-agent verb, so a
    // plist change — ThrottleInterval, in this very build — ships with the app instead of needing
    // somebody to walk to the Mac.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let staged = fixture.root.appendingPathComponent("staged/EvenScribe Room Recorder.app")
    try fixture.writeBundle(at: staged, version: "0.1.8")

    _ = try Self.runSwapScript(fixture, stagedBundle: staged, version: "0.1.8")
    let log = try String(
      contentsOf: fixture.applications.appendingPathComponent("install-launch-agent.log"),
      encoding: .utf8)
    // The NEW version ran it, not the old one.
    #expect(log.contains("0.1.8 install-launch-agent"))
    #expect(!log.contains("0.1.7 install-launch-agent"))
    // With --root, because the plist's ProgramArguments carry one.
    #expect(log.contains("--root"))
  }

  @Test func aResidentCopyThatFailsVerifyIsRolledBack() throws {
    // §13.3 step 8.5, and the reason `.previous` is a path something READS. §12.7 and §12.8 record
    // four instances of a stated guarantee that nothing implemented; a saved bundle no code
    // restored would have been the fifth.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let staged = fixture.root.appendingPathComponent("staged/EvenScribe Room Recorder.app")
    try fixture.writeBundle(at: staged, version: "0.1.8")

    let run = try Self.runSwapScript(
      fixture, stagedBundle: staged, version: "0.1.8", codesignExit: 1)
    #expect(run.status == 1)
    // The room is back on the version it was recording with, and the agent is running again.
    #expect(fixture.version(of: fixture.resident) == "0.1.7")
    #expect(run.toolLog.contains("launchctl bootstrap"))
    let result = try #require(Self.readResult(fixture))
    #expect(result.outcome == .swapFailed)
    #expect(result.reason?.contains("previous one was put back") == true)
  }

  @Test func exactlyOnePreviousBundleIsKept() throws {
    // R3-12. Two updates in a row, and `.previous` holds the version before the current one — not
    // a growing pile of ~90 MB bundles on a Mac that also has to hold a clinic day of audio.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }

    let first = fixture.root.appendingPathComponent("staged1/EvenScribe Room Recorder.app")
    try fixture.writeBundle(at: first, version: "0.1.8")
    _ = try Self.runSwapScript(fixture, stagedBundle: first, version: "0.1.8")
    #expect(fixture.version(of: fixture.previous) == "0.1.7")

    let second = fixture.root.appendingPathComponent("staged2/EvenScribe Room Recorder.app")
    try fixture.writeBundle(at: second, version: "0.1.9")
    _ = try Self.runSwapScript(fixture, stagedBundle: second, version: "0.1.9")

    #expect(fixture.version(of: fixture.resident) == "0.1.9")
    #expect(fixture.version(of: fixture.previous) == "0.1.8")
    // No `.previous.previous`, and nothing else `.app`-shaped left lying around.
    let names = try FileManager.default.contentsOfDirectory(atPath: fixture.applications.path)
      .filter { $0.hasPrefix("EvenScribe Room Recorder.app") }
    #expect(names.sorted() == ["EvenScribe Room Recorder.app", "EvenScribe Room Recorder.app.previous"])
  }

  @Test func aScriptKilledDuringTheSwapLeavesAWorkingBundleAtTheResidentPath() throws {
    // ─── ACCEPTANCE ITEM 6 ────────────────────────────────────────────────────────────────────
    // "A swap script killed between the two moves. The resident path holds a working bundle
    // afterwards, and the room polls again without a visit."
    //
    // The script traps INT/TERM/HUP/QUIT: if it is interrupted with the resident path empty, it
    // puts `.previous` back and bootstraps the agent in again. THIS DOES NOT COVER `kill -9`,
    // which is not trappable — see the build report, where that residual window is flagged.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let staged = fixture.root.appendingPathComponent("staged/EvenScribe Room Recorder.app")
    try fixture.writeBundle(at: staged, version: "0.1.8")

    _ = try Self.runSwapScript(
      fixture, stagedBundle: staged, version: "0.1.8", signal: SIGTERM)

    // Whichever side of the moves the signal landed, SOMETHING runnable is resident.
    let resident = fixture.version(of: fixture.resident)
    #expect(resident == "0.1.7" || resident == "0.1.8")
    #expect(
      FileManager.default.isExecutableFile(
        atPath: fixture.resident.appendingPathComponent("Contents/MacOS/room-recorder").path))
  }

  // MARK: - Quoting

  @Test func everyPathIsQuotedAgainstSpacesAndQuotes() {
    #expect(RoomSwapScript.quoted("/plain/path") == "'/plain/path'")
    #expect(RoomSwapScript.quoted("/with space/x.app") == "'/with space/x.app'")
    // The one character that cannot simply live inside '...'.
    #expect(RoomSwapScript.quoted("it's") == #"'it'\''s'"#)
    // And a path that would be catastrophic unquoted.
    let nasty = RoomSwapScript.quoted("/tmp/a b; rm -rf /; echo $HOME `whoami`")
    #expect(nasty.hasPrefix("'") && nasty.hasSuffix("'"))
    #expect(!nasty.dropFirst().dropLast().contains("'"))
  }

  @Test func theRenderedScriptQuotesTheRealResidentPathShape() {
    let script = RoomSwapScript.render(
      residentBundleURL: URL(fileURLWithPath: "/Users/v/Applications/EvenScribe Room Recorder.app"),
      stagedBundleURL: URL(fileURLWithPath: "/Users/v/Library/Application Support/EvenScribe/RoomRecorder/update-staging/expanded/EvenScribe Room Recorder.app"),
      rootURL: URL(fileURLWithPath: "/Users/v/Library/Application Support/EvenScribe/RoomRecorder"),
      version: "0.1.8")
    #expect(script.contains("RESIDENT='/Users/v/Applications/EvenScribe Room Recorder.app'"))
    #expect(script.contains("PREVIOUS='/Users/v/Applications/EvenScribe Room Recorder.app.previous'"))
    #expect(script.contains("VERSION='0.1.8'"))
    // `set -u` but deliberately NOT `set -e`: every step tests its own status, and a bare `set -e`
    // would abandon the swap half-done with nothing written saying why.
    //
    // Matched as DIRECTIVES, on their own lines — the script's comments discuss `set -e` by name,
    // and a substring test would be satisfied by the prose explaining its absence.
    let directives = script.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
    #expect(directives.contains("set -u"))
    #expect(!directives.contains("set -e"))
    #expect(!directives.contains("set -eu"))
  }

  // MARK: - update-result.json, the receipt

  @Test func theReceiptRoundTripsBetweenBashAndJSONDecoder() throws {
    // The keys are a wire format between a heredoc and a JSONDecoder. A rename on one side alone
    // produces a file the app silently cannot read, and the failure it recorded is lost.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let staged = fixture.root.appendingPathComponent("staged/EvenScribe Room Recorder.app")
    try fixture.writeBundle(at: staged, version: "0.1.8")
    _ = try Self.runSwapScript(fixture, stagedBundle: staged, version: "0.1.8", codesignExit: 1)

    let raw = try String(contentsOf: fixture.result, encoding: .utf8)
    for key in ["outcome", "version", "reason", "at"] {
      #expect(raw.contains("\"\(key)\""))
    }
    let decoded = try #require(RoomUpdateResult.read(root: fixture.root))
    #expect(decoded.outcome == .swapFailed)
    #expect(abs(decoded.at.timeIntervalSinceNow) < 120)
  }

  @Test func theReceiptIsDeletableAndCarriesTheVersionInItsReasonLine() throws {
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let written = RoomUpdateResult(
      outcome: .checksumMismatch, version: "0.1.8",
      reason: "the downloaded file did not match its checksum", at: Date())
    #expect(written.write(root: fixture.root))
    #expect(
      RoomUpdateResult.read(root: fixture.root)?.reportedErrorLine
        == "0.1.8 — the downloaded file did not match its checksum")
    RoomUpdateResult.delete(root: fixture.root)
    #expect(RoomUpdateResult.read(root: fixture.root) == nil)
  }

  @Test func anOkReceiptCarriesNoReasonLine() {
    let ok = RoomUpdateResult(outcome: .ok, version: "0.1.8", reason: nil, at: Date())
    #expect(ok.reportedErrorLine == nil)
  }

  // MARK: - The poll fields these produce

  @Test func theWireOmitsWhatCannotBeMeasuredAndNeverSendsZeroDisk() {
    let bare = InstallPollFields(installID: "install_a", tapeAdvancing: false)
    let names = Set(bare.queryItems().map(\.name))
    #expect(!names.contains("session_open"))
    #expect(!names.contains("disk_free_bytes"))
    #expect(!names.contains("last_update_result"))

    // 0 is the value a broken reader produces and the one this column must never hold.
    let zero = InstallPollFields(installID: "install_a", tapeAdvancing: false, diskFreeBytes: 0)
    #expect(!zero.queryItems().map(\.name).contains("disk_free_bytes"))
    let negative = InstallPollFields(installID: "install_a", tapeAdvancing: false, diskFreeBytes: -1)
    #expect(!negative.queryItems().map(\.name).contains("disk_free_bytes"))

    let full = InstallPollFields(
      installID: "install_a", tapeAdvancing: true, sessionOpen: false, updateChannel: "test",
      lastUpdateResult: "checksum_mismatch",
      lastUpdateError: "0.1.8 — the downloaded file did not match its checksum",
      lastUpdateAt: "2026-09-09T09:14:00Z", diskFreeBytes: 412_300_000_000)
    let items = Dictionary(
      uniqueKeysWithValues: full.queryItems().map { ($0.name, $0.value ?? "") })
    #expect(items["session_open"] == "false")
    #expect(items["update_channel"] == "test")
    #expect(items["disk_free_bytes"] == "412300000000")
    #expect(items["last_update_result"] == "checksum_mismatch")
    // AND `spare_device` IS NOT HERE, and never was on this type — it was a literal in BenchClient
    // and §5.7 removed it.
    #expect(items["spare_device"] == nil)
  }

  @Test func freeSpaceIsMeasuredOrAbsent() throws {
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    // A real directory on a real volume answers a real number.
    let real = try #require(InstallPollFields.freeBytes(onVolumeHolding: fixture.root))
    #expect(real > 0)
    // A path that does not exist answers nil, NOT zero.
    #expect(
      InstallPollFields.freeBytes(
        onVolumeHolding: URL(fileURLWithPath: "/nonexistent-volume-\(UUID().uuidString)")) == nil)
  }

  // MARK: - The channel (R3-8)

  @Test func theChannelDefaultsToStableAndSurvivesAConfigWrittenBeforeR3() throws {
    // Every config.json on disk today lacks the key, and every one of those Macs is on stable.
    let json = """
      {
        "origin": "https://www.evenscribe.app/",
        "room_slug": "home-office",
        "device_uid": "AppleUSB:mic",
        "tapewriter_path": "/x/tapewriter",
        "ffmpeg_path": "/x/ffmpeg",
        "retained_archive_recovery_enabled": false,
        "resident_archive_capture_enabled": false
      }
      """
    let decoded = try JSONDecoder().decode(RoomConfiguration.self, from: Data(json.utf8))
    #expect(decoded.updateChannel == "stable")
  }

  @Test func aHandEditedChannelIsHonouredIfKnownAndIgnoredIfNot() throws {
    // Home Office reaches `test` by a hand edit — there is no verb for it, deliberately. A TYPO in
    // that edit must leave the Mac on the safe shelf, not refuse to start a clinic room.
    func channel(_ value: String) throws -> String {
      let json = """
        {
          "origin": "https://www.evenscribe.app/",
          "room_slug": "home-office",
          "device_uid": "AppleUSB:mic",
          "tapewriter_path": "/x/tapewriter",
          "ffmpeg_path": "/x/ffmpeg",
          "retained_archive_recovery_enabled": false,
          "resident_archive_capture_enabled": false,
          "update_channel": "\(value)"
        }
        """
      return try JSONDecoder().decode(RoomConfiguration.self, from: Data(json.utf8)).updateChannel
    }
    #expect(try channel("test") == "test")
    #expect(try channel("stable") == "stable")
    #expect(try channel("tset") == "stable")
    #expect(try channel("") == "stable")
  }

  @Test func theChannelSurvivesAReEnrolment() throws {
    // A second paste on Home Office must not quietly move it back to `stable`. `applyEnrolment`
    // mutates a named list of fields and this is not one of them — the same rule that protects the
    // room's audio device.
    var configuration = try RoomConfiguration(
      origin: URL(string: "https://www.evenscribe.app")!, roomSlug: "home-office",
      deviceUID: "AppleUSB:mic", tapewriterPath: "/x/tapewriter", ffmpegPath: "/x/ffmpeg",
      updateChannel: "test")
    configuration.applyEnrolment(
      origin: URL(string: "https://www.evenscribe.app")!, roomSlug: "home-office",
      installID: "install_gd9tnfgqazvh", tapewriterPath: nil, ffmpegPath: nil)
    #expect(configuration.updateChannel == "test")
  }

  // MARK: - Helpers

  private func descriptor(version: String, bytes: Data) -> RoomReleaseDescriptor {
    RoomReleaseDescriptor(
      version: version, sha256: sha256Hex(bytes), sizeBytes: Int64(bytes.count),
      blobURL: "https://blob.example/app.zip")
  }

  private func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}

// MARK: - Doubles

private struct StubFetcher: RoomReleaseFetching {
  let release: RoomReleaseDescriptor?
  func fetchRelease(channel: String) async -> RoomReleaseDescriptor? { release }
}

private struct StubDownloader: RoomUpdateDownloading {
  let bytes: Data
  func download(from url: URL) async throws -> Data { bytes }
}

private actor CountingDownloaderBox {
  var count = 0
  func bump() { count += 1 }
}

private struct CountingDownloader: RoomUpdateDownloading {
  private let box = CountingDownloaderBox()
  var count: Int { get async { await box.count } }
  func download(from url: URL) async throws -> Data {
    await box.bump()
    return Data()
  }
}

/// Records what was run and what was spawned, and can be told what to exit with.
private final class RecordingRunner: RoomUpdateCommandRunning, @unchecked Sendable {
  private let lock = NSLock()
  private var _calls: [(String, [String])] = []
  private var _spawned: [(String, [String])] = []
  private let exitCodes: [String: Int32]
  /// When set, the `ditto` stub creates a directory of this name in its destination, so the step
  /// that looks for a `.app` finds one.
  var dittoProducesBundleNamed: String?

  init(exitCodes: [String: Int32] = [:]) { self.exitCodes = exitCodes }

  var calls: [(String, [String])] { get async { lock.withLock { _calls } } }
  var spawned: [(String, [String])] { get async { lock.withLock { _spawned } } }

  func run(_ executable: String, _ arguments: [String]) -> Int32 {
    lock.withLock { _calls.append((executable, arguments)) }
    if executable == "/usr/bin/ditto", let name = dittoProducesBundleNamed,
      let destination = arguments.last
    {
      let bundle = URL(fileURLWithPath: destination).appendingPathComponent(name, isDirectory: true)
      try? FileManager.default.createDirectory(at: bundle, withIntermediateDirectories: true)
    }
    return exitCodes[executable] ?? 0
  }

  func spawnDetached(_ executable: String, _ arguments: [String]) throws {
    lock.withLock { _spawned.append((executable, arguments)) }
  }
}
