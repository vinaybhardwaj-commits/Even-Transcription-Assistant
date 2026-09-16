import Foundation

// Every wire shape here is INFERRED from the Mac source (apps/room-recorder/Sources/RoomRecorderCore/BenchClient.swift,
// read 16 Sep 2026), key for key. None has been checked against the live server from this repository.

public enum BenchPieceRetention: String, Sendable {
    case notApplicable = "not_applicable"
    case retainLocalPiece = "retain_local_piece"
}

public enum BenchError: Error, Equatable, Sendable, CustomStringConvertible {
    case missingSessionCookie
    case invalidURL
    case invalidResponse(retention: BenchPieceRetention)
    case transport(message: String, retention: BenchPieceRetention)
    case http(status: Int, body: String, retention: BenchPieceRetention)
    case sizeMismatch(expected: Int64, actual: Int64?, retention: BenchPieceRetention)

    /// BenchClient.swift:28-41. A piece whose upload failed this way must stay in the spool.
    public var mustRetainLocalPiece: Bool {
        switch self {
        case .invalidResponse(let r), .transport(_, let r), .http(_, _, let r), .sizeMismatch(_, _, let r):
            return r == .retainLocalPiece
        default:
            return false
        }
    }

    public var description: String {
        switch self {
        case .missingSessionCookie: return "no room session to authenticate with"
        case .invalidURL: return "invalid request URL"
        case .invalidResponse: return "the server returned something this build cannot read"
        case .transport(let message, _): return "transport: \(message)"
        case .http(let status, let body, _): return "HTTP \(status): \(body)"
        case .sizeMismatch(let expected, let actual, _):
            return "size mismatch: expected \(expected), got \(actual.map(String.init) ?? "no Content-Length")"
        }
    }

    /// RoomEngine.swift:1029-1033 — the status AND the code, never the status alone.
    public var isRetired: Bool {
        guard case .http(let status, let body, _) = self else { return false }
        return status == 409 && body.contains("RETIRED")
    }

    /// RoomEngine.swift `commandNotPending`: 404 carrying `command_not_pending`.
    public var isCommandNotPending: Bool {
        guard case .http(let status, let body, _) = self else { return false }
        return status == 404 && body.contains("command_not_pending")
    }

    /// Not in the Mac. A token that stops working (401/403) is how an expired 365-day session shows itself; the ruling
    /// is no refresh path, so it is named, logged loudly, and capture continues.
    public var isAuthRefused: Bool {
        guard case .http(let status, _, _) = self else { return false }
        return status == 401 || status == 403
    }
}

public enum BenchSessionStatus: String, Codable, Sendable {
    case recording, paused, ended
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
        case id, label, status
        case roomID = "room_id"
        case micLabel = "mic_label"
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
    case pause, resume, end
}

public struct BenchOKResponse: Codable, Equatable, Sendable {
    public let ok: Bool
}

/// BenchClient.swift `BenchLevelPair`: both finite and inside 0-1, or nothing.
public struct BenchLevelPair: Equatable, Sendable {
    public let peak: Double
    public let average: Double

    public init?(peak: Double, average: Double) {
        guard peak.isFinite, average.isFinite, (0...1).contains(peak), (0...1).contains(average) else { return nil }
        self.peak = peak
        self.average = average
    }
}

/// The eight kinds (`lib/bench-commands.ts` COMMAND_KINDS as the Mac lists them). An unknown string is a VALUE, never a
/// decode failure (R4-D2): one stranger must not cost the whole poll.
public enum BenchCommandKind: Hashable, Sendable, Codable {
    case startDay, pauseDay, resumeDay, endDay, setAudioInput, checkUpdateNow, reportDiag, restartEngine
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "start_day": self = .startDay
        case "pause_day": self = .pauseDay
        case "resume_day": self = .resumeDay
        case "end_day": self = .endDay
        case "set_audio_input": self = .setAudioInput
        case "check_update_now": self = .checkUpdateNow
        case "report_diag": self = .reportDiag
        case "restart_engine": self = .restartEngine
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .startDay: return "start_day"
        case .pauseDay: return "pause_day"
        case .resumeDay: return "resume_day"
        case .endDay: return "end_day"
        case .setAudioInput: return "set_audio_input"
        case .checkUpdateNow: return "check_update_now"
        case .reportDiag: return "report_diag"
        case .restartEngine: return "restart_engine"
        case .unknown(let raw): return raw
        }
    }

    public init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        try value.encode(rawValue)
    }
}

public struct BenchCommand: Codable, Equatable, Sendable {
    public let id: String
    public let kind: BenchCommandKind
    public let args: BenchJSON
    public let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, kind, args
        case createdAt = "created_at"
    }

    public init(id: String, kind: BenchCommandKind, args: BenchJSON = .null, createdAt: String? = nil) {
        self.id = id
        self.kind = kind
        self.args = args
        self.createdAt = createdAt
    }

    /// `args` absent is `.null`; a `created_at` of the wrong type costs that field only.
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try values.decode(String.self, forKey: .id),
                  kind: try values.decode(BenchCommandKind.self, forKey: .kind),
                  args: try values.decodeIfPresent(BenchJSON.self, forKey: .args) ?? .null,
                  createdAt: try? values.decodeIfPresent(String.self, forKey: .createdAt))
    }
}

/// A command that does not decode at all is dropped here and the commands beside it still run.
private struct DecodedBenchCommand: Decodable {
    let command: BenchCommand?
    init(from decoder: Decoder) throws { command = try? BenchCommand(from: decoder) }
}

public struct CommandPollResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let roomID: String?
    public let superseded: Bool
    public let now: String?
    public let commands: [BenchCommand]
    public let assignedChannel: String?

    enum CodingKeys: String, CodingKey {
        case ok, superseded, now, commands
        case roomID = "room_id"
        case assignedChannel = "assigned_channel"
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        ok = try values.decode(Bool.self, forKey: .ok)
        roomID = try values.decodeIfPresent(String.self, forKey: .roomID)
        superseded = try values.decodeIfPresent(Bool.self, forKey: .superseded) ?? false
        now = try values.decodeIfPresent(String.self, forKey: .now)
        commands = try values.decodeIfPresent([DecodedBenchCommand].self, forKey: .commands)?.compactMap(\.command) ?? []
        assignedChannel = (try? values.decodeIfPresent(String.self, forKey: .assignedChannel)) ?? nil
    }
}

public struct CommandAcknowledgement: Codable, Equatable, Sendable {
    public let ok: Bool
    public let id: String
    public let status: String
}

/// R4-D1: the `set_audio_input` fields of an ack. Each sent only when measured or applied.
public struct AudioInputAcknowledgement: Equatable, Sendable {
    public var appliedDeviceUID: String?
    public var appliedInputVolume: Double?
    public var inputVolumeSettable: Bool?

    public init(appliedDeviceUID: String? = nil, appliedInputVolume: Double? = nil, inputVolumeSettable: Bool? = nil) {
        self.appliedDeviceUID = appliedDeviceUID
        self.appliedInputVolume = appliedInputVolume
        self.inputVolumeSettable = inputVolumeSettable
    }
}

/// Tier 1 §3: an operator verb's ack fields. Each sent only when the verb produced it.
public struct OperatorVerbAcknowledgement: Equatable, Sendable {
    public var checkedAt: String?
    public var offeredVersion: String?
    public var deferred: Bool?
    public var held: Bool?
    public var restarting: Bool?
    public var diag: BenchJSON?

    public init(checkedAt: String? = nil, offeredVersion: String? = nil, deferred: Bool? = nil, held: Bool? = nil,
                restarting: Bool? = nil, diag: BenchJSON? = nil) {
        self.checkedAt = checkedAt
        self.offeredVersion = offeredVersion
        self.deferred = deferred
        self.held = held
        self.restarting = restarting
        self.diag = diag
    }
}

public enum BenchPieceSource: String, Codable, Sendable {
    case primary, backup
}

/// One piece as the upload and register calls describe it. `source` is always primary: backup pieces are dead on the
/// Mac (V7) and not implemented here.
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

    public init(sessionID: String, index: Int, contentType: String = "audio/webm", startedAt: String, endedAt: String,
                durationMS: Int, sizeBytes: Int64, gapBeforeMS: Int, peakLevel: Double? = nil, averageLevel: Double? = nil) {
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
    }
}

public struct PresignResponse: Decodable, Equatable, Sendable {
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

public enum BenchHeadResult: Equatable, Sendable {
    case missing
    case present(contentLength: Int64?)
}

public enum ImmutablePieceUploadResult: Equatable, Sendable {
    case alreadyVerified
    case registered(response: ChunkRegistrationResponse, uploaded: Bool)
}
