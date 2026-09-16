import Foundation

/// The fields of one tape.idx line that planning and telemetry read. Everything else in the line is ignored here.
public struct TapeRecord: Decodable, Equatable, Sendable {
    public var samples: Int64?
    public var byteOffset: Int64?
    public var wallNS: UInt64
    public var discontinuity: String?
    public var gapNS: UInt64?
    public var rms: Double?
    public var peak: Double?
    public var zeroRatio: Double?

    enum CodingKeys: String, CodingKey {
        case samples, discontinuity, rms, peak
        case byteOffset = "byte_offset"
        case wallNS = "wall_ns"
        case gapNS = "gap_ns"
        case zeroRatio = "zero_ratio"
    }

    public init(samples: Int64?, byteOffset: Int64? = nil, wallNS: UInt64, discontinuity: String? = nil, gapNS: UInt64? = nil,
                rms: Double? = nil, peak: Double? = nil, zeroRatio: Double? = nil) {
        self.samples = samples
        self.byteOffset = byteOffset ?? samples.map { $0 * 2 }
        self.wallNS = wallNS
        self.discontinuity = discontinuity
        self.gapNS = gapNS
        self.rms = rms
        self.peak = peak
        self.zeroRatio = zeroRatio
    }
}

public enum PiecePipelineError: Error, Equatable, CustomStringConvertible {
    case invalidManifest(String)
    case invalidIndexRecord(Int)
    case nonMonotonicIndex(Int)
    case uncoveredSample(Int64)
    case missingTimestampAnchor(Int64)
    case sourceOpenFailed(String, Int32)
    case sourceRangeUnavailable(offset: Int64, count: Int64)
    case readFailed(offset: Int64, errno: Int32)
    case writeFailed(String, Int32)
    case processFailed(status: Int32, stderr: String)
    case emptyOutput
    case destinationExists(String)
    case verificationMismatch
    case io(String)

    public var description: String {
        switch self {
        case .invalidManifest(let d): return "invalid piece manifest: \(d)"
        case .invalidIndexRecord(let i): return "invalid index record at position \(i)"
        case .nonMonotonicIndex(let i): return "index sample position regressed at position \(i)"
        case .uncoveredSample(let s): return "sample \(s) is not covered by the index"
        case .missingTimestampAnchor(let s): return "no capture timestamp anchor covers sample \(s)"
        case .sourceOpenFailed(let p, let c): return "cannot open PCM source \(p): errno \(c)"
        case .sourceRangeUnavailable(let o, let c): return "PCM source does not contain byte range \(o)..<\(o + c)"
        case .readFailed(let o, let c): return "cannot read PCM source at byte \(o): errno \(c)"
        case .writeFailed(let p, let c): return "cannot write \(p): errno \(c)"
        case .processFailed(let s, let e): return "ffmpeg exited \(s): \(e)"
        case .emptyOutput: return "ffmpeg produced an empty WebM"
        case .destinationExists(let p): return "immutable destination already exists: \(p)"
        case .verificationMismatch: return "upload verification does not match the spooled piece"
        case .io(let d): return d
        }
    }
}

/// One planned piece (PiecePipeline.swift `RoomPiecePlan`). Times are integer milliseconds since the epoch, the Mac's
/// canonical form (its `canonicalDate` rounds to the millisecond).
public struct PiecePlan: Equatable, Sendable {
    public let sessionID: String
    public let index: Int
    public let segmentID: String
    public let sampleStart: Int64
    public let sampleEnd: Int64
    public let startedAtMS: Int64
    public let endedAtMS: Int64
    public let durationMS: Int64
    public let gapBeforeMS: Int64

    public var byteOffset: Int64 { sampleStart * 2 }
    public var byteCount: Int64 { (sampleEnd - sampleStart) * 2 }

    public static func defaultFilename(sessionID: String, index: Int) -> String {
        let safe = String(sessionID.map { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" ? $0 : "_" })
        let digits = String(index)
        return "\(safe)_chunk_\(String(repeating: "0", count: max(0, 5 - digits.count)))\(digits).webm"
    }

    public func manifest(sizeBytes: Int64) throws -> PieceManifest {
        try PieceManifest(sessionID: sessionID, index: index, segmentID: segmentID, sampleStart: sampleStart, sampleEnd: sampleEnd,
                          startedAtMS: startedAtMS, endedAtMS: endedAtMS, durationMS: durationMS, gapBeforeMS: gapBeforeMS,
                          sizeBytes: sizeBytes, filename: Self.defaultFilename(sessionID: sessionID, index: index))
    }
}

/// The spooled piece's ledger entry (PiecePipeline.swift `RoomPieceManifest`), key for key.
public struct PieceManifest: Codable, Equatable, Sendable {
    public static let webMContentType = "audio/webm"

    public let sessionID: String
    public let index: Int
    public let segmentID: String
    public let sampleStart: Int64
    public let sampleEnd: Int64
    public let startedAt: String
    public let endedAt: String
    public let durationMS: Int64
    public let gapBeforeMS: Int64
    public let contentType: String
    public let sizeBytes: Int64
    public let filename: String

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id", index = "idx", segmentID = "segment_id", sampleStart = "sample_start"
        case sampleEnd = "sample_end", startedAt = "started_at", endedAt = "ended_at", durationMS = "duration_ms"
        case gapBeforeMS = "gap_before_ms", contentType = "content_type", sizeBytes = "size_bytes", filename
    }

    public init(sessionID: String, index: Int, segmentID: String, sampleStart: Int64, sampleEnd: Int64, startedAtMS: Int64,
                endedAtMS: Int64, durationMS: Int64, gapBeforeMS: Int64, sizeBytes: Int64, filename: String) throws {
        guard !sessionID.isEmpty, index >= 0, !segmentID.isEmpty else {
            throw PiecePipelineError.invalidManifest("session, index, and segment are required")
        }
        guard sampleStart >= 0, sampleEnd > sampleStart, durationMS >= 0, gapBeforeMS >= 0, sizeBytes > 0 else {
            throw PiecePipelineError.invalidManifest("range, duration, gap, or size is invalid")
        }
        guard endedAtMS >= startedAtMS else { throw PiecePipelineError.invalidManifest("ended_at precedes started_at") }
        guard filename == (filename as NSString).lastPathComponent, !filename.hasPrefix("."), filename.hasSuffix(".webm") else {
            throw PiecePipelineError.invalidManifest("filename must be a plain .webm basename")
        }
        self.sessionID = sessionID
        self.index = index
        self.segmentID = segmentID
        self.sampleStart = sampleStart
        self.sampleEnd = sampleEnd
        self.startedAt = ISO8601.string(milliseconds: startedAtMS)
        self.endedAt = ISO8601.string(milliseconds: endedAtMS)
        self.durationMS = durationMS
        self.gapBeforeMS = gapBeforeMS
        self.contentType = Self.webMContentType
        self.sizeBytes = sizeBytes
        self.filename = filename
    }

    public func encodedJSON() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }

    public var benchPiece: BenchPiece {
        BenchPiece(sessionID: sessionID, index: index, contentType: contentType, startedAt: startedAt, endedAt: endedAt,
                   durationMS: Int(durationMS), sizeBytes: sizeBytes, gapBeforeMS: Int(gapBeforeMS))
    }
}

/// PiecePipeline.swift `RoomPiecePlanner.plan`, transcribed: regions between discontinuities, 4 800 000-sample pieces
/// (5 min at 16 kHz), a short piece where a region closes at a discontinuity or on a final flush, timestamps from the
/// region's anchor plus the sample count.
///
/// ONE EXTENSION for the continuous tape: on the Mac `initialGapBeforeMS` reaches the first piece only when the cursor
/// sits at the first region's start, which is always true there because every resume opens a fresh segment. Here a
/// resume continues the same tape mid-region, so the initial gap is applied to the FIRST PIECE PLANNED, taking the
/// maximum with the region's own gap when the cursor is also at a region start (the Mac's coincident-gap rule).
public enum PiecePlanner {
    public static let fullPieceSamples: Int64 = 4_800_000
    static let sampleRate: Int64 = 16_000

    public static func plan(records: [TapeRecord], sessionID: String, segmentID: String, startingIndex: Int, startingSample: Int64,
                            initialGapBeforeMS: Int64 = 0, finalFlush: Bool = false) throws -> [PiecePlan] {
        guard !sessionID.isEmpty, !segmentID.isEmpty, startingIndex >= 0, startingSample >= 0, initialGapBeforeMS >= 0 else {
            throw PiecePipelineError.invalidManifest("invalid planning identity or cursor")
        }
        guard !records.isEmpty else { return [] }
        var prior: Int64 = -1
        for (i, record) in records.enumerated() {
            guard let s = record.samples, let offset = record.byteOffset, s >= 0, s <= Int64.max / 2, offset == s * 2 else {
                throw PiecePipelineError.invalidIndexRecord(i)
            }
            guard s >= prior else { throw PiecePipelineError.nonMonotonicIndex(i) }
            prior = s
        }

        struct Region {
            let start: Int64, end: Int64, anchorSample: Int64, anchorWallNS: UInt64, gapBeforeMS: Int64, closesAtDiscontinuity: Bool
        }
        let first = records[0].samples!
        var regionStart = first
        var regionGap: Int64 = 0
        var anchor: (sample: Int64, wallNS: UInt64)?
        var durableEnd = first
        var regions: [Region] = []
        for record in records {
            let s = record.samples!
            if record.discontinuity != nil {
                let nextGap = gapMilliseconds(record)
                if s > regionStart {
                    guard let anchor else { throw PiecePipelineError.missingTimestampAnchor(regionStart) }
                    regions.append(Region(start: regionStart, end: s, anchorSample: anchor.sample, anchorWallNS: anchor.wallNS,
                                          gapBeforeMS: regionGap, closesAtDiscontinuity: true))
                    regionGap = nextGap
                } else {
                    regionGap = max(regionGap, nextGap)
                }
                regionStart = s
                durableEnd = s
                anchor = (s, record.wallNS)
            } else {
                durableEnd = s
                // A checkpoint at a region boundary is the first resumed audio; it replaces the discontinuity's stamp.
                if anchor == nil || s == regionStart { anchor = (s, record.wallNS) }
            }
        }
        if durableEnd > regionStart {
            guard let anchor else { throw PiecePipelineError.missingTimestampAnchor(regionStart) }
            regions.append(Region(start: regionStart, end: durableEnd, anchorSample: anchor.sample, anchorWallNS: anchor.wallNS,
                                  gapBeforeMS: regionGap, closesAtDiscontinuity: false))
        }
        guard let last = records.last?.samples, startingSample <= last else { throw PiecePipelineError.uncoveredSample(startingSample) }

        var cursor = startingSample
        var index = startingIndex
        var pendingInitialGap = initialGapBeforeMS
        var out: [PiecePlan] = []
        func make(_ start: Int64, _ end: Int64, _ region: Region) -> PiecePlan {
            var gap = start == region.start ? region.gapBeforeMS : 0
            if out.isEmpty && pendingInitialGap > 0 { gap = max(gap, pendingInitialGap) }
            return makePlan(sessionID: sessionID, segmentID: segmentID, index: index, start: start, end: end,
                            anchorSample: region.anchorSample, anchorWallNS: region.anchorWallNS, gapBeforeMS: gap)
        }
        for region in regions {
            if cursor >= region.end { continue }
            guard cursor >= region.start else { throw PiecePipelineError.uncoveredSample(cursor) }
            while region.end - cursor >= fullPieceSamples {
                let end = cursor + fullPieceSamples
                out.append(make(cursor, end, region))
                pendingInitialGap = 0
                index += 1
                cursor = end
            }
            if cursor < region.end && (region.closesAtDiscontinuity || finalFlush) {
                out.append(make(cursor, region.end, region))
                pendingInitialGap = 0
                index += 1
                cursor = region.end
            }
            if region.closesAtDiscontinuity { cursor = region.end }
        }
        return out
    }

    static func makePlan(sessionID: String, segmentID: String, index: Int, start: Int64, end: Int64, anchorSample: Int64,
                         anchorWallNS: UInt64, gapBeforeMS: Int64) -> PiecePlan {
        PiecePlan(sessionID: sessionID, index: index, segmentID: segmentID, sampleStart: start, sampleEnd: end,
                  startedAtMS: timestampMS(sample: start, anchorSample: anchorSample, anchorWallNS: anchorWallNS),
                  endedAtMS: timestampMS(sample: end, anchorSample: anchorSample, anchorWallNS: anchorWallNS),
                  durationMS: ((end - start) * 1_000 + sampleRate / 2) / sampleRate, gapBeforeMS: gapBeforeMS)
    }

    /// The Mac's Double arithmetic (anchor seconds + sample delta / 16 000), then its millisecond rounding.
    public static func timestampMS(sample: Int64, anchorSample: Int64, anchorWallNS: UInt64) -> Int64 {
        let seconds = Double(anchorWallNS) / 1_000_000_000 + Double(sample - anchorSample) / Double(sampleRate)
        return Int64((seconds * 1_000).rounded())
    }

    static func milliseconds(fromNanoseconds value: UInt64) -> Int64 {
        Int64(min(value / 1_000_000 + (value % 1_000_000 >= 500_000 ? 1 : 0), UInt64(Int64.max)))
    }

    /// gap_ns counts only for these four causes; every other cause, restart and day_rollover included, is 0 by rule.
    static func gapMilliseconds(_ record: TapeRecord) -> Int64 {
        switch record.discontinuity {
        case "capture_discontinuity", "resumed", "ring_overflow", "device_lost": return milliseconds(fromNanoseconds: record.gapNS ?? 0)
        default: return 0
        }
    }
}
