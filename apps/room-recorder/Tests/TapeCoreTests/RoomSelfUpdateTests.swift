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
    /// F4. Inject a FIFO rendezvous immediately before the SECOND move and SIGTERM the script the
    /// instant it reaches it, so the signal lands inside the two-move window every time rather
    /// than after a guessed delay.
    killInsideTheWindow: Bool = false
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

    // F4. The rendezvous, injected between the two moves and nowhere else. The anchor is the
    // second move's own line, so if that line is ever reworded this harness fails loudly rather
    // than silently going back to testing nothing.
    var fifoURL: URL?
    if killInsideTheWindow {
      // NO leading indent: Swift strips the multiline literal's indentation relative to its
      // closing delimiter, so the rendered script's lines start at column zero.
      let anchor = "if ! /bin/mv -f \"$STAGED\" \"$RESIDENT\"; then"
      guard script.contains(anchor) else {
        throw SwapHarnessError.anchorMissing(anchor)
      }
      let fifo = fixture.root.appendingPathComponent("window.fifo", isDirectory: false)
      guard mkfifo(fifo.path, 0o600) == 0 else { throw SwapHarnessError.fifoFailed }
      fifoURL = fifo
      script = script.replacingOccurrences(
        of: anchor,
        with: """
          # ── injected by the test harness (F4) ──────────────────────────────────────────────
          # The resident bundle is at .previous and the staged one has NOT moved in: this is
          # exactly the window acceptance item 6 kills the script in. Tell the test we are here,
          # then hold still long enough to be signalled.
          /bin/echo in-window > '\(fifo.path)'
          /bin/sleep 30
          \(anchor)
          """)
    }

    let scriptURL = fixture.root.appendingPathComponent("swap.sh", isDirectory: false)
    try script.write(to: scriptURL, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: scriptURL.path)

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [scriptURL.path]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()

    if let fifoURL {
      // Opening a FIFO for reading blocks until a writer opens it, so this returns at the moment
      // the script reaches the window — and not a millisecond before.
      let reader = FileHandle(forReadingAtPath: fifoURL.path)
      _ = reader?.readData(ofLength: 1)
      try? reader?.close()
      kill(process.processIdentifier, SIGTERM)
    }

    process.waitUntilExit()
    let log = (try? String(contentsOf: toolLog, encoding: .utf8)) ?? ""
    return (process.terminationStatus, log)
  }

  enum SwapHarnessError: Error {
    /// The line the F4 rendezvous is injected against is gone. Fail loudly: silently skipping the
    /// injection is how acceptance item 6 came to be tested by a test that could not fail.
    case anchorMissing(String)
    case fifoFailed
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
    // Fix 1, F5: the reason is a plain sentence and the version has its own field. Nothing is
    // packed into a delimiter and nothing is parsed back out.
    #expect(result.reportedErrorLine == "the downloaded file did not match its checksum")
    #expect(!(result.reportedErrorLine ?? "").contains("0.1.8"))
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

  @Test func aScriptKilledBetweenTheTwoMovesRestoresThePreviousBundle() throws {
    // ─── ACCEPTANCE ITEM 6, AND THIS TIME IT IS PROVED ────────────────────────────────────────
    // "A swap script killed between the two moves. The resident path holds a working bundle
    // afterwards, and the room polls again without a visit." §13.5 singles this out as the item
    // that must be proven rather than argued.
    //
    // THE FIRST VERSION OF THIS TEST PROVED NOTHING (Fix 1, F4). It signalled 0.35 s after start
    // against a script whose `sleep` had been patched to zero, so the script had almost always
    // already finished; and it then asserted `resident == "0.1.7" || resident == "0.1.8"`, which
    // is every outcome except an empty path. It passed identically against a script with no trap.
    //
    // A FIFO MAKES THE WINDOW DETERMINISTIC. The harness injects, immediately before the SECOND
    // move, a write to a named pipe and then a long sleep. The test blocks reading that pipe, so
    // it unblocks at the exact instant the script is inside the window — resident already moved to
    // `.previous`, staged not yet moved in — and signals there. No timing guess.
    //
    // THIS DOES NOT COVER `kill -9`, which is not trappable. That residual window is flagged in
    // the build report and V has accepted it as a documented limit.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let staged = fixture.root.appendingPathComponent("staged/EvenScribe Room Recorder.app")
    try fixture.writeBundle(at: staged, version: "0.1.8")

    let run = try Self.runSwapScript(
      fixture, stagedBundle: staged, version: "0.1.8", killInsideTheWindow: true)

    // 1. The room is back on the version it was recording with — not empty, and not half-swapped.
    #expect(fixture.version(of: fixture.resident) == "0.1.7")
    #expect(
      FileManager.default.isExecutableFile(
        atPath: fixture.resident.appendingPathComponent("Contents/MacOS/room-recorder").path))
    // 2. `.previous` was consumed by the restore, not left behind as a second copy.
    #expect(!FileManager.default.fileExists(atPath: fixture.previous.path))
    // 3. The failure is on the record, so the fleet card can say why the version did not change.
    let result = try #require(Self.readResult(fixture))
    #expect(result.outcome == .swapFailed)
    #expect(result.version == "0.1.8")
    #expect(result.reason?.contains("interrupted") == true)
    // 4. The agent is running again — "the room polls again without a visit" is the whole ask.
    #expect(run.toolLog.contains("launchctl bootstrap"))
  }

  // MARK: - F2: a repeatable failure must not loop

  @Test func twoFailedSwapsOfOneVersionGiveExactlyOneRetryThenNoFurtherDownload() async throws {
    // ─── THE LOOP THIS CLOSES ─────────────────────────────────────────────────────────────────
    // A resident-verify failure restores `.previous`, launchd starts the old app, and a second and
    // a half later it asks again, is offered the same version, downloads ~90 MB again — the STAGED
    // check passed last time; it was the RESIDENT check that failed — spawns again and exits 64
    // again. Every eighty seconds or so, for ever, each cycle passing through the window where the
    // resident bundle does not exist.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let bytes = Data("a plausible zip".utf8)

    /// One whole process lifetime: read whatever the last one left on disk, try, hand over.
    func oneBoot() async -> RoomUpdateAttempt {
      let runner = RecordingRunner(exitCodes: ["/usr/bin/ditto": 0, "/usr/bin/codesign": 0])
      runner.dittoProducesBundleNamed = "EvenScribe Room Recorder.app"
      let updater = RoomUpdater(
        rootURL: fixture.root, residentBundleURL: fixture.resident, runningVersion: "0.1.7",
        channel: "stable",
        fetcher: StubFetcher(release: descriptor(version: "0.1.8", bytes: bytes)),
        downloader: StubDownloader(bytes: bytes), runner: runner, log: { _ in })
      let attempt = await updater.check(sessionIsOpen: false)
      if case .handedOver = attempt {
        // The swap script would now fail its resident verify and write this. The NEXT process is
        // what counts it — exactly as RoomEngine.init does.
        RoomUpdateResult(
          outcome: .swapFailed, version: "0.1.8",
          reason: "the new version did not satisfy the pinned signing requirement", at: Date()
        ).write(root: fixture.root)
        roomUpdateRecordFailure(
          previous: RoomUpdateAttempts.read(root: fixture.root), version: "0.1.8", now: Date()
        ).write(root: fixture.root)
        RoomUpdateResult.delete(root: fixture.root)
      }
      return attempt
    }

    // Boot 1: the first attempt. Boot 2: the ONE retry. Boot 3 onwards: held.
    #expect(await oneBoot() == .handedOver(version: "0.1.8"))
    #expect(await oneBoot() == .handedOver(version: "0.1.8"))
    #expect(await oneBoot() == .heldAfterRepeatedFailure(version: "0.1.8"))
    #expect(await oneBoot() == .heldAfterRepeatedFailure(version: "0.1.8"))
  }

  @Test func aHeldVersionDownloadsNothingAtAll() async throws {
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    RoomUpdateAttempts(version: "0.1.8", failures: 2, holdUntil: Date().addingTimeInterval(3600))
      .write(root: fixture.root)
    let downloader = CountingDownloader()
    let updater = RoomUpdater(
      rootURL: fixture.root, residentBundleURL: fixture.resident, runningVersion: "0.1.7",
      channel: "stable",
      fetcher: StubFetcher(release: descriptor(version: "0.1.8", bytes: Data([0x01]))),
      downloader: downloader, runner: RecordingRunner(), log: { _ in })

    #expect(await updater.check(sessionIsOpen: false) == .heldAfterRepeatedFailure(version: "0.1.8"))
    #expect(await downloader.count == 0)
    #expect(!FileManager.default.fileExists(atPath: fixture.staging.path))
  }

  @Test func aDifferentVersionIsNeverHeldByTheOneBeforeIt() async throws {
    // Withdrawing the bad release and publishing a good one must reach the room AT ONCE, without
    // waiting out a backoff earned by the build it replaces. This is also what makes rollback work
    // after a failure — the previous version is a different version.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    RoomUpdateAttempts(version: "0.1.8", failures: 2, holdUntil: Date().addingTimeInterval(3600))
      .write(root: fixture.root)
    let bytes = Data("a plausible zip".utf8)
    let runner = RecordingRunner(exitCodes: ["/usr/bin/ditto": 0, "/usr/bin/codesign": 0])
    runner.dittoProducesBundleNamed = "EvenScribe Room Recorder.app"
    let updater = RoomUpdater(
      rootURL: fixture.root, residentBundleURL: fixture.resident, runningVersion: "0.1.7",
      channel: "stable",
      fetcher: StubFetcher(release: descriptor(version: "0.1.9", bytes: bytes)),
      downloader: StubDownloader(bytes: bytes), runner: runner, log: { _ in })

    #expect(await updater.check(sessionIsOpen: false) == .handedOver(version: "0.1.9"))
  }

  @Test func theLedgerIsPureAboutCountingAndHolding() {
    let t0 = Date(timeIntervalSince1970: 1_757_400_000)
    let first = roomUpdateRecordFailure(previous: nil, version: "0.1.8", now: t0)
    #expect(first.failures == 1)
    #expect(first.holdUntil == nil)  // one retry still owed

    let second = roomUpdateRecordFailure(previous: first, version: "0.1.8", now: t0)
    #expect(second.failures == 2)
    #expect(second.holdUntil == t0.addingTimeInterval(RoomSelfUpdate.retryHold))

    // A failure on a DIFFERENT version starts its own count from one.
    let other = roomUpdateRecordFailure(previous: second, version: "0.1.9", now: t0)
    #expect(other.version == "0.1.9")
    #expect(other.failures == 1)
    #expect(other.holdUntil == nil)

    #expect(roomUpdateIsHeld(attempts: second, version: "0.1.8", now: t0))
    #expect(!roomUpdateIsHeld(attempts: second, version: "0.1.9", now: t0))
    #expect(!roomUpdateIsHeld(attempts: first, version: "0.1.8", now: t0))  // retry still owed
    // The hold expires. It is a pause, not a tombstone.
    #expect(
      !roomUpdateIsHeld(
        attempts: second, version: "0.1.8",
        now: t0.addingTimeInterval(RoomSelfUpdate.retryHold + 1)))
  }

  @Test func aVersionMatchClearsTheLedger() async throws {
    // The Mac is now running what its channel offers, so whatever went wrong before is spent.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    RoomUpdateAttempts(version: "0.1.8", failures: 2, holdUntil: Date().addingTimeInterval(3600))
      .write(root: fixture.root)
    let updater = RoomUpdater(
      rootURL: fixture.root, residentBundleURL: fixture.resident, runningVersion: "0.1.8",
      channel: "stable",
      fetcher: StubFetcher(release: descriptor(version: "0.1.8", bytes: Data([0x01]))),
      downloader: CountingDownloader(), runner: RecordingRunner(), log: { _ in })

    #expect(await updater.check(sessionIsOpen: false) == .upToDate)
    #expect(RoomUpdateAttempts.read(root: fixture.root) == nil)
  }

  // MARK: - F3: the restarted app must not delete the running script's staging directory

  @Test func staginIsLeftAloneWhileAHandoverIsInFlight() {
    let t0 = Date(timeIntervalSince1970: 1_757_400_000)
    // No marker: nothing is in flight, sweep freely.
    #expect(roomUpdateMayClearStaging(handover: nil, now: t0))
    // Fresh marker: the swap script is running out of that directory RIGHT NOW.
    let fresh = RoomUpdateHandover(version: "0.1.8", at: t0)
    #expect(!roomUpdateMayClearStaging(handover: fresh, now: t0))
    #expect(!roomUpdateMayClearStaging(handover: fresh, now: t0.addingTimeInterval(60)))
    // Stale marker: the script died without writing a result. ~90 MB must not sit there for ever.
    #expect(
      roomUpdateMayClearStaging(
        handover: fresh, now: t0.addingTimeInterval(RoomSelfUpdate.handoverGrace + 1)))
  }

  @Test func theHandoverMarkerIsWrittenBeforeTheScriptIsSpawned() async throws {
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let bytes = Data("a plausible zip".utf8)
    let runner = RecordingRunner(exitCodes: ["/usr/bin/ditto": 0, "/usr/bin/codesign": 0])
    runner.dittoProducesBundleNamed = "EvenScribe Room Recorder.app"
    // The marker has to exist by the time the script can run, so the runner checks AT SPAWN.
    runner.markerPathAtSpawn = RoomSelfUpdate.handoverMarkerURL(root: fixture.root).path
    let updater = RoomUpdater(
      rootURL: fixture.root, residentBundleURL: fixture.resident, runningVersion: "0.1.7",
      channel: "stable",
      fetcher: StubFetcher(release: descriptor(version: "0.1.8", bytes: bytes)),
      downloader: StubDownloader(bytes: bytes), runner: runner, log: { _ in })

    #expect(await updater.check(sessionIsOpen: false) == .handedOver(version: "0.1.8"))
    #expect(runner.markerExistedAtSpawn == true)
    let marker = try #require(RoomUpdateHandover.read(root: fixture.root))
    #expect(marker.version == "0.1.8")
    // And the staging directory the script needs is still there.
    #expect(FileManager.default.fileExists(atPath: fixture.staging.path))
  }

  // MARK: - F8: the receipt survives a version that is not JSON-safe

  @Test func aVersionCarryingQuotesOrBackslashesStillProducesAReadableReceipt() throws {
    // The version comes off the server. A `"` in it used to close the JSON string in the swap
    // script's heredoc and produce a receipt the app could not decode — losing the very outcome
    // the receipt exists to carry.
    for nasty in ["0.1.8\"evil", "0.1.8\\evil", "0.1.8\"; rm -rf /; \""] {
      let fixture = try Fixture.make()
      defer { fixture.tearDown() }
      let staged = fixture.root.appendingPathComponent("staged/EvenScribe Room Recorder.app")
      try fixture.writeBundle(at: staged, version: "0.1.8")
      _ = try Self.runSwapScript(
        fixture, stagedBundle: staged, version: nasty, codesignExit: 1)
      let decoded = try #require(
        Self.readResult(fixture), "a receipt for version \(nasty) could not be decoded")
      #expect(decoded.version == nasty)
      #expect(decoded.outcome == .swapFailed)
    }
  }

  @Test func theJSONEscaperHandlesWhatJSONRequires() {
    #expect(RoomSwapScript.jsonStringBody("0.1.8") == "0.1.8")
    #expect(RoomSwapScript.jsonStringBody("a\"b") == #"a\"b"#)
    #expect(RoomSwapScript.jsonStringBody("a\\b") == #"a\\b"#)
    #expect(RoomSwapScript.jsonStringBody("a\nb") == #"a\nb"#)
    // Backslash first, or the quote rule's own backslash gets escaped twice.
    #expect(RoomSwapScript.jsonStringBody("\\\"") == #"\\\""#)
    // C0 controls are not allowed raw inside a JSON string.
    #expect(RoomSwapScript.jsonStringBody("a\u{01}b") == #"a\u0001b"#)
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
        == "the downloaded file did not match its checksum")
    #expect(RoomUpdateResult.read(root: fixture.root)?.version == "0.1.8")
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
      lastUpdateResult: "checksum_mismatch", lastUpdateVersion: "0.1.8",
      lastUpdateError: "the downloaded file did not match its checksum",
      lastUpdateAt: "2026-09-09T09:14:00Z", diskFreeBytes: 412_300_000_000)
    let items = Dictionary(
      uniqueKeysWithValues: full.queryItems().map { ($0.name, $0.value ?? "") })
    #expect(items["session_open"] == "false")
    #expect(items["update_channel"] == "test")
    #expect(items["disk_free_bytes"] == "412300000000")
    #expect(items["last_update_result"] == "checksum_mismatch")
    #expect(items["last_update_version"] == "0.1.8")
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
  /// F3. When set, `spawnDetached` records whether this path existed at the moment of the spawn —
  /// the marker has to be on disk BEFORE the script can run, not after.
  var markerPathAtSpawn: String?
  private(set) var markerExistedAtSpawn: Bool?

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
    if let markerPathAtSpawn {
      markerExistedAtSpawn = FileManager.default.fileExists(atPath: markerPathAtSpawn)
    }
    lock.withLock { _spawned.append((executable, arguments)) }
  }
}
