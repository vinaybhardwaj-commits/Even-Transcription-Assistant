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

/// Linux has one continuous capture process, pinned by its own unit and network-isolated. Moving it to another device
/// is a capture-side operation this process cannot perform by itself; this seam is where it plugs in.
public protocol CaptureDeviceSwitching: Sendable {
    /// Throws with a short reason when the capture could not be moved to `uid`.
    func switchCapture(to uid: USBDeviceUID) async throws
}

public struct CaptureSwitchUnavailable: Error, CustomStringConvertible {
    public var description: String { "capture_device_switch_not_wired" }
    public init() {}
}

/// The production switch in U3: not wired. See the report — the capture unit's device is pinned in its ExecStart and
/// nothing yet carries config.json's device_uid to it. Every different-device switch therefore fails cleanly and is
/// rolled back; a same-device request and a volume change are unaffected.
public struct UnwiredCaptureSwitch: CaptureDeviceSwitching {
    public init() {}
    public func switchCapture(to uid: USBDeviceUID) async throws { throw CaptureSwitchUnavailable() }
}
