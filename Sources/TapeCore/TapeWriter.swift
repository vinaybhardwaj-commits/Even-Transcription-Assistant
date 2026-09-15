import Foundation
#if canImport(Glibc)
import Glibc
#endif

// The durable tape. Format facts from the Mac source at f798edf: tape.pcm is raw mono S16_LE 16 kHz, byte_offset =
// samples × 2; tape.idx is one JSON object per line, [.sortedKeys, .withoutEscapingSlashes], \n-terminated.
// This module has no ALSA import.

/// One index record: the fifteen keys of TapeCore/TapeFormat.swift:12-49. Nil fields are omitted.
public struct TapeIndexRecord: Codable, Equatable, Sendable {
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

    public func encodedLine() throws -> [UInt8] {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return [UInt8](try encoder.encode(self)) + [0x0A]
    }
}

/// Levels of the 16 kHz mono tape samples written since the previous checkpoint, as the Mac computes them
/// (TapeWriter.swift:401-424): each sample normalised by 32 768, squares summed as Double in order,
///   rms        = min(1, sqrt(Σ (s/32768)² / n)), 0 when n == 0
///   peak       = max |s/32768|, nil (key omitted) when n == 0
///   zero_ratio = (count of s == 0) / n, nil (key omitted) when n == 0
public struct LevelWindow: Sendable {
    public private(set) var count: Int64 = 0
    private var squaredSum: Double = 0
    private var peakAbs: Double = 0
    private var zeros: Int64 = 0

    public init() {}

    public mutating func add(_ samples: some Collection<Int16>) {
        for s in samples {
            let normalized = Double(s) / 32_768
            squaredSum += normalized * normalized
            peakAbs = max(peakAbs, abs(normalized))
            if s == 0 { zeros += 1 }
        }
        count += Int64(samples.count)
    }

    public var rms: Double { count == 0 ? 0 : min(1, (squaredSum / Double(count)).squareRoot()) }
    public var peak: Double? { count == 0 ? nil : peakAbs }
    public var zeroRatio: Double? { count == 0 ? nil : Double(zeros) / Double(count) }
}

public struct TapeWriterError: Error, CustomStringConvertible {
    public let description: String
}

/// Appends PCM and index records with the ordering U1 §2.3 rules: fsync the PCM before writing an index record that
/// references it, fsync the index after. The index never references a byte that is not already durable in the PCM.
public final class TapeWriter {
    public let directory: URL
    public let device: String
    public let inputSampleRate: Double
    private let pcmFD: Int32
    private let idxFD: Int32
    public private(set) var samples: Int64 = 0
    public private(set) var records = 0
    /// byte_offset of the most recent record, -1 before any.
    public private(set) var lastRecordByteOffset: Int64 = -1
    private var window = LevelWindow()

    /// What was found in the directory when the writer opened it.
    public struct PriorTape: Codable, Sendable {
        /// tape.pcm length before this session, after trimming a trailing odd byte.
        public var pcmBytes: Int64
        /// byte_offset of the last complete prior record (0 if the index held none).
        public var previousByteOffset: Int64
        /// PCM bytes beyond that record which survived the previous session: kept, never truncated.
        public var survivingTailBytes: Int64
        /// input_frames of the last prior record that carried one; the seed for this session's running total.
        public var lastInputFrames: Int64?
        public var records: Int
        /// Bytes of a torn trailing index line truncated away (C3 repair).
        public var tornIndexBytesTruncated: Int
        /// A trailing half sample (odd tape.pcm length) trimmed.
        public var oddPCMByteTrimmed: Bool
        enum CodingKeys: String, CodingKey {
            case records
            case pcmBytes = "pcm_bytes", previousByteOffset = "previous_byte_offset", survivingTailBytes = "surviving_tail_bytes"
            case lastInputFrames = "last_input_frames", tornIndexBytesTruncated = "torn_index_bytes_truncated"
            case oddPCMByteTrimmed = "odd_pcm_byte_trimmed"
        }
    }

    /// Set when the writer continued an existing tape (and wrote a `restart` record).
    public private(set) var prior: PriorTape?

    /// Opens a tape. A new directory gets a new tape. An existing tape is continued: the index is repaired (a torn
    /// trailing line truncated, as C3 requires), a trailing odd PCM byte is trimmed (Mac TapeWriter.swift:129-133), and a
    /// `restart` record is written with previous_byte_offset and surviving_tail_bytes — no input_frames, no gap_ns
    /// (:152, :305-315). Its clocks follow the Mac (:300, :308-309): mono_ns is read once BEFORE the full sync of both
    /// files, wall_ns is read AFTER it, at record construction, so the sync's duration lies between them.
    /// A tape with only one of its two files is refused.
    public init(directory: URL, device: String, inputSampleRate: Double, monoNow: () -> Int64, wallNow: () -> Int64) throws {
        precondition(!device.isEmpty)
        self.directory = directory
        self.device = device
        self.inputSampleRate = inputSampleRate
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let pcmPath = directory.appendingPathComponent("tape.pcm").path
        let idxPath = directory.appendingPathComponent("tape.idx").path
        let havePCM = fm.fileExists(atPath: pcmPath), haveIdx = fm.fileExists(atPath: idxPath)
        guard havePCM == haveIdx else {
            throw TapeWriterError(description: "\(directory.path) holds only one of tape.pcm and tape.idx; refusing to guess")
        }
        func openFile(_ path: String, _ flags: Int32) throws -> Int32 {
            let fd = open(path, flags | O_CLOEXEC, 0o644)
            guard fd >= 0 else { throw TapeWriterError(description: "cannot open \(path): \(String(cString: strerror(errno)))") }
            return fd
        }
        if !havePCM {
            pcmFD = try openFile(pcmPath, O_WRONLY | O_CREAT | O_EXCL | O_APPEND)
            idxFD = try openFile(idxPath, O_WRONLY | O_CREAT | O_EXCL | O_APPEND)
            let dirFD = open(directory.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
            if dirFD >= 0 { fsync(dirFD); close(dirFD) }
            return
        }

        // Continue an existing tape.
        var idx = [UInt8](try Data(contentsOf: URL(fileURLWithPath: idxPath)))
        let completeLength = (idx.lastIndex(of: 0x0A).map { $0 + 1 }) ?? 0
        let torn = idx.count - completeLength
        idx.removeLast(torn)
        var previousByteOffset: Int64 = 0
        var lastInputFrames: Int64? = nil
        var count = 0
        for line in idx.split(separator: 0x0A, omittingEmptySubsequences: false).dropLast() {
            count += 1
            guard !line.isEmpty else { throw TapeWriterError(description: "tape.idx line \(count) is blank: hard error, not repairing") }
            let record: TapeIndexRecord
            do { record = try JSONDecoder().decode(TapeIndexRecord.self, from: Data(line)) } catch {
                throw TapeWriterError(description: "tape.idx line \(count) is not an index record: \(error)")
            }
            if let b = record.byteOffset { previousByteOffset = b }
            if let f = record.inputFrames { lastInputFrames = f }
        }
        var pcmBytes = Int64((try fm.attributesOfItem(atPath: pcmPath)[.size] as? NSNumber)?.int64Value ?? 0)
        let odd = pcmBytes % 2 == 1
        if odd { pcmBytes -= 1 }
        guard previousByteOffset <= pcmBytes else {
            throw TapeWriterError(description: "tape.idx references byte \(previousByteOffset) beyond tape.pcm (\(pcmBytes) bytes): refusing to continue")
        }
        pcmFD = try openFile(pcmPath, O_WRONLY | O_APPEND)
        idxFD = try openFile(idxPath, O_WRONLY | O_APPEND)
        if torn > 0 {
            guard ftruncate(idxFD, off_t(completeLength)) == 0, fsync(idxFD) == 0 else {
                throw TapeWriterError(description: "cannot truncate torn tape.idx tail: \(String(cString: strerror(errno)))")
            }
        }
        if odd {
            guard ftruncate(pcmFD, off_t(pcmBytes)) == 0, fsync(pcmFD) == 0 else {
                throw TapeWriterError(description: "cannot trim odd tape.pcm byte: \(String(cString: strerror(errno)))")
            }
        }
        samples = pcmBytes / 2
        records = count
        lastRecordByteOffset = previousByteOffset
        let found = PriorTape(pcmBytes: pcmBytes, previousByteOffset: previousByteOffset,
                              survivingTailBytes: pcmBytes - previousByteOffset, lastInputFrames: lastInputFrames,
                              records: count, tornIndexBytesTruncated: torn, oddPCMByteTrimmed: odd)
        prior = found
        let restartMono = monoNow()
        guard fsync(pcmFD) == 0, fsync(idxFD) == 0 else {
            throw TapeWriterError(description: "full sync before restart: \(String(cString: strerror(errno)))")
        }
        try appendRecord(TapeIndexRecord(
            byteOffset: pcmBytes, samples: samples, monoNS: UInt64(restartMono), wallNS: UInt64(wallNow()), device: device,
            discontinuity: "restart", previousByteOffset: found.previousByteOffset, survivingTailBytes: found.survivingTailBytes))
    }

    deinit {
        close(pcmFD)
        close(idxFD)
    }

    private func writeAll(_ fd: Int32, _ bytes: UnsafeRawBufferPointer, _ what: String) throws {
        var offset = 0
        while offset < bytes.count {
            let n = write(fd, bytes.baseAddress! + offset, bytes.count - offset)
            if n < 0 {
                if errno == EINTR { continue }
                throw TapeWriterError(description: "write \(what): \(String(cString: strerror(errno)))")
            }
            offset += n
        }
    }

    /// Appends mono 16 kHz samples. The clock advances: samples = bytes written / 2.
    public func append(_ pcm: [Int16]) throws {
        guard !pcm.isEmpty else { return }
        try pcm.withUnsafeBytes { try writeAll(pcmFD, $0, "tape.pcm") }
        samples += Int64(pcm.count)
        window.add(pcm)
    }

    private func appendRecord(_ record: TapeIndexRecord) throws {
        guard fsync(pcmFD) == 0 else { throw TapeWriterError(description: "fsync tape.pcm: \(String(cString: strerror(errno)))") }
        let line = try record.encodedLine()
        try line.withUnsafeBytes { try writeAll(idxFD, $0, "tape.idx") }
        guard fsync(idxFD) == 0 else { throw TapeWriterError(description: "fsync tape.idx: \(String(cString: strerror(errno)))") }
        records += 1
        lastRecordByteOffset = record.byteOffset ?? lastRecordByteOffset
    }

    /// A checkpoint at the current tape position, with the levels of the samples written since the previous record.
    public func checkpoint(monoNS: Int64, wallNS: Int64, inputFrames: Int64) throws {
        let w = window
        window = LevelWindow()
        try appendRecord(TapeIndexRecord(
            byteOffset: samples * 2, samples: samples, monoNS: UInt64(monoNS), wallNS: UInt64(wallNS), device: device,
            rms: w.rms, peak: w.peak, zeroRatio: w.zeroRatio,
            inputFrames: inputFrames, inputSampleRate: inputSampleRate))
    }

    /// A metadata-only discontinuity record at the current tape position. No PCM is written for the gap.
    public func discontinuity(cause: String, gapNS: Int64?, droppedInputFrames: Int64?, monoNS: Int64, wallNS: Int64, inputFrames: Int64) throws {
        try appendRecord(TapeIndexRecord(
            byteOffset: samples * 2, samples: samples, monoNS: UInt64(monoNS), wallNS: UInt64(wallNS), device: device,
            discontinuity: cause,
            gapNS: gapNS.flatMap { $0 > 0 ? UInt64($0) : nil },
            droppedInputFrames: droppedInputFrames.flatMap { $0 > 0 ? UInt64($0) : nil },
            inputFrames: inputFrames, inputSampleRate: inputSampleRate))
    }

    /// The terminal `stopped` record (Mac TapeWriter.swift:366-384): exactly eight keys — byte_offset, samples, mono_ns,
    /// wall_ns, device, discontinuity, input_frames and input_sample_rate (both nil when no input rate was ever active).
    /// No levels, no gap_ns. The caller passes clocks read at the moment of writing. The PCM is fsynced first
    /// (appendRecord), which is the Mac's fullSyncTape(.stopped) barrier. A tape that ENDED has one; a tape whose
    /// process DIED has none.
    public func stopped(monoNS: Int64, wallNS: Int64, inputFrames: Int64?) throws {
        try appendRecord(TapeIndexRecord(
            byteOffset: samples * 2, samples: samples, monoNS: UInt64(monoNS), wallNS: UInt64(wallNS), device: device,
            discontinuity: "stopped",
            inputFrames: inputFrames, inputSampleRate: inputFrames == nil ? nil : inputSampleRate))
    }

    public var pendingWindowSamples: Int64 { window.count }
}
