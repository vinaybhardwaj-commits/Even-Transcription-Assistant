import Foundation
import XCTest
#if canImport(Glibc)
import Glibc
#endif
@testable import BenchCore

let full = PiecePlanner.fullPieceSamples
let t0: UInt64 = 1_789_360_200_123_456_789

func ck(_ s: Int64, wall: UInt64? = nil, rms: Double? = 0.1) -> TapeRecord {
    TapeRecord(samples: s, wallNS: wall ?? t0 + UInt64(s) * 62_500, rms: rms, peak: rms.map { $0 * 2 }, zeroRatio: rms == nil ? nil : 0)
}
func disc(_ s: Int64, _ cause: String, gap: UInt64? = nil, wall: UInt64? = nil) -> TapeRecord {
    TapeRecord(samples: s, wallNS: wall ?? t0 + UInt64(s) * 62_500 + (gap ?? 0), discontinuity: cause, gapNS: gap)
}

/// Copies ffmpeg's input to its output, so a "piece" holds exactly the bytes the encoder was given.
final class CopyRunner: PieceProcessRunning, @unchecked Sendable {
    private let lock = NSLock()
    private var _invocations: [FFmpegInvocation] = []
    var invocations: [FFmpegInvocation] { lock.withLock { _invocations } }
    func run(_ invocation: FFmpegInvocation) throws -> (status: Int32, standardError: String) {
        lock.withLock { _invocations.append(invocation) }
        let input = invocation.arguments[invocation.arguments.firstIndex(of: "-i")! + 1]
        try FileManager.default.copyItem(atPath: input, toPath: invocation.arguments.last!)
        return (0, "")
    }
}

final class PlannerTests: XCTestCase {
    func testFullPiecesAndFinalFlush() throws {
        let records = [ck(0, rms: nil), ck(full), ck(2 * full), ck(2 * full + 1_600_000)]
        let open = try PiecePlanner.plan(records: records, sessionID: "s", segmentID: "tape", startingIndex: 4, startingSample: 0)
        XCTAssertEqual(open.map { [$0.sampleStart, $0.sampleEnd] }, [[0, full], [full, 2 * full]])
        XCTAssertEqual(open.map(\.index), [4, 5])
        XCTAssertEqual(open[0].durationMS, 300_000)
        XCTAssertEqual(open[0].startedAtMS, Int64((Double(t0) / 1e9 * 1000).rounded()))
        let flushed = try PiecePlanner.plan(records: records, sessionID: "s", segmentID: "tape", startingIndex: 4, startingSample: 0, finalFlush: true)
        XCTAssertEqual(flushed.last.map { [$0.sampleStart, $0.sampleEnd, $0.durationMS] }, [2 * full, 2 * full + 1_600_000, 100_000])
    }

    func testDiscontinuitiesCloseEarlyAndGapRules() throws {
        let records = [ck(0), ck(800_000), disc(800_000, "resumed", gap: 1_499_999), ck(800_000, wall: t0 + 900_000_000_000),
                       ck(1_600_000, wall: t0 + 950_000_000_000), disc(1_600_000, "restart"), ck(2_400_000),
                       disc(2_400_000, "ring_overflow", gap: 2_000_000), disc(2_400_000, "device_lost", gap: 7_500_000), ck(3_200_000)]
        let plans = try PiecePlanner.plan(records: records, sessionID: "s", segmentID: "tape", startingIndex: 0, startingSample: 0, finalFlush: true)
        XCTAssertEqual(plans.map { [$0.sampleStart, $0.sampleEnd] }, [[0, 800_000], [800_000, 1_600_000], [1_600_000, 2_400_000], [2_400_000, 3_200_000]])
        XCTAssertEqual(plans.map(\.gapBeforeMS), [0, 1, 0, 8], "1.499999 ms rounds to 1; restart carries 0; coincident gaps take the max, 7.5 ms rounds half up")
        XCTAssertEqual(plans[1].startedAtMS, Int64((Double(t0 + 900_000_000_000) / 1e9 * 1000).rounded()), "the boundary checkpoint is the anchor, not the discontinuity")
    }

    func testPrunedWindowPlansIdentically() throws {
        var records = [ck(0), disc(160_000, "day_rollover"), ck(160_000, wall: t0 + 10_000_000_000)]
        var s: Int64 = 160_000
        while s < 3 * full { s += 20_400; records.append(ck(s, wall: t0 + 10_000_000_000 + UInt64(s - 160_000) * 62_500)) }
        let cursor: Int64 = 160_000 + full
        let fullPlan = try PiecePlanner.plan(records: records, sessionID: "s", segmentID: "tape", startingIndex: 9, startingSample: cursor, finalFlush: true)
        let pruned = [records[1], records[2]] + records.filter { ($0.samples ?? 0) >= cursor }
        let prunedPlan = try PiecePlanner.plan(records: pruned, sessionID: "s", segmentID: "tape", startingIndex: 9, startingSample: cursor, finalFlush: true)
        XCTAssertEqual(fullPlan, prunedPlan)
        XCTAssertFalse(fullPlan.isEmpty)
    }

    func testInitialGapReachesTheFirstPlannedPieceMidRegion() throws {
        let records = [ck(0), ck(2 * full)]
        let plans = try PiecePlanner.plan(records: records, sessionID: "s", segmentID: "tape", startingIndex: 0, startingSample: 1_000_000, initialGapBeforeMS: 60_000)
        XCTAssertEqual(plans.map(\.gapBeforeMS), [60_000])
    }

    func testFilenameAndArgv() throws {
        XCTAssertEqual(PiecePlan.defaultFilename(sessionID: "a/b c", index: 7), "a_b_c_chunk_00007.webm")
        XCTAssertEqual(PieceEncoder.arguments(inputPCM: "IN", outputWebM: "OUT"),
                       ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "IN",
                        "-map_metadata", "-1", "-c:a", "libopus", "-application", "voip", "-b:a", "32k", "-vbr", "on", "-frame_duration", "20",
                        "-f", "webm", "OUT"])
        XCTAssertThrowsError(try PieceEncoder(ffmpegPath: "ffmpeg"), "never PATH")
        XCTAssertEqual(PieceSpool.defaultCapBytes, 398_897_568)
    }

    /// The conformance corpus's own piece expectations (C5/C6), where the fixtures are on disk.
    func testAgreesWithConformanceFixtures() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("fixtures/good")
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else {
            throw XCTSkip("fixtures/ not generated here")
        }
        var compared = 0
        for name in names.sorted() {
            let dir = root.appendingPathComponent(name)
            guard let expectedData = FileManager.default.contents(atPath: dir.appendingPathComponent("expected.json").path),
                  let expected = (try JSONSerialization.jsonObject(with: expectedData) as? [String: Any])?["pieces"] as? [[String: Any]],
                  let idx = FileManager.default.contents(atPath: dir.appendingPathComponent("tape.idx").path),
                  let pcmSize = regularFileSize(dir.appendingPathComponent("tape.pcm").path) else { continue }
            var records: [TapeRecord] = []
            for line in idx.split(separator: 0x0A) {
                if let r = try? JSONDecoder().decode(TapeRecord.self, from: Data(line)) { records.append(r) }
            }
            // The fixture's tape runs to tape.pcm's end; a final flush covers it.
            if let last = records.last?.samples, pcmSize / 2 > last {
                records.append(TapeRecord(samples: pcmSize / 2, wallNS: records.last!.wallNS + UInt64(pcmSize / 2 - last) * 62_500))
            }
            let plans = try PiecePlanner.plan(records: records, sessionID: "s", segmentID: "tape", startingIndex: 0, startingSample: records.first!.samples!, finalFlush: true)
            let got = plans.map { [$0.sampleStart, $0.sampleEnd, $0.gapBeforeMS] }
            let want = expected.map { [($0["sampleStart"] as! NSNumber).int64Value, ($0["sampleEnd"] as! NSNumber).int64Value, (($0["gap_before_ms"] as? NSNumber)?.int64Value ?? 0)] }
            XCTAssertEqual(got, want, name)
            compared += 1
        }
        XCTAssertGreaterThan(compared, 0)
        print("planner agreed with \(compared) conformance fixture(s)")
    }
}

final class SpoolTests: XCTestCase {
    func makePiece(_ spool: PieceSpool, session: String, index: Int, startMS: Int64, bytes: Int) throws -> PieceManifest {
        let plan = PiecePlan(sessionID: session, index: index, segmentID: "tape", sampleStart: Int64(index) * full, sampleEnd: Int64(index + 1) * full,
                             startedAtMS: startMS, endedAtMS: startMS + 300_000, durationMS: 300_000, gapBeforeMS: 0)
        let manifest = try plan.manifest(sizeBytes: Int64(bytes))
        try Data(repeating: UInt8(index), count: bytes).write(to: spool.mediaURL(filename: manifest.filename))
        try spool.publish(manifest)
        return manifest
    }

    func testCapDropsOldestFirstLogsAndAlwaysPublishes() throws {
        let root = temporaryRoot()
        let lines = LockedLines()
        let spool = try PieceSpool(root: root.appendingPathComponent("spool"), dropLog: root.appendingPathComponent("spool-drops.jsonl"),
                                   capBytes: 250, log: RoomLog(sink: { lines.add($0) }))
        _ = try makePiece(spool, session: "s1", index: 0, startMS: 1_000, bytes: 100)
        _ = try makePiece(spool, session: "s1", index: 1, startMS: 301_000, bytes: 100)
        _ = try makePiece(spool, session: "s1", index: 2, startMS: 601_000, bytes: 100)
        XCTAssertEqual(try spool.pending().map(\.manifest.index), [1, 2])
        _ = try makePiece(spool, session: "s1", index: 3, startMS: 901_000, bytes: 240)
        XCTAssertEqual(try spool.pending().map(\.manifest.index), [3], "a piece bigger than what is left still goes in")
        let drops = try spool.drops()
        XCTAssertEqual(drops.map(\.pieceID), ["s1/0", "s1/1", "s1/2"])
        XCTAssertEqual([drops[1].byteStart, drops[1].byteEnd], [2 * full, 4 * full])
        XCTAssertEqual(lines.all.filter { $0.hasPrefix("SPOOL FULL") }.count, 3)
        XCTAssertTrue(lines.all[0].contains("--piece s1/0 --bytes 0-\(2 * full)"))
        XCTAssertEqual(mode(root.appendingPathComponent("spool-drops.jsonl")), 0o600)
    }
}

/// A tape that grows whenever the lane sleeps, like the real capture does.
final class GrowingTape: Sleeper, @unchecked Sendable {
    let dir: URL
    private let lock = NSLock()
    private(set) var samples: Int64 = 0
    var wallNS: UInt64 = t0
    var growOnSleep: Int64 = 20_400
    var sleeps = 0

    init() throws {
        dir = temporaryRoot()
        FileManager.default.createFile(atPath: dir.appendingPathComponent("tape.idx").path, contents: nil)
        FileManager.default.createFile(atPath: dir.appendingPathComponent("tape.pcm").path, contents: nil)
        append(record: #"{"byte_offset":0,"device":"t","input_frames":0,"input_sample_rate":48000,"mono_ns":1,"rms":0,"samples":0,"wall_ns":\#(t0)}"#)
    }

    func append(record line: String) {
        let h = FileHandle(forWritingAtPath: dir.appendingPathComponent("tape.idx").path)!
        h.seekToEndOfFile()
        h.write(Data((line + "\n").utf8))
        h.closeFile()
    }

    /// Appends `count` samples of a recognisable ramp and a checkpoint for them.
    func grow(_ count: Int64) {
        lock.withLock {
            var bytes = Data(count: Int(count) * 2)
            bytes.withUnsafeMutableBytes { raw in
                for i in 0..<Int(count) { raw.storeBytes(of: Int16(truncatingIfNeeded: (samples + Int64(i)) % 30_000).littleEndian, toByteOffset: i * 2, as: Int16.self) }
            }
            let h = FileHandle(forWritingAtPath: dir.appendingPathComponent("tape.pcm").path)!
            h.seekToEndOfFile()
            h.write(bytes)
            h.closeFile()
            samples += count
            wallNS += UInt64(count) * 62_500
            append(record: #"{"byte_offset":\#(samples * 2),"device":"t","mono_ns":1,"peak":0.5,"rms":0.25,"samples":\#(samples),"wall_ns":\#(wallNS),"zero_ratio":0}"#)
        }
    }

    func discontinuity(_ cause: String, gapNS: UInt64) {
        lock.withLock {
            wallNS += gapNS
            append(record: #"{"byte_offset":\#(samples * 2),"device":"t","discontinuity":"\#(cause)","gap_ns":\#(gapNS),"mono_ns":1,"samples":\#(samples),"wall_ns":\#(wallNS)}"#)
        }
    }

    func sleep(nanoseconds: UInt64) async throws {
        lock.withLock { sleeps += 1 }
        if growOnSleep > 0 { grow(growOnSleep) }
    }

    func pcmBytes(_ start: Int64, _ end: Int64) -> Data {
        let h = FileHandle(forReadingAtPath: dir.appendingPathComponent("tape.pcm").path)!
        defer { h.closeFile() }
        h.seek(toFileOffset: UInt64(start))
        return h.readData(ofLength: Int(end - start))
    }
}

final class LaneTests: XCTestCase {
    struct Rig {
        let tape: GrowingTape
        let lane: TapePieceLane
        let spool: PieceSpool
        let store: RoomStore
        let runner: CopyRunner
        let transport: FakeTransport
        let lines: LockedLines
    }

    func rig(tape: GrowingTape? = nil, store: RoomStore? = nil, cap: Int64 = PieceSpool.defaultCapBytes, now: @escaping @Sendable () -> Date = { Date(timeIntervalSince1970: 0) }) throws -> Rig {
        let tape = try tape ?? GrowingTape()
        let store = store ?? RoomStore(root: temporaryRoot())
        let lines = LockedLines()
        let log = RoomLog(sink: { lines.add($0) })
        let spool = try PieceSpool(root: store.spoolURL, dropLog: store.dropLogURL, capBytes: cap, log: log)
        let runner = CopyRunner()
        let t = FakeTransport()
        let client = BenchClient(origin: URL(string: "https://www.evenscribe.app")!, transport: t, sessionToken: { "T" })
        let lane = TapePieceLane(tapeDir: tape.dir, encoder: try PieceEncoder(ffmpegPath: "/usr/bin/ffmpeg", runner: runner), spool: spool,
                                 client: client, store: store, log: log, sleeper: tape, now: now)
        return Rig(tape: tape, lane: lane, spool: spool, store: store, runner: runner, transport: t, lines: lines)
    }

    func testCutsExactByteRangesFromTheDurableEndAndFlushesOnStop() async throws {
        let r = try rig()
        r.tape.grow(1_000_000)  // audio before start_day: never uploaded
        try await r.lane.start(sessionID: "s1", nextIndex: 3, trigger: .startDay)
        r.tape.growOnSleep = 0
        r.tape.grow(full + 400_000)
        try await r.lane.publishAvailable()
        var pending = try r.spool.pending()
        XCTAssertEqual(pending.count, 1)
        let first = try XCTUnwrap(pending.first).manifest
        XCTAssertEqual([first.sampleStart, first.sampleEnd, Int64(first.index)], [1_000_000, 1_000_000 + full, 3])
        let media = try Data(contentsOf: URL(fileURLWithPath: pending[0].mediaPath))
        XCTAssertEqual(media, r.tape.pcmBytes(2_000_000, 2_000_000 + 2 * full), "the encoder was given exactly the piece's byte range")
        XCTAssertEqual(r.runner.invocations.first?.executable, "/usr/bin/ffmpeg")
        try await r.lane.stopAndFlush()
        pending = try r.spool.pending()
        XCTAssertEqual(pending.last.map { [$0.manifest.sampleStart, $0.manifest.sampleEnd, Int64($0.manifest.index)] },
                       [1_000_000 + full, r.tape.samples, 4])
        let cutting = await r.lane.isCutting()
        XCTAssertFalse(cutting)
        // The tape kept its bytes (D6: nothing here writes it).
        XCTAssertEqual(regularFileSize(r.tape.dir.appendingPathComponent("tape.pcm").path), r.tape.samples * 2)
    }

    func testADelayedStartBeginsWhereTheCommandArrivedEvenAcrossARestart() async throws {
        let r = try rig()
        r.tape.growOnSleep = 0
        r.tape.grow(1_000_000)
        let atCommand = await r.lane.durableSamples()!
        r.tape.grow(300_000)                      // the start waited on a backlog...
        r.tape.discontinuity("restart", gapNS: 0) // ...and the capture re-pinned meanwhile
        r.tape.grow(200_000)
        r.tape.growOnSleep = 20_400
        try await r.lane.start(sessionID: "s1", nextIndex: 0, trigger: .startDay, fromSamples: atCommand)
        r.tape.growOnSleep = 0
        try await r.lane.stopAndFlush()
        let pieces = try r.spool.pending().map { [$0.manifest.sampleStart, $0.manifest.sampleEnd] }
        XCTAssertEqual(pieces.first?.first, atCommand, "nothing between the command and the start is skipped")
        XCTAssertEqual(pieces.first?.last, atCommand + 300_000, "the restart record closes the piece")
        XCTAssertEqual(pieces.count, 2)
    }

    func testStartOnADeadTapeThrows() async throws {
        let r = try rig()
        r.tape.growOnSleep = 0
        do {
            try await r.lane.start(sessionID: "s1", nextIndex: 0, trigger: .startDay)
            XCTFail("started on a tape that is not advancing")
        } catch {
            XCTAssertEqual(error as? LaneError, .tapeNotAdvancing(seconds: 20))
        }
        XCTAssertEqual(r.tape.sleeps, 200)
    }

    func testPauseLeavesTheTapeAndResumeCarriesTheGap() async throws {
        let r = try rig()
        try await r.lane.start(sessionID: "s1", nextIndex: 0, trigger: .startDay)
        r.tape.growOnSleep = 0
        r.tape.grow(800_000)
        try await r.lane.stopAndFlush()                  // pause: piece 0 closes
        let paused = try r.spool.pending().last!.manifest
        r.tape.grow(960_000)                             // 60 s recorded while paused, not cut
        r.tape.growOnSleep = 20_400
        try await r.lane.start(sessionID: "s1", nextIndex: 1, trigger: .resumeDay)
        r.tape.growOnSleep = 0
        r.tape.grow(160_000)
        try await r.lane.stopAndFlush()
        let resumed = try r.spool.pending().last!.manifest
        XCTAssertEqual(resumed.index, 1)
        XCTAssertEqual(resumed.sampleStart, paused.sampleEnd + 960_000)
        XCTAssertEqual(resumed.gapBeforeMS, 60_000)
    }

    func testRestartContinuesFromCursorJSON() async throws {
        let r = try rig()
        try await r.lane.start(sessionID: "s1", nextIndex: 0, trigger: .startDay)
        r.tape.growOnSleep = 0
        r.tape.grow(full + 10_000)
        try await r.lane.publishAvailable()
        let saved = try XCTUnwrap(try r.store.read(LaneCursor.self, from: r.store.cursorURL))
        XCTAssertTrue(saved.cutting)
        // The process dies; the tape keeps recording; a new process reconciles the same session.
        r.tape.grow(500_000)
        r.tape.discontinuity("restart", gapNS: 0)
        r.tape.grow(200_000)
        r.tape.growOnSleep = 20_400
        let again = try rig(tape: r.tape, store: r.store)
        try await again.lane.start(sessionID: "s1", nextIndex: 0, trigger: .reconciliation)
        r.tape.growOnSleep = 0
        try await again.lane.stopAndFlush()
        let pieces = try again.spool.pending().map { [$0.manifest.sampleStart, $0.manifest.sampleEnd, Int64($0.manifest.index)] }
        let restartAt = saved.nextSample + 10_020 + 500_000 - 20_400 + 20_400  // where the restart record landed
        XCTAssertEqual(pieces.first, [saved.nextSample - full, saved.nextSample, 0])
        XCTAssertEqual(pieces[1][0], saved.nextSample, "no gap and no overlap across the process restart")
        XCTAssertEqual(pieces[1][2], 1)
        XCTAssertEqual(pieces.count, 3, "the capture's restart record closes a piece early")
        _ = restartAt
        XCTAssertTrue(again.lines.all.contains { $0.contains("from cursor.json") })
    }

    func testDrainRunsTheFiveStepsAndEmptiesTheSpool() async throws {
        let r = try rig()
        try await r.lane.start(sessionID: "s1", nextIndex: 0, trigger: .startDay)
        r.tape.growOnSleep = 0
        r.tape.grow(16_000)
        try await r.lane.stopAndFlush()
        let spooled = try r.spool.pending()[0].manifest
        let size = spooled.sizeBytes
        XCTAssertEqual(spooled.sampleEnd - spooled.sampleStart, 20_400 + 16_000, "the growth seen while starting is in the piece")
        r.transport.onJSON("POST /api/bench/upload-url", #"{"url":"https://s/p","head_url":"https://s/h"}"#)
        r.transport.on("HEAD /h") { [t = r.transport] _ in
            t.requests.filter { $0.method == "HEAD" }.count == 1 ? HTTPResponse(status: 404) : HTTPResponse(status: 200, headers: ["Content-Length": "\(size)"])
        }
        r.transport.on("PUT /p") { _ in HTTPResponse(status: 200) }
        r.transport.onJSON("POST /api/bench/chunks", #"{"ok":true,"key":"k","upload_state":"verified","ended_disagrees":"session_ended"}"#)
        let ended = try await r.lane.drainPending()
        XCTAssertTrue(ended)
        XCTAssertEqual(try r.spool.pending().count, 0)
        let register = jsonObject(r.transport.requests.last?.body)
        XCTAssertEqual(register["duration_ms"] as? Int, 2_275)
        XCTAssertEqual(register["idx"] as? Int, 0)
    }

    func testFailedUploadKeepsThePiece() async throws {
        let r = try rig()
        try await r.lane.start(sessionID: "s1", nextIndex: 0, trigger: .startDay)
        r.tape.growOnSleep = 0
        r.tape.grow(16_000)
        try await r.lane.stopAndFlush()
        r.transport.onJSON("POST /api/bench/upload-url", status: 503, "{}")
        do {
            _ = try await r.lane.drainPending()
            XCTFail()
        } catch let e as BenchError {
            XCTAssertTrue(e.mustRetainLocalPiece)
        }
        XCTAssertEqual(try r.spool.pending().count, 1)
    }

    func testDroppedPieceIsReCutByteForByteFromTheTape() async throws {
        let r = try rig(cap: 3_300_000)  // room for one 3.2 MB test piece of 1 600 000 samples, not two
        try await r.lane.start(sessionID: "s1", nextIndex: 0, trigger: .startDay)
        r.tape.growOnSleep = 0
        r.tape.grow(1_600_000)
        try await r.lane.stopAndFlush()
        let original = try r.spool.pending()[0]
        let originalBytes = try Data(contentsOf: URL(fileURLWithPath: original.mediaPath))
        r.tape.growOnSleep = 20_400
        try await r.lane.start(sessionID: "s1", nextIndex: 1, trigger: .resumeDay)
        r.tape.growOnSleep = 0
        r.tape.grow(1_600_000)
        try await r.lane.stopAndFlush()
        XCTAssertEqual(try r.spool.pending().map(\.manifest.index), [1], "piece 0 was dropped for the cap")
        let drop = try XCTUnwrap(try r.spool.drops().first)
        XCTAssertEqual(drop.pieceID, "s1/0")
        XCTAssertThrowsError(try PieceRecut.recut(pieceID: "s1/0", bytes: "0-2", spool: r.spool, encoder: try PieceEncoder(ffmpegPath: "/usr/bin/ffmpeg", runner: r.runner), pcmPath: r.tape.dir.appendingPathComponent("tape.pcm").path))

        let big = try PieceSpool(root: r.store.spoolURL, dropLog: r.store.dropLogURL, capBytes: PieceSpool.defaultCapBytes, log: RoomLog(sink: { _ in }))
        let recut = try PieceRecut.recut(pieceID: drop.pieceID, bytes: "\(drop.byteStart)-\(drop.byteEnd)", spool: big,
                                         encoder: try PieceEncoder(ffmpegPath: "/usr/bin/ffmpeg", runner: r.runner),
                                         pcmPath: r.tape.dir.appendingPathComponent("tape.pcm").path)
        XCTAssertEqual(recut, original.manifest, "the re-cut piece's manifest is the dropped one's")
        let recutBytes = try Data(contentsOf: big.mediaURL(filename: recut.filename))
        XCTAssertEqual(recutBytes, originalBytes, "the same bytes of tape.pcm went back through the encoder")
        XCTAssertEqual(try big.pending().map(\.manifest.index), [0, 1])
        XCTAssertThrowsError(try PieceRecut.recut(pieceID: drop.pieceID, bytes: "\(drop.byteStart)-\(drop.byteEnd)", spool: big,
                                                  encoder: try PieceEncoder(ffmpegPath: "/usr/bin/ffmpeg", runner: r.runner),
                                                  pcmPath: r.tape.dir.appendingPathComponent("tape.pcm").path)) {
            guard case .alreadySpooled = $0 as? PieceRecut.RecutError else { return XCTFail("\($0)") }
        }
    }

    func testISOMillisecondsRoundTrip() {
        for ms: Int64 in [0, 1_789_360_200_123, 1_789_360_200_999, 1_789_324_199_999] {
            XCTAssertEqual(PieceRecut.parseMS(ISO8601.string(milliseconds: ms)), ms)
        }
        XCTAssertEqual(ISO8601.string(milliseconds: 1_789_360_200_123), "2026-09-14T04:30:00.123Z")
    }
}
