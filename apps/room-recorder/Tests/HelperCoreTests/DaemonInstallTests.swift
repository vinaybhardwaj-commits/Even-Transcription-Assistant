import Foundation
import Testing

@testable import HelperCore
@testable import RoomRecorderCore

// MARK: - The pkg postinstall, dry-run

@Suite struct PostinstallScriptTests {
  static var script: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Packaging/pkg-scripts/postinstall")
  }

  struct Sandbox {
    let base = FileManager.default.temporaryDirectory.appendingPathComponent("postinstall-\(UUID().uuidString)")
    var apps: URL { base.appendingPathComponent("Applications") }
    var app: URL { apps.appendingPathComponent("EvenScribe Room Recorder.app") }
    var helper: URL { app.appendingPathComponent("Contents/MacOS/room-recorder-helper") }
    var daemons: URL { base.appendingPathComponent("LaunchDaemons") }
    var plist: URL { daemons.appendingPathComponent("com.evenscribe.room-recorder.helper.plist") }
    var calls: URL { base.appendingPathComponent("launchctl.calls") }
    var stub: URL { base.appendingPathComponent("launchctl") }

    init(withHelper: Bool = true, withApp: Bool = true, bootoutFails: Bool = false, bootstrapFails: Bool = false) throws {
      try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
      if withApp {
        try FileManager.default.createDirectory(at: helper.deletingLastPathComponent(), withIntermediateDirectories: true)
        if withHelper {
          try "#!/bin/sh\n".write(to: helper, atomically: true, encoding: .utf8)
          try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helper.path)
        }
      }
      try """
        #!/bin/sh
        echo "$@" >> '\(calls.path)'
        case "$1" in
          bootout) exit \(bootoutFails ? 36 : 0) ;;
          bootstrap) exit \(bootstrapFails ? 5 : 0) ;;
        esac
        exit 0
        """.write(to: stub, atomically: true, encoding: .utf8)
      try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stub.path)
    }

    func run() throws -> (status: Int32, output: String) {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/bin/sh")
      process.arguments = [PostinstallScriptTests.script.path, "pkg", apps.path, "/", "/"]
      process.environment = [
        "ETA_POSTINSTALL_TEST": "1", "ETA_INSTALL_LOCATION": apps.path, "ETA_DAEMON_DIR": daemons.path,
        "ETA_LAUNCHCTL": stub.path, "ETA_SKIP_OWNERSHIP": "1", "ETA_LOG_PATH": "/var/log/room-recorder-helper.log",
        "PATH": "/usr/bin:/bin",
      ]
      let pipe = Pipe()
      process.standardOutput = pipe
      process.standardError = pipe
      try process.run()
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }

    var launchctlCalls: [String] {
      ((try? String(contentsOf: calls, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
    }
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
    return process.terminationStatus == 0 ? String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) : nil
  }

  @Test func theScriptParsesUnderEveryShellItCouldRunUnder() throws {
    // shellcheck is not installed on the Mini; `-n` is what is available.
    for shell in ["/bin/sh", "/bin/dash", "/bin/bash"] {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: shell)
      process.arguments = ["-n", Self.script.path]
      try process.run()
      process.waitUntilExit()
      #expect(process.terminationStatus == 0, "\(shell) -n")
    }
    #expect(FileManager.default.isExecutableFile(atPath: Self.script.path))
  }

  @Test func itWritesTheDaemonPlistAndBootstrapsItIntoTheSystemDomain() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0, "\(result.output)")
    let path = box.plist.path
    #expect(plistValue(path, "Label") == "com.evenscribe.room-recorder.helper")
    #expect(plistValue(path, "Program") == box.helper.path)
    #expect(plistValue(path, "ProgramArguments.0") == box.helper.path)
    #expect(plistValue(path, "MachServices.com\\.evenscribe\\.room-recorder\\.helper\\.xpc") == "true")
    #expect(plistValue(path, "RunAtLoad") == "true" && plistValue(path, "KeepAlive") == "true")
    let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber
    #expect(mode?.intValue == 0o644)
    #expect(box.launchctlCalls == ["bootout system/com.evenscribe.room-recorder.helper", "bootstrap system \(path)"])
    #expect(!FileManager.default.fileExists(atPath: path + ".tmp"), "no temp file left")
  }

  @Test func theScriptsConstantsAreTheAppsConstants() throws {
    // The Mach service name and the label are written in the shell script AND used by the app's XPC
    // client; a drift between them would install a daemon nobody connects to.
    let box = try Sandbox()
    defer { box.tearDown() }
    _ = try box.run()
    #expect(plistValue(box.plist.path, "MachServices.com\\.evenscribe\\.room-recorder\\.helper\\.xpc") == "true")
    let text = try String(contentsOf: box.plist, encoding: .utf8)
    #expect(text.contains("<key>\(HelperIdentity.machServiceName)</key>"))
    #expect(text.contains("<string>\(HelperIdentity.helperIdentifier)</string>"))
    #expect(box.plist.path.hasSuffix("/" + HelperIdentity.systemDaemonPlistPath.split(separator: "/").last!))
    #expect(box.helper.lastPathComponent == HelperIdentity.helperExecutableName)
  }

  @Test func runningItAgainIsIdempotent() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    _ = try box.run()
    let first = try Data(contentsOf: box.plist)
    let again = try box.run()
    #expect(again.status == 0)
    #expect(try Data(contentsOf: box.plist) == first, "byte-identical on reinstall")
    #expect(box.launchctlCalls.count == 4)
    #expect(Array(box.launchctlCalls[2...]) == Array(box.launchctlCalls[..<2]), "out then in, both times")
    let leftovers = try FileManager.default.contentsOfDirectory(atPath: box.daemons.path)
    #expect(leftovers == ["com.evenscribe.room-recorder.helper.plist"])
  }

  @Test func aStalePlistFromAnOlderInstallIsReplaced() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    try FileManager.default.createDirectory(at: box.daemons, withIntermediateDirectories: true)
    try "stale".write(to: box.plist, atomically: true, encoding: .utf8)
    _ = try box.run()
    #expect(plistValue(box.plist.path, "Program") == box.helper.path)
  }

  @Test func bootoutOfAJobThatIsNotLoadedDoesNotFailTheInstall() throws {
    let box = try Sandbox(bootoutFails: true)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0)
    #expect(box.launchctlCalls.count == 2 && box.launchctlCalls[1].hasPrefix("bootstrap system"))
  }

  @Test func aFailedBootstrapIsReportedButDoesNotFailTheInstall() throws {
    let box = try Sandbox(bootstrapFails: true)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0, "the recorder app is the product")
    #expect(result.output.contains("bootstrap system") && result.output.contains("failed"))
    #expect(FileManager.default.fileExists(atPath: box.plist.path), "the plist is in place for the next boot")
  }

  @Test func noHelperBinaryMeansNoDaemon() throws {
    let box = try Sandbox(withHelper: false)
    defer { box.tearDown() }
    let result = try box.run()
    #expect(result.status == 0)
    #expect(!FileManager.default.fileExists(atPath: box.plist.path))
    #expect(box.launchctlCalls.isEmpty)
  }

  @Test func noAppMeansTheInstallFails() throws {
    let box = try Sandbox(withApp: false)
    defer { box.tearDown() }
    #expect(try box.run().status == 1)
    #expect(box.launchctlCalls.isEmpty)
  }

  @Test func theBundleIsMadeNonWritableForGroupAndOthers() throws {
    let box = try Sandbox()
    defer { box.tearDown() }
    try FileManager.default.setAttributes([.posixPermissions: 0o777], ofItemAtPath: box.helper.path)
    _ = try box.run()
    let mode = (try FileManager.default.attributesOfItem(atPath: box.helper.path)[.posixPermissions] as? NSNumber)?.intValue ?? 0
    #expect(mode & 0o022 == 0)
  }

  @Test func theTestOverridesAreIgnoredUnlessTheTestFlagIsSet() throws {
    // Without ETA_POSTINSTALL_TEST=1 the script must use the real paths and ignore the overrides. It is
    // run here with a nonexistent install location (so it stops at "no app") and a launchctl stub
    // that would record a call if it were honoured.
    let box = try Sandbox()
    defer { box.tearDown() }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = [Self.script.path, "pkg", "/nonexistent-\(UUID().uuidString)"]
    process.environment = ["ETA_LAUNCHCTL": box.stub.path, "ETA_DAEMON_DIR": box.daemons.path, "ETA_SKIP_OWNERSHIP": "1", "PATH": "/usr/bin:/bin"]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    #expect(process.terminationStatus == 1)
    #expect(box.launchctlCalls.isEmpty && !FileManager.default.fileExists(atPath: box.plist.path))
  }
}

// MARK: - The app's view of the helper: launchd, smappservice, none

@Suite struct HelperModeProbeTests {
  final class Fake: HelperDaemonService, @unchecked Sendable {
    var status: String
    var registerCalls = 0
    var failure: Error?
    init(_ status: String, failure: Error? = nil) { self.status = status; self.failure = failure }
    var registrationName: String { status }
    func register() throws {
      registerCalls += 1
      if let failure { throw failure }
      status = "enabled"
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

// MARK: - The updater must not leave a user-owned helper under a root daemon

@Suite struct UpdaterRootOwnershipTests {
  let home = URL(fileURLWithPath: "/Users/room")
  let app = URL(fileURLWithPath: "/Applications/EvenScribe Room Recorder.app")

  @Test func theUpdaterIsOffWhileTheRootDaemonRunsTheHelperFromTheBundle() {
    #expect(RoomEngine.updaterBundle(bundleURL: app, homeDirectory: home, fileExists: { _ in true }) == nil)
    #expect(
      RoomEngine.updaterBundle(
        bundleURL: URL(fileURLWithPath: "/Users/room/Applications/EvenScribe Room Recorder.app"),
        homeDirectory: home, fileExists: { $0 == HelperIdentity.systemDaemonPlistPath }) == nil)
  }

  @Test func theRuleKeysOnTheSystemPlistAndNothingElse() {
    #expect(RoomEngine.updaterBundle(bundleURL: app, homeDirectory: home, fileExists: { _ in false }) == app)
    #expect(
      RoomEngine.updaterBundle(bundleURL: app, homeDirectory: home, fileExists: { $0 == "/some/other.plist" }) == app)
    // The path asked about is the one the postinstall writes.
    var asked: [String] = []
    _ = RoomEngine.updaterBundle(bundleURL: app, homeDirectory: home, fileExists: { asked.append($0); return false })
    #expect(asked.contains("/Library/LaunchDaemons/com.evenscribe.room-recorder.helper.plist"))
  }
}
