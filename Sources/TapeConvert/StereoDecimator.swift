// 48 kHz stereo S16_LE → 16 kHz mono S16_LE, exactly as spec/CONVERSION-48K-STEREO-TO-16K-MONO.md.
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

    public init(designID: String, taps: [Int32], qBits: Int, factor: Int, phase: Int) {
        self.designID = designID
        self.taps = taps
        self.qBits = qBits
        self.factor = factor
        self.phase = phase
    }

    public static let production = DecimationRule(
        designID: "eta-u1-dec3-fir121-kaiser8-q16-phase2/1",
        taps: FIRTaps.fir48kTo16k121TapQ16, qBits: 16, factor: 3, phase: 2)

    /// Divides by 2 (the downmix sum) and by 2^qBits in one shift.
    public var outputShift: Int { qBits + 1 }
    /// Half of 2^outputShift: added before the arithmetic shift, so exact halves round toward +∞.
    public var roundingBias: Int64 { Int64(1) << Int64(qBits) }
    public static let clipMin: Int64 = -32_768
    public static let clipMax: Int64 = 32_767
    public static let accumulatorBits = 64

    /// Output samples at the start of a region that read the zeroed history: output k reads input frames
    /// factor·k + phase − (taps − 1) … factor·k + phase, so it depends on the history while factor·k + phase < taps − 1.
    /// For the production rule, k < 39.33: the first 40 samples (2.5 ms). U1 spec §11.4, §11.5.
    public var rampOutputSamples: Int { (taps.count - 1 - phase + factor - 1) / factor }

    /// Output samples produced by `frames` input frames: one per frame n with n mod factor == phase.
    /// For the production phase 2 this is floor(frames / 3).
    public func outputCount(frames: Int) -> Int {
        frames > phase ? (frames - phase - 1) / factor + 1 : 0
    }
}

public struct StereoDecimator: Sendable {
    public let rule: DecimationRule
    private let taps: [Int64]
    /// Ring of the last taps.count downmixed samples; zero at stream start.
    private var history: [Int32]
    /// Index of the newest sample in `history`.
    private var newest: Int
    /// Position of the next input frame within its group of `factor` frames.
    private var groupPosition: Int

    public init(rule: DecimationRule = .production) {
        precondition(!rule.taps.isEmpty && rule.factor > 0 && (0..<rule.factor).contains(rule.phase))
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

    /// Converts whole interleaved frames (4 bytes each) and appends the output samples.
    public mutating func process(interleaved bytes: some Collection<UInt8>, into output: inout [Int16]) {
        precondition(bytes.count % 4 == 0, "input must be whole S16_LE stereo frames")
        let n = taps.count
        var it = bytes.makeIterator()
        while let l0 = it.next(), let l1 = it.next(), let r0 = it.next(), let r1 = it.next() {
            let left = Int16(bitPattern: UInt16(l0) | UInt16(l1) << 8)
            let right = Int16(bitPattern: UInt16(r0) | UInt16(r1) << 8)
            // §2: exact sum in 32 bits, no halving, no rounding.
            newest = newest + 1 == n ? 0 : newest + 1
            history[newest] = Int32(left) + Int32(right)

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
            // §5: add 2^16, arithmetic shift right by 17, then clip at both rails.
            let y = min(DecimationRule.clipMax, max(DecimationRule.clipMin, (acc + rule.roundingBias) >> Int64(rule.outputShift)))
            output.append(Int16(y))
        }
    }
}
