import Foundation
import XCTest
@testable import BenchCore

actor FakeLane: PieceLane {
    var calls: [String] = []
    var cutting = false
    var pending = 0
    var startError: Error?
    var drainError: Error?
    var endedByServer = false
    var index = 0
    var samples: Int64 = 1000

    func record(_ c: String) { calls.append(c) }
    func setStartError(_ e: Error?) { startError = e }
    func setPending(_ n: Int) { pending = n }
    func setDrainError(_ e: Error?) { drainError = e }

    func start(sessionID: String, nextIndex: Int, trigger: LaneStartTrigger) async throws {
        calls.append("start \(sessionID) \(nextIndex) \(trigger)")
        if let startError { throw startError }
        cutting = true
        index = nextIndex
    }
    func stopAndFlush() async throws {
        calls.append("stopAndFlush")
        cutting = false
    }
    func publishAvailable() async throws {}
    func drainPending() async throws -> Bool {
        calls.append("drain")
        if let drainError { throw drainError }
        pending = 0
        return endedByServer
    }
    func pendingCount() async -> Int { pending }
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

struct RecordingSwitch: CaptureDeviceSwitching {
    let succeed: Bool
    func switchCapture(to uid: USBDeviceUID) async throws { if !succeed { throw CaptureSwitchUnavailable() } }
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
    }

    func rig(devices: [EnumeratedCaptureDevice] = [tm20, spare], switchSucceeds: Bool = false, cancelAfter: Int = 1_000) throws -> Rig {
        let root = temporaryRoot()
        let store = RoomStore(root: root)
        let config = RoomConfig(origin: URL(string: "https://www.evenscribe.app")!, roomSlug: "opd-5", deviceUID: "usb:0d8c:0134",
                                tapeDir: root.path, installID: "inst_1", tabID: "app_inst_1")
        try store.saveConfig(config)
        let t = FakeTransport()
        t.onJSON("GET /api/bench/sessions/active", #"{"ok":true,"resumable":false,"session":null,"handover_pending":false,"tab_gone":false}"#)
        t.onJSON("POST *", #"{"ok":true,"id":"x","status":"acked"}"#)
        let lane = FakeLane()
        let sleeper = RecordingSleeper(cancelAfter: cancelAfter)
        let volume = FakeVolume()
        volume.values[tm20.uid] = InputVolumeReading(value: 21.0 / 62, settable: true)
        let log = RoomLog(sink: { _ in })
        let env = RoomEngineEnvironment(
            client: BenchClient(origin: config.origin, transport: t, sessionToken: { "TOKEN" }), store: store, lane: lane,
            devices: FakeDevices(devices: devices), volume: volume, captureSwitch: RecordingSwitch(succeed: switchSucceeds),
            machineFacts: { MachineFacts(hostname: "yoga") }, ffmpegVersion: { "ffmpeg version 6.1.1" }, sleeper: sleeper, log: log)
        return Rig(engine: RoomEngine(config: config, installID: "inst_1", environment: env), transport: t, lane: lane,
                   sleeper: sleeper, store: store, volume: volume, log: log)
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
        XCTAssertEqual(starts, ["start s1 0 startDay"])
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
        XCTAssertEqual(acks(r.transport).last?.1["error"] as? String, "device_switch_failed: capture_device_switch_not_wired")
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
                                        captureSwitch: UnwiredCaptureSwitch(), machineFacts: { MachineFacts() }, ffmpegVersion: { nil },
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

final class LockedLines: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []
    func add(_ l: String) { lock.withLock { lines.append(l) } }
    var all: [String] { lock.withLock { lines } }
}

