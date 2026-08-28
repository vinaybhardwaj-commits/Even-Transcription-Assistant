import Darwin
import Foundation
import RoomRecorderCore

private let usage = """
  Usage:
    room-recorder configure --origin <url> --room <slug> --device <uid> --tapewriter <absolute-path> --ffmpeg <absolute-path> [--retained-archive-recovery <true|false>] [--root <dir>]
    room-recorder login [--root <dir>]
    room-recorder run [--root <dir>]
    room-recorder status [--root <dir>]
    room-recorder mark [--root <dir>]
    room-recorder install-launch-agent [--root <dir>]
  """

private struct Arguments {
  let command: String
  let options: [String: String]

  init(_ values: [String]) throws {
    guard let first = values.first else { throw CLIError(usage) }
    command = first
    var parsed: [String: String] = [:]
    var index = 1
    while index < values.count {
      let name = values[index]
      guard name.hasPrefix("--"), index + 1 < values.count else {
        throw CLIError("invalid or missing option value: \(name)\n\(usage)")
      }
      guard parsed[name] == nil else { throw CLIError("duplicate option: \(name)") }
      parsed[name] = values[index + 1]
      index += 2
    }
    options = parsed
  }

  func require(_ name: String) throws -> String {
    guard let value = options[name], !value.isEmpty else {
      throw CLIError("required option: \(name)\n\(usage)")
    }
    return value
  }

  func rejectOptions(except allowed: Set<String>) throws {
    if let unknown = options.keys.first(where: { !allowed.contains($0) }) {
      throw CLIError("unknown option: \(unknown)\n\(usage)")
    }
  }
}

private struct CLIError: Error, LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

@main
private enum RoomRecorderCLI {
  static func main() async {
    do {
      let arguments = try Arguments(Array(CommandLine.arguments.dropFirst()))
      let root = URL(
        fileURLWithPath: arguments.options["--root"] ?? RoomEngine.defaultRootURL.path,
        isDirectory: true
      ).standardizedFileURL
      switch arguments.command {
      case "configure":
        try arguments.rejectOptions(except: [
          "--origin", "--room", "--device", "--tapewriter", "--ffmpeg", "--root",
          "--retained-archive-recovery",
        ])
        guard let origin = URL(string: try arguments.require("--origin")) else {
          throw CLIError("--origin must be an HTTP(S) URL")
        }
        let configuration = try RoomConfiguration(
          origin: origin,
          roomSlug: try arguments.require("--room"),
          deviceUID: try arguments.require("--device"),
          tapewriterPath: try absolutePath(arguments.require("--tapewriter"), name: "--tapewriter"),
          ffmpegPath: try absolutePath(arguments.require("--ffmpeg"), name: "--ffmpeg"),
          installID: "install_\(UUID().uuidString.prefix(12).lowercased())",
          tabID: "native_\(UUID().uuidString.prefix(12).lowercased())",
          retainedArchiveRecoveryEnabled: try strictBoolean(
            arguments.options["--retained-archive-recovery"] ?? "false",
            name: "--retained-archive-recovery"
          )
        )
        try RoomPersistence(root: root).saveConfiguration(configuration)
        print("Configured \(configuration.roomSlug) at \(root.path)")

      case "login":
        try arguments.rejectOptions(except: ["--root"])
        guard isatty(STDIN_FILENO) == 1, let pointer = getpass("Room PIN: ") else {
          throw CLIError("login requires an interactive terminal")
        }
        let pin = String(cString: pointer)
        defer { memset(pointer, 0, strlen(pointer)) }
        guard !pin.isEmpty else { throw CLIError("PIN cannot be empty") }
        let persistence = RoomPersistence(root: root)
        let client = BenchClient(configuration: try persistence.loadConfiguration())
        let response = try await client.login(pin: pin)
        try persistence.saveConfiguration(await client.currentConfiguration())
        print("Logged in to \(response.room.name)")

      case "run":
        try arguments.rejectOptions(except: ["--root"])
        let configuration = try RoomPersistence(root: root).loadConfiguration()
        let bench = BenchClient(configuration: configuration)
        let recovery: (any RoomRetainedArchiveRecovering)? =
          configuration.retainedArchiveRecoveryEnabled
          ? try RetainedArchiveRecovery(rootURL: root, wire: bench)
          : nil
        try await RoomEngine.load(
          rootURL: root,
          remoteFactory: { _ in bench },
          retainedArchiveRecovery: recovery
        ).run()

      case "status":
        try arguments.rejectOptions(except: ["--root"])
        let persistence = RoomPersistence(root: root)
        _ = try persistence.loadConfiguration()
        let status: RoomRecorderStatus
        if var saved = try? persistence.loadStatus() {
          if saved.state == .recording || saved.state == .paused,
            Date().timeIntervalSince(saved.updatedAt) > 10
          {
            saved.state = .offline
            saved.lastError = "recorder heartbeat is stale"
          }
          status = saved
        } else {
          let pending = try RoomPieceSpool(
            rootURL: root.appendingPathComponent("spool", isDirectory: true)
          ).pending().count
          status = RoomRecorderStatus(
            state: pending > 0 ? .uploadPending : .ready,
            pendingPieceCount: pending)
        }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        print(String(decoding: try encoder.encode(status), as: UTF8.self))

      case "mark":
        try arguments.rejectOptions(except: ["--root"])
        let mark = try await RoomEngine.markConsult(rootURL: root)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        print(String(decoding: try encoder.encode(mark), as: UTF8.self))

      case "install-launch-agent":
        try arguments.rejectOptions(except: ["--root"])
        _ = try RoomPersistence(root: root).loadConfiguration()
        let executable =
          Bundle.main.executableURL
          ?? URL(
            fileURLWithPath: CommandLine.arguments[0],
            relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath))
        let launchAgents = FileManager.default.homeDirectoryForCurrentUser
          .appendingPathComponent("Library/LaunchAgents", isDirectory: true)
        try FileManager.default.createDirectory(
          at: launchAgents, withIntermediateDirectories: true,
          attributes: [.posixPermissions: NSNumber(value: 0o700)])
        let plistURL = launchAgents.appendingPathComponent(
          "com.evenscribe.room-recorder.plist", isDirectory: false)
        let logPath = root.appendingPathComponent("launchd.log").path
        let plist: [String: Any] = [
          "Label": "com.evenscribe.room-recorder",
          "ProgramArguments": [executable.standardizedFileURL.path, "run", "--root", root.path],
          "RunAtLoad": true,
          "KeepAlive": true,
          "ProcessType": "Interactive",
          "StandardOutPath": logPath,
          "StandardErrorPath": logPath,
        ]
        let data = try PropertyListSerialization.data(
          fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: plistURL, options: .atomic)
        print("Installed \(plistURL.path)")

      case "help", "--help", "-h":
        print(usage)
      default:
        throw CLIError("unknown command: \(arguments.command)\n\(usage)")
      }
    } catch {
      let message = "room-recorder: \(error.localizedDescription)\n"
      FileHandle.standardError.write(Data(message.utf8))
      exit(1)
    }
  }

  private static func absolutePath(_ value: String, name: String) throws -> String {
    guard value.hasPrefix("/") else { throw CLIError("\(name) must be an absolute path") }
    return URL(fileURLWithPath: value).standardizedFileURL.path
  }

  private static func strictBoolean(_ value: String, name: String) throws -> Bool {
    switch value {
    case "true": return true
    case "false": return false
    default: throw CLIError("\(name) must be true or false")
    }
  }
}
