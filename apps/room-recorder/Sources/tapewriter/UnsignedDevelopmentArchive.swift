import Darwin
import Foundation
import TapeCore

let unsignedDevelopmentArchivePublishedFixedTestRootKey = Data(UInt8(0x00)...UInt8(0x1F))

public struct UnsignedDevelopmentArchiveOptions: Equatable, Sendable {
  public let streamUUID: UUID
  public let roomID: String
  public let istDate: String
  public let laneID: String

  public init(streamUUID: UUID, roomID: String, istDate: String, laneID: String) throws {
    let laneBytes = Array(laneID.utf8)
    let allowed = { (byte: UInt8) in
      (0x30...0x39).contains(byte) || (0x41...0x5A).contains(byte)
        || (0x61...0x7A).contains(byte) || byte == 0x2D || byte == 0x2E || byte == 0x5F
    }
    guard !laneBytes.isEmpty, laneBytes.count <= 64, laneBytes.allSatisfy(allowed),
      laneID != ".", laneID != ".."
    else {
      throw RecorderError(
        "--archive-lane must be 1...64 ASCII letters, digits, '.', '-', or '_' and not '.' or '..'"
      )
    }

    let streamBytes = withUnsafeBytes(of: streamUUID.uuid) { Data($0) }
    do {
      _ = try ArchiveContext(
        streamUUID: streamBytes,
        roomID: roomID,
        istDate: istDate,
        laneID: laneID,
        stableDeviceUID: "unsigned-development-validation"
      ).encodedBytes()
    } catch {
      throw RecorderError("invalid unsigned development archive context: \(error)")
    }

    self.streamUUID = streamUUID
    self.roomID = roomID
    self.istDate = istDate
    self.laneID = laneID
  }

  var streamUUIDBytes: Data {
    withUnsafeBytes(of: streamUUID.uuid) { Data($0) }
  }

  func context(stableDeviceUID: String) -> ArchiveContext {
    ArchiveContext(
      streamUUID: streamUUIDBytes,
      roomID: roomID,
      istDate: istDate,
      laneID: laneID,
      stableDeviceUID: stableDeviceUID
    )
  }

  var tapeBasename: String { "\(laneID).tape" }
  var indexBasename: String { "\(laneID).index" }
}

public struct RecordCommandOptions: Equatable, Sendable {
  public let outputDirectory: URL
  public let requestedDeviceUID: String?
  public let unsignedDevelopmentArchive: UnsignedDevelopmentArchiveOptions?

  public static func parse(_ arguments: [String]) throws -> RecordCommandOptions {
    let valueOptions: Set<String> = [
      "--out", "--device", "--archive-stream", "--archive-room", "--archive-date",
      "--archive-lane",
    ]
    var values: [String: String] = [:]
    var archiveEnabled = false
    var index = 0
    while index < arguments.count {
      let argument = arguments[index]
      if argument == "--unsigned-development-archive" {
        guard !archiveEnabled else { throw RecorderError("duplicate option: \(argument)") }
        archiveEnabled = true
        index += 1
        continue
      }
      guard valueOptions.contains(argument) else {
        throw RecorderError("unknown record option: \(argument)")
      }
      guard values[argument] == nil else { throw RecorderError("duplicate option: \(argument)") }
      guard index + 1 < arguments.count, !arguments[index + 1].hasPrefix("--") else {
        throw RecorderError("missing value for \(argument)")
      }
      values[argument] = arguments[index + 1]
      index += 2
    }

    guard let output = values["--out"], !output.isEmpty else {
      throw RecorderError("required option: --out")
    }
    let archiveNames = ["--archive-stream", "--archive-room", "--archive-date", "--archive-lane"]
    let suppliedArchiveNames = archiveNames.filter { values[$0] != nil }
    if !archiveEnabled, !suppliedArchiveNames.isEmpty {
      throw RecorderError(
        "archive context requires --unsigned-development-archive")
    }

    let archive: UnsignedDevelopmentArchiveOptions?
    if archiveEnabled {
      let missing = archiveNames.filter { values[$0] == nil }
      guard missing.isEmpty else {
        throw RecorderError(
          "unsigned development archive requires \(missing.joined(separator: ", "))")
      }
      guard let stream = UUID(uuidString: values["--archive-stream"]!) else {
        throw RecorderError("malformed --archive-stream UUID")
      }
      archive = try UnsignedDevelopmentArchiveOptions(
        streamUUID: stream,
        roomID: values["--archive-room"]!,
        istDate: values["--archive-date"]!,
        laneID: values["--archive-lane"]!
      )
    } else {
      archive = nil
    }

    return RecordCommandOptions(
      outputDirectory: URL(fileURLWithPath: output).standardizedFileURL,
      requestedDeviceUID: values["--device"],
      unsignedDevelopmentArchive: archive
    )
  }
}

public struct UnsignedDevelopmentArchiveInspectionCommandOptions: Equatable, Sendable {
  public let directory: URL
  public let stableDeviceUID: String
  public let archive: UnsignedDevelopmentArchiveOptions

  public static func parse(_ arguments: [String]) throws
    -> UnsignedDevelopmentArchiveInspectionCommandOptions
  {
    let names = [
      "--dir", "--device", "--archive-stream", "--archive-room", "--archive-date",
      "--archive-lane",
    ]
    var values: [String: String] = [:]
    var index = 0
    while index < arguments.count {
      let name = arguments[index]
      guard names.contains(name) else {
        throw RecorderError("unknown archive inspection option: \(name)")
      }
      guard values[name] == nil else { throw RecorderError("duplicate option: \(name)") }
      guard index + 1 < arguments.count, !arguments[index + 1].hasPrefix("--") else {
        throw RecorderError("missing value for \(name)")
      }
      values[name] = arguments[index + 1]
      index += 2
    }
    let missing = names.filter { values[$0] == nil }
    guard missing.isEmpty else {
      throw RecorderError(
        "unsigned development archive inspection requires \(missing.joined(separator: ", "))")
    }
    guard let stream = UUID(uuidString: values["--archive-stream"]!) else {
      throw RecorderError("malformed --archive-stream UUID")
    }
    return UnsignedDevelopmentArchiveInspectionCommandOptions(
      directory: URL(fileURLWithPath: values["--dir"]!).standardizedFileURL,
      stableDeviceUID: values["--device"]!,
      archive: try UnsignedDevelopmentArchiveOptions(
        streamUUID: stream,
        roomID: values["--archive-room"]!,
        istDate: values["--archive-date"]!,
        laneID: values["--archive-lane"]!
      )
    )
  }
}

public struct UnsignedDevelopmentArchiveInspection: Codable, Equatable, Sendable {
  public let ok: Bool
  public let recordCount: Int
  public let sampleCount: UInt64
  public let plaintextByteCount: UInt64
  public let stagingByteCount: UInt64
  public let plaintextMatchesStaging: Bool
  public let fullRecordCount: Int
  public let shortRecordCount: Int

  enum CodingKeys: String, CodingKey {
    case ok
    case recordCount = "record_count"
    case sampleCount = "sample_count"
    case plaintextByteCount = "plaintext_byte_count"
    case stagingByteCount = "staging_byte_count"
    case plaintextMatchesStaging = "plaintext_matches_staging"
    case fullRecordCount = "full_record_count"
    case shortRecordCount = "short_record_count"
  }

  public static func inspect(
    directory: URL,
    options: UnsignedDevelopmentArchiveOptions,
    stableDeviceUID: String
  ) throws -> UnsignedDevelopmentArchiveInspection {
    let tapeURL = directory.appendingPathComponent(options.tapeBasename)
    let indexURL = directory.appendingPathComponent(options.indexBasename)
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let context = options.context(stableDeviceUID: stableDeviceUID)
    let scan = try ArchiveLaneStore.inspect(
      tapeURL: tapeURL,
      indexURL: indexURL,
      rootKey: unsignedDevelopmentArchivePublishedFixedTestRootKey,
      context: context
    )
    let tapeFD = open(tapeURL.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    guard tapeFD >= 0 else { throw RecorderError.posix("cannot open development archive tape") }
    defer { close(tapeFD) }
    let pcmFD = open(pcmURL.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    guard pcmFD >= 0 else { throw RecorderError.posix("cannot open plaintext staging tape") }
    defer { close(pcmFD) }

    let contextHash = try context.sha256()
    var plaintextByteCount: UInt64 = 0
    var plaintextMatchesStaging = true
    var fullRecordCount = 0
    for record in scan.tape.records {
      let encryptedCount = record.encryptedEndOffset - record.encryptedStartOffset
      let encoded = try readExactly(
        fileDescriptor: tapeFD,
        offset: record.encryptedStartOffset,
        byteCount: encryptedCount,
        label: "development archive tape"
      )
      let opened = try ArchiveRecordCrypto.open(
        encoded,
        rootKey: unsignedDevelopmentArchivePublishedFixedTestRootKey,
        expectedPurpose: .tape,
        expectedContextHash: contextHash
      )
      let staging = try readExactly(
        fileDescriptor: pcmFD,
        offset: plaintextByteCount,
        byteCount: UInt64(opened.plaintext.count),
        label: "plaintext staging tape"
      )
      plaintextMatchesStaging = plaintextMatchesStaging && opened.plaintext == staging
      plaintextByteCount += UInt64(opened.plaintext.count)
      if record.header.logicalUnitCount == 16_000 { fullRecordCount += 1 }
    }
    var stagingStat = stat()
    guard fstat(pcmFD, &stagingStat) == 0, stagingStat.st_mode & S_IFMT == S_IFREG,
      stagingStat.st_size >= 0
    else {
      throw RecorderError.posix("cannot inspect plaintext staging tape")
    }
    let stagingByteCount = UInt64(stagingStat.st_size)
    plaintextMatchesStaging = plaintextMatchesStaging && plaintextByteCount == stagingByteCount
    let sampleCount = scan.index.records.last?.payload.sampleEnd ?? 0
    return UnsignedDevelopmentArchiveInspection(
      ok: plaintextMatchesStaging && scan.tape.records.count == scan.index.records.count,
      recordCount: scan.tape.records.count,
      sampleCount: sampleCount,
      plaintextByteCount: plaintextByteCount,
      stagingByteCount: stagingByteCount,
      plaintextMatchesStaging: plaintextMatchesStaging,
      fullRecordCount: fullRecordCount,
      shortRecordCount: scan.tape.records.count - fullRecordCount
    )
  }

  private static func readExactly(
    fileDescriptor: Int32,
    offset: UInt64,
    byteCount: UInt64,
    label: String
  ) throws -> Data {
    guard offset <= UInt64(Int64.max), byteCount <= UInt64(Int.max),
      byteCount <= UInt64(Int64.max) - offset
    else {
      throw RecorderError("\(label) range is too large")
    }
    let count = Int(byteCount)
    var data = Data(count: count)
    try data.withUnsafeMutableBytes { bytes in
      var completed = 0
      while completed < count {
        let result = pread(
          fileDescriptor,
          bytes.baseAddress!.advanced(by: completed),
          count - completed,
          Int64(offset) + Int64(completed)
        )
        if result < 0, errno == EINTR { continue }
        guard result >= 0 else { throw RecorderError.posix("cannot read \(label)") }
        guard result > 0 else { throw RecorderError("unexpected end of \(label)") }
        completed += result
      }
    }
    return data
  }
}

struct ArchiveDiscontinuityObservation: Equatable {
  let discontinuity: ArchiveIndexDiscontinuity
  let reason: String
  let gapNS: UInt64?
  let monoNS: UInt64?
  let wallNS: UInt64?
}

struct ArchiveDiscontinuityAccumulator {
  private var facts: [StreamMarker: UInt64] = [:]
  private var maximumGapNS: UInt64 = 0
  private var singleMonoNS: UInt64?
  private var singleWallNS: UInt64?

  mutating func append(_ item: StreamItem) {
    guard item.marker != .none else { return }
    let previousCount = facts[item.marker] ?? 0
    facts[item.marker] = previousCount == UInt64.max ? UInt64.max : previousCount + 1
    maximumGapNS = max(maximumGapNS, item.gapNS)
    if facts.values.reduce(0, { $0 + min($1, 2) }) == 1 {
      singleMonoNS = item.monoStartNS
      singleWallNS = item.wallStartNS
    } else {
      singleMonoNS = nil
      singleWallNS = nil
    }
  }

  var observation: ArchiveDiscontinuityObservation? {
    guard !facts.isEmpty else { return nil }
    let totalFacts = facts.values.reduce(UInt64(0)) { partial, count in
      let addition = partial.addingReportingOverflow(count)
      return addition.overflow ? UInt64.max : addition.partialValue
    }
    if totalFacts == 1, let marker = facts.keys.first {
      return ArchiveDiscontinuityObservation(
        discontinuity: marker.archiveDiscontinuity,
        reason: marker.indexName,
        gapNS: maximumGapNS == 0 ? nil : maximumGapNS,
        monoNS: singleMonoNS,
        wallNS: singleWallNS
      )
    }
    let names = facts.keys.sorted { $0.indexName < $1.indexName }.map { marker in
      let count = facts[marker]!
      return count == 1 ? marker.indexName : "\(marker.indexName)*\(count)"
    }
    return ArchiveDiscontinuityObservation(
      discontinuity: .captureDiscontinuity,
      reason: "coalesced:\(names.joined(separator: ","))",
      gapNS: maximumGapNS == 0 ? nil : maximumGapNS,
      monoNS: nil,
      wallNS: nil
    )
  }

  mutating func removeAll() {
    facts.removeAll(keepingCapacity: true)
    maximumGapNS = 0
    singleMonoNS = nil
    singleWallNS = nil
  }
}

final class UnsignedDevelopmentArchiveWriter {
  private let store: ArchiveLaneStore
  private(set) var logicalByteEnd: Int64
  private var pendingDiscontinuities = ArchiveDiscontinuityAccumulator()

  private init(store: ArchiveLaneStore, logicalByteEnd: Int64) {
    self.store = store
    self.logicalByteEnd = logicalByteEnd
  }

  static func printNonConfidentialWarning() {
    fputs(
      "*** UNSIGNED DEVELOPMENT ARCHIVE: NOT CONFIDENTIAL; NON-CLINICAL AUDIO ONLY; NO NETWORK ***\n",
      stderr)
  }

  static func open(
    directory: URL,
    options: UnsignedDevelopmentArchiveOptions,
    stableDeviceUID: String,
    pcmFileDescriptor: Int32,
    plaintextByteCount: Int64,
    existingPlaintextHasContent: Bool
  ) throws -> UnsignedDevelopmentArchiveWriter {
    let context = options.context(stableDeviceUID: stableDeviceUID)
    _ = try context.encodedBytes()
    let tapeURL = directory.appendingPathComponent(options.tapeBasename)
    let indexURL = directory.appendingPathComponent(options.indexBasename)
    if existingPlaintextHasContent,
      !FileManager.default.fileExists(atPath: tapeURL.path),
      !FileManager.default.fileExists(atPath: indexURL.path)
    {
      throw RecorderError(
        "refusing to adopt nonempty legacy plaintext into an unsigned development archive"
      )
    }
    let store = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: tapeURL,
      indexURL: indexURL,
      rootKey: unsignedDevelopmentArchivePublishedFixedTestRootKey,
      context: context
    )
    do {
      let scan = store.scanResult
      let tapeSampleEnd =
        scan.tape.records.last.map {
          $0.header.firstLogicalUnit + UInt64($0.header.logicalUnitCount)
        } ?? 0
      let indexSampleEnd = scan.index.records.last?.payload.sampleEnd ?? 0
      guard tapeSampleEnd == indexSampleEnd else {
        throw RecorderError("development archive tape and index logical ends disagree")
      }
      guard indexSampleEnd <= UInt64(Int64.max / TapeConstants.bytesPerSample) else {
        throw RecorderError("development archive logical end exceeds plaintext staging capacity")
      }
      let authoritativeByteEnd = Int64(indexSampleEnd) * TapeConstants.bytesPerSample
      if authoritativeByteEnd == 0, existingPlaintextHasContent {
        throw RecorderError(
          "refusing to adopt nonempty legacy plaintext into an empty unsigned development archive"
        )
      }
      guard plaintextByteCount >= authoritativeByteEnd else {
        throw RecorderError(
          "plaintext tape.pcm is shorter than the authenticated development archive logical end"
        )
      }
      if plaintextByteCount > authoritativeByteEnd {
        guard ftruncate(pcmFileDescriptor, authoritativeByteEnd) == 0 else {
          throw RecorderError.posix("cannot truncate plaintext staging tail")
        }
        guard fcntl(pcmFileDescriptor, F_FULLFSYNC) == 0 else {
          throw RecorderError.posix("cannot sync truncated plaintext staging tail")
        }
      }
      return UnsignedDevelopmentArchiveWriter(
        store: store,
        logicalByteEnd: authoritativeByteEnd
      )
    } catch {
      store.close()
      throw error
    }
  }

  func noteDiscontinuity(_ item: StreamItem) {
    pendingDiscontinuities.append(item)
  }

  func mirrorDurablePCM(
    fileDescriptor: Int32,
    durableByteEnd: Int64,
    monoNS: UInt64,
    wallNS: UInt64
  ) throws {
    guard durableByteEnd >= logicalByteEnd, durableByteEnd.isMultiple(of: 2) else {
      throw RecorderError("plaintext staging range regressed or became unaligned")
    }
    while logicalByteEnd < durableByteEnd {
      let byteCount = Int(min(32_000, durableByteEnd - logicalByteEnd))
      guard byteCount > 0, byteCount.isMultiple(of: 2) else {
        throw RecorderError("invalid development archive PCM range")
      }
      let plaintext = try readExactly(
        fileDescriptor: fileDescriptor,
        offset: logicalByteEnd,
        byteCount: byteCount
      )
      let pending = pendingDiscontinuities.observation
      let isLastRecord = logicalByteEnd + Int64(byteCount) == durableByteEnd
      let result = try store.appendPCM(
        plaintext,
        observation: ArchiveIndexObservation(
          monoNS: pending?.monoNS ?? (pending == nil && isLastRecord ? monoNS : nil),
          wallNS: pending?.wallNS ?? (pending == nil && isLastRecord ? wallNS : nil),
          rmsQ15: rmsQ15(plaintext),
          nativeFrames: nil,
          inputRateNumerator: nil,
          inputRateDenominator: nil,
          discontinuity: pending?.discontinuity,
          reason: pending?.reason,
          gapNS: pending?.gapNS
        )
      )
      logicalByteEnd = Int64(result.index.payload.sampleEnd) * TapeConstants.bytesPerSample
      if pending != nil { pendingDiscontinuities.removeAll() }
    }
  }

  func close() {
    store.close()
  }

  private func readExactly(fileDescriptor: Int32, offset: Int64, byteCount: Int) throws -> Data {
    var data = Data(count: byteCount)
    try data.withUnsafeMutableBytes { bytes in
      var completed = 0
      while completed < byteCount {
        let result = pread(
          fileDescriptor,
          bytes.baseAddress!.advanced(by: completed),
          byteCount - completed,
          offset + Int64(completed)
        )
        if result < 0, errno == EINTR { continue }
        guard result >= 0 else {
          throw RecorderError.posix("cannot read durable plaintext staging")
        }
        guard result > 0 else {
          throw RecorderError("unexpected end of durable plaintext staging")
        }
        completed += result
      }
    }
    return data
  }

  private func rmsQ15(_ data: Data) -> UInt16 {
    var squaredSum = 0.0
    data.withUnsafeBytes { bytes in
      for offset in stride(from: 0, to: data.count, by: 2) {
        let bits = UInt16(bytes[offset]) | UInt16(bytes[offset + 1]) << 8
        let normalized = Double(Int16(bitPattern: bits)) / 32_768
        squaredSum += normalized * normalized
      }
    }
    let rms = sqrt(squaredSum / Double(data.count / 2))
    return UInt16(min(32_767, Int((rms * 32_767).rounded())))
  }
}

extension StreamMarker {
  fileprivate var archiveDiscontinuity: ArchiveIndexDiscontinuity {
    switch self {
    case .none, .configurationChange, .captureDiscontinuity:
      return .captureDiscontinuity
    case .restart:
      return .restart
    case .deviceLost:
      return .deviceLost
    case .resumed:
      return .resumed
    case .ringOverflow:
      return .ringOverflow
    case .invalidTimestamp:
      return .invalidTimestamp
    case .clockJump:
      return .clockDiscontinuity
    case .formatChange:
      return .formatChange
    }
  }
}
