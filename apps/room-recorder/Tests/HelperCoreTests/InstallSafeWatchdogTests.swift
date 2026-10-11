import Foundation
import Testing

@testable import HelperCore

// MARK: - 0.1.36 carry: the watchdog cannot relaunch the app in the middle of an install

/// The scripts are run for real (stub launchctl, sandbox directories) and the watchdog reads the very file they
/// write, through the real `SystemEnvironment` marker reader. Nothing here fakes the marker itself except where
/// a test says so.
@Suite struct InstallSafeWatchdogTests {
  typealias Box = PostinstallScriptTests.Sandbox
  static var preinstall: URL { PostinstallScriptTests.packaging.appendingPathComponent("pkg-scripts/preinstall") }

  func runPreinstall(_ box: Box) throws -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = [Self.preinstall.path, "pkg", box.apps.path, "/", "/"]
    process.environment = [
      "ETA_POSTINSTALL_TEST": "1", "ETA_SUPPORT_DIR": box.support.path, "ETA_INSTALL_LOG": box.installLog.path,
      "PATH": "/usr/bin:/bin",
    ]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus
  }

  func markerExists(_ box: Box) -> Bool { FileManager.default.fileExists(atPath: box.marker.path) }
  func markerCalls(_ box: Box) -> [String] { box.lines(box.markerLog) }

  /// A watchdog on a Mac whose app is missing, reading the sandbox marker with the production reader.
  func watchdog(_ box: Box, tools: FakeTools) -> (AppWatchdog, FakeEnv) {
    let env = FakeEnv()
    env.appIsRunning = false
    env.files[FakeEnv.plist] = Data("plist".utf8)
    let real = SystemEnvironment(tools: FakeTools(), markerDirectory: box.support.path, markerOwner: getuid())
    env.installProbe = { real.installMarkerAge() }
    return (AppWatchdog(env: env, tools: tools, log: { _ in }), env)
  }

  // ─── the scripts ───────────────────────────────────────────────────────────────────────────

  @Test func theMarkerIsUpForEveryLaunchctlCallOfAnInstallAndGoneAfterwards() throws {
    let box = try Box()
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0)
    let calls = markerCalls(box)
    #expect(calls.contains { $0.hasPrefix("bootout") } && calls.contains { $0.hasPrefix("bootstrap") }, "the install did run")
    #expect(calls.allSatisfy { $0.hasSuffix("marker=present") }, "every launchctl call happened inside the hold: \(calls)")
    #expect(!markerExists(box), "and the hold is removed when the install ends")
  }

  @Test func thePreinstallWritesAPlainRootStyleMarkerAndNeverFailsTheInstall() throws {
    let box = try Box()
    defer { box.tearDown() }
    #expect(try runPreinstall(box) == 0)
    #expect(markerExists(box))
    let attributes = try FileManager.default.attributesOfItem(atPath: box.marker.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o644)
    #expect(attributes[.type] as? FileAttributeType == .typeRegular)
    // A second run replaces it rather than failing.
    #expect(try runPreinstall(box) == 0)
    // An unwritable support directory still lets the install go on.
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: box.support.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: box.support.path) }
    #expect(try runPreinstall(box) == 0)
  }

  @Test func aPreinstallThenPostinstallSequenceHoldsFromTheFirstScriptToTheLast() throws {
    let box = try Box()
    defer { box.tearDown() }
    #expect(try runPreinstall(box) == 0)
    #expect(markerExists(box), "held between the two scripts, while the installer lays the payload down")
    #expect(try box.run().status == 0)
    #expect(!markerExists(box))
  }

  @Test func aFailedDaemonStepStillClearsTheHold() throws {
    let box = try Box(bootstrapFails: true)
    defer { box.tearDown() }
    #expect(try box.run().status == 1)
    #expect(!markerExists(box), "an install that failed must not leave the watchdog off")
    #expect(markerCalls(box).allSatisfy { $0.hasSuffix("marker=present") })
  }

  @Test func aMissingAppFailsTheInstallAndStillClearsTheHold() throws {
    let box = try Box(withApp: false)
    defer { box.tearDown() }
    #expect(try runPreinstall(box) == 0)
    #expect(try box.run().status == 1)
    #expect(!markerExists(box))
  }

  @Test func everyEarlyExitZeroClearsTheHoldToo() throws {
    let noHelper = try Box(withHelper: false)
    defer { noHelper.tearDown() }
    #expect(try noHelper.run().status == 0)
    #expect(!markerExists(noHelper))
    let badCopy = try Box(codesignFails: true)
    defer { badCopy.tearDown() }
    #expect(try badCopy.run().status == 0)
    #expect(!markerExists(badCopy))
  }

  @Test func aTerminatedInstallClearsTheHold() throws {
    // The sleep stub sends SIGTERM to the script while it waits for the old job to leave.
    let box = try Box(preloaded: true, bootoutLingers: 5)
    defer { box.tearDown() }
    try "#!/bin/sh\nkill -TERM $PPID\n".write(to: box.sleepStub, atomically: true, encoding: .utf8)
    let result = try box.run()
    #expect(result.status == 1, "the TERM trap exits non-zero: \(result.output)")
    #expect(!markerExists(box))
  }

  @Test func theMarkerIsWrittenBeforeAnythingElseHappens() throws {
    let source = try String(contentsOf: PostinstallScriptTests.script, encoding: .utf8)
    let trap = try #require(source.range(of: "trap clear_install_marker EXIT"))
    let firstExit = try #require(source.range(of: "exit 1"))
    let bootout = try #require(source.range(of: "bootout \"system/$LABEL\" >"))
    #expect(trap.lowerBound < firstExit.lowerBound, "the trap is set before the script can exit")
    #expect(trap.lowerBound < bootout.lowerBound)
    let pre = try String(contentsOf: Self.preinstall, encoding: .utf8)
    #expect(pre.contains("exit 0") && !pre.contains("exit 1"), "the preinstall never fails the install")
  }

  // ─── the watchdog, reading what the scripts wrote ──────────────────────────────────────────

  @Test func theWatchdogDoesNotRelaunchWhileTheScriptsMarkerStandsAndDoesAfterItIsCleared() throws {
    let box = try Box()
    defer { box.tearDown() }
    let (control, _) = watchdog(box, tools: FakeTools())
    #expect(control.tick() == .restarting, "control: with no install the missing app IS relaunched")
    let tools = FakeTools()
    let (held, _) = watchdog(box, tools: tools)
    #expect(try runPreinstall(box) == 0)
    for _ in 0..<5 { #expect(held.tick() == .installing) }
    #expect(tools.calls.isEmpty, "no bootstrap, no kickstart, while the install runs: \(tools.calls)")
    #expect(held.consecutiveFailures == 0, "and the hold does not feed the backoff")
    #expect(try box.run().status == 0)
    #expect(held.tick() == .restarting, "the install is over: the watchdog is back at once")
    #expect(tools.calls.first == "/bin/launchctl bootstrap gui/501 \(FakeEnv.plist)")
  }

  @Test func aMarkerLeftByAKilledInstallerAgesOut() throws {
    let box = try Box()
    defer { box.tearDown() }
    #expect(try runPreinstall(box) == 0)
    let old = Date().addingTimeInterval(-(HelperPaths.installMarkerGrace + 60))
    try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: box.marker.path)
    let tools = FakeTools()
    let (dog, _) = watchdog(box, tools: tools)
    #expect(dog.tick() == .restarting, "a marker older than 30 minutes is ignored")
  }

  @Test func aMarkerThatIsNotARootOwnedPlainFileIsIgnored() throws {
    let box = try Box()
    defer { box.tearDown() }
    try FileManager.default.createDirectory(at: box.support, withIntermediateDirectories: true)
    let real = SystemEnvironment(tools: FakeTools(), markerDirectory: box.support.path, markerOwner: getuid())
    #expect(real.installMarkerAge() == nil, "no file")
    // a symlink to a fresh file
    let target = box.base.appendingPathComponent("target")
    try Data("x".utf8).write(to: target)
    try FileManager.default.createSymbolicLink(at: box.marker, withDestinationURL: target)
    #expect(real.installMarkerAge() == nil, "a symlink is not a marker")
    try FileManager.default.removeItem(at: box.marker)
    // a directory
    try FileManager.default.createDirectory(at: box.marker, withIntermediateDirectories: true)
    #expect(real.installMarkerAge() == nil, "a directory is not a marker")
    try FileManager.default.removeItem(at: box.marker)
    // a plain file: counts only for its owner
    try Data("x".utf8).write(to: box.marker)
    let age = try #require(real.installMarkerAge())
    #expect(age >= 0 && age < 60)
    let stranger = SystemEnvironment(tools: FakeTools(), markerDirectory: box.support.path, markerOwner: getuid() &+ 1)
    #expect(stranger.installMarkerAge() == nil, "a marker the wrong user owns cannot switch the watchdog off")
    let production = SystemEnvironment(tools: FakeTools(), markerDirectory: box.support.path)
    #expect(production.installMarkerAge() == nil || getuid() == 0, "production wants root as the owner")
  }

  @Test func theInstallHoldBeatsEveryOtherReasonToActAndIsNeverCountedAsAFailure() {
    let env = FakeEnv()
    env.appIsRunning = false
    env.installAge = 10
    let tools = FakeTools()
    let dog = AppWatchdog(env: env, tools: tools, log: { _ in })
    for _ in 0..<3 { #expect(dog.tick() == .installing) }
    #expect(tools.calls.isEmpty && env.writes.isEmpty, "no plist written either: nothing is touched during an install")
    #expect(dog.consecutiveFailures == 0)
    env.installAge = HelperPaths.installMarkerGrace  // exactly the grace is already too old
    env.files[FakeEnv.plist] = Data("plist".utf8)
    #expect(dog.tick() == .restarting)
  }

  @Test func aRunningAppIsStillReportedRunningWhateverTheMarkerSays() {
    let env = FakeEnv()
    env.installAge = 5
    #expect(AppWatchdog(env: env, tools: FakeTools(), log: { _ in }).tick() == .running)
  }
}
