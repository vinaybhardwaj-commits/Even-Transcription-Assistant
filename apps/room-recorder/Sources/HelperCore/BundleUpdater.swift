import FleetCore
import Foundation
import KioskHealthCore

/// Is a recording session open? The same answer the signed-command gates use, in one place. FAIL CLOSED: a running app whose
/// status cannot be read (missing, a symlink, too big, a FIFO) counts as a session in progress.
public enum SessionProbe {
  public static func isOpen(env: HelperEnvironment) -> Bool {
    guard let user = env.consoleUser(), env.appRunning(uid: user.uid) else { return false }
    guard let root = env.roomRoot(uid: user.uid) else { return true }
    return AppStatusSnapshot.read(env: env, root: root, uid: user.uid, gid: user.gid)?.sessionOpen ?? true
  }
}

/// #45 (TS-H8, 0.1.37): whole-bundle self-update from the root helper, with cohorts and an automatic rollback.
///
/// ─── THE ORDER, AND WHY ────────────────────────────────────────────────────────────────────
///  offer    the app hands over a release record the SERVER signed (fk1); nothing is trusted but that signature
///  staging  download from an allowed host, sha256 and size against the record, `pkgutil --expand-full` into a root-only
///           directory, then `codesign --verify --deep --strict` of the app and the helper inside against the pinned
///           requirement (identifier + leaf, compiled in), and the version inside against the record
///  staged   wait until NO session is open (and someone is at the console); the pin and the failure hold are checked again
///  snapshot the installed bundle is copied AS THE ROOM USER into `rollback/<version>.app` and verified; no snapshot, no update
///  install  `installer` runs as a ONE-SHOT launchd job, not as a child of the helper: the pkg's postinstall boots the helper
///           itself out and back in, and a child would die with it. The new helper finds `phase: installing` on disk and
///           carries on from there
///  restart  `kickstart -k` of the app, only when no session is open (otherwise it waits; nothing is ever cut short)
///  health   an `appBeat` carrying the NEW version (the app sends one after each successful bench poll, over XPC, so it
///           proves the hello AND the bench heartbeat) within 5 minutes
///  rollback no beat in time: the snapshot is restored (again only outside a session) and must beat as the OLD version
///
/// Every step is written to `helper-update.json` before it runs, and its word goes out on the bench poll.
/// The watchdog's `install-in-progress` marker is held from the snapshot until the update is over, success or not.
public final class BundleUpdater: @unchecked Sendable {
  public static let healthWindow: TimeInterval = 5 * 60
  public static let installWindow: TimeInterval = 10 * 60
  public static let failuresBeforeHold = 2
  public static let retryHold: TimeInterval = 6 * 3600
  public static let installerLabel = "com.evenscribe.room-recorder.update-installer"
  public static let defaultApp = "/Applications/EvenScribe Room Recorder.app"
  public static let appRequirement =
    "identifier \"\(HelperIdentity.appIdentifier)\" and certificate leaf = H\"\(HelperIdentity.pinnedLeafSHA1)\""

  public struct Failure: Codable, Equatable, Sendable {
    public var count: Int
    public var at: Int
  }

  public struct State: Codable, Equatable, Sendable {
    public var phase = "idle"
    public var version: String?
    public var fromVersion: String?
    public var recordJSON: String?
    public var recordNonce: String?
    public var pkgPath: String?
    public var snapshot: String?
    public var step = "idle"
    public var detail: String?
    public var result: String?
    public var deadline: Int?
    public var restartedAt: Int?
    public var beatVersion: String?
    public var beatAt: Int?
    public var failures: [String: Failure] = [:]
    public var updatedAt = 0

    enum CodingKeys: String, CodingKey {
      case phase, version, step, detail, result, deadline, failures, snapshot
      case fromVersion = "from_version"
      case recordJSON = "record_json"
      case recordNonce = "record_nonce"
      case pkgPath = "pkg_path"
      case restartedAt = "restarted_at"
      case beatVersion = "beat_version"
      case beatAt = "beat_at"
      case updatedAt = "updated_at"
    }
    public init() {}
  }

  public enum Offer: Equatable, Sendable {
    case accepted(step: String)
    case refused(UpdateRefusal)
    /// Already working on exactly this record.
    case inProgress(step: String)
  }

  private let env: HelperEnvironment
  private let tools: SystemTools
  private let disk: UpdateDisk
  private let reader: UserFileAccess
  private let serverKeys: [String: Data]
  private let statePath: String
  private let directory: String
  private let rollbackDirectory: String
  private let appPath: String
  private let pinPath: String
  private let helperVersion: String
  private let now: @Sendable () -> Date
  private let log: @Sendable (String) -> Void
  private let stateLock = NSLock()
  private let workLock = NSLock()
  private var state: State

  public init(
    env: HelperEnvironment, tools: SystemTools, disk: UpdateDisk, reader: UserFileAccess,
    serverKeys: [String: Data] = FleetServerKeys.resolve(),
    directory: String = HelperPaths.supportDirectory + "/update",
    rollbackDirectory: String = HelperPaths.supportDirectory + "/rollback",
    statePath: String = HelperPaths.supportDirectory + "/helper-update.json",
    appPath: String = BundleUpdater.defaultApp, pinPath: String = RoomUpdatePin.defaultPath,
    helperVersion: String = HelperIdentity.helperVersion, now: @escaping @Sendable () -> Date = { Date() },
    log: @escaping @Sendable (String) -> Void
  ) {
    self.env = env
    self.tools = tools
    self.disk = disk
    self.reader = reader
    self.serverKeys = serverKeys
    self.directory = directory
    self.rollbackDirectory = rollbackDirectory
    self.statePath = statePath
    self.appPath = appPath
    self.pinPath = pinPath
    self.helperVersion = helperVersion
    self.now = now
    self.log = log
    self.state = disk.read(statePath, maxBytes: 1 << 20).flatMap { try? JSONDecoder().decode(State.self, from: $0) } ?? State()
  }

  // MARK: What the bench poll shows

  public var current: State { stateLock.lock(); defer { stateLock.unlock() }; return state }

  /// `update_step`, `update_version`, `update_result`, `update_detail`: strings, bounded.
  public func statusDetail() -> [String: String] {
    let s = current
    var out = ["update_step": s.step]
    if let v = s.version { out["update_version"] = v }
    if let r = s.result { out["update_result"] = r }
    if let d = s.detail { out["update_detail"] = String(d.prefix(120)) }
    return out
  }

  public var isBusy: Bool { current.phase != "idle" }

  // MARK: State (root-only, written before each step runs)

  private func epoch() -> Int { Int(now().timeIntervalSince1970) }

  private func mutate(_ body: (inout State) -> Void) {
    stateLock.lock()
    body(&state)
    state.updatedAt = epoch()
    let copy = state
    stateLock.unlock()
    if let data = try? JSONEncoder().encode(copy) { _ = disk.write(data, to: statePath, mode: 0o600) }
  }

  private func step(_ word: String, detail: String? = nil) {
    mutate { $0.step = word; $0.detail = detail }
    log("update: \(word)\(detail.map { " (\($0))" } ?? "")")
  }

  // MARK: Offer

  private func installedVersion() -> String? {
    guard let user = env.consoleUser() else { return nil }
    guard let data = reader.readWhole(appPath + "/Contents/Info.plist", user: user.name, maxBytes: 262_144),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
      let version = plist["CFBundleShortVersionString"] as? String, ReleaseRecord.isPlainVersion(version)
    else { return nil }
    return version
  }

  private func pinVerdict(_ version: String) -> UpdateRefusal? {
    let text = disk.exists(pinPath) ? (disk.read(pinPath, maxBytes: 256).map { String(decoding: $0, as: UTF8.self) } ?? "") : nil
    switch RoomUpdatePin.verdict(offered: version, pinText: text) {
    case .noPin, .allowed: return nil
    case .held: return .pinned
    case .unreadable: return .pinUnreadable
    }
  }

  private func held(_ version: String) -> Bool {
    let s = current
    guard let f = s.failures[version], f.count >= Self.failuresBeforeHold else { return false }
    return TimeInterval(epoch() - f.at) < Self.retryHold
  }

  public func offer(recordJSON: String, signature: String, deviceID: String, machine: String) -> Offer {
    let verdict = ReleaseVerifier.verify(
      recordJSON: recordJSON, signature: signature, serverKeys: serverKeys, deviceID: deviceID, machine: machine, now: now())
    guard case .success(let record) = verdict else {
      if case .failure(let why) = verdict { step("refused", detail: why.rawValue) }
      return .refused({ if case .failure(let why) = verdict { return why }; return .malformed }())
    }
    let s = current
    if s.phase != "idle" {
      if s.version == record.version && s.recordNonce == record.nonce { return .inProgress(step: s.step) }
      return .refused(.busy)
    }
    func refuse(_ why: UpdateRefusal) -> Offer {
      step("refused", detail: why.rawValue)
      return .refused(why)
    }
    guard let helper = RoomVersion(helperVersion), let needed = RoomVersion(record.minHelper), !(helper < needed) else { return refuse(.helperTooOld) }
    guard let installed = installedVersion() else { return refuse(.unknownInstalled) }
    guard roomUpdateNewer(offered: record.version, running: installed) else {
      mutate { $0.step = "up_to_date"; $0.detail = nil }
      return .refused(.notNewer)
    }
    if let why = pinVerdict(record.version) { return refuse(why) }
    if held(record.version) { return refuse(.held) }
    guard record.eligible else { return refuse(.notEligible) }
    mutate {
      $0.phase = "staging"
      $0.version = record.version
      $0.fromVersion = installed
      $0.recordJSON = recordJSON
      $0.recordNonce = record.nonce
      $0.pkgPath = nil
      $0.snapshot = nil
      $0.result = nil
      $0.deadline = nil
      $0.restartedAt = nil
    }
    step("offered")
    return .accepted(step: "offered")
  }

  /// The app's proof of life: it has just finished a successful bench poll, over XPC, running `version`.
  public func appBeat(version: String) {
    mutate { $0.beatVersion = version; $0.beatAt = epoch() }
  }

  // MARK: The machine

  /// One pass. Safe to call from a timer and right after an offer; calls queue behind each other.
  public func tick() {
    workLock.lock(); defer { workLock.unlock() }
    var guardCount = 0
    // A pass can move through several phases in a row (download, verify, ... until it has to wait for something).
    while guardCount < 12 {
      guardCount += 1
      let before = current.phase + "/" + current.step
      switch current.phase {
      case "staging": stage()
      case "staged": install()
      case "installing": watchInstall()
      case "restarting": restart()
      case "health": checkHealth()
      case "rollback_pending", "rolling_back": rollBack()
      case "rollback_health": checkRollbackHealth()
      default: return
      }
      if current.phase + "/" + current.step == before { return }
    }
  }

  private var staging: String { directory + "/staging" }

  private func finish(_ result: String, reason: String? = nil, countFailure: Bool) {
    let version = current.version
    mutate {
      $0.phase = "idle"
      $0.result = result
      $0.detail = reason
      $0.step = result
      $0.deadline = nil
      if countFailure, let version {
        let f = $0.failures[version] ?? Failure(count: 0, at: 0)
        $0.failures[version] = Failure(count: f.count + 1, at: epoch())
      }
      if result == "ok", let version { $0.failures[version] = nil }
    }
    // Never delete the staged restore copy while there is no app at the install path: it may be the only whole bundle left (B3).
    if !(disk.exists(staging + "/restore.app") && !disk.exists(appPath)) { disk.remove(staging) }
    disk.clearInstallMarker()
    log("update: finished \(result)\(reason.map { " (\($0))" } ?? "")")
  }

  private func fail(_ reason: String) { finish("failed", reason: reason, countFailure: true) }

  // staging: download, hash, expand, verify
  private func stage() {
    let s = current
    guard let recordJSON = s.recordJSON, let json = try? FleetJSON.parse(Data(recordJSON.utf8)), let record = ReleaseRecord.parse(json) else {
      return fail("record_lost")
    }
    guard disk.ensureDirectory(directory), disk.ensureDirectory(staging) else { return fail("staging_unwritable") }
    let pkg = staging + "/update-\(record.version).pkg"
    step("downloading")
    guard disk.download(record.pkgURL, to: pkg, maxBytes: record.pkgSize + (1 << 20)) else { return fail("download_failed") }
    step("downloaded")
    guard disk.size(ofFileAt: pkg) == record.pkgSize else { disk.remove(pkg); return fail("size_mismatch") }
    guard disk.sha256(ofFileAt: pkg) == record.pkgSHA256 else { disk.remove(pkg); return fail("sha_mismatch") }
    // From here the file is only ever read as root from a root-only directory: the bytes that were hashed are the bytes installed.
    let expanded = staging + "/expanded"
    disk.remove(expanded)
    guard tools.run("/usr/sbin/pkgutil", ["--expand-full", pkg, expanded]).status == 0 else { return fail("pkg_unreadable") }
    let payloadApp = expanded + "/Payload/EvenScribe Room Recorder.app"
    guard tools.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", "=" + Self.appRequirement, payloadApp]).status == 0
    else { return fail("app_signature_invalid") }
    guard
      tools.run(
        "/usr/bin/codesign", ["--verify", "--strict", "-R", "=" + HelperIdentity.requirementForHelper, payloadApp + "/Contents/MacOS/room-recorder-helper"]
      ).status == 0
    else { return fail("helper_signature_invalid") }
    guard bundleVersion(payloadApp) == record.version else { return fail("version_mismatch") }
    step("verified")
    mutate { $0.pkgPath = pkg; $0.phase = "staged" }
  }

  /// The version in a bundle that root itself unpacked (not a user-owned tree).
  private func bundleVersion(_ app: String) -> String? {
    guard let data = disk.read(app + "/Contents/Info.plist", maxBytes: 262_144),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
    else { return nil }
    return plist["CFBundleShortVersionString"] as? String
  }

  // staged: wait for a quiet room, snapshot, hand the install to a one-shot job
  private func install() {
    let s = current
    guard let version = s.version, let from = s.fromVersion, let pkg = s.pkgPath else { return fail("state_lost") }
    if let why = pinVerdict(version) { return fail(why.rawValue) }  // pinned while it waited
    guard let user = env.consoleUser() else { return step("deferred_no_console_user") }
    if SessionProbe.isOpen(env: env) { return step("deferred_session_open") }
    disk.touchInstallMarker()
    step("snapshotting")
    guard disk.ensureDirectory(rollbackDirectory) else { return fail("rollback_dir_unwritable") }
    let snapshot = rollbackDirectory + "/\(from).app"
    guard disk.snapshotBundle(appPath, user: user.name, to: snapshot) else { return fail("snapshot_failed") }
    guard tools.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", "=" + Self.appRequirement, snapshot]).status == 0 else {
      disk.remove(snapshot)
      return fail("snapshot_unverified")
    }
    // The room may have started a session while the copy ran. Looked at again, last, before anything changes.
    if SessionProbe.isOpen(env: env) {
      disk.remove(snapshot)
      disk.clearInstallMarker()
      return step("deferred_session_open")
    }
    let plist = directory + "/installer.plist"
    let text = Self.installerPlist(label: Self.installerLabel, pkg: pkg)
    guard disk.write(Data(text.utf8), to: plist, mode: 0o644) else { return fail("installer_job_unwritable") }
    _ = tools.run("/bin/launchctl", ["bootout", "system/\(Self.installerLabel)"])
    mutate { $0.snapshot = snapshot; $0.phase = "installing"; $0.deadline = epoch() + Int(Self.installWindow) }
    step("installing")
    guard tools.run("/bin/launchctl", ["bootstrap", "system", plist]).status == 0 else { return fail("installer_job_refused") }
  }

  static func installerPlist(label: String, pkg: String) -> String {
    """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>Label</key>
        <string>\(label)</string>
        <key>ProgramArguments</key>
        <array>
            <string>/usr/sbin/installer</string>
            <string>-pkg</string>
            <string>\(pkg)</string>
            <string>-target</string>
            <string>/</string>
        </array>
        <key>RunAtLoad</key>
        <true/>
        <key>StandardOutPath</key>
        <string>/var/log/room-recorder-helper-update.log</string>
        <key>StandardErrorPath</key>
        <string>/var/log/room-recorder-helper-update.log</string>
    </dict>
    </plist>
    """
  }

  // installing: the job runs without us; the new helper (started by the pkg's postinstall) finds this phase on disk
  private func watchInstall() {
    let s = current
    guard let version = s.version else { return fail("state_lost") }
    disk.touchInstallMarker()  // the pkg's own postinstall clears the marker on its way out; the update is not over yet
    let print = tools.run("/bin/launchctl", ["print", "system/\(Self.installerLabel)"])
    let loaded = print.status == 0
    let running = loaded && print.output.contains("state = running")
    if running, epoch() < (s.deadline ?? 0) { return }
    let exitedClean = loaded && print.output.contains("last exit code = 0")
    let installed = installedVersion()
    if loaded { _ = tools.run("/bin/launchctl", ["bootout", "system/\(Self.installerLabel)"]) }
    if installed == version, exitedClean || !loaded {
      step("installed")
      mutate { $0.phase = "restarting" }
      return
    }
    // The job ended (or ran out of time) and the bundle is not the new one. If what is there still verifies as the OLD
    // version the install changed nothing: say so. If it does not, it is half-done and the snapshot goes back.
    let stillGood = installed == s.fromVersion && tools.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", "=" + Self.appRequirement, appPath]).status == 0
    if stillGood { return fail("install_failed") }
    step("install_damaged", detail: "restoring the snapshot")
    mutate { $0.phase = "rollback_pending"; $0.result = nil }
  }

  // restarting: only outside a session
  private func restart() {
    guard let user = env.consoleUser() else { return step("deferred_no_console_user") }
    if SessionProbe.isOpen(env: env) { return step("deferred_restart_session_open") }
    let domain = "gui/\(user.uid)"
    disk.touchInstallMarker()
    var result = tools.run("/bin/launchctl", ["kickstart", "-k", "\(domain)/\(HelperPaths.agentLabel)"])
    if result.status != 0, let plist = env.agentPlistPath(uid: user.uid) {
      result = tools.run("/bin/launchctl", ["bootstrap", domain, plist])
    }
    guard result.status == 0 else { return step("restart_failed", detail: "launchctl_\(result.status)") }
    mutate { $0.restartedAt = epoch(); $0.deadline = epoch() + Int(Self.healthWindow); $0.phase = "health" }
    step("health_wait")
  }

  // health
  private func checkHealth() {
    let s = current
    guard let version = s.version else { return fail("state_lost") }
    disk.touchInstallMarker()
    if s.beatVersion == version, let beat = s.beatAt, beat >= (s.restartedAt ?? 0) {
      finish("ok", countFailure: false)
      return
    }
    guard epoch() >= (s.deadline ?? Int.max) else { return }
    step("health_failed", detail: "no beat as \(version) within \(Int(Self.healthWindow)) s")
    mutate { $0.phase = "rollback_pending" }
  }

  // rollback
  private func rollBack() {
    let s = current
    guard let snapshot = s.snapshot, let user = env.consoleUser() else {
      return s.phase == "rollback_pending" && env.consoleUser() == nil ? step("deferred_no_console_user") : fail("rollback_impossible")
    }
    let domain = "gui/\(user.uid)"
    let restore = staging + "/restore.app"
    // CRASH-SAFE (0.1.37 R2, B3). The swap is two renames: the failed bundle aside, then the restored copy in. A crash or a power
    // cut between them leaves NO app at appPath. A helper that finds `rolling_back` with nothing at appPath finishes the swap
    // from the copy it already staged, or, if that is gone too, rebuilds the copy from the snapshot first. No session can be
    // open: there is no app to run one.
    if s.phase == "rolling_back", !disk.exists(appPath) {
      step("resuming_rollback", detail: "no app at the install path")
      if !disk.exists(restore) {
        guard disk.exists(snapshot), disk.ensureDirectory(staging),
          tools.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", "=" + Self.appRequirement, snapshot]).status == 0,
          disk.restoreTree(from: snapshot, to: restore, uid: user.uid, gid: user.gid)
        else { return finish("failed", reason: "no_app_and_no_snapshot", countFailure: true) }
      }
      guard disk.rename(restore, to: appPath) else { return finish("failed", reason: "restore_rename_failed", countFailure: true) }
      return restoredNow(domain: domain, user: user)
    }
    if SessionProbe.isOpen(env: env) { return step("rollback_deferred_session_open") }
    disk.touchInstallMarker()
    mutate { $0.phase = "rolling_back" }
    step("rolling_back")
    guard disk.exists(snapshot),
      tools.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", "=" + Self.appRequirement, snapshot]).status == 0
    else { return finish("failed", reason: "snapshot_missing_or_invalid", countFailure: true) }
    guard disk.ensureDirectory(staging), disk.restoreTree(from: snapshot, to: restore, uid: user.uid, gid: user.gid) else {
      return finish("failed", reason: "restore_copy_failed", countFailure: true)
    }
    // The copy and the verify above took seconds, and a consultation may have started in them. LOOKED AT AGAIN, last, before the
    // first thing that touches the running app (B1): the bootout below stops the recorder.
    if SessionProbe.isOpen(env: env) {
      disk.remove(restore)
      mutate { $0.phase = "rollback_pending" }
      return step("rollback_deferred_session_open")
    }
    _ = tools.run("/bin/launchctl", ["bootout", "\(domain)/\(HelperPaths.agentLabel)"])
    let failedAside = rollbackDirectory + "/failed-\(s.version ?? "unknown").app"
    disk.remove(failedAside)
    guard disk.rename(appPath, to: failedAside) else { return finish("failed", reason: "bundle_not_moved_aside", countFailure: true) }
    // <- a crash here leaves no app; the branch at the top finishes the swap on the next start
    guard disk.rename(restore, to: appPath) else {
      _ = disk.rename(failedAside, to: appPath)
      return finish("failed", reason: "restore_rename_failed", countFailure: true)
    }
    restoredNow(domain: domain, user: user)
  }

  private func restoredNow(domain: String, user: (uid: UInt32, gid: UInt32, name: String)) {
    if let plist = env.agentPlistPath(uid: user.uid) { _ = tools.run("/bin/launchctl", ["bootstrap", domain, plist]) }
    mutate { $0.phase = "rollback_health"; $0.restartedAt = epoch(); $0.deadline = epoch() + Int(Self.healthWindow) }
    step("restored")
  }

  private func checkRollbackHealth() {
    let s = current
    disk.touchInstallMarker()
    if let from = s.fromVersion, s.beatVersion == from, let beat = s.beatAt, beat >= (s.restartedAt ?? 0) {
      finish("rolled_back", reason: "health_failed", countFailure: true)
      return
    }
    guard epoch() >= (s.deadline ?? Int.max) else { return }
    finish("failed", reason: "rollback_unhealthy", countFailure: true)
  }
}

/// `offered` is newer than `running`. The user-level updater's rule, shared.
public func roomUpdateNewer(offered: String, running: String) -> Bool {
  guard let have = RoomVersion(running), let want = RoomVersion(offered) else { return false }
  return want > have
}

extension BundleUpdater: UpdateRelay {
  public func offerUpdate(record: String, signature: String, deviceID: String, machine: String) -> String {
    let offer = self.offer(recordJSON: record, signature: signature, deviceID: deviceID, machine: machine)
    switch offer {
    case .accepted:
      // The long part (download, verify) runs off the XPC thread.
      DispatchQueue.global().async { [self] in tick() }
      return "accepted"
    case .inProgress: return "in_progress"
    case .refused(let why): return "refused:\(why.rawValue)"
    }
  }

  public func noteAppBeat(version: String) { appBeat(version: version) }
}
