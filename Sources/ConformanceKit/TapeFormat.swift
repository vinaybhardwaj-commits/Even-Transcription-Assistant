// The tape format constants, as verified from the Mac source at f798edf
// (TapeCore/TapeFormat.swift, PiecePipeline.swift:231, CaptureTimeline).
// Nothing here is stored in the file: tape.pcm has no header, magic or version.

public enum TapeFormat {
    /// Raw headerless mono signed 16-bit little-endian PCM.
    public static let sampleRate: Int64 = 16_000
    public static let channels: Int64 = 1
    public static let bytesPerSample: Int64 = 2

    /// 1e9 / 16000, exact. One sample is exactly 62 500 ns of wall time.
    public static let nsPerSample: Int64 = 62_500

    /// A full piece: exactly 300.000 s.
    public static let pieceSamples: Int64 = 4_800_000

    /// CaptureTimeline.rolloverSplit day length.
    public static let istDayNS: Int64 = 86_400_000_000_000
    /// India Standard Time is UTC+05:30 with no daylight saving.
    public static let istOffsetNS: Int64 = 19_800_000_000_000
}

/// The index keys of TapeCore/TapeFormat.swift:12-49 at f798edf, as tabled in the U0-A refuter verdict.
/// The verdict says "fourteen" but tables fifteen; all fifteen are used, none added.
public enum IndexKey {
    public static let byteOffset = "byte_offset"
    public static let samples = "samples"
    public static let monoNS = "mono_ns"
    public static let wallNS = "wall_ns"
    public static let device = "device"
    public static let rms = "rms"
    public static let peak = "peak"
    public static let zeroRatio = "zero_ratio"
    public static let discontinuity = "discontinuity"
    public static let gapNS = "gap_ns"
    public static let previousByteOffset = "previous_byte_offset"
    public static let survivingTailBytes = "surviving_tail_bytes"
    public static let droppedInputFrames = "dropped_input_frames"
    public static let inputFrames = "input_frames"
    public static let inputSampleRate = "input_sample_rate"

    public static let all = [byteOffset, samples, monoNS, wallNS, device, rms, peak, zeroRatio, discontinuity,
                             gapNS, previousByteOffset, survivingTailBytes, droppedInputFrames, inputFrames, inputSampleRate]
    public static let doubles = [rms, peak, zeroRatio, inputSampleRate]
    public static let strings = [device, discontinuity]
}

/// `discontinuity` values named by the Mac source. The suite does not assume this list is complete.
public enum DiscontinuityCause {
    public static let ringOverflow = "ring_overflow"
    public static let restart = "restart"
    public static let dayRollover = "day_rollover"
    public static let captureDiscontinuity = "capture_discontinuity"
    public static let resumed = "resumed"
    public static let deviceLost = "device_lost"

    /// gapMilliseconds(for:), PiecePipeline.swift:421-428: only these causes surface a gap on the following
    /// piece. Every other cause, day_rollover and restart included, is zero by rule whatever gap_ns says.
    public static let gapCarrying: Set<String> = [captureDiscontinuity, resumed, ringOverflow, deviceLost]

    /// PiecePipeline.swift:417: round half up at 500 000 ns.
    public static func gapMilliseconds(cause: String?, gapNS: Int64?) -> Int64 {
        guard let cause, gapCarrying.contains(cause), let value = gapNS, value > 0 else { return 0 }
        return value / 1_000_000 + (value % 1_000_000 >= 500_000 ? 1 : 0)
    }
}
