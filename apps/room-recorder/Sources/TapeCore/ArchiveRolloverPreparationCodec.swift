import CryptoKit
import Foundation

public enum ArchiveRolloverPreparationError: Error, Equatable, Sendable {
  case invalidID(String)
  case invalidLane
  case invalidSessionSampleStart
  case authenticatedContextMismatch
  case authenticatedBoundaryMismatch(expected: UInt64, actual: UInt64)
  case nonAdjacentTargetDay
}

public struct ArchiveRolloverPreparation: Equatable, Sendable {
  public let commandID: String
  public let sessionID: String
  public let sessionSampleStart: UInt64
  public let oldDay: ArchiveDailyLaneIdentity
  public let boundarySample: UInt64
  public let nextChunkIndex: UInt32
  public let oldAuthenticatedFacts: ArchiveAuthenticatedLaneFacts
  public let targetISTDay: ArchiveISTDay

  public init(
    sessionID: String,
    sessionSampleStart: UInt64,
    oldDay: ArchiveDailyLaneIdentity,
    boundarySample: UInt64,
    nextChunkIndex: UInt32,
    oldAuthenticatedFacts: ArchiveAuthenticatedLaneFacts,
    targetISTDay: ArchiveISTDay
  ) throws {
    guard !sessionID.isEmpty, sessionID.utf8.count <= 256 else {
      throw ArchiveRolloverPreparationError.invalidID("session_id")
    }
    guard oldDay.laneID == "primary" else {
      throw ArchiveRolloverPreparationError.invalidLane
    }
    guard sessionSampleStart <= boundarySample else {
      throw ArchiveRolloverPreparationError.invalidSessionSampleStart
    }
    guard oldAuthenticatedFacts.context == oldDay.context else {
      throw ArchiveRolloverPreparationError.authenticatedContextMismatch
    }
    guard oldAuthenticatedFacts.initialSamplePosition == oldDay.expectedInitialSessionSample else {
      throw ArchiveRolloverPreparationError.authenticatedBoundaryMismatch(
        expected: oldDay.expectedInitialSessionSample,
        actual: oldAuthenticatedFacts.initialSamplePosition)
    }
    guard oldAuthenticatedFacts.authenticatedSampleEnd == boundarySample else {
      throw ArchiveRolloverPreparationError.authenticatedBoundaryMismatch(
        expected: boundarySample,
        actual: oldAuthenticatedFacts.authenticatedSampleEnd)
    }
    guard try oldDay.istDay.next == targetISTDay else {
      throw ArchiveRolloverPreparationError.nonAdjacentTargetDay
    }

    self.sessionID = sessionID
    self.sessionSampleStart = sessionSampleStart
    self.oldDay = oldDay
    self.boundarySample = boundarySample
    self.nextChunkIndex = nextChunkIndex
    self.oldAuthenticatedFacts = oldAuthenticatedFacts
    self.targetISTDay = targetISTDay
    commandID = Self.makeCommandID(
      sessionID: sessionID,
      sessionSampleStart: sessionSampleStart,
      oldDay: oldDay,
      boundarySample: boundarySample,
      nextChunkIndex: nextChunkIndex,
      oldAuthenticatedFacts: oldAuthenticatedFacts,
      targetISTDay: targetISTDay)
  }

  private static func makeCommandID(
    sessionID: String,
    sessionSampleStart: UInt64,
    oldDay: ArchiveDailyLaneIdentity,
    boundarySample: UInt64,
    nextChunkIndex: UInt32,
    oldAuthenticatedFacts: ArchiveAuthenticatedLaneFacts,
    targetISTDay: ArchiveISTDay
  ) -> String {
    var bytes = Data("eta.room-recorder/rollover-preparation/v1".utf8)
    append(sessionID, to: &bytes)
    append(sessionSampleStart, to: &bytes)
    append(oldDay.context.istDate, to: &bytes)
    append(oldDay.context.roomID, to: &bytes)
    append(oldDay.context.laneID, to: &bytes)
    append(oldDay.context.stableDeviceUID, to: &bytes)
    append(oldDay.context.streamUUID, to: &bytes)
    append(oldDay.expectedInitialSessionSample, to: &bytes)
    append(oldDay.keywrapDigestHex, to: &bytes)
    append(boundarySample, to: &bytes)
    append(nextChunkIndex, to: &bytes)
    append(oldAuthenticatedFacts.initialSamplePosition, to: &bytes)
    append(oldAuthenticatedFacts.authenticatedSampleEnd, to: &bytes)
    append(UInt64(oldAuthenticatedFacts.recordCount), to: &bytes)
    append(targetISTDay.description, to: &bytes)
    return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
  }

  private static func append(_ value: String, to data: inout Data) {
    append(Data(value.utf8), to: &data)
  }

  private static func append(_ value: Data, to data: inout Data) {
    append(UInt64(value.count), to: &data)
    data.append(value)
  }

  private static func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
    for index in 0..<MemoryLayout<T>.size {
      data.append(UInt8(truncatingIfNeeded: value >> T(index * 8)))
    }
  }
}

public enum ArchiveRolloverPreparationCodecError: Error, Equatable, Sendable {
  case payloadTooLarge(Int)
  case invalidMagic
  case unsupportedVersion(UInt16)
  case invalidUTF8
  case invalidLength
  case integerOverflow
  case commandIDMismatch
  case noncanonical
}

public enum ArchiveRolloverPreparationCodec {
  private static let magic = Data("ETARPR01".utf8)
  private static let version: UInt16 = 1
  public static let maximumEncodedByteCount = 1_048_576

  public static func encode(_ preparation: ArchiveRolloverPreparation) throws -> Data {
    var writer = Writer()
    writer.data.append(magic)
    writer.append(version)
    try writer.append(preparation.commandID)
    try writer.append(preparation.sessionID)
    writer.append(preparation.sessionSampleStart)
    try writer.append(preparation.oldDay)
    writer.append(preparation.boundarySample)
    writer.append(preparation.nextChunkIndex)
    writer.append(preparation.oldAuthenticatedFacts)
    try writer.append(preparation.targetISTDay.description)
    guard writer.data.count <= maximumEncodedByteCount else {
      throw ArchiveRolloverPreparationCodecError.payloadTooLarge(writer.data.count)
    }
    return writer.data
  }

  public static func decode(_ data: Data) throws -> ArchiveRolloverPreparation {
    guard data.count <= maximumEncodedByteCount else {
      throw ArchiveRolloverPreparationCodecError.payloadTooLarge(data.count)
    }
    var reader = Reader(data: data)
    guard try reader.read(count: magic.count) == magic else {
      throw ArchiveRolloverPreparationCodecError.invalidMagic
    }
    let version: UInt16 = try reader.integer()
    guard version == self.version else {
      throw ArchiveRolloverPreparationCodecError.unsupportedVersion(version)
    }
    let commandID = try reader.string()
    let sessionID = try reader.string()
    let sessionSampleStart: UInt64 = try reader.integer()
    let oldDay = try reader.laneIdentity()
    let boundarySample: UInt64 = try reader.integer()
    let nextChunkIndex: UInt32 = try reader.integer()
    let oldAuthenticatedFacts = try reader.facts(context: oldDay.context)
    let targetISTDay = try ArchiveISTDay(reader.string())
    guard reader.isAtEnd else { throw ArchiveRolloverPreparationCodecError.invalidLength }
    let preparation = try ArchiveRolloverPreparation(
      sessionID: sessionID,
      sessionSampleStart: sessionSampleStart,
      oldDay: oldDay,
      boundarySample: boundarySample,
      nextChunkIndex: nextChunkIndex,
      oldAuthenticatedFacts: oldAuthenticatedFacts,
      targetISTDay: targetISTDay)
    guard preparation.commandID == commandID else {
      throw ArchiveRolloverPreparationCodecError.commandIDMismatch
    }
    guard try encode(preparation) == data else {
      throw ArchiveRolloverPreparationCodecError.noncanonical
    }
    return preparation
  }

  private struct Writer {
    var data = Data()

    mutating func append<T: FixedWidthInteger>(_ value: T) {
      for offset in 0..<MemoryLayout<T>.size {
        data.append(UInt8(truncatingIfNeeded: value >> T(offset * 8)))
      }
    }

    mutating func append(_ value: Data) throws {
      guard value.count <= Int(UInt32.max) else {
        throw ArchiveRolloverPreparationCodecError.invalidLength
      }
      append(UInt32(value.count))
      data.append(value)
    }

    mutating func append(_ value: String) throws {
      try append(Data(value.utf8))
    }

    mutating func append(_ context: ArchiveContext) throws {
      try append(context.streamUUID)
      try append(context.roomID)
      try append(context.istDate)
      try append(context.laneID)
      try append(context.stableDeviceUID)
    }

    mutating func append(_ identity: ArchiveDailyLaneIdentity) throws {
      try append(identity.context)
      append(identity.expectedInitialSessionSample)
      try append(identity.keywrapDigestHex)
    }

    mutating func append(_ facts: ArchiveAuthenticatedLaneFacts) {
      append(facts.initialSamplePosition)
      append(facts.authenticatedSampleEnd)
      append(UInt64(facts.recordCount))
    }
  }

  private struct Reader {
    let data: Data
    var offset = 0
    var isAtEnd: Bool { offset == data.count }

    mutating func integer<T: FixedWidthInteger>() throws -> T {
      guard data.count - offset >= MemoryLayout<T>.size else {
        throw ArchiveRolloverPreparationCodecError.invalidLength
      }
      var result: T = 0
      for index in 0..<MemoryLayout<T>.size {
        result |= T(data[offset + index]) << T(index * 8)
      }
      offset += MemoryLayout<T>.size
      return result
    }

    mutating func read(count: Int) throws -> Data {
      guard count >= 0, data.count - offset >= count else {
        throw ArchiveRolloverPreparationCodecError.invalidLength
      }
      defer { offset += count }
      return data.subdata(in: offset..<(offset + count))
    }

    mutating func lengthPrefixedData() throws -> Data {
      let count: UInt32 = try integer()
      guard let count = Int(exactly: count) else {
        throw ArchiveRolloverPreparationCodecError.integerOverflow
      }
      return try read(count: count)
    }

    mutating func string() throws -> String {
      let bytes = try lengthPrefixedData()
      guard let value = String(data: bytes, encoding: .utf8), Data(value.utf8) == bytes else {
        throw ArchiveRolloverPreparationCodecError.invalidUTF8
      }
      return value
    }

    mutating func context() throws -> ArchiveContext {
      try ArchiveContext(
        streamUUID: lengthPrefixedData(),
        roomID: string(),
        istDate: string(),
        laneID: string(),
        stableDeviceUID: string())
    }

    mutating func laneIdentity() throws -> ArchiveDailyLaneIdentity {
      try ArchiveDailyLaneIdentity(
        context: context(),
        expectedInitialSessionSample: integer(),
        keywrapDigestHex: string())
    }

    mutating func facts(context: ArchiveContext) throws -> ArchiveAuthenticatedLaneFacts {
      let initial: UInt64 = try integer()
      let end: UInt64 = try integer()
      let count: UInt64 = try integer()
      guard let recordCount = Int(exactly: count) else {
        throw ArchiveRolloverPreparationCodecError.integerOverflow
      }
      return try ArchiveAuthenticatedLaneFacts(
        context: context,
        initialSamplePosition: initial,
        authenticatedSampleEnd: end,
        recordCount: recordCount)
    }
  }
}
