// 48 kHz S16_LE at the device's channel count → 16 kHz mono S16_LE, exactly as spec/CONVERSION-48K-TO-16K-MONO.md.
// Pure integer arithmetic. No Foundation, no platform imports: this module is part of the platform-neutral core.

/// Every parameter of the conversion. `production` is the specification; other values exist only so the
/// conformance generator can build negative controls.
public struct DecimationRule: Sendable, Equatable {
    public var designID: String
    public var taps: [Int32]
    /// Taps are scaled by 2^qBits.
    public var qBits: Int
    public var factor: Int
    /// Output k is taken at input frame factor·k + phase.
    public var phase: Int
    /// The capture device's channel count. The taps, factor and phase do not depend on it; only the output divisor does.
    public var channels: Int
    /// Conformance generator only: the channel factor in the output divisor, when it must differ from `channels` so that a
    /// negative control can change the downmix division WITHOUT changing the framing. nil means `channels`, the specification.
    public var divisorChannelsOverride: Int? = nil

    public init(designID: String, taps: [Int32], qBits: Int, factor: Int, phase: Int, channels: Int) {
        self.designID = designID
        self.taps = taps
        self.qBits = qBits
        self.factor = factor
        self.phase = phase
        self.channels = channels
    }

    /// The production rule for a device with `channels` channels (§2, §5 of the conversion spec).
    public static func production(channels: Int) -> DecimationRule {
        DecimationRule(designID: "eta-u1-dec3-fir121-kaiser8-q16-phase2/1",
                       taps: FIRTaps.fir48kTo16k121TapQ16, qBits: 16, factor: 3, phase: 2, channels: channels)
    }

    /// The two-channel production rule (the Yoga's DMIC). Channel-independent properties — taps, factor, phase,
    /// rampOutputSamples, outputCount — may be read from it whatever the device offers.
    public static let production = production(channels: 2)

    /// Divides by the channel count (the downmix mean, §2) and by 2^qBits (Q16) in one step.
    public var outputDivisor: Int64 { Int64(divisorChannelsOverride ?? channels) << Int64(qBits) }
    /// Half the divisor: added before the floor division, so exact halves round toward +∞.
    public var roundingBias: Int64 { outputDivisor / 2 }
    public static let clipMin: Int64 = -32_768
    public static let clipMax: Int64 = 32_767
    public static let accumulatorBits = 64

    /// Output samples at the start of a region that read the zeroed history: output k reads input frames
    /// factor·k + phase − (taps − 1) … factor·k + phase, so it depends on the history while factor·k + phase < taps − 1.
    /// For the production rule, k < 39.33: the first 40 samples (2.5 ms). U1 spec §11.4, §11.5.
    public var rampOutputSamples: Int { (taps.count - 1 - phase + factor - 1) / factor }

    /// Output samples produced by `frames` input frames: one per frame n with n mod factor == phase. Channel-independent.
    /// For the production phase 2 this is floor(frames / 3).
    public func outputCount(frames: Int) -> Int {
        frames > phase ? (frames - phase - 1) / factor + 1 : 0
    }
}

public struct Decimator: Sendable {
    public let rule: DecimationRule
    private let taps: [Int64]
    /// Bytes per input frame: 2 × channels.
    public var bytesPerFrame: Int { 2 * rule.channels }
    /// Ring of the last taps.count downmixed samples; zero at stream start.
    private var history: [Int32]
    /// Index of the newest sample in `history`.
    private var newest: Int
    /// Position of the next input frame within its group of `factor` frames.
    private var groupPosition: Int

    public init(rule: DecimationRule = .production) {
        precondition(!rule.taps.isEmpty && rule.factor > 0 && (0..<rule.factor).contains(rule.phase) && rule.channels > 0)
        self.rule = rule
        self.taps = rule.taps.map(Int64.init)
        self.history = [Int32](repeating: 0, count: rule.taps.count)
        self.newest = rule.taps.count - 1
        self.groupPosition = 0
    }

    /// Returns the converter to its stream-start state: zero history, next frame is frame 0 of a new group.
    /// Called at stream start (implicitly, by init) and at every discontinuity. Frames of an incomplete group
    /// (at most factor − 1) buffered before the reset produce no output.
    public mutating func reset() {
        for i in history.indices { history[i] = 0 }
        newest = taps.count - 1
        groupPosition = 0
    }

    /// Input frames to feed before exactly `outputs` more output samples have been produced (the last frame fed
    /// completes the last of them).
    public func framesUntil(outputs: Int) -> Int {
        guard outputs > 0 else { return 0 }
        let toFirst = groupPosition <= rule.phase ? rule.phase - groupPosition + 1 : rule.factor - groupPosition + rule.phase + 1
        return toFirst + (outputs - 1) * rule.factor
    }

    /// Converts whole interleaved frames (2 × channels bytes each) and appends the output samples.
    public mutating func process(interleaved bytes: some Collection<UInt8>, into output: inout [Int16]) {
        precondition(bytes.count % bytesPerFrame == 0, "input must be whole S16_LE frames of \(rule.channels) channel(s)")
        let n = taps.count
        var it = bytes.makeIterator()
        frames: while true {
            // §2: the mean over the channel count, as an exact sum here; the division by channels is folded into the
            // output divisor (§5), so the conversion rounds exactly once. A single channel is a copy.
            var sum: Int32 = 0
            for _ in 0..<rule.channels {
                guard let lo = it.next(), let hi = it.next() else { break frames }
                sum += Int32(Int16(bitPattern: UInt16(lo) | UInt16(hi) << 8))
            }
            newest = newest + 1 == n ? 0 : newest + 1
            history[newest] = sum

            let position = groupPosition
            groupPosition = groupPosition + 1 == rule.factor ? 0 : groupPosition + 1
            guard position == rule.phase else { continue }

            // §3: acc = Σ h[i] · m[n − i] in 64 bits.
            var acc: Int64 = 0
            var j = newest
            for i in 0..<n {
                acc += taps[i] * Int64(history[j])
                j = j == 0 ? n - 1 : j - 1
            }
            // §5: add half the divisor, floor-divide by it, then clip at both rails.
            let divisor = rule.outputDivisor
            let biased = acc + rule.roundingBias
            let floored = biased >= 0 ? biased / divisor : -((-biased + divisor - 1) / divisor)
            let y = min(DecimationRule.clipMax, max(DecimationRule.clipMin, floored))
            output.append(Int16(y))
        }
    }
}
