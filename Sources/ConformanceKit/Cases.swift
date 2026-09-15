import Foundation
import TapeConvert

public enum Verdict: Equatable {
    case pass
    case fail([String])
    case skipped(String)
    /// The case could not be evaluated (bad fixture, missing expected answers). Never counts as PASS or FAIL.
    case error(String)

    public var label: String {
        switch self {
        case .pass: return "PASS"
        case .fail: return "FAIL"
        case .skipped: return "SKIPPED"
        case .error: return "ERROR"
        }
    }
}

/// Collects failed checks; a case passes only if at least one check ran and none failed.
struct Checks {
    private(set) var failures: [String] = []
    private(set) var count = 0

    mutating func expect(_ ok: Bool, _ message: @autoclosure () -> String) {
        count += 1
        if !ok { failures.append(message()) }
    }

    var verdict: Verdict {
        if count == 0 { return .error("no checks ran") }
        return failures.isEmpty ? .pass : .fail(failures)
    }
}

public enum Cases {
    public static func run(_ id: CaseID, _ f: Fixture) -> Verdict {
        switch id {
        case .C1: return c1(f)
        case .C2: return c2(f)
        case .C3: return c3(f)
        case .C4: return c4(f)
        case .C5: return c5(f)
        case .C6: return c6(f)
        case .C7: return c7(f)
        case .C8: return c8(f)
        case .C9: return .error("C9 is run by C9Harness, not per fixture")
        case .C10: return c10(f)
        }
    }

    static func scan(_ f: Fixture) -> Result<IndexScan, Error> {
        Result { try IndexLog.scan(f.idx) }
    }

    // MARK: C1 — geometry: byte_offset == samples × 2 for every index record

    static func c1(_ f: Fixture) -> Verdict {
        let s: IndexScan
        do { s = try IndexLog.scan(f.idx) } catch { return .error("tape.idx does not scan: \(error)") }
        var c = Checks()
        c.expect(!s.lines.isEmpty, "tape.idx has no complete records")
        c.expect(f.pcm.count % 2 == 0, "tape.pcm is \(f.pcm.count) bytes: not a whole number of s16 samples")
        var previous: (Int64, Int64)? = nil
        for line in s.lines {
            let hasOffset = line.fields[IndexKey.byteOffset] != nil, hasSamples = line.fields[IndexKey.samples] != nil
            c.expect(hasOffset == hasSamples, "line \(line.number): byte_offset and samples must be both present or both absent")
            guard hasOffset || hasSamples else { continue }
            guard let bo = line.int(IndexKey.byteOffset), let sa = line.int(IndexKey.samples) else {
                c.expect(false, "line \(line.number): byte_offset and samples must both be integers")
                continue
            }
            c.expect(bo == sa * TapeFormat.bytesPerSample, "line \(line.number): byte_offset \(bo) != samples \(sa) × 2")
            c.expect(bo >= 0 && sa >= 0, "line \(line.number): negative offset")
            c.expect(bo <= Int64(f.pcm.count), "line \(line.number): byte_offset \(bo) beyond tape.pcm end \(f.pcm.count)")
            if let (pb, ps) = previous {
                c.expect(bo >= pb && sa >= ps, "line \(line.number): byte_offset/samples went backwards (\(pb)/\(ps) → \(bo)/\(sa))")
            }
            previous = (bo, sa)
        }
        return c.verdict
    }

    // MARK: C2 — index byte fidelity: decode into the typed record, re-encode, compare byte for byte

    static func c2(_ f: Fixture) -> Verdict {
        var c = Checks()
        if f.manifest.encoderLine != nil {
            if let problem = c2EncoderLine(f, &c) { return .error(problem) }
        }
        guard f.manifest.idx != nil else { return c.verdict }
        let s: IndexScan
        do { s = try IndexLog.scan(f.idx) } catch { return .error("tape.idx does not scan: \(error)") }
        c.expect(!s.lines.isEmpty, "tape.idx has no complete records")
        for line in s.lines {
            let unknown = line.fields.keys.filter { !IndexKey.all.contains($0) }.sorted()
            c.expect(unknown.isEmpty, "line \(line.number): keys outside the schema: \(unknown)")
            let record: IndexRecord
            do { record = try IndexRecord.decode(line.bytes) } catch {
                c.expect(false, "line \(line.number): does not decode as an index record: \(error)")
                continue
            }
            for v in record.presenceViolations() { c.expect(false, "line \(line.number): \(v)") }
            do {
                let reencoded = try record.encodedLine()
                c.expect(reencoded == line.bytes,
                         "line \(line.number): re-encoded bytes differ\n        original:  \(String(decoding: line.bytes, as: UTF8.self))\n        reencoded: \(String(decoding: reencoded, as: UTF8.self))")
            } catch {
                c.expect(false, "line \(line.number): re-encode threw \(error)")
            }
        }
        return c.verdict
    }

    /// A line measured as another platform's JSONEncoder output: its Doubles must equal the stated source values
    /// bit for bit, and this platform's encoder, given those source values, must write the same bytes.
    static func c2EncoderLine(_ f: Fixture, _ c: inout Checks) -> String? {
        guard let e = f.expected.c2 else { return "expected.json has no C2 block for the encoder line" }
        guard e.outputFormatting == ["sortedKeys", "withoutEscapingSlashes"] else {
            return "encoder line was measured with \(e.outputFormatting), not the index encoder's formatting"
        }
        guard f.encoderLine.last == 0x0A, f.encoderLine.filter({ $0 == 0x0A }).count == 1 else {
            return "encoder line file must be one line terminated by 0x0A"
        }
        let line = Array(f.encoderLine.dropLast())
        var source: [String: Double] = [:]
        for (k, spec) in e.values {
            guard let v = C2EncoderLineExpected.source(spec) else { return "cannot evaluate source value \(k) = \(spec)" }
            source[k] = v
        }
        do {
            let decoded = try JSONDecoder().decode([String: Double].self, from: Data(line))
            c.expect(Set(decoded.keys) == Set(source.keys), "encoder line keys \(decoded.keys.sorted()) != source keys \(source.keys.sorted())")
            for (k, v) in source.sorted(by: { $0.key < $1.key }) {
                c.expect(decoded[k]?.bitPattern == v.bitPattern,
                         "encoder line \(k) decodes to \(decoded[k].map { "\($0)" } ?? "absent"), source \(e.values[k]!) is \(v)")
            }
        } catch {
            c.expect(false, "encoder line does not decode as String → Double: \(error)")
        }
        do {
            let ours = [UInt8](try IndexLineCodec.makeEncoder().encode(source))
            c.expect(ours == line,
                     "this platform's encoder output differs from the fixture line\n        fixture: \(String(decoding: line, as: UTF8.self))\n        ours:    \(String(decoding: ours, as: UTF8.self))")
        } catch {
            c.expect(false, "encoding the source values threw \(error)")
        }
        return nil
    }

    // MARK: C3 — recovery: torn trailing line truncates; interior blank line is a hard error

    static func c3(_ f: Fixture) -> Verdict {
        guard let e = f.expected.c3 else { return .error("expected.json has no C3 block") }
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("conformance-c3-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: dir) }
        let copy = dir.appendingPathComponent("tape.idx")
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data(f.idx).write(to: copy)
        } catch { return .error("cannot stage tape.idx: \(error)") }

        var c = Checks()
        let outcome: Result<IndexScanOutcome, Error> = Result { try IndexLog.repair(fileAt: copy) }
        let after = (try? [UInt8](Data(contentsOf: copy))) ?? []

        switch e.outcome {
        case "clean":
            if case .success(let o) = outcome {
                c.expect(o == .clean, "expected a clean log, repair reported \(o)")
            } else if case .failure(let err) = outcome {
                c.expect(false, "expected a clean log, repair threw: \(err)")
            }
            c.expect(after == f.idx, "repair of a clean log changed the file")
            if let n = e.records, case .success(let s) = scan(f) { c.expect(s.lines.count == n, "expected \(n) records, read \(s.lines.count)") }

        case "torn_tail":
            guard case .success(let o) = outcome else {
                if case .failure(let err) = outcome { c.expect(false, "expected torn-tail repair, repair threw: \(err)") }
                return c.verdict
            }
            guard case .tornTail(let length, let dropped) = o else {
                c.expect(false, "expected a torn tail, repair reported \(o)")
                return c.verdict
            }
            if let want = e.repairedLength { c.expect(length == want, "repaired length \(length) != expected \(want)") }
            if let want = e.droppedBytes { c.expect(dropped == want, "dropped \(dropped) bytes, expected \(want)") }
            c.expect(after.count == length, "file is \(after.count) bytes after repair, repair reported \(length)")
            c.expect(after == Array(f.idx.prefix(length)), "repaired file is not a prefix of the original")
            c.expect(after.last == 0x0A, "repaired file does not end in 0x0A")
            if let s = try? IndexLog.scan(after) {
                c.expect(s.outcome == .clean, "repaired file still scans as \(s.outcome)")
                if let n = e.records { c.expect(s.lines.count == n, "expected \(n) records after repair, read \(s.lines.count)") }
            } else {
                c.expect(false, "repaired file does not scan")
            }

        case "hard_error":
            switch outcome {
            case .success(let o):
                c.expect(false, "expected a hard error (\(e.error ?? "?")), repair reported \(o)")
            case .failure(let err):
                if e.error == "interior_blank_line" {
                    if case IndexLogError.interiorBlankLine(let n) = err {
                        if let want = e.line { c.expect(n == want, "blank line reported at \(n), expected \(want)") }
                        else { c.expect(true, "") }
                    } else {
                        c.expect(false, "expected interior_blank_line, got \(err)")
                    }
                } else {
                    return .error("unknown expected error \(e.error ?? "nil")")
                }
            }
            c.expect(after == f.idx, "a hard error must leave the log untouched")

        default:
            return .error("unknown C3 outcome \(e.outcome)")
        }
        return c.verdict
    }

    // MARK: C4 — clock: derived wall time for named samples matches to the nanosecond

    static func resolve(_ at: String, _ f: Fixture, _ s: IndexScan) -> Int64? {
        if at == "pcm_end" { return TapeClock.samples(bytesWritten: Int64(f.pcm.count)) }
        let parts = at.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2, let n = Int64(parts[1]) else { return nil }
        switch parts[0] {
        case "sample": return n
        case "record": return s.lines.first { $0.number == Int(n) }?.int(IndexKey.samples)
        default: return nil
        }
    }

    static func regions(_ f: Fixture, _ s: IndexScan) -> [TapeRegion] {
        TapeRegions.regions(s.lines, totalSamples: TapeClock.samples(bytesWritten: Int64(f.pcm.count)))
    }

    static func c4(_ f: Fixture) -> Verdict {
        guard let e = f.expected.c4 else { return .error("expected.json has no C4 block") }
        let s: IndexScan
        do { s = try IndexLog.scan(f.idx) } catch { return .error("tape.idx does not scan: \(error)") }
        let rs = regions(f, s)
        var c = Checks()
        c.expect(!e.points.isEmpty, "C4 names no sample points")
        c.expect(!rs.isEmpty, "no record opens a region: no clock anchor")
        for p in e.points {
            guard let sample = resolve(p.at, f, s) else {
                c.expect(false, "\(p.name): cannot resolve \(p.at)")
                continue
            }
            guard let r = TapeRegions.region(containing: sample, in: rs) else {
                c.expect(false, "\(p.name): sample \(sample) lies in no region of the tape")
                continue
            }
            let ns = TapeClock.wallNS(sample: sample, anchorSample: r.anchorSample, anchorWallNS: r.anchorWallNS)
            c.expect(ns == p.wallNS, "\(p.name) (\(p.at) = sample \(sample), anchored on line \(r.anchorLine)): wall_ns \(ns) != expected \(p.wallNS) (Δ \(ns - p.wallNS) ns)")
            // The Double formula must agree with the exact model within its own representable precision.
            let secs = TapeClock.wallSeconds(sample: sample, anchorSample: r.anchorSample, anchorWallNS: r.anchorWallNS)
            let tolNS = secs.ulp * 2e9
            c.expect(abs(secs * 1e9 - Double(p.wallNS)) <= tolNS,
                     "\(p.name): Double formula \(secs) s disagrees with \(p.wallNS) ns beyond 2 ulp (\(tolNS) ns)")
        }
        return c.verdict
    }

    // MARK: C5 — piece adjacency, the zero seam; pieces close at discontinuities

    static func c5(_ f: Fixture) -> Verdict {
        guard let pieces = f.expected.pieces else { return .error("expected.json has no pieces") }
        let s: IndexScan
        do { s = try IndexLog.scan(f.idx) } catch { return .error("tape.idx does not scan: \(error)") }
        let rs = regions(f, s)
        var c = Checks()
        let total = TapeClock.samples(bytesWritten: Int64(f.pcm.count))
        c.expect(pieces.count >= 2, "a seam needs at least two pieces, have \(pieces.count)")
        c.expect(pieces.first?.sampleStart == 0, "first piece starts at \(pieces.first?.sampleStart ?? -1), not 0")
        c.expect(pieces.last?.sampleEnd == total, "last piece ends at \(pieces.last?.sampleEnd ?? -1), tape ends at \(total)")
        for i in 0..<max(0, pieces.count - 1) {
            c.expect(pieces[i].sampleEnd == pieces[i + 1].sampleStart,
                     "seam \(i)/\(i + 1): piece[\(i)].sampleEnd \(pieces[i].sampleEnd) != piece[\(i + 1)].sampleStart \(pieces[i + 1].sampleStart)")
        }
        // Every discontinuity: no piece straddles it, and its gap lands on the piece that follows it. Several
        // discontinuities can share a sample (device_lost then resumed): the regions between them are empty, and the
        // following piece belongs to the LAST region starting there, so only that region's gap rule applies to it.
        let later = rs.dropFirst()
        for (k, r) in later.enumerated() {
            let d = r.start
            for p in pieces where p.sampleStart < d && d < p.sampleEnd {
                c.expect(false, "piece [\(p.sampleStart), \(p.sampleEnd)) straddles the \(r.openedBy ?? "?") discontinuity at sample \(d) (line \(r.anchorLine))")
            }
            let lastAtSample = !later.dropFirst(k + 1).contains { $0.start == d }
            if d < total, lastAtSample {
                let following = pieces.first { $0.sampleStart == d }
                c.expect(following != nil, "no piece starts at the \(r.openedBy ?? "?") discontinuity at sample \(d)")
                // Round half up at 500 000 ns, and only for the four gap-carrying causes.
                let want = DiscontinuityCause.gapMilliseconds(cause: r.openedBy, gapNS: r.gapBeforeNS)
                if let following {
                    c.expect((following.gapBeforeMS ?? 0) == want,
                             "gap_before_ms after the \(r.openedBy ?? "?") at \(d) (gap_ns \(r.gapBeforeNS.map(String.init) ?? "absent")) is \(following.gapBeforeMS.map(String.init) ?? "absent"), rule gives \(want)")
                }
            }
        }
        let gapStarts = Set(rs.dropFirst().filter { DiscontinuityCause.gapMilliseconds(cause: $0.openedBy, gapNS: $0.gapBeforeNS) > 0 }.map(\.start))
        for p in pieces where (p.gapBeforeMS ?? 0) != 0 && !gapStarts.contains(p.sampleStart) {
            c.expect(false, "piece [\(p.sampleStart), \(p.sampleEnd)) carries gap_before_ms \(p.gapBeforeMS!) but no gap-carrying discontinuity precedes it")
        }
        let planned = PiecePlanner.plan(rs)
        let normalised = pieces.map { PieceRange(sampleStart: $0.sampleStart, sampleEnd: $0.sampleEnd, gapBeforeMS: $0.gapBeforeMS == 0 ? nil : $0.gapBeforeMS) }
        c.expect(planned == normalised, "pieces differ from the plan of the index: \(planned.map { "[\($0.sampleStart),\($0.sampleEnd))\($0.gapBeforeMS.map { " gap \($0)ms" } ?? "")" })")
        // Consecutive pieces are adjacent byte ranges of one file: their bytes concatenate to the tape.
        var h = SHA256()
        for p in pieces {
            let lo = Int(max(0, min(p.sampleStart * 2, Int64(f.pcm.count))))
            let hi = Int(max(Int64(lo), min(p.sampleEnd * 2, Int64(f.pcm.count))))
            h.update(f.pcm[lo..<hi])
        }
        c.expect(SHA256.hexString(h.finalize()) == f.manifest.pcm?.sha256, "piece byte ranges do not concatenate to tape.pcm")
        return c.verdict
    }

    // MARK: C6 — piece length: a full piece is exactly 4 800 000 samples

    static func c6(_ f: Fixture) -> Verdict {
        guard let pieces = f.expected.pieces else { return .error("expected.json has no pieces") }
        guard let e = f.expected.c6 else { return .error("expected.json has no C6 block") }
        let s: IndexScan
        do { s = try IndexLog.scan(f.idx) } catch { return .error("tape.idx does not scan: \(error)") }
        let regionEnds = Set(regions(f, s).map(\.end))
        var c = Checks()
        c.expect(e.pieceSamples == TapeFormat.pieceSamples, "expected.json piece_samples \(e.pieceSamples) is not the format's \(TapeFormat.pieceSamples)")
        c.expect(!pieces.isEmpty, "no pieces")
        var full = 0
        var partials: [Int64] = []
        for (i, p) in pieces.enumerated() {
            if p.samples == TapeFormat.pieceSamples { full += 1; continue }
            // Only a region end (a discontinuity or the tape tail) may close a piece short.
            c.expect(regionEnds.contains(p.sampleEnd) && p.samples > 0 && p.samples < TapeFormat.pieceSamples,
                     "piece \(i) is \(p.samples) samples, a full piece is \(TapeFormat.pieceSamples), and it does not end at a discontinuity or the tape end")
            partials.append(p.samples)
        }
        c.expect(full == e.fullPieces, "\(full) full pieces, expected \(e.fullPieces)")
        c.expect(partials == e.partialPieces, "partial pieces \(partials), expected \(e.partialPieces)")
        c.expect(TapeFormat.pieceSamples * TapeFormat.nsPerSample == 300_000_000_000, "a full piece is not exactly 300.000 s")
        return c.verdict
    }

    // MARK: C7 — gap honesty: no zero fill, gap_ns and dropped_input_frames present and non-zero

    static func c7(_ f: Fixture) -> Verdict {
        guard let e = f.expected.c7 else { return .error("expected.json has no C7 block") }
        let s: IndexScan
        do { s = try IndexLog.scan(f.idx) } catch { return .error("tape.idx does not scan: \(error)") }
        guard let i = s.lines.firstIndex(where: { $0.number == e.line }) else { return .error("tape.idx has no line \(e.line)") }
        let d = s.lines[i]
        var c = Checks()

        let cause: String? = { if case .string(let v)? = d.fields[IndexKey.discontinuity] { return v }; return nil }()
        c.expect(cause == e.cause, "line \(e.line): discontinuity is \(cause ?? "absent"), expected \(e.cause)")
        let gap = d.int(IndexKey.gapNS)
        let dropped = d.int(IndexKey.droppedInputFrames)
        c.expect(gap != nil, "line \(e.line): gap_ns absent")
        c.expect(dropped != nil, "line \(e.line): dropped_input_frames absent")
        c.expect((gap ?? 0) > 0, "line \(e.line): gap_ns is \(gap.map(String.init) ?? "absent"), must be non-zero")
        c.expect((dropped ?? 0) > 0, "line \(e.line): dropped_input_frames is \(dropped.map(String.init) ?? "absent"), must be non-zero")
        c.expect(gap == e.gapNS, "line \(e.line): gap_ns \(gap.map(String.init) ?? "absent") != expected \(e.gapNS)")
        c.expect(dropped == e.droppedInputFrames, "line \(e.line): dropped_input_frames \(dropped.map(String.init) ?? "absent") != expected \(e.droppedInputFrames)")

        // The discontinuity is metadata-only: it sits exactly where the real pre-gap audio ends.
        let offset = d.int(IndexKey.byteOffset) ?? -1
        c.expect(offset == e.preGapSamples * 2, "discontinuity byte_offset \(offset) != pre-gap audio \(e.preGapSamples) × 2")
        // No zero fill: the tape holds exactly the real audio, not a sample more.
        let real = (e.preGapSamples + e.postGapSamples) * 2
        c.expect(Int64(f.pcm.count) == real,
                 "tape.pcm is \(f.pcm.count) bytes, real audio is \(real): \(Int64(f.pcm.count) - real) bytes (\((Int64(f.pcm.count) - real) / 2) samples) inserted across the gap")
        // The bytes after the discontinuity are real post-gap audio, not a run of zeros. §11.5: the probe skips the first
        // rampOutputSamples (40) after the boundary, where the reset filter's near-zero output is correct behaviour.
        let probe = C7ZeroProbe.run(pcm: f.pcm, byteOffset: offset, gapNS: e.gapNS, exemptSamples: C7ZeroProbe.exemptSamples)
        if probe.inRange {
            c.expect(!probe.zeroFill, "tape.pcm holds a run of ≥\(probe.length) zero samples starting \(probe.exempt) samples after the discontinuity offset \(offset): zero fill")
        } else {
            c.expect(offset < 0 || e.gapNS < TapeFormat.nsPerSample || Int(offset) == f.pcm.count, "discontinuity offset \(offset) outside tape.pcm")
        }
        // Records after the gap continue from the same byte count.
        if i + 1 < s.lines.count, let next = s.lines[i + 1].int(IndexKey.byteOffset) {
            c.expect(next >= offset && next - offset <= e.postGapSamples * 2,
                     "record after the gap at byte_offset \(next) is not within the post-gap audio (\(offset)…\(offset + e.postGapSamples * 2))")
        }
        return c.verdict
    }

    // MARK: C8 — day rollover: a day_rollover discontinuity at the computed sample, straddling sample in the old day

    static func c8(_ f: Fixture) -> Verdict {
        guard let e = f.expected.c8 else { return .error("expected.json has no C8 block") }
        let s: IndexScan
        do { s = try IndexLog.scan(f.idx) } catch { return .error("tape.idx does not scan: \(error)") }
        let rs = regions(f, s)
        var c = Checks()
        let total = TapeClock.samples(bytesWritten: Int64(f.pcm.count))
        let markers = rs.indices.dropFirst().filter { rs[$0].openedBy == DiscontinuityCause.dayRollover }
        c.expect(markers.count == 1, "expected exactly one day_rollover record, found \(markers.count)")
        for m in markers {
            let marker = rs[m], before = rs[m - 1]
            let line = s.lines.first { $0.number == marker.anchorLine }
            if let line {
                for k in [IndexKey.gapNS, IndexKey.rms, IndexKey.peak, IndexKey.zeroRatio] where line.fields[k] != nil {
                    c.expect(false, "day_rollover record (line \(line.number)) carries \(k)")
                }
            }
            // The anchor is the region the marker closes.
            let (boundary, sample) = DayRollover.rolloverSample(anchorSample: before.anchorSample, anchorWallNS: before.anchorWallNS)
            c.expect(boundary == e.boundaryWallNS, "IST midnight computed at \(boundary) ns, expected \(e.boundaryWallNS)")
            c.expect(boundary % TapeFormat.istDayNS == (TapeFormat.istDayNS - TapeFormat.istOffsetNS) % TapeFormat.istDayNS,
                     "boundary \(boundary) is not an IST midnight")
            c.expect(marker.start == sample, "day_rollover record at sample \(marker.start), computed \(sample) (anchored on line \(before.anchorLine))")
            c.expect(sample == e.rolloverSample, "day_rollover computed at sample \(sample), expected \(e.rolloverSample)")
            c.expect(marker.start > 0 && marker.start < total, "day_rollover sample \(marker.start) is not inside the \(total)-sample tape")
            let wallAt = { (n: Int64) in TapeClock.wallNS(sample: n, anchorSample: before.anchorSample, anchorWallNS: before.anchorWallNS) }
            let last = marker.start - 1
            c.expect(wallAt(last) < boundary && boundary <= wallAt(marker.start),
                     "the last old-day sample \(last) spans [\(wallAt(last)), \(wallAt(marker.start))), which does not end at or after midnight \(boundary)")
            let straddles = wallAt(last) < boundary && boundary < wallAt(marker.start)
            c.expect(straddles == e.straddling, "fixture says straddling=\(e.straddling), measured \(straddles)")
        }
        return c.verdict
    }

    // MARK: C10 — exactly two assertions: the argv byte for byte, and decoded audio within tolerance.
    // Encoded bytes are never asserted on: Opus output drifts across ffmpeg and libopus versions.

    static func c10(_ f: Fixture) -> Verdict {
        guard let e = f.manifest.encoder else { return .error("manifest.json has no encoder block") }
        var c = Checks()

        // Assertion 1: the arguments, byte for byte.
        let argv = PieceEncoder.arguments(input: PieceEncoder.inputPlaceholder, output: PieceEncoder.outputPlaceholder)
        c.expect(argv.map { Array($0.utf8) } == e.argv.map { Array($0.utf8) },
                 "encoder arguments differ from pinned\n        pinned: \(e.argv)\n        built:  \(argv)")

        // Assertion 2: the decoded audio, within the manifest's stated tolerance.
        let env: EncoderEnvironment
        switch EncoderEnvironment.detect() {
        case .success(let v): env = v
        case .failure(let err):
            c.expect(false, "decoded audio: cannot establish the encoder: \(err)")
            return c.verdict
        }
        let pair = "\(env.ffmpegVersion) / \(env.libopusVersion)"
        let known = (env.ffmpegVersion == e.ffmpegVersion && env.libopusVersion == e.libopusVersion) ? "the reference pair"
            : e.alsoVerified.contains { $0.ffmpegVersion == env.ffmpegVersion && $0.libopusVersion == env.libopusVersion }
                ? "an attested pair" : "NOT a recorded pair (informational; C10 does not assert on versions)"
        C10Measurement.environment = "running \(pair) on \(env.host): \(known)"
        switch C10Probe.measure(pcm: f.pcm, env: env, maxLag: e.tolerance.maxLagSamples) {
        case .failure(let err):
            c.expect(false, "decoded audio: \(err)")
        case .success(let m):
            C10Measurement.last = m.summary
            let v = m.violations(e.tolerance)
            c.expect(v.isEmpty, "decoded audio outside tolerance: " + v.joined(separator: "; "))
        }
        return c.verdict
    }
}

public struct C10ProbeError: Error, CustomStringConvertible {
    public let description: String
}

public enum C10Probe {
    /// Encodes `pcm` with the pinned arguments using `env`'s ffmpeg, decodes it back, and measures.
    public static func measure(pcm: [UInt8], env: EncoderEnvironment, maxLag: Int) -> Result<C10Measured, C10ProbeError> {
        guard env.libopusCompiledIn else {
            return .failure(.init(description: "libopus is not compiled into \(env.ffmpegPath) (ffmpeg -encoders: \(env.opusEncoders))"))
        }
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("conformance-c10-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: dir) }
        // As PiecePipeline: the input is a real temp file holding exactly the piece's byte range.
        let input = dir.appendingPathComponent(".piece-\(UUID().uuidString).pcm.tmp")
        let output = dir.appendingPathComponent("piece-\(UUID().uuidString).webm")
        let decoded = dir.appendingPathComponent("decoded.pcm")
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data(pcm).write(to: input)
        } catch { return .failure(.init(description: "cannot stage PCM: \(error)")) }

        let enc = Tools.run(env.ffmpegPath, PieceEncoder.arguments(input: input.path, output: output.path),
                            log: dir.appendingPathComponent("encode.log"))
        guard enc == 0 else {
            return .failure(.init(description: "ffmpeg encode exited \(enc): \(Tools.tail(dir.appendingPathComponent("encode.log")))"))
        }
        let dec = Tools.run(env.ffmpegPath, ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", output.path,
                                             "-f", "s16le", "-ar", "16000", "-ac", "1", decoded.path],
                            log: dir.appendingPathComponent("decode.log"))
        guard dec == 0, let out = try? [UInt8](Data(contentsOf: decoded)) else {
            return .failure(.init(description: "ffmpeg decode exited \(dec): \(Tools.tail(dir.appendingPathComponent("decode.log")))"))
        }
        let a = Audio.samples(pcm)
        let b = Audio.samples(out)
        let (lag, corr) = Audio.bestCorrelation(a, b, maxLag: maxLag)
        let db = 20 * log10(max(Audio.rms(b), 1e-9) / max(Audio.rms(a), 1e-9))
        return .success(C10Measured(inputSamples: a.count, decodedSamples: b.count, bestLagSamples: lag, correlation: corr, rmsDeltaDB: db))
    }
}

/// C7's zero-fill probe (U1 spec §11.5). A run of min(gap samples, 16) exact zero samples is zero fill, looked for
/// starting `exemptSamples` after the discontinuity: the first 40 samples after any boundary are the decimation
/// filter's ramp-up from a zeroed history (§11.4), where near-zero output is correct.
public enum C7ZeroProbe {
    public static let exemptSamples = DecimationRule.production.rampOutputSamples
    public static let threshold = 16

    public struct Result: Sendable { public var inRange: Bool; public var exempt: Int; public var length: Int; public var zeroRun: Int; public var zeroFill: Bool }

    public static func run(pcm: [UInt8], byteOffset: Int64, gapNS: Int64, exemptSamples: Int) -> Result {
        let length = Int(min(gapNS / TapeFormat.nsPerSample, Int64(threshold)))
        let start = Int(byteOffset) + exemptSamples * 2
        guard byteOffset >= 0, length > 0, start + length * 2 <= pcm.count else {
            return Result(inRange: false, exempt: exemptSamples, length: length, zeroRun: 0, zeroFill: false)
        }
        var run = 0
        while run < length, pcm[start + run * 2] == 0, pcm[start + run * 2 + 1] == 0 { run += 1 }
        return Result(inRange: true, exempt: exemptSamples, length: length, zeroRun: run, zeroFill: run >= length)
    }
}

/// The last C10 measurement, for the report.
public enum C10Measurement {
    nonisolated(unsafe) public static var last: String?
    nonisolated(unsafe) public static var environment: String?
}

enum Audio {
    static func samples(_ bytes: [UInt8]) -> [Int16] {
        var out = [Int16](repeating: 0, count: bytes.count / 2)
        for i in 0..<out.count { out[i] = Int16(bitPattern: UInt16(bytes[2 * i]) | UInt16(bytes[2 * i + 1]) << 8) }
        return out
    }

    static func rms(_ x: [Int16]) -> Double {
        guard !x.isEmpty else { return 0 }
        var s = 0.0
        for v in x { s += Double(v) * Double(v) }
        return (s / Double(x.count)).squareRoot()
    }

    /// Normalised cross-correlation of b against a over lags in [−maxLag, maxLag]; b[i + lag] ≈ a[i].
    static func bestCorrelation(_ a: [Int16], _ b: [Int16], maxLag: Int) -> (Int, Double) {
        var best = (0, -2.0)
        for lag in -maxLag...maxLag {
            var sab = 0.0, saa = 0.0, sbb = 0.0
            let lo = max(0, -lag), hi = min(a.count, b.count - lag)
            if hi <= lo { continue }
            for i in lo..<hi {
                let x = Double(a[i]), y = Double(b[i + lag])
                sab += x * y; saa += x * x; sbb += y * y
            }
            let r = (saa > 0 && sbb > 0) ? sab / (saa * sbb).squareRoot() : 0
            if r > best.1 { best = (lag, r) }
        }
        return best
    }
}

enum Tools {
    static func which(_ name: String) -> String? {
        let path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"
        for dir in path.split(separator: ":") {
            let p = "\(dir)/\(name)"
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }

    static func run(_ exe: String, _ args: [String], log: URL) -> Int32 {
        _ = FileManager.default.createFile(atPath: log.path, contents: nil)
        guard let h = try? FileHandle(forWritingTo: log) else { return -1 }
        defer { try? h.close() }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = h
        p.standardError = h
        do { try p.run() } catch { return -1 }
        p.waitUntilExit()
        return p.terminationStatus
    }

    /// Runs a tool and returns its combined stdout and stderr, or nil if it could not run or exited non-zero.
    static func output(_ exe: String, _ args: [String]) -> String? {
        let log = FileManager.default.temporaryDirectory.appendingPathComponent("conformance-tool-\(UUID().uuidString).log")
        defer { try? FileManager.default.removeItem(at: log) }
        guard run(exe, args, log: log) == 0 else { return nil }
        return try? String(contentsOf: log, encoding: .utf8)
    }

    static func tail(_ log: URL) -> String {
        let s = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
        return s.split(separator: "\n").suffix(3).joined(separator: " | ")
    }
}
