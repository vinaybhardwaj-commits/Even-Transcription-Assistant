import Foundation
import Testing

@testable import KioskHealthCore

// MARK: - The helper's engine (0.1.36, #47)

private func engineConfig(source: String = "helper", dir: URL) -> Config {
    var c = Config(machine: "OPD-4.local")
    c.source = source
    c.post = true
    c.roomID = "room-4"
    c.installID = "inst_4"
    c.spoolDir = dir.path
    c.logPath = dir.appendingPathComponent("engine.log").path
    return c
}

private func accepted(_ n: Int) -> Data { Data("{\"ok\":true,\"accepted\":\(n),\"duplicates\":0,\"rejected\":0}".utf8) }

private func events(_ batch: KioskHealthEngine.Batch?) -> [[String: Any]] {
    guard let batch, let o = try? JSONSerialization.jsonObject(with: batch.body) as? [String: Any] else { return [] }
    return (o["events"] as? [[String: Any]]) ?? []
}

@Suite(.serialized) struct KioskHealthEngineTests {
    let clock = FakeClock(Date(timeIntervalSince1970: 1_790_000_000))

    func engine(_ dir: URL, source: String = "helper") throws -> KioskHealthEngine {
        try KioskHealthEngine(config: engineConfig(source: source, dir: dir), runner: FakeRunner(), clock: clock)
    }

    // ─── the envelope ──────────────────────────────────────────────────────────────────────

    @Test func theEnvelopeIsTheStandaloneDaemonsExceptForTheSource() throws {
        let a = try engine(tmpDir("eng-h"), source: "helper")
        let b = try engine(tmpDir("eng-d"), source: "daemon")
        for e in [a, b] { e.emit(kind: "chrome.profile", payload: ["running": true, "presence_ok": true, "active": ["Default"]]) }
        var helper = try #require(events(a.nextBatch()).first)
        var daemon = try #require(events(b.nextBatch()).first)
        #expect(helper["source"] as? String == "helper" && daemon["source"] as? String == "daemon")
        for key in ["source", "boot_id"] { helper.removeValue(forKey: key); daemon.removeValue(forKey: key) }
        #expect(NSDictionary(dictionary: helper).isEqual(to: daemon), "same machine, kind, ts, seq, payload, room_id, install_id")
        #expect(Set(helper.keys) == ["machine", "seq", "kind", "ts", "payload", "room_id", "install_id"])
    }

    @Test func theSinkLimitsStillHold() throws {
        let e = try engine(tmpDir("eng-limits"))
        e.emit(kind: "Chrome Policy/Weird KIND!", payload: ["a": String(repeating: "x", count: 40_000)])
        let sent = try #require(events(e.nextBatch()).first)
        #expect(sent["kind"] as? String == "chrome_policy_weird_kind_")
        let payload = try #require(sent["payload"] as? [String: Any])
        #expect(payload["_truncated"] as? Bool == true, "a payload over 16 KB is replaced, not sent")
    }

    // ─── delivery, driven by the app ───────────────────────────────────────────────────────

    @Test func theSameBatchComesBackUntilTheAppReportsAnAnswer() throws {
        let e = try engine(tmpDir("eng-same"))
        for i in 0..<3 { e.emit(kind: "drift", payload: ["i": i]) }
        let first = try #require(e.nextBatch())
        let again = try #require(e.nextBatch())
        #expect(first == again && first.count == 3)
    }

    @Test func aSinkAnswerAcksTheBatchAndTheNextOneIsNew() throws {
        let e = try engine(tmpDir("eng-ack"))
        e.emit(kind: "drift", payload: ["i": 1])
        let first = try #require(e.nextBatch())
        #expect(e.complete(batchID: first.id, status: 200, body: accepted(1), reason: "") == "sent")
        #expect(e.spoolDepth == 0)
        clock.advance(20)
        e.emit(kind: "drift", payload: ["i": 2])
        let second = try #require(e.nextBatch())
        #expect(second.id != first.id)
    }

    @Test func aLostAnswerLosesNothing_aNewEngineHandsTheSameEventsOutAgain() throws {
        let dir = tmpDir("eng-lost")
        do {
            let e = try engine(dir)
            e.emit(kind: "power.wake", payload: ["origin": "test"])
            _ = try #require(e.nextBatch())
            // the app dies before it reports; the helper restarts
        }
        let again = try engine(dir)
        let batch = try #require(again.nextBatch())
        #expect(events(batch).contains { $0["kind"] as? String == "power.wake" })
    }

    @Test func a413HalvesTheBatchAndA400QuarantinesIt() throws {
        let e = try engine(tmpDir("eng-413"))
        for i in 0..<8 { e.emit(kind: "drift", payload: ["i": i]) }
        let big = try #require(e.nextBatch())
        #expect(big.count == 8)
        #expect(e.complete(batchID: big.id, status: 413, body: Data(), reason: "http 413") == "failed")
        let smaller = try #require(e.nextBatch())
        #expect(smaller.count == 4 && smaller.id != big.id, "the same events, in a smaller batch")
        #expect(e.complete(batchID: smaller.id, status: 400, body: Data(), reason: "http 400") == "quarantined")
        #expect(e.spoolDepth == 4, "the four quarantined events are out of the spool, four are left")
    }

    @Test func a401PausesAnHourAndNetworkErrorsBackOff() throws {
        let e = try engine(tmpDir("eng-401"))
        e.emit(kind: "drift", payload: ["i": 1])
        let b = try #require(e.nextBatch())
        #expect(e.complete(batchID: b.id, status: 401, body: Data(), reason: "http 401") == "unauthorized")
        clock.advance(3_500)
        #expect(e.nextBatch() == nil, "paused for an hour")
        clock.advance(200)
        let resumed = try #require(e.nextBatch())
        #expect(e.complete(batchID: resumed.id, status: nil, body: Data(), reason: "offline") == "failed")
        #expect(e.nextBatch() == nil, "backing off after a transport error")
        clock.advance(11)
        #expect(e.nextBatch() != nil, "ten seconds, then the first retry")
        #expect(e.spoolDepth >= 1, "nothing was deleted")
    }

    @Test func aTwoHundredWithoutTheSinksReplyIsNotAnAck() throws {
        let e = try engine(tmpDir("eng-proxy"))
        e.emit(kind: "drift", payload: ["i": 1])
        let b = try #require(e.nextBatch())
        #expect(e.complete(batchID: b.id, status: 200, body: Data("<html>captive portal</html>".utf8), reason: "") == "failed")
        #expect(e.spoolDepth == 1)
    }

    @Test func aStaleAnswerChangesNothing() throws {
        let e = try engine(tmpDir("eng-stale"))
        e.emit(kind: "drift", payload: ["i": 1])
        let b = try #require(e.nextBatch())
        #expect(e.complete(batchID: "not-the-batch", status: 200, body: accepted(1), reason: "") == "stale")
        #expect(e.spoolDepth == 1)
        #expect(e.nextBatch() == b)
    }

    @Test func protectedKindsAreOnDiskAtOnceEvenBeforeAnyBatchIsTaken() throws {
        let dir = tmpDir("eng-protected")
        let e = try engine(dir)
        e.emit(kind: "chrome.alert", payload: ["reason": "ext_missing:Default"])
        let files = try #require(FileManager.default.enumerator(atPath: dir.path)?.allObjects as? [String])
        let onDisk = files.contains { name in
            (try? String(contentsOfFile: dir.appendingPathComponent(name).path, encoding: .utf8))?.contains("chrome.alert") == true
        }
        #expect(onDisk, "a protected kind is flushed to disk the moment it is emitted")
    }

    // ─── identity and secrets ──────────────────────────────────────────────────────────────

    @Test func theLegacyConfigGivesIdentityAndBaselineAndNeverItsTokenSinkOrActions() throws {
        let dir = tmpDir("eng-legacy")
        let legacy = dir.appendingPathComponent("config.json")
        try Data("""
            {"machine":"OPD-6.local","room_id":"room-6","install_id":"inst_6","sink_url":"https://x.example/api/kiosk-health",
             "token":"SECRET-LEGACY-TOKEN","post":true,"baseline":{"sleep":0,"womp":1},
             "actions":{"darkwake_watchdog":true,"audio_ladder":true,"reboot_rung":true},"console_user":"kiosk"}
            """.utf8).write(to: legacy)
        let e = try KioskHealthEngine(stateDir: dir.appendingPathComponent("spool").path, logPath: dir.appendingPathComponent("l.log").path, legacyConfigPath: legacy.path)
        let c = e.config
        #expect(c.machine == "OPD-6.local" && c.roomID == "room-6" && c.installID == "inst_6" && c.consoleUser == "kiosk")
        #expect(c.source == "helper" && c.token == nil, "the old token is not carried over")
        #expect(c.actions == Actions(darkwakeWatchdog: false, audioLadder: false, rebootRung: false), "no action flag is read, none is on")
        e.emit(kind: "drift", payload: ["i": 1])
        let body = String(decoding: try #require(e.nextBatch()).body, as: UTF8.self)
        #expect(!body.contains("SECRET-LEGACY-TOKEN") && body.contains("\"source\":\"helper\""))
    }

    @Test func withoutALegacyConfigTheHostNameIsTheMachine() throws {
        let dir = tmpDir("eng-nolegacy")
        let e = try KioskHealthEngine(stateDir: dir.appendingPathComponent("s").path, logPath: dir.appendingPathComponent("l").path, legacyConfigPath: dir.appendingPathComponent("absent.json").path)
        #expect(e.config.machine == Config.defaultMachine() && e.config.source == "helper")
    }

    @Test func onlyOneEnginePerStateDirectory() throws {
        let dir = tmpDir("eng-lock")
        let first = try engine(dir)
        #expect(throws: AlreadyRunning.self) { _ = try engine(dir) }
        _ = first
    }

    // ─── what the port left out ────────────────────────────────────────────────────────────

    @Test func theProcessRunnerRefusesEverythingButTheReadOnlyTools() {
        let runner = ProcessRunner()
        for tool in ["/bin/sh", "/sbin/shutdown", "/usr/bin/killall", "/usr/bin/caffeinate", "/usr/bin/sudo", "/bin/rm"] {
            let r = runner.run(tool, ["-n"], timeout: 2)
            #expect(r.launchError?.contains("tool not allowed") == true, "\(tool) must not run")
        }
        #expect(Tool.all == ["/usr/bin/pmset", "/usr/sbin/ioreg", "/usr/sbin/system_profiler", "/usr/bin/log", "/usr/bin/pgrep", "/usr/bin/defaults", "/usr/bin/stat", "/bin/ps", "/usr/bin/plutil"])
    }

    @Test func noActionNoNetworkAndNoCoreAudioOrCoreGraphicsAnywhereInTheSources() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/KioskHealthCore")
        let banned = [
            "import CoreAudio", "import CoreGraphics", "import AVFoundation", "URLSession", "URLRequest", "/usr/bin/killall", "/sbin/shutdown",
            "/usr/bin/caffeinate", "SPUSBDataType", "AudioLadder", "Watchdog(",
        ]
        let names = try FileManager.default.contentsOfDirectory(atPath: sources.path).filter { $0.hasSuffix(".swift") }
        #expect(names.count > 20)
        for name in names {
            let text = try String(contentsOf: sources.appendingPathComponent(name), encoding: .utf8)
            // Comments and the allow-list's own refusal test may NAME these; code may not.
            let code = text.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
            for word in banned { #expect(!code.contains(word), "\(name) contains \(word)") }
        }
    }

    @Test func thePackageLinksOnlyIOKitAndCoreFoundationForTheCollectors() throws {
        let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Package.swift")
        let text = try String(contentsOf: package, encoding: .utf8)
        let start = try #require(text.range(of: "name: \"KioskHealthCore\""))
        let tail = String(text[start.lowerBound...])
        let block = String(tail.prefix(upTo: try #require(tail.range(of: "\n  ),\n")).lowerBound))
        #expect(block.contains(".linkedFramework(\"IOKit\")") && block.contains(".linkedFramework(\"CoreFoundation\")"))
        #expect(!block.contains("CoreAudio") && !block.contains("CoreGraphics"))
    }

    // ─── adapted from the standalone daemon's own tests (they read Daemon.swift; this reads the engine) ───

    @Test func f10_thePmsetLogIsParsedEveryFiveMinutes() {
        #expect(KioskHealthEngine.powerPollInterval == 300)
    }

    @Test func f7_presenceIsIoregEverySixtySecondsAndSystemProfilerOnItsOwnTimer() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("Sources/KioskHealthCore/KioskHealthEngine.swift"), encoding: .utf8)
        #expect(source.contains("every(60, queue: \"audio\"") && source.contains("audio.presencePoll()"))
        #expect(source.contains("every(AudioCollector.profileInterval") && source.contains("audio.profilePoll("))
        #expect(source.contains("every(10, queue: \"recorder\"") && source.contains("every(60, queue: \"chrome\""))
    }

    @Test func f14_theSpoolCapsAreTheOnesForADaemonWhoseEventsLeaveTheMac() {
        #expect(Spool.defaultCap(post: true) == 50 * 1024 * 1024)
        #expect(Spool.defaultProtectedCeiling(post: true) == 200 * 1024 * 1024)
    }
}
