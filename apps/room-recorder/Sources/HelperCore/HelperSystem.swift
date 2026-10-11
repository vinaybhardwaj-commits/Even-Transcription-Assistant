import Darwin
import FleetCore
import Foundation

/// Where the root helper keeps its own files. All of it is root-owned; none of it is writable by a room user.
public enum HelperPaths {
  public static let supportDirectory = HelperIdentity.supportDirectory
  public static let fleetStateFile = "helper-fleet-state.json"
  public static let heartbeatFile = "helper-heartbeat.json"
  /// The scheduled power-on time the last `schedule_poweron` set; absent means the default 07:05.
  public static let powerTimeFile = "helper-power-time"
  public static let agentLabel = "com.evenscribe.room-recorder"
}

public struct ToolResult: Equatable, Sendable {
  public var status: Int32
  public var output: String
  public init(status: Int32, output: String = "") {
    self.status = status
    self.output = output
  }
}

/// Every command the helper runs goes through here: a fixed absolute executable and an argument VECTOR. There is
/// no shell and no string is ever parsed as a command line. A test replaces this with a recorder.
public protocol SystemTools: Sendable {
  func run(_ executable: String, _ arguments: [String]) -> ToolResult
}

public struct ProcessSystemTools: SystemTools {
  /// The only programs the helper will start. Anything else answers 127 without running.
  /// `chown` is deliberately NOT here (0.1.35 R2): the helper writes a user's files as that user and never changes
  /// ownership of anything by path.
  public static let allowed: Set<String> = ["/bin/launchctl", "/usr/bin/pmset", "/usr/bin/caffeinate", "/bin/ps"]
  public var timeout: TimeInterval = 30
  public init(timeout: TimeInterval = 30) { self.timeout = timeout }

  public func run(_ executable: String, _ arguments: [String]) -> ToolResult {
    guard Self.allowed.contains(executable) else { return ToolResult(status: 127, output: "not allowed") }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    do { try process.run() } catch { return ToolResult(status: 126, output: "\(error)") }
    let deadline = DispatchTime.now() + timeout
    let finished = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
      process.waitUntilExit()
      finished.signal()
    }
    if finished.wait(timeout: deadline) == .timedOut {
      process.terminate()
      return ToolResult(status: 124, output: "timed out")
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    return ToolResult(status: process.terminationStatus, output: String(decoding: data, as: UTF8.self))
  }
}

public enum UserFileKind: Equatable, Sendable {
  case missing, regular, symlink, other
}

public enum UserWriteResult: Equatable, Sendable {
  case written
  /// The path, one of its parents, or the existing file is not what a safe write needs (a symlink, a
  /// directory that is not the user's, a path outside the home). Nothing was written.
  case refusedUnsafePath
  case failed
}

/// Runs a closure with the ROOM USER's credentials, so the kernel enforces that user's own permissions on every
/// file operation inside it. The helper is root; it must never touch a path under a user's home as root, because
/// the user controls those paths (a symlink swapped in between a check and a use steers root's write).
///
/// Production uses a dedicated thread with `pthread_setugid_np`. It REFUSES (returns nil) if it cannot drop: it
/// never falls back to running the body as root.
public protocol UserContext: Sendable {
  func run<T: Sendable>(uid: UInt32, gid: UInt32, _ body: @escaping @Sendable () -> T) -> T?
}

@_silgen_name("pthread_setugid_np") private func pthread_setugid_np(_ uid: UInt32, _ gid: UInt32) -> Int32

final class UserContextBox<T: Sendable>: @unchecked Sendable { var value: T? }

public struct ThreadUserContext: UserContext {
  /// `KAUTH_UID_NONE` / `KAUTH_GID_NONE` from <sys/kauth.h>: "this thread has no private identity".
  static let none = UInt32.max - 100
  public init() {}

  public func run<T: Sendable>(uid: UInt32, gid: UInt32, _ body: @escaping @Sendable () -> T) -> T? {
    guard uid != 0 else { return nil }  // never as root
    let box = UserContextBox<T>()
    let done = DispatchSemaphore(value: 0)
    let thread = Thread {
      defer { done.signal() }
      guard pthread_setugid_np(uid, gid) == 0 else { return }  // not root, or refused: do NOTHING
      box.value = body()
      _ = pthread_setugid_np(Self.none, Self.none)
    }
    thread.start()
    done.wait()
    return box.value
  }
}

/// What the helper needs to know about the machine and the room user's session.
///
/// Every file operation on a USER's path takes the user's uid and gid and is done AS that user.
public protocol HelperEnvironment: Sendable {
  /// The user at the console, or nil at the login window.
  func consoleUser() -> (uid: UInt32, gid: UInt32, name: String)?
  func appRunning(uid: UInt32) -> Bool
  func now() -> Date
  func homeDirectory(uid: UInt32) -> String?
  /// `lstat` as the user: a symlink is reported as a symlink, never followed.
  func userFileKind(_ path: String, uid: UInt32, gid: UInt32) -> UserFileKind
  /// A small regular file, read as the user with no symlink followed and no blocking. Nil otherwise.
  func readUserFile(_ path: String, uid: UInt32, gid: UInt32) -> Data?
  func userFileAge(_ path: String, uid: UInt32, gid: UInt32) -> TimeInterval?
  /// Writes `data` as the user to `path` (mode 0644), through a temp file in the same directory and a rename.
  /// Refuses a symlink anywhere on the path from the home down.
  func writeUserFile(_ path: String, data: Data, uid: UInt32, gid: UInt32) -> UserWriteResult
}

public struct SystemEnvironment: HelperEnvironment {
  public static let maxUserFileBytes = 65_536
  let tools: SystemTools
  let user: UserContext
  let homeOverride: String?

  public init(tools: SystemTools = ProcessSystemTools(), user: UserContext = ThreadUserContext(), homeOverride: String? = nil) {
    self.tools = tools
    self.user = user
    self.homeOverride = homeOverride
  }

  public func consoleUser() -> (uid: UInt32, gid: UInt32, name: String)? {
    var info = stat()
    guard stat("/dev/console", &info) == 0, info.st_uid != 0, let entry = getpwuid(info.st_uid) else { return nil }
    let name = String(cString: entry.pointee.pw_name)
    if name == "loginwindow" || name == "root" { return nil }
    return (info.st_uid, entry.pointee.pw_gid, name)
  }

  public func appRunning(uid: UInt32) -> Bool {
    let result = tools.run("/bin/ps", ["-axww", "-o", "uid=,command="])
    guard result.status == 0 else { return false }
    return HelperProcessScan.appRunning(psOutput: result.output, uid: uid)
  }

  public func now() -> Date { Date() }

  public func homeDirectory(uid: UInt32) -> String? {
    homeOverride ?? getpwuid(uid).map { String(cString: $0.pointee.pw_dir) }
  }

  public func userFileKind(_ path: String, uid: UInt32, gid: UInt32) -> UserFileKind {
    user.run(uid: uid, gid: gid) { () -> UserFileKind in
      var info = stat()
      if lstat(path, &info) != 0 { return .missing }
      switch info.st_mode & S_IFMT {
      case S_IFREG: return .regular
      case S_IFLNK: return .symlink
      default: return .other
      }
    } ?? .other  // could not act as the user: treat as "not a plain file", so nothing is written or run on it
  }

  public func readUserFile(_ path: String, uid: UInt32, gid: UInt32) -> Data? {
    let limit = Self.maxUserFileBytes
    return user.run(uid: uid, gid: gid) { () -> Data? in
      // O_NOFOLLOW: a symlink at the end is refused. O_NONBLOCK: a FIFO cannot hold the helper.
      let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
      guard fd >= 0 else { return nil }
      defer { close(fd) }
      var info = stat()
      guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= limit else { return nil }
      var data = Data(count: Int(info.st_size))
      let got = data.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
      guard got == Int(info.st_size) else { return nil }
      return data
    } ?? nil
  }

  public func userFileAge(_ path: String, uid: UInt32, gid: UInt32) -> TimeInterval? {
    user.run(uid: uid, gid: gid) { () -> TimeInterval? in
      var info = stat()
      guard lstat(path, &info) == 0 else { return nil }
      return Date().timeIntervalSince1970 - TimeInterval(info.st_mtimespec.tv_sec)
    } ?? nil
  }

  public func writeUserFile(_ path: String, data: Data, uid: UInt32, gid: UInt32) -> UserWriteResult {
    guard uid != 0, let home = homeDirectory(uid: uid), path.hasPrefix(home + "/") else { return .refusedUnsafePath }
    let relative = String(path.dropFirst(home.count + 1))
    let parts = relative.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard parts.count >= 2, !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return .refusedUnsafePath }
    let directories = Array(parts.dropLast()), name = parts.last!
    let result = user.run(uid: uid, gid: gid) { () -> UserWriteResult in
      // Every directory from the home down must be a REAL directory owned by the user. Missing ones are made.
      func realDirectory(_ directory: String) -> Bool {
        var info = stat()
        return lstat(directory, &info) == 0 && (info.st_mode & S_IFMT) == S_IFDIR && info.st_uid == uid
      }
      var current = home
      guard realDirectory(current) else { return .refusedUnsafePath }
      for component in directories {
        current += "/" + component
        var info = stat()
        if lstat(current, &info) != 0 {
          guard errno == ENOENT, mkdir(current, 0o755) == 0, realDirectory(current) else { return .refusedUnsafePath }
        } else if !realDirectory(current) {
          return .refusedUnsafePath  // a symlink, or a directory that is not the user's
        }
      }
      var existing = stat()
      if lstat(path, &existing) == 0, (existing.st_mode & S_IFMT) != S_IFREG { return .refusedUnsafePath }  // a symlink or a directory
      let temporary = current + "/." + name + ".tmp." + UUID().uuidString
      let fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o644)
      guard fd >= 0 else { return .failed }
      let written = data.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
      let finished = written == data.count && fsync(fd) == 0 && fchmod(fd, 0o644) == 0
      close(fd)
      guard finished, rename(temporary, path) == 0 else {
        unlink(temporary)
        return .failed
      }
      return .written
    }
    return result ?? .failed  // could not act as the user: nothing was written
  }
}

public enum HelperProcessScan {
  /// Is `room-recorder run` (the resident app) among the processes owned by `uid`? `ps -o uid=,command=` lines.
  public static func appRunning(psOutput: String, uid: UInt32) -> Bool {
    psOutput.split(separator: "\n").contains { line in
      let parts = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
      guard parts.count == 2, UInt32(parts[0]) == uid else { return false }
      return parts[1].contains("/Contents/MacOS/room-recorder run")
    }
  }
}

/// What the helper reads from the app's own `status.json` (the app writes it; the helper only reads).
public struct AppStatusSnapshot: Equatable, Sendable {
  public var state: String
  public var sessionOpen: Bool { state == "recording" || state == "paused" }
  public var needsEnrol: Bool { state == "needs_enrol" }

  public static func read(env: HelperEnvironment, root: String, uid: UInt32, gid: UInt32) -> AppStatusSnapshot? {
    guard let data = env.readUserFile(root + "/status.json", uid: uid, gid: gid),
      let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let state = object["state"] as? String
    else { return nil }
    return AppStatusSnapshot(state: state)
  }
}

public extension HelperEnvironment {
  /// `~/Library/Application Support/EvenScribe/RoomRecorder` for the user.
  func roomRoot(uid: UInt32) -> String? {
    homeDirectory(uid: uid).map { $0 + "/Library/Application Support/EvenScribe/RoomRecorder" }
  }
  func agentPlistPath(uid: UInt32) -> String? {
    homeDirectory(uid: uid).map { $0 + "/Library/LaunchAgents/\(HelperPaths.agentLabel).plist" }
  }
}
