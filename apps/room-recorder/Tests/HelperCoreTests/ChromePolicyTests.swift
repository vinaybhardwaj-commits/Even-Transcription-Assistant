import Foundation
import Testing

@testable import FleetCore
@testable import HelperCore

// MARK: - Fakes

/// Root-owned files held in memory.
final class MemoryPolicyFiles: ChromePolicyFiles, @unchecked Sendable {
  private let lock = NSLock()
  private var store: [String: Data] = [:]
  private(set) var writes: [(path: String, mode: UInt16)] = []
  var failWritesTo: Set<String> = []
  func read(_ path: String) -> Data? { lock.lock(); defer { lock.unlock() }; return store[path] }
  func present(_ path: String) -> Bool { lock.lock(); defer { lock.unlock() }; return store[path] != nil || unreadable.contains(path) }
  /// Paths that are THERE but cannot be read (a link, a FIFO).
  var unreadable: Set<String> = []
  func writeAtomic(_ path: String, data: Data, mode: UInt16) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard !failWritesTo.contains(path) else { return false }
    store[path] = data
    writes.append((path, mode))
    return true
  }
  func put(_ path: String, _ data: Data?) { lock.lock(); store[path] = data; lock.unlock() }
  func writeCount(_ path: String) -> Int { lock.lock(); defer { lock.unlock() }; return writes.filter { $0.path == path }.count }
}

/// A Mac with a Chrome that quits when told to (or does not), one console user, and a clock.
final class ChromeWorld: @unchecked Sendable {
  let env = FakeEnv()
  let tools = FakeTools()
  let files = MemoryPolicyFiles()
  let plist = "/Library/Managed Preferences/com.google.Chrome.plist"
  let configPath = "/support/helper-chrome-policy.json"
  let statePath = "/support/helper-chrome-policy-state.json"
  let lock = NSLock()
  var uptime: TimeInterval = 10_000
  var chromeAlive = true
  var diesOn: Set<Int32> = [SIGTERM]
  private(set) var signals: [(Int32, Int32)] = []
  private(set) var sleeps = 0
  var events: [HelperEvent] = []
  private(set) var logs: [String] = []
  var hidIdleNanoseconds: UInt64? = 900 * 1_000_000_000
  var otherUserLines = ""
  static let base = "/Users/room/Library/Application Support/Google/Chrome"
  static let extensionDir = base + "/Default/Extensions/" + ChromePolicy.extensionID
  static let config = ChromePolicyConfig(machineID: "EHRC-CONSUL4s-Mac-mini", room: "OPD 4", token: "tok-SECRET-0123456789")

  init() {
    env.clock = TestServer.night  // 03:00 IST
    env.directories[Self.base] = ["Default", "Profile 1", "Crashpad"]
    tools.responder = { [unowned self] executable, args in
      switch executable {
      case "/bin/ps":
        lock.lock(); defer { lock.unlock() }
        let chrome = chromeAlive
          ? "  4001   501 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --flag\n"
            + "  4002   501 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer\n"
          : ""
        return ToolResult(status: 0, output: chrome + otherUserLines)
      case "/usr/sbin/ioreg":
        return hidIdleNanoseconds.map { ToolResult(status: 0, output: "    | |   \"HIDIdleTime\" = \($0)\n") } ?? ToolResult(status: 1)
      default: return ToolResult(status: 0)
      }
    }
  }

  func reconciler() -> ChromePolicyReconciler {
    ChromePolicyReconciler(
      files: files, tools: tools, env: env, plistPath: plist, configPath: configPath, statePath: statePath,
      bootTime: { [unowned self] in env.clock.addingTimeInterval(-uptime) },
      sleep: { [unowned self] _ in lock.lock(); sleeps += 1; lock.unlock() },
      signalProcess: { [unowned self] pid, signal in
        lock.lock(); defer { lock.unlock() }
        signals.append((pid, signal))
        if diesOn.contains(signal) { chromeAlive = false }
        return 0
      },
      emit: { [unowned self] event in lock.lock(); events.append(event); lock.unlock() },
      log: { [unowned self] line in lock.lock(); logs.append(line); lock.unlock() })
  }

  func storeConfig(_ config: ChromePolicyConfig = ChromeWorld.config) {
    files.put(configPath, try? JSONEncoder().encode(config))
  }
  func extensionInstalled(_ yes: Bool) { env.directories[Self.extensionDir] = yes ? ["1.2.3_0"] : [] }
  var launchctlOpens: [String] { tools.calls.filter { $0.hasPrefix("/bin/launchctl asuser") } }
}

private func plistData(_ dict: [String: Any]) -> Data {
  try! PropertyListSerialization.data(fromPropertyList: dict, format: .xml, options: 0)
}
private func parse(_ data: Data?) -> [String: Any] {
  (try? PropertyListSerialization.propertyList(from: data ?? Data(), options: [], format: nil)) as? [String: Any] ?? [:]
}

// MARK: - The plist

@Suite struct ChromePolicyPlistTests {
  let config = ChromeWorld.config
  let id = ChromePolicy.extensionID

  @Test func aFreshFileGetsOurForcelistEntryAndTheExtensionsOwnConfig() throws {
    let out = parse(ChromePolicyPlist.merged(existing: nil, config: config))
    #expect(out["ExtensionInstallForcelist"] as? [String] == ["\(id);https://www.evenscribe.app/ext/EHRC-CONSUL4s-Mac-mini/update.xml"])
    let block = try #require((((out["3rdparty"] as? [String: Any])?["extensions"]) as? [String: Any])?[id] as? [String: String])
    #expect(block == ["machine_id": "EHRC-CONSUL4s-Mac-mini", "room": "OPD 4", "token": "tok-SECRET-0123456789"])
  }

  @Test func everyOtherKeyIsKeptExactly_theFixture() throws {
    // A realistic managed file: other policies, another extension in the same list, another extension's config.
    let existing = plistData([
      "HomepageLocation": "https://pulse.even.in/", "BrowserSignin": 0, "PasswordManagerEnabled": false,
      "RestoreOnStartup": 1, "URLAllowlist": ["pulse.even.in", "evenscribe.app"],
      "ExtensionInstallForcelist": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;https://other.example/update.xml", "\(id);https://old.example/update.xml"],
      "3rdparty": [
        "extensions": ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": ["keep": "me"]], "other-top-level": ["x": 1],
      ] as [String: Any],
    ])
    let out = parse(ChromePolicyPlist.merged(existing: existing, config: config))
    #expect(out["HomepageLocation"] as? String == "https://pulse.even.in/")
    #expect(out["BrowserSignin"] as? Int == 0 && out["PasswordManagerEnabled"] as? Bool == false && out["RestoreOnStartup"] as? Int == 1)
    #expect(out["URLAllowlist"] as? [String] == ["pulse.even.in", "evenscribe.app"])
    #expect(
      out["ExtensionInstallForcelist"] as? [String] == [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;https://other.example/update.xml", config.forcelistEntry,
      ], "the other entry stays first, the stale one of ours is replaced, not duplicated")
    let third = try #require(out["3rdparty"] as? [String: Any])
    #expect((third["other-top-level"] as? [String: Int]) == ["x": 1])
    let extensions = try #require(third["extensions"] as? [String: Any])
    #expect((extensions["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] as? [String: String]) == ["keep": "me"])
    #expect(extensions[id] != nil)
  }

  @Test func mergingTwiceChangesNothingAndDriftIsThenNil() {
    let once = ChromePolicyPlist.merged(existing: nil, config: config)
    #expect(ChromePolicyPlist.drift(once, config: config) == nil)
    let twice = ChromePolicyPlist.merged(existing: once, config: config)
    #expect(NSDictionary(dictionary: parse(twice)).isEqual(to: parse(once)))
  }

  @Test func aBinaryPlistIsReadAndWrittenBackAsXML() throws {
    let binary = try PropertyListSerialization.data(fromPropertyList: ["Keep": "yes"], format: .binary, options: 0)
    let out = try #require(ChromePolicyPlist.merged(existing: binary, config: config))
    #expect(String(decoding: out.prefix(5), as: UTF8.self) == "<?xml")
    #expect(parse(out)["Keep"] as? String == "yes")
  }

  @Test func aFileThatDoesNotParseIsStartedAfreshNotCrashedOn() {
    let out = parse(ChromePolicyPlist.merged(existing: Data("not a plist".utf8), config: config))
    #expect(out["ExtensionInstallForcelist"] as? [String] == [config.forcelistEntry])
  }

  @Test func driftNamesMissingAndStripped() {
    #expect(ChromePolicyPlist.drift(nil, config: config) == "missing")
    #expect(ChromePolicyPlist.drift(plistData(["Other": 1]), config: config) == "stripped")
    #expect(ChromePolicyPlist.drift(Data("junk".utf8), config: config) == "stripped")
    let current = ChromePolicyPlist.merged(existing: nil, config: config)
    // a changed token, a changed room, a duplicated entry of ours: each is drift
    var other = config; other.token = "tok-DIFFERENT-0123456789"
    #expect(ChromePolicyPlist.drift(current, config: other) == "stripped")
    other = config; other.room = "OPD 5"
    #expect(ChromePolicyPlist.drift(current, config: other) == "stripped")
    var dict = parse(current)
    dict["ExtensionInstallForcelist"] = [config.forcelistEntry, "\(id);https://old.example/u.xml"]
    #expect(ChromePolicyPlist.drift(plistData(dict), config: config) == "stripped")
  }

  @Test func theTokenNeverAppearsWhenAConfigIsPrinted() {
    #expect(!"\(config)".contains("SECRET") && !String(reflecting: config).contains("SECRET"))
    #expect("\(config)".contains("<redacted>"))
  }

  @Test func theDefaultUpdateUrlIsThePerMachineOneThePresenceGuardWrote() {
    #expect(ChromePolicy.defaultUpdateURL(machineID: "M-1") == "https://www.evenscribe.app/ext/M-1/update.xml")
    let custom = ChromePolicyConfig(machineID: "M-1", room: "r", token: "tok-12345678", updateURL: "https://www.evenscribe.app/ext/update.xml")
    #expect(custom.forcelistEntry == "\(id);https://www.evenscribe.app/ext/update.xml")
  }
}

// MARK: - The real file writer

@Suite struct SystemChromePolicyFilesTests {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("chrome-policy-\(UUID().uuidString)")
  func tearDown() { try? FileManager.default.removeItem(at: dir) }

  @Test func writesAtomicallyWithTheModeAskedAndLeavesNoTempFile() throws {
    defer { tearDown() }
    let files = SystemChromePolicyFiles(setOwner: false)
    let path = dir.appendingPathComponent("com.google.Chrome.plist").path
    #expect(files.writeAtomic(path, data: Data("one".utf8), mode: 0o644))
    #expect(files.read(path) == Data("one".utf8))
    #expect((try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber)?.intValue == 0o644)
    #expect(files.writeAtomic(path, data: Data("two".utf8), mode: 0o600))
    #expect((try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path) == ["com.google.Chrome.plist"])
  }

  @Test func aSymlinkIsNeitherReadNorReplaced() throws {
    defer { tearDown() }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let target = dir.appendingPathComponent("target")
    try Data("secret".utf8).write(to: target)
    let link = dir.appendingPathComponent("link")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
    let files = SystemChromePolicyFiles(setOwner: false)
    #expect(files.read(link.path) == nil)
    #expect(!files.writeAtomic(link.path, data: Data("x".utf8), mode: 0o644))
    #expect(try Data(contentsOf: target) == Data("secret".utf8))
  }

  @Test func aFailedWriteLeavesTheOriginalAlone() throws {
    defer { tearDown() }
    let files = SystemChromePolicyFiles(setOwner: false)
    let path = dir.appendingPathComponent("p.plist").path
    #expect(files.writeAtomic(path, data: Data("keep".utf8), mode: 0o644))
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: dir.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path) }
    #expect(!files.writeAtomic(path, data: Data("new".utf8), mode: 0o644))
    #expect(files.read(path) == Data("keep".utf8))
  }
}

// MARK: - The reconciler

@Suite struct ChromePolicyReconcilerTests {
  let w = ChromeWorld()

  @Test func withoutAConfigNothingIsWrittenAndNothingKilled() {
    #expect(w.reconciler().check() == .noConfig)
    #expect(w.files.writes.isEmpty && w.tools.calls.isEmpty)
  }

  @Test func aMissingFileIsWrittenRootOwnedReadableThenCfprefsdIsKilledOnce() throws {
    w.storeConfig()
    let r = w.reconciler()
    #expect(r.check() == .rewrote)
    #expect(w.files.writes.filter { $0.path == w.plist }.map(\.mode) == [0o644])
    #expect(w.tools.calls == ["/usr/bin/killall cfprefsd"])
    #expect(ChromePolicyPlist.drift(w.files.read(w.plist), config: ChromeWorld.config) == nil)
    #expect(w.events.map(\.kind) == ["chrome.policy"] && w.events[0].fields["reason"] == .string("missing"))
    #expect(w.events[0].fields["machine_id"] == .string("EHRC-CONSUL4s-Mac-mini"))
  }

  @Test func aFileThatIsRightIsLeftAloneWithNoWriteAndNoKill() {
    w.storeConfig()
    let r = w.reconciler()
    _ = r.check()
    let writes = w.files.writeCount(w.plist)
    w.tools.responder = { _, _ in ToolResult(status: 0) }
    #expect(r.check() == .ok && r.check() == .ok)
    #expect(w.files.writeCount(w.plist) == writes)
    #expect(w.tools.calls.filter { $0.contains("killall") }.count == 1, "only the first rewrite killed cfprefsd")
  }

  @Test func theBootWipeIsUndoneAndLabelledBoot() {
    w.storeConfig()
    w.uptime = 20
    let r = w.reconciler()
    #expect(r.check() == .rewrote)
    #expect(w.events.last?.fields["reason"] == .string("boot"))
    // macOS regenerates the managed preferences a few seconds later and strips us again
    w.files.put(w.plist, plistData(["Other": 1]))
    w.uptime = 30
    #expect(r.check() == .rewrote)
    #expect(parse(w.files.read(w.plist))["Other"] as? Int == 1, "and what macOS put there is kept")
  }

  @Test func theBootLoopIsTenSecondsUntilTwoCleanChecksOrThreeHundredSeconds() {
    w.storeConfig()
    w.uptime = 20
    let r = w.reconciler()
    #expect(r.nextDelay() == 10)
    _ = r.check()
    #expect(r.nextDelay() == 10, "a rewrite resets the count")
    _ = r.check()
    #expect(r.nextDelay() == 10, "one clean check is not enough")
    _ = r.check()
    #expect(r.nextDelay() == 60, "two in a row")
    w.uptime = 100
    w.files.put(w.plist, nil)
    _ = r.check()
    #expect(r.nextDelay() == 10, "stripped again inside the window")
    w.uptime = 301
    #expect(r.nextDelay() == 60, "the window is over")
  }

  @Test func aFailedWriteIsReportedAtMostThreeTimesPerBoot() {
    w.storeConfig()
    w.files.failWritesTo = [w.plist]
    let r = w.reconciler()
    for _ in 0..<6 { #expect(r.check() == .failed) }
    #expect(w.events.filter { $0.fields["reason"] == .string("rewrite_failed") }.count == 3)
    #expect(!w.tools.calls.contains { $0.contains("killall") }, "nothing changed, so cfprefsd is left alone")
    #expect(r.statusWord == "rewrite_failed")
  }

  @Test func theTokenIsInNoLogLineAndNoEvent() throws {
    let r = w.reconciler()
    #expect(r.apply(ChromeWorld.config).kind == .ok)
    w.files.failWritesTo = [w.plist]
    w.files.put(w.plist, nil)
    _ = r.check()
    _ = r.relaunch(profile: nil)
    let everything = (w.logs + w.events.map { "\($0.kind) \($0.fields)" } + w.tools.calls).joined(separator: "\n")
    #expect(!everything.contains("SECRET"), "the token went somewhere it must not")
    #expect(w.logs.isEmpty == false)
  }

  @Test func theConfigIsKeptRootOnlyAndNotWorldReadable() throws {
    let r = w.reconciler()
    #expect(r.apply(ChromeWorld.config).kind == .ok)
    #expect(w.files.writes.first { $0.path == w.configPath }?.mode == 0o600)
    #expect(w.files.writes.first { $0.path == w.statePath }?.mode == 0o600)
  }

  @Test func applyingTwiceRewritesOnlyTheFirstTime() {
    let r = w.reconciler()
    #expect(r.apply(ChromeWorld.config) == HelperCommandOutcome(.ok, detail: ["rewrote": .bool(true)]))
    #expect(r.apply(ChromeWorld.config) == HelperCommandOutcome(.ok, detail: ["rewrote": .bool(false)]))
  }

  @Test func aConfigThatCannotBeSavedOrAFileThatCannotBeWrittenIsAFailureNotAnOk() {
    w.files.failWritesTo = [w.configPath]
    #expect(w.reconciler().apply(ChromeWorld.config) == HelperCommandOutcome(.failed, reason: "config_not_saved"))
    w.files.failWritesTo = [w.plist]
    #expect(w.reconciler().apply(ChromeWorld.config) == HelperCommandOutcome(.failed, reason: "policy_not_written"))
  }

  @Test func isActiveNeedsAConfigALiveRightFileAndAFreshCheck() {
    let r = w.reconciler()
    #expect(!r.isActive())
    w.storeConfig()
    #expect(!r.isActive(), "a config alone is not enough")
    _ = r.check()
    #expect(r.isActive())
    w.files.put(w.plist, plistData(["Other": 1]))
    #expect(!r.isActive(), "the live file is checked now, not only the last status")
    _ = r.check()
    #expect(r.isActive())
    w.env.clock = w.env.clock.addingTimeInterval(301)
    #expect(!r.isActive(), "and the last good check must be recent")
  }
}

// MARK: - The relaunch rung

@Suite struct ChromeRelaunchRungTests {
  let w = ChromeWorld()

  /// Everything true: config, a rewrite older than three minutes, night, a user, no extension, 15 minutes idle.
  func ready() -> ChromePolicyReconciler {
    w.storeConfig()
    w.extensionInstalled(false)
    let r = w.reconciler()
    _ = r.check()
    w.env.clock = w.env.clock.addingTimeInterval(200)
    return r
  }

  @Test func whenEveryConditionHoldsItGoes() {
    #expect(ready().relaunchDecision() == .go(basis: "fallback"))
  }

  @Test func eachConditionAloneStopsIt() {
    var r = ready()
    w.env.clock = w.env.clock.addingTimeInterval(-100)  // the rewrite is 100 s old
    #expect(r.relaunchDecision() == .no("last_rewrite_under_3min"))
    w.env.clock = w.env.clock.addingTimeInterval(100)

    w.extensionInstalled(true)
    #expect(r.relaunchDecision() == .no("extension_present"))
    w.extensionInstalled(false)

    w.hidIdleNanoseconds = 599 * 1_000_000_000
    #expect(r.relaunchDecision() == .no("not_idle_599s"))
    w.hidIdleNanoseconds = 600 * 1_000_000_000
    #expect(r.relaunchDecision() == .no("not_idle_600s"), "over 600 s, not 600 s")
    w.hidIdleNanoseconds = nil
    #expect(r.relaunchDecision() == .no("idle_unknown"))
    w.hidIdleNanoseconds = 900 * 1_000_000_000

    w.env.console = nil
    #expect(r.relaunchDecision() == .no("no_console_user"))
    w.env.console = (501, 20, "room")

    w.env.directories[ChromeWorld.base] = nil
    #expect(r.relaunchDecision() == .no("presence_unknown"))
    w.env.directories[ChromeWorld.base] = ["Default"]

    w.files.put(w.configPath, nil)
    #expect(r.relaunchDecision() == .no("no_config"))
    r = ready()
    #expect(r.relaunchDecision() != .no("no_config"))
  }

  @Test func neverInClinicHours_noMatterWhatElseHolds() {
    let r = ready()
    for hour in [7.5, 8, 12, 15, 21.49] {
      // IST = UTC + 5:30; midnight IST of the test day is 18:30 UTC the day before
      let istMidnight = (TestServer.night.timeIntervalSince1970 + 19_800).rounded(.down)
      let day = istMidnight - istMidnight.truncatingRemainder(dividingBy: 86_400) - 19_800
      w.env.clock = Date(timeIntervalSince1970: day + hour * 3_600)
      #expect(FleetClock.inClinicHours(w.env.clock), "\(hour) is inside clinic hours")
      #expect(r.relaunchDecision() == .no("clinic_hours") || r.relaunchDecision() == .no("last_rewrite_under_3min") || r.relaunchDecision() == .no("already_relaunched_for_this_rewrite"), "hour \(hour)")
      #expect(r.relaunchIfDue() != .go(basis: "fallback"))
    }
    #expect(w.signals.isEmpty && w.launchctlOpens.isEmpty, "Chrome was not touched")
  }

  @Test func inClinicHoursTheReasonIsClinicHoursWhenTheRewriteIsOldEnough() {
    w.storeConfig()
    w.extensionInstalled(false)
    w.env.clock = Date(timeIntervalSince1970: 1_760_000_100)  // 14:45 IST
    let r = w.reconciler()
    _ = r.check()
    w.env.clock = w.env.clock.addingTimeInterval(200)
    #expect(FleetClock.inClinicHours(w.env.clock))
    #expect(r.relaunchDecision() == .no("clinic_hours"))
  }

  @Test func itQuitsChromeWithTermThenOpensItAsTheRoomUserNeverAsRoot() {
    let r = ready()
    #expect(r.relaunchIfDue() == .go(basis: "fallback"))
    #expect(w.signals.map { "\($0.0):\($0.1)" } == ["4001:\(SIGTERM)"], "only the main process of the console user, only TERM")
    #expect(
      w.launchctlOpens == [
        "/bin/launchctl asuser 501 /usr/bin/sudo -u room /usr/bin/open -a Google Chrome https://pulse.even.in/"
      ])
    #expect(w.events.last?.fields["reason"] == .string("relaunch") && w.events.last?.fields["method"] == .string("term"))
  }

  @Test func oneRewriteBuysOneRelaunch_andTheSpacingIsThirtyMinutes() {
    let r = ready()
    #expect(r.relaunchIfDue() == .go(basis: "fallback"))
    w.chromeAlive = true
    #expect(r.relaunchIfDue() == .no("already_relaunched_for_this_rewrite"))
    // a new rewrite, but only 10 minutes after the relaunch
    w.files.put(w.plist, nil)
    w.env.clock = w.env.clock.addingTimeInterval(400)
    _ = r.check()
    w.env.clock = w.env.clock.addingTimeInterval(200)
    #expect(r.relaunchDecision() == .no("relaunch_under_30min"))
    w.env.clock = w.env.clock.addingTimeInterval(1_300)
    #expect(r.relaunchDecision() == .go(basis: "fallback"))
  }

  @Test func chromeThatWillNotQuitIsKilledAfterFifteenPolls() {
    let r = ready()
    w.diesOn = [SIGKILL]
    #expect(r.relaunchIfDue() == .go(basis: "fallback"))
    #expect(w.signals.map { $0.1 } == [SIGTERM, SIGKILL])
    #expect(w.sleeps >= 15)
    #expect(w.events.last?.fields["method"] == .string("kill"))
  }

  @Test func whenChromeIsNotRunningItIsJustOpened() {
    let r = ready()
    w.chromeAlive = false
    _ = r.relaunchIfDue()
    #expect(w.signals.isEmpty)
    #expect(w.launchctlOpens.count == 1)
    #expect(w.events.last?.fields["method"] == .string("open"))
  }

  @Test func anotherUsersChromeAndChromeHelperProcessesAreNeverSignalled() {
    let r = ready()
    w.otherUserLines = "  5001   502 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n"
    _ = r.relaunchIfDue()
    #expect(w.signals.map { $0.0 } == [4001], "not 4002 (a helper of the same user), not 5001 (another user)")
  }
}

// MARK: - The four Chrome verbs

@Suite struct ChromeVerbTests {
  let w = ChromeWorld()
  var user: String { "/bin/launchctl asuser 501 /usr/bin/sudo -u room" }

  @Test func chromeRelaunchWithAProfileOpensPulseInThatProfile() {
    let out = w.reconciler().relaunch(profile: "Profile 1")
    #expect(out.kind == .ok && out.detail["method"] == .string("term"))
    #expect(w.launchctlOpens == ["\(user) /usr/bin/open -a Google Chrome --args --profile-directory=Profile 1 https://pulse.even.in/"])
  }

  @Test func chromeRelaunchNeedsAConsoleUser() {
    w.env.console = nil
    let out = w.reconciler().relaunch(profile: nil)
    #expect(out == HelperCommandOutcome(.failed, reason: "no_console_user"))
    #expect(w.signals.isEmpty && w.tools.calls.isEmpty)
  }

  @Test func openPulseUsesChromesOwnBinaryOnlyForARunningChromeAndARealProfile() {
    let r = w.reconciler()
    let out = r.openPulse(profile: "Default")
    #expect(out.kind == .ok)
    #expect(w.launchctlOpens == ["\(user) /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Default https://pulse.even.in/"])
    #expect(w.signals.isEmpty, "opening a window quits nothing")
    #expect(r.openPulse(profile: "Profile 9") == HelperCommandOutcome(.failed, reason: "profile_not_found"))
    w.chromeAlive = false
    #expect(r.openPulse(profile: "Default") == HelperCommandOutcome(.failed, reason: "chrome_not_running"))
    #expect(w.launchctlOpens.count == 1, "a stopped Chrome is never started by the binary (it would become the browser)")
  }

  @Test func policyCycleWritesPolicyThenKillsCfprefsdThenRestartsChrome_inThatOrder() {
    w.storeConfig()
    let out = w.reconciler().cycle(profile: nil)
    #expect(out.kind == .ok && out.detail["rewrote"] == .bool(true))
    let order = w.tools.calls.filter { $0.contains("killall") || $0.contains("asuser") }
    #expect(order.first == "/usr/bin/killall cfprefsd")
    #expect(order.last?.contains("/usr/bin/open -a Google Chrome") == true)
    #expect(w.tools.calls.filter { $0.contains("killall") }.count == 2, "once for the rewrite, once for the cycle")
  }

  @Test func policyCycleWithoutAConfigDoesNothing() {
    #expect(w.reconciler().cycle(profile: nil) == HelperCommandOutcome(.failed, reason: "no_config"))
    #expect(w.tools.calls.isEmpty)
  }

  @Test func everySudoCallNamesTheConsoleUserAndNothingElseRunsAsAnotherUser() {
    w.storeConfig()
    let r = w.reconciler()
    _ = r.cycle(profile: "Default")
    _ = r.openPulse(profile: "Default")
    _ = r.relaunch(profile: nil)
    for call in w.tools.calls where call.contains("/usr/bin/sudo") {
      #expect(call.hasPrefix("/bin/launchctl asuser 501 /usr/bin/sudo -u room "), "\(call)")
    }
  }
}

// MARK: - The catalogue

@Suite struct ChromeCatalogueTests {
  let server = TestServer()
  func verify(_ verb: String, _ params: [String: FleetJSON] = [:], at: Date = TestServer.night, approval: String? = nil, console: Bool = true)
    -> Result<FleetVerifier.Accepted, FleetRefusal>
  {
    server.verify(server.envelope(at: at, verb: verb, params: params, approval: approval), consoleUser: console, now: at)
  }
  func reason(_ r: Result<FleetVerifier.Accepted, FleetRefusal>) -> String? {
    if case .failure(let refusal) = r { return refusal.rawValue }
    return nil
  }
  static let apply: [String: FleetJSON] = ["machine_id": .string("EHRC-CONSUL4s-Mac-mini"), "room": .string("OPD 4"), "token": .string("tok-0123456789")]
  static let day = Date(timeIntervalSince1970: 1_760_000_100)  // 14:45 IST

  @Test func theCatalogueIsTwentyVerbsAndTheFiveNewOnesRunOnTheHelper() {
    #expect(FleetVerb.allCases.count == 20)
    for verb in [FleetVerb.chromePolicyApply, .chromeRelaunch, .openPulse, .policyCycle, .retireLegacy] { #expect(verb.runsOnHelper) }
    #expect(Set(FleetVerb.allCases.filter(\.isPrivileged).map(\.rawValue)) == [
      "coreaudiod_reset", "usb_reseat", "restart_recorder", "reload_launchagent", "chrome_relaunch", "policy_cycle",
    ])
  }

  @Test func applyTakesExactlyTheClosedParams() {
    #expect(reason(verify("chrome_policy_apply", Self.apply)) == nil)
    #expect(reason(verify("chrome_policy_apply", Self.apply.merging(["update_url": .string("https://www.evenscribe.app/ext/update.xml")]) { $1 })) == nil)
    for bad: [String: FleetJSON] in [
      [:], Self.apply.filter { $0.key != "token" }, Self.apply.merging(["extra": .int(1)]) { $1 },
      Self.apply.merging(["token": .string("short")]) { $1 }, Self.apply.merging(["token": .string("has space 01234")]) { $1 },
      Self.apply.merging(["machine_id": .string("a/b")]) { $1 }, Self.apply.merging(["room": .string("")]) { $1 },
      Self.apply.merging(["update_url": .string("http://insecure.example/update.xml")]) { $1 },
      Self.apply.merging(["room": .string("bad\nroom")]) { $1 },
    ] { #expect(reason(verify("chrome_policy_apply", bad)) == "bad_params", "\(bad.keys.sorted())") }
  }

  @Test func theProfileMustBeADirectoryNameNotAPathAndNotTheGuest() {
    for good in ["Default", "Profile 1", "Profile 12"] {
      #expect(reason(verify("open_pulse", ["profile": .string(good)])) == nil)
      #expect(reason(verify("chrome_relaunch", ["profile": .string(good)])) == nil)
      #expect(reason(verify("policy_cycle", ["profile": .string(good)])) == nil)
    }
    for bad in ["../Default", "Default/../x", "Guest Profile", "Profile", "Profile 1234", "default", "", "Profile 1 "] {
      #expect(reason(verify("open_pulse", ["profile": .string(bad)])) == "bad_params", "\(bad)")
      #expect(reason(verify("chrome_relaunch", ["profile": .string(bad)])) == "bad_params", "\(bad)")
    }
    #expect(reason(verify("open_pulse")) == "bad_params", "open_pulse needs its profile")
    #expect(reason(verify("chrome_relaunch")) == nil && reason(verify("policy_cycle")) == nil)
    #expect(reason(verify("chrome_relaunch", ["force": .bool(true)])) == "bad_params")
  }

  @Test func chromeIsNeverRestartedInClinicHours_withOrWithoutAnApproval() {
    for verb in ["chrome_relaunch", "policy_cycle"] {
      #expect(reason(verify(verb, at: Self.day)) == "clinic_hours_no_chrome_restart")
      #expect(reason(verify(verb, at: Self.day, approval: "go_ok1")) == "clinic_hours_no_chrome_restart", "approval does not open the window")
      #expect(reason(verify(verb, at: TestServer.night)) == nil, "at night it needs no approval")
    }
  }

  @Test func theClinicHoursEdgesAreSevenThirtyInclusiveAndTwentyOneThirtyExclusive() {
    func istMinute(_ hour: Int, _ minute: Int) -> Date {
      // 2025-10-09 00:00 IST = 2025-10-08 18:30 UTC
      Date(timeIntervalSince1970: 1_759_948_200 + TimeInterval(hour * 3_600 + minute * 60))
    }
    #expect(reason(verify("chrome_relaunch", at: istMinute(7, 29))) == nil)
    #expect(reason(verify("chrome_relaunch", at: istMinute(7, 30))) == "clinic_hours_no_chrome_restart")
    #expect(reason(verify("chrome_relaunch", at: istMinute(21, 29))) == "clinic_hours_no_chrome_restart")
    #expect(reason(verify("chrome_relaunch", at: istMinute(21, 30))) == nil)
  }

  @Test func openPulseAndApplyAreAllowedInClinicHoursAndNeedNoApproval() {
    #expect(reason(verify("open_pulse", ["profile": .string("Default")], at: Self.day)) == nil)
    #expect(reason(verify("chrome_policy_apply", Self.apply, at: Self.day)) == nil)
  }

  @Test func theGuiVerbsNeedAConsoleUserApplyDoesNot() {
    #expect(reason(verify("chrome_relaunch", console: false)) == "no_console_user")
    #expect(reason(verify("policy_cycle", console: false)) == "no_console_user")
    #expect(reason(verify("open_pulse", ["profile": .string("Default")], console: false)) == "no_console_user")
    #expect(reason(verify("chrome_policy_apply", Self.apply, console: false)) == nil)
  }

  @Test func retireLegacyKnowsPresenceGuardOnly() {
    #expect(reason(verify("retire_legacy", ["component": .string("presence-guard")])) == nil)
    #expect(reason(verify("retire_legacy", ["component": .string("presence-guard"), "purge_secrets": .bool(true)])) == nil)
    for bad: [String: FleetJSON] in [
      [:], ["component": .string("kiosk-health")], ["component": .string("../../etc")], ["component": .string("presence-guard"), "x": .int(1)],
      ["component": .string("presence-guard"), "purge_secrets": .string("yes")],
    ] { #expect(reason(verify("retire_legacy", bad)) == "bad_params") }
  }

  @Test func theDeliveredVerbsCountAgainstThePrivilegedCeiling() {
    let json = server.envelope(at: TestServer.night, verb: "policy_cycle")
    let result = server.verify(json, ran: 10, now: TestServer.night)
    #expect(reason(result) == "rate_limited")
  }
}

// MARK: - Through the helper's own runner

@Suite struct ChromeRunnerTests {
  let server = TestServer()
  let w = ChromeWorld()
  let statePath = tempPath("state.json")

  func runner(withChrome: Bool = true, retirement: LegacyRetirement? = nil) -> HelperCommandRunner {
    HelperCommandRunner(
      serverKeys: ["fk1": server.publicKey], env: w.env, tools: w.tools, chrome: withChrome ? w.reconciler() : nil, retirement: retirement,
      statePath: statePath, log: { _ in })
  }
  func send(_ r: HelperCommandRunner, _ verb: String, _ params: [String: FleetJSON] = [:], approval: String? = nil) -> HelperCommandOutcome {
    let text = server.envelope(at: w.env.clock, verb: verb, params: params, approval: approval).canonical
    return r.run(envelopeJSON: text, deviceID: TestServer.deviceID, machine: TestServer.machine)
  }

  @Test func aSignedApplyWritesThePolicyAndTheStoredConfigDoesNotShowTheTokenAnywhereElse() {
    let out = send(runner(), "chrome_policy_apply", ChromeCatalogueTests.apply)
    #expect(out == HelperCommandOutcome(.ok, detail: ["rewrote": .bool(true)]))
    let parsed = parse(w.files.read(w.plist))
    #expect(parsed["ExtensionInstallForcelist"] as? [String] != nil)
    #expect(!w.logs.joined().contains("tok-0123456789"))
  }

  @Test func aSignedCycleInTheDaytimeChangesNothingAndTouchesNoChrome() {
    w.storeConfig()
    w.env.clock = ChromeCatalogueTests.day
    let out = send(runner(), "policy_cycle")
    #expect(out == HelperCommandOutcome(.refused, reason: "clinic_hours_no_chrome_restart"))
    #expect(w.tools.calls.isEmpty && w.signals.isEmpty)
  }

  @Test func withoutTheReconcilerTheVerbsAreUnsupportedNotSilentlyOk() {
    let r = runner(withChrome: false)
    #expect(send(r, "chrome_policy_apply", ChromeCatalogueTests.apply).kind == .unsupported)
    #expect(send(r, "open_pulse", ["profile": .string("Default")]).kind == .unsupported)
    #expect(send(r, "retire_legacy", ["component": .string("presence-guard")]).kind == .unsupported)
  }
}

// MARK: - Retirement

@Suite struct LegacyRetirementTests {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("retire-\(UUID().uuidString)")
  let tools = FakeTools()
  var prefix: String { dir.path }
  var archiveRoot: String { prefix + "/Library/Application Support/EvenScribe/retired" }
  static let secret = "old-ingest-token-SECRET"

  func install(env: Bool = true) throws {
    for (name, path, _) in LegacyRetirement.artifacts {
      let full = prefix + path
      try FileManager.default.createDirectory(atPath: (full as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
      if name == "state" {
        try FileManager.default.createDirectory(atPath: full, withIntermediateDirectories: true)
        try Data("1".utf8).write(to: URL(fileURLWithPath: full + "/last_rewrite"))
      } else if name == "env" {
        if env { try Data("INGEST_TOKEN=\(Self.secret)\n".utf8).write(to: URL(fileURLWithPath: full)) }
      } else {
        try Data(name.utf8).write(to: URL(fileURLWithPath: full))
      }
    }
  }
  func tearDown() { try? FileManager.default.removeItem(at: dir) }

  /// A launchctl whose job disappears on bootout, after `lingers` more `print`s.
  func launchd(loaded: Bool = true, lingers: Int = 0, neverLeaves: Bool = false) {
    let box = Counter()
    let state = Flag(loaded)
    tools.responder = { _, args in
      switch args.first {
      case "bootout":
        if !neverLeaves && lingers == 0 { state.set(false) }
        return ToolResult(status: loaded ? 0 : 36)
      case "print":
        if !neverLeaves, lingers > 0, box.next() > lingers { state.set(false) }
        return state.value ? ToolResult(status: 0) : ToolResult(status: 113)
      default: return ToolResult(status: 0)
      }
    }
  }
  final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var v: Bool
    init(_ v: Bool) { self.v = v }
    var value: Bool { lock.lock(); defer { lock.unlock() }; return v }
    func set(_ new: Bool) { lock.lock(); v = new; lock.unlock() }
  }

  func retirement(active: Bool = true, sleeps: Counter = Counter()) -> LegacyRetirement {
    LegacyRetirement(
      prefix: prefix, tools: tools, policyActive: { active }, archiveRoot: archiveRoot.replacingOccurrences(of: prefix, with: ""),
      now: { Date(timeIntervalSince1970: 1_760_000_000) }, sleep: { _ in _ = sleeps.next() }, log: { _ in })
  }
  func exists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: prefix + path) }

  @Test func withoutAnActivePolicyNothingIsTouched() throws {
    defer { tearDown() }
    try install()
    launchd()
    let out = retirement(active: false).retire(purgeSecrets: false)
    #expect(out == HelperCommandOutcome(.refused, reason: "policy_not_active"))
    #expect(LegacyRetirement.artifacts.allSatisfy { exists($0.path) })
    #expect(tools.calls.isEmpty, "the job was not even booted out")
  }

  @Test func whenActiveItBootsOutWaitsAndMovesEverythingIntoARootOnlyArchive() throws {
    defer { tearDown() }
    try install()
    launchd()
    let out = retirement().retire(purgeSecrets: false)
    #expect(out.kind == .ok && out.detail["state"] == .string("retired"))
    #expect(LegacyRetirement.artifacts.allSatisfy { !exists($0.path) }, "the env file with the old token is gone from where it was")
    let archive = archiveRoot + "/presence-guard-1760000000"
    #expect(try Set(FileManager.default.contentsOfDirectory(atPath: archive)) == ["plist", "script", "env", "state", "RESTORE.txt"])
    #expect((try FileManager.default.attributesOfItem(atPath: archive)[.posixPermissions] as? NSNumber)?.intValue == 0o700)
    #expect(tools.calls.first == "/bin/launchctl bootout system/com.eta.presence-guard")
  }

  @Test func theArchiveIsEnoughToPutItAllBack() throws {
    defer { tearDown() }
    try install()
    launchd()
    _ = retirement().retire(purgeSecrets: false)
    let archive = archiveRoot + "/presence-guard-1760000000"
    let text = try String(contentsOfFile: archive + "/RESTORE.txt", encoding: .utf8)
    #expect(text.contains("launchctl bootstrap system /Library/LaunchDaemons/com.eta.presence-guard.plist"))
    #expect(!text.contains(Self.secret))
    // do what it says
    for (name, path, _) in LegacyRetirement.artifacts {
      try FileManager.default.createDirectory(atPath: ((prefix + path) as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
      try FileManager.default.moveItem(atPath: "\(archive)/\(name)", toPath: prefix + path)
    }
    #expect(LegacyRetirement.artifacts.allSatisfy { exists($0.path) })
    #expect(try String(contentsOfFile: prefix + "/usr/local/etc/eta-presence-guard.env", encoding: .utf8).contains(Self.secret))
  }

  @Test func purgeSecretsDeletesTheOldTokenInsteadOfArchivingIt() throws {
    defer { tearDown() }
    try install()
    launchd()
    let out = retirement().retire(purgeSecrets: true)
    #expect(out.detail["env_deleted"] == .bool(true))
    let archive = archiveRoot + "/presence-guard-1760000000"
    #expect(try Set(FileManager.default.contentsOfDirectory(atPath: archive)) == ["plist", "script", "state", "RESTORE.txt"])
    let everything = try FileManager.default.subpathsOfDirectory(atPath: archive).compactMap {
      try? String(contentsOfFile: archive + "/" + $0, encoding: .utf8)
    }.joined()
    #expect(!everything.contains(Self.secret))
    #expect(!exists("/usr/local/etc/eta-presence-guard.env"))
  }

  @Test func aJobThatLingersIsWaitedForAndOneThatNeverLeavesChangesNothing() throws {
    defer { tearDown() }
    try install()
    launchd(lingers: 3)
    let sleeps = Counter()
    #expect(retirement(sleeps: sleeps).retire(purgeSecrets: false).kind == .ok)
    #expect(sleeps.next() > 1, "it waited")

    let stuck = LegacyRetirementTests()
    defer { stuck.tearDown() }
    try stuck.install()
    stuck.launchd(neverLeaves: true)
    let waits = Counter()
    #expect(stuck.retirement(sleeps: waits).retire(purgeSecrets: false) == HelperCommandOutcome(.failed, reason: "still_loaded"))
    #expect(LegacyRetirement.artifacts.allSatisfy { stuck.exists($0.path) }, "nothing was moved")
    #expect(waits.next() == 11, "ten waits, then it gave up")
  }

  @Test func runningItAgainOnARetiredMacIsAHarmlessOk() throws {
    defer { tearDown() }
    try install()
    launchd()
    _ = retirement().retire(purgeSecrets: false)
    launchd(loaded: false)
    #expect(retirement(active: false).retire(purgeSecrets: false) == HelperCommandOutcome(.ok, detail: ["state": .string("already_retired")]))
  }

  @Test func aMoveThatFailsPutsBackWhatWasAlreadyMoved() throws {
    defer { tearDown() }
    try install()
    launchd()
    // make the 'state' directory unmovable by removing write permission on its parent (/var/db)
    let parent = prefix + "/var/db"
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: parent)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: parent) }
    let out = retirement().retire(purgeSecrets: false)
    #expect(out == HelperCommandOutcome(.failed, reason: "move_failed"))
    #expect(LegacyRetirement.artifacts.allSatisfy { exists($0.path) }, "everything is back where it was")
  }

  @Test func theTokenIsNeverInAnyOutcomeDetail() throws {
    defer { tearDown() }
    try install()
    launchd()
    let out = retirement().retire(purgeSecrets: false)
    #expect(!"\(out)".contains(Self.secret))
  }
}
