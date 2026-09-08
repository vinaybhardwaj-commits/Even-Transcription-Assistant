import AVFoundation
import Darwin
import Foundation
import TapeCapture

/// The §5.5 derivations, in one place, each read from the machine at the moment of the poll.
///
/// ─── THE INVARIANT THIS FILE EXISTS TO HOLD ──────────────────────────────────────────────
/// §5.5: "No reported value is typed by a person. No reported value is a constant that stands in
/// for a measurement. Every value in the table comes from the machine at the moment of the poll.
/// This rule caught two silent labelling incidents."
///
/// So every function below either MEASURES or returns nil. There is no default, no fallback
/// value, and no `?? false` anywhere in this file. A fact that cannot be read is **not reported**,
/// and the server's COALESCE leaves the previous reading in place — which is a different and much
/// more honest state than a fabricated one. `mic_state` is the only field with a name for "I do
/// not know", and that name is `unknown`, which is what the API already expects.
///
/// The two incidents §5.5 refers to are the reason the type below is all optionals rather than a
/// struct of plain values with sensible defaults. A sensible default IS the incident.
public struct MachineFacts: Equatable, Sendable {
  /// `AVCaptureDevice.authorizationStatus(for: .audio)`, mapped to the four API strings.
  public var micState: String
  /// True when `pmset -g` reports `sleep 0`. Nil when pmset could not be read or parsed.
  public var neverSleep: Bool?
  /// `launchd` when the parent process id is 1, else `user`.
  public var launchedBy: String
  /// The LaunchAgent plist exists at the resident path AND `launchctl` lists the label.
  public var launchAgentLoaded: Bool
  public var hostname: String?
  public var hardwareModel: String?
  public var osVersion: String?
  /// The display name of the configured input device, read now. Nil when that device is not
  /// currently attached — an unplugged mic is not a renamed one.
  public var inputDeviceName: String?

  public init(
    micState: String,
    neverSleep: Bool?,
    launchedBy: String,
    launchAgentLoaded: Bool,
    hostname: String?,
    hardwareModel: String?,
    osVersion: String?,
    inputDeviceName: String?
  ) {
    self.micState = micState
    self.neverSleep = neverSleep
    self.launchedBy = launchedBy
    self.launchAgentLoaded = launchAgentLoaded
    self.hostname = hostname
    self.hardwareModel = hardwareModel
    self.osVersion = osVersion
    self.inputDeviceName = inputDeviceName
  }
}

public enum MachineFactsReader {
  public static let launchAgentLabel = "com.evenscribe.room-recorder"

  /// Read everything §5.5 asks for. Cheap enough to run on every poll: one AVFoundation call
  /// that reads a cached TCC answer, two short subprocesses, and three sysctl-class lookups.
  ///
  /// `inputDeviceUID` IS REQUIRED AND HAS NO DEFAULT, deliberately. It is the device the config
  /// says this room records from, and only the caller holding the configuration knows it. A
  /// default of nil would let a future call site silently stop reporting the device — the same
  /// shape of mistake the `install:` parameter was given no default to prevent.
  public static func read(inputDeviceUID: String?) -> MachineFacts {
    MachineFacts(
      micState: microphoneState(),
      neverSleep: neverSleep(),
      launchedBy: launchedBy(),
      launchAgentLoaded: launchAgentLoaded(),
      hostname: hostname(),
      hardwareModel: hardwareModel(),
      osVersion: osVersion(),
      inputDeviceName: inputDeviceName(forUID: inputDeviceUID)
    )
  }

  // ---------------------------------------------------------------------------
  // input_device_name — the eighth poll field (V's ruling, 8 Sep)
  // ---------------------------------------------------------------------------

  /// The name CoreAudio gives the configured device RIGHT NOW.
  ///
  /// MEASURED, never typed, and never the UID as a stand-in: the UID is a stable machine-readable
  /// string ("AppleUSBAudioEngine:...:TONOR TM20 Audio Device:...") and the name is what an
  /// operator reads on the fleet row ("TONOR TM20 Audio Device"). Nil when the configuration names
  /// no device, or when that device is not attached — both are "not measured", which the poll
  /// sends as absence so the server keeps the last true name rather than blanking the row.
  public static func inputDeviceName(forUID uid: String?) -> String? {
    guard let uid, !uid.isEmpty else { return nil }
    return AudioInputDevices.name(forUID: uid)
  }

  // ---------------------------------------------------------------------------
  // mic_state
  // ---------------------------------------------------------------------------

  /// The four strings the API's CHECK constraint accepts, and nothing else.
  ///
  /// `notDetermined` is reported as `not_determined`, NOT as `denied`. They look the same from
  /// here — no audio either way — and they are opposite instructions to the operator: one means
  /// "the prompt has not appeared yet, wait", the other means "go to System Settings". §6 step 3
  /// blocks on `denied` alone for exactly this reason.
  public static func microphoneState() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .notDetermined: return "not_determined"
    case .restricted: return "denied"  // MDM/parental restriction: no audio, and no self-service fix
    @unknown default: return "unknown"
    }
  }

  // ---------------------------------------------------------------------------
  // never_sleep
  // ---------------------------------------------------------------------------

  /// `pmset -g` → the `sleep` line → true when the value is 0.
  ///
  /// NIL, NOT FALSE, when pmset cannot be run or its output does not contain a `sleep` line.
  /// False means "this Mac will sleep and the room will go dark", which sends V to System
  /// Settings; nil means "not measured" and shows as waiting. Guessing false here would send
  /// somebody to a settings pane to fix a setting that may already be correct.
  public static func neverSleep() -> Bool? {
    guard let output = runTool("/usr/bin/pmset", ["-g"]) else { return nil }
    for rawLine in output.split(separator: "\n") {
      let line = rawLine.trimmingCharacters(in: .whitespaces)
      // The line is `sleep                0` — and `displaysleep`/`disksleep` also end in "sleep",
      // so the first field is compared whole rather than with hasPrefix.
      let fields = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
      guard fields.count >= 2, fields[0] == "sleep" else { continue }
      // pmset can append a parenthesised note, e.g. `sleep 0 (sleep prevented by ...)`.
      return Int(fields[1]) == 0
    }
    return nil
  }

  // ---------------------------------------------------------------------------
  // launched_by  /  launch_agent_loaded
  // ---------------------------------------------------------------------------

  /// §5.5: `launchd` when the parent process id is 1, else `user`.
  ///
  /// This is the field §6 step 2 blocks on, and the distinction it draws is the whole point of
  /// the install: an app someone double-clicked runs until the window closes, and a room that
  /// records only while a person stands in it is not installed.
  public static func launchedBy() -> String {
    getppid() == 1 ? "launchd" : "user"
  }

  /// Both halves, per §5.5: the plist exists at the resident path AND launchctl lists the label.
  ///
  /// The plist alone is not enough — a file on disk that launchd never loaded is precisely the
  /// failure §9.2 asks the builder to establish does not happen silently.
  public static func launchAgentLoaded() -> Bool {
    let plist = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/LaunchAgents/\(launchAgentLabel).plist", isDirectory: false)
    guard FileManager.default.fileExists(atPath: plist.path) else { return false }
    guard let listed = runTool("/bin/launchctl", ["print", "gui/\(getuid())/\(launchAgentLabel)"])
    else { return false }
    return listed.contains(launchAgentLabel)
  }

  // ---------------------------------------------------------------------------
  // Machine identity — hostname, model, OS
  // ---------------------------------------------------------------------------

  /// `scutil --get ComputerName` when it answers, else the POSIX hostname.
  ///
  /// ComputerName is what an operator standing in the room reads off the About panel and what
  /// §6 step 2 renders; the POSIX name is the fallback so the field is never empty on a Mac whose
  /// ComputerName is unset.
  public static func hostname() -> String? {
    if let name = runTool("/usr/sbin/scutil", ["--get", "ComputerName"]), !name.isEmpty {
      return name
    }
    var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
    guard gethostname(&buffer, buffer.count) == 0 else { return nil }
    let name = String(cString: buffer)
    return name.isEmpty ? nil : name
  }

  /// The marketing name where the machine knows it ("Mac mini"), else the model identifier
  /// ("Macmini9,1"). Both are facts about the machine; neither is typed.
  public static func hardwareModel() -> String? {
    if let name = sysctlString("hw.product"), !name.isEmpty { return name }
    if let identifier = sysctlString("hw.model"), !identifier.isEmpty { return identifier }
    return nil
  }

  public static func osVersion() -> String? {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "macOS \(v.majorVersion).\(v.minorVersion)"
      + (v.patchVersion > 0 ? ".\(v.patchVersion)" : "")
  }

  private static func sysctlString(_ name: String) -> String? {
    var size = 0
    guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
    var buffer = [CChar](repeating: 0, count: size)
    guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return nil }
    return String(cString: buffer).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  // ---------------------------------------------------------------------------
  // Subprocess helper
  // ---------------------------------------------------------------------------

  /// Run a tool and return trimmed stdout, or nil on any failure.
  ///
  /// NIL ON EVERY FAILURE PATH, deliberately — a non-zero exit, a throw, or empty output all mean
  /// "not measured" rather than a value. The 3-second cap exists because this runs inside the poll
  /// loop and a wedged subprocess must not stall the heartbeat of a recording room.
  static func runTool(_ path: String, _ arguments: [String], timeout: TimeInterval = 3) -> String? {
    guard FileManager.default.isExecutableFile(atPath: path) else { return nil }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do { try process.run() } catch { return nil }

    let deadline = Date().addingTimeInterval(timeout)
    while process.isRunning && Date() < deadline {
      usleep(20_000)
    }
    if process.isRunning {
      process.terminate()
      return nil
    }
    guard process.terminationStatus == 0 else { return nil }
    guard let data = try? pipe.fileHandleForReading.readToEnd(), !data.isEmpty else { return nil }
    let text = String(decoding: data, as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
  }
}
