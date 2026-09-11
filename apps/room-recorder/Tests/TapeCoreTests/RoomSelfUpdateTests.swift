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
      // Release B1. The canary records what the room was running before the swap, and the script
      // reads it with `plutil -extract CFBundleShortVersionString` from the bundle at `.previous`
      // — so a fake bundle needs a real plist or the rollback receipt says `unknown` and the test
      // proves nothing about the sentence the fleet card will show.
      try PropertyListSerialization.data(
        fromPropertyList: ["CFBundleShortVersionString": version], format: .xml, options: 0
      ).write(to: url.appendingPathComponent("Contents/Info.plist", isDirectory: false))
    }

    var updateLog: String {
      (try? String(contentsOf: RoomSelfUpdate.logURL(root: root), encoding: .utf8)) ?? ""
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

  /// Release B1. What the app does about the launch canary while the watchdog is watching for it.
  enum CanaryBehaviour {
    /// A working build: the app polls and deletes the canary `after` seconds. The default for
    /// every test written before the watchdog existed — without it each of them would sit through
    /// the whole canary window before the script it is testing would exit.
    case acknowledged(after: TimeInterval)
    /// A build that cannot poll. Nobody ever deletes the file, so the watchdog times out and rolls
    /// back — §14.2.3, and the whole reason B1 exists.
    case ignored
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
    killInsideTheWindow: Bool = false,
    /// B1, and the same trick one step further on: the rendezvous goes inside the ROLLBACK, after
    /// the failed bundle has been deleted and before the previous one is put back. That is the
    /// second window in this script where the resident path does not exist, and it is new in B1.
    killInsideTheRollback: Bool = false,
    /// Strip `trap rescue` from the rendered script. F4's lesson, made permanent: a test that
    /// proves a fail-safe must be shown to fail without it, or it is proving nothing.
    withoutTheRescueTrap: Bool = false,
    canary: CanaryBehaviour = .acknowledged(after: 0),
    /// H1. Delete `.previous` the instant the canary is armed, so the watchdog reaches its
    /// rollback with nothing to restore — the state a first-ever swap leaves behind.
    removePreviousOnceArmed: Bool = false,
    /// The watchdog's window, rewritten in the rendered script exactly the way `/bin/sleep 3` is.
    /// Three minutes of real time per test is not a thing anybody can run.
    canarySeconds: Int = 4,
    canarySlice: Int = 1
  ) throws -> (status: Int32, toolLog: String, elapsed: TimeInterval, canary: RoomUpdateCanary?) {
    #expect(
      !(killInsideTheWindow && killInsideTheRollback),
      "one rendezvous per run; two would deadlock on the same FIFO")
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

    // B1 §14.2 step 4: the watchdog's constants are literals in the rendered script, and the
    // harness may rewrite them. Both anchors are checked first — a renamed constant would
    // otherwise leave every test below silently waiting out the real three-minute window.
    let windowAnchor = "CANARY_SECONDS=\(Int(RoomSelfUpdate.canaryWindow))"
    let sliceAnchor = "CANARY_SLICE=\(Int(RoomSelfUpdate.canarySlice))"
    guard script.contains(windowAnchor) else { throw SwapHarnessError.anchorMissing(windowAnchor) }
    guard script.contains(sliceAnchor) else { throw SwapHarnessError.anchorMissing(sliceAnchor) }
    script = script.replacingOccurrences(
      of: windowAnchor, with: "CANARY_SECONDS=\(canarySeconds)")
    script = script.replacingOccurrences(of: sliceAnchor, with: "CANARY_SLICE=\(canarySlice)")

    // The negative control for the rescue trap. Removing the line is the only honest way to show
    // that the tests below fail without it.
    if withoutTheRescueTrap {
      let trap = "trap rescue INT TERM HUP QUIT"
      guard script.contains(trap) else { throw SwapHarnessError.anchorMissing(trap) }
      script = script.replacingOccurrences(
        of: trap, with: "# the rescue trap, removed by the test harness on purpose")
    }

    // F4. The rendezvous, injected between the two moves and nowhere else. The anchor is the
    // second move's own line, so if that line is ever reworded this harness fails loudly rather
    // than silently going back to testing nothing.
    var fifoURL: URL?
    if killInsideTheWindow || killInsideTheRollback {
      // NO leading indent: Swift strips the multiline literal's indentation relative to its
      // closing delimiter, so the rendered script's lines start at column zero.
      //
      // The rollback's own restore is not reachable by its `mv` alone — three failure paths in
      // this script move `$PREVIOUS` back — so the anchor is the line ABOVE it, which is unique,
      // and the rendezvous goes between the two.
      //
      // H1 MOVED THIS WINDOW. The rollback used to delete the failed bundle before attempting the
      // restore; now `.failed` outlives the restore and the empty-resident window sits between
      // `mv resident→.failed` and the checked `mv previous→resident`. The anchor guard below is
      // what caught the drift the moment the order changed, which is the whole reason it exists.
      let anchor =
        killInsideTheWindow
        ? "if ! /bin/mv -f \"$STAGED\" \"$RESIDENT\"; then"
        : "if ! /bin/mv -f \"$PREVIOUS\" \"$RESIDENT\"; then"
      guard script.contains(anchor) else {
        throw SwapHarnessError.anchorMissing(anchor)
      }
      let fifo = fixture.root.appendingPathComponent("window.fifo", isDirectory: false)
      guard mkfifo(fifo.path, 0o600) == 0 else { throw SwapHarnessError.fifoFailed }
      fifoURL = fifo
      let rendezvous = """
        # ── injected by the test harness (F4) ──────────────────────────────────────────────
        # The resident path does not exist at this instant: this is exactly the window a killed
        # script must survive. Tell the test we are here, then hold still long enough to be
        # signalled.
        /bin/echo in-window > '\(fifo.path)'
        # SHORT SLEEPS IN A LOOP, not one long one. Bash defers a trap until the current
        # foreground command returns, so a single `/bin/sleep 30` made this test take thirty
        # seconds every time the SIGTERM lost the race to the fork. Fifty-millisecond slices hold
        # the window open just as reliably and let the trap fire at once.
        #
        # 400 SLICES, twenty seconds (Fix 2 G6's owed minor): the reader's deadline is ten, and a
        # window that closes at the same instant the reader gives up is a race nobody needs.
        for _ in $(/usr/bin/seq 1 400); do /bin/sleep 0.05; done
        """
      // Both windows are entered by a checked `mv` whose own line is unique, so the rendezvous
      // goes immediately before it in either case: resident already moved aside, replacement not
      // yet moved in.
      script = script.replacingOccurrences(of: anchor, with: rendezvous + "\n" + anchor)
    }

    let scriptURL = fixture.root.appendingPathComponent("swap.sh", isDirectory: false)
    try script.write(to: scriptURL, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: scriptURL.path)

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [scriptURL.path]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice

    // ─── THE APP'S HALF OF THE CANARY, STOOD IN FOR BY A THREAD ────────────────────────────
    // There is no app in this test — the script has just "started" a stub launchctl — so the
    // acknowledgement has to come from somewhere. This thread is that somewhere: it waits for the
    // canary to appear, keeps a copy of it (the only chance anyone gets to read the file the
    // script writes), waits `after`, and deletes it, exactly as `roomCanaryAcknowledge` does on
    // the app's first successful poll.
    let observed = CanaryObservation()
    let started = Date()
    try process.run()
    let acknowledges: Bool
    if case .acknowledged = canary { acknowledges = true } else { acknowledges = false }
    if acknowledges || removePreviousOnceArmed {
      let canaryURL = RoomSelfUpdate.canaryURL(root: fixture.root)
      let previousURL = fixture.previous
      Thread.detachNewThread {
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
          if let data = try? Data(contentsOf: canaryURL) {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            observed.store(try? decoder.decode(RoomUpdateCanary.self, from: data))
            // H1. Take `.previous` away at the one moment it matters: the canary is armed, so the
            // swap is done and the watchdog is counting, and the rollback that follows will find
            // nothing to go back to.
            if removePreviousOnceArmed { try? FileManager.default.removeItem(at: previousURL) }
            if case .acknowledged(let after) = canary {
              Thread.sleep(forTimeInterval: after)
              try? FileManager.default.removeItem(at: canaryURL)
            }
            return
          }
          if observed.isStopped { return }
          Thread.sleep(forTimeInterval: 0.02)
        }
      }
    }
    defer { observed.stop() }

    if let fifoURL {
      // Opening a FIFO for reading normally BLOCKS until a writer opens it, which is precisely the
      // rendezvous this test wants — it returns at the moment the script reaches the window, and
      // not a millisecond before.
      //
      // ─── BUT A BLOCKING OPEN NEVER TIMES OUT (Fix 2, G6) ─────────────────────────────────
      // If the script dies before the anchor — a bad stub, a `set -u` trip, an edit that breaks
      // the script — nothing ever opens the write end and the whole suite hangs for ever with no
      // diagnosis. A test that cannot fail is bad; a test that cannot FINISH is worse, because it
      // takes every other test with it.
      //
      // So: open non-blocking, then poll for a byte for at most ten seconds. `O_NONBLOCK` on a
      // FIFO read end succeeds immediately even with no writer, and reads return EAGAIN until one
      // arrives — which is what turns "wait for ever" into "wait, with a deadline". The green path
      // is unchanged: the first byte still arrives inside the window.
      let fd = open(fifoURL.path, O_RDONLY | O_NONBLOCK)
      guard fd >= 0 else {
        process.terminate()
        throw SwapHarnessError.fifoFailed
      }
      defer { close(fd) }

      var byte: UInt8 = 0
      var reached = false
      let deadline = Date().addingTimeInterval(10)
      while Date() < deadline {
        let n = read(fd, &byte, 1)
        if n > 0 {
          reached = true
          break
        }
        // n == 0 is "no writer yet"; n < 0 with EAGAIN is "writer open, nothing written yet".
        // Neither is fatal. Anything else is.
        if n < 0 && errno != EAGAIN && errno != EINTR { break }
        usleep(2000)
      }
      guard reached else {
        // Kill it before throwing: a script left sleeping in the window would hold the temporary
        // tree open and leak a process out of the test run.
        kill(process.processIdentifier, SIGKILL)
        process.waitUntilExit()
        throw SwapHarnessError.windowNeverReached
      }
      kill(process.processIdentifier, SIGTERM)
    }

    process.waitUntilExit()
    let elapsed = Date().timeIntervalSince(started)
    let log = (try? String(contentsOf: toolLog, encoding: .utf8)) ?? ""
    return (process.terminationStatus, log, elapsed, observed.value)
  }

  /// What the acknowledging thread saw, handed back across the thread boundary.
  final class CanaryObservation: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: RoomUpdateCanary?
    private var stopped = false

    func store(_ canary: RoomUpdateCanary?) {
      lock.lock()
      defer { lock.unlock() }
      stored = canary
    }

    var value: RoomUpdateCanary? {
      lock.lock()
      defer { lock.unlock() }
      return stored
    }

    /// Ends the thread when the script exited without ever arming a canary — a codesign failure,
    /// say. Nothing here may outlive the run that started it.
    func stop() {
      lock.lock()
      defer { lock.unlock() }
      stopped = true
    }

    var isStopped: Bool {
      lock.lock()
      defer { lock.unlock() }
      return stopped
    }
  }

  enum SwapHarnessError: Error {
    /// The line the F4 rendezvous is injected against is gone. Fail loudly: silently skipping the
    /// injection is how acceptance item 6 came to be tested by a test that could not fail.
    case anchorMissing(String)
    case fifoFailed
    /// Fix 2, G6. Ten seconds passed and the script never reached the window between the two
    /// moves. Something upstream of the rendezvous broke; say so instead of hanging the suite.
    case windowNeverReached
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

    // Release B2 (D2) reversed the rule this line used to hold. A session ending IS by itself a
    // reason to ask again, deferred or not: on 11 Sep `stable` moved while five rooms were
    // recording, nothing had been deferred, and ending their tapes checked nothing.
    schedule.deferredWhileRecording = false
    #expect(schedule.isDue(now: oneMinuteLater, sessionJustEnded: true))
  }

  @Test func aSessionEndMakesTheCheckDueEvenWhenNothingWasDeferred() {
    // B2-D2. 11 Sep 11:42Z: `stable` moved at 11:35:45Z while five rooms were mid-session. None had
    // checked during the session, so none had deferred, and R3-10's early re-run never fired —
    // all five needed `kickstart -k`. Every session end is a check now.
    let start = Date(timeIntervalSince1970: 1_757_400_000)
    let schedule = RoomUpdateSchedule(lastCheckedAt: start, deferredWhileRecording: false)
    let oneMinuteLater = start.addingTimeInterval(60)
    #expect(schedule.isDue(now: oneMinuteLater, sessionJustEnded: true))
    // The six-hour interval still governs every poll that is not a session end, which is what
    // keeps a check from firing while a session is open: `sessionJustEnded` is only ever true on
    // the poll where the session has already closed.
    #expect(!schedule.isDue(now: oneMinuteLater, sessionJustEnded: false))
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
    runner.dittoProducesVersion = "0.1.8"
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
    runner.dittoProducesVersion = "0.1.8"
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
    // 0.1.18: the leaf hash alone. `anchor trusted` asked the Mac's trust settings a question a
    // clinic Mac cannot answer without a click at its screen (Room 4.1, 11 Sep).
    #expect(RoomSelfUpdate.pinnedRequirement.hasPrefix("= certificate leaf"))
    #expect(!RoomSelfUpdate.pinnedRequirement.contains("anchor trusted"))
    #expect(RoomSelfUpdate.pinnedLeafSHA1 == "187dd424fb866204111113d60c6f88a21d098edb")
  }

  @Test func theRenderedSwapScriptVerifiesAgainstTheLeafOnlyRequirement() {
    // 0.1.18. Step 8.5 of the swap script re-verifies the bundle at the resident path with the same
    // constant. Were it still asking `anchor trusted`, a clinic Mac that passed step 6b would put
    // the previous version back at the swap.
    let script = RoomSwapScript.render(
      residentBundleURL: URL(fileURLWithPath: "/Applications/EvenScribe Room Recorder.app"),
      stagedBundleURL: URL(fileURLWithPath: "/tmp/staged/EvenScribe Room Recorder.app"),
      rootURL: URL(fileURLWithPath: "/tmp/room-root"),
      version: "0.1.18")
    #expect(
      script.contains(
        #"REQUIREMENT='= certificate leaf = H"187dd424fb866204111113d60c6f88a21d098edb"'"#))
    #expect(!script.contains("anchor trusted"))
  }

  @Test func aCleanStagingEndsInADetachedSpawnAndAHandover() async throws {
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let bytes = Data("a plausible zip".utf8)
    let runner = RecordingRunner(exitCodes: ["/usr/bin/ditto": 0, "/usr/bin/codesign": 0])
    runner.dittoProducesBundleNamed = "EvenScribe Room Recorder.app"
    runner.dittoProducesVersion = "0.1.8"
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
    // B2-D12. Staged where the app stages it — `update-staging/expanded/` beside the zip — so the
    // sweep below is tested against the real shape: the ~90 MB the B1 report found left behind.
    let staged = fixture.staging.appendingPathComponent("expanded/EvenScribe Room Recorder.app")
    try fixture.writeBundle(at: staged, version: "0.1.8")
    try Data("a plausible zip".utf8).write(
      to: fixture.staging.appendingPathComponent("app.zip", isDirectory: false))

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
    // 5. B2-D12. THE STAGED COPY IS GONE. `rescue()` put the old bundle back and then swept the
    //    staging directory, zip and unmoved bundle with it; before 0.1.20 nothing on any path did.
    #expect(!FileManager.default.fileExists(atPath: fixture.staging.path))
  }

  // MARK: - Release B1: the launch canary (§14.2)

  @Test func theCanaryWindowIsThreeMinutes() {
    // V's ruling, 10 September 2026 (B1-D1). Pinned as a number because the number is the ratified
    // thing, and because the receipt's sentence quotes it: a change here that did not reach the
    // sentence would put a lie on the fleet card.
    #expect(RoomSelfUpdate.canaryWindow == 180)
    #expect(RoomSelfUpdate.canarySlice == 2)
  }

  @Test func theWatchdogExitsWhenTheCanaryIsAcknowledged() throws {
    // §14.2 steps 1 to 3, the ordinary path: the new version launches, polls, deletes the canary,
    // and the script — which has stayed alive purely to watch for that — stands down.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let staged = fixture.root.appendingPathComponent("staged/EvenScribe Room Recorder.app")
    try fixture.writeBundle(at: staged, version: "0.1.11")

    // What the app wrote before it exited 64. It has to be here for the assertion below to mean
    // anything.
    RoomUpdateHandover(version: "0.1.11", at: Date()).write(root: fixture.root)

    let run = try Self.runSwapScript(
      fixture, stagedBundle: staged, version: "0.1.11", canary: .acknowledged(after: 1))

    #expect(run.status == 0)
    // It exited on the acknowledgement, not on the window: four seconds was the whole budget.
    // A timeout run cannot finish before the four seconds of sleeps it is made of, so this still
    // says "it exited on the acknowledgement" — with a margin that survives a busy Mini.
    #expect(run.elapsed < 3.5, "the watchdog waited \(run.elapsed)s for an ack it already had")

    // §14.2.1 — the file the app reads, with the version that was swapped in and the one it
    // replaced. `previous` comes out of the previous bundle's own Info.plist, which is the only
    // place that still knows it.
    let canary = try #require(run.canary, "the script never armed a canary")
    #expect(canary.version == "0.1.11")
    #expect(canary.previous == "0.1.7")
    #expect(abs(canary.armedAt.timeIntervalSinceNow) < 120)

    // The swap stands. Nothing on the success path touches `.previous`.
    #expect(fixture.version(of: fixture.resident) == "0.1.11")
    #expect(fixture.version(of: fixture.previous) == "0.1.7")
    #expect(!FileManager.default.fileExists(atPath: RoomSelfUpdate.canaryURL(root: fixture.root).path))
    let result = try #require(Self.readResult(fixture))
    #expect(result.outcome == .ok)
    #expect(fixture.updateLog.contains("armed the canary for 0.1.11"))
    #expect(fixture.updateLog.contains("acknowledged the canary"))
    // H2's counterpart: on the SUCCESS path the marker is the app's to clear, not the script's.
    // Clearing it here would let the restarted app sweep the staging directory this script is
    // still running out of.
    #expect(RoomUpdateHandover.read(root: fixture.root) != nil)
  }

  @Test func theWatchdogTakesAnAcknowledgementInTheFinalSlice() throws {
    // ─── THE BLIND SLICE THE LOOP LEAVES BEHIND ──────────────────────────────────────────────
    // The loop takes its last look one slice BEFORE the window closes — at 178 s of 180 — and
    // then sleeps through the rest. An app acknowledging in that gap, which is exactly where a
    // slow cold launch on a busy clinic Mac lands, would have had a working build deleted and a
    // failure written against it. Here the ack lands at 3.5 s of a 4-second window, after the
    // loop's final iteration and before the window closes: only the check at the top of the
    // rollback can catch it.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let staged = fixture.root.appendingPathComponent("staged/EvenScribe Room Recorder.app")
    try fixture.writeBundle(at: staged, version: "0.1.11")

    let run = try Self.runSwapScript(
      fixture, stagedBundle: staged, version: "0.1.11", canary: .acknowledged(after: 3.5))

    #expect(run.status == 0)
    #expect(fixture.version(of: fixture.resident) == "0.1.11")
    #expect(fixture.version(of: fixture.previous) == "0.1.7")
    let result = try #require(Self.readResult(fixture))
    #expect(result.outcome == .ok, "a build that polled was rolled back")
    #expect(!fixture.updateLog.contains("rolling back"))
  }

  @Test func theWatchdogRollsBackWhenNobodyPolls() throws {
    // ─── THE FAILURE B1 EXISTS FOR ────────────────────────────────────────────────────────────
    // A build that installs cleanly — checksum, signature, plist, resident-verify all pass — and
    // then cannot poll. `KeepAlive` restarts it for ever and the updater lives inside it, so the
    // room can never be told to go back. Nobody deletes the canary here; the watchdog times out
    // and does §14.2.3, in order.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let staged = fixture.root.appendingPathComponent("staged/EvenScribe Room Recorder.app")
    try fixture.writeBundle(at: staged, version: "0.1.11")
    // What the app wrote before it exited 64, and what keeps the staging directory alive.
    RoomUpdateHandover(version: "0.1.11", at: Date()).write(root: fixture.root)

    let run = try Self.runSwapScript(
      fixture, stagedBundle: staged, version: "0.1.11", canary: .ignored)

    #expect(run.status == 1)
    // The room is back on the version it was recording with, and the broken one is gone rather
    // than parked at `.previous` where the next swap would find it.
    #expect(fixture.version(of: fixture.resident) == "0.1.7")
    #expect(!FileManager.default.fileExists(atPath: fixture.previous.path))
    #expect(
      !FileManager.default.fileExists(atPath: fixture.resident.path + ".failed"))
    #expect(!FileManager.default.fileExists(atPath: RoomSelfUpdate.canaryURL(root: fixture.root).path))

    // §14.2, B1-D6: the receipt names the version that failed and the one it went back to, in the
    // sentence the fleet card shows. The number in it is the ratified window, not the harness's.
    let result = try #require(Self.readResult(fixture))
    #expect(result.outcome == .swapFailed)
    #expect(result.version == "0.1.11")
    #expect(result.reason == "the new version did not poll within 180 s; restored 0.1.7")

    // Booted out, then in again — in that order, and last: the agent is running when this script
    // ends, which is the only thing that makes the room poll again without a visit.
    let verbs = run.toolLog.split(separator: "\n")
      .filter { $0.hasPrefix("launchctl ") }
      .compactMap { $0.split(separator: " ").dropFirst().first.map(String.init) }
    #expect(verbs.suffix(2) == ["bootout", "bootstrap"])

    // Every step of §14.2.3 said so where an operator can read it afterwards.
    // H2. The handover is over: the room is back on the old version, the canary the app would
    // have acknowledged is gone, and nothing else will ever clear this.
    #expect(RoomUpdateHandover.read(root: fixture.root) == nil)

    let log = fixture.updateLog
    #expect(log.contains("0.1.11 did not poll within 4s"))
    #expect(log.contains("rolling back to 0.1.7"))
    #expect(log.contains("booted the agent out"))
    #expect(log.contains("moved 0.1.11 aside"))
    #expect(log.contains("deleted 0.1.11"))
    #expect(log.contains("restored 0.1.7"))
    #expect(log.contains("recorded swap_failed"))
    #expect(log.contains("rolled back to 0.1.7 and bootstrapped"))
  }

  @Test func theRollbackRefusesWhenThereIsNoPreviousBundle() throws {
    // ─── H1: THE ROLLBACK MUST NOT BE THE THING THAT BRICKS A ROOM ───────────────────────────
    // The first cut moved the resident bundle aside, DELETED it, and then ran an unchecked
    // `mv "$PREVIOUS"`. With no `.previous` on disk the room ended with an empty resident path and
    // launchd pointed at nothing — a visit, caused by the code that exists to prevent visits.
    //
    // A room left running a broken build still thrashes under KeepAlive, still holds after its
    // retry, and still takes a republish the moment it can poll. A room with no bundle takes a
    // drive. So the guard keeps the new version and says so.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let staged = fixture.root.appendingPathComponent("staged/EvenScribe Room Recorder.app")
    try fixture.writeBundle(at: staged, version: "0.1.11")

    // `.previous` is taken away the instant the canary is armed — after the swap, while the
    // watchdog is counting — which is the state a Mac whose first-ever swap this is would be in.
    let run = try Self.runSwapScript(
      fixture, stagedBundle: staged, version: "0.1.11",
      canary: .ignored, removePreviousOnceArmed: true)

    #expect(run.status == 1)
    // THE ROOM STILL HAS A BUNDLE, and it is the new one — nothing was moved, nothing deleted.
    #expect(fixture.version(of: fixture.resident) == "0.1.11")
    #expect(
      FileManager.default.isExecutableFile(
        atPath: fixture.resident.appendingPathComponent("Contents/MacOS/room-recorder").path))
    #expect(!FileManager.default.fileExists(atPath: fixture.resident.path + ".failed"))
    #expect(!FileManager.default.fileExists(atPath: fixture.previous.path))

    // The receipt says which of the two failures this was, so the card does not read as a
    // successful rollback that it was not.
    let result = try #require(Self.readResult(fixture))
    #expect(result.outcome == .swapFailed)
    #expect(result.version == "0.1.11")
    #expect(result.reason?.contains("no previous bundle was present to restore") == true)
    #expect(!FileManager.default.fileExists(atPath: RoomSelfUpdate.canaryURL(root: fixture.root).path))

    // THE AGENT IS LEFT RUNNING, NOT BOOTSTRAPPED AGAIN. The guard returns before the rollback's
    // `bootout`, so the agent is still loaded from step 8.8 and still restarting the broken build:
    // there is nothing to put back, and a `bootstrap` of a loaded job is at best a no-op. Only the
    // swap's own pair — 8.1's bootout and 8.8's bootstrap — appears; the rollback adds neither.
    let verbs = run.toolLog.split(separator: "\n")
      .filter { $0.hasPrefix("launchctl ") }
      .compactMap { $0.split(separator: " ").dropFirst().first.map(String.init) }
    #expect(verbs == ["bootout", "bootstrap"], "saw \(verbs)")
    #expect(fixture.updateLog.contains("no previous bundle to restore; leaving 0.1.11 in place"))
    #expect(!fixture.updateLog.contains("rolling back"))
  }

  @Test func aScriptKilledInsideTheRollbackRestoresThePreviousBundle() throws {
    // The rollback opens a SECOND window in which the resident path does not exist — between
    // moving the failed bundle aside and putting the previous one back. It is new in B1, it runs
    // unattended three minutes after everybody has stopped watching, and a script killed inside it
    // would leave launchd with nothing to start. The same trap that covers the swap covers this;
    // the same FIFO rendezvous proves it.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let staged = fixture.root.appendingPathComponent("staged/EvenScribe Room Recorder.app")
    try fixture.writeBundle(at: staged, version: "0.1.11")
    // What the app left in staging before it exited 64; the rescue in the rollback sweeps it too.
    try FileManager.default.createDirectory(at: fixture.staging, withIntermediateDirectories: true)
    try Data("a plausible zip".utf8).write(
      to: fixture.staging.appendingPathComponent("app.zip", isDirectory: false))

    let run = try Self.runSwapScript(
      fixture, stagedBundle: staged, version: "0.1.11",
      killInsideTheRollback: true, canary: .ignored, canarySeconds: 2)

    // 1. A working bundle is resident. Not empty, not the broken one.
    #expect(fixture.version(of: fixture.resident) == "0.1.7")
    #expect(
      FileManager.default.isExecutableFile(
        atPath: fixture.resident.appendingPathComponent("Contents/MacOS/room-recorder").path))
    // 2. `.previous` was consumed by the restore.
    #expect(!FileManager.default.fileExists(atPath: fixture.previous.path))
    // 2a. AND `<resident>.failed` IS GONE. Fix 1 made the failed bundle outlive the restore, so a
    //     kill in this window used to leave ~90 MB of a build that could not poll parked on a Mac
    //     that also holds a clinic day of audio, with nothing on any path to delete it. `rescue()`
    //     now sweeps it immediately after putting the old bundle back (V, 10 Sep, Fix 1 flag 1).
    #expect(!FileManager.default.fileExists(atPath: fixture.resident.path + ".failed"))
    // 3. The interruption is on the record — the rescue's own sentence, not the watchdog's, since
    //    the script died before it could write its own.
    let result = try #require(Self.readResult(fixture))
    #expect(result.outcome == .swapFailed)
    #expect(result.version == "0.1.11")
    #expect(result.reason?.contains("interrupted") == true)
    // 4. And the agent is running again.
    #expect(run.toolLog.contains("launchctl bootstrap"))
    #expect(fixture.updateLog.contains("putting the previous bundle back"))
    // 5. B2-D12 — staging swept after the restore, as in the swap-window kill.
    #expect(!FileManager.default.fileExists(atPath: fixture.staging.path))
  }

  @Test func theRollbackKillIsNotSurvivedWithoutTheRescueTrap() throws {
    // ─── THE PROOF THAT THE TEST ABOVE CAN FAIL (F4's lesson, made permanent) ─────────────────
    // F4 was a test that asserted `resident == "0.1.7" || resident == "0.1.8"` — every outcome
    // except the one that mattered — and passed identically against a script with no trap. So this
    // one runs the same kill with `trap rescue` stripped out and asserts the damage: the resident
    // path is EMPTY, which is a room somebody has to walk to.
    //
    // If this test ever starts passing for the wrong reason — the kill missing the window, the
    // anchor drifting — the one above stops being evidence, and this one says so.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let staged = fixture.root.appendingPathComponent("staged/EvenScribe Room Recorder.app")
    try fixture.writeBundle(at: staged, version: "0.1.11")

    _ = try Self.runSwapScript(
      fixture, stagedBundle: staged, version: "0.1.11",
      killInsideTheRollback: true, withoutTheRescueTrap: true, canary: .ignored, canarySeconds: 2)

    #expect(!FileManager.default.fileExists(atPath: fixture.resident.path))
    // The old bundle is still parked where the rollback left it, with nothing to move it back.
    #expect(fixture.version(of: fixture.previous) == "0.1.7")
  }

  // MARK: - G1: a correctly signed bundle that is labelled wrong

  /// Build an updater whose staged bundle calls itself `stagedVersion` while the release row offers
  /// `offered`. Everything before the version check passes.
  private func mislabelledUpdater(
    _ fixture: Fixture, offered: String, stagedVersion: String?, runner: RecordingRunner
  ) -> RoomUpdater {
    let bytes = Data("a plausible zip".utf8)
    runner.dittoProducesBundleNamed = "EvenScribe Room Recorder.app"
    runner.dittoProducesVersion = stagedVersion
    return RoomUpdater(
      rootURL: fixture.root, residentBundleURL: fixture.resident, runningVersion: "0.1.7",
      channel: "stable",
      fetcher: StubFetcher(release: descriptor(version: offered, bytes: bytes)),
      downloader: StubDownloader(bytes: bytes), runner: runner, log: { _ in })
  }

  @Test func aBundleThatCallsItselfSomethingElseIsStoppedBeforeTheSwap() async throws {
    // ─── THE PUBLISH TYPO, AND WHY IT WAS THE ONE THAT LOOPED ────────────────────────────────
    // The zip is authentic and correctly signed. `app_release.version` says 0.1.8; the Info.plist
    // inside says 0.1.9. Before this check the swap SUCCEEDED, the new copy read its own version as
    // 0.1.9, asked the route, was told 0.1.8, and `running != offered` was true again — download,
    // swap, restart, every eighty seconds, for ever. The ledger could not bound it because the
    // receipt said `ok`, and a ledger that counts failures cannot bound a loop made of successes.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let runner = RecordingRunner(exitCodes: ["/usr/bin/ditto": 0, "/usr/bin/codesign": 0])
    let updater = mislabelledUpdater(
      fixture, offered: "0.1.8", stagedVersion: "0.1.9", runner: runner)

    guard case .stopped(let outcome, let reason) = await updater.check(sessionIsOpen: false) else {
      Issue.record("expected the update to stop on a version mismatch")
      return
    }
    #expect(outcome == .versionMismatch)
    #expect(reason.contains("0.1.9"))
    #expect(reason.contains("0.1.8"))

    // NOTHING WAS HANDED OVER and nothing resident was touched. The swap is the step this check
    // sits in front of.
    #expect(await runner.spawned.isEmpty)
    #expect(fixture.version(of: fixture.resident) == "0.1.7")
    #expect(!FileManager.default.fileExists(atPath: fixture.previous.path))
    #expect(!FileManager.default.fileExists(atPath: fixture.staging.path))

    // The receipt names the version that was OFFERED — the one the card's sentence is about, and
    // the one the ledger is keyed by. Not the version the bundle wrongly claimed.
    let receipt = try #require(Self.readResult(fixture))
    #expect(receipt.outcome == .versionMismatch)
    #expect(receipt.version == "0.1.8")

    // And `stop()` counted it, so the ordinary one-retry-then-hold now applies with no new
    // machinery — which is the whole point of catching it here rather than after the swap.
    let ledger = try #require(RoomUpdateAttempts.read(root: fixture.root))
    #expect(ledger.version == "0.1.8")
    #expect(ledger.failures == 1)
    #expect(ledger.holdUntil == nil)
  }

  @Test func theSameMislabelledReleaseIsTriedOnceMoreAndThenHeld() async throws {
    // The bound: offer the identical bad build three times. Attempt, one retry, then held — the
    // same shape every other failure gets, because it IS every other failure now.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }

    func offerIt() async -> RoomUpdateAttempt {
      let runner = RecordingRunner(exitCodes: ["/usr/bin/ditto": 0, "/usr/bin/codesign": 0])
      return await mislabelledUpdater(
        fixture, offered: "0.1.8", stagedVersion: "0.1.9", runner: runner
      ).check(sessionIsOpen: false)
    }

    #expect(await offerIt() == .stopped(.versionMismatch, reason:
      "the downloaded app calls itself 0.1.9 but the release is named 0.1.8"))
    #expect(await offerIt() == .stopped(.versionMismatch, reason:
      "the downloaded app calls itself 0.1.9 but the release is named 0.1.8"))
    #expect(await offerIt() == .heldAfterRepeatedFailure(version: "0.1.8"))
    #expect(await offerIt() == .heldAfterRepeatedFailure(version: "0.1.8"))
  }

  @Test func aStagedBundleThatWillNotSayWhatItIsIsAlsoRefused() async throws {
    // No Info.plist at all. A bundle that cannot state its version has not been SHOWN to be the one
    // the release names, and "cannot tell" must not read as "matches".
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let runner = RecordingRunner(exitCodes: ["/usr/bin/ditto": 0, "/usr/bin/codesign": 0])
    let updater = mislabelledUpdater(
      fixture, offered: "0.1.8", stagedVersion: nil, runner: runner)

    guard case .stopped(let outcome, let reason) = await updater.check(sessionIsOpen: false) else {
      Issue.record("expected the update to stop")
      return
    }
    #expect(outcome == .versionMismatch)
    #expect(reason.contains("nothing"))
    #expect(await runner.spawned.isEmpty)
  }

  @Test func aCorrectlyLabelledBundleStillHandsOver() async throws {
    // The negative control. The check must not become a wall that stops every update.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let runner = RecordingRunner(exitCodes: ["/usr/bin/ditto": 0, "/usr/bin/codesign": 0])
    let updater = mislabelledUpdater(
      fixture, offered: "0.1.8", stagedVersion: "0.1.8", runner: runner)
    #expect(await updater.check(sessionIsOpen: false) == .handedOver(version: "0.1.8"))
  }

  @Test func theVersionIsReadFromTheStagedBundleOnDisk() throws {
    // Not from `Bundle.main` (this process's own identity) and not from `defaults` (a preferences
    // cache). Bytes, from the path handed in.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let bundle = fixture.root.appendingPathComponent("probe.app", isDirectory: true)
    let contents = bundle.appendingPathComponent("Contents", isDirectory: true)
    try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)

    #expect(RoomUpdater.bundleShortVersion(at: bundle) == nil)  // no plist yet

    let data = try PropertyListSerialization.data(
      fromPropertyList: ["CFBundleShortVersionString": "0.1.9-test"], format: .xml, options: 0)
    try data.write(to: contents.appendingPathComponent("Info.plist", isDirectory: false))
    #expect(RoomUpdater.bundleShortVersion(at: bundle) == "0.1.9-test")

    // A plist with the key missing, and one that is not a plist at all, both read as nil.
    let empty = try PropertyListSerialization.data(
      fromPropertyList: ["CFBundleIdentifier": "x"], format: .xml, options: 0)
    try empty.write(to: contents.appendingPathComponent("Info.plist", isDirectory: false))
    #expect(RoomUpdater.bundleShortVersion(at: bundle) == nil)
    try Data("not a plist".utf8)
      .write(to: contents.appendingPathComponent("Info.plist", isDirectory: false))
    #expect(RoomUpdater.bundleShortVersion(at: bundle) == nil)
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
    runner.dittoProducesVersion = "0.1.8"
      runner.dittoProducesVersion = "0.1.8"
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
    // The new build calls itself what the release calls it — G1's check must pass here.
    runner.dittoProducesVersion = "0.1.9"
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

  // MARK: - G2: one real failure must not trigger the hold

  @Test func aDownloadFailedReceiptAtStartupDoesNotTouchTheLedger() throws {
    // ─── THE DOUBLE COUNT THIS CLOSES ────────────────────────────────────────────────────────
    // `stop()` already counted this failure when it wrote the receipt. The receipt survives on disk
    // until a poll carries it, so a restart before that poll — a reboot, a crash, or the very
    // network outage that caused the download to fail — brought the app back to a receipt it had
    // already counted. Counting again made two, and two is the hold: a room held after ONE real
    // failure, having never had the retry the design promises it.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let t0 = Date(timeIntervalSince1970: 1_757_400_000)

    for outcome in [
      RoomUpdateOutcome.downloadFailed, .checksumMismatch, .signatureMismatch, .expandFailed,
      .versionMismatch, .ok,
    ] {
      RoomUpdateAttempts.clear(root: fixture.root)
      let receipt = RoomUpdateResult(
        outcome: outcome, version: "0.1.8", reason: "something", at: t0)
      let ledger = roomUpdateCountStartupReceipt(
        root: fixture.root, receipt: receipt, now: t0)
      #expect(ledger == nil, "\(outcome.rawValue) must not be counted at startup")
      #expect(RoomUpdateAttempts.read(root: fixture.root) == nil)
    }

    // No receipt at all is likewise nothing to count.
    #expect(roomUpdateCountStartupReceipt(root: fixture.root, receipt: nil, now: t0) == nil)
  }

  @Test func aSwapFailedReceiptAtStartupCountsExactlyOneFailure() throws {
    // The one outcome the swap script writes, and the only failure whose author cannot count it:
    // that process exited 64 and is gone.
    //
    // ─── FLIPPED IN B1 (D8), AND THE OLD ASSERTION WAS THE BUG ────────────────────────────────
    // This test used to assert that the SAME receipt counted twice, and it passed, and that was
    // G2's documented residual: the receipt stays on disk until a poll carries it away, so every
    // restart inside that window counted the same failure again, and two counts is the hold. The
    // launch canary makes a restart inside that window ordinary — a rolled-back room comes back up
    // with the receipt still there — so the residual had to be closed before B1 could ship.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let t0 = Date(timeIntervalSince1970: 1_757_400_000)
    let receipt = RoomUpdateResult(
      outcome: .swapFailed, version: "0.1.8",
      reason: "the new version did not satisfy the pinned signing requirement", at: t0)

    let first = try #require(
      roomUpdateCountStartupReceipt(root: fixture.root, receipt: receipt, now: t0))
    #expect(first.version == "0.1.8")
    #expect(first.failures == 1)
    #expect(first.holdUntil == nil)  // the retry is still owed
    #expect(first.countedReceiptAt == t0)  // and it says which receipt it paid for

    // The same receipt, seen again by the next process to start. Nothing is counted and nothing
    // is written.
    #expect(roomUpdateCountStartupReceipt(root: fixture.root, receipt: receipt, now: t0) == nil)
    let ledger = try #require(RoomUpdateAttempts.read(root: fixture.root))
    #expect(ledger.failures == 1)
    #expect(ledger.holdUntil == nil)

    // A DIFFERENT failure of the same version still counts, and now the room is held. The stamp
    // is the receipt's identity, not a switch that turns counting off.
    let t1 = t0.addingTimeInterval(300)
    let second = try #require(
      roomUpdateCountStartupReceipt(
        root: fixture.root,
        receipt: RoomUpdateResult(
          outcome: .swapFailed, version: "0.1.8", reason: "and again", at: t1),
        now: t1))
    #expect(second.failures == 2)
    #expect(second.countedReceiptAt == t1)
    #expect(second.holdUntil == t1.addingTimeInterval(RoomSelfUpdate.retryHold))
  }

  @Test func aDownloadFailureFollowedByARestartStillGetsItsRetry() throws {
    // The whole G2 scenario end to end, at the ledger: `stop()` counts once, the process restarts
    // with the receipt still on disk, startup counts nothing, and the room is NOT held.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let t0 = Date(timeIntervalSince1970: 1_757_400_000)

    // What `stop()` does.
    roomUpdateRecordFailure(previous: nil, version: "0.1.8", now: t0).write(root: fixture.root)
    let receipt = RoomUpdateResult(
      outcome: .downloadFailed, version: "0.1.8", reason: "the download did not finish", at: t0)
    receipt.write(root: fixture.root)

    // The restart, before any poll could carry the receipt away.
    roomUpdateCountStartupReceipt(root: fixture.root, receipt: receipt, now: t0)

    let ledger = try #require(RoomUpdateAttempts.read(root: fixture.root))
    #expect(ledger.failures == 1)
    #expect(!roomUpdateIsHeld(attempts: ledger, version: "0.1.8", now: t0))
  }

  // MARK: - F3: the restarted app must not delete the running script's staging directory

  @Test func theHandoverGraceIsThirtyMinutes() {
    // V's ruling, 9 September 2026 (Fix 2, G4), raised from ten. Pinned as a number because the
    // number is the ratified thing: too short sweeps the staging directory out from under a swap
    // script that is still working, and that is a far worse failure than ~90 MB sitting around.
    #expect(RoomSelfUpdate.handoverGrace == 30 * 60)
  }

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
    runner.dittoProducesVersion = "0.1.8"
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

  // MARK: - B1-2: the app acknowledges, and B1-D5: the receipt no longer ends the handover

  /// A room root a real `RoomEngine` will load from: the configuration on disk, and nothing else.
  static func writeConfiguration(_ fixture: Fixture) throws {
    let configuration = try RoomConfiguration(
      origin: #require(URL(string: "https://eta.test")),
      roomSlug: "home-office",
      deviceUID: "device-canary-1",
      tapewriterPath: "/usr/bin/false",
      ffmpegPath: "/usr/bin/false")
    try RoomPersistence(root: fixture.root).saveConfiguration(configuration)
  }

  static let enrolledForTests: @Sendable () -> RoomKeychainRecord? = {
    RoomKeychainRecord(
      session: "test.session.jwt", installID: "install_testfixture", roomSlug: "home-office",
      roomName: "Home Office", origin: "https://eta.test")
  }

  @Test func theAppAcknowledgesTheCanaryOnItsFirstSuccessfulPoll() async throws {
    // §14.2 steps 5 and 6, from the app's side. The state on disk is what a swap script leaves
    // behind a moment before this process starts: a handover in flight, and a canary on trial.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    try Self.writeConfiguration(fixture)
    RoomUpdateHandover(version: "0.1.11", at: Date()).write(root: fixture.root)
    RoomUpdateCanary(version: "0.1.11", previous: "0.1.10", armedAt: Date())
      .write(root: fixture.root)

    let remote = CanaryPollRemote()
    let logged = LoggedLines()
    let engine = try await RoomEngine.load(
      rootURL: fixture.root,
      enrolmentReader: Self.enrolledForTests,
      remoteFactory: { _ in remote },
      log: { logged.append($0) })

    // NOT AT INIT. The script is still watching, and the staging directory it is running out of
    // must outlive it (B1-D5).
    #expect(
      FileManager.default.fileExists(atPath: RoomSelfUpdate.canaryURL(root: fixture.root).path))
    #expect(RoomUpdateHandover.read(root: fixture.root) != nil)

    let task = Task { try await engine.run() }
    for _ in 0..<200 {
      if await remote.pollCalls() > 0 { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    task.cancel()
    try await task.value

    #expect(await remote.pollCalls() > 0, "the engine never reached a poll")
    // One poll, and both are gone: the watchdog will see the deletion within two seconds and stand
    // down, and staging is free to be swept.
    #expect(
      !FileManager.default.fileExists(atPath: RoomSelfUpdate.canaryURL(root: fixture.root).path))
    #expect(RoomUpdateHandover.read(root: fixture.root) == nil)
    #expect(logged.all.contains("canary passed for 0.1.11"))
  }

  @Test func aReceiptAloneDoesNotClearTheHandoverMarker() async throws {
    // B1-D5, and the line this replaces. `init` used to clear the marker the moment it read a
    // receipt, on the reasoning that a script that wrote one had finished. Under the canary it has
    // not: it writes `record ok null` and then watches this very process for three minutes, out of
    // the staging directory the marker protects.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    try Self.writeConfiguration(fixture)
    let at = Date()
    RoomUpdateHandover(version: "0.1.11", at: at).write(root: fixture.root)
    RoomUpdateResult(outcome: .ok, version: "0.1.11", reason: nil, at: at)
      .write(root: fixture.root)
    try FileManager.default.createDirectory(
      at: RoomSelfUpdate.stagingURL(root: fixture.root), withIntermediateDirectories: true)

    var engine: RoomEngine? = try await RoomEngine.load(
      rootURL: fixture.root,
      enrolmentReader: Self.enrolledForTests,
      remoteFactory: { _ in CanaryPollRemote() })
    #expect(engine != nil)

    let marker = try #require(RoomUpdateHandover.read(root: fixture.root))
    #expect(marker.version == "0.1.11")
    // And the directory the script is running out of is still there.
    #expect(FileManager.default.fileExists(atPath: fixture.staging.path))
    engine = nil
  }

  @Test func aSwapFailedReceiptIsCountedOnceAcrossRestarts() async throws {
    // G2's residual, closed (B1-D8) — and now proved through the thing that actually does the
    // counting, `RoomEngine.init`, rather than the function under it. A rolled-back room restarts
    // with the receipt still on disk, so the second init below is not a hypothetical: it is what
    // happens every time launchd brings the restored version back before its first poll.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    try Self.writeConfiguration(fixture)
    let at = Date(timeIntervalSince1970: 1_757_400_000)
    RoomUpdateResult(
      outcome: .swapFailed, version: "0.1.12",
      reason: "the new version did not poll within 180 s; restored 0.1.11", at: at
    ).write(root: fixture.root)

    var first: RoomEngine? = try await RoomEngine.load(
      rootURL: fixture.root,
      enrolmentReader: Self.enrolledForTests,
      remoteFactory: { _ in CanaryPollRemote() })
    #expect(first != nil)
    let afterFirst = try #require(RoomUpdateAttempts.read(root: fixture.root))
    #expect(afterFirst.version == "0.1.12")
    #expect(afterFirst.failures == 1)
    #expect(afterFirst.countedReceiptAt == at)
    // The instance lock is held for the life of the engine; a restart is a new process, so this
    // one has to be let go before the next can start.
    first = nil

    var second: RoomEngine? = try await RoomEngine.load(
      rootURL: fixture.root,
      enrolmentReader: Self.enrolledForTests,
      remoteFactory: { _ in CanaryPollRemote() })
    #expect(second != nil)
    let afterSecond = try #require(RoomUpdateAttempts.read(root: fixture.root))
    // ONE failure, and the retry it is owed. Two would be the six-hour hold, earned by one
    // failure and one restart.
    #expect(afterSecond.failures == 1)
    #expect(afterSecond.holdUntil == nil)
    #expect(!roomUpdateIsHeld(attempts: afterSecond, version: "0.1.12", now: Date()))
    second = nil
  }

  // MARK: - B1-3: the break-on-launch hook (D7)

  @Test func breakOnLaunchExitsOne() throws {
    // §14.2 step 7. A PROCESS TEST OF THE BUILT BINARY, not a unit of the guard: what acceptance
    // needs is that the shipped executable dies, with a non-zero code, before it can do anything
    // else — and the "before anything else" half is only true of the real `main.swift`.
    //
    // Nothing here reaches the keychain or the network, because the guard is the first thing in
    // `run` and this Mac IS an enrolled room: a version of this test that let the binary get past
    // the guard would have it polling production from a test suite.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    let binary = try #require(Self.builtCLI())
    FileManager.default.createFile(
      atPath: fixture.root.appendingPathComponent("break-on-launch", isDirectory: false).path,
      contents: nil)

    let process = Process()
    process.executableURL = binary
    process.arguments = ["run", "--root", fixture.root.path]
    let errors = Pipe()
    process.standardError = errors
    process.standardOutput = FileHandle.nullDevice
    try process.run()
    let said = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    process.waitUntilExit()

    // Exit 1, because `KeepAlive = {SuccessfulExit: false}` restarts on non-zero — the thrash is
    // the point, and it is what leaves the canary undeleted for the watchdog to find.
    #expect(process.terminationStatus == 1)
    #expect(said.contains("room-recorder: break-on-launch present; exiting 1"))
  }

  /// The `room-recorder` executable SwiftPM has just built, next to the test bundle.
  static func builtCLI() -> URL? {
    let directory = Bundle(for: TestBundleAnchor.self).bundleURL.deletingLastPathComponent()
    let candidate = directory.appendingPathComponent("room-recorder", isDirectory: false)
    return FileManager.default.isExecutableFile(atPath: candidate.path) ? candidate : nil
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

  @Test func aReEnrolmentPutsTheChannelBackOnStable() throws {
    // 0.1.17, and the reverse of the rule this test used to hold. On 11 Sep a repair paste on Home
    // Office kept `test`, and the 0.1.8 it installed walked straight into an unproven self-update.
    // A paste is a repair; it lands on `stable`, from either shelf. Home Office goes back on `test`
    // by hand, deliberately.
    for prior in ["test", "stable"] {
      var configuration = try RoomConfiguration(
        origin: URL(string: "https://www.evenscribe.app")!, roomSlug: "home-office",
        deviceUID: "AppleUSB:mic", tapewriterPath: "/x/tapewriter", ffmpegPath: "/x/ffmpeg",
        updateChannel: prior)
      configuration.applyEnrolment(
        origin: URL(string: "https://www.evenscribe.app")!, roomSlug: "home-office",
        installID: "install_gd9tnfgqazvh", tapewriterPath: nil, ffmpegPath: nil)
      #expect(configuration.updateChannel == "stable", "prior channel \(prior)")
    }
  }

  // MARK: - Release B2 (D5): the server may move a Mac to stable, and only to stable

  @Test func aPollResponseCarriesTheServerAssignedChannel() throws {
    func decode(_ json: String) throws -> CommandPollResponse {
      try JSONDecoder().decode(CommandPollResponse.self, from: Data(json.utf8))
    }
    let base = #""ok":true,"superseded":false,"commands":[]"#
    #expect(try decode("{\(base),\"assigned_channel\":\"stable\"}").assignedChannel == "stable")
    #expect(try decode("{\(base),\"assigned_channel\":null}").assignedChannel == nil)
    #expect(try decode("{\(base)}").assignedChannel == nil)
    // A junk VALUE must not cost the poll: the commands in the same answer still have to run.
    let junk = try decode(#"{"ok":true,"superseded":false,"commands":[],"assigned_channel":42}"#)
    #expect(junk.assignedChannel == nil)
    #expect(junk.ok)
  }

  @Test func onlyAServerMoveToStableFromAnotherChannelIsApplied() throws {
    func configuration(_ channel: String) throws -> RoomConfiguration {
      try RoomConfiguration(
        origin: #require(URL(string: "https://www.evenscribe.app")), roomSlug: "home-office",
        deviceUID: "AppleUSB:mic", tapewriterPath: "/x/tapewriter", ffmpegPath: "/x/ffmpeg",
        updateChannel: channel)
    }
    // Applied, once: a second identical answer (the server clears only after the app reports
    // `stable`) finds nothing left to move.
    var onTest = try configuration("test")
    let moved = onTest.applyServerAssignedChannel("stable")
    #expect(moved)
    #expect(onTest.updateChannel == "stable")
    let movedAgain = onTest.applyServerAssignedChannel("stable")
    #expect(!movedAgain)

    // Everything else is ignored. Tier 1 §3 (D1 amended) lets the server assign `test` as well —
    // the valve is now `channelLocked`, covered in RoomOperatorVerbTests — so `test` is no longer
    // in the stable Mac's list below; what is left is the part of B2's rule that still holds.
    for assigned in ["test", nil, "", "Stable", "stable ", "beta"] as [String?] {
      var mac = try configuration("test")
      let changed = mac.applyServerAssignedChannel(assigned)
      #expect(!changed, "assigned \(assigned ?? "nil")")
      #expect(mac.updateChannel == "test")
    }
    for assigned in ["stable", nil, "", "Test", "test "] as [String?] {
      var mac = try configuration("stable")
      let changed = mac.applyServerAssignedChannel(assigned)
      #expect(!changed, "assigned \(assigned ?? "nil")")
      #expect(mac.updateChannel == "stable")
    }
  }

  /// A room root on `channel`, ready for a real engine to load.
  static func writeConfiguration(_ fixture: Fixture, channel: String) throws {
    let configuration = try RoomConfiguration(
      origin: #require(URL(string: "https://eta.test")),
      roomSlug: "home-office",
      deviceUID: "device-canary-1",
      tapewriterPath: "/usr/bin/false",
      ffmpegPath: "/usr/bin/false",
      updateChannel: channel)
    try RoomPersistence(root: fixture.root).saveConfiguration(configuration)
    // And the session file an enrolled Mac has, so the engine polls WITH its install fields —
    // `update_channel` rides in them — and never falls back to the machine's real keychain.
    try RoomSessionStore.save(try #require(Self.enrolledForTests()), root: fixture.root)
  }

  /// Run a real engine against `remote` until it has polled `polls` times. The updater is built
  /// the way `defaultUpdater` builds one — from the configuration it is handed — around `fetcher`.
  private static func runEngine(
    _ fixture: Fixture, polls: Int, remote: AssigningPollRemote,
    fetcher: ChannelRecordingFetcher, logged: LoggedLines, builtOn: ChannelBox
  ) async throws {
    let resident = fixture.resident
    let engine = try await RoomEngine.load(
      rootURL: fixture.root,
      enrolmentReader: Self.enrolledForTests,
      remoteFactory: { _ in remote },
      updaterFactory: { configuration, _, root in
        builtOn.set(configuration.updateChannel)
        return RoomUpdater(
          rootURL: root, residentBundleURL: resident, runningVersion: "0.1.19",
          channel: configuration.updateChannel, fetcher: fetcher, runner: RecordingRunner(),
          log: { _ in })
      },
      log: { logged.append($0) })
    let task = Task { try await engine.run() }
    for _ in 0..<400 {
      if await remote.pollCalls() >= polls { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    task.cancel()
    try await task.value
  }

  @Test func aServerMoveToStableReachesTheNextReleaseFetchWithoutARestart() async throws {
    // B2-D5 and the orchestrator's ruling (b), 11 Sep 18:30. The updater is built once, at load,
    // from config.json's channel. Moving config alone would report `stable` on the card while the
    // Mac went on asking `test` for builds until its next restart.
    let fixture = try Fixture.make()
    defer { fixture.tearDown() }
    try Self.writeConfiguration(fixture, channel: "test")
    let remote = AssigningPollRemote(assigned: "stable")
    let fetcher = ChannelRecordingFetcher()
    let logged = LoggedLines()
    let builtOn = ChannelBox()

    try await Self.runEngine(
      fixture, polls: 3, remote: remote, fetcher: fetcher, logged: logged,
      builtOn: builtOn)

    #expect(await remote.pollCalls() >= 3, "the engine never reached three polls")
    // Built on `test` — this is the same process, not a restarted one.
    #expect(builtOn.value == "test")
    // The launch check runs after the first poll's answer is applied, so it is already on stable.
    #expect(await fetcher.channels.first == "stable")
    #expect(await fetcher.channels.allSatisfy { $0 == "stable" })
    // Persisted, so a restart does not put the Mac back on `test` behind the server's back.
    #expect(try RoomPersistence(root: fixture.root).loadConfiguration().updateChannel == "stable")
    // The first poll reported the channel the Mac was on; every poll after it reports `stable`,
    // which is what lets the server clear the assignment.
    let reported = await remote.reportedChannels
    #expect(reported.first == "test")
    #expect(reported.dropFirst().allSatisfy { $0 == "stable" })
    // Once, although the server kept sending `stable` on every poll.
    #expect(logged.all.filter { $0 == "channel moved to stable by the server" }.count == 1)
  }

  @Test func aServerAnswerThatIsNotAMoveToStableChangesNothing() async throws {
    // B2-D5's other half: nothing but a real channel moves a Mac. Tier 1 §3 (D1 amended) takes
    // ("stable", "test") out of this list — the server may now assign `test`, and the case that
    // must change nothing is a LOCKED Mac, in RoomOperatorVerbTests.
    for (channel, assigned) in [("test", nil), ("test", "junk"), ("stable", "stable"), ("stable", "beta")]
      as [(String, String?)]
    {
      let fixture = try Fixture.make()
      defer { fixture.tearDown() }
      try Self.writeConfiguration(fixture, channel: channel)
      let remote = AssigningPollRemote(assigned: assigned)
      let fetcher = ChannelRecordingFetcher()
      let logged = LoggedLines()

      try await Self.runEngine(
        fixture, polls: 2, remote: remote, fetcher: fetcher, logged: logged,
        builtOn: ChannelBox())

      let label = "\(channel) ← \(assigned ?? "nil")"
      #expect(await remote.pollCalls() >= 2, "\(label): the engine never reached two polls")
      #expect(await fetcher.channels.allSatisfy { $0 == channel }, "\(label)")
      #expect(
        try RoomPersistence(root: fixture.root).loadConfiguration().updateChannel == channel,
        "\(label)")
      #expect(await remote.reportedChannels.allSatisfy { $0 == channel }, "\(label)")
      #expect(!logged.all.contains { $0.contains("channel moved") }, "\(label)")
    }
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
  /// Fix 2, G1. The `CFBundleShortVersionString` the stub writes into that bundle's Info.plist.
  /// Nil writes NO plist at all, which is the "will not say what it is" case the check also fails.
  var dittoProducesVersion: String?
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
      let contents = bundle.appendingPathComponent("Contents", isDirectory: true)
      try? FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
      if let version = dittoProducesVersion {
        // A real Info.plist, serialised the same way a real bundle carries one, so the check under
        // test reads bytes rather than a fixture shortcut.
        let plist: [String: Any] = [
          "CFBundleShortVersionString": version,
          "CFBundleIdentifier": "com.evenscribe.room-recorder",
        ]
        if let data = try? PropertyListSerialization.data(
          fromPropertyList: plist, format: .xml, options: 0)
        {
          try? data.write(to: contents.appendingPathComponent("Info.plist", isDirectory: false))
        }
      }
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

/// Anchors `Bundle(for:)` to the test bundle, which is the only reliable way to find the products
/// SwiftPM just built — `Bundle.main` here is the testing helper, off in the toolchain.
private final class TestBundleAnchor: NSObject {}

/// Collects what the engine logged, across the thread it logged on.
private final class LoggedLines: @unchecked Sendable {
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

/// A remote that answers a poll and nothing else. The canary turns on `pollCommands` RETURNING;
/// what it returns is beside the point, which is why this one returns the emptiest legal answer.
private actor CanaryPollRemote: RoomEngineRemote {
  private var polls = 0

  func pollCalls() -> Int { polls }

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    try JSONDecoder().decode(
      ActiveSessionResponse.self,
      from: Data(
        #"{"ok":true,"resumable":false,"session":null,"next_idx":{"primary":0,"backup":0},"reason":null,"handover_pending":false,"tab_gone":false}"#
          .utf8))
  }

  func pollCommands(
    tabID: String, previousPollAt: String?, recordingSessionID: String?, paused: Bool,
    primaryLevels: BenchLevelPair?, install: InstallPollFields?
  ) async throws -> CommandPollResponse {
    polls += 1
    return try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(#"{"ok":true,"superseded":false,"commands":[]}"#.utf8))
  }

  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    throw CanaryStubError.unexpectedCall
  }
  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  { throw CanaryStubError.unexpectedCall }
  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  { throw CanaryStubError.unexpectedCall }
  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw CanaryStubError.unexpectedCall
  }
  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  { throw CanaryStubError.unexpectedCall }
}

private enum CanaryStubError: Error { case unexpectedCall }

/// B2-D5. Answers every poll with the same `assigned_channel` (omitted when nil), and records the
/// `update_channel` each poll reported.
private actor AssigningPollRemote: RoomEngineRemote {
  private let assigned: String?
  private var polls = 0
  private(set) var reportedChannels: [String?] = []

  init(assigned: String?) { self.assigned = assigned }

  func pollCalls() -> Int { polls }

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    try JSONDecoder().decode(
      ActiveSessionResponse.self,
      from: Data(
        #"{"ok":true,"resumable":false,"session":null,"next_idx":{"primary":0,"backup":0},"reason":null,"handover_pending":false,"tab_gone":false}"#
          .utf8))
  }

  func pollCommands(
    tabID: String, previousPollAt: String?, recordingSessionID: String?, paused: Bool,
    primaryLevels: BenchLevelPair?, install: InstallPollFields?
  ) async throws -> CommandPollResponse {
    polls += 1
    reportedChannels.append(install?.updateChannel)
    let field = assigned.map { #","assigned_channel":"\#($0)""# } ?? ""
    return try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(#"{"ok":true,"superseded":false,"commands":[]\#(field)}"#.utf8))
  }

  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    throw CanaryStubError.unexpectedCall
  }
  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  { throw CanaryStubError.unexpectedCall }
  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  { throw CanaryStubError.unexpectedCall }
  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw CanaryStubError.unexpectedCall
  }
  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  { throw CanaryStubError.unexpectedCall }
}

/// B2-D5. Records the channel of every release fetch and offers nothing, so a check is a no-op.
private actor ChannelRecordingFetcher: RoomReleaseFetching {
  private(set) var channels: [String] = []
  func fetchRelease(channel: String) async -> RoomReleaseDescriptor? {
    channels.append(channel)
    return nil
  }
}

/// The channel `updaterFactory` was handed, carried out of the factory closure.
private final class ChannelBox: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: String?
  func set(_ value: String) { lock.withLock { stored = value } }
  var value: String? { lock.withLock { stored } }
}
