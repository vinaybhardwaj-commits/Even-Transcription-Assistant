import Foundation

public struct PieceRange: Codable, Equatable, Sendable {
    public var sampleStart: Int64
    public var sampleEnd: Int64
    /// Set on the first piece after a discontinuity that carries a gap (PiecePipeline gapMilliseconds(for:)).
    public var gapBeforeMS: Int64?

    public init(sampleStart: Int64, sampleEnd: Int64, gapBeforeMS: Int64? = nil) {
        self.sampleStart = sampleStart
        self.sampleEnd = sampleEnd
        self.gapBeforeMS = gapBeforeMS
    }

    enum CodingKeys: String, CodingKey {
        case sampleStart, sampleEnd
        case gapBeforeMS = "gap_before_ms"
    }

    public var samples: Int64 { sampleEnd - sampleStart }
}

/// A span of tape between discontinuities, with the clock anchor that opens it.
public struct TapeRegion: Equatable, Sendable {
    public var start: Int64
    public var end: Int64
    /// The anchor is the `samples` + `wall_ns` pair of the record that opens the region; a checkpoint at the
    /// region boundary replaces a preceding discontinuity's timestamp (PiecePipeline.swift:300-305).
    public var anchorSample: Int64
    public var anchorWallNS: Int64
    /// Index line that supplied the anchor.
    public var anchorLine: Int
    /// Index line of the record that opened the region. Its records run from here up to the next region's openLine.
    public var openLine: Int
    /// The discontinuity that opened the region, if any: the LAST one when several share the sample.
    public var openedBy: String?
    public var gapBeforeNS: Int64?
    /// gap_before_ms of the first piece of this region: the MAXIMUM over every discontinuity record at its start
    /// (PiecePipeline.swift:277-307 — a coincident discontinuity appends no region; `regionGap = max(regionGap, nextGap)`
    /// while regionStart, durableEnd and the anchor are overwritten).
    public var gapBeforeMS: Int64 = 0
    /// How many discontinuity records sit at this region's start.
    public var coincidentDiscontinuities = 0
}

public enum TapeRegions {
    /// Regions from the index (RoomPiecePlanner, PiecePipeline.swift:277-307). Records without `samples` cannot be placed
    /// and are skipped. A region closes on any record whose `discontinuity` is set, EXCEPT one that sits at the region's own
    /// start: a zero-length region is never appended. Instead that region's gap becomes the maximum of the coincident gaps
    /// and its anchor, open line and cause are overwritten by the later record. The last region ends at `totalSamples`.
    public static func regions(_ lines: [IndexLine], totalSamples: Int64) -> [TapeRegion] {
        var out: [TapeRegion] = []
        var current: TapeRegion? = nil
        func opened(at s: Int64, _ line: IndexLine, _ w: Int64, _ cause: String?) -> TapeRegion {
            TapeRegion(start: s, end: 0, anchorSample: s, anchorWallNS: w, anchorLine: line.number, openLine: line.number,
                       openedBy: cause, gapBeforeNS: line.int(IndexKey.gapNS),
                       gapBeforeMS: DiscontinuityCause.gapMilliseconds(cause: cause, gapNS: line.int(IndexKey.gapNS)),
                       coincidentDiscontinuities: cause == nil ? 0 : 1)
        }
        for line in lines {
            guard let s = line.int(IndexKey.samples), let w = line.int(IndexKey.wallNS) else { continue }
            let cause: String? = { if case .string(let c)? = line.fields[IndexKey.discontinuity] { return c }; return nil }()
            if current == nil {
                current = opened(at: 0, line, w, cause)
                current!.anchorSample = s
                continue
            }
            if let cause {
                if s == current!.start, current!.openedBy != nil {
                    // Coincident with the discontinuity that opened this region: no region is appended.
                    let ms = DiscontinuityCause.gapMilliseconds(cause: cause, gapNS: line.int(IndexKey.gapNS))
                    current!.gapBeforeMS = max(current!.gapBeforeMS, ms)
                    current!.coincidentDiscontinuities += 1
                    current!.anchorSample = s
                    current!.anchorWallNS = w
                    current!.anchorLine = line.number
                    current!.openLine = line.number
                    current!.openedBy = cause
                    current!.gapBeforeNS = line.int(IndexKey.gapNS)
                    continue
                }
                current!.end = s
                out.append(current!)
                current = opened(at: s, line, w, cause)
            } else if current!.openedBy != nil, s == current!.start {
                current!.anchorSample = s
                current!.anchorWallNS = w
                current!.anchorLine = line.number
            }
        }
        if var last = current {
            last.end = totalSamples
            out.append(last)
        }
        return out
    }

    public static func region(containing sample: Int64, in regions: [TapeRegion]) -> TapeRegion? {
        if let r = regions.first(where: { $0.start <= sample && sample < $0.end }) { return r }
        if let last = regions.last, sample == last.end { return last }
        return nil
    }

    public static func wallNS(sample: Int64, in regions: [TapeRegion]) -> Int64? {
        region(containing: sample, in: regions).map {
            TapeClock.wallNS(sample: sample, anchorSample: $0.anchorSample, anchorWallNS: $0.anchorWallNS)
        }
    }
}

public enum PiecePlanner {
    /// RoomPiecePlanner.plan: pieces of 4 800 000 samples within each region; a region's end forces a partial
    /// close and resets the cursor, so no piece straddles a discontinuity. The final partial is included
    /// (the tail flush is requested). The first piece of a region carries the region's gap — the maximum of
    /// gapMilliseconds(for:) over every discontinuity at its start (PiecePipeline.swift:277-307). Zero is represented here
    /// as absent; whether the Mac writes 0 or omits the key is not pinned, so C5 treats absent and 0 alike.
    public static func plan(_ regions: [TapeRegion]) -> [PieceRange] {
        var pieces: [PieceRange] = []
        for r in regions {
            var cursor = r.start
            while cursor < r.end {
                let end = min(cursor + TapeFormat.pieceSamples, r.end)
                var gap: Int64? = nil
                if cursor == r.start, r.gapBeforeMS != 0 { gap = r.gapBeforeMS }
                pieces.append(PieceRange(sampleStart: cursor, sampleEnd: end, gapBeforeMS: gap))
                cursor = end
            }
        }
        return pieces
    }
}

public enum PieceEncoder {
    /// Placeholders used in the pinned argument template.
    public static let inputPlaceholder = "{input}"
    public static let outputPlaceholder = "{output}"

    /// PiecePipeline.swift:485-496 at f798edf. Arguments only: the executable is not argv[0] of this array.
    /// The input is a temp file holding exactly the piece's byte range; the output path is the last element.
    public static func arguments(input: String, output: String) -> [String] {
        ["-hide_banner", "-loglevel", "error", "-nostdin", "-n",
         "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", input,
         "-map_metadata", "-1", "-c:a", "libopus", "-application", "voip", "-b:a", "32k", "-vbr", "on", "-frame_duration", "20",
         "-f", "webm", output]
    }
}
