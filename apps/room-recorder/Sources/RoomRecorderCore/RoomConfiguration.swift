import Darwin
import Foundation
import TapeCapture

/// ─── THE CASE ORDER HERE IS NOT THE ERROR CODE ORDER ────────────────────────────────────────
/// Swift bridges an enum's cases to `NSError.code` by putting every case that carries an
/// associated value FIRST, in declaration order, then the payload-free ones. So the codes are
/// 0 invalidExecutablePath, 1 invalidIdentifier, 2 invalidArchivePreflightReceipt,
/// 3 permissionsNotEnforced, 4 invalidOrigin, 5 invalidRoomSlug, 6 invalidDeviceUID,
/// 7 unsafeRoot, 8 rootIsNotDirectory — NOT the order they are written in below.
///
/// This is recorded because it cost real time: `error 6` from a failed enrol was read off the
/// source order as `unsafeRoot` and sent the diagnosis to the filesystem, when the machine was
/// actually saying `invalidDeviceUID`. Adding, removing or reordering a case renumbers the codes,
/// so never read a raw code off this list — reproduce it.
public enum RoomConfigurationError: Error, Equatable, Sendable {
  case invalidOrigin
  case invalidRoomSlug
  case invalidDeviceUID
  case invalidExecutablePath(String)
  case invalidIdentifier(String)
  case invalidArchivePreflightReceipt(String)
  case unsafeRoot
  case rootIsNotDirectory
  case permissionsNotEnforced(path: String, expected: Int, actual: Int?)
}

public struct RoomArchivePreflightReceipt: Codable, Equatable, Sendable {
  public static let formatVersion: UInt64 = 1

  public let formatVersion: UInt64
  public let origin: URL
  public let roomSlug: String
  public let deviceUID: String
  public let ffmpegPath: String
  public let archiveRootPath: String
  public let archiveProbeSucceeded: Bool
  public let keyProbeSucceeded: Bool
  public let encoderProbeSucceeded: Bool
  public let secureEnclavePublicKeySHA256: String
  public let encoderProvenanceID: String
  public let completedAt: Date

  enum CodingKeys: String, CodingKey {
    case formatVersion = "format_version"
    case origin
    case roomSlug = "room_slug"
    case deviceUID = "device_uid"
    case ffmpegPath = "ffmpeg_path"
    case archiveRootPath = "archive_root_path"
    case archiveProbeSucceeded = "archive_probe_succeeded"
    case keyProbeSucceeded = "key_probe_succeeded"
    case encoderProbeSucceeded = "encoder_probe_succeeded"
    case secureEnclavePublicKeySHA256 = "secure_enclave_public_key_sha256"
    case encoderProvenanceID = "encoder_provenance_id"
    case completedAt = "completed_at"
  }

  public init(
    origin: URL,
    roomSlug: String,
    deviceUID: String,
    ffmpegPath: String,
    archiveRootPath: String,
    archiveProbeSucceeded: Bool,
    keyProbeSucceeded: Bool,
    encoderProbeSucceeded: Bool,
    secureEnclavePublicKeySHA256: String,
    encoderProvenanceID: String,
    completedAt: Date
  ) throws {
    try self.init(
      formatVersion: Self.formatVersion,
      origin: origin,
      roomSlug: roomSlug,
      deviceUID: deviceUID,
      ffmpegPath: ffmpegPath,
      archiveRootPath: archiveRootPath,
      archiveProbeSucceeded: archiveProbeSucceeded,
      keyProbeSucceeded: keyProbeSucceeded,
      encoderProbeSucceeded: encoderProbeSucceeded,
      secureEnclavePublicKeySHA256: secureEnclavePublicKeySHA256,
      encoderProvenanceID: encoderProvenanceID,
      completedAt: completedAt
    )
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    try self.init(
      formatVersion: values.decode(UInt64.self, forKey: .formatVersion),
      origin: values.decode(URL.self, forKey: .origin),
      roomSlug: values.decode(String.self, forKey: .roomSlug),
      deviceUID: values.decode(String.self, forKey: .deviceUID),
      ffmpegPath: values.decode(String.self, forKey: .ffmpegPath),
      archiveRootPath: values.decode(String.self, forKey: .archiveRootPath),
      archiveProbeSucceeded: values.decode(Bool.self, forKey: .archiveProbeSucceeded),
      keyProbeSucceeded: values.decode(Bool.self, forKey: .keyProbeSucceeded),
      encoderProbeSucceeded: values.decode(Bool.self, forKey: .encoderProbeSucceeded),
      secureEnclavePublicKeySHA256: values.decode(
        String.self, forKey: .secureEnclavePublicKeySHA256),
      encoderProvenanceID: values.decode(String.self, forKey: .encoderProvenanceID),
      completedAt: values.decode(Date.self, forKey: .completedAt)
    )
  }

  private init(
    formatVersion: UInt64,
    origin: URL,
    roomSlug: String,
    deviceUID: String,
    ffmpegPath: String,
    archiveRootPath: String,
    archiveProbeSucceeded: Bool,
    keyProbeSucceeded: Bool,
    encoderProbeSucceeded: Bool,
    secureEnclavePublicKeySHA256: String,
    encoderProvenanceID: String,
    completedAt: Date
  ) throws {
    guard formatVersion == Self.formatVersion else {
      throw RoomConfigurationError.invalidArchivePreflightReceipt("format_version")
    }
    guard origin.scheme == "https" || origin.scheme == "http", origin.host != nil,
      !roomSlug.isEmpty, !deviceUID.isEmpty, ffmpegPath.hasPrefix("/"),
      archiveRootPath.hasPrefix("/"), !encoderProvenanceID.isEmpty,
      secureEnclavePublicKeySHA256.utf8.count == 64,
      secureEnclavePublicKeySHA256.utf8.allSatisfy({
        (0x30...0x39).contains($0) || (0x61...0x66).contains($0)
      })
    else {
      throw RoomConfigurationError.invalidArchivePreflightReceipt("fields")
    }
    self.formatVersion = formatVersion
    self.origin = origin
    self.roomSlug = roomSlug
    self.deviceUID = deviceUID
    self.ffmpegPath = ffmpegPath
    self.archiveRootPath = URL(fileURLWithPath: archiveRootPath).standardizedFileURL.path
    self.archiveProbeSucceeded = archiveProbeSucceeded
    self.keyProbeSucceeded = keyProbeSucceeded
    self.encoderProbeSucceeded = encoderProbeSucceeded
    self.secureEnclavePublicKeySHA256 = secureEnclavePublicKeySHA256
    self.encoderProvenanceID = encoderProvenanceID
    self.completedAt = completedAt
  }
}

public enum RoomResidentArchiveEligibility: Equatable, Sendable {
  case disabled
  case missingPreflightReceipt
  case unsuccessfulPreflightReceipt
  case preflightReceiptMismatch
  case eligible
}

public struct RoomConfiguration: Codable, Equatable, Sendable {
  public var origin: URL
  public var roomSlug: String
  public var deviceUID: String
  public var tapewriterPath: String
  public var ffmpegPath: String
  public var etaRoomSession: String?
  public var installID: String?
  public var tabID: String?
  public var retainedArchiveRecoveryEnabled: Bool
  public var residentArchiveCaptureEnabled: Bool
  public var archivePreflightReceipt: RoomArchivePreflightReceipt?

  enum CodingKeys: String, CodingKey {
    case origin
    case roomSlug = "room_slug"
    case deviceUID = "device_uid"
    case tapewriterPath = "tapewriter_path"
    case ffmpegPath = "ffmpeg_path"
    case etaRoomSession = "eta_room_session"
    case installID = "install_id"
    case tabID = "tab_id"
    case retainedArchiveRecoveryEnabled = "retained_archive_recovery_enabled"
    case residentArchiveCaptureEnabled = "resident_archive_capture_enabled"
    case archivePreflightReceipt = "archive_preflight_receipt"
  }


  /// A complete configuration for a bundle installed by the §4.4 bootstrap script.
  ///
  /// WHY THIS EXISTS. The script runs `enrol` and then `install-launch-agent`, and nothing else —
  /// there is no `configure` step in it (D9: "one paste does everything"). `install-launch-agent`
  /// loads the configuration, so `enrol` has to leave a complete one behind or the paste dies one
  /// line from the end.
  ///
  /// EVERY FIELD IS DERIVED, NOT DEFAULTED. The helper paths are resolved from the running bundle,
  /// so they are correct wherever D6 placed it and carry no Homebrew absolute path (X2).
  /// `deviceUID` is the machine's own hardware UUID — it is written into the archive index and
  /// must be stable across restarts and re-enrolments of the same Mac, which rules out anything
  /// generated at install time.
  public static func residentDefault(origin: URL, roomSlug: String) throws -> RoomConfiguration {
    guard let tapewriter = BuildInfo.bundledHelper("tapewriter") else {
      throw RoomConfigurationError.invalidExecutablePath("Contents/Helpers/tapewriter")
    }
    guard let ffmpeg = BuildInfo.bundledHelper("ffmpeg") else {
      throw RoomConfigurationError.invalidExecutablePath("Contents/Helpers/ffmpeg")
    }
    // V's ruling, 8 Sep: the device is the machine's CURRENT default audio input, taken here and
    // stored as a UID. No --device argument, no prompt, and no refusal when several inputs exist.
    //
    // `deviceUID` IS AN AUDIO DEVICE, not a machine identifier. RoomEngine passes it straight to
    // `tapewriter record --device` and reports it as the session's mic label, so a machine UUID in
    // this field names no input and the room records nothing. The previous code put `hw.uuid` here,
    // which was wrong on both counts — wrong kind of value, and an OID that no longer exists.
    guard let input = AudioInputDevices.systemDefault() else {
      throw RoomConfigurationError.invalidDeviceUID
    }
    return try RoomConfiguration(
      origin: origin,
      roomSlug: roomSlug,
      deviceUID: input.uid,
      tapewriterPath: tapewriter,
      ffmpegPath: ffmpeg
    )
  }

  public init(
    origin: URL,
    roomSlug: String,
    deviceUID: String,
    tapewriterPath: String,
    ffmpegPath: String,
    etaRoomSession: String? = nil,
    installID: String? = nil,
    tabID: String? = nil,
    retainedArchiveRecoveryEnabled: Bool = false,
    residentArchiveCaptureEnabled: Bool = false,
    archivePreflightReceipt: RoomArchivePreflightReceipt? = nil
  ) throws {
    guard
      let components = URLComponents(url: origin, resolvingAgainstBaseURL: false),
      components.scheme == "https" || components.scheme == "http",
      components.host != nil,
      components.user == nil,
      components.password == nil,
      components.path.isEmpty || components.path == "/",
      components.query == nil,
      components.fragment == nil
    else {
      throw RoomConfigurationError.invalidOrigin
    }
    guard !roomSlug.isEmpty, roomSlug.count <= 128, !roomSlug.contains("/") else {
      throw RoomConfigurationError.invalidRoomSlug
    }
    guard !deviceUID.isEmpty, deviceUID.count <= 256 else {
      throw RoomConfigurationError.invalidDeviceUID
    }
    guard tapewriterPath.hasPrefix("/") else {
      throw RoomConfigurationError.invalidExecutablePath(tapewriterPath)
    }
    guard ffmpegPath.hasPrefix("/") else {
      throw RoomConfigurationError.invalidExecutablePath(ffmpegPath)
    }
    for identifier in [installID, tabID].compactMap({ $0 }) {
      guard !identifier.isEmpty, identifier.count <= 64 else {
        throw RoomConfigurationError.invalidIdentifier(identifier)
      }
    }
    if let cookie = etaRoomSession,
      cookie.contains("\n") || cookie.contains("\r") || cookie.contains(";")
    {
      throw RoomConfigurationError.invalidIdentifier("eta_room_session")
    }

    var normalizedOrigin = origin
    if normalizedOrigin.path.isEmpty {
      normalizedOrigin.appendPathComponent("")
    }
    self.origin = normalizedOrigin
    self.roomSlug = roomSlug
    self.deviceUID = deviceUID
    self.tapewriterPath = tapewriterPath
    self.ffmpegPath = ffmpegPath
    self.etaRoomSession = etaRoomSession
    self.installID = installID
    self.tabID = tabID
    self.retainedArchiveRecoveryEnabled = retainedArchiveRecoveryEnabled
    self.residentArchiveCaptureEnabled = residentArchiveCaptureEnabled
    self.archivePreflightReceipt = archivePreflightReceipt
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    try self.init(
      origin: values.decode(URL.self, forKey: .origin),
      roomSlug: values.decode(String.self, forKey: .roomSlug),
      deviceUID: values.decode(String.self, forKey: .deviceUID),
      tapewriterPath: values.decode(String.self, forKey: .tapewriterPath),
      ffmpegPath: values.decode(String.self, forKey: .ffmpegPath),
      etaRoomSession: values.decodeIfPresent(String.self, forKey: .etaRoomSession),
      installID: values.decodeIfPresent(String.self, forKey: .installID),
      tabID: values.decodeIfPresent(String.self, forKey: .tabID),
      retainedArchiveRecoveryEnabled:
        values.decodeIfPresent(Bool.self, forKey: .retainedArchiveRecoveryEnabled) ?? false,
      residentArchiveCaptureEnabled:
        values.decodeIfPresent(Bool.self, forKey: .residentArchiveCaptureEnabled) ?? false,
      archivePreflightReceipt: values.decodeIfPresent(
        RoomArchivePreflightReceipt.self, forKey: .archivePreflightReceipt)
    )
  }

  public func residentArchiveEligibility(archiveRootURL: URL) -> RoomResidentArchiveEligibility {
    guard residentArchiveCaptureEnabled else { return .disabled }
    guard let receipt = archivePreflightReceipt else { return .missingPreflightReceipt }
    guard receipt.archiveProbeSucceeded, receipt.keyProbeSucceeded, receipt.encoderProbeSucceeded
    else {
      return .unsuccessfulPreflightReceipt
    }
    guard receipt.origin == origin, receipt.roomSlug == roomSlug, receipt.deviceUID == deviceUID,
      receipt.ffmpegPath == ffmpegPath,
      receipt.archiveRootPath == archiveRootURL.standardizedFileURL.path
    else {
      return .preflightReceiptMismatch
    }
    return .eligible
  }
}

public struct RoomRecorderStatus: Codable, Equatable, Sendable {
  public enum State: String, Codable, Sendable {
    case ready
    case recording
    case paused
    case uploadPending = "upload_pending"
    case failed
    case offline
  }

  public var state: State
  public var sessionID: String?
  public var pendingPieceCount: Int
  public var lastError: String?
  public var updatedAt: Date

  enum CodingKeys: String, CodingKey {
    case state
    case sessionID = "session_id"
    case pendingPieceCount = "pending_piece_count"
    case lastError = "last_error"
    case updatedAt = "updated_at"
  }

  public init(
    state: State,
    sessionID: String? = nil,
    pendingPieceCount: Int = 0,
    lastError: String? = nil,
    updatedAt: Date = Date()
  ) {
    self.state = state
    self.sessionID = sessionID
    self.pendingPieceCount = max(0, pendingPieceCount)
    self.lastError = lastError.map { String($0.prefix(500)) }
    self.updatedAt = updatedAt
  }
}

public struct RoomPersistence: Sendable {
  public static let configurationFileName = "config.json"
  public static let statusFileName = "status.json"

  public let root: URL

  public init(root: URL) {
    self.root = root.standardizedFileURL
  }

  public var configurationURL: URL {
    root.appendingPathComponent(Self.configurationFileName, isDirectory: false)
  }

  public var statusURL: URL {
    root.appendingPathComponent(Self.statusFileName, isDirectory: false)
  }

  public func saveConfiguration(_ configuration: RoomConfiguration) throws {
    try write(configuration, to: configurationURL)
  }

  public func loadConfiguration() throws -> RoomConfiguration {
    try read(RoomConfiguration.self, from: configurationURL)
  }

  public func saveStatus(_ status: RoomRecorderStatus) throws {
    try write(status, to: statusURL)
  }

  public func loadStatus() throws -> RoomRecorderStatus {
    try read(RoomRecorderStatus.self, from: statusURL)
  }

  private func prepareRoot() throws {
    let manager = FileManager.default
    var isDirectory: ObjCBool = false
    if manager.fileExists(atPath: root.path, isDirectory: &isDirectory) {
      let attributes = try manager.attributesOfItem(atPath: root.path)
      if attributes[.type] as? FileAttributeType == .typeSymbolicLink {
        throw RoomConfigurationError.unsafeRoot
      }
      guard isDirectory.boolValue else {
        throw RoomConfigurationError.rootIsNotDirectory
      }
    } else {
      try manager.createDirectory(
        at: root,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
    }
    try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
    try verifyPermissions(at: root, expected: 0o700)
  }

  private func write<T: Encodable>(_ value: T, to destination: URL) throws {
    try prepareRoot()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    encoder.dateEncodingStrategy = .iso8601
    let data = try encoder.encode(value)

    // The atomic temporary lives inside a 0700 root; the installed file is then checked as 0600.
    try data.write(to: destination, options: [.atomic])
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o600],
      ofItemAtPath: destination.path
    )
    try verifyPermissions(at: destination, expected: 0o600)
  }

  private func read<T: Decodable>(_ type: T.Type, from source: URL) throws -> T {
    try prepareRoot()
    let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
    if attributes[.type] as? FileAttributeType == .typeSymbolicLink {
      throw RoomConfigurationError.unsafeRoot
    }
    try verifyPermissions(at: source, expected: 0o600)
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(type, from: Data(contentsOf: source))
  }

  private func verifyPermissions(at url: URL, expected: Int) throws {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    let actual = (attributes[.posixPermissions] as? NSNumber)?.intValue
    guard actual == expected else {
      throw RoomConfigurationError.permissionsNotEnforced(
        path: url.path,
        expected: expected,
        actual: actual
      )
    }
  }
}

// MARK: - Enrolment (Install and Fleet PRD §5.3)

extension RoomConfiguration {
  /// Re-point an existing configuration at what THIS enrol established — and nothing else.
  ///
  /// ─── WHAT IS DELIBERATELY ABSENT FROM THIS FUNCTION ─────────────────────────────────────
  /// `deviceUID`. V's ruling, 8 September 2026: a re-enrol on a Mac that is already recording
  /// keeps the input the room is already using. Taking the system default here instead would
  /// silently move a live room onto whatever was plugged in most recently — a headset someone
  /// left connected is enough to do it, and nothing on the card would explain why the room
  /// suddenly sounds wrong.
  ///
  /// The first enrol on a Mac has no configuration to keep, and takes the system default through
  /// `residentDefault(origin:roomSlug:)`. That is the ONLY place the device is chosen.
  ///
  /// This lives here rather than inline in the CLI so the rule above is a test and not a comment.
  public mutating func applyEnrolment(
    origin: URL,
    roomSlug: String,
    installID: String,
    tapewriterPath: String?,
    ffmpegPath: String?
  ) {
    // X2: the bundle carries its own encoder, so the helper paths are re-pointed on every enrol.
    // A re-install off an older config must not keep pointing at a Homebrew ffmpeg that may not
    // be on this Mac at all. Nil means "not running from a bundle" — keep what is configured.
    if let tapewriterPath { self.tapewriterPath = tapewriterPath }
    if let ffmpegPath { self.ffmpegPath = ffmpegPath }
    self.origin = origin
    self.roomSlug = roomSlug
    self.installID = installID
    // §4.5 rule 1: the app's listener tab id is always app_<install_id>.
    self.tabID = "app_\(installID)"
    // §5.4: config.json holds no token. The session lives in the keychain from here on, and this
    // line is what guarantees a re-enrol leaves no earlier token behind on disk.
    self.etaRoomSession = nil
  }
}
