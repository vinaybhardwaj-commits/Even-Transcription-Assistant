import Foundation

public enum ArchiveRolloverPlanCodecError: Error, Equatable, Sendable {
  case payloadTooLarge(Int)
  case invalidMagic
  case unsupportedVersion(UInt16)
  case invalidBoolean(UInt8)
  case invalidUTF8
  case invalidLength
  case integerOverflow
  case commandIDMismatch
  case noncanonical
}

public enum ArchiveRolloverPlanCodec {
  private static let magic = Data("ETARPL01".utf8)
  private static let version: UInt16 = 2
  public static let maximumEncodedByteCount = 1_048_576

  public static func encode(_ plan: ArchiveRolloverPlan) throws -> Data {
    var writer = Writer()
    writer.data.append(magic)
    writer.append(version)
    try writer.append(plan.commandID)
    try writer.append(plan.sessionID)
    writer.append(plan.sessionSampleStart)
    try writer.append(plan.preparationID)
    try writer.append(plan.primary)
    if let backup = plan.backup {
      writer.data.append(1)
      try writer.append(backup)
    } else {
      writer.data.append(0)
    }
    try writer.append(plan.oldControl)
    try writer.append(plan.newControl)
    guard writer.data.count <= maximumEncodedByteCount else {
      throw ArchiveRolloverPlanCodecError.payloadTooLarge(writer.data.count)
    }
    return writer.data
  }

  public static func decode(_ data: Data) throws -> ArchiveRolloverPlan {
    guard data.count <= maximumEncodedByteCount else {
      throw ArchiveRolloverPlanCodecError.payloadTooLarge(data.count)
    }
    var reader = Reader(data: data)
    guard try reader.read(count: magic.count) == magic else {
      throw ArchiveRolloverPlanCodecError.invalidMagic
    }
    let version: UInt16 = try reader.integer()
    guard version == self.version else {
      throw ArchiveRolloverPlanCodecError.unsupportedVersion(version)
    }
    let commandID = try reader.string()
    let sessionID = try reader.string()
    let sessionSampleStart: UInt64 = try reader.integer()
    let preparationID = try reader.string()
    let primary = try reader.audioLane()
    let backupFlag = try reader.byte()
    let backup: ArchiveRolloverAudioLane?
    switch backupFlag {
    case 0: backup = nil
    case 1: backup = try reader.audioLane()
    default: throw ArchiveRolloverPlanCodecError.invalidBoolean(backupFlag)
    }
    let oldControl = try reader.controlIdentity()
    let newControl = try reader.controlIdentity()
    guard reader.isAtEnd else { throw ArchiveRolloverPlanCodecError.invalidLength }
    let plan = try ArchiveRolloverPlan(
      sessionID: sessionID,
      sessionSampleStart: sessionSampleStart,
      preparationID: preparationID,
      primary: primary,
      backup: backup,
      oldControl: oldControl,
      newControl: newControl)
    guard plan.commandID == commandID else {
      throw ArchiveRolloverPlanCodecError.commandIDMismatch
    }
    guard try encode(plan) == data else {
      throw ArchiveRolloverPlanCodecError.noncanonical
    }
    return plan
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
        throw ArchiveRolloverPlanCodecError.invalidLength
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

    mutating func append(_ identity: ArchiveDailyControlIdentity) throws {
      try append(identity.context)
      try append(identity.keywrapDigestHex)
    }

    mutating func append(_ facts: ArchiveAuthenticatedLaneFacts) {
      append(facts.initialSamplePosition)
      append(facts.authenticatedSampleEnd)
      append(UInt64(facts.recordCount))
    }

    mutating func append(_ lane: ArchiveRolloverAudioLane) throws {
      try append(lane.oldDay)
      try append(lane.newDay)
      append(lane.boundarySample)
      append(lane.nextChunkIndex)
      append(lane.oldAuthenticatedFacts)
      append(lane.newAuthenticatedFacts)
    }
  }

  private struct Reader {
    let data: Data
    var offset = 0
    var isAtEnd: Bool { offset == data.count }

    mutating func byte() throws -> UInt8 {
      guard offset < data.count else { throw ArchiveRolloverPlanCodecError.invalidLength }
      defer { offset += 1 }
      return data[offset]
    }

    mutating func integer<T: FixedWidthInteger>() throws -> T {
      guard data.count - offset >= MemoryLayout<T>.size else {
        throw ArchiveRolloverPlanCodecError.invalidLength
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
        throw ArchiveRolloverPlanCodecError.invalidLength
      }
      defer { offset += count }
      return data.subdata(in: offset..<(offset + count))
    }

    mutating func lengthPrefixedData() throws -> Data {
      let count: UInt32 = try integer()
      guard let count = Int(exactly: count) else {
        throw ArchiveRolloverPlanCodecError.integerOverflow
      }
      return try read(count: count)
    }

    mutating func string() throws -> String {
      let bytes = try lengthPrefixedData()
      guard let value = String(data: bytes, encoding: .utf8), Data(value.utf8) == bytes else {
        throw ArchiveRolloverPlanCodecError.invalidUTF8
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

    mutating func controlIdentity() throws -> ArchiveDailyControlIdentity {
      try ArchiveDailyControlIdentity(context: context(), keywrapDigestHex: string())
    }

    mutating func facts(context: ArchiveContext) throws -> ArchiveAuthenticatedLaneFacts {
      let initial: UInt64 = try integer()
      let end: UInt64 = try integer()
      let count: UInt64 = try integer()
      guard let recordCount = Int(exactly: count) else {
        throw ArchiveRolloverPlanCodecError.integerOverflow
      }
      return try ArchiveAuthenticatedLaneFacts(
        context: context,
        initialSamplePosition: initial,
        authenticatedSampleEnd: end,
        recordCount: recordCount)
    }

    mutating func audioLane() throws -> ArchiveRolloverAudioLane {
      let oldDay = try laneIdentity()
      let newDay = try laneIdentity()
      let boundary: UInt64 = try integer()
      let nextChunkIndex: UInt32 = try integer()
      let oldFacts = try facts(context: oldDay.context)
      let newFacts = try facts(context: newDay.context)
      return try ArchiveRolloverAudioLane(
        oldDay: oldDay,
        newDay: newDay,
        nextChunkIndex: UInt64(nextChunkIndex),
        boundarySample: boundary,
        oldAuthenticatedFacts: oldFacts,
        newAuthenticatedFacts: newFacts)
    }
  }
}
