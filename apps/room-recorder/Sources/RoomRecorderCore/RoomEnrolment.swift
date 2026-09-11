import Foundation

/// The `enrol` verb's exchange (Install and Fleet PRD §5.3, D9, D10).
///
/// Called by the §4.4 bootstrap script, on a clinic Mac, seconds after the same token fetched that
/// script. It is the only place the app ever turns a bootstrap token into a room session.
///
/// ─── NOTHING HERE READS FROM THE KEYBOARD ────────────────────────────────────────────────
/// §4.4: "The script runs with stdin owned by the pipe, so no command inside it may read from the
/// keyboard. The `enrol` verb takes everything from its arguments." That is why this exists at all
/// rather than reusing `login`, which calls `getpass` and requires a TTY. A verb that blocked on
/// stdin inside `curl | bash` would hang the paste forever with no output and no way out but
/// Ctrl-C — the worst possible failure in front of a clinician.
public struct RoomEnrolmentResponse: Decodable, Equatable, Sendable {
  public let installID: String
  public let roomSlug: String
  public let roomName: String
  public let session: Session

  public struct Session: Decodable, Equatable, Sendable {
    public let token: String
    public let expiresAt: String
    enum CodingKeys: String, CodingKey {
      case token
      case expiresAt = "expires_at"
    }
  }

  enum CodingKeys: String, CodingKey {
    case installID = "install_id"
    case roomSlug = "room_slug"
    case roomName = "room_name"
    case session
  }
}

extension RoomEnrolmentResponse {
  /// The record `enrol` persists once the exchange has succeeded.
  ///
  /// Extracted from `main.swift` in B1.5 so the thing the verb writes can be built and checked
  /// without a server: the verb now does nothing to it but hand it to `RoomSessionStore.save`.
  public func record(origin: URL) -> RoomKeychainRecord {
    RoomKeychainRecord(
      session: session.token,
      installID: installID,
      roomSlug: roomSlug,
      roomName: roomName,
      origin: origin.absoluteString)
  }
}

extension RoomEnrolment {
  /// Everything `enrol` writes once the exchange has succeeded: the session file, then config.json.
  ///
  /// ─── ENROL OWNS THE SESSION FILE (0.1.17) ────────────────────────────────────────────────
  /// On 11 Sep four bootstrap pastes on Home Office died the same way. The paste installs 0.1.8,
  /// whose enrol predates `room-session.json` and wrote only config.json; the next build read the
  /// file an EARLIER install had left behind, polled as that retired id, took a 409 and stopped for
  /// ever. So an enrol that writes a new install id into config.json must write the same id into
  /// the session file in the same breath, over whatever is there.
  ///
  /// Moved out of `main.swift` so that rule is a test and not a comment. The order is the one the
  /// verb already had — session first, config second — for the reason written there.
  ///
  /// NOTHING HERE DELETES. It runs only after `exchange` returned, so a refused, expired or
  /// unreachable enrol never gets this far and leaves the room's session exactly as it was. And the
  /// response cannot arrive without a token: `RoomEnrolmentResponse` requires one, so a body that
  /// lacks it is `malformedResponse` before anything is written.
  @discardableResult
  public static func persist(
    _ enrolled: RoomEnrolmentResponse,
    origin: URL,
    root: URL,
    tapewriterPath: String?,
    ffmpegPath: String?,
    /// Only called on the first enrol on a Mac, when there is no config.json to re-point.
    firstEnrolConfiguration: () throws -> RoomConfiguration
  ) throws -> RoomConfiguration {
    try RoomSessionStore.save(enrolled.record(origin: origin), root: root)

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
      configuration = try firstEnrolConfiguration()
    }
    // One named mutation, tested in RoomEnrolmentConfigurationTests. `deviceUID` is not among
    // the fields it touches, which is the migration rule V ruled on.
    configuration.applyEnrolment(
      origin: origin,
      roomSlug: enrolled.roomSlug,
      installID: enrolled.installID,
      tapewriterPath: tapewriterPath,
      ffmpegPath: ffmpegPath
    )
    try persistence.saveConfiguration(configuration)
    return configuration
  }
}

public enum RoomEnrolmentError: Error, LocalizedError, Equatable {
  case originNotHTTPS(String)
  case originHostNotAllowed(String)
  case transport(String)
  case server(status: Int, code: String, message: String)
  case malformedResponse

  public var errorDescription: String? {
    switch self {
    case .originNotHTTPS(let value):
      return "--origin must be an https URL, got: \(value)"
    case .originHostNotAllowed(let host):
      return
        "--origin host is not allowed: \(host). Allowed: \(RoomEnrolment.allowedHosts.sorted().joined(separator: ", "))"
    case .transport(let message):
      return "could not reach the enrol endpoint: \(message)"
    case .server(let status, let code, let message):
      // The server's own code, printed verbatim. §5.3 item 4: the script has `set -e` active, so
      // this line is the last thing V sees before the paste stops — it has to name the cause.
      return "enrol refused (HTTP \(status)) \(code): \(message)"
    case .malformedResponse:
      return "the enrol endpoint returned something this build cannot read"
    }
  }
}

public enum RoomEnrolment {
  /// §5.3 item 1: "The allowed host list is a compile-time constant."
  ///
  /// COMPILE-TIME, because `--origin` arrives inside a string a clinic Mac downloaded and piped
  /// into bash. The token is the credential on that path and the origin decides where it is SENT;
  /// a mistyped or substituted origin would post a live enrolment token to a host of somebody
  /// else's choosing. A runtime-configurable list would move that decision back into the data.
  public static let allowedHosts: Set<String> = [
    "www.evenscribe.app",
    "evenscribe.app",
  ]

  /// Validate `--origin` against §5.3 item 1 before anything is sent anywhere.
  public static func validate(origin raw: String) throws -> URL {
    guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), scheme == "https",
      let host = url.host?.lowercased()
    else {
      throw RoomEnrolmentError.originNotHTTPS(raw)
    }
    guard allowedHosts.contains(host) else {
      throw RoomEnrolmentError.originHostNotAllowed(host)
    }
    var components = URLComponents()
    components.scheme = "https"
    components.host = host
    if let port = url.port { components.port = port }
    guard let normalized = components.url else { throw RoomEnrolmentError.originNotHTTPS(raw) }
    return normalized
  }

  /// POST `{ token }` to `/api/room-recorder/enrol` and return what came back.
  ///
  /// The token is never logged and never echoed, on any path including the error paths — the
  /// server's error CODE is what identifies the failure, and it is the same three words for an
  /// unknown, expired or spent token by design.
  public static func exchange(
    token: String,
    origin: URL,
    session: URLSession = .shared
  ) async throws -> RoomEnrolmentResponse {
    var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)
    components?.path = "/api/room-recorder/enrol"
    guard let url = components?.url else { throw RoomEnrolmentError.malformedResponse }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.httpBody = try JSONEncoder().encode(["token": token])

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw RoomEnrolmentError.transport(String(describing: error).prefix(300).description)
    }
    guard let http = response as? HTTPURLResponse else {
      throw RoomEnrolmentError.malformedResponse
    }
    guard (200..<300).contains(http.statusCode) else {
      let (code, message) = decodeServerError(data)
      throw RoomEnrolmentError.server(status: http.statusCode, code: code, message: message)
    }
    do {
      return try JSONDecoder().decode(RoomEnrolmentResponse.self, from: data)
    } catch {
      throw RoomEnrolmentError.malformedResponse
    }
  }

  /// Pull `{ error: { code, message } }` out of a refusal, falling back to the raw body.
  /// The envelope is the one every route in this app uses, so this reads them all.
  static func decodeServerError(_ data: Data) -> (code: String, message: String) {
    struct Envelope: Decodable {
      struct Inner: Decodable {
        let code: String?
        let message: String?
      }
      let error: Inner?
    }
    if let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
      let inner = envelope.error
    {
      return (inner.code ?? "UNKNOWN", inner.message ?? "")
    }
    let raw = String(decoding: data.prefix(300), as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return ("UNKNOWN", raw.isEmpty ? "no response body" : raw)
  }
}
