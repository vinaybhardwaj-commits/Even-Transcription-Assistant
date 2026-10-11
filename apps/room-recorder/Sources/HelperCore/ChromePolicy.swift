import Darwin
import FleetCore
import Foundation

/// #44 (TS-H7): the helper keeps the Chrome enterprise policy for the Pulse Presence extension in place.
///
/// macOS wipes `/Library/Managed Preferences/com.google.Chrome.plist` at boot. This is the port of the standalone
/// presence-guard: rewrite `ExtensionInstallForcelist` (our entry only) and the extension's own `3rdparty` config
/// every 60 s and in a tighter loop for the first 300 s after boot, `killall cfprefsd` after a change, and a relaunch
/// rung. Every other key in the file stays exactly as it was.
///
/// What it never does: read a profile's cookies, tokens or Preferences (the only things read under a user's home are
/// directory NAMES, through the room user's own credentials), put the token in a log line or an event, or restart
/// Chrome between 07:30 and 21:30 IST.
public enum ChromePolicy {
  public static let extensionID = "choegfgddhpljibnolbcljnlfhfpimbh"
  public static let managedPlistPath = "/Library/Managed Preferences/com.google.Chrome.plist"
  public static let pulseURL = "https://pulse.even.in/"
  public static let configFile = "helper-chrome-policy.json"
  public static let stateFile = "helper-chrome-policy-state.json"
  /// The first 300 s after boot, macOS regenerates the managed preferences; check every 10 s until two checks in a row are clean.
  public static let bootWindow: TimeInterval = 300
  public static let bootLoopDelay: TimeInterval = 10
  public static let steadyDelay: TimeInterval = 60
  /// Under this much uptime a missing entry is labelled `boot`, not `missing`.
  public static let bootLabelWindow: TimeInterval = 180
  /// Relaunch rung: the last rewrite must be at least this old.
  public static let rewriteMinAge: TimeInterval = 180
  public static let idleThreshold: TimeInterval = 600
  public static let relaunchSpacing: TimeInterval = 30 * 60
  /// `rewrite_failed` events per boot, so a file that cannot be written does not flood the sink.
  public static let failedEventCap = 3
  public static let chromeApp = "/Applications/Google Chrome.app"
  public static let chromeBinary = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  public static let userDataSuffix = "/Library/Application Support/Google/Chrome"

  public static func defaultUpdateURL(machineID: String) -> String {
    "https://www.evenscribe.app/ext/\(machineID)/update.xml"
  }
}

/// What the extension needs to know about this Mac. The token is a secret: this type never prints it.
public struct ChromePolicyConfig: Codable, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
  public var machineID: String
  public var room: String
  public var token: String
  public var updateURL: String

  enum CodingKeys: String, CodingKey {
    case machineID = "machine_id"
    case room, token
    case updateURL = "update_url"
  }

  public init(machineID: String, room: String, token: String, updateURL: String? = nil) {
    self.machineID = machineID
    self.room = room
    self.token = token
    self.updateURL = updateURL ?? ChromePolicy.defaultUpdateURL(machineID: machineID)
  }

  /// From params that already passed `FleetVerb.parseParams`.
  public init?(params: FleetParams) {
    guard let machine = params.raw["machine_id"]?.stringValue, let room = params.raw["room"]?.stringValue,
      let token = params.raw["token"]?.stringValue
    else { return nil }
    self.init(machineID: machine, room: room, token: token, updateURL: params.raw["update_url"]?.stringValue)
  }

  /// `ExtensionInstallForcelist` entry: `<extension id>;<update url>`.
  public var forcelistEntry: String { "\(ChromePolicy.extensionID);\(updateURL)" }

  public var description: String { "ChromePolicyConfig(machine_id: \(machineID), room: \(room), token: <redacted>)" }
  public var debugDescription: String { description }
}

/// The managed plist, as data. Pure: no file is touched here.
public enum ChromePolicyPlist {
  static let forcelistKey = "ExtensionInstallForcelist"
  static let thirdPartyKey = "3rdparty"

  /// A dictionary from plist bytes (XML or binary), or nil when it does not parse as one.
  static func dictionary(_ data: Data?) -> [String: Any]? {
    guard let data, !data.isEmpty,
      let object = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)
    else { return nil }
    return object as? [String: Any]
  }

  static func extensionConfig(_ config: ChromePolicyConfig) -> [String: Any] {
    ["machine_id": config.machineID, "room": config.room, "token": config.token]
  }

  /// Why the file needs a rewrite: `missing` (no file), `stripped` (a file without our current entry), nil when it is right.
  public static func drift(_ data: Data?, config: ChromePolicyConfig) -> String? {
    guard let data else { return "missing" }
    guard let dict = dictionary(data) else { return "stripped" }
    let list = (dict[forcelistKey] as? [Any]) ?? []
    let ours = list.compactMap { $0 as? String }.filter { $0.hasPrefix(ChromePolicy.extensionID + ";") || $0 == ChromePolicy.extensionID }
    guard ours == [config.forcelistEntry] else { return "stripped" }
    let extensions = ((dict[thirdPartyKey] as? [String: Any])?["extensions"] as? [String: Any]) ?? [:]
    guard let current = extensions[ChromePolicy.extensionID] as? [String: Any],
      current["machine_id"] as? String == config.machineID, current["room"] as? String == config.room,
      current["token"] as? String == config.token
    else { return "stripped" }
    return nil
  }

  /// The new file: everything already in it, except that OUR forcelist entry (any entry for our extension id) is replaced
  /// by the current one, appended last, and our `3rdparty.extensions.<id>` block is set. Other keys, other forcelist
  /// entries and other extensions' `3rdparty` blocks are untouched. A file that does not parse is started afresh.
  public static func merged(existing: Data?, config: ChromePolicyConfig) -> Data? {
    var dict = dictionary(existing) ?? [:]
    var list = (dict[forcelistKey] as? [Any]) ?? []
    list.removeAll { entry in
      guard let text = entry as? String else { return false }
      return text == ChromePolicy.extensionID || text.hasPrefix(ChromePolicy.extensionID + ";")
    }
    list.append(config.forcelistEntry)
    dict[forcelistKey] = list
    var thirdParty = (dict[thirdPartyKey] as? [String: Any]) ?? [:]
    var extensions = (thirdParty["extensions"] as? [String: Any]) ?? [:]
    extensions[ChromePolicy.extensionID] = extensionConfig(config)
    thirdParty["extensions"] = extensions
    dict[thirdPartyKey] = thirdParty
    return try? PropertyListSerialization.data(fromPropertyList: dict, format: .xml, options: 0)
  }
}

/// Root-owned files the policy keeps and writes: the managed plist, the helper's config and its state.
public protocol ChromePolicyFiles: Sendable {
  /// A plain file's bytes, nil when missing, unreadable, not a plain file or a symlink.
  func read(_ path: String) -> Data?
  /// Temp file in the same directory, fsync, owner root:wheel, `mode`, then rename. False on any failure; the original is untouched.
  func writeAtomic(_ path: String, data: Data, mode: UInt16) -> Bool
}

public struct SystemChromePolicyFiles: ChromePolicyFiles {
  /// False in tests, which cannot become root.
  let setOwner: Bool
  public init(setOwner: Bool = true) { self.setOwner = setOwner }

  public func read(_ path: String) -> Data? {
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= 4 * 1024 * 1024 else { return nil }
    return FileManager.default.contents(atPath: path)
  }

  public func writeAtomic(_ path: String, data: Data, mode: UInt16) -> Bool {
    let directory = (path as NSString).deletingLastPathComponent
    var info = stat()
    if lstat(path, &info) == 0, (info.st_mode & S_IFMT) != S_IFREG { return false }  // a symlink or a directory: not ours to replace
    do { try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true) } catch { return false }
    let temporary = directory + "/." + (path as NSString).lastPathComponent + ".tmp." + UUID().uuidString
    let fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { return false }
    let written = data.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    let ownerOK = !setOwner || fchown(fd, 0, 0) == 0
    let finished = written == data.count && fsync(fd) == 0 && fchmod(fd, mode_t(mode)) == 0 && ownerOK
    close(fd)
    guard finished, rename(temporary, path) == 0 else {
      unlink(temporary)
      return false
    }
    return true
  }
}

/// What the policy remembers between ticks and restarts (root-only).
public struct ChromePolicyState: Codable, Equatable, Sendable {
  public var lastRewrite: Int?
  public var lastRelaunch: Int?
  /// The `lastRewrite` the last relaunch answered, so one rewrite buys at most one relaunch.
  public var lastRelaunchRewrite: Int?
  /// Epoch seconds of the last check that found the policy right, and of the last one that did not.
  public var lastOKAt: Int?
  public var lastStatus: String?
  /// `rewrite_failed` events sent this boot: `<boot seconds> <count>`.
  public var failedEvents: String?

  enum CodingKeys: String, CodingKey {
    case lastRewrite = "last_rewrite"
    case lastRelaunch = "last_relaunch"
    case lastRelaunchRewrite = "last_relaunch_rewrite"
    case lastOKAt = "last_ok_at"
    case lastStatus = "last_status"
    case failedEvents = "failed_events"
  }

  public init() {}
}

/// An event the helper wants on the kiosk-health sink. Fields are plain JSON values and never hold a secret.
public struct HelperEvent: Equatable, Sendable {
  public var kind: String
  public var fields: [String: FleetJSON]
  public init(_ kind: String, _ fields: [String: FleetJSON] = [:]) {
    self.kind = kind
    self.fields = fields
  }
}

public enum PolicyCheck: String, Equatable, Sendable {
  case noConfig = "no_config"
  case ok
  case rewrote
  case failed
}

/// `ioreg -c IOHIDSystem`: the console's idle time.
public enum HIDIdle {
  /// Whole seconds of idle time, or nil when the output has no `HIDIdleTime`.
  public static func seconds(fromIORegOutput output: String) -> Int? {
    for line in output.split(separator: "\n") where line.contains("\"HIDIdleTime\"") {
      guard let value = line.split(separator: " ").last, let nanoseconds = UInt64(value) else { continue }
      return Int(nanoseconds / 1_000_000_000)
    }
    return nil
  }
}

extension HelperProcessScan {
  /// The main Chrome process of `uid` (not its helper processes, which carry `--type=` and live under Frameworks).
  public static func chromePIDs(psOutput: String, uid: UInt32) -> [Int32] {
    var pids: [Int32] = []
    for line in psOutput.split(separator: "\n") {
      let parts = line.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
      guard parts.count == 3, let pid = Int32(parts[0]), UInt32(parts[1]) == uid else { continue }
      let command = String(parts[2])
      if command.contains("Google Chrome.app/Contents/MacOS/Google Chrome"), !command.contains("--type=") { pids.append(pid) }
    }
    return pids
  }
}

public enum RelaunchDecision: Equatable, Sendable {
  case go(basis: String)
  /// The first condition that did not hold.
  case no(String)
}

/// Reads the policy, rewrites it when it drifts, and restarts Chrome when the extension is gone and nobody is there.
public final class ChromePolicyReconciler: @unchecked Sendable {
  private let files: ChromePolicyFiles
  private let tools: SystemTools
  private let env: HelperEnvironment
  private let plistPath: String
  private let configPath: String
  private let statePath: String
  private let bootTime: @Sendable () -> Date?
  private let sleep: @Sendable (TimeInterval) -> Void
  private let signalProcess: @Sendable (Int32, Int32) -> Int32
  private let emit: @Sendable (HelperEvent) -> Void
  private let log: @Sendable (String) -> Void
  private let lock = NSLock()
  private var consecutiveOK = 0

  public init(
    files: ChromePolicyFiles = SystemChromePolicyFiles(), tools: SystemTools, env: HelperEnvironment,
    plistPath: String = ChromePolicy.managedPlistPath,
    configPath: String = HelperPaths.supportDirectory + "/" + ChromePolicy.configFile,
    statePath: String = HelperPaths.supportDirectory + "/" + ChromePolicy.stateFile,
    bootTime: @escaping @Sendable () -> Date? = ChromePolicyReconciler.systemBootTime,
    sleep: @escaping @Sendable (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) },
    signalProcess: @escaping @Sendable (Int32, Int32) -> Int32 = { kill($0, $1) },
    emit: @escaping @Sendable (HelperEvent) -> Void = { _ in }, log: @escaping @Sendable (String) -> Void
  ) {
    self.files = files
    self.tools = tools
    self.env = env
    self.plistPath = plistPath
    self.configPath = configPath
    self.statePath = statePath
    self.bootTime = bootTime
    self.sleep = sleep
    self.signalProcess = signalProcess
    self.emit = emit
    self.log = log
  }

  public static let systemBootTime: @Sendable () -> Date? = {
    var value = timeval()
    var size = MemoryLayout<timeval>.size
    guard sysctlbyname("kern.boottime", &value, &size, nil, 0) == 0 else { return nil }
    return Date(timeIntervalSince1970: TimeInterval(value.tv_sec))
  }

  // MARK: Config and state (root-only files)

  public func loadConfig() -> ChromePolicyConfig? {
    files.read(configPath).flatMap { try? JSONDecoder().decode(ChromePolicyConfig.self, from: $0) }
  }

  func saveConfig(_ config: ChromePolicyConfig) -> Bool {
    guard let data = try? JSONEncoder().encode(config) else { return false }
    return files.writeAtomic(configPath, data: data, mode: 0o600)
  }

  public func loadState() -> ChromePolicyState {
    files.read(statePath).flatMap { try? JSONDecoder().decode(ChromePolicyState.self, from: $0) } ?? ChromePolicyState()
  }

  private func saveState(_ state: ChromePolicyState) {
    guard let data = try? JSONEncoder().encode(state) else { return }
    _ = files.writeAtomic(statePath, data: data, mode: 0o600)
  }

  private func uptime() -> TimeInterval? { bootTime().map { env.now().timeIntervalSince($0) } }

  // MARK: The check

  /// One pass: is the policy in the managed plist, and if not, put it back.
  @discardableResult
  public func check() -> PolicyCheck {
    lock.lock(); defer { lock.unlock() }
    guard let config = loadConfig() else { return .noConfig }
    let existing = files.read(plistPath)
    var state = loadState()
    let epoch = Int(env.now().timeIntervalSince1970)
    guard var reason = ChromePolicyPlist.drift(existing, config: config) else {
      consecutiveOK += 1
      state.lastOKAt = epoch
      state.lastStatus = "ok"
      saveState(state)
      return .ok
    }
    consecutiveOK = 0
    if let up = uptime(), up < ChromePolicy.bootLabelWindow { reason = "boot" }
    guard let data = ChromePolicyPlist.merged(existing: existing, config: config),
      files.writeAtomic(plistPath, data: data, mode: 0o644)
    else {
      log("chrome policy: rewrite failed (\(reason))")
      state.lastStatus = "rewrite_failed"
      if failedEventAllowed(&state) { emit(HelperEvent("chrome.policy", ["reason": .string("rewrite_failed"), "machine_id": .string(config.machineID)])) }
      saveState(state)
      return .failed
    }
    _ = tools.run("/usr/bin/killall", ["cfprefsd"])
    state.lastRewrite = epoch
    state.lastOKAt = epoch  // the file was just written and is right
    state.lastStatus = "rewrote"
    saveState(state)
    log("chrome policy: rewrote the managed plist (\(reason))")
    emit(HelperEvent("chrome.policy", ["reason": .string(reason), "machine_id": .string(config.machineID)]))
    return .rewrote
  }

  /// `rewrite_failed` events are capped per boot.
  private func failedEventAllowed(_ state: inout ChromePolicyState) -> Bool {
    let boot = bootTime().map { String(Int($0.timeIntervalSince1970)) } ?? "unknown"
    let parts = (state.failedEvents ?? "").split(separator: " ").map(String.init)
    let count = (parts.count == 2 && parts[0] == boot) ? (Int(parts[1]) ?? 0) : 0
    guard count < ChromePolicy.failedEventCap else { return false }
    state.failedEvents = "\(boot) \(count + 1)"
    return true
  }

  /// Ten seconds while the boot race can still wipe the file (first 300 s, until two clean checks in a row), else a minute.
  public func nextDelay() -> TimeInterval {
    lock.lock(); defer { lock.unlock() }
    guard let up = uptime() else { return ChromePolicy.steadyDelay }
    return (up < ChromePolicy.bootWindow && consecutiveOK < 2) ? ChromePolicy.bootLoopDelay : ChromePolicy.steadyDelay
  }

  /// "Active" for the retirement of the standalone guard: a config is stored and the last check, no older than
  /// `within` seconds, found the live file right. Verified against the file now, not only the stored status.
  public func isActive(within: TimeInterval = 300) -> Bool {
    guard let config = loadConfig(), ChromePolicyPlist.drift(files.read(plistPath), config: config) == nil else { return false }
    guard let at = loadState().lastOKAt else { return false }
    return env.now().timeIntervalSince1970 - TimeInterval(at) <= within
  }

  public var statusWord: String {
    guard loadConfig() != nil else { return "no_config" }
    return loadState().lastStatus ?? "unchecked"
  }

  // MARK: Chrome, as the room user

  private func consoleUserName() -> (uid: UInt32, gid: UInt32, name: String)? {
    guard let user = env.consoleUser(), user.name.range(of: "^[A-Za-z0-9._-]{1,64}$", options: .regularExpression) != nil else { return nil }
    return user
  }

  private func chromePIDs(uid: UInt32) -> [Int32] {
    let result = tools.run("/bin/ps", ["-axww", "-o", "pid=,uid=,command="])
    return result.status == 0 ? HelperProcessScan.chromePIDs(psOutput: result.output, uid: uid) : []
  }

  /// Does any profile of the user have the extension installed? Directory names only. Nil when it cannot be told.
  func extensionInstalled(user: (uid: UInt32, gid: UInt32, name: String)) -> Bool? {
    guard let home = env.homeDirectory(uid: user.uid) else { return nil }
    let base = home + ChromePolicy.userDataSuffix
    guard let profiles = env.userDirectoryEntries(base, uid: user.uid, gid: user.gid) else { return nil }
    for profile in profiles where FleetVerb.isChromeProfile(profile) {
      let entries = env.userDirectoryEntries("\(base)/\(profile)/Extensions/\(ChromePolicy.extensionID)", uid: user.uid, gid: user.gid)
      if let entries, !entries.isEmpty { return true }
    }
    return false
  }

  func hidIdleSeconds() -> Int? {
    let result = tools.run("/usr/sbin/ioreg", ["-c", "IOHIDSystem"])
    return result.status == 0 ? HIDIdle.seconds(fromIORegOutput: result.output) : nil
  }

  /// The relaunch rung's decision, with the first condition that failed. Never acts.
  public func relaunchDecision() -> RelaunchDecision {
    guard loadConfig() != nil else { return .no("no_config") }
    let state = loadState()
    let now = Int(env.now().timeIntervalSince1970)
    guard let last = state.lastRewrite else { return .no("no_last_rewrite") }
    if TimeInterval(now - last) < ChromePolicy.rewriteMinAge { return .no("last_rewrite_under_3min") }
    if state.lastRelaunchRewrite == last { return .no("already_relaunched_for_this_rewrite") }
    if FleetClock.inClinicHours(env.now()) { return .no("clinic_hours") }
    guard let user = consoleUserName() else { return .no("no_console_user") }
    guard let installed = extensionInstalled(user: user) else { return .no("presence_unknown") }
    if installed { return .no("extension_present") }
    guard let idle = hidIdleSeconds() else { return .no("idle_unknown") }
    if idle <= Int(ChromePolicy.idleThreshold) { return .no("not_idle_\(idle)s") }
    if let relaunched = state.lastRelaunch, TimeInterval(now - relaunched) < ChromePolicy.relaunchSpacing { return .no("relaunch_under_30min") }
    return .go(basis: "fallback")
  }

  /// The autonomous rung: after a check, restart Chrome when every condition holds.
  @discardableResult
  public func relaunchIfDue() -> RelaunchDecision {
    let decision = relaunchDecision()
    guard case .go = decision, let user = consoleUserName() else { return decision }
    lock.lock()
    var state = loadState()
    state.lastRelaunch = Int(env.now().timeIntervalSince1970)
    state.lastRelaunchRewrite = state.lastRewrite
    saveState(state)
    lock.unlock()
    let outcome = restartChrome(user: user, profile: nil)
    log("chrome policy: relaunch \(outcome.ok ? outcome.method : "failed")")
    emit(HelperEvent("chrome.policy", ["reason": .string("relaunch"), "method": .string(outcome.method)]))
    return decision
  }

  struct RestartOutcome {
    var ok: Bool
    var method: String
  }

  /// Quit Chrome (SIGTERM, up to 15 s, then SIGKILL) and open it again as the room user. The room user's session restores the tabs.
  func restartChrome(user: (uid: UInt32, gid: UInt32, name: String), profile: String?) -> RestartOutcome {
    var method = "open"
    var pids = chromePIDs(uid: user.uid)
    if !pids.isEmpty {
      method = "term"
      for pid in pids { _ = signalProcess(pid, SIGTERM) }
      var polls = 0
      while polls < 15 {
        pids = chromePIDs(uid: user.uid)
        if pids.isEmpty { break }
        sleep(1)
        polls += 1
      }
      if !pids.isEmpty {
        method = "kill"
        for pid in pids { _ = signalProcess(pid, SIGKILL) }
        sleep(1)
      }
    }
    var arguments = ["-a", "Google Chrome"]
    if let profile { arguments += ["--args", "--profile-directory=\(profile)", ChromePolicy.pulseURL] } else { arguments += [ChromePolicy.pulseURL] }
    let result = tools.run(
      "/bin/launchctl", ["asuser", String(user.uid), "/usr/bin/sudo", "-u", user.name, "/usr/bin/open"] + arguments)
    return RestartOutcome(ok: result.status == 0, method: method)
  }

  // MARK: The verbs

  public func apply(_ config: ChromePolicyConfig) -> HelperCommandOutcome {
    guard saveConfig(config) else { return HelperCommandOutcome(.failed, reason: "config_not_saved") }
    switch check() {
    case .ok: return HelperCommandOutcome(.ok, detail: ["rewrote": .bool(false)])
    case .rewrote: return HelperCommandOutcome(.ok, detail: ["rewrote": .bool(true)])
    case .failed, .noConfig: return HelperCommandOutcome(.failed, reason: "policy_not_written")
    }
  }

  public func relaunch(profile: String?) -> HelperCommandOutcome {
    guard let user = consoleUserName() else { return HelperCommandOutcome(.failed, reason: FleetRefusal.noConsoleUser.rawValue) }
    let outcome = restartChrome(user: user, profile: profile)
    emit(HelperEvent("chrome.policy", ["reason": .string("chrome_relaunch"), "method": .string(outcome.method)]))
    return outcome.ok
      ? HelperCommandOutcome(.ok, detail: ["method": .string(outcome.method)])
      : HelperCommandOutcome(.failed, reason: "open_failed", detail: ["method": .string(outcome.method)])
  }

  public func openPulse(profile: String) -> HelperCommandOutcome {
    guard let user = consoleUserName() else { return HelperCommandOutcome(.failed, reason: FleetRefusal.noConsoleUser.rawValue) }
    guard !chromePIDs(uid: user.uid).isEmpty else { return HelperCommandOutcome(.failed, reason: "chrome_not_running") }
    guard let home = env.homeDirectory(uid: user.uid),
      env.userDirectoryEntries(home + ChromePolicy.userDataSuffix, uid: user.uid, gid: user.gid)?.contains(profile) == true
    else { return HelperCommandOutcome(.failed, reason: "profile_not_found") }
    // With Chrome running, its binary hands the request to the running instance and exits at once.
    let result = tools.run(
      "/bin/launchctl",
      ["asuser", String(user.uid), "/usr/bin/sudo", "-u", user.name, ChromePolicy.chromeBinary, "--profile-directory=\(profile)", ChromePolicy.pulseURL])
    emit(HelperEvent("chrome.policy", ["reason": .string("window_open"), "profile": .string(profile)]))
    return result.status == 0 ? HelperCommandOutcome(.ok) : HelperCommandOutcome(.failed, reason: "open_failed")
  }

  /// Policy, then `cfprefsd`, then a Chrome restart: what a person would do by hand to make Chrome re-read policy.
  public func cycle(profile: String?) -> HelperCommandOutcome {
    guard loadConfig() != nil else { return HelperCommandOutcome(.failed, reason: "no_config") }
    guard let user = consoleUserName() else { return HelperCommandOutcome(.failed, reason: FleetRefusal.noConsoleUser.rawValue) }
    let checked = check()
    guard checked == .ok || checked == .rewrote else { return HelperCommandOutcome(.failed, reason: "policy_not_written") }
    _ = tools.run("/usr/bin/killall", ["cfprefsd"])
    let outcome = restartChrome(user: user, profile: profile)
    emit(HelperEvent("chrome.policy", ["reason": .string("policy_cycle"), "method": .string(outcome.method)]))
    return outcome.ok
      ? HelperCommandOutcome(.ok, detail: ["rewrote": .bool(checked == .rewrote), "method": .string(outcome.method)])
      : HelperCommandOutcome(.failed, reason: "open_failed", detail: ["rewrote": .bool(checked == .rewrote)])
  }
}
