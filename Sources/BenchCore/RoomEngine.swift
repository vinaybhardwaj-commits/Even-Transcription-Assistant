import Foundation

/// How the engine starts cutting pieces. Linux's tape never stops (D6), so "start" means "cut from here", never
/// "launch a capture".
public enum LaneStartTrigger: Equatable, Sendable {
    case startDay, resumeDay, reconciliation
}

/// The piece side of the engine: the cursor over the continuous tape, the spool and the upload. Stage 4's
/// `TapePieceLane` is the production one.
public protocol PieceLane: Sendable {
    /// Begin cutting pieces for `sessionID` with index `nextIndex`. Throws when the tape shows no durable growth within
    /// its deadline — the capture process is not running, and a session must not open on a dead microphone.
    func start(sessionID: String, nextIndex: Int, trigger: LaneStartTrigger) async throws
    /// Cut everything durable into pieces, the last one partial, and stop cutting. The tape is untouched and keeps
    /// advancing. Idempotent: a lane that is not cutting does nothing.
    func stopAndFlush() async throws
    /// Cut the full pieces now due. Does nothing while not cutting.
    func publishAvailable() async throws
    /// Upload every spooled piece, oldest first. True when a registration said the server had ended the session.
    func drainPending() async throws -> Bool
    func pendingCount() async -> Int
    func isCutting() async -> Bool
    func nextIndex() async -> Int
    /// The tape's durable sample count now, or nil when the index cannot be read.
    func durableSamples() async -> Int64?
    /// The latest checkpoint's rms, peak and zero_ratio.
    func latestLevels() async -> (rms: Double?, peak: Double?, zeroRatio: Double?)
    /// The session the lane was last cutting for, forgotten at a session end.
    func endSession() async
}

public struct MachineFacts: Equatable, Sendable {
    public var hostname: String?
    public var hardwareModel: String?
    public var osVersion: String?
    public var neverSleep: Bool?
    public var launchedBy: String?
    public init(hostname: String? = nil, hardwareModel: String? = nil, osVersion: String? = nil, neverSleep: Bool? = nil,
                launchedBy: String? = nil) {
        self.hostname = hostname
        self.hardwareModel = hardwareModel
        self.osVersion = osVersion
        self.neverSleep = neverSleep
        self.launchedBy = launchedBy
    }
}

public struct RoomEngineEnvironment: Sendable {
    public var client: BenchClient
    public var store: RoomStore
    public var lane: any PieceLane
    public var devices: any CaptureDeviceEnumerating
    public var volume: any InputVolumeControlling
    public var captureSwitch: any CaptureDeviceSwitching
    public var machineFacts: @Sendable () -> MachineFacts
    public var ffmpegVersion: @Sendable () -> String?
    public var sleeper: any Sleeper
    public var log: RoomLog
    public var now: @Sendable () -> Date

    public init(client: BenchClient, store: RoomStore, lane: any PieceLane, devices: any CaptureDeviceEnumerating,
                volume: any InputVolumeControlling, captureSwitch: any CaptureDeviceSwitching,
                machineFacts: @escaping @Sendable () -> MachineFacts, ffmpegVersion: @escaping @Sendable () -> String?,
                sleeper: any Sleeper, log: RoomLog, now: @escaping @Sendable () -> Date = { Date() }) {
        self.client = client
        self.store = store
        self.lane = lane
        self.devices = devices
        self.volume = volume
        self.captureSwitch = captureSwitch
        self.machineFacts = machineFacts
        self.ffmpegVersion = ffmpegVersion
        self.sleeper = sleeper
        self.log = log
        self.now = now
    }
}

public enum RoomEngineError: Error, Equatable, CustomStringConvertible {
    case noActiveSession, roomPaused, handoverPending, sessionEndedByServer
    case pendingUploads(Int)
    case io(String)

    public var description: String {
        switch self {
        case .noActiveSession: return "no_active_session"
        case .roomPaused: return "room_paused"
        case .handoverPending: return "browser_handover_pending"
        case .sessionEndedByServer: return "session_ended_by_server"
        case .pendingUploads(let n): return "\(n) piece(s) remain pending"
        case .io(let m): return m
        }
    }
}

/// The poll loop and the command bus (RoomEngine.swift `run()` and `handle(_:)`), with the plain-capture paths of the
/// Mac and none of its resident-archive or control-journal machinery (V4: dormant on the Mac).
public actor RoomEngine {
    public enum Exit: Equatable, Sendable {
        /// 409 RETIRED. Written down; this install never polls again.
        case retired
        /// The poll said `superseded`. Idle, not polling.
        case superseded
        /// `restart_engine`, after its ack landed. The process exits with `restartExitCode` for systemd to relaunch.
        case restart
        case cancelled
    }

    public static let pollIntervalNS: UInt64 = 1_500_000_000       // RoomEngine.swift:1365
    public static let backoffStartNS: UInt64 = 5_000_000_000       // :1207
    public static let backoffCapNS: UInt64 = 30_000_000_000        // :1391-1395
    /// RoomEngine.swift: 75, sysexits EX_TEMPFAIL. Not 0 (a deliberate stop), not 1 (any error).
    public static let restartExitCode: Int32 = 75
    static let reportDiagDefaultLines = 100
    static let reportDiagMaxLines = 500
    static let reportDiagLineMax = 300
    static let reportDiagForbidden = ["eta_room_session", "etaRoomSession", "commandVerifyKey", "SCRIBE_MCP_TOKEN",
                                      "authorization", "cookie", "session_token"]
    /// A refused token is said at once and then every ten minutes while it lasts, not every backoff.
    static let authRefusedRepeatSeconds: TimeInterval = 600

    public private(set) var phase: RoomEnginePhase = .ready
    public private(set) var sessionID: String?
    var roomID: String?
    var nextPieceIndex = 0
    var previousPollAt: String?
    var completedCommands: [String: CommandResult] = [:]
    var lastError: String?
    var needsActiveReconciliation = false
    var lastDurableSamples: Int64?
    var restartRequested = false
    var authRefusedLoggedAt: Date?
    var config: RoomConfig
    let installID: String
    let env: RoomEngineEnvironment

    public init(config: RoomConfig, installID: String, environment: RoomEngineEnvironment) {
        self.config = config
        self.installID = installID
        self.env = environment
    }

    var tabID: String { config.tabID ?? "app_\(installID)" }
    var sessionIsOpen: Bool { phase == .recording || phase == .paused }
    func log(_ m: String) { env.log(m) }

    // MARK: - run

    public func run() async -> Exit {
        if let retired = try? env.store.loadRetired(), retired.installID == installID {
            log("install \(installID) was retired by the server (409 RETIRED) at \(ISO8601.string(retired.at)); not polling. Re-enrol to serve this room.")
            lastError = "retired: this install was superseded by a newer enrolment"
            phase = .superseded
            await saveStatus()
            return .retired
        }
        do {
            _ = try await env.lane.drainPending()
        } catch {
            needsActiveReconciliation = true
            lastError = bounded(error)
            await saveStatus(preferred: .offline)
        }
        do {
            try await adopt(try await env.client.activeSession(tabID: tabID))
        } catch {
            needsActiveReconciliation = true
            lastError = bounded(error)
            await saveStatus(preferred: .offline)
        }

        var backoff = Self.backoffStartNS
        var cancelled = false
        var uploadRetryAfter = Date.distantPast
        var uploadBackoff: TimeInterval = 5
        while !Task.isCancelled && phase != .superseded {
            do {
                try await env.lane.publishAvailable()
            } catch {
                lastError = bounded(error)
                await saveStatus()
            }
            if env.now() >= uploadRetryAfter {
                do {
                    if try await env.lane.drainPending() { try await stopAfterServerEnd() }
                    uploadBackoff = 5
                    uploadRetryAfter = .distantPast
                } catch {
                    lastError = bounded(error)
                    uploadRetryAfter = env.now().addingTimeInterval(uploadBackoff)
                    uploadBackoff = min(uploadBackoff * 2, 60)
                    await saveStatus(preferred: .offline)
                }
            }
            if needsActiveReconciliation {
                do {
                    try await adopt(try await env.client.activeSession(tabID: tabID))
                } catch {
                    lastError = bounded(error)
                    await saveStatus(preferred: .offline)
                }
            }

            do {
                let install = await installFields()
                let levels = await env.lane.latestLevels()
                let response = try await env.client.pollCommands(
                    tabID: tabID, previousPollAt: previousPollAt,
                    recordingSessionID: sessionIsOpen ? sessionID : nil, paused: phase == .paused,
                    primaryLevels: phase == .recording ? levels.rms.flatMap { BenchLevelPair(peak: $0, average: $0) } : nil,
                    install: install)
                if authRefusedLoggedAt != nil {
                    authRefusedLoggedAt = nil
                    log("room session accepted again")
                }
                previousPollAt = response.now ?? previousPollAt
                if let polled = response.roomID, !polled.isEmpty { roomID = polled }
                if response.superseded {
                    log("the server says this install is superseded; stopping without ending the session, and idling")
                    await stopAfterSuperseded()
                    break
                }
                lastError = nil
                for command in response.commands { await handle(command) }
                await saveStatus()
                backoff = Self.backoffStartNS
                if restartRequested { break }
                try await env.sleeper.sleep(nanoseconds: Self.pollIntervalNS)
            } catch is CancellationError {
                cancelled = true
                break
            } catch let error as BenchError where error.isRetired {
                // §4.5 rule 3. Not the backoff: a retired install retrying is how a superseded copy keeps taking the
                // room back from the install that replaced it.
                log("RETIRED: install \(installID) refused (409 RETIRED). A newer enrolment owns \(config.roomSlug). Stopping; this install will not poll again. Re-enrol with a fresh install command if this machine should serve the room.")
                lastError = "retired: this install was superseded by a newer enrolment"
                do {
                    try env.store.saveRetired(RetiredMarker(installID: installID, at: env.now()))
                } catch {
                    log("retired.json could not be written (\(bounded(error, limit: 120))); the next start will poll once and be refused again")
                }
                try? await stopWithoutEnding()
                phase = .superseded
                await saveStatus()
                return .retired
            } catch {
                if let benchError = error as? BenchError, benchError.isAuthRefused { logAuthRefused(benchError) }
                lastError = bounded(error)
                await saveStatus(preferred: .offline)
                do { try await env.sleeper.sleep(nanoseconds: backoff) } catch {
                    cancelled = true
                    break
                }
                backoff = min(backoff * 2, Self.backoffCapNS)
            }
        }

        if restartRequested {
            do {
                try await stopWithoutEnding()
            } catch {
                log("restart: pieces did not close cleanly (\(bounded(error, limit: 120))); restarting anyway")
            }
            log("restarting for the desk: exit \(Self.restartExitCode)")
            return .restart
        }
        if cancelled || Task.isCancelled {
            try? await stopWithoutEnding()
            return .cancelled
        }
        return .superseded
    }

    /// No refresh path exists (spec §3 ruling). Loud, then quiet for ten minutes, then loud again. The capture is a
    /// separate process and never hears of this.
    func logAuthRefused(_ error: BenchError) {
        let now = env.now()
        if let last = authRefusedLoggedAt, now.timeIntervalSince(last) < Self.authRefusedRepeatSeconds { return }
        authRefusedLoggedAt = now
        log("ROOM SESSION REFUSED (\(error)): the token no longer works and there is no refresh. Capture continues to tape; pieces stay in the spool. Re-enrol this room to recover.")
    }

    // MARK: - reconciliation

    func adopt(_ active: ActiveSessionResponse) async throws {
        needsActiveReconciliation = !active.ok
        guard active.ok, active.resumable, let session = active.session,
              session.status == .recording || session.status == .paused else {
            if await env.lane.isCutting() { try await env.lane.stopAndFlush() }
            phase = .ready
            transition(to: nil)
            nextPieceIndex = 0
            await saveStatus()
            return
        }
        guard !active.handoverPending || active.tabGone else {
            phase = .failed
            needsActiveReconciliation = true
            throw RoomEngineError.handoverPending
        }
        transition(to: session.id)
        if let r = session.roomID, !r.isEmpty { roomID = r }
        nextPieceIndex = active.nextIndex?.primary ?? 0
        if session.status == .paused {
            if await env.lane.isCutting() { try await env.lane.stopAndFlush() }
            phase = .paused
        } else {
            if !(await env.lane.isCutting()) {
                try await env.lane.start(sessionID: session.id, nextIndex: nextPieceIndex, trigger: .reconciliation)
            }
            phase = .recording
        }
        await saveStatus()
    }

    func transition(to next: String?) {
        sessionID = next
    }

    // MARK: - the dispatcher

    /// RoomEngine.swift:1624-1706. IDEMPOTENCY LIVES HERE: a command id already in `completedCommands` is re-acked with
    /// its remembered result and NOTHING is executed again.
    func handle(_ command: BenchCommand) async {
        if let remembered = completedCommands[command.id] {
            if Self.isOperatorVerb(command.kind) {
                await finishOperatorVerb(command, result: remembered)
            } else {
                await acknowledge(command, result: remembered)
            }
            return
        }
        switch command.kind {
        case .startDay, .pauseDay, .resumeDay, .endDay:
            break
        case .setAudioInput:
            // Bypasses the decider (RoomEngine.swift:3040-3070).
            let result = await applyAudioInput(command)
            completedCommands[command.id] = result
            await acknowledge(command, result: result)
            return
        case .checkUpdateNow, .reportDiag, .restartEngine:
            await handleOperatorVerb(command)
            return
        case .unknown(let raw):
            log("command \(command.id) has a kind this build does not know (\(raw.prefix(64))); refused")
            let result = CommandResult(ok: false, sessionID: nil, error: "unsupported_kind")
            completedCommands[command.id] = result
            await acknowledge(command, result: result)
            return
        }

        var overridePause = false
        if case .object(let arguments) = command.args, case .bool(true)? = arguments["override_pause"] { overridePause = true }
        let decision = RoomCommandDecider.decide(kind: command.kind, phase: phase, overridePause: overridePause)
        let result: CommandResult
        do {
            switch decision {
            case .acknowledgeCurrentState:
                result = CommandResult(ok: true, sessionID: sessionID, error: nil)
            case .start:
                try await beginOrResume()
                result = CommandResult(ok: true, sessionID: sessionID, error: nil)
            case .resume:
                try await resume()
                result = CommandResult(ok: true, sessionID: sessionID, error: nil)
            case .pause:
                let id = sessionID
                try await pause()
                result = CommandResult(ok: true, sessionID: id, error: nil)
            case .end:
                let id = sessionID
                try await end()
                result = CommandResult(ok: true, sessionID: id, error: nil)
            case .refuse(let reason):
                result = CommandResult(ok: false, sessionID: nil, error: reason)
            }
        } catch {
            lastError = bounded(error)
            let cutting = await env.lane.isCutting()
            if !cutting || (phase != .paused && phase != .recording) { phase = .failed }
            await saveStatus()
            result = CommandResult(ok: false, sessionID: sessionID, error: bounded(error, limit: 160))
        }
        completedCommands[command.id] = result
        await acknowledge(command, result: result)
    }

    /// Three attempts, 1 s then 2 s apart. `command_not_pending` ends it: an earlier attempt landed or the row expired.
    func acknowledge(_ command: BenchCommand, result: CommandResult) async {
        for attempt in 1...3 {
            do {
                let ack = try await env.client.acknowledge(commandID: command.id, ok: result.ok, sessionID: result.sessionID,
                                                           error: result.error, audioInput: result.audioInput, verb: result.verb)
                guard ack.ok, ack.id == command.id, ack.status == (result.ok ? "acked" : "failed") else {
                    throw RoomEngineError.io("invalid command acknowledgement response")
                }
                return
            } catch {
                lastError = bounded(error)
                if let e = error as? BenchError, e.isCommandNotPending { return }
                if attempt < 3 { try? await env.sleeper.sleep(nanoseconds: UInt64(attempt) * 1_000_000_000) }
            }
        }
        await saveStatus(preferred: .offline)
    }

    // MARK: - the four day kinds (plain-capture paths)

    func beginOrResume() async throws {
        _ = try await env.lane.drainPending()
        let pending = await env.lane.pendingCount()
        guard pending == 0 else { throw RoomEngineError.pendingUploads(pending) }
        let active = try await env.client.activeSession(tabID: tabID)
        if active.resumable, let existing = active.session {
            guard !active.handoverPending || active.tabGone else { throw RoomEngineError.handoverPending }
            guard existing.status != .paused else { throw RoomEngineError.roomPaused }
            transition(to: existing.id)
            if let r = existing.roomID, !r.isEmpty { roomID = r }
            nextPieceIndex = active.nextIndex?.primary ?? 0
            try await env.lane.start(sessionID: existing.id, nextIndex: nextPieceIndex, trigger: .reconciliation)
            phase = .recording
            await saveStatus()
            return
        }
        let created = try await env.client.createSession(label: nil, micLabel: config.deviceUID)
        transition(to: created.session.id)
        if let r = created.session.roomID, !r.isEmpty { roomID = r }
        nextPieceIndex = 0
        do {
            try await env.lane.start(sessionID: created.session.id, nextIndex: 0, trigger: .startDay)
        } catch {
            // No durable growth: end the session just opened rather than leave a recording session on a dead mic.
            let startupError = error
            _ = try await env.client.patchSession(id: created.session.id, action: .end)
            await env.lane.endSession()
            transition(to: nil)
            throw startupError
        }
        phase = .recording
        await saveStatus()
    }

    /// D6: pause stops CUTTING and UPLOAD only. The tape keeps advancing; the Mac's interrupt() of the capture
    /// (RoomEngine.swift:3394-3411) has no equivalent here, deliberately.
    func pause() async throws {
        guard let id = sessionID else { throw RoomEngineError.noActiveSession }
        try await env.lane.stopAndFlush()
        do {
            _ = try await env.client.patchSession(id: id, action: .pause)
        } catch {
            phase = .failed
            throw error
        }
        phase = .paused
        await saveStatus()
    }

    func resume() async throws {
        guard let id = sessionID else { throw RoomEngineError.noActiveSession }
        nextPieceIndex = max(nextPieceIndex, await env.lane.nextIndex())
        try await env.lane.start(sessionID: id, nextIndex: nextPieceIndex, trigger: .resumeDay)
        do {
            _ = try await env.client.patchSession(id: id, action: .resume)
        } catch {
            do {
                try await env.lane.stopAndFlush()
            } catch {
                phase = .failed
                throw error
            }
            phase = .paused
            throw error
        }
        phase = .recording
        await saveStatus()
    }

    func end() async throws {
        guard let id = sessionID else { throw RoomEngineError.noActiveSession }
        phase = .ending
        try await env.lane.stopAndFlush()
        await saveStatus()
        var finalError: Error?
        for attempt in 1...3 {
            do {
                if try await env.lane.drainPending() { throw RoomEngineError.sessionEndedByServer }
                finalError = nil
                break
            } catch {
                finalError = error
                lastError = bounded(error)
                await saveStatus(preferred: .offline)
                if attempt < 3 { try await env.sleeper.sleep(nanoseconds: UInt64(attempt) * 1_000_000_000) }
            }
        }
        if let finalError { throw finalError }
        let remaining = await env.lane.pendingCount()
        guard remaining == 0 else { throw RoomEngineError.pendingUploads(remaining) }
        _ = try await env.client.patchSession(id: id, action: .end)
        await env.lane.endSession()
        transition(to: nil)
        nextPieceIndex = 0
        phase = .ready
        await saveStatus()
    }

    func stopAfterServerEnd() async throws {
        try await env.lane.stopAndFlush()
        _ = try await env.lane.drainPending()
        await env.lane.endSession()
        transition(to: nil)
        nextPieceIndex = 0
        phase = .ready
        needsActiveReconciliation = true
        lastError = RoomEngineError.sessionEndedByServer.description
        await saveStatus()
    }

    /// Close the pieces and upload them WITHOUT ending the session, so a relaunched or replacing process reconciles and
    /// carries on (RoomEngine.swift `stopWithoutEnding`).
    func stopWithoutEnding() async throws {
        do {
            try await env.lane.stopAndFlush()
            _ = try await env.lane.drainPending()
        } catch {
            lastError = bounded(error)
            phase = .failed
            needsActiveReconciliation = true
            await saveStatus()
            throw error
        }
        phase = .superseded
        await saveStatus()
    }

    func stopAfterSuperseded() async {
        var retry: UInt64 = 1_000_000_000
        while true {
            do {
                try await stopWithoutEnding()
                return
            } catch {
                if Task.isCancelled { return }
                try? await env.sleeper.sleep(nanoseconds: retry)
                retry = min(retry * 2, Self.backoffCapNS)
            }
        }
    }

    // MARK: - operator verbs

    static func isOperatorVerb(_ kind: BenchCommandKind) -> Bool {
        switch kind {
        case .checkUpdateNow, .reportDiag, .restartEngine: return true
        default: return false
        }
    }

    func handleOperatorVerb(_ command: BenchCommand) async {
        let result: CommandResult
        switch command.kind {
        case .checkUpdateNow:
            // D3: self-update is not ported. Accepted and refused by name so the Bench does not error.
            result = CommandResult(ok: false, sessionID: sessionID, error: "unsupported_kind")
        case .reportDiag:
            result = reportDiag(command)
        case .restartEngine:
            result = restartEngine(command)
        default:
            return
        }
        completedCommands[command.id] = result
        await finishOperatorVerb(command, result: result)
    }

    /// THE EARLY-ACK HOOK. For a verb whose effect ends this process, the ack goes out FIRST and the effect is armed
    /// only once the ack has LANDED (RoomEngine.swift:2789-2836): a restart whose ack failed would be handed the same
    /// command again after relaunch and restart the room in a loop.
    func finishOperatorVerb(_ command: BenchCommand, result: CommandResult) async {
        let landed = await acknowledgeVerb(command, result: result)
        guard landed, result.ok, let effect = Self.effectAfterAck(command.kind) else { return }
        switch effect {
        case .exitForRelaunch: restartRequested = true
        }
    }

    /// An effect that must FOLLOW its ack because it ends this process.
    enum PostAckEffect: Equatable, Sendable {
        case exitForRelaunch
    }

    /// Which kinds ack before their effect. `check_update_now` is the other one on the Mac (RoomEngine.swift:2818-2836),
    /// but D3 makes it a refusal with no effect at all, so only `restart_engine` has one here.
    static func effectAfterAck(_ kind: BenchCommandKind) -> PostAckEffect? {
        switch kind {
        case .restartEngine: return .exitForRelaunch
        default: return nil
        }
    }

    /// Three plain attempts; the caller learns whether it landed. `command_not_pending` counts as landed.
    func acknowledgeVerb(_ command: BenchCommand, result: CommandResult) async -> Bool {
        for _ in 1...3 {
            do {
                let ack = try await env.client.acknowledge(commandID: command.id, ok: result.ok, sessionID: result.sessionID,
                                                           error: result.error, audioInput: nil, verb: result.verb)
                guard ack.ok, ack.id == command.id, ack.status == (result.ok ? "acked" : "failed") else {
                    throw RoomEngineError.io("invalid command acknowledgement response")
                }
                return true
            } catch {
                lastError = bounded(error)
                if let e = error as? BenchError, e.isCommandNotPending { return true }
            }
        }
        return false
    }

    func restartEngine(_ command: BenchCommand) -> CommandResult {
        var force = false
        switch command.args {
        case .null: break
        case .object(let object):
            guard object.keys.allSatisfy({ $0 == "force" }) else { return verbFailure("bad_args") }
            switch object["force"] {
            case .none, .some(.null): break
            case .some(.bool(let value)): force = value
            case .some: return verbFailure("bad_args")
            }
        default: return verbFailure("bad_args")
        }
        if sessionIsOpen && !force { return verbFailure("session_open") }
        log("restart requested by the desk\(force && sessionIsOpen ? " over an open session" : "")")
        return CommandResult(ok: true, sessionID: sessionID, error: nil, verb: OperatorVerbAcknowledgement(restarting: true))
    }

    func verbFailure(_ error: String) -> CommandResult {
        CommandResult(ok: false, sessionID: sessionID, error: error)
    }

    /// What this machine is, runs and has logged. Never the session: RoomConfig has no token field, and a log line
    /// naming any forbidden word is replaced whole.
    func reportDiag(_ command: BenchCommand) -> CommandResult {
        var lines = Self.reportDiagDefaultLines
        switch command.args {
        case .null: break
        case .object(let object):
            guard object.keys.allSatisfy({ $0 == "log_lines" }) else { return verbFailure("bad_args") }
            switch object["log_lines"] {
            case .none, .some(.null): break
            case .some(.number(let value)):
                guard value.isFinite, value == value.rounded(), value >= 0, value <= Double(Self.reportDiagMaxLines) else {
                    return verbFailure("bad_args")
                }
                lines = Int(value)
            case .some: return verbFailure("bad_args")
            }
        default: return verbFailure("bad_args")
        }
        var report: [String: BenchJSON] = [:]
        report["generated_at"] = .string(ISO8601.string(env.now()))
        report["app_version"] = .string(Pinned.appVersion)
        report["build_sha"] = .null
        report["config"] = Self.jsonValue(of: config) ?? .null
        report["ffmpeg_version"] = env.ffmpegVersion().map(BenchJSON.string) ?? .null
        report["input_devices"] = .array(env.devices.usbCaptureDevices().map {
            .object(["name": .string($0.name), "uid": .string($0.uid.description), "is_default": .bool($0.uid.description == config.deviceUID)])
        })
        report["disk_free_bytes"] = freeBytes(onFilesystemHolding: config.tapeDir).map { .number(Double($0)) } ?? .null
        report["log_lines"] = .array(env.log.tail(lines).map { .string(Self.redactedLogLine($0)) })
        report["update_ledger"] = .null
        report["update_channel"] = .string(config.updateChannel)
        report["channel_locked"] = .bool(config.channelLocked)
        report["session_open"] = .bool(sessionIsOpen)
        report["phase"] = .string(phase.rawValue)
        return CommandResult(ok: true, sessionID: sessionID, error: nil, verb: OperatorVerbAcknowledgement(diag: .object(report)))
    }

    static func redactedLogLine(_ line: String) -> String {
        let lower = line.lowercased()
        if reportDiagForbidden.contains(where: { lower.contains($0.lowercased()) }) { return "[redacted]" }
        return String(line.prefix(reportDiagLineMax))
    }

    static func jsonValue<T: Encodable>(of value: T) -> BenchJSON? {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(value) else { return nil }
        return try? JSONDecoder().decode(BenchJSON.self, from: data)
    }

    // MARK: - set_audio_input (R4-D3, D4; spec S5)

    /// Validate everything, then move the device, then set the volume. `device_not_present` and `volume_not_settable`
    /// leave config.json exactly as it was.
    func applyAudioInput(_ command: BenchCommand) async -> CommandResult {
        guard let request = AudioInputRequest.parse(command.args) else { return audioFailure("bad_args") }
        let present = env.devices.usbCaptureDevices()
        var requestedUID: USBDeviceUID?
        if let raw = request.deviceUID {
            guard let found = DeviceResolution.resolve(raw, in: present) else { return audioFailure("device_not_present") }
            requestedUID = found.uid
        }
        guard let targetUID = requestedUID ?? USBDeviceUID(config.deviceUID) else { return audioFailure("device_not_present") }
        if request.inputVolume != nil {
            guard DeviceResolution.resolve(targetUID.description, in: present) != nil,
                  let reading = env.volume.inputVolume(uid: targetUID) else { return audioFailure("device_not_present") }
            guard reading.settable else {
                return audioFailure("volume_not_settable", AudioInputAcknowledgement(inputVolumeSettable: false))
            }
        }

        var applied = AudioInputAcknowledgement()
        if let uid = requestedUID {
            if let failure = await switchRecordingDevice(to: uid) { return failure }
            applied.appliedDeviceUID = uid.description
        }
        if let volume = request.inputVolume {
            do {
                try env.volume.setInputVolume(uid: targetUID, value: volume)
            } catch {
                return audioFailure("volume_set_failed: \(bounded(error, limit: 120))", applied)
            }
            let reread = env.volume.inputVolume(uid: targetUID)
            applied.appliedInputVolume = reread?.value.map { ($0 * 10_000).rounded() / 10_000 }
            applied.inputVolumeSettable = reread?.settable
            log("input volume on \(targetUID) set by the desk")
        } else {
            applied.inputVolumeSettable = USBDeviceUID(config.deviceUID).flatMap { env.volume.inputVolume(uid: $0) }?.settable
        }
        return CommandResult(ok: true, sessionID: sessionID, error: nil, audioInput: applied)
    }

    /// Disk first, then the capture; a switch that cannot complete puts config.json back.
    func switchRecordingDevice(to uid: USBDeviceUID) async -> CommandResult? {
        let previous = config.deviceUID
        guard uid.description != previous else { return nil }
        do {
            try saveDeviceUID(uid.description)
        } catch {
            return audioFailure("config_write_failed: \(bounded(error, limit: 120))")
        }
        do {
            try await env.captureSwitch.switchCapture(to: uid)
        } catch {
            log("device switch to \(uid) failed (\(bounded(error, limit: 120))); back to \(previous)")
            do {
                try saveDeviceUID(previous)
            } catch {
                log("recording device NOT restored to \(previous) in config.json: \(bounded(error, limit: 120))")
                config.deviceUID = previous
            }
            return audioFailure("device_switch_failed: \(bounded(error, limit: 120))")
        }
        log("recording device set to \(uid) by the desk (was \(previous))")
        return nil
    }

    /// Re-read config.json and change ONE key, so a hand edit made while running is kept.
    func saveDeviceUID(_ uid: String) throws {
        var onDisk = try env.store.loadConfig() ?? config
        onDisk.deviceUID = uid
        try env.store.saveConfig(onDisk)
        config.deviceUID = uid
    }

    func audioFailure(_ reason: String, _ audioInput: AudioInputAcknowledgement? = nil) -> CommandResult {
        CommandResult(ok: false, sessionID: nil, error: reason, audioInput: audioInput)
    }

    // MARK: - telemetry and status

    func installFields() async -> InstallPollFields {
        let durable = await env.lane.durableSamples()
        let advancing: Bool = {
            guard let durable, let previous = lastDurableSamples else { return false }
            return durable > previous
        }()
        lastDurableSamples = durable
        var fields = InstallPollFields(installID: installID, tapeAdvancing: advancing)
        let facts = env.machineFacts()
        fields.appVersion = Pinned.appVersion
        fields.hostname = facts.hostname
        fields.hardwareModel = facts.hardwareModel
        fields.osVersion = facts.osVersion
        fields.neverSleep = facts.neverSleep
        fields.launchedBy = facts.launchedBy
        let devices = env.devices.usbCaptureDevices()
        fields.inputDevices = devices.map { .init(name: $0.name, uid: $0.uid.description, isDefault: $0.uid.description == config.deviceUID) }
        if let configured = DeviceResolution.resolve(config.deviceUID, in: devices) {
            fields.inputDeviceName = configured.name
            let reading = env.volume.inputVolume(uid: configured.uid)
            fields.inputVolume = reading?.value
            fields.inputVolumeSettable = reading?.settable
        }
        fields.sessionOpen = sessionIsOpen
        fields.updateChannel = config.updateChannel
        fields.channelLocked = config.channelLocked
        fields.diskFreeBytes = freeBytes(onFilesystemHolding: config.tapeDir)
        let levels = await env.lane.latestLevels()
        fields.peak = levels.peak
        fields.zeroRatio = levels.zeroRatio
        return fields
    }

    func saveStatus(preferred: RoomStatus.State? = nil) async {
        let pending = await env.lane.pendingCount()
        let state: RoomStatus.State
        switch phase {
        case .recording, .ending: state = .recording
        case .paused: state = .paused
        case .failed: state = .failed
        case .ready, .superseded: state = pending > 0 ? .uploadPending : (preferred ?? .ready)
        }
        do {
            try env.store.saveStatus(RoomStatus(state: state, sessionID: sessionID, pendingPieceCount: pending,
                                                lastError: lastError, updatedAt: env.now()))
        } catch {
            log("status.json not written: \(bounded(error, limit: 120))")
        }
    }

    // Test access.
    func completedResult(_ id: String) -> CommandResult? { completedCommands[id] }
    func setPhaseForTesting(_ phase: RoomEnginePhase, sessionID: String?) {
        self.phase = phase
        self.sessionID = sessionID
    }
    var isRestartRequested: Bool { restartRequested }
    var currentDeviceUID: String { config.deviceUID }
}
