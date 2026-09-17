import Foundation

/// Wraps a real recorded tape as a suite fixture, so the unchanged cases run against live output. The fixture holds
/// recorded audio: it is written outside the repository and must never be committed.
///
/// A recorded tape has no independent expected answers, so only cases whose checks are invariants of the tape itself
/// are listed: C1 (geometry), C2 (byte fidelity and presence rules of every real line), C3 (a clean log repairs to
/// itself), C5 and C6 (the piece list is planned from the index; the cases then check adjacency, no straddling,
/// gap placement and exact piece lengths against the tape bytes), and C7 when the tape holds a ring_overflow (the gap
/// record's fields, and no zero fill at its offset). C4 needs expected wall times and is not listed;
/// the clock report below measures the recorded times against the sample-clock model instead.
public enum TapeAdopter {
    /// The parts of room-recorder's run summary that C8 pins a recorded rollover to: the capture thread's own log.
    struct RecorderSummary: Decodable {
        struct Split: Decodable {
            var firstFrame: Int64; var frameCount: Int; var frameOffset: Int
            var targetWallNS: Int64; var markerMonoNS: Int64; var suffixWallStartNS: Int64
            enum CodingKeys: String, CodingKey {
                case firstFrame = "first_frame", frameCount = "frame_count", frameOffset = "frame_offset"
                case targetWallNS = "target_wall_ns", markerMonoNS = "marker_mono_ns", suffixWallStartNS = "suffix_wall_start_ns"
            }
        }
        struct Event: Decodable { var firstFrame: Int64; var frames: Int64; var cause: String
            enum CodingKeys: String, CodingKey { case frames, cause, firstFrame = "first_frame" } }
        var rollovers: [Split]
        var events: [Event]
    }

    public static func adopt(tape: URL, fixturesRoot: URL, name: String, simulateTornTailBytes: Int?, recorderSummary: URL? = nil) throws -> String {
        let pcm = [UInt8](try Data(contentsOf: tape.appendingPathComponent("tape.pcm")))
        var idx = [UInt8](try Data(contentsOf: tape.appendingPathComponent("tape.idx")))
        var e = ExpectedAnswers()
        var cases: [CaseID]
        var report: [String] = []
        let description: String

        if let cut = simulateTornTailBytes {
            // A simulated power-cut tear: the last `cut` bytes of the index are removed, leaving a partial final line.
            guard cut > 0, cut < idx.count else { throw FixtureLoadError(fixture: name, reason: "bad tear size") }
            idx.removeLast(cut)
            let scan = try IndexLog.scan(idx)
            guard case .tornTail(let length, let dropped) = scan.outcome else {
                throw FixtureLoadError(fixture: name, reason: "removing \(cut) bytes did not leave a torn tail")
            }
            e.c3 = C3Expected(outcome: "torn_tail", records: scan.lines.count, repairedLength: length, droppedBytes: dropped)
            cases = [.C3]
            description = "RECORDED tape \(tape.path) with its index tail torn by removing the last \(cut) bytes (simulated tear; the recorder never produced it)."
            report.append("simulated tear: \(scan.lines.count) complete records, repair to \(length) bytes, \(dropped) torn bytes")
        } else {
            let scan = try IndexLog.scan(idx)
            guard scan.outcome == .clean else { throw FixtureLoadError(fixture: name, reason: "tape.idx is not clean: \(scan.outcome); repair it first") }
            let total = Int64(pcm.count / 2)
            let regions = TapeRegions.regions(scan.lines, totalSamples: total)
            let pieces = PiecePlanner.plan(regions)
            let regionEnds = Set(regions.map(\.end))
            let full = pieces.filter { $0.samples == TapeFormat.pieceSamples }.count
            let partials = pieces.filter { $0.samples != TapeFormat.pieceSamples && regionEnds.contains($0.sampleEnd) }.map(\.samples)
            e.c3 = C3Expected(outcome: "clean", records: scan.lines.count)
            e.pieces = pieces
            e.c6 = C6Expected(pieceSamples: TapeFormat.pieceSamples, fullPieces: full, partialPieces: partials)
            cases = [.C1, .C2, .C3, .C6]
            if pieces.count >= 2 { cases.insert(.C5, at: 3) }
            // C7 on a real forced gap: the first ring_overflow record carrying gap_ns and dropped_input_frames. The
            // tape holds exactly the audio before and after it, so pre = its samples and post = the rest.
            if let gap = scan.lines.first(where: {
                if case .string("ring_overflow")? = $0.fields[IndexKey.discontinuity] { return $0.int(IndexKey.gapNS) != nil && $0.int(IndexKey.droppedInputFrames) != nil }
                return false
            }), let at = gap.int(IndexKey.samples) {
                e.c7 = C7Expected(line: gap.number, cause: "ring_overflow", gapNS: gap.int(IndexKey.gapNS)!,
                                  droppedInputFrames: gap.int(IndexKey.droppedInputFrames)!, preGapSamples: at, postGapSamples: total - at)
                cases.append(.C7)
                report.append("C7 on line \(gap.number): ring_overflow at sample \(at), gap_ns \(gap.int(IndexKey.gapNS)!), dropped_input_frames \(gap.int(IndexKey.droppedInputFrames)!)")
            }
            // C8 on a recorded rollover: the laws are the tape's own; the pins come from the recorder's capture-side split
            // log (target, marker mono, the new day's first wall time, input frames at the split), not from the index.
            let markers = scan.lines.filter { if case .string(DiscontinuityCause.dayRollover)? = $0.fields[IndexKey.discontinuity] { return true }; return false }
            if !markers.isEmpty {
                guard let url = recorderSummary else { throw FixtureLoadError(fixture: name, reason: "the tape holds day_rollover records: pass --recorder-summary") }
                let log = try JSONDecoder().decode(RecorderSummary.self, from: Data(contentsOf: url))
                guard log.rollovers.count == markers.count else {
                    throw FixtureLoadError(fixture: name, reason: "summary logs \(log.rollovers.count) splits, tape holds \(markers.count) day_rollover records")
                }
                var pins: [C8Rollover] = []
                for (split, marker) in zip(log.rollovers, markers) {
                    let at = split.firstFrame + Int64(split.frameOffset)
                    let dropped = log.events.filter { $0.cause == "ring_overflow" && $0.firstFrame < at }.reduce(Int64(0)) { $0 + $1.frames }
                    let i = scan.lines.firstIndex { $0.number == marker.number }!
                    let s0 = marker.int(IndexKey.samples)
                    let next = i + 1 < scan.lines.count ? scan.lines[i + 1] : nil
                    let prev = i > 0 ? scan.lines[i - 1] : nil
                    let hasSuffix = next.map { $0.fields[IndexKey.discontinuity] == nil && $0.int(IndexKey.samples) == s0 } ?? false
                    let hasPrefix = prev.map { $0.fields[IndexKey.discontinuity] == nil && $0.fields[IndexKey.peak] != nil && $0.int(IndexKey.samples) == s0 } ?? false
                    let inside = split.frameOffset > 0 && split.frameOffset < split.frameCount
                    // Inside one buffer both neighbours are the logged segment boundary; at a buffer edge the other
                    // neighbour belongs to another buffer the log does not describe, and is taken from the tape.
                    let suffix = hasSuffix ? (split.frameOffset < split.frameCount ? split.suffixWallStartNS : next!.int(IndexKey.wallNS)) : nil
                    let prefix = hasPrefix ? (split.frameOffset > 0 ? split.suffixWallStartNS : prev!.int(IndexKey.wallNS)) : nil
                    pins.append(C8Rollover(line: marker.number, boundaryWallNS: split.targetWallNS, markerMonoNS: split.markerMonoNS,
                                           rolloverSample: s0 ?? -1, inputFrames: marker.fields[IndexKey.inputFrames] == nil ? nil : at - dropped,
                                           prefixEndWallNS: prefix, suffixWallNS: suffix,
                                           straddling: inside && split.suffixWallStartNS > split.targetWallNS && hasPrefix && hasSuffix))
                    report.append("C8 pin from the capture log: line \(marker.number) target \(split.targetWallNS), frame offset \(split.frameOffset)/\(split.frameCount), new day's first wall \(split.suffixWallStartNS) (Δ \(split.suffixWallStartNS - split.targetWallNS) ns), input frames at split \(at - dropped); rollover_sample \(s0 ?? -1) taken from the tape (held by C8's frames law)")
                }
                e.c8 = C8Expected(rollovers: pins)
                cases.append(.C8)
            }
            description = "RECORDED tape \(tape.path): \(total) samples (\(Double(total) / 16000) s), \(scan.lines.count) records, \(regions.count) region(s), \(pieces.count) piece(s). Real audio: never commit."
            report.append("tape: \(total) samples = \(Double(total) / 16000) s, \(scan.lines.count) records, \(regions.count) region(s), pieces \(pieces.map { "[\($0.sampleStart),\($0.sampleEnd))" })")
            report.append(contentsOf: clockReport(scan.lines, regions))
        }

        let dir = fixturesRoot.appendingPathComponent("good").appendingPathComponent(name)
        let fm = FileManager.default
        if fm.fileExists(atPath: dir.path) { try fm.removeItem(at: dir) }
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        func put(_ bytes: [UInt8], _ file: String) throws -> FileDigest {
            try Data(bytes).write(to: dir.appendingPathComponent(file))
            return FileDigest(file: file, bytes: Int64(bytes.count), sha256: SHA256.hex(bytes))
        }
        let pretty = JSONEncoder()
        pretty.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        var m = FixtureManifest(schema: FixtureManifest.currentSchema, name: name, description: description,
                                provenance: "recorded (not synthetic; outside the repository)", role: .good, cases: cases,
                                negativeControl: nil, pcm: nil, idx: nil, expected: nil, synthesis: nil, resampler: nil, encoder: nil)
        m.pcm = try put(pcm, "tape.pcm")
        m.idx = try put(idx, "tape.idx")
        m.expected = try put([UInt8](try pretty.encode(e)) + [0x0A], "expected.json")
        try (pretty.encode(m) + Data([0x0A])).write(to: dir.appendingPathComponent(FixtureLoader.manifestFile))
        return (["adopted \(dir.path) serving \(cases.map(\.rawValue))"] + report).joined(separator: "\n")
    }

    /// Recorded wall_ns and mono_ns of each region's checkpoints against the sample-clock model of that region.
    /// A region's records are exactly the lines from the record that opened it up to (not including) the record that
    /// opened the next region, so no record of a later region — e.g. the checkpoint that opens a session after a
    /// `restart`, which shares the boundary's sample — can leak in. Drift is measured from the region's anchor to its
    /// last checkpoint on the monotonic clock; the largest step between consecutive residuals shows jitter.
    static func clockReport(_ lines: [IndexLine], _ regions: [TapeRegion]) -> [String] {
        var out: [String] = []
        for (i, r) in regions.enumerated() {
            let nextOpen = i + 1 < regions.count ? regions[i + 1].openLine : Int.max
            let own = lines.filter { $0.number >= r.openLine && $0.number < nextOpen }
            guard let anchor = own.first(where: { $0.number == r.anchorLine }), let anchorMono = anchor.int(IndexKey.monoNS) else { continue }
            let checkpoints = own.filter { $0.fields[IndexKey.discontinuity] == nil && $0.number >= r.anchorLine }
            guard let last = checkpoints.last, let ls = last.int(IndexKey.samples), let lm = last.int(IndexKey.monoNS), ls > r.anchorSample else { continue }
            var maxDev: Int64 = 0, maxStep: Int64 = 0, prev: Int64? = nil
            for l in checkpoints {
                guard let s = l.int(IndexKey.samples), let w = l.int(IndexKey.wallNS) else { continue }
                let residual = w - TapeClock.wallNS(sample: s, anchorSample: r.anchorSample, anchorWallNS: r.anchorWallNS)
                maxDev = max(maxDev, abs(residual))
                if let p = prev { maxStep = max(maxStep, abs(residual - p)) }
                prev = residual
            }
            let modelSpan = (ls - r.anchorSample) * TapeFormat.nsPerSample
            let ppm = Double((lm - anchorMono) - modelSpan) / Double(modelSpan) * 1e6
            out.append("clock, region [\(r.start),\(r.end)) lines \(r.openLine)..<\(nextOpen == Int.max ? lines.count + 1 : nextOpen) anchored on line \(r.anchorLine) (\(r.openedBy ?? "tape start")): \(checkpoints.count) checkpoints, wall_ns vs sample clock max |deviation| \(String(format: "%.3f", Double(maxDev) / 1e6)) ms, largest step \(String(format: "%.3f", Double(maxStep) / 1e6)) ms, mono drift anchor→line \(last.number) \(String(format: "%+.1f", ppm)) ppm")
        }
        return out
    }
}
