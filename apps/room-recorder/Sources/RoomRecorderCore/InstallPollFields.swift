import Foundation

/// The EIGHT poll fields of Install and Fleet PRD §4.3, plus the three machine facts §6 step 2
/// renders, assembled from a `MachineFacts` reading at the moment of the poll.
///
/// ─── NIL MEANS NOT MEASURED, AND IS SENT AS ABSENCE ──────────────────────────────────────
/// `queryItems()` omits any field whose value could not be read. That is not tidiness: the
/// server COALESCEs every one of these columns, so an omitted field leaves the last good reading
/// in place, while a fabricated one would overwrite a true value with a guess. §5.5's invariant —
/// "no reported value is a constant that stands in for a measurement" — is enforced here, at the
/// only point where these values become a request.
///
/// `tape_advancing` is the exception in the other direction: it is a Bool, not a Bool?, because
/// the app always knows whether its own durable sample index moved. There is no "cannot tell".
public struct InstallPollFields: Equatable, Sendable {
  public var installID: String
  public var appVersion: String?
  public var buildSHA: String?
  public var micState: String?
  public var tapeAdvancing: Bool
  public var neverSleep: Bool?
  public var launchedBy: String?
  public var hostname: String?
  public var hardwareModel: String?
  public var osVersion: String?
  /// The eighth field (V's ruling, 8 Sep): what the configured input device is CALLED, so the
  /// fleet row can show it beside the mic state. Same rules as the rest — derived, never typed,
  /// and omitted rather than guessed when the device is not attached.
  public var inputDeviceName: String?

  public init(
    installID: String,
    appVersion: String? = nil,
    buildSHA: String? = nil,
    micState: String? = nil,
    tapeAdvancing: Bool,
    neverSleep: Bool? = nil,
    launchedBy: String? = nil,
    hostname: String? = nil,
    hardwareModel: String? = nil,
    osVersion: String? = nil,
    inputDeviceName: String? = nil
  ) {
    self.installID = installID
    self.appVersion = appVersion
    self.buildSHA = buildSHA
    self.micState = micState
    self.tapeAdvancing = tapeAdvancing
    self.neverSleep = neverSleep
    self.launchedBy = launchedBy
    self.hostname = hostname
    self.hardwareModel = hardwareModel
    self.osVersion = osVersion
    self.inputDeviceName = inputDeviceName
  }

  /// Build from a live machine reading. `tapeAdvancing` comes from the caller because only the
  /// engine knows whether its own durable sample index moved since the previous poll.
  public init(
    installID: String,
    facts: MachineFacts,
    tapeAdvancing: Bool,
    appVersion: String? = BuildInfo.appVersion,
    buildSHA: String? = BuildInfo.buildSHA
  ) {
    self.init(
      installID: installID,
      appVersion: appVersion,
      buildSHA: buildSHA,
      micState: facts.micState,
      tapeAdvancing: tapeAdvancing,
      neverSleep: facts.neverSleep,
      launchedBy: facts.launchedBy,
      hostname: facts.hostname,
      hardwareModel: facts.hardwareModel,
      osVersion: facts.osVersion,
      inputDeviceName: facts.inputDeviceName
    )
  }

  /// §4.5 rule 1: the app's listener `tab_id` is `app_<install_id>` and the app writes no other
  /// form. Stated here so the one place that knows the install id is the one place that builds it.
  public var tabID: String { "app_\(installID)" }

  public func queryItems() -> [URLQueryItem] {
    var items = [URLQueryItem(name: "install_id", value: installID)]
    func add(_ name: String, _ value: String?) {
      guard let value, !value.isEmpty else { return }
      items.append(URLQueryItem(name: name, value: value))
    }
    add("app_version", appVersion)
    add("build_sha", buildSHA)
    add("mic_state", micState)
    items.append(URLQueryItem(name: "tape_advancing", value: tapeAdvancing ? "true" : "false"))
    if let neverSleep {
      items.append(URLQueryItem(name: "never_sleep", value: neverSleep ? "true" : "false"))
    }
    add("launched_by", launchedBy)
    add("hostname", hostname)
    add("hardware_model", hardwareModel)
    add("os_version", osVersion)
    add("input_device_name", inputDeviceName)
    return items
  }
}

/// Build-time constants written by the packaging script (§5.5: "a build-time constant written by
/// the packaging script").
///
/// These two ARE constants, and they are the only ones §5.5 permits — because they describe the
/// BUILD, not the machine, and a build genuinely cannot measure its own version at runtime. Both
/// are read from the running bundle's Info.plist rather than baked into the binary, so a bundle
/// that was assembled wrong reports what it actually is instead of what the source hoped.
public enum BuildInfo {
  /// `CFBundleShortVersionString` of the running bundle. Nil for an unbundled `swift run` binary,
  /// which is correct: a loose debug binary has no release version and must not claim one.
  public static var appVersion: String? {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
  }

  /// The short git sha the packaging script stamped into the Info.plist.
  public static var buildSHA: String? {
    Bundle.main.object(forInfoDictionaryKey: "ETABuildSHA") as? String
  }

  /// Absolute path to a bundled helper, or nil when running outside a bundle.
  ///
  /// §5.1 puts the vendored encoder at `Contents/Helpers/ffmpeg`, and X2's ruling is that the app
  /// uses it and no longer looks for Homebrew. Resolving relative to the running executable means
  /// the bundle can be placed anywhere — `~/Applications` per D6 — without a configured path.
  public static func bundledHelper(_ name: String) -> String? {
    guard let executable = Bundle.main.executableURL?.resolvingSymlinksInPath() else { return nil }
    let helpers = executable
      .deletingLastPathComponent()  // Contents/MacOS
      .deletingLastPathComponent()  // Contents
      .appendingPathComponent("Helpers", isDirectory: true)
      .appendingPathComponent(name, isDirectory: false)
    return FileManager.default.isExecutableFile(atPath: helpers.path) ? helpers.path : nil
  }
}
