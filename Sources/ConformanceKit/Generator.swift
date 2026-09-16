import Foundation
import TapeConvert
import TapeCore

/// Synthesises PCM from tones and silence of known sample counts. Never recorded audio.
public enum Synth {
    public static func render(_ segments: [SynthSegment]) -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(Int(segments.reduce(Int64(0)) { $0 + ($1.samples ?? 0) } * 2))
        for s in segments {
            switch s.kind {
            case "silence":
                out.append(contentsOf: repeatElement(0, count: Int(s.samples ?? 0) * 2))
            case "tone":
                // Cosine, so every tone segment begins at full amplitude, never at zero.
                let hz = Double(s.freqHz ?? 0), amp = (s.amplitude ?? 0) * 32767.0
                for n in 0..<Int(s.samples ?? 0) {
                    let v = Int16((amp * cos(2.0 * Double.pi * hz * Double(n) / 16000.0)).rounded())
                    let u = UInt16(bitPattern: v)
                    out.append(UInt8(u & 0xff))
                    out.append(UInt8(u >> 8))
                }
            default:
                break  // "gap" writes no PCM: that is the point of it.
            }
        }
        return out
    }
}

/// One synthetic index record. Index lines are hand-formatted here, never produced by JSONEncoder, so C2
/// compares the platform encoder against an independent statement of the canonical form: keys sorted by
/// byte, no whitespace, `/` and non-ASCII unescaped, and Doubles written as the shortest decimal that
/// round-trips with a trailing ".0" removed (measured as swift-foundation's output on 14 Sep 2026; Darwin's
/// output is not verified on this machine). Double fields are therefore carried as literal strings.
/// rms/peak/zero_ratio values are literals chosen to exercise Double formatting; no case asserts them
/// against the PCM.
public struct SynthRecord {
    public var samples: Int64?
    public var monoNS: UInt64
    public var wallNS: Int64
    public var device: String
    public var rms: String?
    public var peak: String?
    public var zeroRatio: String?
    public var discontinuity: String?
    public var gapNS: UInt64?
    public var previousByteOffset: Int64?
    public var survivingTailBytes: Int64?
    public var droppedInputFrames: UInt64?
    public var inputFrames: Int64?
    public var inputSampleRate: String?

    // Corruptions, for negative controls only.
    var byteOffsetOverride: Int64? = nil
    var reverseKeys = false
    var escapeSlashes = false

    func pairs() -> [(String, String)] {
        func str(_ v: String) -> String {
            var o = "\""
            for ch in v.unicodeScalars {
                switch ch {
                case "\"": o += "\\\""
                case "\\": o += "\\\\"
                case "/" where escapeSlashes: o += "\\/"
                default: o.unicodeScalars.append(ch)
                }
            }
            return o + "\""
        }
        var p: [(String, String)] = []
        if let s = samples {
            p.append((IndexKey.byteOffset, String(byteOffsetOverride ?? s * 2)))
            p.append((IndexKey.samples, String(s)))
        }
        p.append((IndexKey.monoNS, String(monoNS)))
        p.append((IndexKey.wallNS, String(wallNS)))
        p.append((IndexKey.device, str(device)))
        if let v = rms { p.append((IndexKey.rms, v)) }
        if let v = peak { p.append((IndexKey.peak, v)) }
        if let v = zeroRatio { p.append((IndexKey.zeroRatio, v)) }
        if let v = discontinuity { p.append((IndexKey.discontinuity, str(v))) }
        if let v = gapNS { p.append((IndexKey.gapNS, String(v))) }
        if let v = previousByteOffset { p.append((IndexKey.previousByteOffset, String(v))) }
        if let v = survivingTailBytes { p.append((IndexKey.survivingTailBytes, String(v))) }
        if let v = droppedInputFrames { p.append((IndexKey.droppedInputFrames, String(v))) }
        if let v = inputFrames { p.append((IndexKey.inputFrames, String(v))) }
        if let v = inputSampleRate { p.append((IndexKey.inputSampleRate, v)) }
        p.sort { Array($0.0.utf8).lexicographicallyPrecedes(Array($1.0.utf8)) }
        if reverseKeys { p.reverse() }
        return p
    }

    public func line() -> String {
        "{" + pairs().map { "\"\($0.0)\":\($0.1)" }.joined(separator: ",") + "}\n"
    }
}

/// Builds a tape's index on a synthetic clock: one sample is 62 500 ns; a gap advances wall and mono time
/// without advancing samples.
struct TapeBuilder {
    let device: String
    /// Input rate literal, e.g. "48000"; input_frames is samples × inputNum / inputDen.
    let inputRate: (literal: String, num: Int64, den: Int64)?
    var anchorSample: Int64 = 0
    var anchorWall: Int64
    var anchorMono: UInt64
    var records: [SynthRecord] = []
    var stat = 0

    static let rmsLiterals = ["0.35355339059327373", "0.17677669529663687", "0.30000000000000004", "0.1", "6.25e-05", "0.9999999999999999"]
    static let peakLiterals = ["0.5", "0.0625", "0.3333333333333333", "1e-05", "0.001", "1"]
    static let zeroRatioLiterals = ["0", "0.6666666666666666", "1.5e-07", "0.001", "0.5", "1"]

    init(device: String, wall: Int64, mono: UInt64, inputRate: (String, Int64, Int64)?) {
        self.device = device
        self.anchorWall = wall
        self.anchorMono = mono
        self.inputRate = inputRate.map { (literal: $0.0, num: $0.1, den: $0.2) }
    }

    func wall(_ s: Int64) -> Int64 { anchorWall + (s - anchorSample) * TapeFormat.nsPerSample }
    func mono(_ s: Int64) -> UInt64 { anchorMono + UInt64((s - anchorSample) * TapeFormat.nsPerSample) }

    func base(_ s: Int64) -> SynthRecord {
        SynthRecord(samples: s, monoNS: mono(s), wallNS: wall(s), device: device,
                    inputFrames: inputRate.map { s * $0.num / $0.den }, inputSampleRate: inputRate?.literal)
    }

    /// A checkpoint. `window` false: the window since the previous record holds zero samples, so no peak/zero_ratio.
    mutating func checkpoint(_ s: Int64, window: Bool = true) {
        var r = base(s)
        if window {
            r.rms = TapeBuilder.rmsLiterals[stat % 6]
            r.peak = TapeBuilder.peakLiterals[stat % 6]
            r.zeroRatio = TapeBuilder.zeroRatioLiterals[stat % 6]
            stat += 1
        } else {
            r.rms = "0"
        }
        records.append(r)
    }

    mutating func checkpoints(every step: Int64, after start: Int64, through end: Int64) {
        var s = start + step
        while s <= end { checkpoint(s); s += step }
    }

    /// A discontinuity at sample `s`. Its timestamp is the wall time audio resumes; the region re-anchors on it.
    mutating func discontinuity(_ s: Int64, cause: String, gapNS: UInt64? = nil, dropped: UInt64? = nil,
                                previousByteOffset: Int64? = nil, survivingTailBytes: Int64? = nil) {
        let g = Int64(gapNS ?? 0)
        anchorWall = wall(s) + g
        anchorMono = mono(s) + UInt64(g)
        anchorSample = s
        var r = base(s)
        r.discontinuity = cause
        r.gapNS = gapNS
        r.droppedInputFrames = dropped
        r.previousByteOffset = previousByteOffset
        r.survivingTailBytes = survivingTailBytes
        records.append(r)
    }

    /// A checkpoint at the region boundary whose timestamp replaces the discontinuity's (offset by `jitterNS`).
    mutating func boundaryCheckpoint(_ s: Int64, jitterNS: Int64) {
        anchorWall += jitterNS
        anchorMono += UInt64(jitterNS)
        checkpoint(s, window: false)
    }

    var idx: [UInt8] { Array(records.map { $0.line() }.joined().utf8) }
}

public enum FixtureGenerator {
    struct Draft {
        var manifest: FixtureManifest
        var pcm: [UInt8]
        var idx: [UInt8]
        var expected: ExpectedAnswers
        var encoderLine: [UInt8] = []
        /// C9: input, expected output and taps file bytes; digests are filled in when written.
        var resampler: (input: [UInt8], output: [UInt8], taps: [UInt8], regions: [UInt8]?)? = nil
    }

    // Synthetic clocks.
    /// 2026-09-14 10:00:00.123456789 IST.
    static let cleanAnchorNS: Int64 = 1_789_360_200_123_456_789
    /// 2026-09-14 00:00:00 IST, as UTC ns.
    static let istMidnightNS: Int64 = 1_789_324_200_000_000_000
    static let monoStart: UInt64 = 86_400_123_000_000

    static let dmic = "sof-hda-dsp: DMIC Raw (hw:0,6) / Yoga — built-in"
    static let usb = "USB Audio/Jabra SPEAK 510 — \"room\" mic"

    static func manifest(_ name: String, _ description: String, _ cases: [CaseID], _ synthesis: [SynthSegment]) -> FixtureManifest {
        FixtureManifest(schema: FixtureManifest.currentSchema, name: name, description: description,
                        provenance: "synthetic", role: .good, cases: cases, negativeControl: nil,
                        pcm: nil, idx: nil, expected: nil, synthesis: synthesis, resampler: nil, encoder: nil)
    }

    static func point(_ name: String, _ at: String, _ b: TapeBuilder, _ s: Int64) -> ClockPoint {
        ClockPoint(name: name, at: at, wallNS: b.wall(s))
    }

    /// C10's decoded-audio tolerance, stated before any reference run.
    public static let c10Tolerance = C10Tolerance(
        method: "Encode tape.pcm with the pinned arguments; decode the piece with ffmpeg to s16le 16 kHz mono. "
            + "(1) |decoded sample count - input sample count| <= max_sample_count_delta. "
            + "(2) For every lag L in [-max_lag_samples, +max_lag_samples], compute the normalised cross-correlation "
            + "sum(x[i]*y[i+L]) / sqrt(sum(x[i]^2) * sum(y[i+L]^2)) over the overlapping samples, x = input, y = decoded; "
            + "the maximum must be >= min_correlation. "
            + "(3) |20*log10(RMS(decoded) / RMS(input))| over all samples <= max_rms_delta_db. "
            + "Encoded bytes are never compared.",
        maxSampleCountDelta: 320, maxLagSamples: 320, minCorrelation: 0.95, maxRMSDeltaDB: 1.0)

    // MARK: Good fixtures

    static func cleanShortBuilder() -> TapeBuilder {
        var b = TapeBuilder(device: dmic, wall: cleanAnchorNS, mono: monoStart, inputRate: ("48000", 3, 1))
        b.checkpoint(0, window: false)
        b.checkpoints(every: 8_000, after: 0, through: 40_000)
        return b
    }

    static func cleanShort(encoder env: EncoderEnvironment) throws -> Draft {
        let syn: [SynthSegment] = [.tone(1000, 0.5, 16_000), .silence(8_000), .tone(440, 0.25, 16_000)]
        let b = cleanShortBuilder()
        var e = ExpectedAnswers()
        e.c3 = C3Expected(outcome: "clean", records: b.records.count)
        e.c4 = ClockExpected(points: [
            point("first sample", "sample:0", b, 0),
            point("second sample", "sample:1", b, 1),
            point("fourth record", "record:4", b, 24_000),
            point("last sample", "sample:39999", b, 39_999),
            point("end of tape", "pcm_end", b, 40_000),
        ])
        var m = manifest("clean-short", "2.5 s clean tape: 1 kHz tone, silence, 440 Hz tone; opening checkpoint at 0, then every 0.5 s. Input rate 48000.",
                         [.C1, .C2, .C3, .C4, .C10], syn)
        let pcm = Synth.render(syn)
        // The reference measurement is taken now, with this encoder, against the tolerance stated above.
        let measured: C10Measured
        switch C10Probe.measure(pcm: pcm, env: env, maxLag: c10Tolerance.maxLagSamples) {
        case .success(let v): measured = v
        case .failure(let err): throw FixtureLoadError(fixture: "good/clean-short", reason: "C10 reference measurement failed: \(err)")
        }
        let violations = measured.violations(c10Tolerance)
        guard violations.isEmpty else {
            throw FixtureLoadError(fixture: "good/clean-short",
                                   reason: "C10 reference is outside the stated tolerance (not widening it): \(violations.joined(separator: "; ")) — \(measured.summary)")
        }
        m.encoder = EncoderContract(
            ffmpegVersion: env.ffmpegVersion, libopusVersion: env.libopusVersion, libopusLibrary: env.libopusLibrary,
            opusEncoders: env.opusEncoders, recordedOn: env.host,
            argv: PieceEncoder.arguments(input: PieceEncoder.inputPlaceholder, output: PieceEncoder.outputPlaceholder),
            tolerance: c10Tolerance, referenceMeasurement: measured, alsoVerified: [])
        return Draft(manifest: m, pcm: pcm, idx: b.idx, expected: e)
    }

    /// ring_overflow at 24 000 (500 ms, boundary checkpoint replaces its timestamp), restart at 40 000 (2 s).
    /// `zeroFill` inserts that many zero samples at the ring_overflow: the C7 negative control.
    static func discontinuityBuilder(zeroFill: Int64 = 0) -> TapeBuilder {
        var b = TapeBuilder(device: usb, wall: cleanAnchorNS + 7_000_000_000, mono: monoStart + 7_000_000_000, inputRate: ("44100", 441, 160))
        b.checkpoint(0, window: false)
        b.checkpoints(every: 8_000, after: 0, through: 24_000)
        b.discontinuity(24_000, cause: DiscontinuityCause.ringOverflow, gapNS: 500_000_000, dropped: 22_050)
        b.boundaryCheckpoint(24_000, jitterNS: 1_250)
        let z = zeroFill
        b.checkpoints(every: 8_000, after: 24_000 + z, through: 40_000 + z)
        b.discontinuity(40_000 + z, cause: DiscontinuityCause.restart, gapNS: 2_000_000_000,
                        previousByteOffset: (40_000 + z) * 2, survivingTailBytes: 0)
        b.checkpoints(every: 8_000, after: 40_000 + z, through: 48_000 + z)
        return b
    }

    static let discontinuitySynthesis: [SynthSegment] = [
        .tone(1000, 0.5, 24_000), .gap(ns: 500_000_000, droppedInputFrames: 22_050),
        .tone(440, 0.25, 16_000), SynthSegment(kind: "gap", gapNS: 2_000_000_000), .tone(1000, 0.25, 8_000),
    ]

    static func discontinuity() -> Draft {
        let b = discontinuityBuilder()
        var e = ExpectedAnswers()
        e.c3 = C3Expected(outcome: "clean", records: b.records.count)
        let ringLine = b.records.firstIndex { $0.discontinuity == DiscontinuityCause.ringOverflow }! + 1
        e.c7 = C7Expected(line: ringLine, cause: DiscontinuityCause.ringOverflow, gapNS: 500_000_000, droppedInputFrames: 22_050,
                          preGapSamples: 24_000, postGapSamples: 24_000)
        // Wall times are the builder's clock; C4 derives them from the index's region anchors.
        var clock = TapeBuilder(device: usb, wall: cleanAnchorNS + 7_000_000_000, mono: 0, inputRate: nil)
        let before = point("last sample before the ring_overflow", "sample:23999", clock, 23_999)
        clock.anchorWall = clock.wall(24_000) + 500_000_000 + 1_250; clock.anchorSample = 24_000
        let resume = point("first sample after the ring_overflow (boundary checkpoint anchor)", "sample:24000", clock, 24_000)
        let mid = point("sample 32000", "sample:32000", clock, 32_000)
        clock.anchorWall = clock.wall(40_000) + 2_000_000_000; clock.anchorSample = 40_000
        let restart = point("first sample after the restart", "sample:40000", clock, 40_000)
        let end = point("end of tape", "pcm_end", clock, 48_000)
        e.c4 = ClockExpected(points: [before, resume, mid, restart, end])
        // restart carries a 2 s gap_ns, but restart is not a gap-carrying cause: its piece's gap is zero by rule.
        e.pieces = [PieceRange(sampleStart: 0, sampleEnd: 24_000),
                    PieceRange(sampleStart: 24_000, sampleEnd: 40_000, gapBeforeMS: 500),
                    PieceRange(sampleStart: 40_000, sampleEnd: 48_000)]
        return Draft(manifest: manifest("discontinuity",
                                        "3 s of tone in three regions: ring_overflow at 24000 (500 ms gap, 22050 dropped input frames, boundary checkpoint re-anchors), restart at 40000 (2 s gap). No PCM for either gap. Input rate 44100.",
                                        [.C1, .C2, .C3, .C4, .C5, .C7], discontinuitySynthesis),
                     pcm: Synth.render(discontinuitySynthesis), idx: b.idx, expected: e)
    }

    static func tornTail() -> Draft {
        let syn: [SynthSegment] = [.tone(1000, 0.5, 48_000)]
        var b = TapeBuilder(device: dmic, wall: cleanAnchorNS, mono: monoStart, inputRate: ("48000", 3, 1))
        b.checkpoint(0, window: false)
        b.checkpoints(every: 16_000, after: 0, through: 48_000)
        let complete = b.records.dropLast().map { $0.line() }.joined()
        let torn = String(b.records.last!.line().dropLast().prefix(40))  // no 0x0A
        var e = ExpectedAnswers()
        e.c3 = C3Expected(outcome: "torn_tail", records: b.records.count - 1, repairedLength: complete.utf8.count, droppedBytes: torn.utf8.count)
        return Draft(manifest: manifest("torn-tail", "3 s tone; three complete records and a torn fourth line with no terminating 0x0A.",
                                        [.C1, .C2, .C3], syn),
                     pcm: Synth.render(syn), idx: Array((complete + torn).utf8), expected: e)
    }

    static func interiorBlank() -> Draft {
        let syn: [SynthSegment] = [.tone(1000, 0.5, 48_000)]
        var b = TapeBuilder(device: dmic, wall: cleanAnchorNS, mono: monoStart, inputRate: ("48000", 3, 1))
        b.checkpoint(0, window: false)
        b.checkpoints(every: 16_000, after: 0, through: 48_000)
        let lines = b.records.map { $0.line() }
        let idx = lines[0] + lines[1] + "\n" + lines[2] + lines[3]
        var e = ExpectedAnswers()
        e.c3 = C3Expected(outcome: "hard_error", error: "interior_blank_line", line: 3)
        return Draft(manifest: manifest("interior-blank", "3 s tone; an empty line between the second and third records (line 3).",
                                        [.C3], syn),
                     pcm: Synth.render(syn), idx: Array(idx.utf8), expected: e)
    }

    static func multiPiece() -> Draft {
        let syn: [SynthSegment] = [.tone(440, 0.25, 1_000_000), .silence(3_800_000),
                                   .tone(1000, 0.25, 1_000_000), .silence(3_800_000),
                                   .tone(440, 0.25, 800_000), .silence(800_000)]
        let total: Int64 = 11_200_000
        var b = TapeBuilder(device: dmic, wall: cleanAnchorNS, mono: monoStart, inputRate: ("48000", 3, 1))
        b.checkpoint(0, window: false)
        b.checkpoints(every: 160_000, after: 0, through: total)
        var e = ExpectedAnswers()
        e.pieces = [PieceRange(sampleStart: 0, sampleEnd: 4_800_000),
                    PieceRange(sampleStart: 4_800_000, sampleEnd: 9_600_000),
                    PieceRange(sampleStart: 9_600_000, sampleEnd: 11_200_000)]
        e.c6 = C6Expected(pieceSamples: 4_800_000, fullPieces: 2, partialPieces: [1_600_000])
        return Draft(manifest: manifest("multi-piece", "700 s tape, no discontinuity: two full 300 s pieces and a 100 s partial tail; checkpoints every 10 s.",
                                        [.C1, .C2, .C5, .C6], syn),
                     pcm: Synth.render(syn), idx: b.idx, expected: e)
    }

    static func multiPieceGap() -> Draft {
        let syn: [SynthSegment] = [.tone(440, 0.25, 1_000_000), .silence(4_800_000),
                                   .gap(ns: 250_000_000, droppedInputFrames: 12_000), .tone(1000, 0.25, 1_000_000)]
        var b = TapeBuilder(device: dmic, wall: cleanAnchorNS, mono: monoStart, inputRate: ("48000", 3, 1))
        b.checkpoint(0, window: false)
        b.checkpoints(every: 200_000, after: 0, through: 5_800_000)
        b.discontinuity(5_800_000, cause: DiscontinuityCause.ringOverflow, gapNS: 250_000_000, dropped: 12_000)
        b.checkpoints(every: 200_000, after: 5_800_000, through: 6_800_000)
        var e = ExpectedAnswers()
        e.pieces = [PieceRange(sampleStart: 0, sampleEnd: 4_800_000),
                    PieceRange(sampleStart: 4_800_000, sampleEnd: 5_800_000),
                    PieceRange(sampleStart: 5_800_000, sampleEnd: 6_800_000, gapBeforeMS: 250)]
        e.c6 = C6Expected(pieceSamples: 4_800_000, fullPieces: 1, partialPieces: [1_000_000, 1_000_000])
        return Draft(manifest: manifest("multi-piece-gap",
                                        "425 s tape with a 250 ms ring_overflow at 362.5 s: one full piece, a 62.5 s partial closed at the discontinuity, a 62.5 s piece after it carrying gap_before_ms 250.",
                                        [.C1, .C2, .C5, .C6], syn),
                     pcm: Synth.render(syn), idx: b.idx, expected: e)
    }

    /// Two gap-carrying discontinuities with fractional-millisecond gaps, 16 000 samples apart.
    static func gapRoundingBuilder(_ first: (cause: String, ns: UInt64), _ second: (cause: String, ns: UInt64)) -> TapeBuilder {
        var b = TapeBuilder(device: dmic, wall: cleanAnchorNS, mono: monoStart, inputRate: ("48000", 3, 1))
        b.checkpoint(0, window: false)
        b.checkpoints(every: 8_000, after: 0, through: 16_000)
        for (at, g) in [(Int64(16_000), first), (Int64(32_000), second)] {
            b.discontinuity(at, cause: g.cause, gapNS: g.ns, dropped: g.cause == DiscontinuityCause.ringOverflow ? 24 : nil)
            b.checkpoints(every: 8_000, after: at, through: at + 16_000)
        }
        return b
    }

    static func gapRounding(name: String, description: String, _ first: (cause: String, ns: UInt64, ms: Int64),
                            _ second: (cause: String, ns: UInt64, ms: Int64)) -> Draft {
        let syn: [SynthSegment] = [.tone(1000, 0.5, 16_000), SynthSegment(kind: "gap", gapNS: Int64(first.ns)),
                                   .tone(440, 0.25, 16_000), SynthSegment(kind: "gap", gapNS: Int64(second.ns)),
                                   .tone(1000, 0.25, 16_000)]
        let b = gapRoundingBuilder((first.cause, first.ns), (second.cause, second.ns))
        var e = ExpectedAnswers()
        e.pieces = [PieceRange(sampleStart: 0, sampleEnd: 16_000),
                    PieceRange(sampleStart: 16_000, sampleEnd: 32_000, gapBeforeMS: first.ms == 0 ? nil : first.ms),
                    PieceRange(sampleStart: 32_000, sampleEnd: 48_000, gapBeforeMS: second.ms == 0 ? nil : second.ms)]
        return Draft(manifest: manifest(name, description, [.C1, .C2, .C5], syn),
                     pcm: Synth.render(syn), idx: b.idx, expected: e)
    }

    static func gapRoundingBelow() -> Draft {
        gapRounding(name: "gap-rounding-below-half",
                    description: "Fractional gaps just below the half millisecond round down: capture_discontinuity 120499999 ns -> 120 ms; ring_overflow 499999 ns -> 0 ms (rounds to zero).",
                    (DiscontinuityCause.captureDiscontinuity, 120_499_999, 120), (DiscontinuityCause.ringOverflow, 499_999, 0))
    }

    static func gapRoundingAbove() -> Draft {
        gapRounding(name: "gap-rounding-at-and-above-half",
                    description: "Fractional gaps at and just above the half millisecond round up: device_lost 120500000 ns -> 121 ms (the >= 500000 edge); resumed 60500001 ns -> 61 ms.",
                    (DiscontinuityCause.deviceLost, 120_500_000, 121), (DiscontinuityCause.resumed, 60_500_001, 61))
    }

    /// Darwin Foundation JSONEncoder output, measured on the Mac mini (Swift 6.4, macOS 27.0) with
    /// [.sortedKeys, .withoutEscapingSlashes], exact stdout, as recorded in ETA-U0-CLOSED-14-SEP-2026.md.
    /// Measured data, not generated: never edit this line.
    static let darwinDoubleLine = #"{"a":0,"b":48000,"c":0.5,"d":0.0317,"e":0.4166666666666667,"f":0.3333333333333333}"#
    static let darwinDoubleSources = ["a": "0.0", "b": "48000.0", "c": "0.5", "d": "0.0317", "e": "0.4166666666666667", "f": "1.0/3.0"]

    static func darwinDoubles() -> Draft {
        var e = ExpectedAnswers()
        e.c2 = C2EncoderLineExpected(measuredOn: "Mac mini, Swift 6.4, macOS 27.0, Foundation JSONEncoder, 14 Sep 2026",
                                     outputFormatting: ["sortedKeys", "withoutEscapingSlashes"], values: darwinDoubleSources)
        let m = FixtureManifest(schema: FixtureManifest.currentSchema, name: "darwin-encoder-doubles",
                                description: "Darwin JSONEncoder output for six Doubles (whole and fractional), measured on the Mac. C2 asserts this platform's encoder writes the same bytes from the same values. Not an index line: keys a-f are the probe's.",
                                provenance: "darwin:swift-6.4/macOS-27.0 (measured)", role: .good, cases: [.C2], negativeControl: nil,
                                pcm: nil, idx: nil, expected: nil, synthesis: nil, resampler: nil, encoder: nil)
        return Draft(manifest: m, pcm: [], idx: [], expected: e, encoderLine: Array((darwinDoubleLine + "\n").utf8))
    }

    // MARK: C9 — the conversion

    /// One stretch of synthetic 48 kHz stereo input. Tones are cosines from phase 0 at the segment start,
    /// amplitude × 32767, rounded to nearest (half away from zero), per channel.
    enum StereoSignal {
        case silence
        case tone(hz: Double, amplitude: Double)
        case dc(Int16)
        /// Full-scale square: first half-period +32767, second half −32768.
        case square(periodFrames: Int)

        func sample(_ n: Int) -> Int16 {
            switch self {
            case .silence: return 0
            case .tone(let hz, let a): return Int16((a * 32767.0 * cos(2.0 * Double.pi * hz * Double(n) / 48000.0)).rounded())
            case .dc(let v): return v
            case .square(let p): return n % p < p / 2 ? 32_767 : -32_768
            }
        }

        var text: String {
            switch self {
            case .silence: return "silence"
            case .tone(let hz, let a): return "cosine \(Int(hz)) Hz amplitude \(a)"
            case .dc(let v): return "DC \(v)"
            case .square(let p): return "full-scale square, period \(p) frames (\(p / 2) at +32767 then \(p / 2) at -32768)"
            }
        }
    }

    static let c9Segments: [(frames: Int, left: StereoSignal, right: StereoSignal)] = [
        (4_800, .silence, .silence),
        (48_000, .tone(hz: 1000, amplitude: 0.5), .tone(hz: 3000, amplitude: 0.25)),
        (24_000, .tone(hz: 10000, amplitude: 0.5), .tone(hz: 10000, amplitude: 0.5)),
        (4_800, .dc(-1), .dc(0)),
        (4_800, .dc(0), .dc(1)),
        (4_800, .dc(-3), .dc(-2)),
        (4_800, .dc(32_767), .dc(32_767)),
        (4_800, .dc(-32_768), .dc(-32_768)),
        (24_000, .square(periodFrames: 96), .square(periodFrames: 96)),
        (9_600, .tone(hz: 7000, amplitude: 0.5), .silence),
        (2, .tone(hz: 1000, amplitude: 0.5), .tone(hz: 3000, amplitude: 0.25)),
    ]

    /// The C9 input at `channels` channels: channel 0 is the left programme, channel 1 the right (only 1 and 2 are used).
    static func c9Input(channels: Int = 2) -> [UInt8] {
        var out: [UInt8] = []
        for seg in c9Segments {
            for n in 0..<seg.frames {
                for v in (0..<channels).map({ $0 == 1 ? seg.right.sample(n) : seg.left.sample(n) }) {
                    let u = UInt16(bitPattern: v)
                    out.append(UInt8(u & 0xff))
                    out.append(UInt8(u >> 8))
                }
            }
        }
        return out
    }

    /// Deliberately asymmetric taps (sum 65536) so that reading the convolution index backwards changes the output.
    static let directionProbeTaps: [Int32] = {
        var t = [Int32](repeating: 0, count: 121)
        t[0] = 32_768; t[1] = 16_384; t[2] = 8_192; t[120] = 8_192
        return t
    }()

    /// Region starts for the reset test: 52801 falls one frame into a group (that frame is dropped), 100800 on a group boundary.
    static let c9RegionStarts = [52_801, 100_800]

    static func conversionSpec(_ rule: DecimationRule, inputFrames: Int, tapsRole: String, regionStarts: [Int]?) -> ResamplerFixture {
        let tapSum = rule.taps.reduce(Int64(0)) { $0 + Int64($1) }
        let probe = tapsRole == "direction_probe"
        let regionsCount: Int? = regionStarts.map { starts in
            let bounds = [0] + starts + [inputFrames]
            return zip(bounds, bounds.dropFirst()).reduce(0) { $0 + rule.outputCount(frames: $1.1 - $1.0) }
        }
        return ResamplerFixture(
            design: rule.designID,
            specification: "spec/CONVERSION-48K-TO-16K-MONO.md. All arithmetic exact integer; no floating point in the conversion.",
            input: FileDigest(file: "input-48k.pcm", bytes: 0, sha256: ""),
            output: FileDigest(file: "expected-16k-mono.pcm", bytes: 0, sha256: ""),
            taps: FileDigest(file: probe ? "direction-probe-121tap-q16.taps" : "fir-48k-to-16k-\(rule.taps.count)tap-q\(rule.qBits).taps", bytes: 0, sha256: ""),
            inputFrames: inputFrames, channelCount: rule.channels, outputSamples: rule.outputCount(frames: inputFrames),
            inputFormat: "S16_LE, \(rule.channels) channel(s) interleaved, 48000 Hz; frame = \(2 * rule.channels) bytes, channel c at bytes 2c..2c+1; frames numbered n = 0,1,2,... from stream start",
            outputFormat: "S16_LE, 1 channel, 16000 Hz",
            downmix: rule.channels == 1
                ? "channel_count 1: m[n] = s[n], a copy (conversion spec section 2), as the Mac copies a single channel (AudioRing.swift:296-309). No attenuation: the output divisor is 2^\(rule.qBits), not 2 x 2^\(rule.qBits)."
                : "channel_count \(rule.channels): m[n] is the MEAN over the channels. Held here as the exact sum m[n] = sum over c of s_c[n] in a signed 32-bit integer (range \(-32768 * rule.channels)..\(32767 * rule.channels)), with the division by \(rule.channels) folded into the output divisor (section 5), so the conversion rounds exactly once. The Mac takes the same mean in Float32 (AudioRing.swift:296-309). s=(-1,0) gives m=-1 exactly.",
            filter: probe
                ? .init(tapCount: rule.taps.count, qBits: rule.qBits, tapSum: tapSum, symmetric: false, cutoffHz: 0, window: "none", kaiserBeta: 0,
                        design: "Direction probe, not a low-pass: h[0]=32768, h[1]=16384, h[2]=8192, h[120]=8192, every other tap 0. Asymmetric on purpose, so acc[n] = sum h[i]*m[n-i] and the reversed sum h[i]*m[n+i-120] give different output.",
                        rule: "The integers in the taps file, h[0]..h[120], run through the production arithmetic (downmix, accumulator, decimation, rounding, clipping) unchanged.")
                : .init(tapCount: rule.taps.count, qBits: rule.qBits, tapSum: tapSum, symmetric: rule.taps == rule.taps.reversed(),
                        cutoffHz: 7000, window: "Kaiser", kaiserBeta: 8.0,
                        design: "Provenance only: windowed sinc, cutoff 7000 Hz (-6 dB point) at fs 48000 Hz, Kaiser beta 8.0, scaled by 2^16, each tap rounded half away from zero, residual added to the centre tap so the sum is exactly 65536 (tools/design_fir.py 121 7000 8.0 16). Integer-tap response: 0-6000 Hz within +/-0.002 dB, -6.02 dB at 7000 Hz, <= -69.1 dB from 8000 to 24000 Hz.",
                        rule: "The integers in the taps file are normative: h[0]..h[\(rule.taps.count - 1)], one decimal integer per \\n-terminated line."),
            accumulator: .init(bits: DecimationRule.accumulatorBits, signed: true,
                               historyAtStart: "zero: m[j] = 0 for every j before the region's first frame (stream start or discontinuity)",
                               rule: "acc[n] = sum over i = 0..\(rule.taps.count - 1) of h[i] * m[n - i], in a signed 64-bit integer. Index direction: h[0] multiplies the NEWEST sample m[n], h[\(rule.taps.count - 1)] the OLDEST m[n - \(rule.taps.count - 1)]. |acc| <= 65536 * sum|h| = 8357675008 for the production taps, beyond 32 bits."),
            decimation: .init(factor: rule.factor, phase: rule.phase,
                              rule: "Output sample k = 0,1,2,... is computed from acc[\(rule.factor)k + \(rule.phase)], produced when input frame \(rule.factor)k + \(rule.phase) arrives. F input frames give one output per frame n < F with n mod \(rule.factor) == \(rule.phase)\(rule.phase == rule.factor - 1 ? ", i.e. floor(F / \(rule.factor)): an output needs the complete group \(rule.factor)k .. \(rule.factor)k+\(rule.factor - 1), and up to \(rule.factor - 1) trailing frames give none" : "")."),
            outputRounding: .init(bias: rule.roundingBias, divisor: rule.outputDivisor,
                                  rule: "y = floor((acc + \(rule.roundingBias)) / \(rule.outputDivisor)), FLOOR division, never truncation toward zero; the two differ for negative accumulators, so a port using / on a signed integer is non-conforming. The divisor is channels x 2^\(rule.qBits) = \(rule.channels) x \(Int64(1) << Int64(rule.qBits)): it divides by the channel count (the downmix mean) and by Q\(rule.qBits) at once. Exact halves round toward +infinity: acc=\(rule.roundingBias) -> 1, acc=\(-rule.roundingBias) -> 0, acc=\(-3 * rule.roundingBias) -> -1."),
            clipping: .init(min: DecimationRule.clipMin, max: DecimationRule.clipMax,
                            rule: "After rounding: y > 32767 becomes 32767; y < -32768 becomes -32768."),
            streaming: "Output does not depend on how input frames are split across calls: FIR history and the position within the current 3-frame group carry across calls. At stream start AND at every discontinuity the converter resets: history zero, the next frame is frame 0 of a new group, and frames of an incomplete group buffered before the reset (at most 2) produce no output. Cost: the first 40 output samples of every region (2.5 ms) are computed partly from zero history, deterministically.",
            chunkPatterns: [[1], [2], [3], [7, 13, 480], [1024]],
            tapsRole: tapsRole,
            regionStarts: regionStarts,
            regionsOutput: regionStarts == nil ? nil : FileDigest(file: "expected-16k-mono-regions.pcm", bytes: 0, sha256: ""),
            regionsOutputSamples: regionsCount,
            inputSynthesis: (rule.channels == 1
                ? c9Segments.map { "\($0.frames) frames: \($0.left.text)" }
                : c9Segments.map { "\($0.frames) frames: L \($0.left.text); R \($0.right.text)" })
                + ["tone samples: round(amplitude * 32767 * cos(2*pi*f*n/48000)) with n from 0 at each segment start, rounded half away from zero"])
    }

    /// `outputRule` (default `rule`) computes the expected outputs; a negative control can differ from what its manifest states.
    /// `carryHistory` writes the regions output as if nothing reset at the discontinuities.
    static func c9Draft(name: String, description: String, rule: DecimationRule, tapsRole: String = "production",
                        regionStarts: [Int]? = nil, outputRule: DecimationRule? = nil, carryHistory: Bool = false) -> Draft {
        let input = c9Input(channels: rule.channels)
        let producer = TapeConvertResampler(rule: outputRule ?? rule)
        let output = producer.convert(input48k: input, chunkFrames: [])
        let regions = regionStarts.map { carryHistory ? output : producer.convert(input48k: input, resetAtFrames: $0) }
        let taps = Array(rule.taps.map { "\($0)\n" }.joined().utf8)
        var m = FixtureManifest(schema: FixtureManifest.currentSchema, name: name, description: description,
                                provenance: "synthetic", role: .good, cases: [.C9], negativeControl: nil,
                                pcm: nil, idx: nil, expected: nil, synthesis: nil, resampler: nil, encoder: nil)
        m.resampler = conversionSpec(rule, inputFrames: input.count / (2 * rule.channels), tapsRole: tapsRole, regionStarts: regionStarts)
        if carryHistory, let count = regions.map({ $0.count / 2 }) { m.resampler!.regionsOutputSamples = count }
        var d = Draft(manifest: m, pcm: [], idx: [], expected: ExpectedAnswers())
        d.resampler = (input, output, taps, regions)
        return d
    }

    static var directionProbeRule: DecimationRule {
        var r = DecimationRule.production
        r.taps = directionProbeTaps
        return r
    }

    static func c9Good() -> [Draft] {
        [
            c9Draft(name: "c9-resample-tones",
                    description: "134402 frames of synthetic 48 kHz stereo: independent L/R tones, a 10 kHz tone above the output Nyquist, DC half-steps (-1/0, 0/1, -3/-2) and both rails, a full-scale square that overshoots and clips at both rails, a 7 kHz tone at the cut-off, and 2 trailing frames. Output generated by the production conversion; regions output with resets at frames 52801 and 100800.",
                    rule: .production, regionStarts: c9RegionStarts),
            c9Draft(name: "c9-resample-mono",
                    description: "The same 134402-frame programme as ONE channel (the TONOR TM20's format): channel_count 1, so the downmix is a copy and the output divisor is 65536, not 131072 — unity gain, not half. Regions output with resets at frames 52801 and 100800.",
                    rule: .production(channels: 1), regionStarts: c9RegionStarts),
            c9Draft(name: "c9-direction-probe",
                    description: "The C9 input run through the production arithmetic with deliberately asymmetric taps, so the convolution index direction (h[0] on the newest sample) is pinned.",
                    rule: directionProbeRule, tapsRole: "direction_probe"),
        ]
    }

    static func c9Negatives() -> [Draft] {
        var perturbed = DecimationRule.production
        perturbed.taps[59] += 1
        var shifted = DecimationRule.production
        shifted.phase = 1
        var reversed = directionProbeRule
        reversed.taps = directionProbeTaps.reversed()
        func neg(_ d: Draft, from: String = "good/c9-resample-tones", corruption: String) -> Draft {
            var d = d
            d.manifest.role = .negative
            d.manifest.negativeControl = NegativeControl(targetCase: .C9, derivedFrom: from, corruption: corruption)
            d.manifest.description = "NEGATIVE CONTROL for C9, derived from \(from). \(corruption)"
            return d
        }
        // Divisor-only variants: the framing stays at the fixture's channel count, so only the downmix division differs.
        var sumNotMean = DecimationRule.production
        sumNotMean.divisorChannelsOverride = 1   // 2-channel input divided by 2^16 only: the sum, not the mean
        var monoHalved = DecimationRule.production(channels: 1)
        monoHalved.divisorChannelsOverride = 2   // 1-channel input divided by 2 x 2^16: attenuated by 6 dB
        return [
            neg(c9Draft(name: "c9-downmix-sum-not-mean", description: "", rule: .production, outputRule: sumNotMean),
                corruption: "The 2-channel input converted with the divisor 65536 instead of 131072: the downmix sums the channels instead of averaging them, so every sample is twice the specified value, and clips where the mean would not."),
            neg(c9Draft(name: "c9-mono-attenuated", description: "", rule: .production(channels: 1), outputRule: monoHalved),
                from: "good/c9-resample-mono",
                corruption: "The 1-channel input converted with the 2-channel divisor 131072: a mono copy attenuated by 6 dB, which is what the old 'm = L + R' wording would have produced on a TONOR TM20."),
            neg(c9Draft(name: "c9-coefficient-perturbed", description: "", rule: perturbed),
                corruption: "A self-consistent variant with one coefficient changed: h[59] is 16534 instead of 16533 (tap sum 65537). Taps file, manifest fields and expected output all describe that variant."),
            neg(c9Draft(name: "c9-decimation-phase-shifted", description: "", rule: shifted),
                corruption: "A self-consistent variant with the decimation phase shifted by one input frame: output k taken at acc[3k + 1] instead of acc[3k + 2]. Manifest and expected output describe that variant."),
            neg(c9Draft(name: "c9-convolution-reversed", description: "", rule: directionProbeRule, tapsRole: "direction_probe", outputRule: reversed),
                from: "good/c9-direction-probe",
                corruption: "Same asymmetric taps file, but the expected output was computed with the index reversed: acc[n] = sum h[i]*m[n+i-120] (h[0] on the oldest sample)."),
            neg(c9Draft(name: "c9-history-carried-across-discontinuity", description: "", rule: .production, regionStarts: c9RegionStarts, carryHistory: true),
                corruption: "The regions output carries FIR history and group position across the discontinuities at 52801 and 100800 instead of resetting (what the Mac's AVAudioConverter does)."),
        ]
    }

    /// device_lost and resumed at the same sample, as a real outage writes them: an empty region between them, and the
    /// following piece carries the resumed gap.
    static func deviceLostResumed() -> Draft {
        let syn: [SynthSegment] = [.tone(1000, 0.5, 16_000), SynthSegment(kind: "gap", gapNS: 2_500_000_000), .tone(440, 0.25, 16_000)]
        var b = TapeBuilder(device: dmic, wall: cleanAnchorNS, mono: monoStart, inputRate: ("48000", 3, 1))
        b.checkpoint(0, window: false)
        b.checkpoints(every: 8_000, after: 0, through: 16_000)
        b.discontinuity(16_000, cause: DiscontinuityCause.deviceLost)
        b.discontinuity(16_000, cause: DiscontinuityCause.resumed, gapNS: 2_500_000_000)
        b.checkpoints(every: 8_000, after: 16_000, through: 32_000)
        var e = ExpectedAnswers()
        e.pieces = [PieceRange(sampleStart: 0, sampleEnd: 16_000),
                    PieceRange(sampleStart: 16_000, sampleEnd: 32_000, gapBeforeMS: 2_500)]
        return Draft(manifest: manifest("device-lost-resumed",
                                        "1 s tone, device_lost and resumed (gap_ns 2.5 s) at the same sample 16000, 1 s tone. The piece after them carries the resumed gap; device_lost carries none.",
                                        [.C1, .C2, .C5], syn),
                     pcm: Synth.render(syn), idx: b.idx, expected: e)
    }

    /// U1 spec §11.5: a quiet-room tone (RMS 0.005, 250 Hz sine) with a ring_overflow. The tape is produced by the
    /// production converter with a reset at the gap, so the 20 samples after the boundary are the filter's ramp-up
    /// rounding to zero. C7 must pass with the 40-sample exemption, and would fail without it.
    static func c7QuietRoom() -> Draft {
        let amplitude = 0.005 * 2.0.squareRoot() * 32767.0
        func region(_ frames: Int) -> [UInt8] {
            var bytes: [UInt8] = []
            for n in 0..<frames {
                let v = UInt16(bitPattern: Int16((amplitude * sin(2.0 * Double.pi * 250.0 * Double(n) / 48000.0)).rounded()))
                bytes += [UInt8(v & 0xff), UInt8(v >> 8), UInt8(v & 0xff), UInt8(v >> 8)]
            }
            return bytes
        }
        let converter = TapeConvertResampler()
        let pcm = converter.convert(input48k: region(48_000), chunkFrames: []) + converter.convert(input48k: region(48_000), chunkFrames: [])
        var b = TapeBuilder(device: dmic, wall: cleanAnchorNS, mono: monoStart, inputRate: ("48000", 3, 1))
        b.checkpoint(0, window: false)
        b.checkpoints(every: 8_000, after: 0, through: 16_000)
        b.discontinuity(16_000, cause: DiscontinuityCause.ringOverflow, gapNS: 750_000_000, dropped: 36_000)
        b.checkpoints(every: 8_000, after: 16_000, through: 32_000)
        var e = ExpectedAnswers()
        let ringLine = b.records.firstIndex { $0.discontinuity == DiscontinuityCause.ringOverflow }! + 1
        e.c7 = C7Expected(line: ringLine, cause: DiscontinuityCause.ringOverflow, gapNS: 750_000_000, droppedInputFrames: 36_000,
                          preGapSamples: 16_000, postGapSamples: 16_000)
        var m = manifest("c7-quiet-room-ramp",
                         "U1 spec 11.5. Two 1 s regions of a 250 Hz sine at RMS 0.005 (48 kHz stereo, both channels, starting at a zero crossing), converted by the production conversion with a reset at a 750 ms ring_overflow. The first 20 samples after the boundary are the filter ramp rounding to zero: C7 passes with the 40-sample exemption and would report zero fill without it. rms/peak/zero_ratio in the index are literals.",
                         [.C1, .C2, .C7], [])
        m.synthesis = nil
        return Draft(manifest: m, pcm: pcm, idx: b.idx, expected: e)
    }

    /// Restart onto a tape whose tape.pcm ends in half a sample (Mac TapeWriter.swift:129-133 trims it on startup).
    /// The prior tape (1 s tone, three checkpoints) has one stray byte appended; the production TapeWriter then opens it,
    /// appends 1 s of tone, checkpoints and stops, on fixed clocks. The result must be sample-aligned, with the restart
    /// record at the trimmed length 32000.
    static func restartOddTail() throws -> Draft {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("conformance-odd-tail-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: dir) }
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let first: [SynthSegment] = [.tone(1000, 0.5, 16_000)], second: [SynthSegment] = [.tone(440, 0.25, 16_000)]
        var prior = TapeBuilder(device: dmic, wall: cleanAnchorNS, mono: monoStart, inputRate: ("48000", 3, 1))
        prior.checkpoint(0, window: false)
        prior.checkpoints(every: 8_000, after: 0, through: 16_000)
        try Data(Synth.render(first) + [0x5A]).write(to: dir.appendingPathComponent("tape.pcm"))   // 32 001 bytes
        try Data(prior.idx).write(to: dir.appendingPathComponent("tape.idx"))

        let restartMono = Int64(monoStart) + 60_000_000_000, restartWall = cleanAnchorNS + 60_000_000_000
        let writer = try TapeWriter(directory: dir, device: dmic, inputSampleRate: 48_000,
                                    monoNow: { restartMono }, wallNow: { restartWall + 1_500_000 })
        let seed = writer.prior?.lastInputFrames ?? 0
        let tone = Synth.render(second)
        try writer.append(stride(from: 0, to: tone.count, by: 2).map { Int16(bitPattern: UInt16(tone[$0]) | UInt16(tone[$0 + 1]) << 8) })
        try writer.checkpoint(monoNS: restartMono + 1_010_000_000, wallNS: restartWall + 1_010_000_000, inputFrames: seed + 48_000)
        try writer.stopped(monoNS: restartMono + 1_020_000_000, wallNS: restartWall + 1_020_000_000, inputFrames: seed + 48_000)
        let pcm = [UInt8](try Data(contentsOf: dir.appendingPathComponent("tape.pcm")))
        let idx = [UInt8](try Data(contentsOf: dir.appendingPathComponent("tape.idx")))
        var e = ExpectedAnswers()
        e.c3 = C3Expected(outcome: "clean", records: String(decoding: idx, as: UTF8.self).split(separator: "\n").count)
        return Draft(manifest: manifest("restart-odd-tail-trimmed",
                                        "A prior 1 s tape whose tape.pcm had one stray byte (32001 bytes), continued by the production TapeWriter: the odd byte is trimmed before the restart record, which sits at byte_offset 32000; then 1 s of tone, a checkpoint and stopped (fixed clocks).",
                                        [.C1, .C2, .C3], first + second),
                     pcm: pcm, idx: idx, expected: e)
    }

    // MARK: Negative controls

    static func negative(_ base: Draft, name: String, target: CaseID, corruption: String, _ mutate: (inout Draft) -> Void) -> Draft {
        var d = base
        mutate(&d)
        d.manifest.name = name
        d.manifest.role = .negative
        d.manifest.cases = [target]
        d.manifest.encoder = nil  // only fixtures that serve C10 carry the encoder contract
        d.manifest.negativeControl = NegativeControl(targetCase: target, derivedFrom: "good/\(base.manifest.name)", corruption: corruption)
        d.manifest.description = "NEGATIVE CONTROL for \(target.rawValue), derived from good/\(base.manifest.name). \(corruption)"
        return d
    }

    static func replaceLine(_ idx: [UInt8], _ number: Int, with line: String) -> [UInt8] {
        var lines = String(decoding: idx, as: UTF8.self).components(separatedBy: "\n")
        lines[number - 1] = line
        return Array(lines.joined(separator: "\n").utf8)
    }

    static func negatives(clean: Draft, disc: Draft, torn: Draft, multi: Draft, above: Draft, darwin: Draft, lost: Draft, odd: Draft) -> [Draft] {
        func cleanRecords(_ edit: (inout [SynthRecord]) -> Void) -> [UInt8] {
            var b = cleanShortBuilder()
            edit(&b.records)
            return b.idx
        }
        return [
            negative(clean, name: "c1-offset-not-twice-samples", target: .C1,
                     corruption: "Index line 4 says byte_offset 48002 for samples 24000.") { d in
                d.idx = cleanRecords { $0[3].byteOffsetOverride = 48_002 }
            },
            negative(odd, name: "c1-restart-odd-tail-untrimmed", target: .C1,
                     corruption: "The writer did not trim the stray byte: tape.pcm keeps it at byte 32000 (64001 bytes, odd), and the restart record and everything after it sit one byte late.") { d in
                d.pcm.insert(0x5A, at: 32_000)
                var lines = String(decoding: d.idx, as: UTF8.self).components(separatedBy: "\n")
                let restart = lines.firstIndex { $0.contains("\"discontinuity\":\"restart\"") }!
                for i in restart..<lines.count where !lines[i].isEmpty {
                    lines[i] = lines[i].replacingOccurrences(of: "\"byte_offset\":32000,", with: "\"byte_offset\":32001,")
                        .replacingOccurrences(of: "\"byte_offset\":64000,", with: "\"byte_offset\":64001,")
                }
                d.idx = Array(lines.joined(separator: "\n").utf8)
                d.manifest.synthesis = nil
            },
            negative(clean, name: "c2-unsorted-keys", target: .C2,
                     corruption: "Index line 3 has its keys in reverse order.") { d in
                d.idx = cleanRecords { $0[2].reverseKeys = true }
            },
            negative(clean, name: "c2-escaped-slash", target: .C2,
                     corruption: "Index line 2 writes the device string with an escaped slash (\\/).") { d in
                d.idx = cleanRecords { $0[1].escapeSlashes = true }
            },
            negative(clean, name: "c2-noncanonical-double", target: .C2,
                     corruption: "Index line 2 writes peak as 0.50, not the shortest form 0.5.") { d in
                d.idx = cleanRecords { $0[1].peak = "0.50" }
            },
            negative(darwin, name: "c2-darwin-line-17-digit-double", target: .C2,
                     corruption: "The measured line with e written to 17 significant digits (0.41666666666666669), as a %.17g encoder would; same value, different bytes.") { d in
                d.encoderLine = Array((darwinDoubleLine.replacingOccurrences(of: "0.4166666666666667", with: "0.41666666666666669") + "\n").utf8)
                d.manifest.provenance = "synthetic corruption of a darwin-measured line"
            },
            negative(disc, name: "c2-rms-on-discontinuity", target: .C2,
                     corruption: "The ring_overflow record carries rms, which only checkpoints may carry.") { d in
                var b = discontinuityBuilder()
                let i = b.records.firstIndex { $0.discontinuity == DiscontinuityCause.ringOverflow }!
                b.records[i].rms = "0.1"
                d.idx = b.idx
            },
            negative(torn, name: "c3-blank-line-inside-torn-log", target: .C3,
                     corruption: "A blank line is inserted after line 1 of a torn log; truncating the tail must not be enough.") { d in
                let first = String(decoding: d.idx, as: UTF8.self).components(separatedBy: "\n")[0]
                d.idx = replaceLine(d.idx, 1, with: first + "\n")
            },
            negative(clean, name: "c4-one-sample-lost", target: .C4,
                     corruption: "The last sample is missing from tape.pcm, so the clock at end of tape is 62 500 ns early.") { d in
                d.pcm.removeLast(2)
                d.manifest.synthesis![2].samples! -= 1
            },
            negative(multi, name: "c5-reanchored-seam", target: .C5,
                     corruption: "Piece 1 is re-anchored one sample late: [4800001, 9600001). Both seams break; lengths stay 300 s.") { d in
                d.expected.pieces![1] = PieceRange(sampleStart: 4_800_001, sampleEnd: 9_600_001)
            },
            negative(disc, name: "c5-piece-straddles-discontinuity", target: .C5,
                     corruption: "Pieces ignore the ring_overflow at 24000: one piece spans [0, 40000).") { d in
                d.expected.pieces = [PieceRange(sampleStart: 0, sampleEnd: 40_000),
                                     PieceRange(sampleStart: 40_000, sampleEnd: 48_000)]
            },
            negative(disc, name: "c5-gap-on-preceding-piece", target: .C5,
                     corruption: "gap_before_ms 500 is on the piece before the ring_overflow instead of the one after it.") { d in
                d.expected.pieces = [PieceRange(sampleStart: 0, sampleEnd: 24_000, gapBeforeMS: 500),
                                     PieceRange(sampleStart: 24_000, sampleEnd: 40_000),
                                     PieceRange(sampleStart: 40_000, sampleEnd: 48_000)]
            },
            negative(disc, name: "c5-gap-on-restart", target: .C5,
                     corruption: "The piece after the restart carries gap_before_ms 2000 from its gap_ns; restart is zero by rule.") { d in
                d.expected.pieces![2].gapBeforeMS = 2_000
            },
            negative(above, name: "c5-gap-rounded-down-at-half", target: .C5,
                     corruption: "device_lost 120500000 ns is rounded down to 120 ms; the rule rounds half up to 121.") { d in
                d.expected.pieces![1].gapBeforeMS = 120
            },
            negative(lost, name: "c5-resumed-gap-dropped", target: .C5,
                     corruption: "The piece after device_lost + resumed carries no gap_before_ms, as if only device_lost (zero by rule) applied.") { d in
                d.expected.pieces![1].gapBeforeMS = nil
            },
            negative(multi, name: "c6-first-piece-one-short", target: .C6,
                     corruption: "Piece 0 ends at 4799999 and piece 1 starts there: adjacency holds, lengths are 4799999 and 4800001.") { d in
                d.expected.pieces![0].sampleEnd = 4_799_999
                d.expected.pieces![1].sampleStart = 4_799_999
            },
            negative(disc, name: "c7-zero-filled-gap", target: .C7,
                     corruption: "The 500 ms ring_overflow gap is zero-filled with 8000 silent samples; later offsets move by 16000 bytes.") { d in
                d.pcm.insert(contentsOf: repeatElement(UInt8(0), count: 16_000), at: 48_000)
                d.manifest.synthesis!.insert(.silence(8_000), at: 2)
                d.idx = discontinuityBuilder(zeroFill: 8_000).idx
            },
        ]
    }

    // MARK: Writing

    public static func generate(into root: URL, force: Bool) throws -> [String] {
        let fm = FileManager.default
        if fm.fileExists(atPath: root.path) {
            guard force else {
                throw FixtureLoadError(fixture: root.path, reason: "exists; fixtures are not regenerated casually (pass --force)")
            }
            try fm.removeItem(at: root)
        }
        // C10's fixture must name the encoder it was recorded against; refuse to write one that cannot.
        let env: EncoderEnvironment
        switch EncoderEnvironment.detect() {
        case .success(let v): env = v
        case .failure(let err): throw FixtureLoadError(fixture: "good/clean-short", reason: "cannot record the C10 encoder: \(err)")
        }
        guard env.libopusCompiledIn else {
            throw FixtureLoadError(fixture: "good/clean-short", reason: "libopus is not compiled into \(env.ffmpegPath): \(env.opusEncoders)")
        }
        let clean = try cleanShort(encoder: env), disc = discontinuity(), torn = tornTail()
        let blank = interiorBlank(), multi = multiPiece(), multiGap = multiPieceGap(), midnight = try istMidnight()
        let below = gapRoundingBelow(), above = gapRoundingAbove(), darwin = darwinDoubles(), lost = deviceLostResumed(), quiet = c7QuietRoom(), odd = try restartOddTail()
        let two = try twoRollovers().0, before = try beforeFirstAudio(), quietMidnight = try quietRoomMidnight(), lostMidnight = try deviceLostAtMidnight()
        let midGroup = try discontinuityMidGroup(), coincident = coincidentGaps()
        var written: [String] = []
        for d in [clean, disc, torn, blank, multi, multiGap, below, above, midnight, two, before, quietMidnight, lostMidnight, midGroup, coincident, darwin, lost, quiet, odd] + c9Good() {
            written.append(try write(d, to: root.appendingPathComponent("good").appendingPathComponent(d.manifest.name)))
        }
        for d in negatives(clean: clean, disc: disc, torn: torn, multi: multi, above: above, darwin: darwin, lost: lost, odd: odd) + c9Negatives()
            + (try rolloverNegatives(midnight: midnight, two: two, before: before, quiet: quietMidnight, lost: lostMidnight, coincident: coincident)) {
            written.append(try write(d, to: root.appendingPathComponent("negative").appendingPathComponent(d.manifest.name)))
        }
        return written
    }

    static func write(_ draft: Draft, to dir: URL) throws -> String {
        let fm = FileManager.default
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        var m = draft.manifest

        let pretty = JSONEncoder()
        pretty.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let expected = [UInt8](try pretty.encode(draft.expected)) + [0x0A]

        func put(_ bytes: [UInt8], _ file: String) throws -> FileDigest {
            try Data(bytes).write(to: dir.appendingPathComponent(file))
            return FileDigest(file: file, bytes: Int64(bytes.count), sha256: SHA256.hex(bytes))
        }
        if let r = draft.resampler, var spec = m.resampler {
            spec.input = try put(r.input, spec.input.file)
            spec.output = try put(r.output, spec.output.file)
            spec.taps = try put(r.taps, spec.taps.file)
            if let regions = r.regions, let file = spec.regionsOutput { spec.regionsOutput = try put(regions, file.file) }
            m.resampler = spec
        } else if m.cases != [.C2] || draft.encoderLine.isEmpty {
            m.pcm = try put(draft.pcm, "tape.pcm")
            m.idx = try put(draft.idx, "tape.idx")
        }
        if !draft.encoderLine.isEmpty { m.encoderLine = try put(draft.encoderLine, "encoder-line.json") }
        m.expected = try put(expected, "expected.json")
        try (pretty.encode(m) + Data([0x0A])).write(to: dir.appendingPathComponent(FixtureLoader.manifestFile))
        return "\(draft.manifest.role.rawValue)/\(draft.manifest.name)  pcm \(draft.pcm.count) B  idx \(draft.idx.count) B"
    }

    // MARK: Attesting another encoder version pair

    /// Measures C10's decoded audio with the running encoder and, only if it is within the fixture's
    /// unchanged tolerance, records the version pair in `encoder.also_verified`. Returns the measurement line.
    public static func attestEncoder(fixture dir: URL) throws -> String {
        let root = dir.deletingLastPathComponent().deletingLastPathComponent()
        let f = try FixtureLoader.load(dir, root: root)
        guard var contract = f.manifest.encoder else { throw FixtureLoadError(fixture: f.id, reason: "has no encoder block") }
        let env: EncoderEnvironment
        switch EncoderEnvironment.detect() {
        case .success(let v): env = v
        case .failure(let err): throw FixtureLoadError(fixture: f.id, reason: "cannot establish the encoder: \(err)")
        }
        let m: C10Measured
        switch C10Probe.measure(pcm: f.pcm, env: env, maxLag: contract.tolerance.maxLagSamples) {
        case .success(let v): m = v
        case .failure(let err): throw FixtureLoadError(fixture: f.id, reason: "\(err)")
        }
        let line = "\(env.ffmpegVersion) / \(env.libopusVersion) on \(env.host): \(m.summary)"
        let violations = m.violations(contract.tolerance)
        guard violations.isEmpty else {
            throw FixtureLoadError(fixture: f.id, reason: "outside tolerance, not attested and tolerance not widened: \(violations.joined(separator: "; ")) — \(line)")
        }
        if env.ffmpegVersion == contract.ffmpegVersion && env.libopusVersion == contract.libopusVersion {
            return "reference pair, nothing to attest — \(line)"
        }
        contract.alsoVerified.removeAll { $0.ffmpegVersion == env.ffmpegVersion && $0.libopusVersion == env.libopusVersion }
        contract.alsoVerified.append(EncoderAttestation(ffmpegVersion: env.ffmpegVersion, libopusVersion: env.libopusVersion,
                                                        libopusLibrary: env.libopusLibrary, opusEncoders: env.opusEncoders,
                                                        recordedOn: env.host, measurement: m))
        var manifest = f.manifest
        manifest.encoder = contract
        let pretty = JSONEncoder()
        pretty.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try (pretty.encode(manifest) + Data([0x0A])).write(to: dir.appendingPathComponent(FixtureLoader.manifestFile))
        return "attested — \(line)"
    }
}
