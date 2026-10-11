import Foundation

/// #46: the root helper keeps the recorder app running.
///
/// Every 30 s: is there a console user, is the app process there? If the app is missing the helper puts the
/// LaunchAgent plist back when it is gone, then `bootstrap`s it (or, if launchd says it is already loaded,
/// `kickstart`s it WITHOUT -k). Backoff 30 s, 60, 120, 240, then 5 min. It never fights:
///  · a recorder that stopped on purpose: `status.json` says `needs_enrol`;
///  · an operator: a `watchdog-hold` file in the app's root;
///  · an update in flight: `update-handover.json` younger than the 30 minute grace;
///  · the helper's own kill file (the helper does not run at all then).
/// At the login window there is nobody to run the app for, so it does nothing and reports `no_console_user`.
public enum WatchdogAppState: String, Equatable, Sendable {
  case running
  case missing
  case restarting
  case noConsoleUser = "no_console_user"
  case needsEnrol = "needs_enrol"
  case held
  case updating
}

public final class AppWatchdog: @unchecked Sendable {
  public static let baseDelay: TimeInterval = 30
  public static let maxDelay: TimeInterval = 300
  public static let handoverGrace: TimeInterval = 30 * 60

  private let env: HelperEnvironment
  private let tools: SystemTools
  private let appExecutable: String
  private let log: @Sendable (String) -> Void
  private let lock = NSLock()
  private var failures = 0
  private var nextAttempt: Date?
  private var last: WatchdogAppState = .missing

  public init(
    env: HelperEnvironment, tools: SystemTools,
    appExecutable: String = "/Applications/EvenScribe Room Recorder.app/Contents/MacOS/room-recorder",
    log: @escaping @Sendable (String) -> Void
  ) {
    self.env = env
    self.tools = tools
    self.appExecutable = appExecutable
    self.log = log
  }

  public var lastState: WatchdogAppState { lock.lock(); defer { lock.unlock() }; return last }
  public var consecutiveFailures: Int { lock.lock(); defer { lock.unlock() }; return failures }

  /// Delay after the Nth consecutive failed attempt: 30, 60, 120, 240, 300, 300 ...
  public static func delay(afterFailures n: Int) -> TimeInterval {
    min(baseDelay * pow(2, Double(max(n - 1, 0))), maxDelay)
  }

  @discardableResult
  public func tick() -> WatchdogAppState {
    let state = evaluate()
    lock.lock(); last = state; lock.unlock()
    return state
  }

  private func evaluate() -> WatchdogAppState {
    guard let user = env.consoleUser() else {
      reset()
      return .noConsoleUser
    }
    if env.appRunning(uid: user.uid) {
      reset()
      return .running
    }
    guard let root = env.roomRoot(uid: user.uid), let plist = env.agentPlistPath(uid: user.uid) else { return .missing }
    if AppStatusSnapshot.read(env: env, root: root, uid: user.uid, gid: user.gid)?.needsEnrol == true { return .needsEnrol }
    // The hold and the handover marker live in the room user's own directory: the room user is the operator of
    // this Mac, so being able to hold the watchdog is a feature (see INSTALL.md), and every read is done AS them.
    if env.userFileKind(root + "/watchdog-hold", uid: user.uid, gid: user.gid) != .missing { return .held }
    if let age = env.userFileAge(root + "/update-handover.json", uid: user.uid, gid: user.gid), age < Self.handoverGrace {
      return .updating
    }

    let now = env.now()
    lock.lock()
    let waiting = nextAttempt.map { now < $0 } ?? false
    lock.unlock()
    if waiting { return .missing }

    // The plist is the room user's file. Root never writes it as root, never follows a symlink to it, and never
    // loads one that is not a plain file.
    switch env.userFileKind(plist, uid: user.uid, gid: user.gid) {
    case .regular:
      break
    case .symlink, .other:
      log("watchdog: the LaunchAgent plist is not a plain file; not touching it")
      return fail(now)
    case .missing:
      let logPath = root + "/launchd.log"
      guard let data = LaunchAgentPlist.data(executablePath: appExecutable, rootPath: root, logPath: logPath) else {
        return fail(now)
      }
      switch env.writeUserFile(plist, data: data, uid: user.uid, gid: user.gid) {
      case .written:
        log("watchdog: restored the missing LaunchAgent plist")
      case .refusedUnsafePath:
        log("watchdog: the LaunchAgent plist path is not safe to write (a symlink on the way); refused")
        return fail(now)
      case .failed:
        log("watchdog: the LaunchAgent plist is missing and could not be rewritten")
        return fail(now)
      }
    }
    let domain = "gui/\(user.uid)"
    var result = tools.run("/bin/launchctl", ["bootstrap", domain, plist])
    if result.status != 0 {
      // Already loaded (error 5 or 37): it is there but not running. Start it, without -k.
      result = tools.run("/bin/launchctl", ["kickstart", "\(domain)/\(HelperPaths.agentLabel)"])
    }
    log("watchdog: app missing for uid \(user.uid); relaunch \(result.status == 0 ? "requested" : "failed (\(result.status))")")
    _ = fail(now)
    return .restarting
  }

  private func fail(_ now: Date) -> WatchdogAppState {
    lock.lock()
    failures += 1
    nextAttempt = now.addingTimeInterval(Self.delay(afterFailures: failures))
    lock.unlock()
    return .missing
  }

  private func reset() {
    lock.lock()
    failures = 0
    nextAttempt = nil
    lock.unlock()
  }
}
