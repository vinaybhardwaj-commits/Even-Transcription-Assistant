import Foundation
#if canImport(Glibc)
import Glibc
#endif

/// `cursor.json`: where piece cutting stands, so a restarted process carries on from the next unspooled sample instead
/// of skipping what the tape recorded while it was down. Linux only — the Mac opens a fresh segment on every start.
public struct LaneCursor: Codable, Equatable, Sendable {
    public var sessionID: String
    public var nextSample: Int64
    public var nextIndex: Int
    public var cutting: Bool
    public var lastPieceEndedAtMS: Int64?

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id", nextSample = "next_sample", nextIndex = "next_index", cutting
        case lastPieceEndedAtMS = "last_piece_ended_at_ms"
    }
}

public enum LaneError: Error, Equatable, CustomStringConvertible {
    case tapeNotAdvancing(seconds: Int)
    case noTape(String)

    public var description: String {
        switch self {
        case .tapeNotAdvancing(let s): return "capture_not_advancing: tape.idx did not grow within \(s) s; is room-recorder.service running?"
        case .noTape(let p): return "no tape index at \(p)"
        }
    }
}

/// The production `PieceLane` over the ONE continuous tape (V1, D6). The capture writes the tape; this only reads it:
/// tape.idx as it grows, and each piece's exact byte range of tape.pcm through the encoder.
public actor TapePieceLane: PieceLane {
    public static let segmentID = "tape"
    static let growthDeadlineNS: UInt64 = 20_000_000_000      // RoomEngine.swift waitForDurableGrowth: 20 s
    static let growthPollNS: UInt64 = 100_000_000
    /// A stop waits this long, at most, for the index to reach the moment of the command, so the final piece ends there
    /// rather than at the checkpoint before it (checkpoints land every ~1.3 s).
    static let flushWaitNS: UInt64 = 3_000_000_000

    let pcmPath: String
    let follower: TapeIndexFollower
    let indexPath: String
    let encoder: PieceEncoder
    let spool: PieceSpool
    let client: BenchClient
    let store: RoomStore
    let log: RoomLog
    let sleeper: any Sleeper
    let now: @Sendable () -> Date

    var sessionID: String?
    var cursor: Int64 = 0
    var index = 0
    var cutting = false
    var lastPieceEndedAtMS: Int64?
    var pendingInitialGapMS: Int64 = 0
    /// While cutting: the records that opened the region holding the cursor, then every record at or after the cursor.
    /// Dropping the checkpoints in between changes nothing the planner computes.
    var window: [TapeRecord] = []
    /// The records that opened the most recent region.
    var latestGroup: [TapeRecord] = []
    var lastRecord: TapeRecord?
    var lastRMS: Double?
    var lastPeak: Double?
    var lastZeroRatio: Double?
    var persisted: LaneCursor?
    /// The first read of the index is the whole file. When cursor.json says cutting was under way, that one read also
    /// builds the window for the saved cursor, so a restart never reads a long tape twice.
    var initialReadDone = false
    var bootCursor: Int64?
    var bootWindow: [TapeRecord] = []

    public init(tapeDir: URL, encoder: PieceEncoder, spool: PieceSpool, client: BenchClient, store: RoomStore, log: RoomLog,
                sleeper: any Sleeper, now: @escaping @Sendable () -> Date = { Date() }) {
        self.pcmPath = tapeDir.appendingPathComponent("tape.pcm").path
        self.indexPath = tapeDir.appendingPathComponent("tape.idx").path
        self.follower = TapeIndexFollower(path: tapeDir.appendingPathComponent("tape.idx").path)
        self.encoder = encoder
        self.spool = spool
        self.client = client
        self.store = store
        self.log = log
        self.sleeper = sleeper
        self.now = now
        self.persisted = try? store.read(LaneCursor.self, from: store.cursorURL)
    }

    // MARK: reading the tape

    func refresh() {
        let records = follower.readNew()
        if follower.didReset {
            log("tape.idx was replaced or rewritten; reading it again from the start")
            latestGroup = []
            lastRecord = nil
            window = []
            bootWindow = []
        }
        if !initialReadDone {
            initialReadDone = true
            bootCursor = persisted?.cutting == true ? persisted?.nextSample : nil
        }
        if cutting {
            absorb(records, cursor: cursor, into: &window)
        } else if let bootCursor {
            absorb(records, cursor: bootCursor, into: &bootWindow)
            // A server unreachable for days would grow this without bound; past about a week of checkpoints it is
            // dropped and a reconciliation that still wants it reads the index again instead.
            if bootWindow.count > 500_000 { bootWindow = [] }
        } else {
            var unused: [TapeRecord] = []
            absorb(records, cursor: nil, into: &unused)
        }
    }

    /// Groups, the last record, the levels, and — with a cursor — the planning window.
    func absorb(_ records: [TapeRecord], cursor: Int64?, into window: inout [TapeRecord]) {
        for record in records {
            guard let samples = record.samples else { continue }
            if let rms = record.rms { lastRMS = rms }
            if let peak = record.peak { lastPeak = peak }
            if let zero = record.zeroRatio { lastZeroRatio = zero }
            let groupStart = latestGroup.first?.samples
            if latestGroup.isEmpty || record.discontinuity != nil && samples != groupStart {
                latestGroup = [record]
                if let cursor { if samples <= cursor { window = [record] } else { window.append(record) } }
            } else if samples == groupStart {
                latestGroup.append(record)
                if cursor != nil { window.append(record) }
            } else if let cursor, samples >= cursor {
                window.append(record)
            }
            lastRecord = record
        }
    }

    /// The whole index again, building the window for `cursor` from scratch.
    func rescan(cursor: Int64) {
        let fresh = TapeIndexFollower(path: indexPath)
        latestGroup = []
        window = []
        absorb(fresh.readNew(), cursor: cursor, into: &window)
    }

    /// The window again for the current cursor, keeping only what planning still needs.
    func prune() {
        let old = window
        latestGroup = []
        window = []
        absorb(old, cursor: cursor, into: &window)
        // `absorb` rebuilt latestGroup from the window alone; the true latest group is the last one it saw, which is
        // the same group, because the window runs to the end of the index.
    }

    // MARK: PieceLane

    public func start(sessionID: String, nextIndex: Int, trigger: LaneStartTrigger) async throws {
        refresh()
        let before = lastRecord?.samples
        let deadline = Self.growthDeadlineNS / Self.growthPollNS
        var waited: UInt64 = 0
        while true {
            if let now = lastRecord?.samples, let before, now > before { break }
            if before == nil, lastRecord?.samples != nil, waited > 0 { break }
            guard waited < deadline else { throw LaneError.tapeNotAdvancing(seconds: Int(Self.growthDeadlineNS / 1_000_000_000)) }
            try await sleeper.sleep(nanoseconds: Self.growthPollNS)
            waited += 1
            refresh()
        }

        if trigger == .reconciliation, let saved = persisted, saved.sessionID == sessionID, saved.cutting {
            cursor = saved.nextSample
            index = max(nextIndex, saved.nextIndex)
            lastPieceEndedAtMS = saved.lastPieceEndedAtMS
            pendingInitialGapMS = 0
            if bootCursor == saved.nextSample, !bootWindow.isEmpty { window = bootWindow } else { rescan(cursor: cursor) }
            bootWindow = []
            bootCursor = nil
            log("resuming piece cutting for session \(sessionID) at sample \(cursor), index \(index), from cursor.json")
        } else {
            let startSample = before ?? lastRecord?.samples ?? 0
            if sessionID != self.sessionID { lastPieceEndedAtMS = nil }
            cursor = startSample
            index = nextIndex
            // The region holding the durable end is the latest one: its opening group and the last record are all the
            // planner needs. No rescan of a long tape.
            window = latestGroup
            if let last = lastRecord, last != latestGroup.last { window.append(last) }
            bootWindow = []
            bootCursor = nil
            if trigger == .resumeDay, let last = lastPieceEndedAtMS, let anchor = latestGroupAnchor(atOrBefore: cursor) {
                let at = PiecePlanner.timestampMS(sample: cursor, anchorSample: anchor.samples!, anchorWallNS: anchor.wallNS)
                pendingInitialGapMS = max(0, at - last)
            } else {
                pendingInitialGapMS = 0
            }
            if trigger == .reconciliation {
                log("cutting for session \(sessionID) from the tape's durable end, sample \(cursor): no cursor.json for it, so anything the tape recorded before now stays on tape only")
            }
        }
        self.sessionID = sessionID
        cutting = true
        try persist()
    }

    /// The anchor the planner will use for the region holding `sample`: the last record of that region's opening group.
    func latestGroupAnchor(atOrBefore sample: Int64) -> TapeRecord? {
        var group: [TapeRecord] = []
        for record in window {
            guard let s = record.samples else { continue }
            if group.isEmpty || record.discontinuity != nil && s != group[0].samples {
                if s > sample { break }
                group = [record]
            } else if s == group[0].samples {
                group.append(record)
            }
        }
        return group.last
    }

    public func stopAndFlush() async throws {
        guard cutting else { return }
        let requestedNS = UInt64(max(0, now().timeIntervalSince1970) * 1_000_000_000)
        var waited: UInt64 = 0
        refresh()
        while (lastRecord?.wallNS ?? 0) < requestedNS, waited < Self.flushWaitNS / Self.growthPollNS {
            try? await sleeper.sleep(nanoseconds: Self.growthPollNS)
            waited += 1
            refresh()
        }
        try cut(finalFlush: true)
        cutting = false
        try persist()
    }

    public func publishAvailable() async throws {
        guard cutting else {
            refresh()
            return
        }
        refresh()
        try cut(finalFlush: false)
    }

    func cut(finalFlush: Bool) throws {
        guard let sessionID, !window.isEmpty else { return }
        let plans = try PiecePlanner.plan(records: window, sessionID: sessionID, segmentID: Self.segmentID, startingIndex: index,
                                          startingSample: cursor, initialGapBeforeMS: pendingInitialGapMS, finalFlush: finalFlush)
        for plan in plans {
            let filename = PiecePlan.defaultFilename(sessionID: plan.sessionID, index: plan.index)
            if let existing = spool.existingManifest(filename: filename) {
                // A crash between publishing and saving the cursor: the piece is already in the ledger.
                guard existing.sampleStart == plan.sampleStart, existing.sampleEnd == plan.sampleEnd else {
                    throw PiecePipelineError.destinationExists("\(filename) is spooled for samples \(existing.sampleStart)-\(existing.sampleEnd), not \(plan.sampleStart)-\(plan.sampleEnd)")
                }
            } else {
                let media = spool.mediaURL(filename: filename)
                if regularFileSize(media.path) != nil {
                    unlink(media.path)  // media without a manifest: an interrupted publish, not a piece
                }
                let size = try encoder.encode(plan: plan, pcmPath: pcmPath, destination: media)
                try spool.publish(try plan.manifest(sizeBytes: size))
            }
            cursor = plan.sampleEnd
            index = plan.index + 1
            lastPieceEndedAtMS = plan.endedAtMS
            pendingInitialGapMS = 0
            try persist()
        }
        if !plans.isEmpty { prune() }
    }

    public func drainPending() async throws -> Bool {
        var endedByServer = false
        for piece in try spool.pending() {
            let bytes = try Data(contentsOf: URL(fileURLWithPath: piece.mediaPath))
            let result = try await client.uploadImmutablePiece(piece.manifest.benchPiece, bytes: bytes)
            try spool.removeVerified(piece, sessionID: piece.manifest.sessionID, index: piece.manifest.index, sizeBytes: piece.manifest.sizeBytes)
            if case .registered(let response, _) = result, response.endedDisagrees != nil { endedByServer = true }
        }
        return endedByServer
    }

    public func pendingCount() async -> Int { (try? spool.pending().count) ?? 0 }
    public func isCutting() async -> Bool { cutting }
    public func nextIndex() async -> Int { index }

    public func durableSamples() async -> Int64? {
        refresh()
        return lastRecord?.samples
    }

    public func latestLevels() async -> (rms: Double?, peak: Double?, zeroRatio: Double?) {
        refresh()
        return (lastRMS, lastPeak, lastZeroRatio)
    }

    public func endSession() async {
        bootCursor = nil
        bootWindow = []
        cutting = false
        sessionID = nil
        lastPieceEndedAtMS = nil
        pendingInitialGapMS = 0
        window = []
        persisted = nil
        unlink(store.cursorURL.path)
    }

    func persist() throws {
        guard let sessionID else { return }
        let saved = LaneCursor(sessionID: sessionID, nextSample: cursor, nextIndex: index, cutting: cutting, lastPieceEndedAtMS: lastPieceEndedAtMS)
        try store.write(saved, to: store.cursorURL)
        persisted = saved
    }

    // Test access.
    var cursorForTesting: Int64 { cursor }
    var windowCountForTesting: Int { window.count }
}

/// S4's re-cut: a dropped piece back into the pipeline from tape.pcm, given its id and byte range.
public enum PieceRecut {
    public enum RecutError: Error, Equatable, CustomStringConvertible {
        case badPieceID(String)
        case badByteRange(String)
        case notDropped(pieceID: String, bytes: String)
        case alreadySpooled(String)

        public var description: String {
            switch self {
            case .badPieceID(let v): return "--piece must be <session_id>/<idx>, got \(v)"
            case .badByteRange(let v): return "--bytes must be <start>-<end>, even, end > start, got \(v)"
            case .notDropped(let p, let b): return "no drop of piece \(p) with bytes \(b) is logged in spool-drops.jsonl; nothing re-cut"
            case .alreadySpooled(let f): return "\(f) is already in the spool; nothing re-cut"
            }
        }
    }

    public static func parseByteRange(_ raw: String) throws -> (Int64, Int64) {
        let parts = raw.split(separator: "-")
        guard parts.count == 2, let a = Int64(parts[0]), let b = Int64(parts[1]), a >= 0, b > a, a % 2 == 0, b % 2 == 0 else {
            throw RecutError.badByteRange(raw)
        }
        return (a, b)
    }

    /// The drop log is the ledger of what was dropped: the piece's times and gap come from it, the audio from the tape.
    @discardableResult
    public static func recut(pieceID: String, bytes: String, spool: PieceSpool, encoder: PieceEncoder, pcmPath: String) throws -> PieceManifest {
        guard pieceID.split(separator: "/").count == 2 else { throw RecutError.badPieceID(pieceID) }
        let (start, end) = try parseByteRange(bytes)
        guard let drop = try spool.drops().last(where: { $0.pieceID == pieceID && $0.byteStart == start && $0.byteEnd == end }) else {
            throw RecutError.notDropped(pieceID: pieceID, bytes: bytes)
        }
        let filename = PiecePlan.defaultFilename(sessionID: drop.sessionID, index: drop.index)
        guard spool.existingManifest(filename: filename) == nil else { throw RecutError.alreadySpooled(filename) }
        guard let startedMS = parseMS(drop.startedAt), let endedMS = parseMS(drop.endedAt) else {
            throw PiecePipelineError.invalidManifest("drop log timestamps unreadable for \(pieceID)")
        }
        let plan = PiecePlan(sessionID: drop.sessionID, index: drop.index, segmentID: TapePieceLane.segmentID, sampleStart: start / 2,
                             sampleEnd: end / 2, startedAtMS: startedMS, endedAtMS: endedMS, durationMS: drop.durationMS,
                             gapBeforeMS: drop.gapBeforeMS)
        let media = spool.mediaURL(filename: filename)
        if regularFileSize(media.path) != nil { unlink(media.path) }
        let size = try encoder.encode(plan: plan, pcmPath: pcmPath, destination: media)
        let manifest = try plan.manifest(sizeBytes: size)
        try spool.publish(manifest)
        return manifest
    }

    /// Inverse of `ISO8601.string(milliseconds:)`.
    static func parseMS(_ text: String) -> Int64? {
        let scanner = Array(text.utf8)
        guard scanner.count == 24, text.hasSuffix("Z") else { return nil }
        func number(_ from: Int, _ count: Int) -> Int32? { Int32(String(decoding: scanner[from..<from + count], as: UTF8.self)) }
        guard let y = number(0, 4), let mo = number(5, 2), let d = number(8, 2), let h = number(11, 2), let mi = number(14, 2),
              let s = number(17, 2), let ms = number(20, 3) else { return nil }
        var parts = tm()
        parts.tm_year = y - 1900
        parts.tm_mon = mo - 1
        parts.tm_mday = d
        parts.tm_hour = h
        parts.tm_min = mi
        parts.tm_sec = s
        return Int64(timegm(&parts)) * 1_000 + Int64(ms)
    }
}
