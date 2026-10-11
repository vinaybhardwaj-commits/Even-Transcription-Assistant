import CryptoKit
import Foundation
import Testing

@testable import FleetCore
@testable import HelperCore

@Suite struct HelperCommandRunnerTests {
  let server = TestServer()
  let env = FakeEnv()
  let tools = FakeTools()
  let statePath = tempPath("state.json")

  func runner(keys: [String: Data]? = nil, safeMode: Bool = false) -> HelperCommandRunner {
    HelperCommandRunner(
      serverKeys: keys ?? ["fk1": server.publicKey], env: env, tools: tools, statePath: statePath, safeMode: safeMode, log: { _ in })
  }
  func envelope(
    _ verb: String, _ params: [String: FleetJSON] = [:], approval: String? = nil, nonce: String = TestServer.freshNonce(),
    cmdID: String = "cmd_1", mutate: ((inout [String: FleetJSON]) -> Void)? = nil
  ) -> String {
    server.envelope(
      at: env.clock, cmdID: cmdID, verb: verb, params: params, nonce: nonce, approval: approval, mutate: mutate
    ).canonical
  }
  func run(_ r: HelperCommandRunner, _ text: String, device: String = TestServer.deviceID, machine: String = TestServer.machine)
    -> HelperCommandOutcome
  { r.run(envelopeJSON: text, deviceID: device, machine: machine) }

  // MARK: The helper verifies for itself

  @Test func theServersPublishedVectorIsAcceptedByTheHelperItself() throws {
    let key = Data(base64Encoded: FleetEnvelopeVectorTests.fakeKey)!
    let r = HelperCommandRunner(
      serverKeys: ["fk1": key], env: env, tools: tools, statePath: statePath, log: { _ in })
    env.clock = FleetEnvelope.date("2026-10-10T07:01:00.000Z")!
    let outcome = r.run(
      envelopeJSON: try FleetEnvelopeVectorTests.vectorA().canonical, deviceID: "dev_000000000000000000000001",
      machine: "EXAMPLE-MAC")
    #expect(outcome.kind == .unsupported && outcome.reason == "upload_not_available", "signature verified, verb is collect_diag")
  }

  @Test func anEnvelopeSignedByAnyOtherKeyChangesNothing() {
    let stranger = Curve25519.Signing.PrivateKey()
    let text = server.envelope(at: env.clock, verb: "wake", signWith: stranger).canonical
    let outcome = run(runner(), text)
    #expect(outcome == HelperCommandOutcome(.refused, reason: "bad_signature"))
    #expect(tools.calls.isEmpty)
  }

  @Test func theCompiledInFk1IsWhatTheDefaultRunnerTrusts() {
    let r = HelperCommandRunner(env: env, tools: tools, statePath: statePath, log: { _ in })  // default keys
    let outcome = run(r, envelope("wake"))
    #expect(outcome == HelperCommandOutcome(.refused, reason: "bad_signature"), "the test key is not fk1")
  }

  @Test func aReplayedEnvelopeIsRefusedEvenByAFreshHelperProcess() {
    let nonce = TestServer.freshNonce()
    let text = envelope("wake", nonce: nonce)
    #expect(run(runner(), text).kind == .ok)
    let again = run(runner(), text)  // a NEW runner: the ledger is on disk, root-only
    #expect(again == HelperCommandOutcome(.refused, reason: "replay"))
    #expect(tools.actions.filter { $0.contains("caffeinate") }.count == 1)
    let mode = (try? FileManager.default.attributesOfItem(atPath: statePath)[.posixPermissions] as? NSNumber)?.intValue
    #expect(mode == 0o600)
  }

  @Test func expiredWrongDeviceWrongMachineAndMalformedAreRefusedBeforeAnythingRuns() {
    let old = server.envelope(at: env.clock, verb: "wake", issued: env.clock.addingTimeInterval(-1_000)).canonical
    #expect(run(runner(), old).reason == "expired")
    #expect(run(runner(), envelope("wake"), device: "dev_00000000000000000000000b").reason == "machine_mismatch")
    #expect(run(runner(), envelope("wake"), machine: "another-mac").reason == "machine_mismatch")
    #expect(run(runner(), "not json").reason == "malformed")
    #expect(run(runner(), envelope("wake") { $0["extra"] = .int(1) }).reason == "malformed")
    #expect(tools.calls.isEmpty)
  }

  @Test func theHelperRunsOnlyHelperVerbs() {
    for verb in ["select_audio_input", "self_test", "list_audio_inputs", "report_diag", "pieces_inventory", "pieces_reupload"] {
      let params: [String: FleetJSON] = verb == "select_audio_input" ? ["device_uid": .string("u")] : [:]
      #expect(run(runner(), envelope(verb, params)).reason == "verb_not_allowed", "\(verb) belongs to the app")
    }
    #expect(run(runner(), envelope("update_bundle")).reason == "verb_not_allowed")
    #expect(tools.calls.isEmpty)
  }

  @Test func badParamsRefuseWithoutRunningAnything() {
    #expect(run(runner(), envelope("wake", ["x": .int(1)])).reason == "bad_params")
    #expect(run(runner(), envelope("collect_diag", ["scope": .string("keychain")])).reason == "bad_params")
    #expect(run(runner(), envelope("schedule_poweron", ["time": .string("25:00")])).reason == "bad_params")
    #expect(tools.calls.isEmpty)
  }

  // MARK: Gates, from the helper's own view of the machine

  @Test func anOpenSessionBlocksResetAndRestartAndReloadUnlessForcedAndApproved() {
    env.setStatus("recording")
    #expect(run(runner(), envelope("coreaudiod_reset")).reason == "session_open")
    #expect(run(runner(), envelope("reload_launchagent")).reason == "session_open")
    #expect(run(runner(), envelope("restart_recorder")).reason == "session_open")
    #expect(run(runner(), envelope("restart_recorder", ["force": .bool(true)])).reason == "session_open", "forced but not approved")
    #expect(tools.actions.isEmpty)
    let forced = run(runner(), envelope("restart_recorder", ["force": .bool(true)], approval: "go_ok1"))
    #expect(forced.kind == .ok)
    #expect(tools.actions == ["/bin/launchctl kickstart -k gui/501/com.evenscribe.room-recorder"])
  }

  @Test func pausedCountsAsOpenAndAStatusFromADeadAppDoesNot() {
    env.setStatus("paused")
    #expect(run(runner(), envelope("coreaudiod_reset")).reason == "session_open")
    env.appIsRunning = false  // a stale status.json left by an app that is gone
    #expect(run(runner(), envelope("coreaudiod_reset")).kind == .ok)
  }

  @Test func withNoConsoleUserTheGuiVerbsRefuseAndTheRootOnesRun() {
    env.console = nil
    // REFUSED by the gate, not "failed" later: a helper that assumed a console user would fail inside the verb.
    #expect(run(runner(), envelope("restart_recorder")) == HelperCommandOutcome(.refused, reason: "no_console_user"))
    #expect(run(runner(), envelope("reload_launchagent")) == HelperCommandOutcome(.refused, reason: "no_console_user"))
    #expect(run(runner(), envelope("coreaudiod_reset")).kind == .ok)
    #expect(run(runner(), envelope("wake")).kind == .ok)
  }

  @Test func clinicHoursNeedApprovalAndTheHelperAppliesItItself() {
    env.clock = TestServer.now  // 14:25 IST
    #expect(run(runner(), envelope("coreaudiod_reset")).reason == "clinic_hours_needs_approval")
    #expect(run(runner(), envelope("coreaudiod_reset", approval: "go_okay")).kind == .ok)
    #expect(run(runner(), envelope("wake")).kind == .ok, "not privileged")
  }

  @Test func theCeilingsSurviveARestartOfTheHelper() {
    #expect(run(runner(), envelope("coreaudiod_reset")).kind == .ok)
    #expect(run(runner(), envelope("coreaudiod_reset")).reason == "rate_limited", "one reset per 30 minutes")
    env.clock = env.clock.addingTimeInterval(1_801)
    #expect(run(runner(), envelope("coreaudiod_reset")).kind == .ok)
  }

  @Test func tenPrivilegedVerbsAnHourAndNoMore() {
    var ok = 0
    for index in 0..<11 {
      let outcome = run(runner(), envelope("reload_launchagent", cmdID: "cmd_\(index)"))
      if outcome.kind == .ok { ok += 1 } else { #expect(outcome.reason == "rate_limited") }
    }
    #expect(ok == 10)
  }

  // MARK: The verbs, and exactly what they run

  @Test func coreaudiodResetIsOneKickstartOfTheSystemService() {
    #expect(run(runner(), envelope("coreaudiod_reset")).kind == .ok)
    #expect(tools.actions == ["/bin/launchctl kickstart -k system/com.apple.audio.coreaudiod"])
  }

  @Test func aFailingToolIsReportedFailedWithItsStatusAndNothingElse() {
    tools.responder = { _, _ in ToolResult(status: 113) }
    let outcome = run(runner(), envelope("coreaudiod_reset"))
    #expect(outcome == HelperCommandOutcome(.failed, reason: "launchctl_113"))
  }

  @Test func restartRecorderKicksTheConsoleUsersAgentOnly() {
    #expect(run(runner(), envelope("restart_recorder")).kind == .ok)
    #expect(tools.actions == ["/bin/launchctl kickstart -k gui/501/com.evenscribe.room-recorder"])
  }

  @Test func reloadLaunchAgentIsBootoutThenBootstrapOfTheUsersDomain() {
    env.files[FakeEnv.plist] = Data("plist".utf8)
    let outcome = run(runner(), envelope("reload_launchagent"))
    #expect(outcome.kind == .ok && outcome.detail["plist_rewritten"] == .bool(false))
    #expect(tools.actions == [
      "/bin/launchctl bootout gui/501/com.evenscribe.room-recorder",
      "/bin/launchctl bootstrap gui/501 \(FakeEnv.plist)",
    ])
  }

  @Test func reloadLaunchAgentRewritesAMissingPlistOwnedByTheUser() throws {
    let outcome = run(runner(), envelope("reload_launchagent"))
    #expect(outcome.kind == .ok && outcome.detail["plist_rewritten"] == .bool(true))
    let write = try #require(env.writes.first)
    #expect(write.path == FakeEnv.plist && write.uid == 501 && write.gid == 20)
    let object = try #require(try PropertyListSerialization.propertyList(from: write.data, format: nil) as? [String: Any])
    #expect(object["KeepAlive"] as? Bool == true && object["Label"] as? String == "com.evenscribe.room-recorder")
    #expect((object["ProgramArguments"] as? [String])?.last == FakeEnv.root)
    #expect(tools.actions.last == "/bin/launchctl bootstrap gui/501 \(FakeEnv.plist)")
  }

  @Test func reloadFailsHonestlyIfThePlistCannotBeWritten() {
    env.writeResult = .failed
    let outcome = run(runner(), envelope("reload_launchagent"))
    #expect(outcome == HelperCommandOutcome(.failed, reason: "plist_not_written"))
    #expect(tools.actions.isEmpty)
  }

  @Test func aPlistPathThatIsASymlinkIsRefusedAndNothingIsBootedOut() {
    env.files[FakeEnv.plist] = Data("x".utf8)
    env.symlinks = [FakeEnv.plist]
    let outcome = run(runner(), envelope("reload_launchagent"))
    #expect(outcome == HelperCommandOutcome(.refused, reason: "unsafe_path"))
    #expect(tools.actions.isEmpty, "not even a bootout")
  }

  @Test func aWriteTheEnvironmentRefusesAsUnsafeIsARefusalNotAFailure() {
    env.writeResult = .refusedUnsafePath
    #expect(run(runner(), envelope("reload_launchagent")) == HelperCommandOutcome(.refused, reason: "unsafe_path"))
    #expect(tools.actions.isEmpty)
  }

  @Test func aRunningAppWhoseStatusCannotBeReadCountsAsASessionInProgress() {
    // status.json missing (or a symlink, or too big, or a FIFO: all read as nil): fail CLOSED.
    env.files[FakeEnv.root + "/status.json"] = nil
    #expect(run(runner(), envelope("coreaudiod_reset")).reason == "session_open")
    #expect(tools.actions.isEmpty)
    env.setStatus("ready")
    #expect(run(runner(), envelope("coreaudiod_reset")).kind == .ok)
    // ...and an app that is not running cannot have a session, whatever it left behind.
    let gone = FakeEnv()
    gone.appIsRunning = false
    let r = HelperCommandRunner(serverKeys: ["fk1": server.publicKey], env: gone, tools: FakeTools(), statePath: tempPath("s.json"), log: { _ in })
    #expect(r.run(envelopeJSON: server.envelope(at: gone.clock, verb: "coreaudiod_reset").canonical, deviceID: TestServer.deviceID, machine: TestServer.machine).kind == .ok)
  }

  @Test func inSafeModeOnlyDiagnosticsRunAndNothingIsConsumed() {
    let safe = runner(safeMode: true)
    for verb in ["coreaudiod_reset", "wake", "pmset_enforce", "schedule_poweron", "reload_launchagent", "restart_recorder"] {
      #expect(run(safe, envelope(verb, cmdID: "cmd_\(verb)")) == HelperCommandOutcome(.refused, reason: "safe_mode"), "\(verb)")
    }
    #expect(tools.actions.isEmpty)
    #expect(run(safe, envelope("helper_status")).kind == .ok)
    #expect(run(safe, envelope("collect_diag", ["scope": .string("power")])).kind == .unsupported)
    // A refused envelope is not spent: the same one runs once safe mode ends.
    let nonce = TestServer.freshNonce()
    let held = envelope("wake", nonce: nonce)
    #expect(run(safe, held).reason == "safe_mode")
    #expect(run(runner(), held).kind == .ok)
  }

  @Test func scheduleAtAnotherTimeIsRememberedAndTheDefaultClearsIt() throws {
    let timePath = tempPath("power-time")
    let r = HelperCommandRunner(
      serverKeys: ["fk1": server.publicKey], env: env, tools: tools, statePath: statePath, powerTimePath: timePath, log: { _ in })
    let pmset = FakePmset()
    let r2 = HelperCommandRunner(
      serverKeys: ["fk1": server.publicKey], env: env, tools: pmset.tools, statePath: statePath, powerTimePath: timePath, log: { _ in })
    _ = r
    #expect(run(r2, envelope("schedule_poweron", ["time": .string("06:45")])).kind == .ok)
    #expect(PowerPolicy.storedTime(at: timePath) == "06:45")
    #expect(run(r2, envelope("schedule_poweron", ["time": .string("07:05")], cmdID: "cmd_2")).kind == .ok)
    #expect(PowerPolicy.storedTime(at: timePath) == nil, "the default means no override")
  }

  @Test func wakeIsCaffeinateFiveSeconds() {
    #expect(run(runner(), envelope("wake")).kind == .ok)
    #expect(tools.actions == ["/usr/bin/caffeinate -u -t 5"])
  }

  @Test func usbReseatAndCollectDiagAreUnsupportedAndRunNothing() {
    #expect(run(runner(), envelope("usb_reseat")) == HelperCommandOutcome(.unsupported, reason: "no_controllable_hub"))
    #expect(run(runner(), envelope("usb_reseat", ["port": .string("2")])).kind == .unsupported)
    #expect(run(runner(), envelope("collect_diag", ["scope": .string("power")])).reason == "upload_not_available")
    #expect(tools.actions.isEmpty)
  }

  @Test func helperStatusReportsWithoutChangingAnything() {
    tools.responder = { exe, args in
      args == ["-g"] ? ToolResult(status: 0, output: " sleep 0\n womp 1\n") : ToolResult(status: 0, output: "")
    }
    let outcome = run(runner(safeMode: true), envelope("helper_status"))
    #expect(outcome.kind == .ok)
    #expect(outcome.detail["helper_version"] == .string(HelperIdentity.helperVersion) && outcome.detail["safe_mode"] == .bool(true))
    #expect(outcome.detail["console_user"] == .bool(true) && outcome.detail["pmset_drift"] == .int(0))
    #expect(tools.actions.isEmpty)
  }

  @Test func noVerbEverRunsAShellOrTouchesAutologin() {
    for verb in ["coreaudiod_reset", "restart_recorder", "reload_launchagent", "wake", "pmset_enforce", "schedule_poweron", "helper_status"] {
      _ = run(runner(), envelope(verb, cmdID: "cmd_\(verb)"))
    }
    let executables = Set(tools.calls.compactMap { $0.split(separator: " ").first.map(String.init) })
    #expect(executables.isSubset(of: ProcessSystemTools.allowed), "\(executables)")
    #expect(!tools.calls.contains { $0.contains("autologin") || $0.contains("sh -c") || $0.contains("kcpassword") })
  }

  @Test func theRealToolRunnerRefusesAnythingNotOnItsList() {
    let real = ProcessSystemTools()
    #expect(real.run("/bin/sh", ["-c", "true"]) == ToolResult(status: 127, output: "not allowed"))
    #expect(real.run("/usr/bin/sudo", ["true"]).status == 127)
    #expect(ProcessSystemTools.allowed == ["/bin/launchctl", "/usr/bin/pmset", "/usr/bin/caffeinate", "/bin/ps"])
    #expect(real.run("/usr/sbin/chown", ["0:0", "/tmp/x"]).status == 127, "the helper cannot chown anything")
  }
}
