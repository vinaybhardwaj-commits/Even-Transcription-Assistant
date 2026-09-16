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

/// Collects failed checks; a case passes only if at least one check ran and none failed. Every assertion belongs to a
/// named check (`law`), whose grounding spec/check-grounding.json states; an assertion made under no name is counted
/// as UNLABELLED, which the suite reports as ungrounded.
struct Checks {
    private(set) var failures: [String] = []
    private(set) var count = 0
    private var current = "UNLABELLED"

    mutating func law(_ id: String) { current = id }

    mutating func expect(_ ok: Bool, _ message: @autoclosure () -> String) {
        count += 1
        CheckRegistry.record(current)
        if !ok { failures.append("[\(current)] " + message()) }
    }

    var verdict: Verdict {
        if count == 0 { return .error("no checks ran") }
        return failures.isEmpty ? .pass : .fail(failures)
    }
}

/// Which named checks made assertions in this process, and how many.
public enum CheckRegistry {
    nonisolated(unsafe) private static var ran: [String: Int] = [:]
    static func record(_ id: String) { ran[id, default: 0] += 1 }
    public static func reset() { ran = [:] }
    public static var snapshot: [String: Int] { ran }
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
        c.law("C1.geometry")
        c.expect(!s.lines.isEmpty, "tape.idx has no complete records")
        c.law("C1.pcm-whole-samples")
        c.expect(f.pcm.count % 2 == 0, "tape.pcm is \(f.pcm.count) bytes: not a whole number of s16 samples")
        var previous: (Int64, Int64)? = nil
        for line in s.lines {
            let hasOffset = line.fields[IndexKey.byteOffset] != nil, hasSamples = line.fields[IndexKey.samples] != nil
            c.law("C1.geometry")
            c.expect(hasOffset == hasSamples, "line \(line.number): byte_offset and samples must be both present or both absent")
            guard hasOffset || hasSamples else { continue }
            guard let bo = line.int(IndexKey.byteOffset), let sa = line.int(IndexKey.samples) else {
                c.expect(false, "line \(line.number): byte_offset and samples must both be integers")
                continue
            }
            c.expect(bo == sa * TapeFormat.bytesPerSample, "line \(line.number): byte_offset \(bo) != samples \(sa) × 2")
            c.expect(bo >= 0 && sa >= 0, "line \(line.number): negative offset")
            c.law("C1.within-pcm")
            c.expect(bo <= Int64(f.pcm.count), "line \(line.number): byte_offset \(bo) beyond tape.pcm end \(f.pcm.count)")
            if let (pb, ps) = previous {
                c.law("C1.monotonic")
                c.expect(bo >= pb && sa >= ps, "line \(line.number): byte_offset/samples went backwards (\(pb)/\(ps) → \(bo)/\(sa))")
            }
            previous = (bo, sa)
        }
        // A clean stop is the tape's last write (TapeWriter.swift:366-384: the stopped record carries byteOffset:
        // bytesWritten after fullSyncTape(.stopped)). The final stopped record sits at tape.pcm's length exactly; the
        // `stopped` record opens a zero-length region. A stopped record that is not the last line (a tape restarted after
        // a clean stop) is followed by the restart record at the same byte_offset (:305-315: byte_offset = tape.pcm
        // length at open) with nothing surviving past it.
        c.law("C1.stopped-at-pcm-end")
        for (i, line) in s.lines.enumerated() {
            guard case .string(DiscontinuityCause.stopped)? = line.fields[IndexKey.discontinuity], let bo = line.int(IndexKey.byteOffset) else { continue }
            if i == s.lines.count - 1 {
                c.expect(bo == Int64(f.pcm.count), "line \(line.number): the final stopped record's byte_offset \(bo) != tape.pcm length \(f.pcm.count): \(Int64(f.pcm.count) - bo) bytes written after the clean stop")
            } else {
                let next = s.lines[i + 1]
                let isRestart: Bool = { if case .string(DiscontinuityCause.restart)? = next.fields[IndexKey.discontinuity] { return true }; return false }()
                c.expect(isRestart && next.int(IndexKey.byteOffset) == bo && next.int(IndexKey.survivingTailBytes) == 0,
                         "line \(line.number): a stopped record that is not the last line must be followed by a restart at byte_offset \(bo) with surviving_tail_bytes 0")
            }
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
        c.law("C2.schema-keys")
        c.expect(!s.lines.isEmpty, "tape.idx has no complete records")
        for line in s.lines {
            let unknown = line.fields.keys.filter { !IndexKey.all.contains($0) }.sorted()
            c.law("C2.schema-keys")
            c.expect(unknown.isEmpty, "line \(line.number): keys outside the schema: \(unknown)")
            let record: IndexRecord
            do { record = try IndexRecord.decode(line.bytes) } catch {
                c.law("C2.presence")
                c.expect(false, "line \(line.number): does not decode as an index record: \(error)")
                continue
            }
            c.law("C2.presence")
            for v in record.presenceViolations() { c.expect(false, "line \(line.number): \(v)") }
            do {
                let reencoded = try record.encodedLine()
                c.law("C2.reencode")
                c.expect(reencoded == line.bytes,
                         "line \(line.number): re-encoded bytes differ\n        original:  \(String(decoding: line.bytes, as: UTF8.self))\n        reencoded: \(String(decoding: reencoded, as: UTF8.self))")
            } catch {
                c.law("C2.reencode")
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
            c.law("C2.darwin-encoder-line")
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

        // The reader (IndexLog.scan) and the writer's open path (IndexLog.repair) are separate behaviours on the Mac and are
        // asserted separately: TapeFormat.swift:135-154 excludes a torn tail from every parse; only repairTrailingPartial,
        // which TapeWriter.swift:137 passes, truncates it on disk.
        var c = Checks()
        let read: Result<IndexScan, Error> = Result { try IndexLog.scan(f.idx) }
        let repaired: Result<IndexRepair, Error> = Result { try IndexLog.repair(fileAt: copy) }
        let outcome = repaired.map(\.outcome)
        let after = (try? [UInt8](Data(contentsOf: copy))) ?? []

        switch e.outcome {
        case "clean":
            c.law("C3.clean-unchanged")
            if case .success(let o) = outcome {
                c.expect(o == .clean, "expected a clean log, repair reported \(o)")
            } else if case .failure(let err) = outcome {
                c.expect(false, "expected a clean log, repair threw: \(err)")
            }
            if case .success(let r) = repaired {
                c.expect(!r.openedForWriting, "a clean log must never be opened for writing")
            }
            c.expect(after == f.idx, "repair of a clean log changed the file")
            if let n = e.records, case .success(let s) = read { c.expect(s.lines.count == n, "expected \(n) records, read \(s.lines.count)") }

        case "torn_tail":
            // The reader: the partial line is excluded, the file is not touched, and no error is raised.
            c.law("C3.torn-tail-excluded-by-the-reader")
            switch read {
            case .failure(let err):
                c.expect(false, "the reader must exclude a torn tail, not fail: \(err)")
            case .success(let s):
                guard case .tornTail(let length, let dropped) = s.outcome else {
                    c.expect(false, "the reader reported \(s.outcome), not a torn tail")
                    break
                }
                if let want = e.repairedLength { c.expect(length == want, "the reader puts the last complete line at \(length), expected \(want)") }
                if let want = e.droppedBytes { c.expect(dropped == want, "the reader excludes \(dropped) bytes, expected \(want)") }
                if let n = e.records { c.expect(s.lines.count == n, "the reader returned \(s.lines.count) complete records, expected \(n)") }
            }
            // The writer's open path: it truncates, and only then.
            c.law("C3.torn-tail-repaired-by-the-writer")
            guard case .success(let r) = repaired, case .tornTail(let length, let dropped) = r.outcome else {
                if case .failure(let err) = repaired { c.expect(false, "expected torn-tail repair, repair threw: \(err)") }
                else { c.expect(false, "expected a torn tail, repair reported \(outcome)") }
                return c.verdict
            }
            c.expect(r.openedForWriting, "a torn tail must be truncated on disk (the file was never opened for writing)")
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
            // An interior blank line fails the WHOLE read (TapeFormat.swift:170-175), not just the repair, and nothing on
            // disk is touched.
            c.law("C3.interior-blank")
            if e.error == "interior_blank_line" {
                switch read {
                case .success(let s):
                    c.expect(false, "the read must fail on an interior blank line; it returned \(s.lines.count) records and \(s.outcome)")
                case .failure(let err):
                    if case IndexLogError.interiorBlankLine(let n) = err {
                        if let want = e.line { c.expect(n == want, "the read reported the blank line at \(n), expected \(want)") }
                        else { c.expect(true, "") }
                    } else {
                        c.expect(false, "expected interior_blank_line from the read, got \(err)")
                    }
                }
            } else {
                return .error("unknown expected error \(e.error ?? "nil")")
            }
            switch outcome {
            case .success(let o):
                c.expect(false, "expected a hard error (\(e.error ?? "?")), repair reported \(o)")
            case .failure(let err):
                if case IndexLogError.interiorBlankLine = err { c.expect(true, "") }
                else { c.expect(false, "expected interior_blank_line, got \(err)") }
            }
            if case .success(let r) = repaired { c.expect(!r.openedForWriting, "a hard error must not open the log for writing") }
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
        c.law("C4.clock")
        c.expect(!e.points.isEmpty, "C4 names no sample points")
        c.expect(!rs.isEmpty, "no record opens a region: no clock anchor")
        for p in e.points {
            c.law("C4.clock")
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
            c.law("C4.double-formula")
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
        c.law("C5.adjacency")
        c.expect(pieces.count >= 2, "a seam needs at least two pieces, have \(pieces.count)")
        c.expect(pieces.first?.sampleStart == 0, "first piece starts at \(pieces.first?.sampleStart ?? -1), not 0")
        c.expect(pieces.last?.sampleEnd == total, "last piece ends at \(pieces.last?.sampleEnd ?? -1), tape ends at \(total)")
        for i in 0..<max(0, pieces.count - 1) {
            c.expect(pieces[i].sampleEnd == pieces[i + 1].sampleStart,
                     "seam \(i)/\(i + 1): piece[\(i)].sampleEnd \(pieces[i].sampleEnd) != piece[\(i + 1)].sampleStart \(pieces[i + 1].sampleStart)")
        }
        // Every discontinuity: no piece straddles it, and its gap lands on the piece that follows it. Several
        // discontinuities can share a sample (device_lost then resumed): PiecePipeline.swift:277-307 appends no region for
        // the zero-length gap, so the following piece carries the MAXIMUM of their gaps while the region's anchor is the
        // LAST one's wall_ns.
        for r in rs.dropFirst() {
            let d = r.start
            c.law("C5.no-straddle")
            for p in pieces where p.sampleStart < d && d < p.sampleEnd {
                c.expect(false, "piece [\(p.sampleStart), \(p.sampleEnd)) straddles the \(r.openedBy ?? "?") discontinuity at sample \(d) (line \(r.anchorLine))")
            }
            c.law(r.coincidentDiscontinuities > 1 ? "C5.gap-max-at-sample" : "C5.gap-after-discontinuity")
            if d < total {
                let following = pieces.first { $0.sampleStart == d }
                c.expect(following != nil, "no piece starts at the \(r.openedBy ?? "?") discontinuity at sample \(d)")
                if let following {
                    c.expect((following.gapBeforeMS ?? 0) == r.gapBeforeMS,
                             "gap_before_ms after the \(r.coincidentDiscontinuities) discontinuity record(s) at \(d) (last: \(r.openedBy ?? "?")) is \(following.gapBeforeMS.map(String.init) ?? "absent"), the rule gives \(r.gapBeforeMS)")
                }
            }
        }
        let gapStarts = Set(rs.dropFirst().filter { $0.gapBeforeMS > 0 }.map(\.start))
        for p in pieces where (p.gapBeforeMS ?? 0) != 0 && !gapStarts.contains(p.sampleStart) {
            c.expect(false, "piece [\(p.sampleStart), \(p.sampleEnd)) carries gap_before_ms \(p.gapBeforeMS!) but no gap-carrying discontinuity precedes it")
        }
        c.law("C5.plan")
        let planned = PiecePlanner.plan(rs)
        let normalised = pieces.map { PieceRange(sampleStart: $0.sampleStart, sampleEnd: $0.sampleEnd, gapBeforeMS: $0.gapBeforeMS == 0 ? nil : $0.gapBeforeMS) }
        c.expect(planned == normalised, "pieces differ from the plan of the index: \(planned.map { "[\($0.sampleStart),\($0.sampleEnd))\($0.gapBeforeMS.map { " gap \($0)ms" } ?? "")" })")
        c.law("C5.byte-ranges-concatenate")
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
        c.law("C6.full-piece")
        c.expect(e.pieceSamples == TapeFormat.pieceSamples, "expected.json piece_samples \(e.pieceSamples) is not the format's \(TapeFormat.pieceSamples)")
        c.expect(!pieces.isEmpty, "no pieces")
        var full = 0
        var partials: [Int64] = []
        for (i, p) in pieces.enumerated() {
            if p.samples == TapeFormat.pieceSamples { full += 1; continue }
            // Only a region end (a discontinuity or the tape tail) may close a piece short.
            c.law("C6.partial-only-at-region-end")
            c.expect(regionEnds.contains(p.sampleEnd) && p.samples > 0 && p.samples < TapeFormat.pieceSamples,
                     "piece \(i) is \(p.samples) samples, a full piece is \(TapeFormat.pieceSamples), and it does not end at a discontinuity or the tape end")
            partials.append(p.samples)
        }
        c.law("C6.full-piece")
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
        c.law("C7.boundary")
        c.expect(cause == e.cause, "line \(e.line): discontinuity is \(cause ?? "absent"), expected \(e.cause)")
        let gap = d.int(IndexKey.gapNS)
        let dropped = d.int(IndexKey.droppedInputFrames)
        let probeLength: Int
        if let wantGap = e.gapNS, let wantDropped = e.droppedInputFrames {
            c.law("C7.gap-fields")
            c.expect(gap != nil, "line \(e.line): gap_ns absent")
            c.expect(dropped != nil, "line \(e.line): dropped_input_frames absent")
            c.expect((gap ?? 0) > 0, "line \(e.line): gap_ns is \(gap.map(String.init) ?? "absent"), must be non-zero")
            c.expect((dropped ?? 0) > 0, "line \(e.line): dropped_input_frames is \(dropped.map(String.init) ?? "absent"), must be non-zero")
            c.expect(gap == wantGap, "line \(e.line): gap_ns \(gap.map(String.init) ?? "absent") != expected \(wantGap)")
            c.expect(dropped == wantDropped, "line \(e.line): dropped_input_frames \(dropped.map(String.init) ?? "absent") != expected \(wantDropped)")
            probeLength = C7ZeroProbe.length(gapNS: wantGap)
        } else {
            c.law("C7.gapless-day-rollover")
            // A boundary with no gap (day_rollover): nothing was lost, so there is nothing to count and nothing to fill.
            c.expect(e.gapNS == nil && e.droppedInputFrames == nil, "expected.json gives only one of gap_ns and dropped_input_frames")
            c.expect(cause == DiscontinuityCause.dayRollover, "a gapless C7 boundary must be a day_rollover, line \(e.line) is \(cause ?? "absent")")
            c.expect(gap == nil, "line \(e.line): a gapless boundary carries gap_ns \(gap.map(String.init) ?? "")")
            c.expect(dropped == nil, "line \(e.line): a gapless boundary carries dropped_input_frames \(dropped.map(String.init) ?? "")")
            probeLength = C7ZeroProbe.threshold
        }

        // discontinuity() writes no PCM of its own, but its first statement flushes the resampler
        // (TapeWriter.swift:268 → :261-264 → writeConverted :245-259, whose writeAll at :252 appends to tape.pcm), and the
        // record's byteOffset: bytesWritten is taken AFTER that flush. So the boundary sits exactly at the end of the audio
        // the tape holds at that moment; nothing is inserted for the gap itself.
        c.law("C7.no-zero-fill")
        let offset = d.int(IndexKey.byteOffset) ?? -1
        c.expect(offset == e.preGapSamples * 2, "discontinuity byte_offset \(offset) != pre-gap audio \(e.preGapSamples) × 2")
        // No zero fill: the tape holds exactly the real audio, not a sample more.
        let real = (e.preGapSamples + e.postGapSamples) * 2
        c.expect(Int64(f.pcm.count) == real,
                 "tape.pcm is \(f.pcm.count) bytes, real audio is \(real): \(Int64(f.pcm.count) - real) bytes (\((Int64(f.pcm.count) - real) / 2) samples) inserted across the gap")
        // The bytes after the discontinuity are real post-gap audio, not a run of zeros. §11.5: the probe skips the first
        // rampOutputSamples (40) after the boundary, where the reset filter's near-zero output is correct behaviour.
        c.law("C7.zero-run-probe")
        let probe = C7ZeroProbe.run(pcm: f.pcm, byteOffset: offset, length: probeLength, exemptSamples: C7ZeroProbe.exemptSamples)
        if probe.inRange {
            c.expect(!probe.zeroFill, "tape.pcm holds a run of ≥\(probe.length) zero samples starting \(probe.exempt) samples after the discontinuity offset \(offset): zero fill")
        } else {
            c.expect(offset < 0 || probeLength == 0 || Int(offset) == f.pcm.count, "discontinuity offset \(offset) outside tape.pcm")
        }
        // What our converter contributes to that flush: nothing. U1 spec §11.4 resets it at every discontinuity, and an
        // incomplete group of input frames produces no output, so the closing region holds exactly
        // outputCount(frames consumed in it) = floor(frames / 3) samples. If the Mac's resampler emits a final partial sample
        // where ours drops it, every discontinuity's byte_offset differs by one sample, and this is the check that shows it.
        // Only at 48 kHz: the conversion is specified for a 48 kHz input (spec/CONVERSION-48K-TO-16K-MONO.md), and a
        // fixture may describe a device at another rate.
        c.law("C7.boundary-after-flush")
        let closingRegions = regions(f, s)
        if d.double(IndexKey.inputSampleRate) == 48_000,
           let closing = closingRegions.last(where: { $0.end == e.preGapSamples && $0.openLine <= d.number }),
           let anchor = s.lines.first(where: { $0.number == closing.anchorLine }),
           let f0 = anchor.int(IndexKey.inputFrames), let f1 = d.int(IndexKey.inputFrames) {
            let want = Int64(DecimationRule.production.outputCount(frames: Int(f1 - f0)))
            c.expect(e.preGapSamples - closing.start == want,
                     "the region closed at line \(d.number) holds \(e.preGapSamples - closing.start) samples from \(f1 - f0) input frames (lines \(anchor.number)→\(d.number)); the converter gives \(want), so the boundary byte_offset should be \((closing.start + want) * 2)")
        }
        c.law("C7.no-zero-fill")
        // Records after the gap continue from the same byte count.
        if i + 1 < s.lines.count, let next = s.lines[i + 1].int(IndexKey.byteOffset) {
            c.expect(next >= offset && next - offset <= e.postGapSamples * 2,
                     "record after the gap at byte_offset \(next) is not within the post-gap audio (\(offset)…\(offset + e.postGapSamples * 2))")
        }
        return c.verdict
    }

    // MARK: C8 — day rollover (U1 step 5, Mac grounding of 15 Sep read off f798edf)
    //
    // The Mac decides the boundary on the WALL clock of each capture buffer (CaptureTimeline.swift:141), splits the buffer
    // at frameOffset = ceil(elapsed × input rate / 1e9) input frames (:146-149), publishes prefix audio, a marker whose
    // wall_ns IS the target midnight, then suffix audio, and re-arms at target + 86 400 000 000 000 ns (:122-131). The first
    // target of a capture session comes from Asia/Kolkata (ArchiveMidnightFoundation.swift:10-11). The marker is written by
    // the generic discontinuity() (TapeWriter.swift:267-296) and resets the converter, so the old day holds exactly the
    // output of its input frames: floor(frames / 3). Every law below is read off the tape's own records, so it holds on a
    // real tape as well as a synthetic one.

    static func c8(_ f: Fixture) -> Verdict {
        guard let e = f.expected.c8 else { return .error("expected.json has no C8 block") }
        let s: IndexScan
        do { s = try IndexLog.scan(f.idx) } catch { return .error("tape.idx does not scan: \(error)") }
        let lines = s.lines
        let rs = regions(f, s)
        var c = Checks()
        func cause(_ l: IndexLine) -> String? { if case .string(let v)? = l.fields[IndexKey.discontinuity] { return v }; return nil }
        func isCheckpoint(_ l: IndexLine) -> Bool { l.fields[IndexKey.discontinuity] == nil }
        let markers = lines.indices.filter { cause(lines[$0]) == DiscontinuityCause.dayRollover }
        c.law("C8.pins")
        c.expect(markers.count == e.rollovers.count, "tape.idx holds \(markers.count) day_rollover record(s), expected \(e.rollovers.count)")
        let sessionBreaks: Set<String> = [DiscontinuityCause.restart, DiscontinuityCause.deviceLost, DiscontinuityCause.resumed]
        let allowed: Set<String> = [IndexKey.byteOffset, IndexKey.samples, IndexKey.monoNS, IndexKey.wallNS, IndexKey.device,
                                    IndexKey.discontinuity, IndexKey.inputFrames, IndexKey.inputSampleRate]

        for (k, mi) in markers.enumerated() {
            let r = lines[mi]
            let n = r.number
            guard let m = r.int(IndexKey.wallNS), let rs0 = r.int(IndexKey.samples) else {
                c.law("C8.L1-keys")
                c.expect(false, "day_rollover line \(n) has no wall_ns or samples")
                continue
            }
            c.law("C8.L1-keys")
            // L1 — the record's keys (TapeWriter.swift:267-296): no gap, no drops, no levels, no restart fields.
            let extra = Set(r.fields.keys).subtracting(allowed).sorted()
            c.expect(extra.isEmpty, "day_rollover line \(n) carries \(extra)")
            for key in [IndexKey.byteOffset, IndexKey.monoNS, IndexKey.device] where r.fields[key] == nil {
                c.expect(false, "day_rollover line \(n) has no \(key)")
            }
            c.law("C8.L2-target")
            // L2 — wall_ns is the target itself, an IST midnight, not a clock read.
            c.expect((m + TapeFormat.istOffsetNS) % TapeFormat.istDayNS == 0,
                     "day_rollover line \(n) wall_ns \(m) is not an IST midnight (\((m + TapeFormat.istOffsetNS) % TapeFormat.istDayNS) ns past one)")
            c.law("C8.L3-rearm")
            // L3 — within one capture session each boundary is the previous one plus exactly one IST day.
            if k > 0 {
                let prev = lines[markers[k - 1]]
                let broken = lines[(markers[k - 1] + 1)..<mi].contains { cause($0).map(sessionBreaks.contains) ?? false }
                if !broken, let pm = prev.int(IndexKey.wallNS) {
                    c.expect(m == pm + TapeFormat.istDayNS,
                             "day_rollover line \(n) wall_ns \(m) is not the previous boundary (line \(prev.number)) + 86400000000000 = \(pm + TapeFormat.istDayNS) (Δ \(m - pm - TapeFormat.istDayNS) ns)")
                }
            }
            // The capture anchor after the marker (start of the suffix) and the forced checkpoint before it (end of the
            // prefix), when the tape has them at the marker's own sample.
            let after = mi + 1 < lines.count ? lines[mi + 1] : nil
            let suffix = after.flatMap { isCheckpoint($0) && $0.int(IndexKey.samples) == rs0 ? $0.int(IndexKey.wallNS) : nil }
            var bi = mi - 1
            while bi >= 0, !isCheckpoint(lines[bi]), lines[bi].int(IndexKey.samples) == rs0, cause(lines[bi]) != DiscontinuityCause.dayRollover { bi -= 1 }
            let before = bi >= 0 ? lines[bi] : nil
            let prefixEnd = before.flatMap { isCheckpoint($0) && $0.fields[IndexKey.peak] != nil && $0.int(IndexKey.samples) == rs0 ? $0.int(IndexKey.wallNS) : nil }
            let rate = (after?.double(IndexKey.inputSampleRate) ?? r.double(IndexKey.inputSampleRate)) ?? 48_000
            // One input frame, as the Mac's truncating segmentEnd can express it: the new day's first wall time lies in
            // [midnight, midnight + floor(1e9 / rate)] — [0, 20834) ns at 48 kHz — for split counts up to 1 200 frames
            // (checked: no truncated count ≤ 1 200 falls below an exact frame edge).
            let frameNS = Int64((1e9 / rate).rounded(.down))
            func withinOneFrame(_ d: Int64) -> Bool { d >= 0 && d <= frameNS }
            // The run of the marker: from the last restart record (or the tape start) up to the marker.
            let sessionStart = lines[..<mi].lastIndex { cause($0) == DiscontinuityCause.restart }
            let audioBefore = lines[((sessionStart ?? -1) + 1)..<mi].contains(where: isCheckpoint)
            c.law("C8.L4-straddle")
            // L4 — the straddling input frame stays in the OLD day: ceil for the frame count (CaptureTimeline.swift:146-149),
            // floor for the new day's wall time (AudioRing.swift:323-325).
            if let e0 = prefixEnd, let s0 = suffix, e0 == s0 {
                // Split inside one buffer: prefix end == suffix start, and midnight lies in the last prefix frame.
                c.expect(s0 >= m, "the old day's audio ends and the new day's begins at \(s0), \(m - s0) ns BEFORE midnight \(m) (line \(n)): the input frame straddling midnight was put in the NEW day")
                c.expect(s0 < m || withinOneFrame(s0 - m), "the new day begins \(s0 - m) ns after midnight (line \(n)), outside [0, \(frameNS + 1)): at least one whole old-day input frame lies after midnight")
            } else if let e0 = prefixEnd {
                if e0 >= m {
                    c.expect(withinOneFrame(e0 - m), "the prefix ends \(e0 - m) ns after midnight (line \(n)): a whole old-day input frame lies after midnight")
                } else if let s0 = suffix {
                    c.expect(s0 >= m, "the prefix ended before midnight and the new day begins at \(s0), \(m - s0) ns BEFORE midnight \(m) (line \(n)): new-day audio before the boundary")
                }
            } else if let s0 = suffix, !audioBefore {
                c.expect(s0 >= m, "no audio preceded the marker, yet the new day begins \(m - s0) ns BEFORE midnight (line \(n))")
            }
            c.law("C8.L5-frames")
            // L5 — the old day holds exactly the converter output of its input frames (reset at every discontinuity).
            if let closed = rs.last(where: { $0.end == rs0 && $0.start <= rs0 && $0.anchorLine < n }),
               let anchor = lines.first(where: { $0.number == closed.anchorLine }),
               let f0 = anchor.int(IndexKey.inputFrames), let f1 = r.int(IndexKey.inputFrames), closed.openLine < n {
                let want = Int64(DecimationRule.production.outputCount(frames: Int(f1 - f0)))
                c.expect(rs0 - closed.start == want,
                         "the day closed at line \(n) holds \(rs0 - closed.start) samples from \(f1 - f0) input frames (lines \(anchor.number)→\(n)); the conversion gives \(want)")
            }
            c.law("C8.L7-input-frames")
            // L7 — input_frames keyed off currentInputSampleRate (TapeWriter.swift:285), which is declared per run() (:153),
            // set by the run's first audio and cleared only by a format change (:290). A run is the tape from its start or
            // from a restart record; a device loss does not start one.
            c.expect((r.fields[IndexKey.inputFrames] != nil) == audioBefore,
                     audioBefore ? "day_rollover line \(n) omits input_frames although audio preceded it in this run"
                                 : "day_rollover line \(n) carries input_frames although no audio preceded it in this run (no input rate was known)")
            c.law("C8.pins")
            // Pins.
            if k < e.rollovers.count {
                let w = e.rollovers[k]
                c.expect(n == w.line, "day_rollover \(k) is on line \(n), expected \(w.line)")
                c.expect(m == w.boundaryWallNS, "day_rollover \(k) wall_ns \(m), expected \(w.boundaryWallNS)")
                c.expect(r.int(IndexKey.monoNS) == w.markerMonoNS, "day_rollover \(k) mono_ns \(r.int(IndexKey.monoNS).map(String.init) ?? "absent"), expected \(w.markerMonoNS)")
                c.expect(rs0 == w.rolloverSample, "day_rollover \(k) at sample \(rs0), expected \(w.rolloverSample)")
                c.expect(r.int(IndexKey.inputFrames) == w.inputFrames, "day_rollover \(k) input_frames \(r.int(IndexKey.inputFrames).map(String.init) ?? "absent"), expected \(w.inputFrames.map(String.init) ?? "absent")")
                c.expect(prefixEnd == w.prefixEndWallNS, "day_rollover \(k) prefix end wall_ns \(prefixEnd.map(String.init) ?? "none"), expected \(w.prefixEndWallNS.map(String.init) ?? "none")")
                c.expect(suffix == w.suffixWallNS, "day_rollover \(k) suffix first wall_ns \(suffix.map(String.init) ?? "none"), expected \(w.suffixWallNS.map(String.init) ?? "none")")
                let straddles = prefixEnd != nil && prefixEnd == suffix && (suffix ?? m) > m
                c.expect(straddles == w.straddling, "day_rollover \(k): straddling measured \(straddles), expected \(w.straddling)")
            }
        }
        c.law("C8.L6-no-unmarked-midnight")
        // L6 — no unmarked midnight: a checkpoint stamped with the end of audio (it carries peak) at or after the first IST
        // midnight following its region's start must be the forced checkpoint of a day_rollover at that same sample. A
        // region opened by a day_rollover starts its day at the marker's wall_ns, not at its capture anchor.
        for (ri, region) in rs.enumerated() {
            let opener = lines.first { $0.number == region.openLine }
            let dayStart = region.openedBy == DiscontinuityCause.dayRollover ? (opener?.int(IndexKey.wallNS) ?? region.anchorWallNS) : region.anchorWallNS
            let boundary = DayRollover.nextISTMidnight(after: dayStart)
            let nextOpen = ri + 1 < rs.count ? rs[ri + 1].openLine : Int.max
            for l in lines where l.number >= region.openLine && l.number < nextOpen && isCheckpoint(l) && l.fields[IndexKey.peak] != nil {
                guard let w = l.int(IndexKey.wallNS), w >= boundary else { continue }
                // The exception: a day_rollover at this checkpoint's own sample, stamped with this very midnight. (Not the
                // region's opener: when discontinuities share a sample the region is opened by the LAST of them.)
                let marked = lines.contains { cause($0) == DiscontinuityCause.dayRollover && $0.int(IndexKey.samples) == l.int(IndexKey.samples) && $0.int(IndexKey.wallNS) == boundary }
                c.expect(marked, "line \(l.number) is stamped \(w - boundary) ns after IST midnight \(boundary) (region anchored on line \(region.anchorLine)) with no day_rollover at that boundary")
            }
        }
        // L8 — the capture anchor is deferred to the first AUDIO after a run of markers: every discontinuity() sets
        // needsCaptureAnchor (TapeWriter.swift:288-292), a marker item returns early (:323-326), and the anchor at :339-341
        // is reached only for an audio item. So (a) no checkpoint sits between two discontinuity records unless audio was
        // consumed between them (an anchor always precedes at least one consumed frame), and (b) the first record after
        // the last marker of a run, if it is a checkpoint, is that marker's empty-window anchor at the same sample.
        c.law("C8.L8-anchor-deferred")
        for i in lines.indices where !isCheckpoint(lines[i]) && cause(lines[i]) != DiscontinuityCause.stopped && i + 1 < lines.count {
            let d = lines[i], next = lines[i + 1]
            guard isCheckpoint(next) else { continue }
            let anchorShaped = next.fields[IndexKey.peak] == nil && next.int(IndexKey.samples) == d.int(IndexKey.samples)
            c.expect(anchorShaped, "line \(next.number) follows the \(cause(d) ?? "?") record on line \(d.number) but is not its capture anchor (it carries levels or another sample): audio after the marker was written without the deferred anchor")
            if anchorShaped, i + 2 < lines.count, !isCheckpoint(lines[i + 2]), lines[i + 2].int(IndexKey.samples) == next.int(IndexKey.samples) {
                let after = lines[i + 2]
                let consumed = after.int(IndexKey.inputFrames).map { f in next.int(IndexKey.inputFrames).map { f > $0 } ?? true } ?? false
                c.expect(consumed, "line \(next.number) is a capture anchor between the \(cause(d) ?? "?") record (line \(d.number)) and the \(cause(after) ?? "?") record (line \(after.number)) with no audio consumed between them: the anchor must wait for the first audio after both")
            }
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
        c.law("C10.argv")
        c.expect(argv.map { Array($0.utf8) } == e.argv.map { Array($0.utf8) },
                 "encoder arguments differ from pinned\n        pinned: \(e.argv)\n        built:  \(argv)")

        // Assertion 2: the decoded audio, within the manifest's stated tolerance.
        c.law("C10.decoded-audio")
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

/// C7's zero-fill probe (U1 spec §11.5). A run of `length` exact zero samples is zero fill — min(gap samples, 16) after a
/// gap, 16 after a gapless boundary — looked for starting `exemptSamples` after the discontinuity: the first 40 samples
/// after any boundary are the decimation filter's ramp-up from a zeroed history (§11.4), where near-zero output is correct.
public enum C7ZeroProbe {
    public static let exemptSamples = DecimationRule.production.rampOutputSamples
    public static let threshold = 16

    public struct Result: Sendable { public var inRange: Bool; public var exempt: Int; public var length: Int; public var zeroRun: Int; public var zeroFill: Bool }

    public static func length(gapNS: Int64) -> Int { Int(min(gapNS / TapeFormat.nsPerSample, Int64(threshold))) }

    public static func run(pcm: [UInt8], byteOffset: Int64, length: Int, exemptSamples: Int) -> Result {
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
