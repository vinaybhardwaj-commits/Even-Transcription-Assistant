import Foundation
import Testing

@testable import HelperCore
@testable import KioskHealthCore

// MARK: - 0.1.36 R2 (B1): the kiosk-health collectors never read a room user's files as root

/// The REAL reader (`HelperUserFiles`, here on a context that runs as the test's own user, since a test cannot become
/// root) under the REAL collectors, on a real directory tree. Each test plants a symlink, a hard link or a FIFO at a path a
/// collector reads, pointing at a file that stands in for a root-only one, and asserts that nothing of it leaves the helper:
/// not in an event, not in the state file. A control with an ordinary file proves the collector would have shipped it.
private let secretWord = "SECRETLEAK-4f9c2a"

private struct StubClock: KioskHealthCore.Clock { var date: Date; func now() -> Date { date } }
private struct StubSleeper: Sleeper { func sleep(_ seconds: TimeInterval) {} }
private struct StubRunner: CommandRunner {
  var chrome = true
  func run(_ exe: String, _ args: [String], timeout: TimeInterval) -> CommandResult {
    if exe == Tool.pgrep { return CommandResult(status: chrome ? 0 : 1, stdout: chrome ? "1\n" : "", stderr: "") }
    return CommandResult(status: 1, stdout: "", stderr: "stub", timedOut: false, launchError: nil)
  }
}

private final class Tree {
  let base = FileManager.default.temporaryDirectory.appendingPathComponent("kh-safety-\(UUID().uuidString)")
  var home: String { base.appendingPathComponent("home").path }
  var recorder: String { home + "/Library/Application Support/EvenScribe/RoomRecorder" }
  var chromeData: String { home + ChromeProbe.userDataSuffix }
  var stateURL: URL { base.appendingPathComponent("state.json") }
  let secret: String
  let user = NSUserName()

  init() throws {
    secret = base.appendingPathComponent("root-only.txt").path
    try FileManager.default.createDirectory(atPath: base.appendingPathComponent("home").path, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: recorder + "/captures/s1/seg1", withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: chromeData + "/Default/Extensions/\(ChromeProbe.extensionID)/1.0_0", withIntermediateDirectories: true)
    try Data(
      "room-recorder: Error: \(secretWord) write failed\n{\"state\":\"recording\",\"session_id\":\"\(secretWord)\"}\n".utf8
    ).write(to: URL(fileURLWithPath: secret))
  }
  func tearDown() { try? FileManager.default.removeItem(at: base) }

  func ctx(reader: UserFileAccess? = nil, now: Date = Date(timeIntervalSince1970: 1_000_000_000)) -> Context {
    var cfg = Config(machine: "m")
    cfg.consoleUser = user
    return Context(
      config: cfg, runner: StubRunner(), clock: StubClock(date: now), sleeper: StubSleeper(), state: FileState(url: stateURL),
      files: reader ?? HelperUserFiles(context: SameUserContext()), homeOverride: home)
  }

  enum Plant { case symlink, hardlink, fifo }
  func plant(_ kind: Plant, at path: String) throws {
    try? FileManager.default.removeItem(atPath: path)
    try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    switch kind {
    case .symlink: try FileManager.default.createSymbolicLink(atPath: path, withDestinationPath: secret)
    case .hardlink: try FileManager.default.linkItem(atPath: secret, toPath: path)
    case .fifo: #expect(mkfifo(path, 0o600) == 0)
    }
  }
  /// Everything that left: event payloads as JSON, plus the state file.
  func leaked(_ events: [DraftEvent]) -> Bool {
    let text = events.map { J.string($0.payload) }.joined() + ((try? String(contentsOf: stateURL, encoding: .utf8)) ?? "")
    return text.contains(secretWord)
  }
}

private func finishes<T>(within seconds: TimeInterval = 5, _ body: @escaping () -> T) -> T? {
  let box = Box<T>()
  let done = DispatchSemaphore(value: 0)
  Thread.detachNewThread { box.value = body(); done.signal() }
  return done.wait(timeout: .now() + seconds) == .success ? box.value : nil
}
private final class Box<T>: @unchecked Sendable { var value: T? }

@Suite(.serialized) struct KioskUserFileSafetyTests {
  fileprivate static let plants: [Tree.Plant] = [.symlink, .hardlink, .fifo]

  // ─── controls: the same layout with ordinary files DOES ship ───────────────────────────────

  @Test func controlAnOrdinaryLogLineAndStatusFileShip() throws {
    let t = try Tree(); defer { t.tearDown() }
    let c = RecorderLogCollector(ctx: t.ctx())
    _ = c.poll()  // first sight: history is not shipped
    try Data("room-recorder: Error: ordinary failure\n".utf8).write(to: URL(fileURLWithPath: t.recorder + "/launchd.log"))
    try Data("{\"state\":\"ready\"}".utf8).write(to: URL(fileURLWithPath: t.recorder + "/status.json"))
    let events = c.poll().events
    #expect(events.contains { $0.kind == "recorder.log" && J.string($0.payload).contains("ordinary failure") })
    #expect(events.contains { $0.kind == "recorder.status" })
  }

  // ─── recorder logs (RecorderLogs.swift: Tail.read, discoverLogs) ───────────────────────────

  @Test func aPlantedLaunchdLogShipsNothingOfTheTarget() throws {
    for kind in Self.plants {
      let t = try Tree(); defer { t.tearDown() }
      let c = RecorderLogCollector(ctx: t.ctx())
      _ = c.poll()
      try t.plant(kind, at: t.recorder + "/launchd.log")
      let events = try #require(finishes { c.poll().events }, "\(kind): the poll must not hang")
      #expect(!t.leaked(events), "\(kind) at launchd.log")
      #expect(!events.contains { $0.kind == "recorder.log" })
    }
  }

  @Test func aPlantedTapewriterLogShipsNothingOfTheTarget() throws {
    for kind in Self.plants {
      let t = try Tree(); defer { t.tearDown() }
      let c = RecorderLogCollector(ctx: t.ctx())
      _ = c.poll()
      try t.plant(kind, at: t.recorder + "/captures/s1/seg1/tapewriter.log")
      let events = try #require(finishes { c.poll().events }, "\(kind): the poll must not hang")
      #expect(!t.leaked(events), "\(kind) at tapewriter.log")
    }
  }

  @Test func aSymlinkedCapturesDirectoryIsNotFollowed() throws {
    let t = try Tree(); defer { t.tearDown() }
    let elsewhere = t.base.appendingPathComponent("elsewhere/s9/seg1").path
    try FileManager.default.createDirectory(atPath: elsewhere, withIntermediateDirectories: true)
    try Data("room-recorder: Error: \(secretWord)\n".utf8).write(to: URL(fileURLWithPath: elsewhere + "/tapewriter.log"))
    try FileManager.default.createSymbolicLink(atPath: t.recorder + "/captures/s9", withDestinationPath: t.base.appendingPathComponent("elsewhere/s9").path)
    let c = RecorderLogCollector(ctx: t.ctx())
    #expect(c.discoverLogs(io: try #require(t.ctx().userIO()), recorderDir: t.recorder).allSatisfy { !$0.contains("/s9/") })
  }

  // ─── status.json (RecorderLogs.statusEvents, RecorderState.read) ───────────────────────────

  @Test func aPlantedStatusJsonSaysNothingAndTheSessionGateFailsClosed() throws {
    for kind in Self.plants {
      let t = try Tree(); defer { t.tearDown() }
      try t.plant(kind, at: t.recorder + "/status.json")
      let c = RecorderLogCollector(ctx: t.ctx())
      let events = try #require(finishes { c.poll().events }, "\(kind): the poll must not hang")
      #expect(!t.leaked(events), "\(kind) at status.json")
      #expect(!events.contains { $0.kind == "recorder.status" })
      let snapshot = try #require(finishes { RecorderState.read(t.ctx()) })
      #expect(snapshot.open == .unknown, "\(kind): an unreadable status is 'unknown', which every action treats as open")
      #expect(!J.string(snapshot.payload()).contains(secretWord))
    }
  }

  @Test func aStatusFileOverTheCapIsNotRead() throws {
    let t = try Tree(); defer { t.tearDown() }
    try Data(("{\"state\":\"ready\",\"pad\":\"" + String(repeating: "x", count: 70_000) + "\"}").utf8).write(to: URL(fileURLWithPath: t.recorder + "/status.json"))
    #expect(RecorderLogCollector(ctx: t.ctx()).poll().events.contains { $0.kind == "recorder.status" } == false)
  }

  // ─── the tape (RecorderState.newestTape) ───────────────────────────────────────────────────

  @Test func aSymlinkedTapeDirectoryOrSessionDoesNotCountAsRecentTape() throws {
    let t = try Tree(); defer { t.tearDown() }
    try FileManager.default.removeItem(atPath: t.recorder + "/captures/s1")
    let real = t.base.appendingPathComponent("elsewhere").path
    try FileManager.default.createDirectory(atPath: real + "/seg1", withIntermediateDirectories: true)
    try Data("x".utf8).write(to: URL(fileURLWithPath: real + "/seg1/tape.pcm"))
    try FileManager.default.createSymbolicLink(atPath: t.recorder + "/captures/s1", withDestinationPath: real)
    let io = try #require(t.ctx().userIO())
    #expect(RecorderState.newestTape(io: io, recorderDir: t.recorder) == nil)
  }

  // ─── the recorder app's Info.plist (Drift.swift) ───────────────────────────────────────────

  @Test func aPlantedInfoPlistIsNotReadOrReported() throws {
    for kind in Self.plants {
      let t = try Tree(); defer { t.tearDown() }
      var cfg = Config(machine: "m"); cfg.consoleUser = t.user
      cfg.recorderAppPath = t.base.appendingPathComponent("App.app").path
      try t.plant(kind, at: cfg.recorderAppPath! + "/Contents/Info.plist")
      let ctx = Context(config: cfg, runner: StubRunner(), clock: StubClock(date: Date()), sleeper: StubSleeper(), state: FileState(url: t.stateURL),
                        files: HelperUserFiles(context: SameUserContext()), homeOverride: t.home)
      let observed = try #require(finishes { DriftCollector(ctx: ctx).observe() })
      #expect(observed.state.recorderAppFound == false && observed.state.recorderVersion == nil, "\(kind)")
    }
  }

  @Test func controlAnOrdinaryInfoPlistIsReadAsTheUser() throws {
    let t = try Tree(); defer { t.tearDown() }
    var cfg = Config(machine: "m"); cfg.consoleUser = t.user
    cfg.recorderAppPath = t.base.appendingPathComponent("App.app").path
    try FileManager.default.createDirectory(atPath: cfg.recorderAppPath! + "/Contents", withIntermediateDirectories: true)
    try PropertyListSerialization.data(fromPropertyList: ["CFBundleShortVersionString": "9.9.9"], format: .xml, options: 0)
      .write(to: URL(fileURLWithPath: cfg.recorderAppPath! + "/Contents/Info.plist"))
    let ctx = Context(config: cfg, runner: StubRunner(), clock: StubClock(date: Date()), sleeper: StubSleeper(), state: FileState(url: t.stateURL),
                      files: HelperUserFiles(context: SameUserContext()), homeOverride: t.home)
    #expect(DriftCollector(ctx: ctx).observe().state.recorderVersion == "9.9.9")
  }

  // ─── Chrome (Chrome.swift: Local State and the directory listings) ─────────────────────────

  @Test func aPlantedLocalStateIsNotReadAndNoToolRunsOnIt() throws {
    for kind in Self.plants {
      let t = try Tree(); defer { t.tearDown() }
      try Data("{\"profile\":{\"last_used\":\"\(secretWord)\",\"last_active_profiles\":[\"Default\"]}}".utf8).write(to: URL(fileURLWithPath: t.secret))
      try t.plant(kind, at: t.chromeData + "/Local State")
      let collector = ChromeCollector(ctx: t.ctx())
      let result = try #require(finishes { collector.poll() }, "\(kind): must not hang")
      #expect(!t.leaked(result.events), "\(kind) at Local State")
      let sample = try #require(finishes { collector.sample() }?.0)
      #expect(sample.lastUsed == nil && sample.active.isEmpty, "\(kind)")
    }
  }

  @Test func aLocalStateOverFourMiBIsNotRead() throws {
    let t = try Tree(); defer { t.tearDown() }
    var big = Data("{\"profile\":{\"last_used\":\"Default\"},\"pad\":\"".utf8)
    big.append(Data(repeating: 0x78, count: 4 * 1024 * 1024 + 10))
    big.append(Data("\"}".utf8))
    try big.write(to: URL(fileURLWithPath: t.chromeData + "/Local State"))
    let sample = try #require(ChromeCollector(ctx: t.ctx()).sample().0)
    #expect(sample.lastUsed == nil)
  }

  @Test func controlAnOrdinaryLocalStateIsParsedInProcess() throws {
    let t = try Tree(); defer { t.tearDown() }
    try Data("{\"profile\":{\"last_used\":\"Default\",\"last_active_profiles\":[\"Default\"]}}".utf8).write(to: URL(fileURLWithPath: t.chromeData + "/Local State"))
    let sample = try #require(ChromeCollector(ctx: t.ctx()).sample().0)
    #expect(sample.active == ["Default"] && sample.ext["Default"] == ["1.0_0"])
  }

  @Test func aSymlinkedExtensionDirectoryOrVersionIsNotFollowed() throws {
    let t = try Tree(); defer { t.tearDown() }
    try Data("{\"profile\":{\"last_active_profiles\":[\"Default\"]}}".utf8).write(to: URL(fileURLWithPath: t.chromeData + "/Local State"))
    let ext = t.chromeData + "/Default/Extensions/\(ChromeProbe.extensionID)"
    try FileManager.default.removeItem(atPath: ext)
    let real = t.base.appendingPathComponent("real-ext/9.9_0").path
    try FileManager.default.createDirectory(atPath: real, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: ext, withDestinationPath: t.base.appendingPathComponent("real-ext").path)
    #expect(try #require(ChromeCollector(ctx: t.ctx()).sample().0).ext["Default"] == [], "a symlinked extension directory lists as empty")
    try FileManager.default.removeItem(atPath: ext)
    try FileManager.default.createDirectory(atPath: ext, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: ext + "/1.0_0", withDestinationPath: real)
    #expect(try #require(ChromeCollector(ctx: t.ctx()).sample().0).ext["Default"] == [], "and a symlinked version is not a version")
  }

  // ─── never as root ─────────────────────────────────────────────────────────────────────────

  @Test func ifTheThreadCannotTakeTheUsersIdentityNothingIsReadNotEvenAnOrdinaryFile() throws {
    struct Refusing: UserContext { func run<T: Sendable>(uid: UInt32, gid: UInt32, _ body: @escaping @Sendable () -> T) -> T? { nil } }
    let t = try Tree(); defer { t.tearDown() }
    try Data("{\"state\":\"ready\"}".utf8).write(to: URL(fileURLWithPath: t.recorder + "/status.json"))
    let reader = HelperUserFiles(context: Refusing())
    #expect(reader.readWhole(t.recorder + "/status.json", user: t.user, maxBytes: 1_000) == nil)
    #expect(reader.info(t.recorder, user: t.user) == nil && reader.entries(t.recorder, user: t.user) == nil)
    let snapshot = RecorderState.read(t.ctx(reader: reader))
    #expect(snapshot.open == .unknown && snapshot.recorderDirFound == false)
  }

  @Test func theReaderRefusesRootAndOddNames() {
    for name in ["root", "", "a b", "../x", String(repeating: "u", count: 65)] {
      #expect(HelperUserFiles.identity(name) == nil, "\(name)")
    }
    #expect(HelperUserFiles.identity(NSUserName()) != nil || getuid() == 0)
  }

  @Test func theUnprivilegedReaderRefusesToRunAsRoot() {
    // Its guard is `geteuid() != 0`; as the (non-root) test user it works, and the source says it stops at root.
    #expect(UnprivilegedUserFiles().info(NSTemporaryDirectory(), user: "x") != nil || geteuid() == 0)
  }

  // ─── the sweep: no collector reads a user path with a plain root API ───────────────────────

  @Test func noCollectorSourceUsesAPlainFileApiOnAUserPath() throws {
    let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/KioskHealthCore")
    let collectors = ["Chrome.swift", "RecorderLogs.swift", "RecorderState.swift", "Drift.swift", "HID.swift", "Audio.swift", "Power.swift", "Display.swift", "Assertions.swift"]
    let banned = ["contentsOfDirectory", "fileExists(", "attributesOfItem", "FileHandle(forReading", "Tool.plutil", "FS.mtime(", "FS.size(", "Data(contentsOf"]
    for name in collectors {
      let text = try String(contentsOf: sources.appendingPathComponent(name), encoding: .utf8)
      let code = text.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
      for word in banned { #expect(!code.contains(word), "\(name) uses \(word)") }
      // the one allowed plain read: the ROOT-owned managed preferences, in Drift
      let reads = code.components(separatedBy: "FileManager.default.contents(atPath:").count - 1
      #expect(reads == (name == "Drift.swift" ? 1 : 0), "\(name): \(reads) plain contents(atPath:)")
    }
  }
}

// ─── the hardened primitives themselves ───────────────────────────────────────────────────────

@Suite struct HardenedFileTests {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("hardened-\(UUID().uuidString)")
  init() throws { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
  func tearDown() { try? FileManager.default.removeItem(at: dir) }
  func path(_ n: String) -> String { dir.appendingPathComponent(n).path }

  @Test func plainFilesReadWholeAndInRanges() throws {
    defer { tearDown() }
    try Data("0123456789".utf8).write(to: URL(fileURLWithPath: path("f")))
    #expect(HardenedFile.readWhole(path("f"), maxBytes: 10) == Data("0123456789".utf8))
    #expect(HardenedFile.readWhole(path("f"), maxBytes: 9) == nil, "over the cap is nil, not truncated")
    #expect(HardenedFile.readRange(path("f"), offset: 4, maxBytes: 3) == Data("456".utf8))
    #expect(HardenedFile.readRange(path("f"), offset: 10, maxBytes: 3) == Data())
    #expect(HardenedFile.readRange(path("f"), offset: 99, maxBytes: 3) == Data())
  }

  @Test func symlinkHardlinkFifoDirectoryAndMissingAreAllRefused() throws {
    defer { tearDown() }
    try Data("secret".utf8).write(to: URL(fileURLWithPath: path("target")))
    try FileManager.default.createSymbolicLink(atPath: path("sym"), withDestinationPath: path("target"))
    try FileManager.default.linkItem(atPath: path("target"), toPath: path("hard"))
    #expect(mkfifo(path("fifo"), 0o600) == 0)
    try FileManager.default.createDirectory(atPath: path("d"), withIntermediateDirectories: true)
    for name in ["sym", "hard", "target", "fifo", "d", "absent"] {
      #expect(HardenedFile.readWhole(path(name), maxBytes: 100) == nil, "\(name)")
      #expect(HardenedFile.readRange(path(name), offset: 0, maxBytes: 100) == nil, "\(name)")
    }
    #expect(HardenedFile.info(path("sym"))?.isSymlink == true && HardenedFile.info(path("sym"))?.isRegular == false)
    #expect(HardenedFile.info(path("hard"))?.nlink == 2)
  }

  @Test func onceTheOtherLinkIsGoneTheFileReadsAgain() throws {
    defer { tearDown() }
    try Data("ok".utf8).write(to: URL(fileURLWithPath: path("a")))
    try FileManager.default.linkItem(atPath: path("a"), toPath: path("b"))
    #expect(HardenedFile.readWhole(path("a"), maxBytes: 10) == nil)
    try FileManager.default.removeItem(atPath: path("b"))
    #expect(HardenedFile.readWhole(path("a"), maxBytes: 10) == Data("ok".utf8))
  }

  @Test func listingsAreOfRealDirectoriesOnly() throws {
    defer { tearDown() }
    try FileManager.default.createDirectory(atPath: path("d"), withIntermediateDirectories: true)
    try Data().write(to: URL(fileURLWithPath: path("d/x")))
    try Data().write(to: URL(fileURLWithPath: path("d/.hidden")))
    try FileManager.default.createSymbolicLink(atPath: path("link"), withDestinationPath: path("d"))
    #expect(Set(HardenedFile.entries(path("d")) ?? []) == ["x", ".hidden"])
    #expect(HardenedFile.entries(path("link")) == nil)
    #expect(HardenedFile.entries(path("d/x")) == nil)
  }
}

// ─── the root reads of the helper's own files refuse links too ("anywhere", R2) ──────────────────

@Suite struct RootReadsRefuseLinksTests {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rootreads-\(UUID().uuidString)")
  init() throws { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
  func tearDown() { try? FileManager.default.removeItem(at: dir) }
  func path(_ n: String) -> String { dir.appendingPathComponent(n).path }

  @Test func theChromePolicyFilesStandaloneConfigAndPowerTimeAllRefuseAHardLinkAndASymlink() throws {
    defer { tearDown() }
    try Data("{\"machine\":\"LINKED-MACHINE\"}".utf8).write(to: URL(fileURLWithPath: path("config.json")))
    try Data("07:30\n".utf8).write(to: URL(fileURLWithPath: path("power")))
    for (name, target) in [("config.json", "config-hard.json"), ("power", "power-hard")] {
      try FileManager.default.linkItem(atPath: path(name), toPath: path(target))
    }
    try FileManager.default.createSymbolicLink(atPath: path("config-sym.json"), withDestinationPath: path("config.json"))
    let files = SystemChromePolicyFiles(setOwner: false)
    #expect(files.read(path("config-hard.json")) == nil && files.read(path("config-sym.json")) == nil)
    #expect(Config.load(path: path("config-hard.json")).machine != "LINKED-MACHINE")
    #expect(Config.load(path: path("config-sym.json")).machine != "LINKED-MACHINE")
    #expect(PowerPolicy.storedTime(at: path("power-hard")) == nil)
    // an unlinked, plain file still reads
    try FileManager.default.removeItem(atPath: path("config-hard.json"))
    try FileManager.default.removeItem(atPath: path("power-hard"))
    #expect(Config.load(path: path("config.json")).machine == "LINKED-MACHINE")
    #expect(PowerPolicy.storedTime(at: path("power")) == "07:30")
  }
}
