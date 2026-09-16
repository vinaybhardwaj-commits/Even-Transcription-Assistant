import Foundation

/// `POST /api/room-recorder/enrol` (RoomEnrolment.swift:170-184) and what it persists.
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

public enum RoomEnrolmentError: Error, Equatable, CustomStringConvertible {
    case originNotHTTPS(String)
    case originHostNotAllowed(String)
    case transport(String)
    case server(status: Int, code: String, message: String)
    case malformedResponse
    case deviceUIDInvalid(String)
    case deviceNotPresent(String)
    case deviceIdentityConflict(configured: String, requested: String)
    case firstEnrolNeedsDevice
    case ffmpegMissing(String)

    public var description: String {
        switch self {
        case .originNotHTTPS(let v): return "--origin must be an https URL, got: \(v)"
        case .originHostNotAllowed(let host):
            return "--origin host is not allowed: \(host). Allowed: \(RoomEnrolment.allowedHosts.sorted().joined(separator: ", "))"
        case .transport(let m): return "could not reach the enrol endpoint: \(m)"
        case .server(let status, let code, let message): return "enrol refused (HTTP \(status)) \(code): \(message)"
        case .malformedResponse: return "the enrol endpoint returned something this build cannot read"
        case .deviceUIDInvalid(let v): return "--device-uid must be usb:<VID>:<PID> in hex, e.g. usb:0d8c:0134; got: \(v)"
        case .deviceNotPresent(let uid): return "device_not_present: \(uid) is not among the USB capture devices attached now; nothing was sent and nothing was written"
        case .deviceIdentityConflict(let configured, let requested):
            return "this room already records from \(configured); a re-enrol keeps the device identity, so --device-uid \(requested) is refused. Change the device with set_audio_input from the Bench."
        case .firstEnrolNeedsDevice: return "the first enrol on this machine needs --device-uid usb:<VID>:<PID> (e.g. usb:0d8c:0134 for the TM20)"
        case .ffmpegMissing(let path): return "ffmpeg is not an executable at the pinned path \(path); install it (U4 apt dependency) before enrolling"
        }
    }
}

public enum RoomEnrolment {
    /// §5.3 item 1: a compile-time constant (RoomEnrolment.swift:142-163). No env override, no config override.
    public static let allowedHosts: Set<String> = ["www.evenscribe.app", "evenscribe.app"]

    #if BENCH_TEST_HOOKS
    /// Test-hook builds only (-Xswiftc -DBENCH_TEST_HOOKS), for the local stub. A release build does not contain this.
    public static let allowsLocalStubOrigin = true
    #else
    public static let allowsLocalStubOrigin = false
    #endif

    public static func validate(origin raw: String) throws -> URL {
        try validate(origin: raw, allowLocalStub: allowsLocalStubOrigin)
    }

    /// https, host in the allowlist (case-insensitive), normalised to scheme://host[:port] with nothing else.
    static func validate(origin raw: String, allowLocalStub: Bool) throws -> URL {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else {
            throw RoomEnrolmentError.originNotHTTPS(raw)
        }
        let localStub = allowLocalStub && scheme == "http" && (host == "127.0.0.1" || host == "localhost")
        guard scheme == "https" || localStub else { throw RoomEnrolmentError.originNotHTTPS(raw) }
        guard allowedHosts.contains(host) || localStub else { throw RoomEnrolmentError.originHostNotAllowed(host) }
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        if let port = url.port { components.port = port }
        guard let normalized = components.url else { throw RoomEnrolmentError.originNotHTTPS(raw) }
        return normalized
    }

    /// POST `{"token": ...}`. The token is never logged or echoed on any path; the server's error CODE identifies the
    /// failure. No cookie: there is no session yet.
    public static func exchange(token: String, origin: URL, transport: any HTTPTransport) async throws -> RoomEnrolmentResponse {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)
        components?.percentEncodedPath = "/api/room-recorder/enrol"
        guard let url = components?.url else { throw RoomEnrolmentError.malformedResponse }
        let request = HTTPRequest(method: "POST", url: url,
                                  headers: ["Content-Type": "application/json", "Accept": "application/json"],
                                  body: try JSONEncoder().encode(["token": token]))
        let response: HTTPResponse
        do {
            response = try await transport.send(request)
        } catch {
            throw RoomEnrolmentError.transport(String(describing: error).prefix(300).description)
        }
        guard (200..<300).contains(response.status) else {
            let (code, message) = decodeServerError(response.body)
            throw RoomEnrolmentError.server(status: response.status, code: code, message: message)
        }
        do {
            return try JSONDecoder().decode(RoomEnrolmentResponse.self, from: response.body)
        } catch {
            throw RoomEnrolmentError.malformedResponse
        }
    }

    /// `{ error: { code, message } }`, falling back to the raw body (RoomEnrolment.swift `decodeServerError`).
    static func decodeServerError(_ data: Data) -> (code: String, message: String) {
        struct Envelope: Decodable {
            struct Inner: Decodable {
                let code: String?
                let message: String?
            }
            let error: Inner?
        }
        if let envelope = try? JSONDecoder().decode(Envelope.self, from: data), let inner = envelope.error {
            return (inner.code ?? "UNKNOWN", inner.message ?? "")
        }
        let raw = String(decoding: data.prefix(300), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return ("UNKNOWN", raw.isEmpty ? "no response body" : raw)
    }

    /// Everything that must hold BEFORE the token is spent: an existing configuration's device is kept; a first enrol
    /// names one; either way it must be attached now. Returns the device identity the room will have.
    public static func preflight(store: RoomStore, requestedDeviceUID: String?, devices: [EnumeratedCaptureDevice],
                                 ffmpegIsExecutable: Bool) throws -> USBDeviceUID {
        try store.prepareRoot()
        guard ffmpegIsExecutable else { throw RoomEnrolmentError.ffmpegMissing(Pinned.ffmpegPath) }
        let existing = try store.loadConfig()
        let chosen: String
        if let existing {
            if let requested = requestedDeviceUID, USBDeviceUID(requested)?.description != existing.deviceUID {
                throw RoomEnrolmentError.deviceIdentityConflict(configured: existing.deviceUID, requested: requested)
            }
            chosen = existing.deviceUID
        } else {
            guard let requested = requestedDeviceUID else { throw RoomEnrolmentError.firstEnrolNeedsDevice }
            chosen = requested
        }
        guard let uid = USBDeviceUID(chosen) else { throw RoomEnrolmentError.deviceUIDInvalid(chosen) }
        guard DeviceResolution.resolve(uid.description, in: devices) != nil else {
            throw RoomEnrolmentError.deviceNotPresent(uid.description)
        }
        return uid
    }

    /// Persist, in the Mac's load-bearing order (RoomEnrolment.swift:69-106): room-session.json FIRST, then config.json
    /// re-pointed by `applyEnrolment`. A crash between the two leaves the new session beside the old config, which the
    /// next enrol overwrites; the reverse order could leave a config naming an install whose session was never written.
    /// Nothing here deletes, except the retired marker of a DIFFERENT install id.
    @discardableResult
    public static func persist(_ enrolled: RoomEnrolmentResponse, origin: URL, deviceUID: USBDeviceUID, store: RoomStore,
                               now: Date = Date()) throws -> RoomConfig {
        try store.saveSession(RoomSessionRecord(
            sessionToken: enrolled.session.token, installID: enrolled.installID, roomSlug: enrolled.roomSlug,
            roomName: enrolled.roomName, origin: origin.absoluteString, writtenBy: Pinned.appVersion, writtenAt: now))
        var config = ((try? store.loadConfig()) ?? nil) ?? RoomConfig(origin: origin, roomSlug: enrolled.roomSlug, deviceUID: deviceUID.description)
        config.applyEnrolment(origin: origin, roomSlug: enrolled.roomSlug, installID: enrolled.installID)
        try store.saveConfig(config)
        if let retired = try? store.loadRetired(), retired.installID != enrolled.installID {
            try store.clearRetired()
        }
        return config
    }
}
