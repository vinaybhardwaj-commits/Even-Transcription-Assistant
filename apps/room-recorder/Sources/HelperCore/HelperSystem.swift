import Darwin
import FleetCore
import Foundation

/// Where the root helper keeps its own files. All of it is root-owned; none of it is writable by a room user.
public enum HelperPaths {
  public static let supportDirectory = HelperIdentity.supportDirectory
  public static let fleetStateFile = "helper-fleet-state.json"
  public static let heartbeatFile = "helper-heartbeat.json"
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
  public static let allowed: Set<String> = [
    "/bin/launchctl", "/usr/bin/pmset", "/usr/bin/caffeinate", "/bin/ps", "/usr/sbin/chown",
  ]
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

/// What the helper needs to know about the machine and the room user's session. Real in production, a fake in a test.
public protocol HelperEnvironment: Sendable {
  /// The user at the console, or nil at the login window.
  func consoleUser() -> (uid: UInt32, gid: UInt32, name: String)?
  func appRunning(uid: UInt32) -> Bool
  func now() -> Date
  func fileExists(_ path: String) -> Bool
  func read(_ path: String) -> Data?
  func fileAge(_ path: String) -> TimeInterval?
  /// Writes `data` owned by `uid:gid`, mode 0644, creating the directory if needed.
  func writeUserFile(_ path: String, data: Data, uid: UInt32, gid: UInt32) -> Bool
  func homeDirectory(uid: UInt32) -> String?
}

public struct SystemEnvironment: HelperEnvironment {
  let tools: SystemTools
  public init(tools: SystemTools = ProcessSystemTools()) { self.tools = tools }

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
  public func fileExists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: path) }
  public func read(_ path: String) -> Data? { try? Data(contentsOf: URL(fileURLWithPath: path)) }

  public func fileAge(_ path: String) -> TimeInterval? {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
      let modified = attributes[.modificationDate] as? Date
    else { return nil }
    return Date().timeIntervalSince(modified)
  }

  public func writeUserFile(_ path: String, data: Data, uid: UInt32, gid: UInt32) -> Bool {
    let url = URL(fileURLWithPath: path)
    let directory = url.deletingLastPathComponent()
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try data.write(to: url, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path)
    } catch { return false }
    return tools.run("/usr/sbin/chown", ["\(uid):\(gid)", path]).status == 0
  }

  public func homeDirectory(uid: UInt32) -> String? {
    getpwuid(uid).map { String(cString: $0.pointee.pw_dir) }
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

  public static func read(env: HelperEnvironment, root: String) -> AppStatusSnapshot? {
    guard let data = env.read(root + "/status.json"),
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
