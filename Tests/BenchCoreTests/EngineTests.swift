import Foundation
import RecorderCore
import XCTest
@testable import BenchCore

/// A clock the tests move by hand; `sleep` advances it.
final class FakeClock: @unchecked Sendable {
    private let lock = NSLock()
    private var t: TimeInterval = 1_789_400_000
    var now: Date { lock.withLock { Date(timeIntervalSince1970: t) } }
    func advance(_ seconds: TimeInterval) { lock.withLock { t += seconds } }
}

actor FakeLane: PieceLane {
    var calls: [String] = []
    var cutting = false
    /// Pending pieces as (session, seconds each upload takes on the fake clock).
    var pending: [(session: String, uploadSeconds: TimeInterval)] = []
    var startError: Error?
    var drainError: Error?
    var endedByServer = false
    var index = 0
    var samples: Int64 = 1000
    let clock: FakeClock

    init(clock: FakeClock = FakeClock()) { self.clock = clock }

    func setStartError(_ e: Error?) { startError = e }
    func setPending(_ p: [(session: String, uploadSeconds: TimeInterval)]) { pending = p }
    func setDrainError(_ e: Error?) { drainError = e }

    func start(sessionID: String, nextIndex: Int, trigger: LaneStartTrigger, fromSamples: Int64?) async throws {
        calls.append("start \(sessionID) \(nextIndex) \(trigger)\(fromSamples.map { " from \($0)" } ?? "")")
        if let startError { throw startError }
        cutting = true
        index = nextIndex
    }
    func stopAndFlush() async throws {
        calls.append("stopAndFlush")
        cutting = false
    }
    func publishAvailable() async throws {}
    func drainPending(maxPieces: Int?, deadline: Date?) async throws -> Bool {
        calls.append("drain")
        if let drainError { throw drainError }
        var done = 0
        while !pending.isEmpty {
            if let maxPieces, done >= maxPieces { break }
            if let deadline, clock.now >= deadline { break }
            clock.advance(pending[0].uploadSeconds)
            pending.removeFirst()
            done += 1
        }
        return endedByServer
    }
    func pendingCount(sessionID: String?) async -> Int { pending.filter { sessionID == nil || $0.session == sessionID }.count }
    func isCutting() async -> Bool { cutting }
    func nextIndex() async -> Int { index }
    func durableSamples() async -> Int64? {
        samples += 16_000
        return samples
    }
    func latestLevels() async -> (rms: Double?, peak: Double?, zeroRatio: Double?) { (0.1, 0.3, 0.0) }
    func endSession() async { calls.append("endSession") }
}

final class RecordingSleeper: Sleeper, @unchecked Sendable {
    private let lock = NSLock()
    private var _sleeps: [UInt64] = []
    let cancelAfter: Int
    init(cancelAfter: Int = 1_000) { self.cancelAfter = cancelAfter }
    var sleeps: [UInt64] { lock.withLock { _sleeps } }
    func sleep(nanoseconds: UInt64) async throws {
        let n = lock.withLock { _sleeps.append(nanoseconds); return _sleeps.count }
        if n >= cancelAfter { throw CancellationError() }
    }
}

struct FakeDevices: CaptureDeviceEnumerating {
    var devices: [EnumeratedCaptureDevice]
    func usbCaptureDevices() -> [EnumeratedCaptureDevice] { devices }
}

final class FakeVolume: InputVolumeControlling, @unchecked Sendable {
    private let lock = NSLock()
    var values: [USBDeviceUID: InputVolumeReading] = [:]
    var sets: [(USBDeviceUID, Double)] = []
    func inputVolume(uid: USBDeviceUID) -> InputVolumeReading? { lock.withLock { values[uid] } }
    func setInputVolume(uid: USBDeviceUID, value: Double) throws {
        try lock.withLock {
            guard let current = values[uid], current.settable else { throw RoomEngineError.io("not settable") }
            values[uid] = InputVolumeReading(value: (value * 62).rounded() / 62, settable: true)
            sets.append((uid, value))
        }
    }
}

/// Plays the capture's part: answers a re-pin request, and on a refusal or a revert puts config.json back as it would.
struct RecordingSwitch: CaptureDeviceSwitching {
    enum Answer { case switched, absent, revertedBusy, silent }
    let answer: Answer
    var store: RoomStore? = nil
    var previous = "usb:0d8c:0134"
    init(succeed: Bool) { answer = succeed ? .switched : .silent }
    init(answer: Answer, store: RoomStore) {
        self.answer = answer
        self.store = store
    }
    func switchCapture(to uid: USBDeviceUID, requestedAtWallNS: Int64) async throws {
        switch answer {
        case .switched: return
        case .absent:
            if var c = try store?.loadConfig() { c.deviceUID = previous; try store?.saveConfig(c) }
            throw CaptureSwitchError.notPresent
        case .revertedBusy:
            if var c = try store?.loadConfig() { c.deviceUID = previous; try store?.saveConfig(c) }
            throw CaptureSwitchError.reverted(reason: "busy")
        case .silent:
            throw CaptureSwitchError.noConfirmation(seconds: 15)
        }
    }
}

let spare = EnumeratedCaptureDevice(uid: USBDeviceUID("usb:1234:5678")!, name: "Spare", alsaName: "hw:CARD=Spare,DEV=0", card: 2)

final class EngineTests: XCTestCase {
    struct Rig {
        let engine: RoomEngine
        let transport: FakeTransport
        let lane: FakeLane
        let sleeper: RecordingSleeper
        let store: RoomStore
        let volume: FakeVolume
        let log: RoomLog
        let lines: LockedLines
    }

    func rig(devices: [EnumeratedCaptureDevice] = [tm20, spare], switchSucceeds: Bool = false, switchAnswer: RecordingSwitch.Answer? = nil,
             clock: FakeClock? = nil, cancelAfter: Int = 1_000) throws -> Rig {
        let root = temporaryRoot()
        let store = RoomStore(root: root)
        let config = RoomConfig(origin: URL(string: "https://www.evenscribe.app")!, roomSlug: "opd-5", deviceUID: "usb:0d8c:0134",
                                tapeDir: root.path, installID: "inst_1", tabID: "app_inst_1")
        try store.saveConfig(config)
        let t = FakeTransport()
        t.onJSON("GET /api/bench/sessions/active", #"{"ok":true,"resumable":false,"session":null,"handover_pending":false,"tab_gone":false}"#)
        t.onJSON("POST *", #"{"ok":true,"id":"x","status":"acked"}"#)
        let lane = FakeLane(clock: clock ?? FakeClock())
        let sleeper = RecordingSleeper(cancelAfter: cancelAfter)
        let volume = FakeVolume()
        volume.values[tm20.uid] = InputVolumeReading(value: 21.0 / 62, settable: true)
        let lines = LockedLines()
        let log = RoomLog(sink: { lines.add($0) })
        let env = RoomEngineEnvironment(
            client: BenchClient(origin: config.origin, transport: t, sessionToken: { "TOKEN" }), store: store, lane: lane,
            devices: FakeDevices(devices: devices), volume: volume,
            captureSwitch: switchAnswer.map { RecordingSwitch(answer: $0, store: store) } ?? RecordingSwitch(succeed: switchSucceeds),
            machineFacts: { MachineFacts(hostname: "yoga") }, ffmpegVersion: { "ffmpeg version 6.1.1" }, sleeper: sleeper, log: log,
            now: { [clock] in clock?.now ?? Date() })
        return Rig(engine: RoomEngine(config: config, installID: "inst_1", environment: env), transport: t, lane: lane,
                   sleeper: sleeper, store: store, volume: volume, log: log, lines: lines)
    }

    /// Acks answer with the id that was acked and the status the ok implies.
    func echoAcks(_ t: FakeTransport) {
        t.on("POST *") { r in
            let parts = r.url.path.split(separator: "/")
            guard parts.count == 5, parts[3] != "", parts.last == "ack" else { return HTTPResponse(status: 404) }
            let ok = jsonObject(r.body)["ok"] as? Bool ?? false
            return HTTPResponse(status: 200, body: Data(#"{"ok":true,"id":"\#(parts[3])","status":"\#(ok ? "acked" : "failed")"}"#.utf8))
        }
    }

    func acks(_ t: FakeTransport) -> [(String, [String: Any])] {
        t.requests.filter { $0.url.path.hasSuffix("/ack") }.map { (String($0.url.path.split(separator: "/")[3]), jsonObject($0.body)) }
    }

    func testDeciderTable() {
        typealias D = RoomCommandDecider
        XCTAssertEqual(D.decide(kind: .startDay, phase: .ready), .start)
        XCTAssertEqual(D.decide(kind: .startDay, phase: .failed), .start)
        XCTAssertEqual(D.decide(kind: .startDay, phase: .recording), .acknowledgeCurrentState)
        XCTAssertEqual(D.decide(kind: .startDay, phase: .paused), .refuse("room_paused"))
        XCTAssertEqual(D.decide(kind: .startDay, phase: .paused, overridePause: true), .resume)
        XCTAssertEqual(D.decide(kind: .startDay, phase: .ending), .refuse("ending_in_progress"))
        XCTAssertEqual(D.decide(kind: .startDay, phase: .superseded), .refuse("superseded"))
        XCTAssertEqual(D.decide(kind: .pauseDay, phase: .paused), .acknowledgeCurrentState)
        XCTAssertEqual(D.decide(kind: .pauseDay, phase: .recording), .pause)
        XCTAssertEqual(D.decide(kind: .pauseDay, phase: .ready), .refuse("not_recording"))
        XCTAssertEqual(D.decide(kind: .resumeDay, phase: .recording), .acknowledgeCurrentState)
        XCTAssertEqual(D.decide(kind: .resumeDay, phase: .paused), .resume)
        XCTAssertEqual(D.decide(kind: .resumeDay, phase: .failed), .refuse("not_paused"))
        for p in [RoomEnginePhase.recording, .paused, .failed] { XCTAssertEqual(D.decide(kind: .endDay, phase: p), .end) }
        for p in [RoomEnginePhase.ready, .ending, .superseded] { XCTAssertEqual(D.decide(kind: .endDay, phase: p), .refuse("no_active_session")) }
        XCTAssertEqual(D.decide(kind: .setAudioInput, phase: .ready), .refuse("unsupported_kind"))
    }

    func testRedeliveredCommandIsReackedWithoutReExecuting() async throws {
        let r = try rig()
        echoAcks(r.transport)
        r.transport.onJSON("POST /api/bench/sessions", #"{"session":{"id":"s1","room_id":"r1","status":"recording"}}"#)
        let start = BenchCommand(id: "c1", kind: .startDay)
        await r.engine.handle(start)
        await r.engine.handle(start)
        await r.engine.handle(start)
        let creates = r.transport.requests.filter { $0.method == "POST" && $0.url.path == "/api/bench/sessions" }
        XCTAssertEqual(creates.count, 1, "the session is created once")
        let starts = await r.lane.calls.filter { $0.hasPrefix("start") }
        XCTAssertEqual(starts, ["start s1 0 startDay from 17000"])
        XCTAssertEqual(acks(r.transport).map(\.0), ["c1", "c1", "c1"], "every delivery is acked")
        XCTAssertTrue(acks(r.transport).allSatisfy { $0.1["ok"] as? Bool == true && $0.1["session_id"] as? String == "s1" })
        let phase = await r.engine.phase
        XCTAssertEqual(phase, .recording)
    }

    func testDayAckComesAfterTheLocalEffect() async throws {
        let r = try rig()
        echoAcks(r.transport)
        await r.engine.setPhaseForTesting(.recording, sessionID: "s1")
        r.transport.onJSON("PATCH /api/bench/sessions/s1", #"{"ok":true}"#)
        await r.engine.handle(BenchCommand(id: "p1", kind: .pauseDay))
        let order = r.transport.requests.map { "\($0.method) \($0.url.path)" }
        XCTAssertEqual(order, ["PATCH /api/bench/sessions/s1", "POST /api/bench/commands/p1/ack"])
        let laneCalls = await r.lane.calls
        XCTAssertEqual(laneCalls, ["stopAndFlush"], "pause stops cutting; nothing touches the capture (D6)")
        let phase = await r.engine.phase
        XCTAssertEqual(phase, .paused)
    }

    func testRestartAcksBeforeItsEffectAndOnlyArmsWhenTheAckLanded() async throws {
        let r = try rig()
        // Ack fails three times: no restart.
        r.transport.on("POST /api/bench/commands/r1/ack") { _ in HTTPResponse(status: 500) }
        await r.engine.handle(BenchCommand(id: "r1", kind: .restartEngine))
        var armed = await r.engine.isRestartRequested
        XCTAssertFalse(armed, "a restart whose ack did not land must not restart")
        XCTAssertEqual(r.transport.requests.filter { $0.url.path == "/api/bench/commands/r1/ack" }.count, 3)
        // Re-delivered, ack lands: armed, and the remembered result is what is sent.
        echoAcks(r.transport)
        await r.engine.handle(BenchCommand(id: "r1", kind: .restartEngine))
        armed = await r.engine.isRestartRequested
        XCTAssertTrue(armed)
        XCTAssertEqual(acks(r.transport).last?.1["restarting"] as? Bool, true)
    }

    func testRestartRefusedWhileSessionOpenUnlessForced() async throws {
        let r = try rig()
        echoAcks(r.transport)
        await r.engine.setPhaseForTesting(.recording, sessionID: "s1")
        await r.engine.handle(BenchCommand(id: "r1", kind: .restartEngine))
        XCTAssertEqual(acks(r.transport).last?.1["error"] as? String, "session_open")
        var armed = await r.engine.isRestartRequested
        XCTAssertFalse(armed)
        await r.engine.handle(BenchCommand(id: "r2", kind: .restartEngine, args: .object(["force": .bool(true)])))
        armed = await r.engine.isRestartRequested
        XCTAssertTrue(armed)
        await r.engine.handle(BenchCommand(id: "r3", kind: .restartEngine, args: .object(["force": .string("yes")])))
        XCTAssertEqual(acks(r.transport).last?.1["error"] as? String, "bad_args")
    }

    func testUnknownAndCheckUpdateNowAckUnsupportedKind() async throws {
        let r = try rig()
        echoAcks(r.transport)
        await r.engine.handle(BenchCommand(id: "u1", kind: .unknown("teleport")))
        await r.engine.handle(BenchCommand(id: "u2", kind: .checkUpdateNow))
        let sent = acks(r.transport)
        XCTAssertEqual(sent.map(\.0), ["u1", "u2"])
        XCTAssertTrue(sent.allSatisfy { $0.1["ok"] as? Bool == false && $0.1["error"] as? String == "unsupported_kind" })
    }

    func testReportDiagNeverCarriesTheTokenAndRedactsLogLines() async throws {
        let r = try rig()
        echoAcks(r.transport)
        r.log("poll with Cookie: eta_room_session=TOKEN")
        r.log("an ordinary line")
        await r.engine.handle(BenchCommand(id: "d1", kind: .reportDiag, args: .object(["log_lines": .number(10)])))
        let body = try XCTUnwrap(r.transport.requests.last?.body)
        let text = String(decoding: body, as: UTF8.self)
        XCTAssertFalse(text.contains("TOKEN"))
        let diag = try XCTUnwrap(jsonObject(body)["diag"] as? [String: Any])
        let lines = try XCTUnwrap(diag["log_lines"] as? [String])
        XCTAssertTrue(lines.contains("[redacted]"))
        XCTAssertTrue(lines.contains { $0.hasSuffix("an ordinary line") })
        XCTAssertEqual((diag["config"] as? [String: Any])?["device_uid"] as? String, "usb:0d8c:0134")
        await r.engine.handle(BenchCommand(id: "d2", kind: .reportDiag, args: .object(["log_lines": .number(501)])))
        XCTAssertEqual(acks(r.transport).last?.1["error"] as? String, "bad_args")
    }

    func testSetAudioInputAbsentDeviceRefusesBeforeAnyMutation() async throws {
        let r = try rig()
        echoAcks(r.transport)
        let before = try Data(contentsOf: r.store.configURL)
        await r.engine.handle(BenchCommand(id: "a1", kind: .setAudioInput, args: .object(["device_uid": .string("usb:dead:beef"), "input_volume": .number(0.5)])))
        XCTAssertEqual(acks(r.transport).last?.1["error"] as? String, "device_not_present")
        XCTAssertEqual(try Data(contentsOf: r.store.configURL), before)
        XCTAssertTrue(r.volume.sets.isEmpty, "the volume is not touched when the device half is refused")
        // A CoreAudio-style uid is not a Linux identity: absent, not bad_args.
        await r.engine.handle(BenchCommand(id: "a2", kind: .setAudioInput, args: .object(["device_uid": .string("BuiltInMicrophoneDevice")])))
        XCTAssertEqual(acks(r.transport).last?.1["error"] as? String, "device_not_present")
        await r.engine.handle(BenchCommand(id: "a3", kind: .setAudioInput, args: .object([:])))
        XCTAssertEqual(acks(r.transport).last?.1["error"] as? String, "bad_args")
    }

    func testSetAudioInputVolumeAndUnsettable() async throws {
        let r = try rig()
        echoAcks(r.transport)
        await r.engine.handle(BenchCommand(id: "v1", kind: .setAudioInput, args: .object(["input_volume": .number(1.7)])))
        let ok = try XCTUnwrap(acks(r.transport).last?.1)
        XCTAssertEqual(ok["ok"] as? Bool, true)
        XCTAssertEqual(ok["applied_input_volume"] as? Double, 1.0, "clamped, then re-read")
        XCTAssertEqual(ok["input_volume_settable"] as? Bool, true)
        XCTAssertNil(ok["applied_device_uid"])
        r.volume.values[tm20.uid] = InputVolumeReading(value: nil, settable: false)
        await r.engine.handle(BenchCommand(id: "v2", kind: .setAudioInput, args: .object(["input_volume": .number(0.2)])))
        let refused = try XCTUnwrap(acks(r.transport).last?.1)
        XCTAssertEqual(refused["error"] as? String, "volume_not_settable")
        XCTAssertEqual(refused["input_volume_settable"] as? Bool, false)
    }

    func testDeviceSwitchThatCannotCompleteIsRolledBack() async throws {
        let r = try rig(switchSucceeds: false)
        echoAcks(r.transport)
        await r.engine.handle(BenchCommand(id: "s1", kind: .setAudioInput, args: .object(["device_uid": .string("usb:1234:5678")])))
        XCTAssertEqual(acks(r.transport).last?.1["error"] as? String, "device_switch_failed: capture_did_not_confirm within 15 s")
        XCTAssertEqual(try r.store.loadConfig()?.deviceUID, "usb:0d8c:0134")
        let uid = await r.engine.currentDeviceUID
        XCTAssertEqual(uid, "usb:0d8c:0134")
        // The same device is a no-op success, not a switch.
        await r.engine.handle(BenchCommand(id: "s2", kind: .setAudioInput, args: .object(["device_uid": .string("usb:0D8C:0134")])))
        XCTAssertEqual(acks(r.transport).last?.1["applied_device_uid"] as? String, "usb:0d8c:0134")
    }

    func testDeviceSwitchWhenWiredPersists() async throws {
        let r = try rig(switchSucceeds: true)
        echoAcks(r.transport)
        await r.engine.handle(BenchCommand(id: "s1", kind: .setAudioInput, args: .object(["device_uid": .string("usb:1234:5678")])))
        XCTAssertEqual(acks(r.transport).last?.1["applied_device_uid"] as? String, "usb:1234:5678")
        XCTAssertEqual(try r.store.loadConfig()?.deviceUID, "usb:1234:5678")
    }

    func testRetiredStopsForeverAndIsWrittenDown() async throws {
        let r = try rig()
        r.transport.onJSON("GET /api/bench/commands", status: 409, #"{"error":{"code":"RETIRED"}}"#)
        let exit = await r.engine.run()
        XCTAssertEqual(exit, .retired)
        XCTAssertEqual(try r.store.loadRetired()?.installID, "inst_1")
        let polls = r.transport.requests.filter { $0.url.path == "/api/bench/commands" }.count
        XCTAssertEqual(polls, 1, "no retry of a retired install")
        // A later start with the same install id does not poll at all.
        let again = try rig()
        try again.store.saveRetired(RetiredMarker(installID: "inst_1", at: Date()))
        let exit2 = await again.engine.run()
        XCTAssertEqual(exit2, .retired)
        XCTAssertTrue(again.transport.requests.isEmpty)
    }

    func testBackoffFiveDoublingToThirtyThenPollIntervalAfterRecovery() async throws {
        let r = try rig(cancelAfter: 7)
        var failures = 5
        r.transport.on("GET /api/bench/commands") { _ in
            failures -= 1
            return failures >= 0 ? HTTPResponse(status: 503) : HTTPResponse(status: 200, body: Data(#"{"ok":true,"commands":[]}"#.utf8))
        }
        _ = await r.engine.run()
        XCTAssertEqual(r.sleeper.sleeps, [5, 10, 20, 30, 30, 1.5, 1.5].map { UInt64($0 * 1_000_000_000) })
    }

    func testTokenRefusedIsLoggedOnceAndPollingContinues() async throws {
        let root = temporaryRoot()
        let store = RoomStore(root: root)
        let lines = LockedLines()
        let config = RoomConfig(origin: URL(string: "https://www.evenscribe.app")!, roomSlug: "opd-5", deviceUID: "usb:0d8c:0134",
                                tapeDir: root.path, installID: "inst_1", tabID: "app_inst_1")
        let t = FakeTransport()
        t.onJSON("GET /api/bench/sessions/active", status: 401, "{}")
        t.onJSON("GET /api/bench/commands", status: 401, "{}")
        let sleeper = RecordingSleeper(cancelAfter: 4)
        let lane = FakeLane()
        let env = RoomEngineEnvironment(client: BenchClient(origin: config.origin, transport: t, sessionToken: { "T" }), store: store,
                                        lane: lane, devices: FakeDevices(devices: [tm20]), volume: FakeVolume(),
                                        captureSwitch: RecordingSwitch(succeed: false), machineFacts: { MachineFacts() }, ffmpegVersion: { nil },
                                        sleeper: sleeper, log: RoomLog(sink: { lines.add($0) }))
        let exit = await RoomEngine(config: config, installID: "inst_1", environment: env).run()
        XCTAssertEqual(exit, .cancelled)
        XCTAssertEqual(lines.all.filter { $0.contains("ROOM SESSION REFUSED") }.count, 1)
        XCTAssertEqual(t.requests.filter { $0.url.path == "/api/bench/commands" }.count, 4, "it keeps trying")
        XCTAssertTrue(try XCTUnwrap(store.loadStatus()?.lastError).contains("HTTP 401"))
    }

    func testSupersededStopsWithoutEnding() async throws {
        let r = try rig()
        r.transport.onJSON("GET /api/bench/commands", #"{"ok":true,"superseded":true,"commands":[]}"#)
        let exit = await r.engine.run()
        XCTAssertEqual(exit, .superseded)
        XCTAssertFalse(r.transport.requests.contains { $0.method == "PATCH" }, "superseded never ends the session")
        let calls = await r.lane.calls
        XCTAssertTrue(calls.contains("stopAndFlush"))
    }

    func testStartDayOnADeadTapeEndsTheSessionItOpened() async throws {
        let r = try rig()
        echoAcks(r.transport)
        r.transport.onJSON("POST /api/bench/sessions", #"{"session":{"id":"s9","status":"recording"}}"#)
        r.transport.onJSON("PATCH /api/bench/sessions/s9", #"{"ok":true}"#)
        await r.lane.setStartError(RoomEngineError.io("no durable growth"))
        await r.engine.handle(BenchCommand(id: "c1", kind: .startDay))
        XCTAssertEqual(jsonObject(r.transport.requests.first { $0.method == "PATCH" }?.body) as NSDictionary, ["action": "end"] as NSDictionary)
        XCTAssertEqual(acks(r.transport).last?.1["ok"] as? Bool, false)
        let phase = await r.engine.phase
        XCTAssertEqual(phase, .failed)
    }

    func testPollCarriesRecordingSessionAndInstallFields() async throws {
        let r = try rig(cancelAfter: 2)
        r.transport.onJSON("GET /api/bench/sessions/active", #"{"ok":true,"resumable":true,"session":{"id":"s1","room_id":"r1","status":"recording"},"next_idx":{"primary":7,"backup":0},"handover_pending":false,"tab_gone":false}"#)
        r.transport.onJSON("GET /api/bench/commands", #"{"ok":true,"commands":[]}"#)
        _ = await r.engine.run()
        let starts = await r.lane.calls.filter { $0.hasPrefix("start") }
        XCTAssertEqual(starts, ["start s1 7 reconciliation"], "a restart mid-session reconciles and cuts on from the server's next index")
        let polls = r.transport.requests.filter { $0.url.path == "/api/bench/commands" }
        let first = Dictionary(uniqueKeysWithValues: queryItems(polls[0].url).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(first["recording_session_id"], "s1")
        XCTAssertEqual(first["tab_id"], "app_inst_1")
        XCTAssertEqual(first["install_id"], "inst_1")
        XCTAssertEqual(first["tape_advancing"], "false", "one reading is never enough")
        XCTAssertEqual(first["input_device_name"], "USB Audio")
        XCTAssertEqual(first["session_open"], "true")
        XCTAssertNotNil(first["input_devices"])
        let second = Dictionary(uniqueKeysWithValues: queryItems(polls[1].url).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(second["tape_advancing"], "true")
    }
}

extension EngineTests {

    // MARK: fix 1 — the bench side of a re-pin

    func testSwitchToPresentDeviceAcksAfterTheCaptureConfirms() async throws {
        let r = try rig(switchAnswer: .switched)
        echoAcks(r.transport)
        await r.engine.handle(BenchCommand(id: "d1", kind: .setAudioInput, args: .object(["device_uid": .string("usb:1234:5678")])))
        let ack = try XCTUnwrap(acks(r.transport).last?.1)
        XCTAssertEqual(ack["ok"] as? Bool, true)
        XCTAssertEqual(ack["applied_device_uid"] as? String, "usb:1234:5678")
        XCTAssertEqual(try r.store.loadConfig()?.deviceUID, "usb:1234:5678", "room-bench wrote the identity; it restarted nothing")
    }

    func testCaptureRefusingAnAbsentDeviceAcksDeviceNotPresentAndKeepsTheOldOne() async throws {
        let r = try rig(switchAnswer: .absent)
        echoAcks(r.transport)
        await r.engine.handle(BenchCommand(id: "d2", kind: .setAudioInput, args: .object(["device_uid": .string("usb:1234:5678")])))
        XCTAssertEqual(acks(r.transport).last?.1["error"] as? String, "device_not_present")
        XCTAssertEqual(try r.store.loadConfig()?.deviceUID, "usb:0d8c:0134")
        let uid = await r.engine.currentDeviceUID
        XCTAssertEqual(uid, "usb:0d8c:0134")
    }

    func testCaptureRevertingABusyDeviceAcksTheReason() async throws {
        let r = try rig(switchAnswer: .revertedBusy)
        echoAcks(r.transport)
        await r.engine.handle(BenchCommand(id: "d3", kind: .setAudioInput, args: .object(["device_uid": .string("usb:1234:5678")])))
        XCTAssertEqual(acks(r.transport).last?.1["error"] as? String, "device_switch_failed: reverted: busy")
        XCTAssertEqual(try r.store.loadConfig()?.deviceUID, "usb:0d8c:0134")
    }

    func testConfigRepinSwitchReadsOnlyAnAnswerToThisRequest() async throws {
        let root = temporaryRoot()
        let store = RoomStore(root: root)
        let statusPath = root.appendingPathComponent("capture-device.json").path
        let sleeper = RecordingSleeper()
        let uid = USBDeviceUID("usb:1234:5678")!
        // A stale answer from before the request does not count: it times out.
        try DeviceConfigFile.writeStatus(CaptureDeviceStatus(deviceUID: "usb:1234:5678", requestedUID: "usb:1234:5678", outcome: .switched,
                                                             alsaName: "hw:CARD=Spare,DEV=0", reason: nil, atWallNS: 100, pid: 1),
                                         besideConfig: store.configURL.path)
        do {
            try await ConfigRepinSwitch(store: store, sleeper: sleeper).switchCapture(to: uid, requestedAtWallNS: 200)
            XCTFail("took a stale answer")
        } catch {
            XCTAssertEqual(error as? CaptureSwitchError, .noConfirmation(seconds: 15))
        }
        XCTAssertEqual(sleeper.sleeps.count, 61, "15 s at 250 ms")
        try DeviceConfigFile.writeStatus(CaptureDeviceStatus(deviceUID: "usb:0d8c:0134", requestedUID: "usb:1234:5678", outcome: .refusedAbsent,
                                                             alsaName: nil, reason: "absent", atWallNS: 300, pid: 1), besideConfig: store.configURL.path)
        XCTAssertEqual(mode(URL(fileURLWithPath: statusPath)), 0o600)
        do {
            try await ConfigRepinSwitch(store: store, sleeper: RecordingSleeper()).switchCapture(to: uid, requestedAtWallNS: 200)
            XCTFail()
        } catch {
            XCTAssertEqual(error as? CaptureSwitchError, .notPresent)
        }
        try DeviceConfigFile.writeStatus(CaptureDeviceStatus(deviceUID: "usb:1234:5678", requestedUID: "usb:1234:5678", outcome: .switched,
                                                             alsaName: "hw:CARD=Spare,DEV=0", reason: nil, atWallNS: 400, pid: 1), besideConfig: store.configURL.path)
        try await ConfigRepinSwitch(store: store, sleeper: RecordingSleeper()).switchCapture(to: uid, requestedAtWallNS: 200)
    }

    // MARK: fix 1 — the capture's decisions

    func testRepinDecisions() {
        let a = PinnedUSBIdentity("usb:0d8c:0134")!
        let listed = [ListedCapture(stableName: "hw:CARD=Device,DEV=0", card: 1, device: 0, usbID: "0d8c:0134"),
                      ListedCapture(stableName: "hw:CARD=Spare2,DEV=0", card: 3, device: 0, usbID: "1234:5678"),
                      ListedCapture(stableName: "hw:CARD=Spare,DEV=0", card: 2, device: 0, usbID: "1234:5678"),
                      ListedCapture(stableName: "hw:CARD=sofhdadsp,DEV=6", card: 0, device: 6, usbID: nil)]
        XCTAssertEqual(RepinDecision.decide(current: a, configured: "usb:0d8c:0134", listed: listed), .ignore(reason: "unchanged"))
        XCTAssertEqual(RepinDecision.decide(current: a, configured: nil, listed: listed), .ignore(reason: "config.json has no readable device_uid"))
        guard case .ignore = RepinDecision.decide(current: a, configured: "hw:CARD=Device", listed: listed) else { return XCTFail() }
        XCTAssertEqual(RepinDecision.decide(current: a, configured: "usb:dead:beef", listed: listed), .refuseAbsent(requested: PinnedUSBIdentity("usb:dead:beef")!))
        XCTAssertEqual(RepinDecision.decide(current: a, configured: "usb:1234:5678", listed: listed),
                       .switchTo(PinnedUSBIdentity("usb:1234:5678")!, listed[2]), "exact usb id, lowest card")
        XCTAssertEqual(RepinStartup.decide(requestedNotReadyReason: nil, previous: a), .useRequested)
        XCTAssertEqual(RepinStartup.decide(requestedNotReadyReason: "busy", previous: a), .revertTo(a, reason: "busy"))
        XCTAssertEqual(RepinStartup.execArguments(["record", "--device-config", "c", "--repin-from", "usb:1111:2222", "--tape", "t"], previous: a),
                       ["record", "--device-config", "c", "--tape", "t", "--repin-from", "usb:0d8c:0134"])
    }

    func testCaptureRewritesOneKeyAtModeSixHundred() throws {
        let root = temporaryRoot()
        let store = RoomStore(root: root)
        var config = RoomConfig(origin: URL(string: "https://www.evenscribe.app")!, roomSlug: "opd-5", deviceUID: "usb:1234:5678", installID: "i", tabID: "app_i")
        config.channelLocked = true
        try store.saveConfig(config)
        XCTAssertEqual(DeviceConfigFile.readDeviceUID(store.configURL.path), "usb:1234:5678")
        try DeviceConfigFile.rewriteDeviceUID(store.configURL.path, to: "usb:0d8c:0134")
        var expected = config
        expected.deviceUID = "usb:0d8c:0134"
        XCTAssertEqual(try store.loadConfig(), expected, "every other key kept, and room-bench's own reader accepts the file")
        XCTAssertEqual(mode(store.configURL), 0o600)
    }

    func testCaptureStatusKeysAreWhatRoomBenchReads() throws {
        let status = CaptureDeviceStatus(deviceUID: "usb:a", requestedUID: "usb:b", outcome: .reverted, alsaName: "hw", reason: "busy", atWallNS: 7, pid: 9)
        let report = try JSONDecoder().decode(CaptureDeviceReport.self, from: try JSONEncoder().encode(status))
        XCTAssertEqual(report, CaptureDeviceReport(deviceUID: "usb:a", requestedUID: "usb:b", outcome: "reverted", alsaName: "hw", reason: "busy", atWallNS: 7, pid: 9))
    }

    // MARK: fix 2 — a day start cannot deadlock on uploads

    func testDayStartWaitsAtMostTheBoundThenStartsWithTheBacklogBehindIt() async throws {
        let clock = FakeClock()
        let r = try rig(clock: clock)
        echoAcks(r.transport)
        r.transport.onJSON("POST /api/bench/sessions", #"{"session":{"id":"s2","status":"recording"}}"#)
        // A weekend offline: 144 pieces from the last session, each taking 60 s to upload on a slow link.
        await r.lane.setPending(Array(repeating: (session: "s1", uploadSeconds: 60), count: 144))
        let before = clock.now
        await r.engine.handle(BenchCommand(id: "c1", kind: .startDay))
        let waited = clock.now.timeIntervalSince(before)
        XCTAssertLessThanOrEqual(waited, RoomEngine.dayStartBacklogTimeout + 60, "bounded: 300 s plus the one upload already under way")
        XCTAssertEqual(acks(r.transport).last?.1["ok"] as? Bool, true, "the day started")
        let remaining = await r.lane.pendingCount(sessionID: nil)
        XCTAssertEqual(remaining, 144 - 5, "the backlog is still there, uploading behind the day")
        let starts = await r.lane.calls.filter { $0.hasPrefix("start") }
        XCTAssertEqual(starts, ["start s2 0 startDay from 17000"], "the day begins on the tape where the command arrived")
        XCTAssertEqual(r.lines.all.filter { $0.hasPrefix("DAY START WITH BACKLOG: 139 piece(s)") }.count, 1)
        let phase = await r.engine.phase
        XCTAssertEqual(phase, .recording)
    }

    func testDayStartDoesNotWaitAtAllWhenUploadsAreFailing() async throws {
        let clock = FakeClock()
        let r = try rig(clock: clock)
        echoAcks(r.transport)
        r.transport.onJSON("POST /api/bench/sessions", #"{"session":{"id":"s2","status":"recording"}}"#)
        await r.lane.setPending([(session: "s1", uploadSeconds: 60)])
        await r.lane.setDrainError(BenchError.transport(message: "offline", retention: .retainLocalPiece))
        let before = clock.now
        await r.engine.handle(BenchCommand(id: "c1", kind: .startDay))
        XCTAssertEqual(clock.now, before)
        XCTAssertEqual(acks(r.transport).last?.1["ok"] as? Bool, true)
        XCTAssertTrue(r.lines.all.contains { $0.hasPrefix("DAY START WITH BACKLOG") && $0.contains("upload failing") })
    }

    func testAnotherSessionsBacklogDoesNotStopThisDayEnding() async throws {
        let clock = FakeClock()
        let r = try rig(clock: clock)
        echoAcks(r.transport)
        r.transport.onJSON("PATCH /api/bench/sessions/s2", #"{"ok":true}"#)
        await r.engine.setPhaseForTesting(.recording, sessionID: "s2")
        await r.lane.setPending([(session: "s1", uploadSeconds: 1_000)])
        await r.lane.setDrainError(BenchError.transport(message: "offline", retention: .retainLocalPiece))
        await r.engine.handle(BenchCommand(id: "e1", kind: .endDay))
        XCTAssertEqual(acks(r.transport).last?.1["ok"] as? Bool, false, "draining failed three times: the Mac's rule, kept")
        await r.lane.setDrainError(nil)
        await r.engine.setPhaseForTesting(.recording, sessionID: "s2")
        await r.engine.handle(BenchCommand(id: "e2", kind: .endDay))
        XCTAssertEqual(acks(r.transport).last?.1["ok"] as? Bool, true, "s1's backlog does not hold s2's end")
    }
}

final class LockedLines: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    func add(_ l: String) { lock.withLock { lines.append(l) } }
    var all: [String] { lock.withLock { lines } }
}

