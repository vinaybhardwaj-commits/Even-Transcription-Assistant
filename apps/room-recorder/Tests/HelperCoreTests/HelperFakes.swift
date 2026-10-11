import FleetCore
import Foundation

@testable import HelperCore

/// Records every command the helper would run and answers from a closure.
final class FakeTools: SystemTools, @unchecked Sendable {
  private let lock = NSLock()
  private var recorded: [String] = []
  var responder: @Sendable (String, [String]) -> ToolResult = { _, _ in ToolResult(status: 0) }

  func run(_ executable: String, _ arguments: [String]) -> ToolResult {
    lock.lock()
    recorded.append(([executable] + arguments).joined(separator: " "))
    lock.unlock()
    return responder(executable, arguments)
  }
  var calls: [String] { lock.lock(); defer { lock.unlock() }; return recorded }
  /// Calls that change something, i.e. everything except the read-only queries.
  var actions: [String] {
    calls.filter { !$0.hasPrefix("/bin/ps") && $0 != "/usr/bin/pmset -g" && $0 != "/usr/bin/pmset -g sched" }
  }
}

/// A fake machine: who is at the console, whether the app runs, what is on disk.
final class FakeEnv: HelperEnvironment, @unchecked Sendable {
  private let lock = NSLock()
  var console: (uid: UInt32, gid: UInt32, name: String)? = (501, 20, "room")
  var appIsRunning = true
  var clock = TestServer.night
  var files: [String: Data] = [:]
  var symlinks = Set<String>()
  var ages: [String: TimeInterval] = [:]
  var writes: [(path: String, data: Data, uid: UInt32, gid: UInt32)] = []
  var writeResult: UserWriteResult = .written

  /// A healthy idle app: it has written a `ready` status. (A running app with NO readable status counts as a session.)
  init() { setStatus("ready") }

  func consoleUser() -> (uid: UInt32, gid: UInt32, name: String)? { console }
  func appRunning(uid: UInt32) -> Bool { appIsRunning }
  func now() -> Date { clock }
  func homeDirectory(uid: UInt32) -> String? { "/Users/room" }
  func userFileKind(_ path: String, uid: UInt32, gid: UInt32) -> UserFileKind {
    lock.lock(); defer { lock.unlock() }
    if symlinks.contains(path) { return .symlink }
    return files[path] != nil ? .regular : .missing
  }
  func readUserFile(_ path: String, uid: UInt32, gid: UInt32) -> Data? { lock.lock(); defer { lock.unlock() }; return files[path] }
  func userFileAge(_ path: String, uid: UInt32, gid: UInt32) -> TimeInterval? { ages[path] }
  func writeUserFile(_ path: String, data: Data, uid: UInt32, gid: UInt32) -> UserWriteResult {
    guard writeResult == .written else { return writeResult }
    lock.lock()
    files[path] = data
    writes.append((path, data, uid, gid))
    lock.unlock()
    return .written
  }

  static let root = "/Users/room/Library/Application Support/EvenScribe/RoomRecorder"
  static let plist = "/Users/room/Library/LaunchAgents/com.evenscribe.room-recorder.plist"
  func setStatus(_ state: String) { files[Self.root + "/status.json"] = Data("{\"state\":\"\(state)\"}".utf8) }
}

func tempPath(_ name: String) -> String {
  FileManager.default.temporaryDirectory.appendingPathComponent("helper-\(UUID().uuidString)-\(name)").path
}
