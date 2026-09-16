import Foundation
import TapeConvert

/// The 48 kHz → 16 kHz mono conversion as C9 sees it, at the fixture's channel count.
public protocol Resampler: Sendable {
    var rule: DecimationRule { get }
    /// s16le 48 kHz interleaved at rule.channels in, s16le 16 kHz mono out. `chunkFrames` is cycled to split the input
    /// into calls; empty means one call.
    func convert(input48k: [UInt8], chunkFrames: [Int]) -> [UInt8]
    /// The same conversion with a reset (a discontinuity) before each listed input frame.
    func convert(input48k: [UInt8], resetAtFrames: [Int]) -> [UInt8]
    /// The same arithmetic with other taps: used only by direction-probe fixtures.
    func with(taps: [Int32]) -> any Resampler
    /// The same arithmetic at another channel count.
    func with(channels: Int) -> any Resampler
}

/// The implementation in TapeConvert, adapted for the suite.
public struct TapeConvertResampler: Resampler {
    public let rule: DecimationRule
    public init(rule: DecimationRule = .production) { self.rule = rule }

    public func with(taps: [Int32]) -> any Resampler {
        var r = rule
        r.taps = taps
        return TapeConvertResampler(rule: r)
    }

    public func with(channels: Int) -> any Resampler {
        var r = rule
        r.channels = channels
        return TapeConvertResampler(rule: r)
    }

    public func convert(input48k: [UInt8], resetAtFrames: [Int]) -> [UInt8] {
        var decimator = Decimator(rule: rule)
        var samples: [Int16] = []
        var start = 0
        let bpf = decimator.bytesPerFrame
        for boundary in resetAtFrames.sorted() + [input48k.count / bpf] where boundary >= start {
            decimator.process(interleaved: input48k[(start * bpf)..<(boundary * bpf)], into: &samples)
            if boundary * bpf < input48k.count { decimator.reset() }
            start = boundary
        }
        return Self.bytes(samples)
    }

    static func bytes(_ samples: [Int16]) -> [UInt8] {
        var out = [UInt8]()
        out.reserveCapacity(samples.count * 2)
        for s in samples {
            let u = UInt16(bitPattern: s)
            out.append(UInt8(u & 0xff))
            out.append(UInt8(u >> 8))
        }
        return out
    }

    public func convert(input48k: [UInt8], chunkFrames: [Int]) -> [UInt8] {
        var decimator = Decimator(rule: rule)
        var samples: [Int16] = []
        samples.reserveCapacity(input48k.count / (decimator.bytesPerFrame * 3))
        if chunkFrames.isEmpty {
            decimator.process(interleaved: input48k, into: &samples)
        } else {
            var offset = 0, k = 0
            while offset < input48k.count {
                let end = min(input48k.count, offset + max(1, chunkFrames[k % chunkFrames.count]) * decimator.bytesPerFrame)
                decimator.process(interleaved: input48k[offset..<end], into: &samples)
                offset = end
                k += 1
            }
        }
        return Self.bytes(samples)
    }
}

/// C9 pins determinism, not Mac parity (RULINGS R7): a fixed 48 kHz stereo input produces a byte-identical 16 kHz
/// mono output every run, on every machine, from the written specification.
public enum C9Harness {
    public static func run(fixtures: [Fixture], resampler: (any Resampler)?) -> [(fixture: String, verdict: Verdict)] {
        let c9 = fixtures.filter { $0.manifest.cases.contains(.C9) }
        if c9.isEmpty {
            return [("-", .skipped("no C9 fixture present"))]
        }
        return c9.map { f in (f.id, run(f, resampler)) }
    }

    /// Parses a taps file: decimal integers, one per line, every line terminated by 0x0A, nothing else.
    static func parseTaps(_ bytes: [UInt8]) -> [Int32]? {
        guard bytes.last == 0x0A else { return nil }
        var taps: [Int32] = []
        for line in bytes.dropLast().split(separator: 0x0A, omittingEmptySubsequences: false) {
            guard let v = Int32(String(decoding: line, as: UTF8.self)), String(v) == String(decoding: line, as: UTF8.self) else { return nil }
            taps.append(v)
        }
        return taps
    }

    static func sample(_ bytes: [UInt8], _ k: Int) -> Int16 {
        let lo = UInt16(bytes[2 * k])
        let hi = UInt16(bytes[2 * k + 1])
        return Int16(bitPattern: lo | (hi << 8))
    }

    static func firstDifference(_ a: [UInt8], _ b: [UInt8]) -> String {
        let n = min(a.count, b.count) / 2
        let differing = (0..<n).filter { sample(a, $0) != sample(b, $0) }
        if let k = differing.first {
            return "first difference at output sample \(k): expected \(sample(a, k)), produced \(sample(b, k)); \(differing.count) of \(n) samples differ"
        }
        return a.count == b.count ? "identical" : "lengths differ: expected \(a.count / 2) samples, produced \(b.count / 2)"
    }

    static func run(_ f: Fixture, _ resampler: (any Resampler)?) -> Verdict {
        guard let r = f.manifest.resampler else { return .error("C9 fixture has no resampler block") }
        guard let resampler else { return .skipped("C9 fixture present but no resampler is linked into this build") }
        guard let fixtureTaps = parseTaps(f.resamplerTaps) else { return .error("\(r.taps.file) is not one decimal integer per \\n-terminated line") }
        var impl = resampler.rule
        impl.channels = r.channelCount
        var c = Checks()
        // A direction probe runs the implementation's arithmetic with the fixture's deliberately asymmetric taps.
        let subject: any Resampler
        switch r.tapsRole {
        case "production": subject = resampler.with(channels: r.channelCount)
        case "direction_probe":
            c.law("C9.direction-probe")
            c.expect(fixtureTaps != fixtureTaps.reversed(), "a direction probe needs asymmetric taps; \(r.taps.file) is symmetric")
            subject = resampler.with(taps: fixtureTaps).with(channels: r.channelCount)
        default: return .error("unknown taps_role \(r.tapsRole)")
        }

        // The written rules, field by field, against the implementation.
        c.law("C9.manifest-describes-implementation")
        c.expect(r.design == impl.designID, "design \(r.design) != implementation \(impl.designID)")
        c.expect(r.channelCount >= 1, "channel_count \(r.channelCount) is not a positive channel count")
        c.expect(r.filter.tapCount == fixtureTaps.count, "filter.tap_count \(r.filter.tapCount) but \(r.taps.file) holds \(fixtureTaps.count) taps")
        c.expect(r.filter.tapSum == fixtureTaps.reduce(Int64(0)) { $0 + Int64($1) }, "filter.tap_sum \(r.filter.tapSum) but \(r.taps.file) sums to \(fixtureTaps.reduce(Int64(0)) { $0 + Int64($1) })")
        c.expect(r.filter.symmetric == (fixtureTaps == fixtureTaps.reversed()), "filter.symmetric \(r.filter.symmetric) does not describe \(r.taps.file)")
        if r.tapsRole == "production", fixtureTaps != impl.taps {
            let i = zip(fixtureTaps, impl.taps).enumerated().first { $0.element.0 != $0.element.1 }?.offset
            c.expect(false, "taps differ from the implementation" + (i.map { ": h[\($0)] is \(fixtureTaps[$0]) in \(r.taps.file), \(impl.taps[$0]) in the implementation" } ?? ": counts \(fixtureTaps.count) vs \(impl.taps.count)"))
        }
        c.expect(r.filter.qBits == impl.qBits, "filter.q_bits \(r.filter.qBits) != implementation \(impl.qBits)")
        c.expect(r.accumulator.bits == DecimationRule.accumulatorBits && r.accumulator.signed, "accumulator \(r.accumulator.signed ? "signed" : "unsigned") \(r.accumulator.bits)-bit != implementation signed \(DecimationRule.accumulatorBits)-bit")
        c.expect(r.decimation.factor == impl.factor, "decimation.factor \(r.decimation.factor) != implementation \(impl.factor)")
        c.expect(r.decimation.phase == impl.phase, "decimation.phase \(r.decimation.phase) != implementation \(impl.phase)")
        c.expect(r.outputRounding.bias == impl.roundingBias && r.outputRounding.divisor == impl.outputDivisor,
                 "output_rounding bias \(r.outputRounding.bias) divisor \(r.outputRounding.divisor) != implementation \(impl.roundingBias), \(impl.outputDivisor)")
        c.expect(r.clipping.min == DecimationRule.clipMin && r.clipping.max == DecimationRule.clipMax, "clipping [\(r.clipping.min), \(r.clipping.max)] != implementation")

        // Geometry of the checked-in files.
        let bytesPerFrame = 2 * max(1, r.channelCount)
        c.expect(f.resamplerInput.count % bytesPerFrame == 0 && f.resamplerInput.count / bytesPerFrame == r.inputFrames,
                 "input is \(f.resamplerInput.count) bytes = \(f.resamplerInput.count / bytesPerFrame) frames of \(r.channelCount) channel(s), manifest says \(r.inputFrames)")
        c.expect(f.resamplerOutput.count == r.outputSamples * 2, "output is \(f.resamplerOutput.count) bytes, manifest says \(r.outputSamples) samples")
        let rule = DecimationRule(designID: r.design, taps: fixtureTaps, qBits: r.filter.qBits, factor: r.decimation.factor, phase: r.decimation.phase, channels: r.channelCount)
        c.expect(r.outputSamples == rule.outputCount(frames: r.inputFrames),
                 "output_samples \(r.outputSamples) != \(rule.outputCount(frames: r.inputFrames)), the count of frames n < \(r.inputFrames) with n mod \(r.decimation.factor) == \(r.decimation.phase)")

        // Output bytes: whole stream, twice, and every chunking.
        let whole = subject.convert(input48k: f.resamplerInput, chunkFrames: [])
        c.law("C9.output-deterministic")
        c.expect(whole == f.resamplerOutput, "output differs from \(r.output.file): " + firstDifference(f.resamplerOutput, whole))
        c.expect(subject.convert(input48k: f.resamplerInput, chunkFrames: []) == whole, "two whole-stream runs differ")
        for pattern in r.chunkPatterns {
            let chunked = subject.convert(input48k: f.resamplerInput, chunkFrames: pattern)
            c.expect(chunked == whole, "chunks \(pattern) change the output: " + firstDifference(whole, chunked))
        }

        // Discontinuities: history resets, so the stream equals its regions converted in isolation.
        if let starts = r.regionStarts, let file = r.regionsOutput {
            c.law("C9.region-reset")
            let frames = f.resamplerInput.count / bytesPerFrame
            let bounds = [0] + starts + [frames]
            let expectedCount = zip(bounds, bounds.dropFirst()).reduce(0) { $0 + rule.outputCount(frames: $1.1 - $1.0) }
            c.expect(r.regionsOutputSamples == expectedCount && f.resamplerRegionsOutput.count == expectedCount * 2,
                     "regions output is \(f.resamplerRegionsOutput.count / 2) samples (manifest \(r.regionsOutputSamples ?? -1)); resets at \(starts) give \(expectedCount)")
            let withResets = subject.convert(input48k: f.resamplerInput, resetAtFrames: starts)
            c.expect(withResets == f.resamplerRegionsOutput,
                     "output with resets at \(starts) differs from \(file.file): " + firstDifference(f.resamplerRegionsOutput, withResets))
            var isolated: [UInt8] = []
            for (a, b) in zip(bounds, bounds.dropFirst()) {
                isolated += subject.convert(input48k: Array(f.resamplerInput[(a * bytesPerFrame)..<(b * bytesPerFrame)]), chunkFrames: [])
            }
            c.expect(isolated == withResets, "regions converted in isolation differ from the stream with resets: " + firstDifference(isolated, withResets))
        }
        return c.verdict
    }
}

/// The resampler linked into this build.
public enum LinkedResampler {
    public static let current: (any Resampler)? = TapeConvertResampler()
}
