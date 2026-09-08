import Darwin
import Foundation
import RoomRecorderCore

private let usage = """
  Usage:
    room-recorder configure --origin <url> --room <slug> --device <uid> --tapewriter <absolute-path> --ffmpeg <absolute-path> [--retained-archive-recovery <true|false>] [--root <dir>]
    room-recorder login [--root <dir>]
    room-recorder enrol --token <token> --origin <https origin> [--root <dir>]
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

      case "enrol":
        // Install and Fleet PRD §5.3. Called by the §4.4 bootstrap script inside `curl | bash`.
        // NOTHING here reads stdin — see RoomEnrolment's type comment for why that matters.
        try arguments.rejectOptions(except: ["--token", "--origin", "--root"])
        let token = try arguments.require("--token")
        let origin = try RoomEnrolment.validate(origin: try arguments.require("--origin"))
        let enrolled = try await RoomEnrolment.exchange(token: token, origin: origin)

        // Keychain FIRST, config second. If the keychain write fails the verb must exit non-zero
        // with no config written, so the script's `set -e` stops the paste before the LaunchAgent
        // is installed — a resident app with no session would poll into 401s for ever.
        try RoomKeychain.save(
          RoomKeychainRecord(
            session: enrolled.session.token,
            installID: enrolled.installID,
            roomSlug: enrolled.roomSlug,
            roomName: enrolled.roomName,
            origin: origin.absoluteString
          ))

        let persistence = RoomPersistence(root: root)
        var configuration: RoomConfiguration
        if let existing = try? persistence.loadConfiguration() {
          // MIGRATION KEEPS THE ROOM'S DEVICE (V's ruling, 8 Sep). A re-enrol on a Mac that is
          // already recording must not silently move the room onto whatever input happens to be
          // the system default today — someone may have plugged in a headset an hour ago. The
          // fields below are re-pointed on every enrol; `deviceUID` is deliberately not one of
          // them, and this comment is here so it does not get "tidied" into the list.
          configuration = existing
        } else {
          // First enrol on this Mac: take the current system default input. §5.3 has no --device
          // argument and asks the operator nothing, so the machine's own default is the answer.
          configuration = try RoomConfiguration.residentDefault(
            origin: origin, roomSlug: enrolled.roomSlug)
        }
        // One named mutation, tested in RoomEnrolmentConfigurationTests. `deviceUID` is not among
        // the fields it touches, which is the migration rule V ruled on.
        configuration.applyEnrolment(
          origin: origin,
          roomSlug: enrolled.roomSlug,
          installID: enrolled.installID,
          tapewriterPath: BuildInfo.bundledHelper("tapewriter"),
          ffmpegPath: BuildInfo.bundledHelper("ffmpeg")
        )
        try persistence.saveConfiguration(configuration)

        // The token is NOT echoed. The room name is what tells V the paste bound the right room.
        print("Enrolled as \(enrolled.roomName) (\(enrolled.roomSlug)), install \(enrolled.installID)")

      case "login":
        try arguments.rejectOptions(except: ["--root"])
        guard isatty(STDIN_FILENO) == 1, let pointer = getpass("Room PIN: ") else {
          throw CLIError("login requires an interactive terminal")
        }
        let pin = String(cString: pointer)
        defer { memset(pointer, 0, strlen(pointer)) }
        guard !pin.isEmpty else { throw CLIError("PIN cannot be empty") }
        let persistence = RoomPersistence(root: root)
        // THE ONE LEGITIMATE EXCEPTION to "build clients from startingConfiguration". `login`
        // is the verb that OBTAINS a session by exchanging a PIN, so by definition it starts
        // without one and must not refuse for lack of it.
        let client = BenchClient(configuration: try persistence.loadConfiguration())  // SESSION_EXEMPT
        let response = try await client.login(pin: pin)
        let loggedIn = await client.currentConfiguration()
        // The session goes to the keychain, not to config.json — `saveConfiguration` strips it
        // now, so writing it there would silently lose it. This verb predates §5.3's enrol and
        // is kept working rather than left to fail quietly.
        guard let installID = loggedIn.installID, let session = loggedIn.etaRoomSession else {
          throw CLIError(
            "login succeeded but this room has no install id to bind the session to. Enrol this Mac with the install command from /admin/bench.")
        }
        try RoomKeychain.save(
          RoomKeychainRecord(
            session: session,
            installID: installID,
            roomSlug: loggedIn.roomSlug,
            roomName: response.room.name,
            origin: loggedIn.origin.absoluteString
          ))
        try persistence.saveConfiguration(loggedIn)
        print("Logged in to \(response.room.name)")

      case "run":
        try arguments.rejectOptions(except: ["--root"])
        // NOT `loadConfiguration()`. That returns what is on disk, and §5.4 keeps no session
        // there, so a client built from it polls unauthenticated for ever. `startingConfiguration`
        // is the one place that adds the keychain session, and it refuses if there is none.
        let configuration = try RoomEngine.startingConfiguration(rootURL: root)
        let bench = BenchClient(configuration: configuration)
        let recovery: (any RoomRetainedArchiveRecovering)?
        if configuration.retainedArchiveRecoveryEnabled {
          if configuration.residentArchiveEligibility(archiveRootURL: root) == .eligible,
            let receipt = configuration.archivePreflightReceipt
          {
            recovery = try RetainedArchiveRecovery(
              rootURL: root,
              wire: bench,
              ffmpegURL: URL(fileURLWithPath: configuration.ffmpegPath),
              encoderProvenanceID: receipt.encoderProvenanceID)
          } else {
            recovery = try RetainedArchiveRecovery(rootURL: root, wire: bench)
          }
        } else {
          recovery = nil
        }
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
          // §4.5 rule 3 / R2 §2.4. NOT `KeepAlive: true`, which restarts on ANY exit: a retired
          // install stops deliberately and cleanly, and an unconditional KeepAlive would have
          // launchd relaunch it in a tight loop for ever, polling 409s. `SuccessfulExit: false`
          // means "restart only when it exits non-zero", so a crash is still covered and a
          // deliberate stop is honoured.
          "KeepAlive": ["SuccessfulExit": false],
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
    } catch RoomEngineError.needsEnrolment {
      // EXIT ZERO, and the zero is the whole point. The LaunchAgent carries
      // `KeepAlive = { SuccessfulExit: false }`, so a non-zero exit here would have launchd
      // restart the app immediately, for ever, each time failing the same way — the thrash §2.4
      // exists to prevent. RoomEngine.load has already written `needs_enrol` and said why on
      // stderr; there is nothing left to retry, so the process stops and stays stopped.
      exit(0)
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
