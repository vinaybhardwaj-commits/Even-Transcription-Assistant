import Foundation
import Testing

@testable import HelperCore
@testable import RoomRecorderCore

// MARK: - The pkg postinstall, dry-run

@Suite struct PostinstallScriptTests {
  static var packaging: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Packaging")
  }
  static var script: URL { packaging.appendingPathComponent("pkg-scripts/postinstall") }
  static let label = "com.evenscribe.room-recorder.helper"

  struct Sandbox {
    let base = FileManager.default.temporaryDirectory.appendingPathComponent("postinstall-\(UUID().uuidString)")
    var apps: URL { base.appendingPathComponent("Applications") }
    var app: URL { apps.appendingPathComponent("EvenScribe Room Recorder.app") }
    var bundleHelper: URL { app.appendingPathComponent("Contents/MacOS/room-recorder-helper") }
    var daemons: URL { base.appendingPathComponent("LaunchDaemons") }
    var plist: URL { daemons.appendingPathComponent("\(PostinstallScriptTests.label).plist") }
    var helperDir: URL { base.appendingPathComponent("PrivilegedHelperTools") }
    var helperCopy: URL { helperDir.appendingPathComponent(PostinstallScriptTests.label) }
    var calls: URL { base.appendingPathComponent("launchctl.calls") }
    var state: URL { base.appendingPathComponent("launchctl.state") }
    var codesignCalls: URL { base.appendingPathComponent("codesign.calls") }
    var stub: URL { base.appendingPathComponent("launchctl") }
    var codesignStub: URL { base.appendingPathComponent("codesign") }
    var sleepStub: URL { base.appendingPathComponent("sleep") }
    var sleepCalls: URL { base.appendingPathComponent("sleep.calls") }
    var installLog: URL { base.appendingPathComponent("install.log") }
    var chownStub: URL { base.appendingPathComponent("chown") }
    var chownCalls: URL { base.appendingPathComponent("chown.calls") }
    var usersDir: URL { base.appendingPathComponent("Users") }
    var pinFile: URL { base.appendingPathComponent("EvenScribe/update-pin") }

    /// `realCodesign`: do not stub codesign, so the pinned requirement is checked for real.
    /// How the fake launchd treats the job. `bootstrapFailures`: the first N bootstraps exit 5.
    /// `bootstrapSilentLosses`: the first N bootstraps exit 0 but the job is not there (the field bug).
    /// `runsAfter`: .immediately, .afterKickstart (loaded, idle until kickstarted) or .never.
    enum Runs { case immediately, afterKickstart, never }

    init(
      withHelper: Bool = true, withApp: Bool = true, bootoutFails: Bool = false, bootstrapFails: Bool = false,
      codesignFails: Bool = false, helperText: String = "#!/bin/sh\n# v1\n",
      bootstrapFailures: Int = 0, bootstrapSilentLosses: Int = 0, runsAfter: Runs = .immediately,
      preloaded: Bool = false, bootoutLingers: Int = 0
    ) throws {
      try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
      if withApp {
        try FileManager.default.createDirectory(at: bundleHelper.deletingLastPathComponent(), withIntermediateDirectories: true)
        if withHelper {
          try helperText.write(to: bundleHelper, atomically: true, encoding: .utf8)
          try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bundleHelper.path)
        }
      }
      // The launchctl stub also records what sits at the helper copy's path at each call, so a test
      // can see that the old file was running at bootout and the new one is there at bootstrap.
      let failures = bootstrapFails ? 99 : bootstrapFailures
      let runsNow = runsAfter == .immediately ? 1 : 0
      let kickRuns = runsAfter == .never ? 0 : 1
      try """
        #!/bin/sh
        echo "$@" >> '\(calls.path)'
        echo "$1 helper=$(cat '\(helperCopy.path)' 2>/dev/null | tr -d '\\n')" >> '\(state.path)'
        D='\(base.path)'
        # bootout is asynchronous: with a linger count N the job stays visible to the next N `print`s.
        linger_active() { [ -f "$D/linger" ] && [ "$(cat "$D/linger")" -gt 0 ]; }
        case "$1" in
          bootout)
            if [ \(bootoutLingers) -gt 0 ] && [ -f "$D/loaded" ]; then echo \(bootoutLingers) > "$D/linger"
            else rm -f "$D/loaded" "$D/running"; fi
            exit \(bootoutFails ? 36 : 0) ;;
          bootstrap)
            if linger_active; then exit 5; fi
            n=$(cat "$D/bootstrap.count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$D/bootstrap.count"
            if [ "$n" -le \(failures) ]; then exit 5; fi
            if [ "$n" -le \(failures + bootstrapSilentLosses) ]; then exit 0; fi
            touch "$D/loaded"; [ \(runsNow) = 1 ] && touch "$D/running"; exit 0 ;;
          kickstart) [ -f "$D/loaded" ] && [ \(kickRuns) = 1 ] && touch "$D/running"; exit 0 ;;
          print)
            if [ -f "$D/linger" ]; then
              k=$(cat "$D/linger")
              if [ "$k" -gt 0 ]; then echo $((k - 1)) > "$D/linger"; else rm -f "$D/linger" "$D/loaded" "$D/running"; fi
            fi
            [ -f "$D/loaded" ] || { echo "Could not find service" >&2; exit 113; }
            if [ -f "$D/running" ]; then echo "state = running"; else echo "state = not running"; fi
            exit 0 ;;
        esac
        exit 0
        """.write(to: stub, atomically: true, encoding: .utf8)
      try """
        #!/bin/sh
        echo "$@" >> '\(sleepCalls.path)'
        """.write(to: sleepStub, atomically: true, encoding: .utf8)
      if preloaded {
        FileManager.default.createFile(atPath: base.appendingPathComponent("loaded").path, contents: Data())
        FileManager.default.createFile(atPath: base.appendingPathComponent("running").path, contents: Data())
      }
      try """
        #!/bin/sh
        echo "$@" >> '\(codesignCalls.path)'
        exit \(codesignFails ? 3 : 0)
        """.write(to: codesignStub, atomically: true, encoding: .utf8)
      try """
        #!/bin/sh
        echo "$@" >> '\(chownCalls.path)'
        exit 0
        """.write(to: chownStub, atomically: true, encoding: .utf8)
      for url in [stub, codesignStub, chownStub, sleepStub] {
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
      }
    }

    func run(realCodesign: Bool = false, extraEnv: [String: String] = [:]) throws -> (status: Int32, output: String) {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/bin/sh")
      process.arguments = [PostinstallScriptTests.script.path, "pkg", apps.path, "/", "/"]
      var environment = [
        "ETA_POSTINSTALL_TEST": "1", "ETA_INSTALL_LOCATION": apps.path, "ETA_DAEMON_DIR": daemons.path,
        "ETA_HELPER_DIR": helperDir.path, "ETA_LAUNCHCTL": stub.path, "ETA_SKIP_OWNERSHIP": "1",
        "ETA_LOG_PATH": "/var/log/room-recorder-helper.log", "PATH": "/usr/bin:/bin",
        "ETA_USERS_DIR": usersDir.path, "ETA_CONSOLE_USER": "alice", "ETA_PIN_FILE": pinFile.path,
        "ETA_SLEEP": sleepStub.path, "ETA_INSTALL_LOG": installLog.path,
      ]
      if !realCodesign { environment["ETA_CODESIGN"] = codesignStub.path }
      process.environment = environment.merging(extraEnv) { $1 }
      let pipe = Pipe()
      process.standardOutput = pipe
      process.standardError = pipe
      try process.run()
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }

    func lines(_ url: URL) -> [String] {
      ((try? String(contentsOf: url, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
    }
    var launchctlCalls: [String] { lines(calls) }
    /// Everything but the `print` queries the verification makes.
    var actions: [String] { launchctlCalls.filter { !$0.hasPrefix("print ") } }
    func tearDown() { try? FileManager.default.removeItem(at: base) }
  }

  private func plistValue(_ path: String, _ keyPath: String) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/plutil")
    process.arguments = ["-extract", keyPath, "raw", "-o", "-", path]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return process.terminationStatus == 0
      ? String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) : nil
  }

  private func mode(_ url: URL) -> Int {
    ((try? FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.flatMap { $0 })?.intValue ?? -1
  }

  @Test func theScriptsParseUnderEveryShellAndPassShellcheck() throws {
    let scripts = [Self.script, Self.packaging.appendingPathComponent("rollback.sh")]
    for script in scripts {
      for shell in ["/bin/sh", "/bin/dash", "/bin/bash"] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-n", script.path]
        try process.run()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0, "\(shell) -n \(script.lastPathComponent)")
      }
      #expect(FileManager.default.isExecutableFile(atPath: script.path))
    }
    // shellcheck is installed on the Mini (brew); when it is, it must find nothing at all.
    for path in ["/opt/homebrew/bin/shellcheck", "/usr/local/bin/shellcheck"] where FileManager.default.isExecutableFile(atPath: path) {
      for script in scripts {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["-s", "sh", script.path]
        let pipe = Pipe()
        process.standardOutput = pipe
        try process.run()
        let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        process.waitUntilExit()
        #expect(process.terminationStatus == 0, "shellcheck \(script.lastPathComponent): \(out)")
      }
      break
    }
  }

  @Test func itCopiesTheHelperToTheRootOnlyDirectoryAndPointsTheDaemonThere() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0, "\(result.output)")
    let path = box.plist.path
    #expect(plistValue(path, "Label") == Self.label)
    #expect(plistValue(path, "Program") == box.helperCopy.path, "NOT the bundle")
    #expect(plistValue(path, "ProgramArguments.0") == box.helperCopy.path)
    #expect(!(try String(contentsOf: box.plist, encoding: .utf8)).contains(".app/"), "no path into any bundle")
    #expect(plistValue(path, "MachServices.com\\.evenscribe\\.room-recorder\\.helper\\.xpc") == "true")
    #expect(plistValue(path, "RunAtLoad") == "true" && plistValue(path, "KeepAlive") == "true")
    #expect(mode(box.plist) == 0o644)
    // The copy is the bundle's helper, byte for byte, executable, and its directory is 755.
    #expect(try Data(contentsOf: box.helperCopy) == Data(contentsOf: box.bundleHelper))
    #expect(mode(box.helperCopy) == 0o755 && mode(box.helperDir) == 0o755)
    #expect(box.actions == ["bootout system/\(Self.label)", "bootstrap system \(path)"])
    let leftovers = try FileManager.default.contentsOfDirectory(atPath: box.helperDir.path)
    #expect(leftovers == [Self.label], "no staged file left behind")
  }

  @Test func theCopyIsVerifiedAgainstThePinnedRequirementBeforeAnythingIsReplaced() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    _ = try box.run()
    let call = try #require(box.lines(box.codesignCalls).first)
    #expect(call.hasPrefix("--verify --strict -R ="))
    #expect(call.contains(HelperIdentity.requirementForHelper))
    #expect(call.contains(box.helperDir.path), "the STAGED COPY is what is verified, not the bundle's file")
  }

  @Test func aCopyThatFailsVerificationChangesNothing() throws {
    let box = try Sandbox(codesignFails: true)
    defer { box.tearDown() }
    // An earlier install is in place.
    try FileManager.default.createDirectory(at: box.helperDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: box.daemons, withIntermediateDirectories: true)
    try "OLD-HELPER".write(to: box.helperCopy, atomically: true, encoding: .utf8)
    try "OLD-PLIST".write(to: box.plist, atomically: true, encoding: .utf8)
    let result = try box.run()
    #expect(result.status == 0, "the recorder app still installs")
    #expect(result.output.contains("pinned code-signing requirement"))
    #expect(try String(contentsOf: box.helperCopy, encoding: .utf8) == "OLD-HELPER")
    #expect(try String(contentsOf: box.plist, encoding: .utf8) == "OLD-PLIST")
    #expect(box.launchctlCalls.isEmpty, "the running daemon was not even bounced")
    #expect(try FileManager.default.contentsOfDirectory(atPath: box.helperDir.path) == [Self.label])
  }

  @Test func aSameLookingButForeignHelperIsRefusedByTheRealCodesignCheck() throws {
    // No codesign stub: the real tool and the real pinned requirement. A copy of /bin/ls signed ad hoc
    // with the helper's identifier is NOT signed by our leaf, so it must not be installed.
    let box = try Sandbox()
    defer { box.tearDown() }
    try FileManager.default.removeItem(at: box.bundleHelper)
    try FileManager.default.copyItem(atPath: "/bin/ls", toPath: box.bundleHelper.path)
    for args in [["--remove-signature"], ["--force", "--sign", "-", "--identifier", HelperIdentity.helperIdentifier]] {
      let sign = Process()
      sign.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
      sign.arguments = args + [box.bundleHelper.path]
      sign.standardError = FileHandle.nullDevice
      try sign.run()
      sign.waitUntilExit()
    }
    let result = try box.run(realCodesign: true)
    #expect(result.status == 0)
    #expect(result.output.contains("pinned code-signing requirement"))
    #expect(!FileManager.default.fileExists(atPath: box.plist.path))
    #expect(!FileManager.default.fileExists(atPath: box.helperCopy.path))
    #expect(box.launchctlCalls.isEmpty)
  }

  @Test func anUpgradeBootsTheOldHelperOutBeforeTheNewCopyIsInAndBootstrapsTheNewOne() throws {
    let box = try Sandbox(helperText: "#!/bin/sh\n# v2\n")
    defer { box.tearDown() }
    try FileManager.default.createDirectory(at: box.helperDir, withIntermediateDirectories: true)
    try "#!/bin/sh\n# v1\n".write(to: box.helperCopy, atomically: true, encoding: .utf8)
    let result = try box.run()
    #expect(result.status == 0)
    let seen = box.lines(box.state)
    #expect(seen.first == "bootout helper=#!/bin/sh# v1", "the OLD helper is still there when the job is booted out")
    #expect(seen.first { $0.hasPrefix("bootstrap") } == "bootstrap helper=#!/bin/sh# v2", "the NEW helper is in place when the job is bootstrapped")
    #expect(mode(box.helperCopy) == 0o755)
  }

  @Test func theScriptsConstantsAreTheAppsConstants() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    _ = try box.run()
    let text = try String(contentsOf: box.plist, encoding: .utf8)
    #expect(text.contains("<key>\(HelperIdentity.machServiceName)</key>"))
    #expect(text.contains("<string>\(HelperIdentity.helperIdentifier)</string>"))
    #expect(box.plist.lastPathComponent == HelperIdentity.systemDaemonPlistPath.split(separator: "/").last.map(String.init))
    #expect(box.helperCopy.lastPathComponent == HelperIdentity.privilegedHelperPath.split(separator: "/").last.map(String.init))
    #expect(box.helperDir.lastPathComponent == "PrivilegedHelperTools" && HelperIdentity.privilegedHelperPath.hasPrefix("/Library/PrivilegedHelperTools/"))
    // The requirement the script enforces is the one the app enforces on the helper.
    let source = try String(contentsOf: Self.script, encoding: .utf8)
    #expect(source.contains("REQUIREMENT='\(HelperIdentity.requirementForHelper)'"))
  }

  @Test func runningItAgainIsIdempotent() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    _ = try box.run()
    let plistOnce = try Data(contentsOf: box.plist), helperOnce = try Data(contentsOf: box.helperCopy)
    let again = try box.run()
    #expect(again.status == 0)
    #expect(try Data(contentsOf: box.plist) == plistOnce && Data(contentsOf: box.helperCopy) == helperOnce)
    #expect(box.actions.count == 4)
    #expect(Array(box.actions[2...]) == Array(box.actions[..<2]), "out then in, both times")
    #expect(try FileManager.default.contentsOfDirectory(atPath: box.daemons.path) == ["\(Self.label).plist"])
    #expect(try FileManager.default.contentsOfDirectory(atPath: box.helperDir.path) == [Self.label])
  }

  @Test func aStalePlistFromAnOlderInstallIsReplaced() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    try FileManager.default.createDirectory(at: box.daemons, withIntermediateDirectories: true)
    try "stale".write(to: box.plist, atomically: true, encoding: .utf8)
    _ = try box.run()
    #expect(plistValue(box.plist.path, "Program") == box.helperCopy.path)
  }

  @Test func bootoutOfAJobThatIsNotLoadedDoesNotFailTheInstall() throws {
    let box = try Sandbox(bootoutFails: true)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0)
    #expect(box.actions.count == 2 && box.actions[1].hasPrefix("bootstrap system"))
  }

  @Test func aBootstrapThatNeverTakesFailsTheInstallLoudly() throws {
    let box = try Sandbox(bootstrapFails: true)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 1, "every try is spent and the job is not there: the installer must report it")
    #expect(result.output.contains("FAILED") && result.output.contains("NOT loaded after 4 bootstrap attempts"))
    #expect(result.output.contains("sudo launchctl bootstrap system"), "it tells the operator the one command")
    #expect(FileManager.default.fileExists(atPath: box.plist.path) && FileManager.default.fileExists(atPath: box.helperCopy.path))
  }

  @Test func noHelperBinaryMeansNoDaemon() throws {
    let box = try Sandbox(withHelper: false)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0)
    #expect(!FileManager.default.fileExists(atPath: box.plist.path) && !FileManager.default.fileExists(atPath: box.helperDir.path))
    #expect(box.launchctlCalls.isEmpty)
  }

  @Test func noAppMeansTheInstallFails() throws {
    let box = try Sandbox(withApp: false)
    defer { box.tearDown() }
    #expect(try box.run().status == 1)
    #expect(box.launchctlCalls.isEmpty)
  }

  // ─── 0.1.34: after bootstrap the job is ASKED FOR, retried once, and the result logged ─────────

  @Test func aHealthyInstallIsVerifiedByNameAndLogged() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0 && result.output.contains("VERIFIED: \(Self.label) is running"))
    #expect(box.launchctlCalls.contains("print system/\(Self.label)"))
    #expect(box.actions.filter { $0.hasPrefix("bootstrap") }.count == 1, "no retry when it took the first time")
    #expect(!box.launchctlCalls.contains { $0.hasPrefix("kickstart") })
    let log = try String(contentsOf: box.installLog, encoding: .utf8)
    #expect(log.contains("bootstrap system") && log.contains("VERIFIED"), "\(log)")
    #expect(log.split(separator: "\n").allSatisfy { $0.contains("room-recorder postinstall:") })
  }

  @Test func aBootstrapThatReturnsZeroButLeavesNoJobIsRetried_theFieldBug() throws {
    // OPD 5 and OPD 6 on 0.1.33: the job was gone right after the install.
    let box = try Sandbox(bootstrapSilentLosses: 1)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0)
    #expect(box.actions.filter { $0.hasPrefix("bootstrap") }.count == 2)
    #expect(result.output.contains("is not (re)loaded; retry 1 of 3 in 2 s"))
    #expect(result.output.contains("VERIFIED"))
    #expect(box.lines(box.sleepCalls) == ["2"], "a 2 s gap before the retry")
  }

  @Test func aBootstrapThatFailsOnceIsRetriedOnceAndThenTakes() throws {
    let box = try Sandbox(bootstrapFailures: 1)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0 && result.output.contains("VERIFIED"))
    #expect(box.actions.filter { $0.hasPrefix("bootstrap") }.count == 2)
    #expect(result.output.contains("failed"))
  }

  @Test func neverMoreThanFourBootstrapsAndNeverAKickstartOfAJobThatIsNotLoaded() throws {
    let box = try Sandbox(bootstrapFailures: 9)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 1)
    #expect(box.actions.filter { $0.hasPrefix("bootstrap") }.count == 4, "one try plus three retries, no more")
    #expect(box.lines(box.sleepCalls) == ["2", "2", "2"], "2 s between tries")
    #expect(!box.launchctlCalls.contains { $0.hasPrefix("kickstart") })
    #expect(result.output.contains("FAILED: \(Self.label) is NOT loaded"))
  }

  @Test func aJobLoadedButNotRunningIsKickstartedWithoutDashK() throws {
    let box = try Sandbox(runsAfter: .afterKickstart)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0 && result.output.contains("VERIFIED"))
    let kicks = box.launchctlCalls.filter { $0.hasPrefix("kickstart") }
    #expect(kicks == ["kickstart system/\(Self.label)"], "exactly one, and no -k")
    #expect(box.actions.filter { $0.hasPrefix("bootstrap") }.count == 1, "loaded, so no second bootstrap")
  }

  @Test func aJobThatNeverRunsIsReportedNotHidden() throws {
    let box = try Sandbox(runsAfter: .never)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 1, "loaded but never running after the kickstart: the installer must report it")
    #expect(result.output.contains("FAILED") && result.output.contains("loaded but NOT running after kickstart"))
    #expect(!result.output.contains("VERIFIED"))
    #expect(box.launchctlCalls.filter { $0.hasPrefix("kickstart") }.count == 1, "one kickstart, no loop")
    let log = try String(contentsOf: box.installLog, encoding: .utf8)
    #expect(log.contains("NOT running"))
  }

  // ─── 0.1.34 R2: bootout is asynchronous; wait for it, retry up to three times, fail only if all fail ───

  @Test func aBootoutThatLingersTwoPollsIsWaitedOutBeforeTheFirstBootstrap() throws {
    let box = try Sandbox(preloaded: true, bootoutLingers: 2)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0 && result.output.contains("VERIFIED"))
    #expect(result.output.contains("bootout complete: \(Self.label) gone after 2 s"))
    #expect(box.lines(box.sleepCalls) == ["1", "1"], "one second per poll, two polls")
    #expect(box.actions.filter { $0.hasPrefix("bootstrap") }.count == 1, "no bootstrap was fired into a job that was still being removed")
    #expect(box.actions.first == "bootout system/\(Self.label)")
  }

  @Test func withoutTheWaitAFreshBootstrapWouldHaveBeenRefusedInProgress() throws {
    // The stub refuses a bootstrap while the old job is still lingering, as launchd does. The script must
    // therefore have polled first; this pins that the order bootout -> print... -> bootstrap holds.
    let box = try Sandbox(preloaded: true, bootoutLingers: 3)
    defer { box.tearDown() }
    _ = try box.run()
    let lines = box.launchctlCalls
    let firstBootstrap = try #require(lines.firstIndex { $0.hasPrefix("bootstrap") })
    let prints = lines[..<firstBootstrap].filter { $0.hasPrefix("print ") }.count
    #expect(prints >= 4, "three lingering polls plus the one that found it gone: \(lines)")
  }

  @Test func aBootoutThatNeverFinishesIsWaitedForTenSecondsThenTheScriptCarriesOn() throws {
    let box = try Sandbox(preloaded: true, bootoutLingers: 99)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(box.lines(box.sleepCalls).filter { $0 == "1" }.count >= 10)
    #expect(result.output.contains("is still loaded 10 s after bootout; continuing anyway"))
    #expect(box.actions.filter { $0.hasPrefix("bootstrap") }.count == 4, "it still tries, with the retries")
    // The old job is what is running: say so, do not call it verified.
    #expect(result.status == 0 && !result.output.contains("VERIFIED") && result.output.contains("PREVIOUS definition"))
  }

  @Test func threeFailuresThenSuccessTakesOnTheFourthTry() throws {
    let box = try Sandbox(bootstrapFailures: 3)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0 && result.output.contains("VERIFIED") && result.output.contains("bootstrap attempts: 4"))
    #expect(box.actions.filter { $0.hasPrefix("bootstrap") }.count == 4)
    #expect(box.lines(box.sleepCalls) == ["2", "2", "2"])
  }

  @Test func theFieldBugNeedingMoreThanOneRetryIsStillRecovered() throws {
    let box = try Sandbox(bootstrapSilentLosses: 2)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0 && result.output.contains("VERIFIED"))
    #expect(box.actions.filter { $0.hasPrefix("bootstrap") }.count == 3)
  }

  @Test func silentLossOnEveryTryFailsTheInstallAfterExactlyFourAttempts() throws {
    let box = try Sandbox(bootstrapSilentLosses: 9)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 1 && result.output.contains("FAILED"))
    #expect(box.actions.filter { $0.hasPrefix("bootstrap") }.count == 4)
  }

  @Test func theNonZeroExitLeavesTheFilesInPlaceAndSaysTheOneCommand() throws {
    let box = try Sandbox(bootstrapFails: true)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 1)
    #expect(FileManager.default.fileExists(atPath: box.plist.path) && FileManager.default.fileExists(atPath: box.helperCopy.path))
    #expect(result.output.contains("Retry: sudo launchctl bootstrap system \(box.plist.path)"))
    let log = try String(contentsOf: box.installLog, encoding: .utf8)
    #expect(log.contains("FAILED"), "the install log carries it too")
  }

  @Test func aNonZeroExitIsOnlyEverTheDaemonStepsOrAMissingApp() throws {
    // A helper that cannot be installed for its own reasons changes nothing and does NOT fail the install.
    let noHelper = try Sandbox(withHelper: false)
    defer { noHelper.tearDown() }
    #expect(try noHelper.run().status == 0)
    let badCopy = try Sandbox(codesignFails: true)
    defer { badCopy.tearDown() }
    #expect(try badCopy.run().status == 0)
  }

  @Test func noKickstartDashKAnywhereInTheScript() throws {
    let source = try String(contentsOf: Self.script, encoding: .utf8)
    #expect(!source.contains("kickstart -k"), "-k would kill a running job, and must never touch the app's agent")
    #expect(!source.contains("gui/"), "the script never touches a user's agent domain")
  }

  // ─── 0.1.33: the app bundle belongs to the room user; only the helper side is root ─────────────

  /// Runs with ownership ON and chown replaced by a recorder, since a test cannot become root.
  private func runOwning(_ box: Sandbox, extra: [String: String] = [:]) throws -> (status: Int32, output: String) {
    try box.run(extraEnv: ["ETA_SKIP_OWNERSHIP": "0", "ETA_CHOWN": box.chownStub.path].merging(extra) { $1 })
  }

  @Test func theBundleIsHandedToTheConsoleUserAndNeverToRoot() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    let result = try runOwning(box)
    #expect(result.status == 0, "\(result.output)")
    let chowns = box.lines(box.chownCalls)
    #expect(chowns.contains("-R alice:staff \(box.app.path)"), "\(chowns)")
    #expect(!chowns.contains { $0.contains("root:wheel") && $0.contains(box.app.path) }, "no root ownership of the bundle")
    #expect(!chowns.contains { $0.hasPrefix("-R root") }, "nothing is chowned to root recursively any more")
  }

  @Test func theHelperCopyItsDirectoryAndThePlistStayRootWheel() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    _ = try runOwning(box)
    let chowns = box.lines(box.chownCalls)
    #expect(chowns.contains("root:wheel \(box.helperDir.path)"))
    #expect(chowns.contains { $0.hasPrefix("root:wheel \(box.helperCopy.path).new.") }, "the staged copy, before it is moved in")
    #expect(chowns.contains { $0.hasPrefix("root:wheel \(box.plist.path).tmp.") })
    // and the installed layout is the 0.1.32 one
    #expect(plistValue(box.plist.path, "Program") == box.helperCopy.path)
    #expect(mode(box.helperCopy) == 0o755 && mode(box.helperDir) == 0o755 && mode(box.plist) == 0o644)
    #expect(box.actions == ["bootout system/\(Self.label)", "bootstrap system \(box.plist.path)"])
  }

  @Test func theBundleStaysWritableByItsOwnerAndNotByOthers() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: box.app.path)  // as a root-owned install leaves it
    try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: box.bundleHelper.path)
    _ = try runOwning(box)
    #expect(mode(box.app) & 0o200 != 0 && mode(box.bundleHelper) & 0o200 != 0, "the owner can write")
    #expect(mode(box.app) & 0o022 == 0 && mode(box.bundleHelper) & 0o022 == 0, "group and others cannot")
  }

  @Test func atTheLoginWindowTheUserWhoHasTheRecordersAgentIsTheRoomUser() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    let agents = box.usersDir.appendingPathComponent("alice/Library/LaunchAgents")
    try FileManager.default.createDirectory(at: agents, withIntermediateDirectories: true)
    try "x".write(to: agents.appendingPathComponent("com.evenscribe.room-recorder.plist"), atomically: true, encoding: .utf8)
    let me = NSUserName()
    let result = try runOwning(box, extra: ["ETA_CONSOLE_USER": "loginwindow"])
    #expect(result.status == 0)
    #expect(box.lines(box.chownCalls).contains { $0.hasPrefix("-R \(me):") && $0.hasSuffix(box.app.path) }, "\(box.lines(box.chownCalls))")
  }

  @Test func ifNoSingleRoomUserCanBeFoundTheBundleOwnershipIsLeftAloneAndSaidSo() throws {
    for agentCount in [0, 2] {
      let box = try Sandbox()
      defer { box.tearDown() }
      for index in 0..<agentCount {
        let agents = box.usersDir.appendingPathComponent("user\(index)/Library/LaunchAgents")
        try FileManager.default.createDirectory(at: agents, withIntermediateDirectories: true)
        try "x".write(to: agents.appendingPathComponent("com.evenscribe.room-recorder.plist"), atomically: true, encoding: .utf8)
      }
      let result = try runOwning(box, extra: ["ETA_CONSOLE_USER": "root"])
      #expect(result.status == 0)
      #expect(result.output.contains("could not tell which user runs the recorder"))
      #expect(!box.lines(box.chownCalls).contains { $0.contains(box.app.path) }, "agents: \(agentCount)")
      #expect(box.actions.count == 2, "the helper side still installs")
    }
  }

  @Test func aRootOwnedPreviousAndFailedLeftByAnEarlierSwapAreRemoved() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    let previous = URL(fileURLWithPath: box.app.path + ".previous"), failed = URL(fileURLWithPath: box.app.path + ".failed")
    for aside in [previous, failed] {
      try FileManager.default.createDirectory(at: aside.appendingPathComponent("Contents"), withIntermediateDirectories: true)
      try "old".write(to: aside.appendingPathComponent("Contents/f"), atomically: true, encoding: .utf8)
    }
    // "Root" is this test's own uid, the only owner a test can create.
    let result = try runOwning(box, extra: ["ETA_ROOT_UID": String(getuid())])
    #expect(result.status == 0)
    #expect(!FileManager.default.fileExists(atPath: previous.path) && !FileManager.default.fileExists(atPath: failed.path))
    #expect(result.output.contains("removed the root-owned"))
    #expect(FileManager.default.fileExists(atPath: box.app.path), "the app itself is untouched")
  }

  @Test func aPreviousTheRoomUserOwnsIsLeftForTheUpdaterToHandle() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    let previous = URL(fileURLWithPath: box.app.path + ".previous")
    try FileManager.default.createDirectory(at: previous.appendingPathComponent("Contents"), withIntermediateDirectories: true)
    _ = try runOwning(box)  // ROOT_UID stays 0, and this test's files are not owned by uid 0
    #expect(FileManager.default.fileExists(atPath: previous.path), "the rollback copy a normal swap keeps is not destroyed")
  }

  @Test func reinstallingOverARootOwnedBundleReownsItEveryTime() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    _ = try runOwning(box)
    _ = try runOwning(box)
    let owned = box.lines(box.chownCalls).filter { $0 == "-R alice:staff \(box.app.path)" }
    #expect(owned.count == 2)
    #expect(try FileManager.default.contentsOfDirectory(atPath: box.helperDir.path) == [Self.label])
  }

  // ─── 0.1.34: a pkg install ends a rollback pin ───────────────────────────────────────────────────

  @Test func aPkgInstallRemovesTheUpdatePin() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    try FileManager.default.createDirectory(at: box.pinFile.deletingLastPathComponent(), withIntermediateDirectories: true)
    try "0.1.31\n".write(to: box.pinFile, atomically: true, encoding: .utf8)
    let result = try box.run()
    #expect(result.status == 0)
    #expect(!FileManager.default.fileExists(atPath: box.pinFile.path))
    #expect(result.output.contains("removed the update pin"))
    #expect(FileManager.default.fileExists(atPath: box.plist.path), "the rest of the install still ran")
  }

  @Test func noPinMeansNothingIsSaidOrDone() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0 && !result.output.contains("update pin"))
  }

  @Test func thePinGoesEvenWhenThereIsNoHelperToInstall() throws {
    let box = try Sandbox(withHelper: false)
    defer { box.tearDown() }
    try FileManager.default.createDirectory(at: box.pinFile.deletingLastPathComponent(), withIntermediateDirectories: true)
    try "0.1.31".write(to: box.pinFile, atomically: true, encoding: .utf8)
    _ = try box.run()
    #expect(!FileManager.default.fileExists(atPath: box.pinFile.path))
  }

  @Test func aMissingAppLeavesThePinAlone() throws {
    let box = try Sandbox(withApp: false)
    defer { box.tearDown() }
    try FileManager.default.createDirectory(at: box.pinFile.deletingLastPathComponent(), withIntermediateDirectories: true)
    try "0.1.31".write(to: box.pinFile, atomically: true, encoding: .utf8)
    #expect(try box.run().status == 1)
    #expect(FileManager.default.fileExists(atPath: box.pinFile.path), "a failed install does not lift a rollback")
  }

  @Test func theBundleIsMadeNonWritableForGroupAndOthers() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    try FileManager.default.setAttributes([.posixPermissions: 0o777], ofItemAtPath: box.bundleHelper.path)
    _ = try box.run()
    #expect(mode(box.bundleHelper) & 0o022 == 0)
  }

  @Test func theTestOverridesAreIgnoredUnlessTheTestFlagIsSet() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = [Self.script.path, "pkg", "/nonexistent-\(UUID().uuidString)"]
    process.environment = [
      "ETA_LAUNCHCTL": box.stub.path, "ETA_DAEMON_DIR": box.daemons.path, "ETA_HELPER_DIR": box.helperDir.path,
      "ETA_CODESIGN": box.codesignStub.path, "ETA_SKIP_OWNERSHIP": "1", "PATH": "/usr/bin:/bin",
    ]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    #expect(process.terminationStatus == 1)
    #expect(box.launchctlCalls.isEmpty && !FileManager.default.fileExists(atPath: box.plist.path))
    #expect(!FileManager.default.fileExists(atPath: box.helperDir.path))
  }
}

// MARK: - Rollback to an older pkg (B2), dry-run

@Suite struct RollbackScriptTests {
  static var script: URL { PostinstallScriptTests.packaging.appendingPathComponent("rollback.sh") }
  static let label = "com.evenscribe.room-recorder.helper"

  struct Sandbox {
    let base = FileManager.default.temporaryDirectory.appendingPathComponent("rollback-\(UUID().uuidString)")
    var app: URL { base.appendingPathComponent("Applications/EvenScribe Room Recorder.app") }
    var saved: URL { URL(fileURLWithPath: app.path + ".rollback-saved") }
    var daemons: URL { base.appendingPathComponent("LaunchDaemons") }
    var plist: URL { daemons.appendingPathComponent("\(RollbackScriptTests.label).plist") }
    var helperDir: URL { base.appendingPathComponent("PrivilegedHelperTools") }
    var helperCopy: URL { helperDir.appendingPathComponent(RollbackScriptTests.label) }
    var agentPlist: URL { base.appendingPathComponent("agent.plist") }
    var log: URL { base.appendingPathComponent("calls.log") }
    var pkg: URL { base.appendingPathComponent("older.pkg") }
    var pinFile: URL { base.appendingPathComponent("EvenScribe/update-pin") }
    var chownCalls: URL { base.appendingPathComponent("chown.calls") }

    /// `installedVersion`: what the "older pkg" lays down in the app's Info.plist (nil: it lays down none).
    init(installerFails: Bool = false, withAgent: Bool = true, installedVersion: String? = "0.1.31") throws {
      let fm = FileManager.default
      try fm.createDirectory(at: app.appendingPathComponent("Contents"), withIntermediateDirectories: true)
      try "NEWER".write(to: app.appendingPathComponent("Contents/marker"), atomically: true, encoding: .utf8)
      try fm.createDirectory(at: daemons, withIntermediateDirectories: true)
      try fm.createDirectory(at: helperDir, withIntermediateDirectories: true)
      try "plist".write(to: plist, atomically: true, encoding: .utf8)
      try "helper".write(to: helperCopy, atomically: true, encoding: .utf8)
      if withAgent { try "agent".write(to: agentPlist, atomically: true, encoding: .utf8) }
      try "pkg".write(to: pkg, atomically: true, encoding: .utf8)
      for (name, body) in [
        ("launchctl", "echo \"launchctl $*\" >> '\(log.path)'"),
        ("pkgutil", "echo \"pkgutil $*\" >> '\(log.path)'"),
        // The installer stub records whether the NEWER app is still on disk when it runs: it must not be.
        ("chown", "echo \"$@\" >> '\(chownCalls.path)'"),
        ("installer", "echo \"installer $* app_present=$([ -e '\(app.path)' ] && echo yes || echo no) daemon_plist=$([ -e '\(plist.path)' ] && echo yes || echo no) helper_copy=$([ -e '\(helperCopy.path)' ] && echo yes || echo no) pin_present=$([ -e '\(pinFile.path)' ] && echo yes || echo no)\" >> '\(log.path)'\n\(installerFails || installedVersion == nil ? "" : "mkdir -p '\(app.path)/Contents' && /usr/bin/plutil -create xml1 '\(app.path)/Contents/Info.plist' && /usr/bin/plutil -replace CFBundleShortVersionString -string '\(installedVersion!)' '\(app.path)/Contents/Info.plist'")\nexit \(installerFails ? 1 : 0)"),
      ] {
        let url = base.appendingPathComponent(name)
        try "#!/bin/sh\n\(body)\n".write(to: url, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
      }
    }

    func run(arguments: [String]? = nil) throws -> (status: Int32, output: String) {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/bin/sh")
      process.arguments = [RollbackScriptTests.script.path] + (arguments ?? [pkg.path])
      process.environment = [
        "ETA_ROLLBACK_TEST": "1", "ETA_APP": app.path, "ETA_DAEMON_DIR": daemons.path, "ETA_HELPER_DIR": helperDir.path,
        "ETA_LAUNCHCTL": base.appendingPathComponent("launchctl").path, "ETA_INSTALLER": base.appendingPathComponent("installer").path,
        "ETA_PKGUTIL": base.appendingPathComponent("pkgutil").path, "ETA_CONSOLE_UID": "501",
        "ETA_AGENT_PLIST": agentPlist.path, "ETA_PIN_FILE": pinFile.path,
        "ETA_CHOWN": base.appendingPathComponent("chown").path, "PATH": "/usr/bin:/bin",
      ]
      let pipe = Pipe()
      process.standardOutput = pipe
      process.standardError = pipe
      try process.run()
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }

    var calls: [String] {
      ((try? String(contentsOf: log, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
    }
    func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }
    func tearDown() { try? FileManager.default.removeItem(at: base) }
  }

  @Test func theNewerAppIsGoneBeforeTheOlderPkgIsInstalled() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0, "\(result.output)")
    let calls = box.calls
    #expect(calls == [
      "launchctl bootout gui/501/com.evenscribe.room-recorder",
      "launchctl bootout system/\(Self.label)",
      "pkgutil --forget com.evenscribe.room-recorder.pkg",
      "installer -pkg \(box.pkg.path) -target / app_present=no daemon_plist=no helper_copy=no pin_present=no",
      "launchctl bootstrap gui/501 \(box.agentPlist.path)",
    ], "order matters: this is the whole point of the script")
    // The "older pkg" has laid its own app down; the NEWER one (its marker file) is gone, and so is the saved copy.
    #expect(box.exists(box.app) && !box.exists(box.app.appendingPathComponent("Contents/marker")))
    #expect(!box.exists(box.saved) && !box.exists(box.plist) && !box.exists(box.helperCopy))
  }

  @Test func aFailedOlderInstallPutsTheNewerAppBackSoTheRoomIsNeverWithoutOne() throws {
    let box = try Sandbox(installerFails: true)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 1)
    #expect(box.exists(box.app) && !box.exists(box.saved))
    #expect(try String(contentsOf: box.app.appendingPathComponent("Contents/marker"), encoding: .utf8) == "NEWER")
    #expect(result.output.contains("WITHOUT the root helper"))
    #expect(box.calls.last == "launchctl bootstrap gui/501 \(box.agentPlist.path)", "the agent is started again")
  }

  // ─── 0.1.34: the rollback pin ───────────────────────────────────────────────────────────────────

  @Test func aSuccessfulRollbackPinsTheInstalledVersionAsRoot() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0, "\(result.output)")
    #expect(try String(contentsOf: box.pinFile, encoding: .utf8) == "0.1.31\n")
    let mode = (try FileManager.default.attributesOfItem(atPath: box.pinFile.path)[.posixPermissions] as? NSNumber)?.intValue
    #expect(mode == 0o644)
    let chowns = try String(contentsOf: box.chownCalls, encoding: .utf8).split(separator: "\n").map(String.init)
    #expect(chowns.count == 1 && chowns[0].hasPrefix("root:wheel ") && chowns[0].contains("update-pin"), "\(chowns)")
    #expect(result.output.contains("pinned at 0.1.31"))
    #expect(try FileManager.default.contentsOfDirectory(atPath: box.pinFile.deletingLastPathComponent().path) == ["update-pin"], "no temp file left")
  }

  @Test func theRollbackPinsTheVersionTheOlderPkgLaidDownWhateverThatIs() throws {
    let box = try Sandbox(installedVersion: "0.1.29")
    defer { box.tearDown() }
    _ = try box.run()
    #expect(try String(contentsOf: box.pinFile, encoding: .utf8) == "0.1.29\n")
  }

  @Test func theInstallerRunsBeforeThePinIsWritten() throws {
    // A pkg that itself clears the pin (0.1.34 and later) must not undo the pin the rollback then sets.
    let box = try Sandbox()
    defer { box.tearDown() }
    try FileManager.default.createDirectory(at: box.pinFile.deletingLastPathComponent(), withIntermediateDirectories: true)
    try "0.1.99\n".write(to: box.pinFile, atomically: true, encoding: .utf8)
    _ = try box.run()
    #expect(box.calls.contains { $0.contains("pin_present=yes") }, "the old pin was still there when the installer ran")
    #expect(try String(contentsOf: box.pinFile, encoding: .utf8) == "0.1.31\n", "and is replaced afterwards")
  }

  @Test func aFailedRollbackWritesNoPinAndLeavesAnExistingOne() throws {
    let box = try Sandbox(installerFails: true)
    defer { box.tearDown() }
    #expect(try box.run().status == 1)
    #expect(!FileManager.default.fileExists(atPath: box.pinFile.path))
    let box2 = try Sandbox(installerFails: true)
    defer { box2.tearDown() }
    try FileManager.default.createDirectory(at: box2.pinFile.deletingLastPathComponent(), withIntermediateDirectories: true)
    try "0.1.30\n".write(to: box2.pinFile, atomically: true, encoding: .utf8)
    #expect(try box2.run().status == 1)
    #expect(try String(contentsOf: box2.pinFile, encoding: .utf8) == "0.1.30\n")
  }

  @Test func ifTheInstalledVersionCannotBeReadNoPinIsWrittenAndItSaysSo() throws {
    let box = try Sandbox(installedVersion: nil)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0 && result.output.contains("NO pin was written"))
    #expect(!FileManager.default.fileExists(atPath: box.pinFile.path))
  }

  @Test func theVersionIsReducedToVersionCharactersBeforeItIsWritten() throws {
    let box = try Sandbox(installedVersion: "0.1.31; rm -rf /")
    defer { box.tearDown() }
    _ = try box.run()
    let text = try String(contentsOf: box.pinFile, encoding: .utf8)
    #expect(text == "0.1.31rm-rf\n" || text.allSatisfy { $0.isLetter || $0.isNumber || ".-_+\n".contains($0) }, "\(text)")
  }

  @Test func noAgentPlistMeansItSaysWhatToDoInsteadOfGuessing() throws {
    let box = try Sandbox(withAgent: false)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0 && result.output.contains("install-launch-agent"))
    #expect(!box.calls.contains { $0.contains("bootstrap gui") })
  }

  @Test func itRefusesWithoutAPkgAndTouchesNothing() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    #expect(try box.run(arguments: []).status == 1)
    #expect(try box.run(arguments: ["/nonexistent.pkg"]).status == 1)
    #expect(box.calls.isEmpty && box.exists(box.app) && box.exists(box.plist) && box.exists(box.helperCopy))
  }

  @Test func itRefusesToRunOverAnEarlierSavedApp() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    try FileManager.default.createDirectory(at: box.saved, withIntermediateDirectories: true)
    #expect(try box.run().status == 1)
    #expect(box.calls.isEmpty && box.exists(box.app))
  }

  @Test func withoutTheTestFlagItWantsRoot() throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = [Self.script.path, "/tmp/x.pkg"]
    process.environment = ["PATH": "/usr/bin:/bin"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    try process.run()
    let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    process.waitUntilExit()
    if getuid() != 0 {
      #expect(process.terminationStatus == 1 && out.contains("as root"))
    }
  }
}

// MARK: - The app's view of the helper: launchd, smappservice, none

@Suite struct HelperModeProbeTests {
  final class Fake: HelperDaemonService, @unchecked Sendable {
    var status: String
    var registerCalls = 0
    var unregisterCalls = 0
    var failure: Error?
    var unregisterFailure: Error?
    init(_ status: String, failure: Error? = nil) { self.status = status; self.failure = failure }
    var registrationName: String { status }
    func register() throws {
      registerCalls += 1
      if let failure { throw failure }
      status = "enabled"
    }
    func unregister() throws {
      unregisterCalls += 1
      if let unregisterFailure { throw unregisterFailure }
      status = "notRegistered"
    }
  }
  static func hello(ok: Bool) -> () -> HelperResponse? {
    { ok ? HelperResponse(ok: true, code: "ok", detail: ["helper_version": "0.2.0-h2"]) : nil }
  }

  private func probe(plist: Bool, _ service: Fake, hello: @escaping () -> HelperResponse?, state: inout HelperRegistrationState)
    -> HelperBootstrap.Probe
  {
    HelperBootstrap.probe(
      systemPlistExists: { plist }, service: service, hello: hello, openSettings: {}, state: &state, log: { _ in })
  }

  @Test func aLoadedLaunchdJobThatAnswersIsEnabledInLaunchdMode() {
    let service = Fake("notFound")
    var state = HelperRegistrationState()
    let result = probe(plist: true, service, hello: Self.hello(ok: true), state: &state)
    #expect(result.mode == "launchd" && result.registration == "enabled" && result.xpcOK == true)
    #expect(result.helperVersion == "0.2.0-h2")
  }

  @Test func registerIsNeverCalledWhileTheLaunchdJobIsPresent() {
    for status in ["notFound", "notRegistered", "enabled", "requiresApproval"] {
      let service = Fake(status)
      var state = HelperRegistrationState()
      for _ in 0..<5 { _ = probe(plist: true, service, hello: Self.hello(ok: true), state: &state) }
      #expect(service.registerCalls == 0, "\(status): two registrations of one Mach service would fight")
      #expect(state.attempts == 0)
    }
  }

  @Test func aLaunchdJobThatDoesNotAnswerIsReportedNotHidden() {
    let service = Fake("notFound")
    var state = HelperRegistrationState()
    let result = probe(plist: true, service, hello: Self.hello(ok: false), state: &state)
    #expect(result.mode == "launchd" && result.registration == "notAnswering" && result.xpcOK == false)
    #expect(service.registerCalls == 0)
  }

  @Test func withoutTheSystemPlistTheSMAppServicePathRunsAsBefore() {
    let service = Fake("notRegistered")
    var state = HelperRegistrationState()
    let result = probe(plist: false, service, hello: Self.hello(ok: true), state: &state)
    #expect(result.mode == "smappservice" && result.registration == "enabled")
    #expect(service.registerCalls == 1)
  }

  @Test func approvalPendingIsSMAppServiceMode() {
    let service = Fake("requiresApproval")
    var state = HelperRegistrationState()
    let result = probe(plist: false, service, hello: Self.hello(ok: false), state: &state)
    #expect(result.mode == "smappservice" && result.registration == "requiresApproval")
  }

  @Test func neitherMeansNoneAndKeepsTheError() {
    let refusal = NSError(domain: "D", code: 7, userInfo: [NSLocalizedDescriptionKey: "no"])
    let service = Fake("notFound", failure: refusal)
    var state = HelperRegistrationState()
    let result = probe(plist: false, service, hello: Self.hello(ok: false), state: &state)
    #expect(result.mode == "none" && result.registration == "notFound")
    #expect(result.error == "domain=D code=7: no")
  }

  @Test func modeReachesStatusJSONAndTheBenchRow() throws {
    let status = RoomRecorderStatus(state: .ready, helperRegistration: "enabled", helperMode: "launchd")
    let object = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(status)) as? [String: Any])
    #expect(object["helper_mode"] as? String == "launchd" && object["helper_registration"] as? String == "enabled")
    var fields = InstallPollFields(installID: "i", tapeAdvancing: true)
    #expect(!fields.queryItems().map(\.name).contains("helper_mode"))
    fields.helperMode = "launchd"
    fields.helperRegistration = "enabled"
    let items = Dictionary(uniqueKeysWithValues: fields.queryItems().map { ($0.name, $0.value ?? "") })
    #expect(items["helper_mode"] == "launchd" && items["helper_registration"] == "enabled")
    let old = try JSONEncoder().encode(RoomRecorderStatus(state: .ready))
    #expect(try JSONDecoder().decode(RoomRecorderStatus.self, from: old).helperMode == nil)
  }
}

// MARK: - Launchd mode touches SMAppService not at all (0.1.34)

/// Counts EVERY touch: a status read, register, and unregister.
final class StrictService: HelperDaemonService, @unchecked Sendable {
  var statusReads = 0, registerCalls = 0, unregisterCalls = 0
  let status: String
  init(_ status: String) { self.status = status }
  var registrationName: String { statusReads += 1; return status }
  func register() throws { registerCalls += 1 }
  /// Not part of the protocol any more; kept here so a mutant that re-adds the call is counted.
  func unregister() throws { unregisterCalls += 1 }
  var touches: Int { statusReads + registerCalls + unregisterCalls }
}

@Suite struct LaunchdModeTouchesNoSMAppServiceTests {
  @Test func everyStatusInLaunchdModeMakesZeroCalls() {
    // 0.1.33 called unregister() here and launchd removed the system job ("removing service: ...").
    for status in ["enabled", "requiresApproval", "notRegistered", "notFound"] {
      let service = StrictService(status)
      var state = HelperRegistrationState()
      var logs: [String] = []
      for answering in [true, false, true] {
        let result = HelperBootstrap.probe(
          systemPlistExists: { true }, service: service, hello: HelperModeProbeTests.hello(ok: answering),
          openSettings: {}, state: &state, log: { logs.append($0) })
        #expect(result.mode == "launchd" && result.registration == (answering ? "enabled" : "notAnswering"))
        #expect(result.error == nil)
      }
      #expect(service.touches == 0, "\(status): status reads \(service.statusReads), register \(service.registerCalls), unregister \(service.unregisterCalls)")
      #expect(logs.isEmpty, "and nothing about SMAppService is logged either")
    }
  }

  @Test func theStateHasNoUnregisterBookkeepingLeft() {
    #expect(HelperRegistrationState() == HelperRegistrationState())
    #expect(HelperRegistrationState.maxAttempts == 2)
  }

  @Test func theSourceNeverNamesUnregisterOutsideItsExplanation() throws {
    let source = try String(
      contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Sources/RoomRecorderCore/HelperBootstrap.swift"), encoding: .utf8)
    let code = source.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
    #expect(!code.contains { $0.contains("unregister") }, "no code line calls or declares unregister")
  }

  @Test func theSMAppServicePathStillRegistersWhenThereIsNoSystemPlist() {
    let service = StrictService("notRegistered")
    var state = HelperRegistrationState()
    _ = HelperBootstrap.probe(
      systemPlistExists: { false }, service: service, hello: HelperModeProbeTests.hello(ok: true),
      openSettings: {}, state: &state, log: { _ in })
    #expect(service.registerCalls == 1 && service.unregisterCalls == 0)
  }
}

// MARK: - status.json carries what FLEET asked for (0.1.34)

@Suite struct StatusJSONHelperFieldsTests {
  @Test func xpcOkAndVersionAreInStatusJSONWithTheNamesFLEETReads() throws {
    let status = RoomRecorderStatus(
      state: .ready, helperRegistration: "enabled", helperMode: "launchd", helperXPCOK: true, helperVersion: "0.2.0-h2")
    let object = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(status)) as? [String: Any])
    #expect(object["helper_xpc_ok"] as? Bool == true)
    #expect(object["helper_version"] as? String == "0.2.0-h2")
    #expect(object["helper_mode"] as? String == "launchd" && object["helper_registration"] as? String == "enabled")
  }

  @Test func aSilentHelperIsFalseNotAbsent() throws {
    let status = RoomRecorderStatus(state: .ready, helperRegistration: "notAnswering", helperMode: "launchd", helperXPCOK: false)
    let object = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(status)) as? [String: Any])
    #expect(object["helper_xpc_ok"] as? Bool == false, "false is a fact FLEET needs; it must not vanish")
    #expect(object["helper_version"] == nil)
  }

  @Test func unmeasuredIsAbsentAndOldFilesStillDecode() throws {
    let object = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(RoomRecorderStatus(state: .ready))) as? [String: Any])
    #expect(object["helper_xpc_ok"] == nil && object["helper_version"] == nil)
    let back = try JSONDecoder().decode(RoomRecorderStatus.self, from: JSONEncoder().encode(RoomRecorderStatus(state: .ready, helperXPCOK: true, helperVersion: "1")))
    #expect(back.helperXPCOK == true && back.helperVersion == "1")
  }

  @Test func theEngineWritesThemFromTheProbe() throws {
    // The cache the engine reads is the cache the probe fills.
    HelperStatusCache.shared.set(HelperSnapshot(registration: "enabled", helperVersion: "0.2.0-h2", xpcOK: true, mode: "launchd"), error: nil)
    defer { HelperStatusCache.shared.set(nil) }
    let snapshot = try #require(HelperStatusCache.shared.snapshot)
    let status = RoomRecorderStatus(
      state: .ready, helperRegistration: snapshot.registration, helperMode: snapshot.mode, helperXPCOK: snapshot.xpcOK,
      helperVersion: snapshot.helperVersion)
    #expect(status.helperXPCOK == true && status.helperVersion == "0.2.0-h2")
  }
}

// MARK: - The updater is back on, and cannot reach the root helper copy

@Suite struct UpdaterWithRootHelperCopyTests {
  let home = URL(fileURLWithPath: "/Users/room")
  let app = URL(fileURLWithPath: "/Applications/EvenScribe Room Recorder.app")

  @Test func theSystemDaemonPlistNoLongerSwitchesTheUpdaterOff() {
    var asked: [String] = []
    let bundle = RoomEngine.updaterBundle(bundleURL: app, homeDirectory: home, fileExists: { asked.append($0); return true })
    #expect(bundle == app)
    #expect(!asked.contains("/Library/LaunchDaemons/com.evenscribe.room-recorder.helper.plist"), "the rule is gone")
  }

  @Test func theOtherRulesStillHold() {
    let old = URL(fileURLWithPath: "/Users/room/Applications/EvenScribe Room Recorder.app")
    #expect(RoomEngine.updaterBundle(bundleURL: old, homeDirectory: home, fileExists: { _ in false }) == old)
    #expect(RoomEngine.updaterBundle(bundleURL: old, homeDirectory: home, fileExists: { $0 == "/Applications/EvenScribe Room Recorder.app" }) == nil)
    #expect(RoomEngine.updaterBundle(bundleURL: URL(fileURLWithPath: "/tmp/room-recorder"), homeDirectory: home, fileExists: { _ in false }) == nil)
  }

  @Test func theSwapScriptNamesNothingOfTheRootDaemon() {
    let script = RoomSwapScript.render(
      residentBundleURL: app, stagedBundleURL: URL(fileURLWithPath: "/tmp/staged/EvenScribe Room Recorder.app"),
      rootURL: URL(fileURLWithPath: "/Users/room/Library/Application Support/EvenScribe/RoomRecorder"), version: "0.1.99")
    for forbidden in ["PrivilegedHelperTools", "LaunchDaemons", "bootstrap system", "bootout system", " system/", "room-recorder.helper"] {
      #expect(!script.contains(forbidden), "\(forbidden)")
    }
    #expect(script.contains("gui/"), "it works the user's agent domain only")
  }
}
