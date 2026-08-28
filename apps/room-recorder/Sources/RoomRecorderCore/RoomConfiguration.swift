import Foundation

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
