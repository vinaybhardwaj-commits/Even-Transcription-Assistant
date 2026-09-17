import Foundation

/// A typed index record, field for field with TapeCore/TapeFormat.swift:12-49 at f798edf.
/// Optional fields are omitted when nil (synthesised Codable uses encodeIfPresent), which is how
/// the Mac writes them. C2 round-trips every line through this type.
public struct IndexRecord: Codable, Equatable, Sendable {
    public var byteOffset: Int64?
    public var samples: Int64?
    public var monoNS: UInt64
    public var wallNS: UInt64
    public var device: String
    public var rms: Double?
    public var peak: Double?
    public var zeroRatio: Double?
    public var discontinuity: String?
    public var gapNS: UInt64?
    public var previousByteOffset: Int64?
    public var survivingTailBytes: Int64?
    public var droppedInputFrames: UInt64?
    public var inputFrames: Int64?
    public var inputSampleRate: Double?

    enum CodingKeys: String, CodingKey {
        case samples, device, rms, peak, discontinuity
        case byteOffset = "byte_offset", monoNS = "mono_ns", wallNS = "wall_ns", zeroRatio = "zero_ratio"
        case gapNS = "gap_ns", previousByteOffset = "previous_byte_offset", survivingTailBytes = "surviving_tail_bytes"
        case droppedInputFrames = "dropped_input_frames", inputFrames = "input_frames", inputSampleRate = "input_sample_rate"
    }

    public var isCheckpoint: Bool { discontinuity == nil }

    /// The presence rules of the schema table. Returns one message per violation.
    public func presenceViolations() -> [String] {
        var v: [String] = []
        if (byteOffset == nil) != (samples == nil) { v.append("byte_offset and samples must be both present or both absent") }
        if device.isEmpty { v.append("device must be non-empty") }
        if isCheckpoint {
            if rms == nil { v.append("checkpoint without rms") }
            if (peak == nil) != (zeroRatio == nil) { v.append("peak and zero_ratio must be both present or both absent") }
            if gapNS != nil { v.append("gap_ns on a checkpoint") }
        } else {
            if rms != nil || peak != nil || zeroRatio != nil { v.append("rms/peak/zero_ratio on a \(discontinuity!) record") }
            if let g = gapNS, g == 0 { v.append("gap_ns present but zero") }
            if discontinuity == DiscontinuityCause.dayRollover, gapNS != nil { v.append("day_rollover carries gap_ns") }
        }
        if discontinuity != DiscontinuityCause.restart, previousByteOffset != nil || survivingTailBytes != nil {
            v.append("previous_byte_offset/surviving_tail_bytes outside a restart record")
        }
        if discontinuity != DiscontinuityCause.ringOverflow, droppedInputFrames != nil {
            v.append("dropped_input_frames outside a ring_overflow record")
        }
        if let d = droppedInputFrames, d == 0 { v.append("dropped_input_frames present but zero") }
        if (inputFrames == nil) != (inputSampleRate == nil) { v.append("input_frames and input_sample_rate must be paired") }
        return v
    }

    public static func decode(_ line: [UInt8]) throws -> IndexRecord {
        try JSONDecoder().decode(IndexRecord.self, from: Data(line))
    }

    public func encodedLine() throws -> [UInt8] {
        [UInt8](try IndexLineCodec.makeEncoder().encode(self))
    }
}
