import FleetCore
import Foundation

/// The outcome of one signed command, as the helper reports it.
public struct HelperCommandOutcome: Equatable, Sendable {
  public enum Kind: String, Sendable { case ok, refused, failed, unsupported }
  public var kind: Kind
  public var reason: String?
  public var detail: [String: FleetJSON]
  public init(_ kind: Kind, reason: String? = nil, detail: [String: FleetJSON] = [:]) {
    self.kind = kind
    self.reason = reason
    self.detail = detail
  }
}

/// Runs the helper's verbs (§8.3 "runs: helper" plus the two power verbs of #43).
///
/// ─── THE HELPER VERIFIES FOR ITSELF ───────────────────────────────────────────────────────
/// The app forwards the signed envelope whole. The helper re-checks the signature against its own compiled-in
/// server keys, the time window, the nonce (kept in a ROOT-only file), the device and machine, the allow-list,
/// the closed params, the local gates and the ceilings, and only then runs a fixed tool invocation. A
/// compromised or impersonated app therefore cannot make the helper do anything the server did not sign.
public final class HelperCommandRunner: @unchecked Sendable {
  private let serverKeys: [String: Data]
  private let env: HelperEnvironment
  private let tools: SystemTools
  private let power: PowerPolicy
  private let watchdog: AppWatchdog?
  private let statePath: String
  private let powerTimePath: String
  private let safeMode: Bool
  private let log: @Sendable (String) -> Void
  private let lock = NSLock()

  public init(
    serverKeys: [String: Data] = FleetServerKeys.resolve(), env: HelperEnvironment, tools: SystemTools,
    watchdog: AppWatchdog? = nil, statePath: String,
    powerTimePath: String = HelperIdentity.supportDirectory + "/" + HelperPaths.powerTimeFile, safeMode: Bool = false,
    log: @escaping @Sendable (String) -> Void
  ) {
    self.serverKeys = serverKeys
    self.env = env
    self.tools = tools
    self.power = PowerPolicy(tools: tools)
    self.watchdog = watchdog
    self.statePath = statePath
    self.powerTimePath = powerTimePath
    self.safeMode = safeMode
    self.log = log
  }

  // MARK: State (root-only, nonces and ceilings)

  private func loadState() -> FleetState {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: statePath)),
      let state = try? JSONDecoder().decode(FleetState.self, from: data)
    else { return FleetState() }
    return state
  }

  private func saveState(_ state: FleetState) {
    guard let data = try? JSONEncoder().encode(state) else { return }
    let url = URL(fileURLWithPath: statePath)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: url, options: .atomic)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: statePath)
  }

  // MARK: Verify, then run

  public func run(envelopeJSON: String, deviceID: String, machine: String) -> HelperCommandOutcome {
    lock.lock(); defer { lock.unlock() }
    guard let json = try? FleetJSON.parse(Data(envelopeJSON.utf8)) else {
      return HelperCommandOutcome(.refused, reason: FleetRefusal.malformed.rawValue)
    }
    var state = loadState()
    let now = env.now()
    let epoch = Int(now.timeIntervalSince1970)
    let user = env.consoleUser()
    let root = user.flatMap { env.roomRoot(uid: $0.uid) }
    // FAIL CLOSED: a running app whose status cannot be read (missing, a symlink, too big, a FIFO) counts as a
    // session in progress, so a reset or a restart waits rather than cutting a consultation.
    let sessionOpen: Bool = {
      guard let user, env.appRunning(uid: user.uid) else { return false }
      guard let root else { return true }
      return AppStatusSnapshot.read(env: env, root: root, uid: user.uid, gid: user.gid)?.sessionOpen ?? true
    }()
    let verifier = FleetVerifier(serverKeys: serverKeys, deviceID: deviceID, machine: machine)
    let verdict = verifier.verify(
      json, now: now, nonceSeen: { state.nonceSeen($0) },
      gates: FleetGateState(sessionOpen: sessionOpen, consoleUserPresent: user != nil),
      rates: FleetRateState(
        privilegedInLastHour: state.privilegedRuns(inHourBefore: epoch),
        secondsSinceLastReset: state.lastCoreaudiodReset.map { epoch - $0 }),
      killSwitch: false, handles: { $0.runsOnHelper })
    switch verdict {
    case .failure(let refusal):
      log("helper refused a command: \(refusal.rawValue)")
      return HelperCommandOutcome(.refused, reason: refusal.rawValue)
    case .success(let accepted):
      // Safe mode (three unstable launches in a row) keeps to diagnostics: it must not change the machine.
      if safeMode, accepted.verb != .helperStatus, accepted.verb != .collectDiag {
        log("helper in safe mode refused \(accepted.verb.rawValue)")
        return HelperCommandOutcome(.refused, reason: "safe_mode")
      }
      state.remember(nonce: accepted.envelope.nonce)
      if accepted.verb.isPrivileged { state.recordPrivilegedRun(at: epoch) }
      if accepted.verb == .coreaudiodReset { state.lastCoreaudiodReset = epoch }
      saveState(state)
      let outcome = execute(accepted.verb, accepted.params, user: user)
      log("helper ran \(accepted.verb.rawValue): \(outcome.kind.rawValue)\(outcome.reason.map { " (\($0))" } ?? "")")
      return outcome
    }
  }

  // MARK: The verbs

  private func execute(
    _ verb: FleetVerb, _ params: FleetParams, user: (uid: UInt32, gid: UInt32, name: String)?
  ) -> HelperCommandOutcome {
    switch verb {
    case .helperStatus:
      let drift = power.currentDrift()
      return HelperCommandOutcome(
        .ok,
        detail: [
          "helper_version": .string(HelperIdentity.helperVersion), "safe_mode": .bool(safeMode),
          "console_user": .bool(user != nil), "app_state": .string((watchdog?.lastState ?? .missing).rawValue),
          "power_schedule": .string(power.powerSchedule()), "pmset_drift": .int(Int64(drift?.count ?? -1)),
        ])
    case .collectDiag:
      // Validated, then declined: there is no upload route to send a bundle to.
      return HelperCommandOutcome(.unsupported, reason: "upload_not_available", detail: ["scope": params.raw["scope"] ?? .null])
    case .usbReseat:
      return HelperCommandOutcome(.unsupported, reason: "no_controllable_hub")
    case .coreaudiodReset:
      let result = tools.run("/bin/launchctl", ["kickstart", "-k", "system/com.apple.audio.coreaudiod"])
      return result.status == 0
        ? HelperCommandOutcome(.ok, detail: ["restarted": .bool(true)])
        : HelperCommandOutcome(.failed, reason: "launchctl_\(result.status)")
    case .restartRecorder:
      guard let user else { return HelperCommandOutcome(.failed, reason: FleetRefusal.noConsoleUser.rawValue) }
      let result = tools.run("/bin/launchctl", ["kickstart", "-k", "gui/\(user.uid)/\(HelperPaths.agentLabel)"])
      return result.status == 0
        ? HelperCommandOutcome(.ok, detail: ["restarting": .bool(true)])
        : HelperCommandOutcome(.failed, reason: "launchctl_\(result.status)")
    case .reloadLaunchagent:
      guard let user, let plist = env.agentPlistPath(uid: user.uid), let root = env.roomRoot(uid: user.uid) else {
        return HelperCommandOutcome(.failed, reason: FleetRefusal.noConsoleUser.rawValue)
      }
      var rewritten = false
      switch env.userFileKind(plist, uid: user.uid, gid: user.gid) {
      case .regular:
        break
      case .symlink, .other:
        return HelperCommandOutcome(.refused, reason: "unsafe_path")
      case .missing:
        guard let data = LaunchAgentPlist.data(
          executablePath: "/Applications/EvenScribe Room Recorder.app/Contents/MacOS/room-recorder",
          rootPath: root, logPath: root + "/launchd.log")
        else { return HelperCommandOutcome(.failed, reason: "plist_not_written") }
        switch env.writeUserFile(plist, data: data, uid: user.uid, gid: user.gid) {
        case .written: rewritten = true
        case .refusedUnsafePath: return HelperCommandOutcome(.refused, reason: "unsafe_path")
        case .failed: return HelperCommandOutcome(.failed, reason: "plist_not_written")
        }
      }
      _ = tools.run("/bin/launchctl", ["bootout", "gui/\(user.uid)/\(HelperPaths.agentLabel)"])
      let result = tools.run("/bin/launchctl", ["bootstrap", "gui/\(user.uid)", plist])
      return result.status == 0
        ? HelperCommandOutcome(.ok, detail: ["plist_rewritten": .bool(rewritten)])
        : HelperCommandOutcome(.failed, reason: "launchctl_\(result.status)", detail: ["plist_rewritten": .bool(rewritten)])
    case .wake:
      let result = tools.run("/usr/bin/caffeinate", ["-u", "-t", "5"])
      return result.status == 0 ? HelperCommandOutcome(.ok) : HelperCommandOutcome(.failed, reason: "caffeinate_\(result.status)")
    case .pmsetEnforce:
      let report = power.enforce()
      return HelperCommandOutcome(
        report.ok ? .ok : .failed, reason: report.ok ? nil : "pmset_drift",
        detail: [
          "drift_before": .array(report.driftBefore.map(FleetJSON.string)),
          "applied": .array(report.applied.map(FleetJSON.string)),
          "drift_after": .array(report.driftAfter.map(FleetJSON.string)),
          "failures": .array(report.failures.map(FleetJSON.string)),
        ])
    case .schedulePoweron:
      let time = params.raw["time"]?.stringValue ?? PowerPolicy.defaultPowerOn
      // `repeat` REPLACES whatever schedule is there, so it is always applied when asked, not only when missing.
      let set = tools.run("/usr/bin/pmset", ["repeat", "wakeorpoweron", "MTWRFSU", "\(time):00"])
      guard set.status == 0 else { return HelperCommandOutcome(.failed, reason: "pmset_\(set.status)") }
      let schedule = power.powerSchedule(time: time)
      guard schedule != "none" else {
        return HelperCommandOutcome(.failed, reason: "schedule_not_visible", detail: ["time": .string(time)])
      }
      // Remember the time, root-only, so the 15-minute re-assertion keeps THIS time and not the default.
      PowerPolicy.saveStoredTime(time, at: powerTimePath)
      return HelperCommandOutcome(.ok, detail: ["power_schedule": .string(schedule)])
    case .reportDiag, .listAudioInputs, .selectAudioInput, .selfTest, .piecesInventory, .piecesReupload:
      return HelperCommandOutcome(.refused, reason: FleetRefusal.verbNotAllowed.rawValue)
    }
  }
}
