import Foundation
import Testing

@testable import FleetCore
@testable import HelperCore

/// Stands in for a successful privilege drop. A test process is not root, so `pthread_setugid_np` is refused; this runs
/// the body when (and only when) the requested identity is the test user's own, exactly what a successful drop would do.
struct SameUserContext: UserContext {
  func run<T: Sendable>(uid: UInt32, gid: UInt32, _ body: @escaping @Sendable () -> T) -> T? {
    guard uid == getuid(), gid == getgid() else { return nil }
    return body()
  }
}

/// A temp "home" with the three things the attacks need: a victim file the writer must never touch, and a real tree.
final class HomeTree {
  let base = FileManager.default.temporaryDirectory.appendingPathComponent("home-\(UUID().uuidString)")
  var home: String { base.appendingPathComponent("home").path }
  var agents: String { home + "/Library/LaunchAgents" }
  var plist: String { agents + "/com.evenscribe.room-recorder.plist" }
  var victim: String { base.appendingPathComponent("victim-root-helper").path }
  var elsewhere: String { base.appendingPathComponent("elsewhere").path }
  static let victimBytes = Data("ROOT-HELPER-BINARY".utf8)

  init() throws {
    let fm = FileManager.default
    try fm.createDirectory(atPath: home, withIntermediateDirectories: true)
    try fm.createDirectory(atPath: elsewhere, withIntermediateDirectories: true)
    try Self.victimBytes.write(to: URL(fileURLWithPath: victim))
    try fm.setAttributes([.posixPermissions: 0o400], ofItemAtPath: victim)  // not what a plist write would leave it as
  }
  func makeAgents() throws { try FileManager.default.createDirectory(atPath: agents, withIntermediateDirectories: true) }
  func link(_ path: String, to target: String) throws {
    try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: path, withDestinationPath: target)
  }
  func tearDown() {
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: victim)
    try? FileManager.default.removeItem(at: base)
  }

  struct Fingerprint: Equatable { var bytes: Data; var mode: Int; var owner: Int; var inode: UInt64 }
  func fingerprint(_ path: String) -> Fingerprint? {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: path), let bytes = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
    return Fingerprint(
      bytes: bytes, mode: (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1, owner: (attrs[.ownerAccountID] as? NSNumber)?.intValue ?? -1,
      inode: (attrs[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0)
  }
}

@Suite struct RealUserFileWriterTests {
  let tree: HomeTree
  let tools = FakeTools()
  var env: SystemEnvironment { SystemEnvironment(tools: tools, user: SameUserContext(), homeOverride: tree.home) }
  let uid = getuid(), gid = getgid()

  init() throws { tree = try HomeTree() }

  func write(_ path: String? = nil) -> UserWriteResult {
    env.writeUserFile(path ?? tree.plist, data: Data("new-plist".utf8), uid: uid, gid: gid)
  }

  @Test func aSafeWriteMakesTheDirectoryChainAndAUserOwnedFileWithoutAnyChown() throws {
    defer { tree.tearDown() }
    #expect(write() == .written)
    let print = try #require(tree.fingerprint(tree.plist))
    #expect(print.bytes == Data("new-plist".utf8) && print.mode == 0o644 && print.owner == Int(uid))
    #expect(tools.calls.isEmpty, "the writer runs no tool at all: no chown, no chmod by path")
    #expect(try FileManager.default.contentsOfDirectory(atPath: tree.agents) == ["com.evenscribe.room-recorder.plist"], "no temp left")
  }

  @Test func anExistingPlistIsReplacedAtomicallyByARename() throws {
    defer { tree.tearDown() }
    try tree.makeAgents()
    try Data("old".utf8).write(to: URL(fileURLWithPath: tree.plist))
    let before = try #require(tree.fingerprint(tree.plist))
    #expect(write() == .written)
    let after = try #require(tree.fingerprint(tree.plist))
    #expect(after.bytes == Data("new-plist".utf8) && after.inode != before.inode, "a new file renamed over the old one")
  }

  @Test func aSymlinkedPlistPathIsRefusedAndTheTargetIsUntouched() throws {
    defer { tree.tearDown() }
    try tree.link(tree.plist, to: tree.victim)
    let before = try #require(tree.fingerprint(tree.victim))
    #expect(write() == .refusedUnsafePath)
    #expect(tree.fingerprint(tree.victim) == before, "owner, mode, bytes and inode of the root-owned file are unchanged")
    #expect(try FileManager.default.destinationOfSymbolicLink(atPath: tree.plist) == tree.victim, "the link was left alone")
    #expect(tools.calls.isEmpty)
  }

  @Test func aSymlinkedLaunchAgentsDirectoryIsRefused() throws {
    defer { tree.tearDown() }
    try tree.link(tree.agents, to: tree.elsewhere)
    try Data("do not touch".utf8).write(to: URL(fileURLWithPath: tree.elsewhere + "/com.evenscribe.room-recorder.plist"))
    let before = try #require(tree.fingerprint(tree.elsewhere + "/com.evenscribe.room-recorder.plist"))
    #expect(write() == .refusedUnsafePath)
    #expect(tree.fingerprint(tree.elsewhere + "/com.evenscribe.room-recorder.plist") == before)
    #expect(try FileManager.default.contentsOfDirectory(atPath: tree.elsewhere) == ["com.evenscribe.room-recorder.plist"], "nothing created behind the link")
  }

  @Test func aSymlinkedLibraryOrHomeIsRefusedToo() throws {
    defer { tree.tearDown() }
    try tree.link(tree.home + "/Library", to: tree.elsewhere)
    #expect(write() == .refusedUnsafePath)
    #expect(try FileManager.default.contentsOfDirectory(atPath: tree.elsewhere).isEmpty)
    // the home itself a symlink
    let linkedHome = tree.base.appendingPathComponent("linked-home").path
    try FileManager.default.createSymbolicLink(atPath: linkedHome, withDestinationPath: tree.elsewhere)
    let viaLink = SystemEnvironment(tools: tools, user: SameUserContext(), homeOverride: linkedHome)
    #expect(viaLink.writeUserFile(linkedHome + "/Library/LaunchAgents/x.plist", data: Data(), uid: uid, gid: gid) == .refusedUnsafePath)
  }

  @Test func aPathOutsideTheHomeOrWithDotDotIsRefused() throws {
    defer { tree.tearDown() }
    #expect(write(tree.elsewhere + "/x.plist") == .refusedUnsafePath)
    #expect(write(tree.home + "/Library/../../elsewhere/x.plist") == .refusedUnsafePath)
    #expect(write(tree.home + "/x.plist") == .refusedUnsafePath, "a file directly in the home is not a LaunchAgents path")
    #expect(write("/etc/room.plist") == .refusedUnsafePath)
    #expect(try FileManager.default.contentsOfDirectory(atPath: tree.elsewhere).isEmpty)
  }

  @Test func aDirectoryWhereTheFileShouldBeIsRefused() throws {
    defer { tree.tearDown() }
    try FileManager.default.createDirectory(atPath: tree.plist, withIntermediateDirectories: true)
    #expect(write() == .refusedUnsafePath)
  }

  @Test func rootIsNeverAWriteIdentityAndADropThatCannotHappenWritesNothing() throws {
    defer { tree.tearDown() }
    #expect(env.writeUserFile(tree.plist, data: Data("x".utf8), uid: 0, gid: 0) == .refusedUnsafePath)
    // Another user's identity, which this (non-root) test cannot assume: nothing is written, and there is no fallback to root.
    #expect(env.writeUserFile(tree.plist, data: Data("x".utf8), uid: uid &+ 7, gid: gid) == .failed)
    #expect(!FileManager.default.fileExists(atPath: tree.plist))
    #expect(tools.calls.isEmpty)
  }

  @Test func theProductionDropRefusesWhenItIsNotAllowedToDrop() throws {
    defer { tree.tearDown() }
    let production = ThreadUserContext()
    #expect(production.run(uid: 0, gid: 0) { true } == nil, "never as root")
    if getuid() != 0 {
      // pthread_setugid_np needs root; without it the body must NOT run at all.
      final class Flag: @unchecked Sendable { var ran = false }
      let flag = Flag()
      #expect(production.run(uid: getuid(), gid: getgid()) { flag.ran = true; return 1 } == nil)
      #expect(!flag.ran, "no drop, no run, and in particular no run as root")
      let real = SystemEnvironment(tools: tools, user: production, homeOverride: tree.home)
      #expect(real.writeUserFile(tree.plist, data: Data("x".utf8), uid: uid, gid: gid) == .failed)
      #expect(!FileManager.default.fileExists(atPath: tree.plist))
    }
  }

  @Test func theWriterSourceNeverCallsChownOrChmodByPath() throws {
    let source = try String(
      contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Sources/HelperCore/HelperSystem.swift"), encoding: .utf8)
    let code = source.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
    #expect(!code.contains("\"/usr/sbin/chown\"") && !code.contains("chown(") && !code.contains("lchown"))
    #expect(!code.contains("setAttributes"), "no by-path attribute change on a user's path")
    #expect(code.contains("O_NOFOLLOW") && code.contains("O_EXCL") && code.contains("fchmod"))
  }
}

@Suite struct RealUserFileReaderTests {
  let tree: HomeTree
  let tools = FakeTools()
  var env: SystemEnvironment { SystemEnvironment(tools: tools, user: SameUserContext(), homeOverride: tree.home) }
  let uid = getuid(), gid = getgid()
  init() throws { tree = try HomeTree() }

  @Test func aSmallRegularFileIsRead() throws {
    defer { tree.tearDown() }
    let path = tree.elsewhere + "/status.json"
    try Data("{\"state\":\"ready\"}".utf8).write(to: URL(fileURLWithPath: path))
    #expect(env.readUserFile(path, uid: uid, gid: gid) == Data("{\"state\":\"ready\"}".utf8))
  }

  @Test func aSymlinkIsNotFollowed() throws {
    defer { tree.tearDown() }
    try tree.link(tree.elsewhere + "/status.json", to: tree.victim)
    #expect(env.readUserFile(tree.elsewhere + "/status.json", uid: uid, gid: gid) == nil)
    #expect(env.userFileKind(tree.elsewhere + "/status.json", uid: uid, gid: gid) == .symlink)
  }

  @Test func aFIFODoesNotHoldTheHelper() throws {
    defer { tree.tearDown() }
    let path = tree.elsewhere + "/status.json"
    #expect(mkfifo(path, 0o600) == 0)
    let started = Date()
    #expect(env.readUserFile(path, uid: uid, gid: gid) == nil)
    #expect(Date().timeIntervalSince(started) < 2, "it returned, it did not block waiting for a writer")
    #expect(env.userFileKind(path, uid: uid, gid: gid) == .other)
  }

  @Test func anOversizedFileIsRefused() throws {
    defer { tree.tearDown() }
    let path = tree.elsewhere + "/status.json"
    try Data(count: SystemEnvironment.maxUserFileBytes + 1).write(to: URL(fileURLWithPath: path))
    #expect(env.readUserFile(path, uid: uid, gid: gid) == nil)
    try Data(count: SystemEnvironment.maxUserFileBytes).write(to: URL(fileURLWithPath: path))
    #expect(env.readUserFile(path, uid: uid, gid: gid)?.count == SystemEnvironment.maxUserFileBytes)
  }

  @Test func kindsAreReportedWithoutFollowing() throws {
    defer { tree.tearDown() }
    #expect(env.userFileKind(tree.elsewhere + "/nope", uid: uid, gid: gid) == .missing)
    #expect(env.userFileKind(tree.victim, uid: uid, gid: gid) == .regular)
    #expect(env.userFileKind(tree.elsewhere, uid: uid, gid: gid) == .other)
    #expect(env.userFileAge(tree.victim, uid: uid, gid: gid) != nil && env.userFileAge(tree.elsewhere + "/nope", uid: uid, gid: gid) == nil)
  }

  @Test func withoutADropNothingIsRead() throws {
    defer { tree.tearDown() }
    #expect(env.readUserFile(tree.victim, uid: uid &+ 5, gid: gid) == nil)
    #expect(env.userFileKind(tree.victim, uid: uid &+ 5, gid: gid) == .other, "unreadable as that user: treated as not a plain file")
  }
}

/// The verbs themselves, on the REAL file code, with only the machine facts faked.
struct HybridEnv: HelperEnvironment {
  let real: SystemEnvironment
  var appRunning = false
  func consoleUser() -> (uid: UInt32, gid: UInt32, name: String)? { (getuid(), getgid(), "tester") }
  func appRunning(uid: UInt32) -> Bool { appRunning }
  func now() -> Date { TestServer.night }
  func homeDirectory(uid: UInt32) -> String? { real.homeDirectory(uid: uid) }
  func userFileKind(_ path: String, uid: UInt32, gid: UInt32) -> UserFileKind { real.userFileKind(path, uid: uid, gid: gid) }
  func readUserFile(_ path: String, uid: UInt32, gid: UInt32) -> Data? { real.readUserFile(path, uid: uid, gid: gid) }
  func userFileAge(_ path: String, uid: UInt32, gid: UInt32) -> TimeInterval? { real.userFileAge(path, uid: uid, gid: gid) }
  func writeUserFile(_ path: String, data: Data, uid: UInt32, gid: UInt32) -> UserWriteResult {
    real.writeUserFile(path, data: data, uid: uid, gid: gid)
  }
}

@Suite struct VerbsOnTheRealWriterTests {
  let tree: HomeTree
  let server = TestServer()
  let tools = FakeTools()
  init() throws { tree = try HomeTree() }

  var env: HybridEnv {
    HybridEnv(real: SystemEnvironment(tools: FakeTools(), user: SameUserContext(), homeOverride: tree.home))
  }
  func runner() -> HelperCommandRunner {
    HelperCommandRunner(serverKeys: ["fk1": server.publicKey], env: env, tools: tools, statePath: tempPath("s.json"), log: { _ in })
  }
  func reload() -> HelperCommandOutcome {
    runner().run(
      envelopeJSON: server.envelope(at: TestServer.night, verb: "reload_launchagent").canonical, deviceID: TestServer.deviceID,
      machine: TestServer.machine)
  }
  /// The room root the runner derives is <home>/Library/Application Support/EvenScribe/RoomRecorder.
  var plist: String { tree.home + "/Library/LaunchAgents/com.evenscribe.room-recorder.plist" }

  @Test func reloadWithASymlinkedPlistIsRefusedAndTheRootFileIsUnchanged() throws {
    defer { tree.tearDown() }
    try tree.link(plist, to: tree.victim)
    let before = try #require(tree.fingerprint(tree.victim))
    let outcome = reload()
    #expect(outcome == HelperCommandOutcome(.refused, reason: "unsafe_path"))
    #expect(tree.fingerprint(tree.victim) == before)
    #expect(tools.actions.isEmpty, "no bootout, no bootstrap")
  }

  @Test func reloadWithASymlinkedLaunchAgentsDirectoryWritesNothingAndRunsNothing() throws {
    defer { tree.tearDown() }
    try tree.link(tree.home + "/Library/LaunchAgents", to: tree.elsewhere)
    let outcome = reload()
    #expect(outcome == HelperCommandOutcome(.refused, reason: "unsafe_path"))
    #expect(try FileManager.default.contentsOfDirectory(atPath: tree.elsewhere).isEmpty)
    #expect(tools.actions.isEmpty)
  }

  @Test func reloadWithAMissingPlistWritesAUserOwnedPlistThenReloadsIt() throws {
    defer { tree.tearDown() }
    let outcome = reload()
    #expect(outcome.kind == .ok && outcome.detail["plist_rewritten"] == .bool(true))
    let print = try #require(tree.fingerprint(plist))
    #expect(print.owner == Int(getuid()) && print.mode == 0o644)
    #expect(tools.actions == ["/bin/launchctl bootout gui/\(getuid())/com.evenscribe.room-recorder", "/bin/launchctl bootstrap gui/\(getuid()) \(plist)"])
  }

  @Test func theWatchdogWithASymlinkedPlistTouchesNothing() throws {
    defer { tree.tearDown() }
    try tree.link(plist, to: tree.victim)
    let before = try #require(tree.fingerprint(tree.victim))
    let dog = AppWatchdog(env: env, tools: tools, log: { _ in })
    #expect(dog.tick() == .missing)
    #expect(tree.fingerprint(tree.victim) == before)
    #expect(tools.calls.isEmpty)
  }

  @Test func theWatchdogRestoresAMissingPlistAsTheUserAndThenBootstraps() throws {
    defer { tree.tearDown() }
    let dog = AppWatchdog(env: env, tools: tools, log: { _ in })
    #expect(dog.tick() == .restarting)
    #expect(tree.fingerprint(plist)?.owner == Int(getuid()))
    #expect(tools.calls == ["/bin/launchctl bootstrap gui/\(getuid()) \(plist)"])
  }

  @Test func aStatusFileThatIsAFIFOMakesTheWatchdogCarryOnInsteadOfHanging() throws {
    defer { tree.tearDown() }
    let root = tree.home + "/Library/Application Support/EvenScribe/RoomRecorder"
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    #expect(mkfifo(root + "/status.json", 0o600) == 0)
    let dog = AppWatchdog(env: env, tools: tools, log: { _ in })
    let started = Date()
    #expect(dog.tick() == .restarting)
    #expect(Date().timeIntervalSince(started) < 5)
  }
}
