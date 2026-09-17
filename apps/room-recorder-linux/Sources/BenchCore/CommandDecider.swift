import Foundation

/// RoomEngine.swift:63-71. The Mac's names, so the Bench needs no change.
public enum RoomEnginePhase: String, Equatable, Sendable {
    case ready, recording, paused, ending, failed, superseded
}

public enum RoomCommandDecision: Equatable, Sendable {
    case start
    case acknowledgeCurrentState
    case resume
    case pause
    case end
    case refuse(String)
}

/// RoomEngine.swift:81-111, transcribed. Pure: a day kind and the phase in, a decision out.
public enum RoomCommandDecider {
    public static func decide(kind: BenchCommandKind, phase: RoomEnginePhase, overridePause: Bool = false) -> RoomCommandDecision {
        switch kind {
        case .startDay:
            switch phase {
            case .recording: return .acknowledgeCurrentState
            case .paused: return overridePause ? .resume : .refuse("room_paused")
            case .ending: return .refuse("ending_in_progress")
            case .superseded: return .refuse("superseded")
            case .ready, .failed: return .start
            }
        case .pauseDay:
            if phase == .paused { return .acknowledgeCurrentState }
            return phase == .recording ? .pause : .refuse("not_recording")
        case .resumeDay:
            if phase == .recording { return .acknowledgeCurrentState }
            return phase == .paused ? .resume : .refuse("not_paused")
        case .endDay:
            return phase == .recording || phase == .paused || phase == .failed ? .end : .refuse("no_active_session")
        case .setAudioInput, .checkUpdateNow, .reportDiag, .restartEngine, .unknown:
            return .refuse("unsupported_kind")
        }
    }
}

/// What a command's ack carries (RoomEngine.swift `CommandResult`).
public struct CommandResult: Equatable, Sendable {
    public var ok: Bool
    public var sessionID: String?
    public var error: String?
    public var audioInput: AudioInputAcknowledgement?
    public var verb: OperatorVerbAcknowledgement?

    public init(ok: Bool, sessionID: String?, error: String?, audioInput: AudioInputAcknowledgement? = nil,
                verb: OperatorVerbAcknowledgement? = nil) {
        self.ok = ok
        self.sessionID = sessionID
        self.error = error
        self.audioInput = audioInput
        self.verb = verb
    }
}

/// `set_audio_input`'s arguments (RoomEngine.swift `AudioInputRequest.parse`). Nil is `bad_args`: not an object, a
/// `device_uid` that is not a 1-256 character string, an `input_volume` that is not a finite number, or neither present.
/// A volume outside 0-1 is clamped, not refused.
public struct AudioInputRequest: Equatable, Sendable {
    public var deviceUID: String?
    public var inputVolume: Double?

    public static func parse(_ args: BenchJSON) -> AudioInputRequest? {
        guard case .object(let object) = args else { return nil }
        var request = AudioInputRequest()
        switch object["device_uid"] {
        case .none, .some(.null): break
        case .some(.string(let uid)):
            guard !uid.isEmpty, uid.count <= 256 else { return nil }
            request.deviceUID = uid
        case .some: return nil
        }
        switch object["input_volume"] {
        case .none, .some(.null): break
        case .some(.number(let volume)):
            guard volume.isFinite else { return nil }
            request.inputVolume = min(max(volume, 0), 1)
        case .some: return nil
        }
        guard request.deviceUID != nil || request.inputVolume != nil else { return nil }
        return request
    }
}

/// The capture is a separate, network-isolated process (V8). Moving it to another device is its own operation: this
/// process writes the new identity to config.json and waits for the capture to say what became of it.
public protocol CaptureDeviceSwitching: Sendable {
    /// Called after config.json names `uid`. `requestedAtWallNS` is the wall time just before that write, so only an
    /// answer to THIS request counts. Returns when the capture records from `uid`; throws `CaptureSwitchError`.
    func switchCapture(to uid: USBDeviceUID, requestedAtWallNS: Int64) async throws
}

public enum CaptureSwitchError: Error, Equatable, CustomStringConvertible {
    /// The capture found the device absent and kept recording the old one (it has put config.json back).
    case notPresent
    /// The device was attached but not ready; the capture went back to the old one (and put config.json back).
    case reverted(reason: String)
    /// No answer within the deadline: the capture is not running, or is not a build that watches config.json.
    case noConfirmation(seconds: Int)

    public var description: String {
        switch self {
        case .notPresent: return "device_not_present"
        case .reverted(let reason): return "reverted: \(reason)"
        case .noConfirmation(let s): return "capture_did_not_confirm within \(s) s"
        }
    }
}

/// `capture-device.json`, as room-recorder writes it (RecorderCore/DeviceConfig.swift `CaptureDeviceStatus`, same keys).
public struct CaptureDeviceReport: Codable, Equatable, Sendable {
    public var deviceUID: String
    public var requestedUID: String
    public var outcome: String
    public var alsaName: String?
    public var reason: String?
    public var atWallNS: Int64
    public var pid: Int32

    enum CodingKeys: String, CodingKey {
        case outcome, reason, pid
        case deviceUID = "device_uid"
        case requestedUID = "requested_uid"
        case alsaName = "alsa_name"
        case atWallNS = "at_wall_ns"
    }
}

/// The production switch (U3 fix 1): the capture watches config.json and re-pins itself; this waits for its answer.
public struct ConfigRepinSwitch: CaptureDeviceSwitching {
    /// 15 s = the capture's 1 s look at config.json + its 5 s bound for the new device to become ready + PipeWire's
    /// measured 5.0 s hold on a device it goes back to (M2.2) + 4 s for the clean stop and the re-exec.
    public static let confirmationDeadlineNS: UInt64 = 15_000_000_000
    static let pollNS: UInt64 = 250_000_000

    let store: RoomStore
    let sleeper: any Sleeper

    public init(store: RoomStore, sleeper: any Sleeper) {
        self.store = store
        self.sleeper = sleeper
    }

    public func switchCapture(to uid: USBDeviceUID, requestedAtWallNS: Int64) async throws {
        let url = store.root.appendingPathComponent("capture-device.json")
        var waited: UInt64 = 0
        while waited <= Self.confirmationDeadlineNS {
            if let report = try? store.read(CaptureDeviceReport.self, from: url),
               report.requestedUID == uid.description, report.atWallNS >= requestedAtWallNS {
                switch report.outcome {
                case "switched", "started" where report.deviceUID == uid.description: return
                case "refused_absent": throw CaptureSwitchError.notPresent
                case "reverted": throw CaptureSwitchError.reverted(reason: report.reason ?? "not ready")
                default: break
                }
            }
            try await sleeper.sleep(nanoseconds: Self.pollNS)
            waited += Self.pollNS
        }
        throw CaptureSwitchError.noConfirmation(seconds: Int(Self.confirmationDeadlineNS / 1_000_000_000))
    }
}
