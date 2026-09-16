import Foundation

// MARK: - Manifest schema (manifest.json)
//
// A fixture is a directory:
//   manifest.json  — this schema: what the fixture is, which cases it serves, file digests
//   tape.pcm       — raw s16le mono 16 kHz, synthesised (never recorded audio)
//   tape.idx       — newline-delimited JSON index
//   expected.json  — the expected answers, keyed by case id
// See FIXTURES.md in the repository root for the field-by-field description.

public enum CaseID: String, Codable, CaseIterable, Comparable, Sendable {
    case C1, C2, C3, C4, C5, C6, C7, C8, C9, C10
    /// U2 S3 + the indefinite run. Unlike C1-C10 this case is NOT fixture-driven: it has no tape to read, because
    /// what it pins is a startup decision (which of ABSENT / BUSY / WRONG a probe result is, and what each does) and
    /// a run-length rule. S3Harness generates its own rows from scripted probe sequences and a fake clock, the same
    /// way C9Harness generates its own; see Suite.run.
    case S3
    public static func < (a: CaseID, b: CaseID) -> Bool {
        allCases.firstIndex(of: a)! < allCases.firstIndex(of: b)!
    }
}

public enum FixtureRole: String, Codable, Sendable {
    /// Must PASS every case it lists.
    case good
    /// A deliberately corrupted copy. Must FAIL the single case it lists.
    case negative
}

public struct FileDigest: Codable, Equatable, Sendable {
    public var file: String
    public var bytes: Int64
    public var sha256: String
}

public struct NegativeControl: Codable, Equatable, Sendable {
    public var targetCase: CaseID
    public var derivedFrom: String
    public var corruption: String
    enum CodingKeys: String, CodingKey {
        case targetCase = "target_case", derivedFrom = "derived_from", corruption
    }
}

/// How tape.pcm was synthesised, in order. `gap` contributes no PCM: it documents a discontinuity.
public struct SynthSegment: Codable, Equatable, Sendable {
    public var kind: String            // "tone" | "silence" | "gap"
    public var samples: Int64?         // tone, silence
    public var freqHz: Int?            // tone
    public var amplitude: Double?      // tone, fraction of full scale
    public var gapNS: Int64?           // gap
    public var droppedInputFrames: Int64?  // gap
    enum CodingKeys: String, CodingKey {
        case kind, samples, amplitude
        case freqHz = "freq_hz", gapNS = "gap_ns", droppedInputFrames = "dropped_input_frames"
    }

    public static func tone(_ hz: Int, _ amplitude: Double, _ samples: Int64) -> SynthSegment {
        SynthSegment(kind: "tone", samples: samples, freqHz: hz, amplitude: amplitude)
    }
    public static func silence(_ samples: Int64) -> SynthSegment {
        SynthSegment(kind: "silence", samples: samples)
    }
    public static func gap(ns: Int64, droppedInputFrames: Int64) -> SynthSegment {
        SynthSegment(kind: "gap", gapNS: ns, droppedInputFrames: droppedInputFrames)
    }
}

/// C9 only: the conversion under test, specified field by field (spec/CONVERSION-48K-TO-16K-MONO.md),
/// with its checked-in input, output and taps. Numeric fields are compared with the linked implementation;
/// the rule strings are the written specification and are carried so the fixture stands alone.
public struct ResamplerFixture: Codable, Equatable, Sendable {
    public var design: String
    public var specification: String
    public var input: FileDigest
    public var output: FileDigest
    public var taps: FileDigest
    public var inputFrames: Int
    /// Channels in the input file: 1 copies, more than 1 is averaged (conversion spec §2).
    public var channelCount: Int
    public var outputSamples: Int
    public var inputFormat: String
    public var outputFormat: String
    public var downmix: String
    public var filter: FilterSpec
    public var accumulator: AccumulatorSpec
    public var decimation: DecimationSpec
    public var outputRounding: RoundingSpec
    public var clipping: ClippingSpec
    public var streaming: String
    /// Frame-count patterns the input is split into (cycled); every split must give the whole-stream output.
    public var chunkPatterns: [[Int]]
    /// "production": the taps must equal the implementation's. "direction_probe": deliberately asymmetric taps run
    /// through the implementation's arithmetic, so a reversed convolution index cannot pass.
    public var tapsRole: String
    /// Input frames before which a discontinuity resets the converter; `regions_output` is the expected result.
    public var regionStarts: [Int]?
    public var regionsOutput: FileDigest?
    public var regionsOutputSamples: Int?
    public var inputSynthesis: [String]

    enum CodingKeys: String, CodingKey {
        case design, specification, input, output, taps, downmix, filter, accumulator, decimation, clipping, streaming
        case inputFrames = "input_frames", channelCount = "channel_count", outputSamples = "output_samples", inputFormat = "input_format"
        case outputFormat = "output_format", outputRounding = "output_rounding", chunkPatterns = "chunk_patterns"
        case inputSynthesis = "input_synthesis"
        case tapsRole = "taps_role", regionStarts = "region_starts", regionsOutput = "regions_output"
        case regionsOutputSamples = "regions_output_samples"
    }

    public struct FilterSpec: Codable, Equatable, Sendable {
        public var tapCount: Int
        public var qBits: Int
        public var tapSum: Int64
        public var symmetric: Bool
        public var cutoffHz: Double
        public var window: String
        public var kaiserBeta: Double
        public var design: String
        public var rule: String
        enum CodingKeys: String, CodingKey {
            case symmetric, window, design, rule
            case tapCount = "tap_count", qBits = "q_bits", tapSum = "tap_sum", cutoffHz = "cutoff_hz", kaiserBeta = "kaiser_beta"
        }
    }
    public struct AccumulatorSpec: Codable, Equatable, Sendable {
        public var bits: Int
        public var signed: Bool
        public var historyAtStart: String
        public var rule: String
        enum CodingKeys: String, CodingKey { case bits, signed, rule, historyAtStart = "history_at_start" }
    }
    public struct DecimationSpec: Codable, Equatable, Sendable {
        public var factor: Int
        public var phase: Int
        public var rule: String
    }
    public struct RoundingSpec: Codable, Equatable, Sendable {
        public var bias: Int64
        /// channels × 2^qBits: the single division of the conversion (§5).
        public var divisor: Int64
        public var rule: String
    }
    public struct ClippingSpec: Codable, Equatable, Sendable {
        public var min: Int64
        public var max: Int64
        public var rule: String
    }
}

public struct FixtureManifest: Codable, Equatable, Sendable {
    public static let currentSchema = "eta.room-recorder.u0.fixture/1"

    public var schema: String
    public var name: String
    public var description: String
    /// "synthetic" or "mac:<commit>". PCM is always synthetic.
    public var provenance: String
    public var role: FixtureRole
    public var cases: [CaseID]
    public var negativeControl: NegativeControl?
    public var pcm: FileDigest?
    public var idx: FileDigest?
    public var expected: FileDigest?
    public var synthesis: [SynthSegment]?
    public var resampler: ResamplerFixture?
    /// Required when `cases` contains C10.
    public var encoder: EncoderContract?
    /// C2 only: a JSON line measured as encoder output on another platform, stored byte for byte plus 0x0A.
    public var encoderLine: FileDigest?

    enum CodingKeys: String, CodingKey {
        case schema, name, description, provenance, role, cases, pcm, idx, expected, synthesis, resampler, encoder
        case encoderLine = "encoder_line"
        case negativeControl = "negative_control"
    }
}

// MARK: - Expected answers (expected.json)

public struct ExpectedAnswers: Codable, Equatable, Sendable {
    public var c2: C2EncoderLineExpected?
    public var c3: C3Expected?
    public var c4: ClockExpected?
    public var pieces: [PieceRange]?
    public var c6: C6Expected?
    public var c7: C7Expected?
    public var c8: C8Expected?

    public init() {}

    enum CodingKeys: String, CodingKey {
        case c2 = "C2", c3 = "C3", c4 = "C4", pieces, c6 = "C6", c7 = "C7", c8 = "C8"
    }
}

/// The source Doubles behind an `encoder_line`. Each value is a decimal literal ("0.0317") or a quotient
/// of two decimal literals ("1.0/3.0"), exactly as the measurement stated them.
public struct C2EncoderLineExpected: Codable, Equatable, Sendable {
    public var measuredOn: String
    public var outputFormatting: [String]
    public var values: [String: String]
    enum CodingKeys: String, CodingKey {
        case values
        case measuredOn = "measured_on", outputFormatting = "output_formatting"
    }

    public static func source(_ spec: String) -> Double? {
        let parts = spec.split(separator: "/").map { Double($0.trimmingCharacters(in: .whitespaces)) }
        switch parts.count {
        case 1: return parts[0]
        case 2: if let p = parts[0], let q = parts[1] { return p / q }; return nil
        default: return nil
        }
    }
}

public struct C3Expected: Codable, Equatable, Sendable {
    /// "clean" | "torn_tail" | "hard_error"
    public var outcome: String
    public var records: Int?
    public var repairedLength: Int?
    public var droppedBytes: Int?
    /// hard_error: "interior_blank_line"
    public var error: String?
    public var line: Int?
    enum CodingKeys: String, CodingKey {
        case outcome, records, error, line
        case repairedLength = "repaired_length", droppedBytes = "dropped_bytes"
    }
}

public struct ClockPoint: Codable, Equatable, Sendable {
    public var name: String
    /// "sample:<n>" | "record:<line>" (that line's `samples`) | "pcm_end" (tape.pcm bytes / 2)
    public var at: String
    public var wallNS: Int64
    enum CodingKeys: String, CodingKey { case name, at, wallNS = "wall_ns" }
}

/// The clock anchor has no field of its own: it is read from the index (TapeRegions), never from here.
public struct ClockExpected: Codable, Equatable, Sendable {
    public var points: [ClockPoint]
}

public struct C6Expected: Codable, Equatable, Sendable {
    public var pieceSamples: Int64
    public var fullPieces: Int
    /// Lengths of the pieces closed short by a region end (a discontinuity or the tape tail), in order.
    public var partialPieces: [Int64]
    enum CodingKeys: String, CodingKey {
        case pieceSamples = "piece_samples", fullPieces = "full_pieces", partialPieces = "partial_pieces"
    }
}

public struct C7Expected: Codable, Equatable, Sendable {
    /// 1-based index line carrying the discontinuity.
    public var line: Int
    /// The record's `discontinuity` value.
    public var cause: String
    /// Both nil for a gapless boundary (day_rollover): the record must then carry neither key.
    public var gapNS: Int64?
    public var droppedInputFrames: Int64?
    /// Real audio samples written before and after the gap. The tape holds exactly their sum.
    public var preGapSamples: Int64
    public var postGapSamples: Int64
    enum CodingKeys: String, CodingKey {
        case line, cause
        case gapNS = "gap_ns", droppedInputFrames = "dropped_input_frames"
        case preGapSamples = "pre_gap_samples", postGapSamples = "post_gap_samples"
    }
}

/// Every day_rollover record of the tape, in order. The laws C8 applies are read off the tape; these values pin them.
public struct C8Expected: Codable, Equatable, Sendable {
    public var rollovers: [C8Rollover]
}

public struct C8Rollover: Codable, Equatable, Sendable {
    /// 1-based index line of the day_rollover record.
    public var line: Int
    /// The marker's wall_ns: the target IST midnight.
    public var boundaryWallNS: Int64
    public var markerMonoNS: Int64
    /// The marker's `samples`: old-day samples end here.
    public var rolloverSample: Int64
    /// nil: the record carries no input_frames.
    public var inputFrames: Int64?
    /// wall_ns of the forced checkpoint at the marker's sample (end of the old-day audio); nil if the tape has none.
    public var prefixEndWallNS: Int64?
    /// wall_ns of the capture anchor right after the marker (the suffix's first wall_ns); nil if the tape has none.
    public var suffixWallNS: Int64?
    /// Midnight falls strictly inside an input frame: prefix end == suffix start > boundary.
    public var straddling: Bool
    enum CodingKeys: String, CodingKey {
        case line, straddling
        case boundaryWallNS = "boundary_wall_ns", markerMonoNS = "marker_mono_ns", rolloverSample = "rollover_sample"
        case inputFrames = "input_frames", prefixEndWallNS = "prefix_end_wall_ns", suffixWallNS = "suffix_wall_ns"
    }
}

/// C10's decoded-audio tolerance. Every bound is stated; none has a default.
public struct C10Tolerance: Codable, Equatable, Sendable {
    /// How the three bounds are computed, in words, so the numbers cannot be reinterpreted.
    public var method: String
    /// |decoded samples − input samples| ≤ this.
    public var maxSampleCountDelta: Int
    /// The correlation search covers lags in [−this, +this] samples.
    public var maxLagSamples: Int
    /// Best normalised cross-correlation over that lag range ≥ this.
    public var minCorrelation: Double
    /// |20·log10(RMS decoded / RMS input)| ≤ this, in dB.
    public var maxRMSDeltaDB: Double
    enum CodingKeys: String, CodingKey {
        case method
        case maxSampleCountDelta = "max_sample_count_delta", maxLagSamples = "max_lag_samples"
        case minCorrelation = "min_correlation", maxRMSDeltaDB = "max_rms_delta_db"
    }
}

/// C10's contract, stated in the manifest. The versions are provenance: C10 never asserts on
/// encoded bytes, so a different ffmpeg or libopus must not, by itself, fail the case.
public struct EncoderContract: Codable, Equatable, Sendable {
    /// First line of `ffmpeg -version` on the machine that recorded this fixture, verbatim.
    public var ffmpegVersion: String
    /// `opus_get_version_string()` of the libopus that ffmpeg linked on that machine.
    public var libopusVersion: String
    /// The libopus shared object that string was read from.
    public var libopusLibrary: String
    /// `ffmpeg -encoders` lines matching opus, verbatim, showing libopus compiled in.
    public var opusEncoders: [String]
    /// PRETTY_NAME of the recording host. Not necessarily a fleet OS.
    public var recordedOn: String
    /// The piece encoder arguments (PiecePipeline.swift:485-496, no executable name), with "{input}" and
    /// "{output}" placeholders. Asserted byte for byte.
    public var argv: [String]
    public var tolerance: C10Tolerance
    /// The decoded-audio measurement taken with the encoder above when the fixture was generated.
    public var referenceMeasurement: C10Measured
    /// Other encoder version pairs that were measured within the same tolerance, appended by
    /// `conformance attest-encoder`. The tolerance is never widened to admit one.
    public var alsoVerified: [EncoderAttestation]
    enum CodingKeys: String, CodingKey {
        case argv, tolerance
        case ffmpegVersion = "ffmpeg_version", libopusVersion = "libopus_version", libopusLibrary = "libopus_library"
        case opusEncoders = "opus_encoders", recordedOn = "recorded_on"
        case referenceMeasurement = "reference_measurement", alsoVerified = "also_verified"
    }
}

/// What C10's decoded-audio assertion measured.
public struct C10Measured: Codable, Equatable, Sendable {
    public var inputSamples: Int
    public var decodedSamples: Int
    public var bestLagSamples: Int
    public var correlation: Double
    public var rmsDeltaDB: Double
    enum CodingKeys: String, CodingKey {
        case correlation
        case inputSamples = "input_samples", decodedSamples = "decoded_samples"
        case bestLagSamples = "best_lag_samples", rmsDeltaDB = "rms_delta_db"
    }

    public func violations(_ t: C10Tolerance) -> [String] {
        var v: [String] = []
        if abs(decodedSamples - inputSamples) > t.maxSampleCountDelta {
            v.append("sample count Δ \(decodedSamples - inputSamples) exceeds ±\(t.maxSampleCountDelta)")
        }
        if correlation < t.minCorrelation { v.append("correlation \(correlation) at lag \(bestLagSamples) < \(t.minCorrelation)") }
        if abs(rmsDeltaDB) > t.maxRMSDeltaDB { v.append("RMS Δ \(rmsDeltaDB) dB exceeds ±\(t.maxRMSDeltaDB)") }
        return v
    }

    public var summary: String {
        "decoded \(decodedSamples)/\(inputSamples) samples (Δ \(decodedSamples - inputSamples)), best lag \(bestLagSamples), "
            + "correlation \(String(format: "%.5f", correlation)), RMS Δ \(String(format: "%+.4f", rmsDeltaDB)) dB"
    }
}

public struct EncoderAttestation: Codable, Equatable, Sendable {
    public var ffmpegVersion: String
    public var libopusVersion: String
    public var libopusLibrary: String
    public var opusEncoders: [String]
    public var recordedOn: String
    public var measurement: C10Measured
    enum CodingKeys: String, CodingKey {
        case measurement
        case ffmpegVersion = "ffmpeg_version", libopusVersion = "libopus_version", libopusLibrary = "libopus_library"
        case opusEncoders = "opus_encoders", recordedOn = "recorded_on"
    }
}

// MARK: - Loader

public struct FixtureLoadError: Error, CustomStringConvertible {
    public let fixture: String
    public let reason: String
    public var description: String { "\(fixture): \(reason)" }
}

public struct Fixture {
    public let url: URL
    /// Path relative to the fixtures root, e.g. "good/clean-short".
    public let id: String
    public let manifest: FixtureManifest
    public let pcm: [UInt8]
    public let idx: [UInt8]
    public let expected: ExpectedAnswers
    public var encoderLine: [UInt8] = []
    public var resamplerInput: [UInt8] = []
    public var resamplerOutput: [UInt8] = []
    public var resamplerTaps: [UInt8] = []
    public var resamplerRegionsOutput: [UInt8] = []
}

public enum FixtureLoader {
    public static let manifestFile = "manifest.json"

    /// Every directory under `root` (depth ≤ 2) that holds a manifest.json, sorted by id.
    public static func discover(root: URL) throws -> [URL] {
        let fm = FileManager.default
        var found: [URL] = []
        func visit(_ dir: URL, depth: Int) throws {
            if fm.fileExists(atPath: dir.appendingPathComponent(manifestFile).path) {
                found.append(dir)
                return
            }
            guard depth < 2 else { return }
            for name in try fm.contentsOfDirectory(atPath: dir.path).sorted() where !name.hasPrefix(".") {
                let child = dir.appendingPathComponent(name)
                var isDir: ObjCBool = false
                if fm.fileExists(atPath: child.path, isDirectory: &isDir), isDir.boolValue {
                    try visit(child, depth: depth + 1)
                }
            }
        }
        try visit(root, depth: 0)
        return found
    }

    public static func load(_ dir: URL, root: URL) throws -> Fixture {
        let id = String(dir.standardizedFileURL.path.dropFirst(root.standardizedFileURL.path.count))
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        func fail(_ reason: String) -> FixtureLoadError { FixtureLoadError(fixture: id, reason: reason) }

        let manifestData: Data
        do { manifestData = try Data(contentsOf: dir.appendingPathComponent(manifestFile)) } catch { throw fail("cannot read manifest.json: \(error)") }
        let manifest: FixtureManifest
        do { manifest = try JSONDecoder().decode(FixtureManifest.self, from: manifestData) } catch { throw fail("manifest.json does not match schema: \(error)") }
        guard manifest.schema == FixtureManifest.currentSchema else { throw fail("schema \(manifest.schema) is not \(FixtureManifest.currentSchema)") }
        guard !manifest.cases.isEmpty else { throw fail("manifest names no cases") }
        switch manifest.role {
        case .good:
            guard manifest.negativeControl == nil else { throw fail("a good fixture must not carry negative_control") }
        case .negative:
            guard let nc = manifest.negativeControl else { throw fail("a negative fixture must carry negative_control") }
            guard manifest.cases == [nc.targetCase] else { throw fail("a negative fixture lists exactly its target case") }
        }

        func read(_ d: FileDigest?, _ what: String) throws -> [UInt8] {
            guard let d else { return [] }
            let bytes: [UInt8]
            do { bytes = [UInt8](try Data(contentsOf: dir.appendingPathComponent(d.file))) } catch { throw fail("cannot read \(d.file): \(error)") }
            guard Int64(bytes.count) == d.bytes else { throw fail("\(d.file) is \(bytes.count) bytes, manifest says \(d.bytes)") }
            let digest = SHA256.hex(bytes)
            guard digest == d.sha256 else { throw fail("\(d.file) sha256 \(digest) != manifest \(d.sha256)") }
            return bytes
        }
        if manifest.cases.contains(.C10) {
            guard let e = manifest.encoder else { throw fail("serves C10 but manifest.json has no encoder block") }
            guard e.ffmpegVersion.hasPrefix("ffmpeg version ") else { throw fail("encoder.ffmpeg_version does not name an ffmpeg version") }
            guard e.libopusVersion.hasPrefix("libopus ") else { throw fail("encoder.libopus_version does not name a libopus version") }
            guard e.opusEncoders.contains(where: { $0.split(separator: " ").contains("libopus") }) else {
                throw fail("encoder.opus_encoders does not show libopus compiled into ffmpeg")
            }
            guard !e.argv.isEmpty, !e.tolerance.method.isEmpty else { throw fail("encoder.argv or tolerance.method is empty") }
            let t = e.tolerance
            guard t.maxSampleCountDelta >= 0, t.maxLagSamples >= 0, t.minCorrelation.isFinite, t.minCorrelation > 0,
                  t.minCorrelation <= 1, t.maxRMSDeltaDB.isFinite, t.maxRMSDeltaDB >= 0 else {
                throw fail("encoder.tolerance has an out-of-range bound")
            }
            guard e.referenceMeasurement.violations(t).isEmpty else {
                throw fail("encoder.reference_measurement is outside encoder.tolerance")
            }
            for a in e.alsoVerified where !a.ffmpegVersion.hasPrefix("ffmpeg version ") || !a.libopusVersion.hasPrefix("libopus ")
                || !a.measurement.violations(t).isEmpty {
                throw fail("encoder.also_verified entry for \(a.recordedOn) does not name versions or is outside tolerance")
            }
        }
        let pcm = try read(manifest.pcm, "pcm")
        let idx = try read(manifest.idx, "idx")
        let expectedBytes = try read(manifest.expected, "expected")
        var expected = ExpectedAnswers()
        if !expectedBytes.isEmpty {
            do { expected = try JSONDecoder().decode(ExpectedAnswers.self, from: Data(expectedBytes)) } catch { throw fail("expected.json does not match schema: \(error)") }
        }
        if let synthesis = manifest.synthesis {
            let declared = synthesis.reduce(Int64(0)) { $0 + ($1.kind == "gap" ? 0 : ($1.samples ?? 0)) }
            guard declared * TapeFormat.bytesPerSample == Int64(pcm.count) else {
                throw fail("synthesis declares \(declared) samples but tape.pcm holds \(pcm.count) bytes")
            }
        }
        var fixture = Fixture(url: dir, id: id, manifest: manifest, pcm: pcm, idx: idx, expected: expected)
        fixture.encoderLine = try read(manifest.encoderLine, "encoder line")
        if manifest.cases.contains(.C9) {
            guard let r = manifest.resampler else { throw fail("serves C9 but manifest.json has no resampler block") }
            fixture.resamplerInput = try read(r.input, "resampler input")
            fixture.resamplerOutput = try read(r.output, "resampler output")
            fixture.resamplerTaps = try read(r.taps, "resampler taps")
            fixture.resamplerRegionsOutput = try read(r.regionsOutput, "resampler regions output")
        }
        return fixture
    }
}
