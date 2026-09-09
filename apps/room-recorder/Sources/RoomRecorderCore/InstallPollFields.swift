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

  // ─── BUILD R3 (§13.4) ─────────────────────────────────────────────────────────────────────
  /// R3-6. Whether a recording session was open at the moment of the poll, from the engine's own
  /// state. A `Bool?` and not a `Bool`: an engine that has not decided yet reports nothing rather
  /// than reporting "idle", and the server writes NULL, which the card reads as "not reported".
  ///
  /// THE BENCH LISTENER'S `recording` FLAG IS NOT USABLE FOR THIS. OPD 5's listener row has read
  /// true since 24 August, fifteen days, with no session open. §5.5 wants a value read from the
  /// machine at poll time, and this is one.
  public var sessionOpen: Bool?
  /// R3-8. Which channel this Mac asks for, from its own `config.json`.
  public var updateChannel: String?
  /// The last self-update outcome, read once out of `update-result.json` and then never again.
  public var lastUpdateResult: String?
  /// The reason line that goes with it, carrying the attempted version at its head.
  public var lastUpdateError: String?
  /// When the swap script recorded that outcome, ISO-8601.
  public var lastUpdateAt: String?
  /// V, 9 September 2026. Free bytes on the volume holding the captures directory.
  ///
  /// NIL RATHER THAN 0, and the distinction is the whole of §5.5 in one field. A reader that
  /// cannot answer reports nothing; "0 bytes free" is a clinical emergency this app must never be
  /// able to invent from a failed `resourceValues` call.
  public var diskFreeBytes: Int64?

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
    inputDeviceName: String? = nil,
    sessionOpen: Bool? = nil,
    updateChannel: String? = nil,
    lastUpdateResult: String? = nil,
    lastUpdateError: String? = nil,
    lastUpdateAt: String? = nil,
    diskFreeBytes: Int64? = nil
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
    self.sessionOpen = sessionOpen
    self.updateChannel = updateChannel
    self.lastUpdateResult = lastUpdateResult
    self.lastUpdateError = lastUpdateError
    self.lastUpdateAt = lastUpdateAt
    self.diskFreeBytes = diskFreeBytes
  }

  /// Build from a live machine reading. `tapeAdvancing` comes from the caller because only the
  /// engine knows whether its own durable sample index moved since the previous poll.
  public init(
    installID: String,
    facts: MachineFacts,
    tapeAdvancing: Bool,
    appVersion: String? = BuildInfo.appVersion,
    buildSHA: String? = BuildInfo.buildSHA,
    sessionOpen: Bool? = nil,
    updateChannel: String? = nil,
    lastUpdateResult: String? = nil,
    lastUpdateError: String? = nil,
    lastUpdateAt: String? = nil,
    diskFreeBytes: Int64? = nil
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
      inputDeviceName: facts.inputDeviceName,
      sessionOpen: sessionOpen,
      updateChannel: updateChannel,
      lastUpdateResult: lastUpdateResult,
      lastUpdateError: lastUpdateError,
      lastUpdateAt: lastUpdateAt,
      diskFreeBytes: diskFreeBytes
    )
  }

  /// Free space on the volume holding `directory`, or nil (§5.5, V's 9 September addition).
  ///
  /// ─── THIS LIVES HERE, NOT IN MachineFacts, AND SAYING WHY MATTERS ─────────────────────────
  /// `MachineFacts` measures the MACHINE and takes no arguments beyond the configured input; free
  /// space is a fact about ONE DIRECTORY, and the only object that knows which directory a room
  /// records into is the engine. Build R3's file contract also does not open MachineFacts.swift,
  /// and reaching into a file the contract did not name would be the wrong kind of tidy.
  ///
  /// `volumeAvailableCapacityForImportantUsageKey`, which is what the Finder shows and what a
  /// purgeable-space-aware macOS actually considers available — not `volumeAvailableCapacityKey`,
  /// which under-reports by whatever the system is holding in purgeable caches and would make a
  /// healthy Mac look close to full. NIL, NEVER 0: see the property comment above.
  public static func freeBytes(onVolumeHolding directory: URL) -> Int64? {
    guard
      let values = try? directory.resourceValues(forKeys: [
        .volumeAvailableCapacityForImportantUsageKey
      ]),
      let available = values.volumeAvailableCapacityForImportantUsage,
      available > 0
    else {
      return nil
    }
    return Int64(available)
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
    // ── Build R3 (§13.4) ────────────────────────────────────────────────────────────────────
    // `session_open` follows the same absence rule as everything else here, but for a different
    // reason at the far end: the server writes it RAW rather than COALESCEing it, so an omitted
    // field lands as NULL and reads as "not reported" — which is exactly right for an engine that
    // has not decided, and is why nil must not become "false" on the way out.
    if let sessionOpen {
      items.append(URLQueryItem(name: "session_open", value: sessionOpen ? "true" : "false"))
    }
    add("update_channel", updateChannel)
    add("last_update_result", lastUpdateResult)
    add("last_update_error", lastUpdateError)
    add("last_update_at", lastUpdateAt)
    // Sent as digits, and only when positive. `add` already drops an empty string; the guard is
    // here so no arithmetic anywhere can turn an unreadable volume into a "0" on a clinical row.
    if let diskFreeBytes, diskFreeBytes > 0 {
      items.append(URLQueryItem(name: "disk_free_bytes", value: String(diskFreeBytes)))
    }
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
