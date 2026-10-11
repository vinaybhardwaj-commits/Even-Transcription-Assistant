import Foundation
import Testing

@testable import FleetCore
@testable import HelperCore

// MARK: - #43 Power

/// A fake `pmset` that keeps real state, so enforcement can be watched converging.
final class FakePmset: @unchecked Sendable {
  let tools = FakeTools()
  private let lock = NSLock()
  var settings: [String: Int]
  var schedule: String
  var failSet = Set<String>()

  static let good: [String: Int] = ["sleep": 0, "disksleep": 0, "displaysleep": 0, "powernap": 0, "autorestart": 1, "womp": 1]

  init(_ settings: [String: Int] = FakePmset.good, schedule: String = "") {
    self.settings = settings
    self.schedule = schedule
    tools.responder = { [unowned self] exe, args in
      self.lock.lock(); defer { self.lock.unlock() }
      guard exe == "/usr/bin/pmset" else { return ToolResult(status: 0) }
      if args == ["-g"] {
        return ToolResult(status: 0, output: "System-wide power settings:\nCurrently in use:\n standby 1\n" + self.settings.sorted { $0.key < $1.key }.map { " \($0.key) \($0.value)" }.joined(separator: "\n") + "\n")
      }
      if args == ["-g", "sched"] { return ToolResult(status: 0, output: self.schedule) }
      if args.count == 3, args[0] == "-a" {
        if self.failSet.contains(args[1]) { return ToolResult(status: 1) }
        self.settings[args[1]] = Int(args[2])
        return ToolResult(status: 0)
      }
      if args.count == 4, args[0] == "repeat", args[1] == "wakeorpoweron", args[2] == "MTWRFSU" {
        let parts = args[3].split(separator: ":")
        let hour = Int(parts[0])!, minute = parts[1]
        self.schedule = "Repeating power events:\n  wakepoweron at \(hour % 12 == 0 ? 12 : hour % 12):\(minute)\(hour >= 12 ? "PM" : "AM") every day\n"
        return ToolResult(status: 0)
      }
      return ToolResult(status: 1)
    }
  }
}

@Suite struct PowerPolicyTests {
  @Test func theBaselineIsTheCompiledInSix() {
    #expect(PowerPolicy.baseline.map { "\($0.key)=\($0.value)" } == ["sleep=0", "disksleep=0", "displaysleep=0", "powernap=0", "autorestart=1", "womp=1"])
    #expect(PowerPolicy.defaultPowerOn == "07:05")
  }

  @Test func parsesTheLinesOfPmsetG() {
    let sample = """
      System-wide power settings:
      Currently in use:
       standbydelaylow      10800
       sleep                0 (sleep prevented by powerd)
       womp                 1
       autorestart          1
       displaysleep         10
      """
    let parsed = PowerPolicy.parse(pmsetG: sample)
    #expect(parsed["sleep"] == 0 && parsed["womp"] == 1 && parsed["displaysleep"] == 10 && parsed["standbydelaylow"] == 10_800)
    #expect(parsed["System-wide"] == nil)
  }

  @Test func driftNamesWhatDiffersAndIgnoresWhatTheMacDoesNotReport() {
    #expect(PowerPolicy.drift(current: FakePmset.good).isEmpty)
    #expect(PowerPolicy.drift(current: ["sleep": 10, "womp": 0]) == ["sleep=10(want 0)", "womp=0(want 1)"])
    #expect(PowerPolicy.drift(current: [:]).isEmpty, "a setting the Mac does not report cannot be judged")
  }

  @Test func enforceRevertsAManualChangeAndSaysSo() {
    let pmset = FakePmset(["sleep": 5, "disksleep": 0, "displaysleep": 10, "powernap": 1, "autorestart": 1, "womp": 1])
    let report = PowerPolicy(tools: pmset.tools).enforce()
    #expect(report.driftBefore == ["sleep=5(want 0)", "displaysleep=10(want 0)", "powernap=1(want 0)"])
    #expect(report.applied == ["sleep=0", "displaysleep=0", "powernap=0"])
    #expect(report.driftAfter.isEmpty && report.ok)
    #expect(pmset.settings == FakePmset.good)
    #expect(pmset.tools.actions == ["/usr/bin/pmset -a sleep 0", "/usr/bin/pmset -a displaysleep 0", "/usr/bin/pmset -a powernap 0"])
  }

  @Test func aBaselineMacIsLeftAloneWithoutAWrite() {
    let pmset = FakePmset()
    let report = PowerPolicy(tools: pmset.tools).enforce()
    #expect(report.ok && report.applied.isEmpty && pmset.tools.actions.isEmpty)
  }

  @Test func aSettingThatWillNotApplyIsAFailureNotASilentPass() {
    let pmset = FakePmset(["sleep": 5, "disksleep": 0, "displaysleep": 0, "powernap": 0, "autorestart": 1, "womp": 1])
    pmset.failSet = ["sleep"]
    let report = PowerPolicy(tools: pmset.tools).enforce()
    #expect(!report.ok && report.failures == ["sleep_1"] && report.driftAfter == ["sleep=5(want 0)"])
  }

  @Test func autologinAndEverythingElseIsNeverTouched() {
    let pmset = FakePmset(["sleep": 5, "disksleep": 5, "displaysleep": 5, "powernap": 1, "autorestart": 0, "womp": 0])
    let policy = PowerPolicy(tools: pmset.tools)
    _ = policy.enforce()
    _ = policy.assertSchedule()
    #expect(pmset.tools.calls.allSatisfy { $0.hasPrefix("/usr/bin/pmset ") })
    #expect(!pmset.tools.calls.contains { $0.lowercased().contains("autologin") || $0.contains("defaults") || $0.contains("kcpassword") })
  }

  @Test func theScheduleParserReadsAMAndPMAndRequiresEveryDay() {
    #expect(PowerPolicy.scheduleMatches("Repeating power events:\n  wakepoweron at 7:05AM every day\n", time: "07:05"))
    #expect(PowerPolicy.scheduleMatches("  wake or power on at 7:05AM every day", time: "07:05"))
    #expect(PowerPolicy.scheduleMatches("  wakepoweron at 12:00AM every day", time: "00:00"))
    #expect(PowerPolicy.scheduleMatches("  wakepoweron at 7:05PM every day", time: "19:05"))
    #expect(!PowerPolicy.scheduleMatches("  wakepoweron at 7:05AM weekdays", time: "07:05"))
    #expect(!PowerPolicy.scheduleMatches("  wakepoweron at 8:05AM every day", time: "07:05"))
    #expect(!PowerPolicy.scheduleMatches("", time: "07:05"))
  }

  @Test func theDailyPowerOnIsReassertedOnlyWhenItHasBeenCleared() {
    let cleared = FakePmset()
    let first = PowerPolicy(tools: cleared.tools).assertSchedule()
    #expect(first.changed && first.ok)
    #expect(cleared.tools.actions == ["/usr/bin/pmset repeat wakeorpoweron MTWRFSU 07:05:00"])
    let again = PowerPolicy(tools: cleared.tools).assertSchedule()
    #expect(!again.changed && again.ok)
    #expect(cleared.tools.actions.count == 1, "no second write once it holds")
    #expect(PowerPolicy(tools: cleared.tools).powerSchedule() == "MTWRFSU 07:05")
  }

  @Test func theFifteenMinutePassKeepsTheTimeASchedulePoweronSet() {
    let pmset = FakePmset()
    let env = FakeEnv()
    let timePath = tempPath("power-time")
    PowerPolicy.saveStoredTime("06:45", at: timePath)
    let monitor = HelperMonitor(
      env: env, tools: pmset.tools, watchdog: AppWatchdog(env: env, tools: pmset.tools, log: { _ in }), safeMode: false,
      heartbeatPath: tempPath("hb.json"), powerTimePath: timePath, log: { _ in })
    monitor.enforcePower()
    #expect(pmset.tools.actions.contains("/usr/bin/pmset repeat wakeorpoweron MTWRFSU 06:45:00"))
    #expect(!pmset.tools.actions.contains { $0.contains("07:05") }, "the default is not forced back over a chosen time")
    #expect(monitor.statusDetail()["power_schedule"] == "MTWRFSU 06:45")
  }

  @Test func aStoredTimeThatIsNotAClockTimeIsIgnored() {
    let path = tempPath("power-time")
    try? "25:99\n".write(toFile: path, atomically: true, encoding: .utf8)
    #expect(PowerPolicy.storedTime(at: path) == nil)
    #expect(PowerPolicy.storedTime(at: tempPath("none")) == nil)
  }

  @Test func aMonitorTickRevertsAManualChangeWithinTheInterval() {
    let pmset = FakePmset(["sleep": 30, "disksleep": 0, "displaysleep": 0, "powernap": 0, "autorestart": 1, "womp": 1])
    let env = FakeEnv()
    var logs: [String] = []
    let lock = NSLock()
    let monitor = HelperMonitor(
      env: env, tools: pmset.tools, watchdog: AppWatchdog(env: env, tools: pmset.tools, log: { _ in }), safeMode: false,
      heartbeatPath: tempPath("hb.json"), log: { lock.lock(); logs.append($0); lock.unlock() })
    #expect(HelperMonitor.powerInterval == 900, "15 minutes")
    monitor.enforcePower()
    #expect(pmset.settings["sleep"] == 0)
    #expect(logs.contains { $0.contains("reverted sleep=30(want 0)") })
    #expect(monitor.statusDetail()["power_schedule"] == "MTWRFSU 07:05" && monitor.statusDetail()["pmset_drift"] == "")
  }
}

// MARK: - #46 Watchdog

@Suite struct AppWatchdogTests {
  let env = FakeEnv()
  let tools = FakeTools()
  func dog() -> AppWatchdog { AppWatchdog(env: env, tools: tools, log: { _ in }) }
  func missing() { env.appIsRunning = false; env.files[FakeEnv.plist] = Data("plist".utf8) }

  @Test func aRunningAppIsLeftAlone() {
    #expect(dog().tick() == .running)
    #expect(tools.calls.isEmpty)
  }

  @Test func bootoutByTheRoomUserIsFixedOnTheNextTick() {
    missing()
    #expect(dog().tick() == .restarting)
    #expect(tools.calls == ["/bin/launchctl bootstrap gui/501 \(FakeEnv.plist)"])
  }

  @Test func aDeletedPlistIsRestoredThenTheAppIsBootstrapped() throws {
    env.appIsRunning = false  // and no plist on disk
    #expect(dog().tick() == .restarting)
    let write = try #require(env.writes.first)
    #expect(write.path == FakeEnv.plist && write.uid == 501)
    let plist = try #require(try PropertyListSerialization.propertyList(from: write.data, format: nil) as? [String: Any])
    #expect(plist["KeepAlive"] as? Bool == true && plist["RunAtLoad"] as? Bool == true)
    #expect((plist["ProgramArguments"] as? [String]) == ["/Applications/EvenScribe Room Recorder.app/Contents/MacOS/room-recorder", "run", "--root", FakeEnv.root])
    #expect(tools.calls == ["/bin/launchctl bootstrap gui/501 \(FakeEnv.plist)"])
  }

  @Test func ifBootstrapSaysAlreadyLoadedItKickstartsWithoutDashK() {
    missing()
    tools.responder = { _, args in args.first == "bootstrap" ? ToolResult(status: 37) : ToolResult(status: 0) }
    #expect(dog().tick() == .restarting)
    #expect(tools.calls == ["/bin/launchctl bootstrap gui/501 \(FakeEnv.plist)", "/bin/launchctl kickstart gui/501/com.evenscribe.room-recorder"])
    #expect(!tools.calls.contains { $0.contains("-k") })
  }

  @Test func atTheLoginWindowItDoesNothingAndSaysNoConsoleUser() {
    env.console = nil
    env.appIsRunning = false
    let watchdog = dog()
    for _ in 0..<10 { #expect(watchdog.tick() == .noConsoleUser) }
    #expect(tools.calls.isEmpty && env.writes.isEmpty, "no relaunch attempts spam")
    #expect(watchdog.lastState == .noConsoleUser && watchdog.consecutiveFailures == 0)
  }

  @Test func theBackoffIsThirtyThenDoublingToFiveMinutes() {
    #expect((1...7).map { AppWatchdog.delay(afterFailures: $0) } == [30, 60, 120, 240, 300, 300, 300])
  }

  @Test func itDoesNotRetryBeforeTheBackoffHasRunOut() {
    missing()
    let watchdog = dog()
    #expect(watchdog.tick() == .restarting)
    #expect(tools.calls.count == 1)
    env.clock = env.clock.addingTimeInterval(29)
    #expect(watchdog.tick() == .missing)
    #expect(tools.calls.count == 1, "still inside the 30 s")
    env.clock = env.clock.addingTimeInterval(2)
    #expect(watchdog.tick() == .restarting)
    #expect(tools.calls.count == 2)
    env.clock = env.clock.addingTimeInterval(59)
    #expect(watchdog.tick() == .missing && tools.calls.count == 2, "the second gap is 60 s")
    env.clock = env.clock.addingTimeInterval(2)
    #expect(watchdog.tick() == .restarting && tools.calls.count == 3)
    #expect(watchdog.consecutiveFailures == 3)
  }

  @Test func theBackoffResetsWhenTheAppIsSeenRunning() {
    missing()
    let watchdog = dog()
    _ = watchdog.tick()
    env.appIsRunning = true
    #expect(watchdog.tick() == .running && watchdog.consecutiveFailures == 0)
    env.appIsRunning = false
    #expect(watchdog.tick() == .restarting, "no leftover wait")
  }

  @Test func neverFightsARecorderThatStoppedBecauseItNeedsEnrolment() {
    missing()
    env.setStatus("needs_enrol")
    let watchdog = dog()
    for _ in 0..<5 { #expect(watchdog.tick() == .needsEnrol) }
    #expect(tools.calls.isEmpty)
  }

  @Test func neverFightsAnOperatorHold() {
    missing()
    env.files[FakeEnv.root + "/watchdog-hold"] = Data()
    #expect(dog().tick() == .held)
    #expect(tools.calls.isEmpty)
  }

  @Test func neverFightsAnUpdateInFlight() {
    missing()
    env.files[FakeEnv.root + "/update-handover.json"] = Data()
    env.ages[FakeEnv.root + "/update-handover.json"] = 60
    #expect(dog().tick() == .updating)
    #expect(tools.calls.isEmpty)
    env.ages[FakeEnv.root + "/update-handover.json"] = AppWatchdog.handoverGrace + 1  // stale marker
    #expect(dog().tick() == .restarting)
  }

  @Test func aPlistItCannotWriteIsLoggedAndBacksOffNotRetriedInALoop() {
    env.appIsRunning = false
    env.writeResult = .failed
    let watchdog = dog()
    #expect(watchdog.tick() == .missing)
    #expect(watchdog.tick() == .missing)
    #expect(tools.calls.isEmpty && watchdog.consecutiveFailures == 1, "the second tick is inside the backoff")
  }

  @Test func aPlistThatIsASymlinkIsNeverWrittenOverOrLoaded() {
    env.appIsRunning = false
    env.files[FakeEnv.plist] = Data("x".utf8)
    env.symlinks = [FakeEnv.plist]
    let watchdog = dog()
    #expect(watchdog.tick() == .missing)
    #expect(tools.calls.isEmpty && env.writes.isEmpty)
  }

  @Test func anUnsafePlistPathIsRefusedAndBacksOff() {
    env.appIsRunning = false
    env.writeResult = .refusedUnsafePath
    let watchdog = dog()
    #expect(watchdog.tick() == .missing && watchdog.consecutiveFailures == 1)
    #expect(tools.calls.isEmpty)
  }

  @Test func itOnlyEverUsesTheUsersGuiDomain() {
    missing()
    _ = dog().tick()
    #expect(tools.calls.allSatisfy { $0.contains("gui/501") })
    #expect(!tools.calls.contains { $0.contains("system/") })
  }

  @Test func theProcessScanFindsTheAppOnlyForTheRightUser() {
    let ps = """
        0 /sbin/launchd
      501 /Applications/EvenScribe Room Recorder.app/Contents/MacOS/room-recorder run --root /Users/room/x
      502 /Applications/EvenScribe Room Recorder.app/Contents/MacOS/room-recorder run --root /Users/other/x
      501 /Applications/EvenScribe Room Recorder.app/Contents/Helpers/tapewriter record --out /x --device d
      """
    #expect(HelperProcessScan.appRunning(psOutput: ps, uid: 501))
    #expect(!HelperProcessScan.appRunning(psOutput: ps, uid: 503))
    #expect(!HelperProcessScan.appRunning(psOutput: "501 /usr/bin/room-recorder-other run", uid: 501))
  }
}

// MARK: - The heartbeat file and the XPC surface

@Suite struct HelperMonitorAndServiceTests {
  @Test func eachTickWritesAWorldReadableHeartbeatWithTheFieldsFLEETReads() throws {
    let pmset = FakePmset()
    let env = FakeEnv()
    let path = tempPath("heartbeat.json")
    let monitor = HelperMonitor(
      env: env, tools: pmset.tools, watchdog: AppWatchdog(env: env, tools: pmset.tools, log: { _ in }), safeMode: false,
      heartbeatPath: path, log: { _ in })
    monitor.enforcePower()
    let beat = monitor.tick()
    #expect(beat.appState == "running" && beat.state == "ok" && beat.consoleUser && beat.powerSchedule == "MTWRFSU 07:05")
    let object = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any])
    for key in ["at", "helper_version", "state", "app_state", "console_user", "power_schedule", "pmset_drift", "watchdog_failures"] {
      #expect(object[key] != nil, "\(key)")
    }
    let mode = (try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber)?.intValue
    #expect(mode == 0o644)
  }

  @Test func atTheLoginWindowTheHeartbeatSaysNoConsoleUser() {
    let pmset = FakePmset()
    let env = FakeEnv()
    env.console = nil
    env.appIsRunning = false
    let monitor = HelperMonitor(
      env: env, tools: pmset.tools, watchdog: AppWatchdog(env: env, tools: pmset.tools, log: { _ in }), safeMode: false,
      heartbeatPath: tempPath("hb.json"), log: { _ in })
    let beat = monitor.tick()
    #expect(beat.appState == "no_console_user" && !beat.consoleUser)
    #expect(monitor.statusDetail()["app_state"] == "no_console_user")
  }

  @Test func theHelperStatusVerbCarriesTheMonitorsDetail() throws {
    let pmset = FakePmset(["sleep": 7, "disksleep": 0, "displaysleep": 0, "powernap": 0, "autorestart": 1, "womp": 1])
    let env = FakeEnv()
    let monitor = HelperMonitor(
      env: env, tools: pmset.tools, watchdog: AppWatchdog(env: env, tools: pmset.tools, log: { _ in }), safeMode: true,
      heartbeatPath: tempPath("hb.json"), log: { _ in })
    let service = HelperService(safeMode: true, statusDetail: { monitor.statusDetail() })
    let reply = try #require(HelperResponse.decode(service.handle(try HelperCodec.encode(.helperStatus))))
    #expect(reply.ok && reply.detail["state"] == "safe_mode" && reply.detail["app_state"] != nil)
    #expect(reply.detail["power_schedule"] != nil && reply.detail["helper_version"] == HelperIdentity.helperVersion)
  }

  @Test func theSixthXPCVerbCarriesAnEnvelopeAndIsBounded() throws {
    let envelope = "{\"v\":2}"
    let good = HelperCommand.runSignedCommand(envelope: envelope, deviceID: "dev_00000000000000000000000a", machine: "m")
    #expect(try HelperCodec.decode(try HelperCodec.encode(good)) == good)
    func refusal(_ command: HelperCommand) -> HelperRefusal? {
      do { _ = try HelperCodec.decode(try HelperCodec.encode(command)); return nil } catch { return error as? HelperRefusal }
    }
    #expect(refusal(.runSignedCommand(envelope: "", deviceID: "dev_00000000000000000000000a", machine: "m")) == .badParams)
    #expect(refusal(.runSignedCommand(envelope: envelope, deviceID: "dev_nope", machine: "m")) == .badParams)
    #expect(refusal(.runSignedCommand(envelope: envelope, deviceID: "dev_00000000000000000000000a", machine: "")) == .badParams)
    #expect(refusal(.runSignedCommand(envelope: String(repeating: "x", count: 6_001), deviceID: "dev_00000000000000000000000a", machine: "m")) == .badParams)
    #expect(refusal(.runSignedCommand(envelope: envelope, deviceID: "dev_00000000000000000000000a", machine: "a\nb")) == .badParams)
  }

  @Test func withoutARunnerTheSignedCommandVerbIsNotImplementedAndWithOneItRefusesForgeries() throws {
    let bare = HelperService(safeMode: false)
    let request = try HelperCodec.encode(.runSignedCommand(envelope: "{}", deviceID: "dev_00000000000000000000000a", machine: "m"))
    #expect(try #require(HelperResponse.decode(bare.handle(request))).code == "not_implemented")
    let env = FakeEnv(), tools = FakeTools()
    let runner = HelperCommandRunner(serverKeys: [:], env: env, tools: tools, statePath: tempPath("s.json"), log: { _ in })
    let service = HelperService(safeMode: false, runner: runner)
    let reply = try #require(HelperResponse.decode(service.handle(request)))
    #expect(!reply.ok && reply.detail["outcome"] == "refused" && reply.detail["reason"] == "malformed")
    #expect(tools.calls.isEmpty)
  }

  @Test func aGoodSignedCommandComesBackAsAnOutcomeAndDetailJSON() throws {
    let server = TestServer()
    let env = FakeEnv(), tools = FakeTools()
    let runner = HelperCommandRunner(serverKeys: ["fk1": server.publicKey], env: env, tools: tools, statePath: tempPath("s.json"), log: { _ in })
    let service = HelperService(safeMode: false, runner: runner)
    let text = server.envelope(at: env.clock, verb: "wake").canonical
    let reply = try #require(HelperResponse.decode(service.handle(try HelperCodec.encode(
      .runSignedCommand(envelope: text, deviceID: TestServer.deviceID, machine: TestServer.machine)))))
    #expect(reply.ok && reply.detail["outcome"] == "ok" && reply.detail["detail_json"] == "{}")
  }
}
