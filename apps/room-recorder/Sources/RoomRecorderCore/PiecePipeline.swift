import Foundation
import TapeCore

public enum RoomPiecePipelineError: Error, Equatable, LocalizedError, Sendable {
  case invalidManifest(String)
  case invalidIndexRecord(Int)
  case nonMonotonicIndex(Int)
  case uncoveredSample(Int64)
  case missingTimestampAnchor(Int64)
  case sourceOpenFailed(String, Int32)
  case sourceRangeUnavailable(offset: Int64, count: Int64)
  case readFailed(offset: Int64, errno: Int32)
  case writeFailed(String, Int32)
  case processFailed(status: Int32, stderr: String)
  case emptyOutput
  case destinationExists(String)
  case verificationMismatch
  case io(String)

  public var errorDescription: String? {
    switch self {
    case .invalidManifest(let detail): return "invalid piece manifest: \(detail)"
    case .invalidIndexRecord(let index): return "invalid index record at position \(index)"
    case .nonMonotonicIndex(let index):
      return "index sample position regressed at position \(index)"
    case .uncoveredSample(let sample): return "sample \(sample) is not covered by the index"
    case .missingTimestampAnchor(let sample):
      return "no capture timestamp anchor covers sample \(sample)"
    case .sourceOpenFailed(let path, let code):
      return "cannot open PCM source \(path): errno \(code)"
    case .sourceRangeUnavailable(let offset, let count):
      return "PCM source does not contain byte range \(offset)..<\(offset + count)"
    case .readFailed(let offset, let code):
      return "cannot read PCM source at byte \(offset): errno \(code)"
    case .writeFailed(let path, let code): return "cannot write \(path): errno \(code)"
    case .processFailed(let status, let stderr):
      return "ffmpeg exited \(status): \(stderr)"
    case .emptyOutput: return "ffmpeg produced an empty WebM"
    case .destinationExists(let path): return "immutable destination already exists: \(path)"
    case .verificationMismatch: return "upload verification does not match the spooled piece"
    case .io(let detail): return detail
    }
  }
}

public struct RoomPieceManifest: Codable, Equatable, Sendable {
  public static let webMContentType = "audio/webm"

  public let sessionID: String
  public let index: Int
  public let segmentID: String
  public let sampleStart: Int64
  public let sampleEnd: Int64
  public let startedAt: Date
  public let endedAt: Date
  public let durationMS: Int64
  public let gapBeforeMS: Int64
  public let contentType: String
  public let sizeBytes: Int64
  public let filename: String

  enum CodingKeys: String, CodingKey {
    case sessionID = "session_id"
    case index = "idx"
    case segmentID = "segment_id"
    case sampleStart = "sample_start"
    case sampleEnd = "sample_end"
    case startedAt = "started_at"
    case endedAt = "ended_at"
    case durationMS = "duration_ms"
    case gapBeforeMS = "gap_before_ms"
    case contentType = "content_type"
    case sizeBytes = "size_bytes"
    case filename
  }

  public init(
    sessionID: String,
    index: Int,
    segmentID: String,
    sampleStart: Int64,
    sampleEnd: Int64,
    startedAt: Date,
    endedAt: Date,
    durationMS: Int64,
    gapBeforeMS: Int64,
    sizeBytes: Int64,
    filename: String
  ) throws {
    guard !sessionID.isEmpty, index >= 0, !segmentID.isEmpty else {
      throw RoomPiecePipelineError.invalidManifest("session, index, and segment are required")
    }
    guard sampleStart >= 0, sampleEnd > sampleStart, durationMS >= 0, gapBeforeMS >= 0,
      sizeBytes > 0
    else {
      throw RoomPiecePipelineError.invalidManifest("range, duration, gap, or size is invalid")
    }
    guard endedAt >= startedAt else {
      throw RoomPiecePipelineError.invalidManifest("ended_at precedes started_at")
    }
    guard filename == URL(fileURLWithPath: filename).lastPathComponent,
      !filename.hasPrefix("."), filename.hasSuffix(".webm")
    else {
      throw RoomPiecePipelineError.invalidManifest("filename must be a plain .webm basename")
    }
    self.sessionID = sessionID
    self.index = index
    self.segmentID = segmentID
    self.sampleStart = sampleStart
    self.sampleEnd = sampleEnd
    self.startedAt = Self.canonicalDate(startedAt)
    self.endedAt = Self.canonicalDate(endedAt)
    self.durationMS = durationMS
    self.gapBeforeMS = gapBeforeMS
    contentType = Self.webMContentType
    self.sizeBytes = sizeBytes
    self.filename = filename
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    let contentType = try values.decode(String.self, forKey: .contentType)
    guard contentType == Self.webMContentType else {
      throw RoomPiecePipelineError.invalidManifest("content_type must be audio/webm")
    }
    try self.init(
      sessionID: values.decode(String.self, forKey: .sessionID),
      index: values.decode(Int.self, forKey: .index),
      segmentID: values.decode(String.self, forKey: .segmentID),
      sampleStart: values.decode(Int64.self, forKey: .sampleStart),
      sampleEnd: values.decode(Int64.self, forKey: .sampleEnd),
      startedAt: Self.decodeDate(values.decode(String.self, forKey: .startedAt)),
      endedAt: Self.decodeDate(values.decode(String.self, forKey: .endedAt)),
      durationMS: values.decode(Int64.self, forKey: .durationMS),
      gapBeforeMS: values.decode(Int64.self, forKey: .gapBeforeMS),
      sizeBytes: values.decode(Int64.self, forKey: .sizeBytes),
      filename: values.decode(String.self, forKey: .filename)
    )
  }

  public func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(sessionID, forKey: .sessionID)
    try values.encode(index, forKey: .index)
    try values.encode(segmentID, forKey: .segmentID)
    try values.encode(sampleStart, forKey: .sampleStart)
    try values.encode(sampleEnd, forKey: .sampleEnd)
    try values.encode(Self.encodeDate(startedAt), forKey: .startedAt)
    try values.encode(Self.encodeDate(endedAt), forKey: .endedAt)
    try values.encode(durationMS, forKey: .durationMS)
    try values.encode(gapBeforeMS, forKey: .gapBeforeMS)
    try values.encode(contentType, forKey: .contentType)
    try values.encode(sizeBytes, forKey: .sizeBytes)
    try values.encode(filename, forKey: .filename)
  }

  public func encodedJSON() throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(self)
  }

  public static func decodeJSON(_ data: Data) throws -> RoomPieceManifest {
    try JSONDecoder().decode(RoomPieceManifest.self, from: data)
  }

  private static func encodeDate(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
  }

  private static func canonicalDate(_ date: Date) -> Date {
    Date(timeIntervalSince1970: (date.timeIntervalSince1970 * 1_000).rounded() / 1_000)
  }

  private static func decodeDate(_ value: String) throws -> Date {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }
    let wholeSeconds = ISO8601DateFormatter()
    wholeSeconds.formatOptions = [.withInternetDateTime]
    guard let date = wholeSeconds.date(from: value) else {
      throw RoomPiecePipelineError.invalidManifest("timestamp is not UTC ISO-8601")
    }
    return date
  }
}

public struct RoomPiecePlan: Equatable, Sendable {
  public let sessionID: String
  public let index: Int
  public let segmentID: String
  public let sampleStart: Int64
  public let sampleEnd: Int64
  public let startedAt: Date
  public let endedAt: Date
  public let durationMS: Int64
  public let gapBeforeMS: Int64

  public var byteOffset: Int64 { sampleStart * TapeConstants.bytesPerSample }
  public var byteCount: Int64 { (sampleEnd - sampleStart) * TapeConstants.bytesPerSample }

  public func manifest(sizeBytes: Int64, filename: String? = nil) throws -> RoomPieceManifest {
    try RoomPieceManifest(
      sessionID: sessionID,
      index: index,
      segmentID: segmentID,
      sampleStart: sampleStart,
      sampleEnd: sampleEnd,
      startedAt: startedAt,
      endedAt: endedAt,
      durationMS: durationMS,
      gapBeforeMS: gapBeforeMS,
      sizeBytes: sizeBytes,
      filename: filename ?? Self.defaultFilename(sessionID: sessionID, index: index)
    )
  }

  public static func defaultFilename(sessionID: String, index: Int) -> String {
    let safeSession = sessionID.map { character in
      character.isLetter || character.isNumber || character == "_" || character == "-"
        ? character : "_"
    }
    return "\(String(safeSession))_chunk_\(String(format: "%05d", index)).webm"
  }
}

public enum RoomPiecePlanner {
  public static let fullPieceSamples: Int64 = 4_800_000

  public static func plan(
    records: [IndexRecord],
    sessionID: String,
    segmentID: String,
    startingIndex: Int,
    startingSample: Int64,
    initialGapBeforeMS: Int64 = 0,
    finalFlush: Bool = false
  ) throws -> [RoomPiecePlan] {
    guard !sessionID.isEmpty, !segmentID.isEmpty, startingIndex >= 0, startingSample >= 0,
      initialGapBeforeMS >= 0
    else {
      throw RoomPiecePipelineError.invalidManifest("invalid planning identity or cursor")
    }
    guard !records.isEmpty else { return [] }

    var priorSample: Int64 = -1
    for (index, record) in records.enumerated() {
      guard let sample = record.samples, let offset = record.byteOffset, sample >= 0,
        sample <= Int64.max / TapeConstants.bytesPerSample,
        offset == sample * TapeConstants.bytesPerSample
      else {
        throw RoomPiecePipelineError.invalidIndexRecord(index)
      }
      guard sample >= priorSample else { throw RoomPiecePipelineError.nonMonotonicIndex(index) }
      priorSample = sample
    }

    struct Region {
      let start: Int64
      let end: Int64
      let anchorSample: Int64
      let anchorWallNS: UInt64
      let gapBeforeMS: Int64
      let closesAtDiscontinuity: Bool
    }

    let firstSample = records[0].samples!
    var regionStart = firstSample
    var regionGap = initialGapBeforeMS
    var anchor: (sample: Int64, wallNS: UInt64)?
    var durableEnd = firstSample
    var regions: [Region] = []

    for record in records {
      let sample = record.samples!
      if record.discontinuity != nil {
        let nextGap = gapMilliseconds(for: record)
        if sample > regionStart {
          guard let anchor else {
            throw RoomPiecePipelineError.missingTimestampAnchor(regionStart)
          }
          regions.append(
            Region(
              start: regionStart,
              end: sample,
              anchorSample: anchor.sample,
              anchorWallNS: anchor.wallNS,
              gapBeforeMS: regionGap,
              closesAtDiscontinuity: true
            ))
          regionGap = nextGap
        } else {
          regionGap = max(regionGap, nextGap)
        }
        regionStart = sample
        durableEnd = sample
        anchor = (sample, record.wallNS)
      } else {
        durableEnd = sample
        // A checkpoint at a region boundary is the first resumed audio frame. It replaces the
        // preceding discontinuity timestamp, which marks when capture stopped rather than resumed.
        if anchor == nil || sample == regionStart { anchor = (sample, record.wallNS) }
      }
    }

    if durableEnd > regionStart {
      guard let anchor else {
        throw RoomPiecePipelineError.missingTimestampAnchor(regionStart)
      }
      regions.append(
        Region(
          start: regionStart,
          end: durableEnd,
          anchorSample: anchor.sample,
          anchorWallNS: anchor.wallNS,
          gapBeforeMS: regionGap,
          closesAtDiscontinuity: false
        ))
    }

    guard let finalIndexedSample = records.last?.samples, startingSample <= finalIndexedSample
    else {
      throw RoomPiecePipelineError.uncoveredSample(startingSample)
    }

    var cursor = startingSample
    var pieceIndex = startingIndex
    var result: [RoomPiecePlan] = []
    for region in regions {
      if cursor >= region.end { continue }
      guard cursor >= region.start else {
        throw RoomPiecePipelineError.uncoveredSample(cursor)
      }

      while region.end - cursor >= fullPieceSamples {
        let end = cursor + fullPieceSamples
        result.append(
          makePlan(
            sessionID: sessionID,
            segmentID: segmentID,
            index: pieceIndex,
            start: cursor,
            end: end,
            anchorSample: region.anchorSample,
            anchorWallNS: region.anchorWallNS,
            gapBeforeMS: cursor == region.start ? region.gapBeforeMS : 0
          ))
        pieceIndex += 1
        cursor = end
      }

      if cursor < region.end && (region.closesAtDiscontinuity || finalFlush) {
        result.append(
          makePlan(
            sessionID: sessionID,
            segmentID: segmentID,
            index: pieceIndex,
            start: cursor,
            end: region.end,
            anchorSample: region.anchorSample,
            anchorWallNS: region.anchorWallNS,
            gapBeforeMS: cursor == region.start ? region.gapBeforeMS : 0
          ))
        pieceIndex += 1
        cursor = region.end
      }

      if region.closesAtDiscontinuity { cursor = region.end }
    }
    return result
  }

  private static func makePlan(
    sessionID: String,
    segmentID: String,
    index: Int,
    start: Int64,
    end: Int64,
    anchorSample: Int64,
    anchorWallNS: UInt64,
    gapBeforeMS: Int64
  ) -> RoomPiecePlan {
    let startedAt = timestamp(
      sample: start, anchorSample: anchorSample, anchorWallNS: anchorWallNS)
    let endedAt = timestamp(
      sample: end, anchorSample: anchorSample, anchorWallNS: anchorWallNS)
    let sampleCount = end - start
    let durationMS =
      (sampleCount * 1_000 + TapeConstants.sampleRate / 2)
      / TapeConstants.sampleRate
    return RoomPiecePlan(
      sessionID: sessionID,
      index: index,
      segmentID: segmentID,
      sampleStart: start,
      sampleEnd: end,
      startedAt: startedAt,
      endedAt: endedAt,
      durationMS: durationMS,
      gapBeforeMS: gapBeforeMS
    )
  }

  private static func timestamp(
    sample: Int64, anchorSample: Int64, anchorWallNS: UInt64
  ) -> Date {
    let sampleDelta = sample - anchorSample
    return Date(
      timeIntervalSince1970: Double(anchorWallNS) / 1_000_000_000
        + Double(sampleDelta) / Double(TapeConstants.sampleRate))
  }

  private static func milliseconds(fromNanoseconds value: UInt64) -> Int64 {
    let rounded = value / 1_000_000 + (value % 1_000_000 >= 500_000 ? 1 : 0)
    return Int64(min(rounded, UInt64(Int64.max)))
  }

  private static func gapMilliseconds(for record: IndexRecord) -> Int64 {
    switch record.discontinuity {
    case "capture_discontinuity", "resumed", "ring_overflow", "device_lost":
      return milliseconds(fromNanoseconds: record.gapNS ?? 0)
    default:
      return 0
    }
  }
}

public struct RoomPieceProcessResult: Equatable, Sendable {
  public let terminationStatus: Int32
  public let standardError: String

  public init(terminationStatus: Int32, standardError: String = "") {
    self.terminationStatus = terminationStatus
    self.standardError = standardError
  }
}

public struct FFmpegEncoderInvocation: Equatable, Sendable {
  public let executableURL: URL
  public let arguments: [String]
  public let outputURL: URL

  public init(executableURL: URL, arguments: [String], outputURL: URL) {
    self.executableURL = executableURL
    self.arguments = arguments
    self.outputURL = outputURL
  }
}

public protocol RoomPieceProcessRunning: Sendable {
  func run(_ invocation: FFmpegEncoderInvocation) throws -> RoomPieceProcessResult
}

public struct FoundationPieceProcessRunner: RoomPieceProcessRunning {
  public init() {}

  public func run(_ invocation: FFmpegEncoderInvocation) throws -> RoomPieceProcessResult {
    let process = Process()
    let errorPipe = Pipe()
    process.executableURL = invocation.executableURL
    process.arguments = invocation.arguments
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = errorPipe
    // Home Office 15 Sep 2026: a 3-day pid leaked ~4847 PIPEs (ulimit -n 256 → EMFILE on
    // .pcm.tmp). Foundation keeps both pipe ends unless we close them; cutter retries ~1.5s.
    defer {
      try? errorPipe.fileHandleForReading.close()
      try? errorPipe.fileHandleForWriting.close()
    }
    try process.run()
    try? errorPipe.fileHandleForWriting.close()
    let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return RoomPieceProcessResult(
      terminationStatus: process.terminationStatus,
      standardError: String(decoding: errorData.prefix(4_096), as: UTF8.self)
    )
  }
}

public struct FFmpegEncoderCommand: Equatable, Sendable {
  public let executableURL: URL

  public init(executableURL: URL) {
    self.executableURL = executableURL
  }

  public func invocation(inputPCMURL: URL, outputWebMURL: URL) -> FFmpegEncoderInvocation {
    FFmpegEncoderInvocation(
      executableURL: executableURL,
      arguments: [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
        "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", inputPCMURL.path,
        "-map_metadata", "-1", "-c:a", "libopus", "-application", "voip",
        "-b:a", "32k", "-vbr", "on", "-frame_duration", "20",
        "-f", "webm", outputWebMURL.path,
      ],
      outputURL: outputWebMURL
    )
  }
}

public struct FFmpegPieceEncoder: Sendable {
  public let command: FFmpegEncoderCommand
  private let runner: any RoomPieceProcessRunning

  public init(
    command: FFmpegEncoderCommand,
    runner: any RoomPieceProcessRunning = FoundationPieceProcessRunner()
  ) {
    self.command = command
    self.runner = runner
  }

  @discardableResult
  public func encode(plan: RoomPiecePlan, pcmURL: URL, destinationURL: URL) throws -> Int64 {
    guard plan.byteCount > 0, plan.byteCount <= Int64(Int.max) else {
      throw RoomPiecePipelineError.sourceRangeUnavailable(
        offset: plan.byteOffset, count: plan.byteCount)
    }
    guard !FileManager.default.fileExists(atPath: destinationURL.path) else {
      throw RoomPiecePipelineError.destinationExists(destinationURL.path)
    }

    let directory = destinationURL.deletingLastPathComponent()
    let token = UUID().uuidString
    let inputTemporary = directory.appendingPathComponent(".piece-\(token).pcm.tmp")
    let outputTemporary = directory.appendingPathComponent(".piece-\(token).webm.tmp")
    defer {
      try? FileManager.default.removeItem(at: inputTemporary)
      try? FileManager.default.removeItem(at: outputTemporary)
    }

    try copyExactRange(
      sourceURL: pcmURL,
      offset: plan.byteOffset,
      count: plan.byteCount,
      destinationURL: inputTemporary
    )
    let result = try runner.run(
      command.invocation(inputPCMURL: inputTemporary, outputWebMURL: outputTemporary))
    guard result.terminationStatus == 0 else {
      throw RoomPiecePipelineError.processFailed(
        status: result.terminationStatus,
        stderr: result.standardError.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    let outputSize = try synchronizeRegularFile(outputTemporary)
    guard outputSize > 0 else { throw RoomPiecePipelineError.emptyOutput }
    guard chmod(outputTemporary.path, S_IRUSR | S_IWUSR) == 0 else {
      throw RoomPiecePipelineError.writeFailed(outputTemporary.path, errno)
    }
    try installWithoutReplacement(source: outputTemporary, destination: destinationURL)
    try synchronizeDirectory(directory)
    return outputSize
  }
}

public struct RoomPieceUploadVerification: Equatable, Sendable {
  public let sessionID: String
  public let index: Int
  public let sizeBytes: Int64

  public init(sessionID: String, index: Int, sizeBytes: Int64) {
    self.sessionID = sessionID
    self.index = index
    self.sizeBytes = sizeBytes
  }
}

public struct RoomSpooledPiece: Equatable, Sendable {
  public let manifest: RoomPieceManifest
  public let manifestURL: URL
  public let mediaURL: URL
}

public struct RoomPieceSpool: Sendable {
  public let rootURL: URL

  public init(rootURL: URL) throws {
    self.rootURL = rootURL.standardizedFileURL
    try FileManager.default.createDirectory(
      at: self.rootURL, withIntermediateDirectories: true,
      attributes: [.posixPermissions: NSNumber(value: 0o700)])
    guard chmod(self.rootURL.path, S_IRUSR | S_IWUSR | S_IXUSR) == 0 else {
      throw RoomPiecePipelineError.writeFailed(self.rootURL.path, errno)
    }
    try requireDirectory(self.rootURL)
  }

  public func mediaURL(for manifest: RoomPieceManifest) -> URL {
    rootURL.appendingPathComponent(manifest.filename, isDirectory: false)
  }

  public func publish(_ manifest: RoomPieceManifest) throws -> RoomSpooledPiece {
    let mediaURL = mediaURL(for: manifest)
    let actualSize = try regularFileSize(mediaURL)
    guard actualSize == manifest.sizeBytes else {
      throw RoomPiecePipelineError.invalidManifest(
        "media size \(actualSize) does not match \(manifest.sizeBytes)")
    }
    guard chmod(mediaURL.path, S_IRUSR | S_IWUSR) == 0 else {
      throw RoomPiecePipelineError.writeFailed(mediaURL.path, errno)
    }

    let manifestURL = self.manifestURL(for: manifest)
    guard !FileManager.default.fileExists(atPath: manifestURL.path) else {
      throw RoomPiecePipelineError.destinationExists(manifestURL.path)
    }
    let temporary = rootURL.appendingPathComponent(
      ".manifest-\(UUID().uuidString).json.tmp", isDirectory: false)
    defer { try? FileManager.default.removeItem(at: temporary) }
    try writeSynchronized(manifest.encodedJSON(), to: temporary)
    try installWithoutReplacement(source: temporary, destination: manifestURL)
    try synchronizeDirectory(rootURL)
    return RoomSpooledPiece(
      manifest: manifest, manifestURL: manifestURL, mediaURL: mediaURL)
  }

  public func pending() throws -> [RoomSpooledPiece] {
    let urls = try FileManager.default.contentsOfDirectory(
      at: rootURL,
      includingPropertiesForKeys: nil,
      options: [.skipsHiddenFiles, .skipsSubdirectoryDescendants])
    var pieces: [RoomSpooledPiece] = []
    for manifestURL in urls where manifestURL.lastPathComponent.hasSuffix(".manifest.json") {
      let manifest = try RoomPieceManifest.decodeJSON(Data(contentsOf: manifestURL))
      let mediaURL = mediaURL(for: manifest)
      guard try regularFileSize(mediaURL) == manifest.sizeBytes else {
        throw RoomPiecePipelineError.invalidManifest(
          "spooled media is missing or changed for \(manifest.filename)")
      }
      pieces.append(
        RoomSpooledPiece(
          manifest: manifest, manifestURL: manifestURL, mediaURL: mediaURL))
    }
    return pieces.sorted {
      if $0.manifest.startedAt != $1.manifest.startedAt {
        return $0.manifest.startedAt < $1.manifest.startedAt
      }
      if $0.manifest.sessionID != $1.manifest.sessionID {
        return $0.manifest.sessionID < $1.manifest.sessionID
      }
      return $0.manifest.index < $1.manifest.index
    }
  }

  public func removeVerified(
    _ piece: RoomSpooledPiece, verification: RoomPieceUploadVerification
  ) throws {
    let manifest = piece.manifest
    guard verification.sessionID == manifest.sessionID,
      verification.index == manifest.index,
      verification.sizeBytes == manifest.sizeBytes,
      piece.manifestURL.standardizedFileURL == manifestURL(for: manifest).standardizedFileURL,
      piece.mediaURL.standardizedFileURL == mediaURL(for: manifest).standardizedFileURL,
      try regularFileSize(piece.mediaURL) == manifest.sizeBytes
    else {
      throw RoomPiecePipelineError.verificationMismatch
    }
    try FileManager.default.removeItem(at: piece.manifestURL)
    try synchronizeDirectory(rootURL)
    try FileManager.default.removeItem(at: piece.mediaURL)
    try synchronizeDirectory(rootURL)
  }

  private func manifestURL(for manifest: RoomPieceManifest) -> URL {
    rootURL.appendingPathComponent("\(manifest.filename).manifest.json", isDirectory: false)
  }
}

private func copyExactRange(
  sourceURL: URL, offset: Int64, count: Int64, destinationURL: URL
) throws {
  let sourceFD = open(sourceURL.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
  guard sourceFD >= 0 else {
    throw RoomPiecePipelineError.sourceOpenFailed(sourceURL.path, errno)
  }
  defer { _ = close(sourceFD) }
  var sourceStat = stat()
  guard fstat(sourceFD, &sourceStat) == 0, sourceStat.st_mode & S_IFMT == S_IFREG,
    sourceStat.st_size >= 0, offset >= 0, count >= 0,
    offset <= sourceStat.st_size, count <= sourceStat.st_size - offset
  else {
    throw RoomPiecePipelineError.sourceRangeUnavailable(offset: offset, count: count)
  }

  let destinationFD = open(
    destinationURL.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
    S_IRUSR | S_IWUSR)
  guard destinationFD >= 0 else {
    throw RoomPiecePipelineError.writeFailed(destinationURL.path, errno)
  }
  defer { _ = close(destinationFD) }

  var buffer = [UInt8](repeating: 0, count: 1_048_576)
  var completed: Int64 = 0
  while completed < count {
    let request = min(buffer.count, Int(count - completed))
    let readCount = buffer.withUnsafeMutableBytes { bytes in
      pread(sourceFD, bytes.baseAddress!, request, off_t(offset + completed))
    }
    if readCount < 0 {
      if errno == EINTR { continue }
      throw RoomPiecePipelineError.readFailed(offset: offset + completed, errno: errno)
    }
    guard readCount > 0 else {
      throw RoomPiecePipelineError.sourceRangeUnavailable(offset: offset, count: count)
    }
    try buffer.withUnsafeBytes { bytes in
      try writeAll(
        destinationFD, pointer: bytes.baseAddress!, count: readCount, path: destinationURL.path)
    }
    completed += Int64(readCount)
  }
}

private func writeSynchronized(_ data: Data, to url: URL) throws {
  let fileDescriptor = open(
    url.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
    S_IRUSR | S_IWUSR)
  guard fileDescriptor >= 0 else { throw RoomPiecePipelineError.writeFailed(url.path, errno) }
  defer { _ = close(fileDescriptor) }
  try data.withUnsafeBytes { bytes in
    try writeAll(fileDescriptor, pointer: bytes.baseAddress!, count: bytes.count, path: url.path)
  }
  while fsync(fileDescriptor) != 0 {
    if errno == EINTR { continue }
    throw RoomPiecePipelineError.writeFailed(url.path, errno)
  }
}

private func writeAll(_ fileDescriptor: Int32, pointer: UnsafeRawPointer, count: Int, path: String)
  throws
{
  var completed = 0
  while completed < count {
    let result = write(fileDescriptor, pointer.advanced(by: completed), count - completed)
    if result < 0 {
      if errno == EINTR { continue }
      throw RoomPiecePipelineError.writeFailed(path, errno)
    }
    guard result > 0 else { throw RoomPiecePipelineError.writeFailed(path, EIO) }
    completed += result
  }
}

private func synchronizeRegularFile(_ url: URL) throws -> Int64 {
  let fileDescriptor = open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
  guard fileDescriptor >= 0 else { throw RoomPiecePipelineError.emptyOutput }
  defer { _ = close(fileDescriptor) }
  var info = stat()
  guard fstat(fileDescriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size >= 0
  else { throw RoomPiecePipelineError.emptyOutput }
  while fsync(fileDescriptor) != 0 {
    if errno == EINTR { continue }
    throw RoomPiecePipelineError.writeFailed(url.path, errno)
  }
  return info.st_size
}

private func regularFileSize(_ url: URL) throws -> Int64 {
  let fileDescriptor = open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
  guard fileDescriptor >= 0 else {
    throw RoomPiecePipelineError.io("missing spooled file \(url.path)")
  }
  defer { _ = close(fileDescriptor) }
  var info = stat()
  guard fstat(fileDescriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size >= 0
  else { throw RoomPiecePipelineError.io("spooled path is not a regular file: \(url.path)") }
  return info.st_size
}

private func requireDirectory(_ url: URL) throws {
  let fileDescriptor = open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
  guard fileDescriptor >= 0 else { throw RoomPiecePipelineError.io("cannot open spool root") }
  defer { _ = close(fileDescriptor) }
  var info = stat()
  guard fstat(fileDescriptor, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else {
    throw RoomPiecePipelineError.io("spool root is not a directory")
  }
}

private func installWithoutReplacement(source: URL, destination: URL) throws {
  guard link(source.path, destination.path) == 0 else {
    let code = errno
    if code == EEXIST { throw RoomPiecePipelineError.destinationExists(destination.path) }
    throw RoomPiecePipelineError.writeFailed(destination.path, code)
  }
  guard unlink(source.path) == 0 else {
    throw RoomPiecePipelineError.writeFailed(source.path, errno)
  }
}

private func synchronizeDirectory(_ url: URL) throws {
  let fileDescriptor = open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
  guard fileDescriptor >= 0 else {
    throw RoomPiecePipelineError.writeFailed(url.path, errno)
  }
  defer { _ = close(fileDescriptor) }
  while fsync(fileDescriptor) != 0 {
    if errno == EINTR { continue }
    throw RoomPiecePipelineError.writeFailed(url.path, errno)
  }
}
