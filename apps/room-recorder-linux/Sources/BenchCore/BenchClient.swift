import Foundation

/// The Bench HTTP layer, mirroring the Mac's `BenchClient` (apps/room-recorder/Sources/RoomRecorderCore/BenchClient.swift)
/// request for request.
///
/// ORIGIN: fixed at enrol and read from config.json. There is no environment override and no runtime setter.
/// AUTH: `Cookie: eta_room_session=<token>` on every API request (BenchClient.swift:816). There is no refresh call on the
/// Mac and none here; a refused token surfaces as `BenchError.isAuthRefused` for the engine to log.
/// The storage PUT and HEAD go to presigned URLs and carry no cookie, exactly as the Mac's do.
public struct BenchClient: Sendable {
    public static let maximumErrorBodyBytes = 4_096

    public let origin: URL
    let sessionToken: @Sendable () -> String?
    let transport: any HTTPTransport

    public init(origin: URL, transport: any HTTPTransport, sessionToken: @escaping @Sendable () -> String?) {
        self.origin = origin
        self.transport = transport
        self.sessionToken = sessionToken
    }

    // MARK: - Sessions

    /// `GET /api/bench/sessions/active?tab_id=&since=`
    public func activeSession(tabID: String?, since: String? = nil) async throws -> ActiveSessionResponse {
        var query: [URLQueryItem] = []
        if let tabID { query.append(URLQueryItem(name: "tab_id", value: tabID)) }
        if let since { query.append(URLQueryItem(name: "since", value: since)) }
        return try await decoded(try request(path: "/api/bench/sessions/active", query: query), as: ActiveSessionResponse.self)
    }

    /// `POST /api/bench/sessions` with `{"label": <string|null>, "mic_label": <string|null>}` — both keys always present.
    public func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
        struct Body: Encodable {
            let label: String?
            let micLabel: String?
            enum CodingKeys: String, CodingKey {
                case label
                case micLabel = "mic_label"
            }
            func encode(to encoder: Encoder) throws {
                var values = encoder.container(keyedBy: CodingKeys.self)
                if let label { try values.encode(label, forKey: .label) } else { try values.encodeNil(forKey: .label) }
                if let micLabel { try values.encode(micLabel, forKey: .micLabel) } else { try values.encodeNil(forKey: .micLabel) }
            }
        }
        var r = try request(path: "/api/bench/sessions", method: "POST")
        r.body = try JSONEncoder().encode(Body(label: label, micLabel: micLabel))
        return try await decoded(r, as: CreateSessionResponse.self)
    }

    /// `PATCH /api/bench/sessions/<id>` with `{"action": "pause"|"resume"|"end"}` (and `notes` only when given).
    public func patchSession(id: String, action: BenchSessionAction, notes: String? = nil) async throws -> BenchOKResponse {
        struct Body: Encodable {
            let action: BenchSessionAction
            let notes: String?
        }
        var r = try request(path: "/api/bench/sessions/\(Self.pathComponent(id))", method: "PATCH")
        r.body = try JSONEncoder().encode(Body(action: action, notes: notes))
        return try await decoded(r, as: BenchOKResponse.self)
    }

    // MARK: - Command bus

    /// `GET /api/bench/commands?tab_id=&prev_poll_at=&recording_session_id=&paused=&mic_peak=&mic_avg=&<install fields>`
    public func pollCommands(tabID: String, previousPollAt: String?, recordingSessionID: String?, paused: Bool,
                             primaryLevels: BenchLevelPair?, install: InstallPollFields?) async throws -> CommandPollResponse {
        var query = [URLQueryItem(name: "tab_id", value: tabID)]
        if let previousPollAt { query.append(URLQueryItem(name: "prev_poll_at", value: previousPollAt)) }
        if let recordingSessionID { query.append(URLQueryItem(name: "recording_session_id", value: recordingSessionID)) }
        query.append(URLQueryItem(name: "paused", value: paused ? "true" : "false"))
        if let primaryLevels {
            query.append(URLQueryItem(name: "mic_peak", value: InstallPollFields.fourDecimals(primaryLevels.peak)))
            query.append(URLQueryItem(name: "mic_avg", value: InstallPollFields.fourDecimals(primaryLevels.average)))
        }
        query.append(contentsOf: install?.queryItems() ?? [])
        return try await decoded(try request(path: "/api/bench/commands", query: query), as: CommandPollResponse.self)
    }

    /// `POST /api/bench/commands/<id>/ack` with `ok`, and `session_id`, `error`, the R4 audio fields and the Tier 1 verb
    /// fields only when present, all top level. Answer `{ok, id, status}`.
    public func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?,
                            audioInput: AudioInputAcknowledgement? = nil,
                            verb: OperatorVerbAcknowledgement? = nil) async throws -> CommandAcknowledgement {
        struct Body: Encodable {
            let ok: Bool
            let sessionID: String?
            let error: String?
            let audioInput: AudioInputAcknowledgement?
            let verb: OperatorVerbAcknowledgement?
            enum CodingKeys: String, CodingKey {
                case ok, error, deferred, held, restarting, diag
                case sessionID = "session_id"
                case appliedDeviceUID = "applied_device_uid"
                case appliedInputVolume = "applied_input_volume"
                case inputVolumeSettable = "input_volume_settable"
                case checkedAt = "checked_at"
                case offeredVersion = "offered_version"
            }
            func encode(to encoder: Encoder) throws {
                var values = encoder.container(keyedBy: CodingKeys.self)
                try values.encode(ok, forKey: .ok)
                try values.encodeIfPresent(sessionID, forKey: .sessionID)
                try values.encodeIfPresent(error, forKey: .error)
                try values.encodeIfPresent(audioInput?.appliedDeviceUID, forKey: .appliedDeviceUID)
                try values.encodeIfPresent(audioInput?.appliedInputVolume, forKey: .appliedInputVolume)
                try values.encodeIfPresent(audioInput?.inputVolumeSettable, forKey: .inputVolumeSettable)
                try values.encodeIfPresent(verb?.checkedAt, forKey: .checkedAt)
                try values.encodeIfPresent(verb?.offeredVersion, forKey: .offeredVersion)
                try values.encodeIfPresent(verb?.deferred, forKey: .deferred)
                try values.encodeIfPresent(verb?.held, forKey: .held)
                try values.encodeIfPresent(verb?.restarting, forKey: .restarting)
                try values.encodeIfPresent(verb?.diag, forKey: .diag)
            }
        }
        var r = try request(path: "/api/bench/commands/\(Self.pathComponent(commandID))/ack", method: "POST")
        r.body = try JSONEncoder().encode(Body(ok: ok, sessionID: sessionID, error: error, audioInput: audioInput, verb: verb))
        return try await decoded(r, as: CommandAcknowledgement.self)
    }

    // MARK: - Pieces: the five-step dance

    /// `POST /api/bench/upload-url` with `{session_id, idx, content_type}`.
    public func presign(_ piece: BenchPiece) async throws -> PresignResponse {
        struct Body: Encodable {
            let session_id: String
            let idx: Int
            let content_type: String
        }
        var r = try request(path: "/api/bench/upload-url", method: "POST")
        r.body = try JSONEncoder().encode(Body(session_id: piece.sessionID, idx: piece.index, content_type: piece.contentType))
        return try await decoded(r, as: PresignResponse.self, retention: .retainLocalPiece)
    }

    /// PUT to the presigned URL. No cookie, `Content-Type` the piece's.
    public func put(bytes: Data, to url: URL, contentType: String) async throws {
        _ = try await send(HTTPRequest(method: "PUT", url: url, headers: ["Content-Type": contentType], body: bytes),
                           retention: .retainLocalPiece)
    }

    /// HEAD the presigned head URL, requiring 2xx; the object's Content-Length.
    public func head(url: URL) async throws -> Int64? {
        try await send(HTTPRequest(method: "HEAD", url: url), retention: .retainLocalPiece).contentLength
    }

    /// HEAD that reads 404 as "not there yet" rather than an error.
    public func probeHead(url: URL) async throws -> BenchHeadResult {
        let response: HTTPResponse
        do {
            response = try await transport.send(HTTPRequest(method: "HEAD", url: url))
        } catch {
            throw BenchError.transport(message: String(describing: error).prefix(500).description, retention: .retainLocalPiece)
        }
        if response.status == 404 { return .missing }
        guard (200..<300).contains(response.status) else {
            throw BenchError.http(status: response.status, body: Self.boundedBody(response.body), retention: .retainLocalPiece)
        }
        return .present(contentLength: response.contentLength)
    }

    /// `POST /api/bench/chunks` with `{session_id, idx, content_type, started_at, ended_at, duration_ms, size_bytes,
    /// gap_before_ms}` and `peak_level` / `avg_level` only when present.
    public func register(_ piece: BenchPiece) async throws -> ChunkRegistrationResponse {
        struct Body: Encodable {
            let piece: BenchPiece
            enum CodingKeys: String, CodingKey {
                case sessionID = "session_id", index = "idx", contentType = "content_type", startedAt = "started_at"
                case endedAt = "ended_at", durationMS = "duration_ms", sizeBytes = "size_bytes"
                case gapBeforeMS = "gap_before_ms", peakLevel = "peak_level", averageLevel = "avg_level"
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
                try values.encodeIfPresent(piece.peakLevel, forKey: .peakLevel)
                try values.encodeIfPresent(piece.averageLevel, forKey: .averageLevel)
            }
        }
        var r = try request(path: "/api/bench/chunks", method: "POST")
        r.body = try JSONEncoder().encode(Body(piece: piece))
        return try await decoded(r, as: ChunkRegistrationResponse.self, retention: .retainLocalPiece)
    }

    /// presign -> HEAD -> PUT -> HEAD verify -> register (BenchClient.swift `uploadImmutablePiece`). A presign that says
    /// `already_verified` ends it there; an object already at the head URL with the right length skips the PUT.
    public func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws -> ImmutablePieceUploadResult {
        guard Int64(bytes.count) == piece.sizeBytes else {
            throw BenchError.sizeMismatch(expected: piece.sizeBytes, actual: Int64(bytes.count), retention: .retainLocalPiece)
        }
        let signed = try await presign(piece)
        if signed.alreadyVerified { return .alreadyVerified }
        guard let putURL = signed.url, let headURL = signed.headURL else {
            throw BenchError.invalidResponse(retention: .retainLocalPiece)
        }
        var uploaded = true
        if case .present(let existing)? = try? await probeHead(url: headURL), existing == piece.sizeBytes {
            uploaded = false
        } else {
            try await put(bytes: bytes, to: putURL, contentType: piece.contentType)
            let size = try await head(url: headURL)
            if let size, size != piece.sizeBytes {
                throw BenchError.sizeMismatch(expected: piece.sizeBytes, actual: size, retention: .retainLocalPiece)
            }
        }
        return .registered(response: try await register(piece), uploaded: uploaded)
    }

    // MARK: - Plumbing

    func request(path: String, method: String = "GET", query: [URLQueryItem] = []) throws -> HTTPRequest {
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { throw BenchError.invalidURL }
        // `percentEncodedPath`, not `path`: the id components are already percent-encoded, and the `path` setter would
        // encode their `%` a second time. (The Mac sets `path`; its ids are UUIDs, so the double encoding never bites.)
        components.percentEncodedPath = path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw BenchError.invalidURL }
        var headers = ["Accept": "application/json"]
        if method != "GET" && method != "HEAD" { headers["Content-Type"] = "application/json" }
        guard let token = sessionToken() else { throw BenchError.missingSessionCookie }
        headers["Cookie"] = "eta_room_session=\(token)"
        return HTTPRequest(method: method, url: url, headers: headers)
    }

    func decoded<T: Decodable>(_ request: HTTPRequest, as type: T.Type,
                               retention: BenchPieceRetention = .notApplicable) async throws -> T {
        let response = try await send(request, retention: retention)
        do { return try JSONDecoder().decode(type, from: response.body) } catch {
            throw BenchError.invalidResponse(retention: retention)
        }
    }

    func send(_ request: HTTPRequest, retention: BenchPieceRetention) async throws -> HTTPResponse {
        let response: HTTPResponse
        do {
            response = try await transport.send(request)
        } catch {
            throw BenchError.transport(message: String(describing: error).prefix(500).description, retention: retention)
        }
        guard (200..<300).contains(response.status) else {
            throw BenchError.http(status: response.status, body: Self.boundedBody(response.body), retention: retention)
        }
        return response
    }

    static func boundedBody(_ data: Data) -> String {
        String(decoding: data.prefix(maximumErrorBodyBytes), as: UTF8.self)
    }

    /// Percent-encodes a path component, `/` included (BenchClient.swift `pathComponent`).
    static func pathComponent(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
