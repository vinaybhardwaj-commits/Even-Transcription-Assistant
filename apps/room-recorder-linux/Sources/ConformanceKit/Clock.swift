// The sample-count clock and the IST day rollover.

public enum TapeClock {
    /// IndexRecord.samples = bytesWritten / 2.
    public static func samples(bytesWritten: Int64) -> Int64 { bytesWritten / TapeFormat.bytesPerSample }

    /// Exact wall time in ns. Because 1 sample == 62 500 ns exactly, this is integer-exact.
    public static func wallNS(sample: Int64, anchorSample: Int64, anchorWallNS: Int64) -> Int64 {
        anchorWallNS + (sample - anchorSample) * TapeFormat.nsPerSample
    }

    /// The formula as written in PiecePipeline.timestamp: anchorWallNS/1e9 + (sample − anchorSample)/16000.
    public static func wallSeconds(sample: Int64, anchorSample: Int64, anchorWallNS: Int64) -> Double {
        Double(anchorWallNS) / 1e9 + Double(sample - anchorSample) / Double(TapeFormat.sampleRate)
    }
}

public enum DayRollover {
    /// The first IST midnight strictly after `wallNS`, as a UTC wall time in ns.
    public static func nextISTMidnight(after wallNS: Int64) -> Int64 {
        let local = wallNS + TapeFormat.istOffsetNS
        let day = local / TapeFormat.istDayNS
        return (day + 1) * TapeFormat.istDayNS - TapeFormat.istOffsetNS
    }

    /// The sample at which the `day_rollover` discontinuity is written, as CaptureTimeline.swift:134-152:
    ///   frameOffset = Int((Double(elapsedNS) * sampleRate / 1_000_000_000).rounded(.up))
    /// Frames 0..<frameOffset are the prefix (old day). Rounding up puts a sample that straddles midnight in
    /// the prefix: it is the LAST sample of the old day, and the marker lands on the sample after it.
    public static func rolloverSample(anchorSample: Int64, anchorWallNS: Int64) -> (boundaryWallNS: Int64, sample: Int64) {
        let boundary = nextISTMidnight(after: anchorWallNS)
        let elapsedNS = boundary - anchorWallNS
        let frameOffset = Int64((Double(elapsedNS) * Double(TapeFormat.sampleRate) / 1_000_000_000).rounded(.up))
        return (boundary, anchorSample + frameOffset)
    }
}
