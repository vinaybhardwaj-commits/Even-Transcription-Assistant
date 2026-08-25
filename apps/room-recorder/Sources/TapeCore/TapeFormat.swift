import Foundation

public enum TapeConstants {
  public static let sampleRate: Int64 = 16_000
  public static let channels: Int = 1
  public static let bitsPerSample: Int = 16
  public static let bytesPerSample: Int64 = 2
  public static let bytesPerSecond: Int64 = sampleRate * bytesPerSample
  public static let passTailSeconds = 2.5
}

public struct IndexRecord: Codable, Equatable, Sendable {
  public var byteOffset: Int64?
  public var samples: Int64?
  public var monoNS: UInt64
  public var wallNS: UInt64
  public var device: String?
  public var rms: Double?
  public var discontinuity: String?
  public var gapNS: UInt64?
  public var previousByteOffset: Int64?
  public var survivingTailBytes: Int64?
  public var droppedInputFrames: UInt64?
  public var inputFrames: Int64?
  public var inputSampleRate: Double?

  enum CodingKeys: String, CodingKey {
    case byteOffset = "byte_offset"
    case samples
    case monoNS = "mono_ns"
    case wallNS = "wall_ns"
    case device
    case rms
    case discontinuity
    case gapNS = "gap_ns"
    case previousByteOffset = "previous_byte_offset"
    case survivingTailBytes = "surviving_tail_bytes"
    case droppedInputFrames = "dropped_input_frames"
    case inputFrames = "input_frames"
    case inputSampleRate = "input_sample_rate"
  }

  public init(
    byteOffset: Int64? = nil,
    samples: Int64? = nil,
    monoNS: UInt64,
    wallNS: UInt64,
    device: String? = nil,
    rms: Double? = nil,
    discontinuity: String? = nil,
    gapNS: UInt64? = nil,
    previousByteOffset: Int64? = nil,
    survivingTailBytes: Int64? = nil,
    droppedInputFrames: UInt64? = nil,
    inputFrames: Int64? = nil,
    inputSampleRate: Double? = nil
  ) {
    self.byteOffset = byteOffset
    self.samples = samples
    self.monoNS = monoNS
    self.wallNS = wallNS
    self.device = device
    self.rms = rms
    self.discontinuity = discontinuity
    self.gapNS = gapNS
    self.previousByteOffset = previousByteOffset
    self.survivingTailBytes = survivingTailBytes
    self.droppedInputFrames = droppedInputFrames
    self.inputFrames = inputFrames
    self.inputSampleRate = inputSampleRate
  }

  public var isCheckpoint: Bool {
    discontinuity == nil && byteOffset != nil && samples != nil
  }
}

public enum TapeError: Error, LocalizedError, Equatable {
  case missingFile(String)
  case oddPCMSize(Int64)
  case malformedIndex(line: Int, detail: String)
  case invalidIndex(line: Int, detail: String)
  case indexBeyondPCM(line: Int, offset: Int64, pcmSize: Int64)
  case fileTooLarge(String)
  case emptyIndex
  case io(String)

  public var errorDescription: String? {
    switch self {
    case .missingFile(let name): return "missing \(name)"
    case .oddPCMSize(let size): return "tape.pcm has an odd byte count: \(size)"
    case .malformedIndex(let line, let detail): return "malformed tape.idx line \(line): \(detail)"
    case .invalidIndex(let line, let detail): return "invalid tape.idx line \(line): \(detail)"
    case .indexBeyondPCM(let line, let offset, let pcmSize):
      return "tape.idx line \(line) points past tape.pcm: \(offset) > \(pcmSize)"
    case .fileTooLarge(let detail): return detail
    case .emptyIndex: return "tape.idx contains no committed records"
    case .io(let detail): return detail
    }
  }
}

public struct IndexReadResult: Sendable {
  public let records: [IndexRecord]
  public let discardedTrailingBytes: Int
}

public enum IndexLog {
  public static func read(url: URL, pcmSize: Int64? = nil, repairTrailingPartial: Bool = false)
    throws -> IndexReadResult
  {
    guard FileManager.default.fileExists(atPath: url.path) else {
      return IndexReadResult(records: [], discardedTrailingBytes: 0)
    }
    let data: Data
    do {
      data = try Data(contentsOf: url)
    } catch {
      throw TapeError.io("cannot read tape.idx: \(error.localizedDescription)")
    }

    var committedLength = data.count
    if let last = data.last, last != 0x0A {
      if let newline = data.lastIndex(of: 0x0A) {
        committedLength = data.distance(from: data.startIndex, to: data.index(after: newline))
      } else {
        committedLength = 0
      }
    }
    let discarded = data.count - committedLength
    if repairTrailingPartial && discarded > 0 {
      do {
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: UInt64(committedLength))
        try handle.close()
      } catch {
        throw TapeError.io("cannot repair trailing tape.idx record: \(error.localizedDescription)")
      }
    }

    let committed = data.prefix(committedLength)
    if committed.isEmpty {
      return IndexReadResult(records: [], discardedTrailingBytes: discarded)
    }
    guard let text = String(data: committed, encoding: .utf8) else {
      throw TapeError.malformedIndex(line: 1, detail: "invalid UTF-8")
    }

    let decoder = JSONDecoder()
    var records: [IndexRecord] = []
    var previousOffset: Int64 = 0
    var previousSamples: Int64 = 0
    var segmentInputFrames: Int64?
    var segmentInputRate: Double?
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
    for (zeroBased, rawLine) in lines.enumerated() {
      if rawLine.isEmpty && zeroBased == lines.count - 1 {
        continue
      }
      let lineNumber = zeroBased + 1
      guard !rawLine.isEmpty else {
        throw TapeError.malformedIndex(line: lineNumber, detail: "empty interior record")
      }
      let record: IndexRecord
      do {
        record = try decoder.decode(IndexRecord.self, from: Data(rawLine.utf8))
      } catch {
        throw TapeError.malformedIndex(line: lineNumber, detail: error.localizedDescription)
      }
      let precedingOffset = previousOffset
      if let offset = record.byteOffset, let samples = record.samples {
        guard offset >= 0, samples >= 0 else {
          throw TapeError.invalidIndex(line: lineNumber, detail: "negative offset or sample count")
        }
        guard samples <= Int64.max / TapeConstants.bytesPerSample,
          offset == samples * TapeConstants.bytesPerSample
        else {
          throw TapeError.invalidIndex(
            line: lineNumber, detail: "byte_offset must equal samples * 2")
        }
        guard offset >= previousOffset, samples >= previousSamples else {
          throw TapeError.invalidIndex(line: lineNumber, detail: "offset or sample count regressed")
        }
        if let pcmSize, offset > pcmSize {
          throw TapeError.indexBeyondPCM(line: lineNumber, offset: offset, pcmSize: pcmSize)
        }
        previousOffset = offset
        previousSamples = samples
      } else if record.byteOffset != nil || record.samples != nil {
        throw TapeError.invalidIndex(
          line: lineNumber, detail: "byte_offset and samples must appear together")
      }
      guard record.byteOffset != nil, record.samples != nil else {
        throw TapeError.invalidIndex(
          line: lineNumber, detail: "every record requires byte_offset and samples")
      }
      guard let device = record.device, !device.isEmpty else {
        throw TapeError.invalidIndex(line: lineNumber, detail: "every record requires a device uid")
      }
      if record.discontinuity == nil, record.rms == nil {
        throw TapeError.invalidIndex(line: lineNumber, detail: "checkpoint requires rms")
      }
      if let discontinuity = record.discontinuity, discontinuity.isEmpty {
        throw TapeError.invalidIndex(line: lineNumber, detail: "discontinuity cause is empty")
      }
      if let rms = record.rms, !(0...1).contains(rms) {
        throw TapeError.invalidIndex(line: lineNumber, detail: "rms must be between 0 and 1")
      }
      if record.inputFrames != nil || record.inputSampleRate != nil {
        guard let frames = record.inputFrames, frames >= 0,
          let rate = record.inputSampleRate, rate.isFinite, rate > 0
        else {
          throw TapeError.invalidIndex(
            line: lineNumber,
            detail: "input_frames and a positive input_sample_rate must appear together")
        }
        if record.discontinuity == nil {
          if let previousFrames = segmentInputFrames, frames < previousFrames {
            throw TapeError.invalidIndex(
              line: lineNumber, detail: "input_frames regressed without a discontinuity")
          }
          if let previousRate = segmentInputRate, rate != previousRate {
            throw TapeError.invalidIndex(
              line: lineNumber, detail: "input_sample_rate changed without a discontinuity")
          }
        }
        segmentInputFrames = frames
        segmentInputRate = rate
      }
      if record.discontinuity != nil {
        segmentInputFrames = nil
        segmentInputRate = nil
      }
      if record.discontinuity == "restart" {
        guard let previous = record.previousByteOffset, previous >= 0,
          let tail = record.survivingTailBytes, tail >= 0,
          let offset = record.byteOffset,
          previous == precedingOffset,
          tail == offset - previous
        else {
          throw TapeError.invalidIndex(
            line: lineNumber,
            detail: "restart tail fields do not match the preceding durable offset")
        }
      }
      records.append(record)
    }
    return IndexReadResult(records: records, discardedTrailingBytes: discarded)
  }

  public static func encodedLine(_ record: IndexRecord) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    var data = try encoder.encode(record)
    data.append(0x0A)
    return data
  }
}
