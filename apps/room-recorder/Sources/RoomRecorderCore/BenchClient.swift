import Foundation

public enum BenchPieceRetention: String, Codable, Sendable {
  case notApplicable = "not_applicable"
  case retainLocalPiece = "retain_local_piece"
}

public struct BenchHTTPError: Error, Equatable, Sendable, CustomStringConvertible {
  public let statusCode: Int
  public let body: String
  public let retention: BenchPieceRetention

  public var mustRetainLocalPiece: Bool { retention == .retainLocalPiece }
  public var description: String { "HTTP \(statusCode): \(body)" }
}

public enum BenchClientError: Error, Equatable, Sendable {
  case missingSessionCookie
  case loginCookieMissing
  case invalidResponse(retention: BenchPieceRetention)
  case invalidURL
  case transport(message: String, retention: BenchPieceRetention)
  case http(BenchHTTPError)
  case sizeMismatch(expected: Int64, actual: Int64?, retention: BenchPieceRetention)

  public var mustRetainLocalPiece: Bool {
    switch self {
    case .invalidResponse(let retention), .transport(_, let retention),
      .sizeMismatch(_, _, let retention):
      return retention == .retainLocalPiece
    case .http(let error):
      return error.mustRetainLocalPiece
    default:
      return false
    }
  }
}

public indirect enum JSONValue: Codable, Equatable, Sendable {
  case object([String: JSONValue])
  case array([JSONValue])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null

  public init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer()
    if value.decodeNil() {
      self = .null
    } else if let decoded = try? value.decode(Bool.self) {
      self = .bool(decoded)
    } else if let decoded = try? value.decode(Double.self) {
      self = .number(decoded)
    } else if let decoded = try? value.decode(String.self) {
      self = .string(decoded)
    } else if let decoded = try? value.decode([JSONValue].self) {
      self = .array(decoded)
    } else {
      self = .object(try value.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var value = encoder.singleValueContainer()
    switch self {
    case .object(let object): try value.encode(object)
    case .array(let array): try value.encode(array)
    case .string(let string): try value.encode(string)
    case .number(let number): try value.encode(number)
    case .bool(let bool): try value.encode(bool)
    case .null: try value.encodeNil()
    }
  }
}

public struct RoomLoginResponse: Codable, Equatable, Sendable {
  public struct Room: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let slug: String
  }
  public let ok: Bool
  public let room: Room
}

public enum BenchSessionStatus: String, Codable, Sendable {
  case recording
  case paused
  case ended
}

public struct BenchSession: Codable, Equatable, Sendable {
  public let id: String
  public let roomID: String?
  public let label: String?
  public let micLabel: String?
  public let status: BenchSessionStatus
  public let startedAt: String?
  public let lastAnyChunkAt: String?

  enum CodingKeys: String, CodingKey {
    case id
    case roomID = "room_id"
    case label
    case micLabel = "mic_label"
    case status
    case startedAt = "started_at"
    case lastAnyChunkAt = "last_any_chunk_at"
  }
}

public struct CreateSessionResponse: Codable, Equatable, Sendable {
  public let session: BenchSession
}

public struct ActiveSessionResponse: Codable, Equatable, Sendable {
  public struct NextIndex: Codable, Equatable, Sendable {
    public let primary: Int
    public let backup: Int
  }
  public let ok: Bool
  public let resumable: Bool
  public let session: BenchSession?
  public let nextIndex: NextIndex?
  public let reason: String?
  public let handoverPending: Bool
  public let tabGone: Bool
  public let handoverStarted: Bool?
  public let handoverComplete: Bool?

  enum CodingKeys: String, CodingKey {
    case ok, resumable, session, reason
    case nextIndex = "next_idx"
    case handoverPending = "handover_pending"
    case tabGone = "tab_gone"
    case handoverStarted = "handover_started"
    case handoverComplete = "handover_complete"
  }
}

public enum BenchSessionAction: String, Codable, Sendable {
  case pause
  case resume
  case end
}

public struct BenchOKResponse: Codable, Equatable, Sendable {
  public let ok: Bool
}

public struct BenchLevelPair: Equatable, Sendable {
  public let peak: Double
  public let average: Double

  public init?(peak: Double, average: Double) {
    guard peak.isFinite, average.isFinite, (0...1).contains(peak), (0...1).contains(average) else {
      return nil
    }
    self.peak = peak
    self.average = average
  }
}

public enum BenchCommandKind: String, Codable, Sendable {
  case startDay = "start_day"
  case pauseDay = "pause_day"
  case resumeDay = "resume_day"
  case endDay = "end_day"
}

public struct BenchCommand: Codable, Equatable, Sendable {
  public let id: String
  public let kind: BenchCommandKind
  public let args: JSONValue
  public let createdAt: String?

  enum CodingKeys: String, CodingKey {
    case id, kind, args
    case createdAt = "created_at"
  }
}

public struct CommandPollResponse: Codable, Equatable, Sendable {
  public let ok: Bool
  public let roomID: String?
  public let superseded: Bool
  public let now: String?
  public let commands: [BenchCommand]

  enum CodingKeys: String, CodingKey {
    case ok, superseded, now, commands
    case roomID = "room_id"
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    ok = try values.decode(Bool.self, forKey: .ok)
    roomID = try values.decodeIfPresent(String.self, forKey: .roomID)
    superseded = try values.decodeIfPresent(Bool.self, forKey: .superseded) ?? false
    now = try values.decodeIfPresent(String.self, forKey: .now)
    commands = try values.decodeIfPresent([BenchCommand].self, forKey: .commands) ?? []
  }
}

public struct CommandAcknowledgement: Codable, Equatable, Sendable {
  public let ok: Bool
  public let id: String
  public let status: String
}

public struct ConsultMarkResponse: Codable, Equatable, Sendable {
  public let ok: Bool
  public let delivered: Bool
  public let eventID: String
  public let sessionID: String
  public let at: String
  public let brainStatus: Int?
  public let reason: String?

  enum CodingKeys: String, CodingKey {
    case ok, delivered, at, reason
    case eventID = "event_id"
    case sessionID = "session_id"
    case brainStatus = "brain_status"
  }
}

public enum BenchPieceSource: String, Codable, Sendable {
  case primary
  case backup
}

public struct BenchPiece: Equatable, Sendable {
  public let sessionID: String
  public let index: Int
  public let contentType: String
  public let startedAt: String
  public let endedAt: String
  public let durationMS: Int
  public let sizeBytes: Int64
  public let gapBeforeMS: Int
  public let peakLevel: Double?
  public let averageLevel: Double?
  public let source: BenchPieceSource

  public init(
    sessionID: String,
    index: Int,
    contentType: String = "audio/webm",
    startedAt: String,
    endedAt: String,
    durationMS: Int,
    sizeBytes: Int64,
    gapBeforeMS: Int,
    peakLevel: Double? = nil,
    averageLevel: Double? = nil,
    source: BenchPieceSource = .primary
  ) {
    self.sessionID = sessionID
    self.index = index
    self.contentType = contentType
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.durationMS = durationMS
    self.sizeBytes = sizeBytes
    self.gapBeforeMS = gapBeforeMS
    self.peakLevel = peakLevel
    self.averageLevel = averageLevel
    self.source = source
  }
}

public struct PresignResponse: Codable, Equatable, Sendable {
  public let alreadyVerified: Bool
  public let url: URL?
  public let headURL: URL?
  public let key: String?
  public let expiresInSeconds: Int?
  public let method: String?
  public let contentType: String?
  public let source: BenchPieceSource?

  enum CodingKeys: String, CodingKey {
    case url, key, method, source
    case alreadyVerified = "already_verified"
    case headURL = "head_url"
    case expiresInSeconds = "expires_in_seconds"
    case contentType = "content_type"
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    alreadyVerified = try values.decodeIfPresent(Bool.self, forKey: .alreadyVerified) ?? false
    url = try values.decodeIfPresent(URL.self, forKey: .url)
    headURL = try values.decodeIfPresent(URL.self, forKey: .headURL)
    key = try values.decodeIfPresent(String.self, forKey: .key)
    expiresInSeconds = try values.decodeIfPresent(Int.self, forKey: .expiresInSeconds)
    method = try values.decodeIfPresent(String.self, forKey: .method)
    contentType = try values.decodeIfPresent(String.self, forKey: .contentType)
    source = try values.decodeIfPresent(BenchPieceSource.self, forKey: .source)
  }
}

public struct ChunkRegistrationResponse: Codable, Equatable, Sendable {
  public let ok: Bool
  public let key: String
  public let uploadState: String
  public let endedDisagrees: String?

  enum CodingKeys: String, CodingKey {
    case ok, key
    case uploadState = "upload_state"
    case endedDisagrees = "ended_disagrees"
  }
}

public enum ImmutablePieceUploadResult: Equatable, Sendable {
  case alreadyVerified
  case registered(response: ChunkRegistrationResponse, uploaded: Bool)
}

public actor BenchClient {
  public static let maximumErrorBodyBytes = 4_096

  private var configuration: RoomConfiguration
  private let session: URLSession
  private let encoder: JSONEncoder
  private let decoder: JSONDecoder

  public init(configuration: RoomConfiguration, session: URLSession = .shared) {
    self.configuration = configuration
    self.session = session
    self.encoder = JSONEncoder()
    self.decoder = JSONDecoder()
  }

  public func currentConfiguration() -> RoomConfiguration {
    configuration
  }

  @discardableResult
  public func login(pin: String) async throws -> RoomLoginResponse {
    struct Body: Encodable { let pin: String }
    var request = try request(path: loginPath, method: "POST", authenticated: false)
    request.httpBody = try encoder.encode(Body(pin: pin))
    let (data, response) = try await send(request, retention: .notApplicable)
    let cookies = HTTPCookie.cookies(
      withResponseHeaderFields: response.allHeaderFields.reduce(into: [String: String]()) {
        result, item in
        guard let key = item.key as? String, let value = item.value as? String else { return }
        result[key] = value
      },
      for: request.url!
    )
    guard let token = cookies.first(where: { $0.name == "eta_room_session" })?.value else {
      throw BenchClientError.loginCookieMissing
    }
    configuration.etaRoomSession = token
    return try decode(RoomLoginResponse.self, from: data, retention: .notApplicable)
  }

  public func activeSession(tabID: String? = nil, since: String? = nil) async throws
    -> ActiveSessionResponse
  {
    var query: [URLQueryItem] = []
    if let tabID { query.append(URLQueryItem(name: "tab_id", value: tabID)) }
    if let since { query.append(URLQueryItem(name: "since", value: since)) }
    let request = try request(path: "/api/bench/sessions/active", query: query)
    return try await decoded(request, as: ActiveSessionResponse.self)
  }

  public func createSession(label: String? = nil, micLabel: String? = nil) async throws
    -> CreateSessionResponse
  {
    struct Body: Encodable {
      let label: String?
      let micLabel: String?
      enum CodingKeys: String, CodingKey {
        case label
        case micLabel = "mic_label"
      }
      func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        if let label {
          try values.encode(label, forKey: .label)
        } else {
          try values.encodeNil(forKey: .label)
        }
        if let micLabel {
          try values.encode(micLabel, forKey: .micLabel)
        } else {
          try values.encodeNil(forKey: .micLabel)
        }
      }
    }
    var request = try request(path: "/api/bench/sessions", method: "POST")
    request.httpBody = try encoder.encode(Body(label: label, micLabel: micLabel))
    return try await decoded(request, as: CreateSessionResponse.self)
  }

  public func patchSession(
    id: String,
    action: BenchSessionAction,
    notes: String? = nil
  ) async throws -> BenchOKResponse {
    struct Body: Encodable {
      let action: BenchSessionAction
      let notes: String?
    }
    var request = try request(path: "/api/bench/sessions/\(pathComponent(id))", method: "PATCH")
    request.httpBody = try encoder.encode(Body(action: action, notes: notes))
    return try await decoded(request, as: BenchOKResponse.self)
  }

  public func pollCommands(
    tabID: String,
    previousPollAt: String? = nil,
    recordingSessionID: String? = nil,
    paused: Bool,
    primaryLevels: BenchLevelPair? = nil
  ) async throws -> CommandPollResponse {
    var query = [URLQueryItem(name: "tab_id", value: tabID)]
    if let previousPollAt {
      query.append(URLQueryItem(name: "prev_poll_at", value: previousPollAt))
    }
    if let recordingSessionID {
      query.append(URLQueryItem(name: "recording_session_id", value: recordingSessionID))
    }
    query.append(URLQueryItem(name: "paused", value: paused ? "true" : "false"))
    if let primaryLevels {
      query.append(URLQueryItem(name: "mic_peak", value: Self.levelString(primaryLevels.peak)))
      query.append(URLQueryItem(name: "mic_avg", value: Self.levelString(primaryLevels.average)))
    }
    query.append(URLQueryItem(name: "spare_device", value: "false"))
    var request = try request(path: "/api/bench/commands", query: query)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    return try await decoded(request, as: CommandPollResponse.self)
  }

  public func acknowledge(
    commandID: String,
    ok: Bool,
    sessionID: String? = nil,
    error: String? = nil
  ) async throws -> CommandAcknowledgement {
    struct Body: Encodable {
      let ok: Bool
      let sessionID: String?
      let error: String?
      enum CodingKeys: String, CodingKey {
        case ok, error
        case sessionID = "session_id"
      }
    }
    var request = try request(
      path: "/api/bench/commands/\(pathComponent(commandID))/ack",
      method: "POST"
    )
    request.httpBody = try encoder.encode(Body(ok: ok, sessionID: sessionID, error: error))
    return try await decoded(request, as: CommandAcknowledgement.self)
  }

  public func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    struct Body: Encodable {
      let type = "consult_mark"
      let at: String
      let sessionID: String?
      enum CodingKeys: String, CodingKey {
        case type, at
        case sessionID = "session_id"
      }
    }
    var request = try request(path: "/api/bench/brain-proxy", method: "POST")
    request.httpBody = try encoder.encode(Body(at: at, sessionID: sessionID))
    return try await decoded(request, as: ConsultMarkResponse.self)
  }

  public func presign(_ piece: BenchPiece) async throws -> PresignResponse {
    var request = try request(path: "/api/bench/upload-url", method: "POST")
    request.httpBody = try encoder.encode(PresignBody(piece: piece))
    return try await decoded(
      request,
      as: PresignResponse.self,
      retention: .retainLocalPiece
    )
  }

  public func put(bytes: Data, to url: URL, contentType: String) async throws {
    var request = URLRequest(url: url)
    request.httpMethod = "PUT"
    request.setValue(contentType, forHTTPHeaderField: "Content-Type")
    request.httpBody = bytes
    _ = try await send(request, retention: .retainLocalPiece)
  }

  public func head(url: URL) async throws -> Int64? {
    var request = URLRequest(url: url)
    request.httpMethod = "HEAD"
    let (_, response) = try await send(request, retention: .retainLocalPiece)
    return Self.contentLength(response)
  }

  public func register(_ piece: BenchPiece) async throws -> ChunkRegistrationResponse {
    var request = try request(path: "/api/bench/chunks", method: "POST")
    request.httpBody = try encoder.encode(RegisterPieceBody(piece: piece))
    return try await decoded(
      request,
      as: ChunkRegistrationResponse.self,
      retention: .retainLocalPiece
    )
  }

  public func uploadImmutablePiece(
    _ piece: BenchPiece,
    bytes: Data
  ) async throws -> ImmutablePieceUploadResult {
    guard Int64(bytes.count) == piece.sizeBytes else {
      throw BenchClientError.sizeMismatch(
        expected: piece.sizeBytes,
        actual: Int64(bytes.count),
        retention: .retainLocalPiece
      )
    }
    let signed = try await presign(piece)
    if signed.alreadyVerified { return .alreadyVerified }
    guard let putURL = signed.url, let headURL = signed.headURL else {
      throw BenchClientError.invalidResponse(retention: .retainLocalPiece)
    }

    var uploaded = true
    if let existingSize = try? await probeHead(url: headURL), existingSize == piece.sizeBytes {
      uploaded = false
    } else {
      try await put(bytes: bytes, to: putURL, contentType: piece.contentType)
      let size = try await head(url: headURL)
      if let size, size != piece.sizeBytes {
        throw BenchClientError.sizeMismatch(
          expected: piece.sizeBytes,
          actual: size,
          retention: .retainLocalPiece
        )
      }
    }
    return .registered(response: try await register(piece), uploaded: uploaded)
  }

  private var loginPath: String {
    "/room/\(pathComponent(configuration.roomSlug))/api/login"
  }

  private func request(
    path: String,
    method: String = "GET",
    authenticated: Bool = true,
    query: [URLQueryItem] = []
  ) throws -> URLRequest {
    guard var components = URLComponents(url: configuration.origin, resolvingAgainstBaseURL: false)
    else {
      throw BenchClientError.invalidURL
    }
    components.path = path
    components.queryItems = query.isEmpty ? nil : query
    guard let url = components.url else { throw BenchClientError.invalidURL }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if method != "GET" && method != "HEAD" {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if authenticated {
      guard let cookie = configuration.etaRoomSession else {
        throw BenchClientError.missingSessionCookie
      }
      request.setValue("eta_room_session=\(cookie)", forHTTPHeaderField: "Cookie")
    }
    return request
  }

  private func decoded<T: Decodable>(
    _ request: URLRequest,
    as type: T.Type,
    retention: BenchPieceRetention = .notApplicable
  ) async throws -> T {
    let (data, _) = try await send(request, retention: retention)
    return try decode(type, from: data, retention: retention)
  }

  private func decode<T: Decodable>(
    _ type: T.Type,
    from data: Data,
    retention: BenchPieceRetention
  ) throws -> T {
    do { return try decoder.decode(type, from: data) } catch {
      throw BenchClientError.invalidResponse(retention: retention)
    }
  }

  private func send(
    _ request: URLRequest,
    retention: BenchPieceRetention
  ) async throws -> (Data, HTTPURLResponse) {
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw BenchClientError.transport(
        message: String(describing: error).prefix(500).description,
        retention: retention
      )
    }
    guard let http = response as? HTTPURLResponse else {
      throw BenchClientError.invalidResponse(retention: retention)
    }
    guard (200..<300).contains(http.statusCode) else {
      let bounded = data.prefix(Self.maximumErrorBodyBytes)
      throw BenchClientError.http(
        BenchHTTPError(
          statusCode: http.statusCode,
          body: String(decoding: bounded, as: UTF8.self),
          retention: retention
        )
      )
    }
    return (data, http)
  }

  private func probeHead(url: URL) async throws -> Int64? {
    var request = URLRequest(url: url)
    request.httpMethod = "HEAD"
    let (_, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      return nil
    }
    return Self.contentLength(http)
  }

  private static func contentLength(_ response: HTTPURLResponse) -> Int64? {
    guard let raw = response.value(forHTTPHeaderField: "Content-Length") else { return nil }
    return Int64(raw)
  }

  private static func levelString(_ value: Double) -> String {
    String(format: "%.4f", locale: Locale(identifier: "en_US_POSIX"), value)
  }

  private func pathComponent(_ value: String) -> String {
    value.addingPercentEncoding(
      withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
  }
}

private struct PresignBody: Encodable {
  let piece: BenchPiece
  enum CodingKeys: String, CodingKey {
    case sessionID = "session_id"
    case index = "idx"
    case contentType = "content_type"
    case source
  }
  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(piece.sessionID, forKey: .sessionID)
    try values.encode(piece.index, forKey: .index)
    try values.encode(piece.contentType, forKey: .contentType)
    if piece.source == .backup { try values.encode(BenchPieceSource.backup, forKey: .source) }
  }
}

private struct RegisterPieceBody: Encodable {
  let piece: BenchPiece
  enum CodingKeys: String, CodingKey {
    case sessionID = "session_id"
    case index = "idx"
    case contentType = "content_type"
    case startedAt = "started_at"
    case endedAt = "ended_at"
    case durationMS = "duration_ms"
    case sizeBytes = "size_bytes"
    case gapBeforeMS = "gap_before_ms"
    case peakLevel = "peak_level"
    case averageLevel = "avg_level"
    case source
  }
  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(piece.sessionID, forKey: .sessionID)
    try values.encode(piece.index, forKey: .index)
    try values.encode(piece.contentType, forKey: .contentType)
    try values.encode(piece.startedAt, forKey: .startedAt)
    try values.encode(piece.endedAt, forKey: .endedAt)
    try values.encode(piece.durationMS, forKey: .durationMS)
    try values.encode(piece.sizeBytes, forKey: .sizeBytes)
    try values.encode(piece.gapBeforeMS, forKey: .gapBeforeMS)
    if let peak = piece.peakLevel { try values.encode(peak, forKey: .peakLevel) }
    if let average = piece.averageLevel { try values.encode(average, forKey: .averageLevel) }
    if piece.source == .backup { try values.encode(BenchPieceSource.backup, forKey: .source) }
  }
}
