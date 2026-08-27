import Foundation
import TapeCore

public struct UnsignedDevelopmentDerivationCommandOptions: Equatable, Sendable {
  public let directory: URL
  public let stableDeviceUID: String
  public let sessionID: String
  public let finalFlush: Bool
  public let archive: UnsignedDevelopmentArchiveOptions

  public static func parse(_ arguments: [String]) throws
    -> UnsignedDevelopmentDerivationCommandOptions
  {
    let valueNames = [
      "--dir", "--device", "--session", "--archive-stream", "--archive-room",
      "--archive-date", "--archive-lane",
    ]
    var values: [String: String] = [:]
    var finalFlush = false
    var index = 0
    while index < arguments.count {
      let name = arguments[index]
      if name == "--final" {
        guard !finalFlush else { throw RecorderError("duplicate option: --final") }
        finalFlush = true
        index += 1
        continue
      }
      guard valueNames.contains(name) else {
        throw RecorderError("unknown unsigned development derivation option: \(name)")
      }
      guard values[name] == nil else { throw RecorderError("duplicate option: \(name)") }
      guard index + 1 < arguments.count, !arguments[index + 1].hasPrefix("--") else {
        throw RecorderError("missing value for \(name)")
      }
      values[name] = arguments[index + 1]
      index += 2
    }
    let missing = valueNames.filter { values[$0] == nil }
    guard missing.isEmpty else {
      throw RecorderError(
        "unsigned development derivation requires \(missing.joined(separator: ", "))")
    }
    guard let stream = UUID(uuidString: values["--archive-stream"]!) else {
      throw RecorderError("malformed --archive-stream UUID")
    }
    guard !values["--dir"]!.isEmpty else {
      throw RecorderError("--dir must not be empty")
    }
    let sessionID = values["--session"]!
    guard !sessionID.isEmpty, sessionID.utf8.count <= 256 else {
      throw RecorderError("--session must be 1...256 UTF-8 bytes")
    }
    return UnsignedDevelopmentDerivationCommandOptions(
      directory: URL(fileURLWithPath: values["--dir"]!).standardizedFileURL,
      stableDeviceUID: values["--device"]!,
      sessionID: sessionID,
      finalFlush: finalFlush,
      archive: try UnsignedDevelopmentArchiveOptions(
        streamUUID: stream,
        roomID: values["--archive-room"]!,
        istDate: values["--archive-date"]!,
        laneID: values["--archive-lane"]!
      )
    )
  }
}

public struct UnsignedDevelopmentDerivationReport: Codable, Equatable, Sendable {
  public struct Reservation: Codable, Equatable, Sendable {
    public let reservationID: String
    public let chunkIndex: UInt32
    public let sampleStart: UInt64
    public let sampleEnd: UInt64
    public let uncertainty: String?

    enum CodingKeys: String, CodingKey {
      case reservationID = "reservation_id"
      case chunkIndex = "chunk_idx"
      case sampleStart = "sample_start"
      case sampleEnd = "sample_end"
      case uncertainty
    }
  }

  public let ok: Bool
  public let authenticatedSampleCount: UInt64
  public let authenticatedSampleEnd: UInt64
  public let reservationCount: Int
  public let reservations: [Reservation]
  public let journalRecordsWritten: Int
  public let levelRecordCount: Int
  public let levelObservationCount: Int
  public let levelRecordsWritten: Int
  public let sidecarSampleCount: UInt64
  public let repairedJournalTrailingByteCount: UInt64
  public let repairedLevelTrailingByteCount: UInt64

  enum CodingKeys: String, CodingKey {
    case ok
    case authenticatedSampleCount = "authenticated_sample_count"
    case authenticatedSampleEnd = "authenticated_sample_end"
    case reservationCount = "reservation_count"
    case reservations
    case journalRecordsWritten = "journal_records_written"
    case levelRecordCount = "level_record_count"
    case levelObservationCount = "level_observation_count"
    case levelRecordsWritten = "level_records_written"
    case sidecarSampleCount = "sidecar_sample_count"
    case repairedJournalTrailingByteCount = "repaired_journal_trailing_byte_count"
    case repairedLevelTrailingByteCount = "repaired_level_trailing_byte_count"
  }

  public static func derive(
    options: UnsignedDevelopmentDerivationCommandOptions
  ) throws -> UnsignedDevelopmentDerivationReport {
    UnsignedDevelopmentArchiveWriter.printNonConfidentialWarning()
    let archive = options.archive
    let result = try ArchiveLocalDeriver.derive(
      tapeURL: options.directory.appendingPathComponent(archive.tapeBasename),
      indexURL: options.directory.appendingPathComponent(archive.indexBasename),
      journalURL: options.directory.appendingPathComponent("\(archive.laneID).jrn"),
      levelURL: options.directory.appendingPathComponent("\(archive.laneID).lvl"),
      rootKey: unsignedDevelopmentArchivePublishedFixedTestRootKey,
      context: archive.context(stableDeviceUID: options.stableDeviceUID),
      sessionID: options.sessionID,
      finalFlush: options.finalFlush
    )
    let sidecarSamples = result.levelRecords.reduce(UInt64(0)) {
      $0 + UInt64($1.sampleCount)
    }
    let observations = result.levelRecords.reduce(0) { $0 + $1.observations.count }
    return UnsignedDevelopmentDerivationReport(
      ok: sidecarSamples == result.authenticatedSampleCount,
      authenticatedSampleCount: result.authenticatedSampleCount,
      authenticatedSampleEnd: result.authenticatedSampleEnd,
      reservationCount: result.reservations.count,
      reservations: result.reservations.map {
        Reservation(
          reservationID: $0.reservationID,
          chunkIndex: $0.chunkIndex,
          sampleStart: $0.sampleStart,
          sampleEnd: $0.sampleEnd,
          uncertainty: $0.uncertainty?.rawValue
        )
      },
      journalRecordsWritten: result.journalRecordsWritten,
      levelRecordCount: result.levelRecords.count,
      levelObservationCount: observations,
      levelRecordsWritten: result.levelRecordsWritten,
      sidecarSampleCount: sidecarSamples,
      repairedJournalTrailingByteCount: result.repairedJournalTrailingByteCount,
      repairedLevelTrailingByteCount: result.repairedLevelTrailingByteCount
    )
  }
}
