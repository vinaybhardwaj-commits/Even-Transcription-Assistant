import Foundation

public enum ArchiveJournalState: String, CaseIterable, Equatable, Sendable {
  case reserved
  case encoded
  case spoolDurable = "spool_durable"
  case putComplete = "put_complete"
  case headVerified = "head_verified"
  case rowRegistered = "row_registered"
  case done
}

public enum ArchiveTimestampUncertainty: String, CaseIterable, Equatable, Sendable {
  case fewerThanThreeAnchors = "fewer_than_three_anchors"
  case anchorsSpanLessThanTenSeconds = "anchors_span_less_than_ten_seconds"
  case boundaryBeyondNewestAnchor = "boundary_beyond_newest_anchor"
  case fittedRateNonFinite = "fitted_rate_non_finite"
  case fittedRateOutOfBounds = "fitted_rate_out_of_bounds"
  case discontinuityIntersectsFit = "discontinuity_intersects_fit"
}

public enum ArchiveJournalPayloadError: Error, Equatable, Sendable {
  case invalidID(String)
  case invalidReservationID
  case invalidISTDate(String)
  case invalidSampleRange(start: UInt64, end: UInt64)
  case incompleteTiming
  case missingUncertainty
  case incompleteLevels
  case missingReservedLevels
  case invalidLevels(average: UInt16, peak: UInt16)
  case invalidInitialReservation
  case invalidError
  case invalidEnvelopeRange
  case unknownState(String)
  case unknownUncertainty(String)
  case integerOverflow(field: String)
  case invalidSyntax(offset: Int)
  case payloadTooLarge(Int)
}

public struct ArchiveJournalPayload: Equatable, Sendable {
  public let reservationID: String
  public let roomID: String
  public let sessionID: String
  public let laneID: String
  public let istDate: String
  public let chunkIndex: UInt32
  public let sampleStart: UInt64
  public let sampleEnd: UInt64
  public let startMS: UInt64?
  public let endMS: UInt64?
  public let uncertainty: ArchiveTimestampUncertainty?
  public let averageLevelQ15: UInt16?
  public let peakLevelQ15: UInt16?
  public let attemptID: String?
  public let priorState: ArchiveJournalState?
  public let newState: ArchiveJournalState
  public let error: String?

  public init(
    reservationID: String,
    roomID: String,
    sessionID: String,
    laneID: String,
    istDate: String,
    chunkIndex: UInt32,
    sampleStart: UInt64,
    sampleEnd: UInt64,
    startMS: UInt64?,
    endMS: UInt64?,
    uncertainty: ArchiveTimestampUncertainty?,
    averageLevelQ15: UInt16?,
    peakLevelQ15: UInt16?,
    attemptID: String?,
    priorState: ArchiveJournalState?,
    newState: ArchiveJournalState,
    error: String?
  ) throws {
    guard Self.validID(reservationID) else {
      throw ArchiveJournalPayloadError.invalidID("reservation_id")
    }
    guard reservationID.utf8.count == 64,
      reservationID.utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x66).contains($0) })
    else {
      throw ArchiveJournalPayloadError.invalidReservationID
    }
    for (name, value) in [
      ("room_id", roomID), ("session_id", sessionID), ("lane_id", laneID),
    ] where !Self.validID(value) {
      throw ArchiveJournalPayloadError.invalidID(name)
    }
    if let attemptID, !Self.validID(attemptID) {
      throw ArchiveJournalPayloadError.invalidID("attempt_id")
    }
    guard Self.validISTDate(istDate) else {
      throw ArchiveJournalPayloadError.invalidISTDate(istDate)
    }
    guard sampleEnd > sampleStart else {
      throw ArchiveJournalPayloadError.invalidSampleRange(start: sampleStart, end: sampleEnd)
    }
    guard (startMS == nil) == (endMS == nil) else {
      throw ArchiveJournalPayloadError.incompleteTiming
    }
    if startMS == nil, uncertainty == nil {
      throw ArchiveJournalPayloadError.missingUncertainty
    }
    guard (averageLevelQ15 == nil) == (peakLevelQ15 == nil) else {
      throw ArchiveJournalPayloadError.incompleteLevels
    }
    if let averageLevelQ15, let peakLevelQ15,
      averageLevelQ15 > 32_767 || peakLevelQ15 > 32_767 || averageLevelQ15 > peakLevelQ15
    {
      throw ArchiveJournalPayloadError.invalidLevels(
        average: averageLevelQ15, peak: peakLevelQ15)
    }
    if newState == .reserved, averageLevelQ15 == nil {
      throw ArchiveJournalPayloadError.missingReservedLevels
    }
    if newState == .reserved,
      priorState != nil || attemptID != nil || error != nil
    {
      throw ArchiveJournalPayloadError.invalidInitialReservation
    }
    if let error, error.isEmpty || error.utf8.count > 256 {
      throw ArchiveJournalPayloadError.invalidError
    }

    self.reservationID = reservationID
    self.roomID = roomID
    self.sessionID = sessionID
    self.laneID = laneID
    self.istDate = istDate
    self.chunkIndex = chunkIndex
    self.sampleStart = sampleStart
    self.sampleEnd = sampleEnd
    self.startMS = startMS
    self.endMS = endMS
    self.uncertainty = uncertainty
    self.averageLevelQ15 = averageLevelQ15
    self.peakLevelQ15 = peakLevelQ15
    self.attemptID = attemptID
    self.priorState = priorState
    self.newState = newState
    self.error = error
    try ArchiveJournalPayloadCodec.validateEncodedSize(self)
  }

  private static func validID(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 256
  }

  private static func validISTDate(_ value: String) -> Bool {
    let context = ArchiveContext(
      streamUUID: Data(repeating: 0, count: 16),
      roomID: "validation",
      istDate: value,
      laneID: "primary",
      stableDeviceUID: "validation"
    )
    return (try? context.encodedBytes()) != nil
  }
}

public enum ArchiveJournalPayloadCodec {
  public static func encode(_ payload: ArchiveJournalPayload) throws -> Data {
    var result = Data()
    result.append(contentsOf: "{\"attempt_id\":".utf8)
    appendOptionalString(payload.attemptID, to: &result)
    result.append(contentsOf: ",\"avg_level_q15\":".utf8)
    appendOptionalInteger(payload.averageLevelQ15.map(UInt64.init), to: &result)
    result.append(contentsOf: ",\"chunk_idx\":".utf8)
    appendInteger(UInt64(payload.chunkIndex), to: &result)
    result.append(contentsOf: ",\"end_ms\":".utf8)
    appendOptionalInteger(payload.endMS, to: &result)
    result.append(contentsOf: ",\"error\":".utf8)
    appendOptionalString(payload.error, to: &result)
    result.append(contentsOf: ",\"ist_date\":".utf8)
    appendString(payload.istDate, to: &result)
    result.append(contentsOf: ",\"lane_id\":".utf8)
    appendString(payload.laneID, to: &result)
    result.append(contentsOf: ",\"new_state\":".utf8)
    appendString(payload.newState.rawValue, to: &result)
    result.append(contentsOf: ",\"peak_level_q15\":".utf8)
    appendOptionalInteger(payload.peakLevelQ15.map(UInt64.init), to: &result)
    result.append(contentsOf: ",\"prior_state\":".utf8)
    appendOptionalString(payload.priorState?.rawValue, to: &result)
    result.append(contentsOf: ",\"reservation_id\":".utf8)
    appendString(payload.reservationID, to: &result)
    result.append(contentsOf: ",\"room_id\":".utf8)
    appendString(payload.roomID, to: &result)
    result.append(contentsOf: ",\"sample_end\":".utf8)
    appendInteger(payload.sampleEnd, to: &result)
    result.append(contentsOf: ",\"sample_start\":".utf8)
    appendInteger(payload.sampleStart, to: &result)
    result.append(contentsOf: ",\"session_id\":".utf8)
    appendString(payload.sessionID, to: &result)
    result.append(contentsOf: ",\"start_ms\":".utf8)
    appendOptionalInteger(payload.startMS, to: &result)
    result.append(contentsOf: ",\"uncertainty\":".utf8)
    appendOptionalString(payload.uncertainty?.rawValue, to: &result)
    result.append(0x7D)
    guard result.count <= Int(ArchiveRecordPurpose.journal.maximumPlaintextByteCount) else {
      throw ArchiveJournalPayloadError.payloadTooLarge(result.count)
    }
    return result
  }

  public static func decode(_ data: Data) throws -> ArchiveJournalPayload {
    guard data.count <= Int(ArchiveRecordPurpose.journal.maximumPlaintextByteCount) else {
      throw ArchiveJournalPayloadError.payloadTooLarge(data.count)
    }
    var parser = JournalJSONParser(data)
    try parser.expect("{\"attempt_id\":")
    let attemptID = try parser.optionalString()
    try parser.expect(",\"avg_level_q15\":")
    let average = try parser.optionalInteger(field: "avg_level_q15")
    try parser.expect(",\"chunk_idx\":")
    let chunk = try parser.integer(field: "chunk_idx")
    try parser.expect(",\"end_ms\":")
    let endMS = try parser.optionalInteger(field: "end_ms")
    try parser.expect(",\"error\":")
    let error = try parser.optionalString()
    try parser.expect(",\"ist_date\":")
    let istDate = try parser.string()
    try parser.expect(",\"lane_id\":")
    let laneID = try parser.string()
    try parser.expect(",\"new_state\":")
    let newStateRaw = try parser.string()
    guard let newState = ArchiveJournalState(rawValue: newStateRaw) else {
      throw ArchiveJournalPayloadError.unknownState(newStateRaw)
    }
    try parser.expect(",\"peak_level_q15\":")
    let peak = try parser.optionalInteger(field: "peak_level_q15")
    try parser.expect(",\"prior_state\":")
    let priorStateRaw = try parser.optionalString()
    let priorState: ArchiveJournalState?
    if let priorStateRaw {
      guard let value = ArchiveJournalState(rawValue: priorStateRaw) else {
        throw ArchiveJournalPayloadError.unknownState(priorStateRaw)
      }
      priorState = value
    } else {
      priorState = nil
    }
    try parser.expect(",\"reservation_id\":")
    let reservationID = try parser.string()
    try parser.expect(",\"room_id\":")
    let roomID = try parser.string()
    try parser.expect(",\"sample_end\":")
    let sampleEnd = try parser.integer(field: "sample_end")
    try parser.expect(",\"sample_start\":")
    let sampleStart = try parser.integer(field: "sample_start")
    try parser.expect(",\"session_id\":")
    let sessionID = try parser.string()
    try parser.expect(",\"start_ms\":")
    let startMS = try parser.optionalInteger(field: "start_ms")
    try parser.expect(",\"uncertainty\":")
    let uncertaintyRaw = try parser.optionalString()
    let uncertainty: ArchiveTimestampUncertainty?
    if let uncertaintyRaw {
      guard let value = ArchiveTimestampUncertainty(rawValue: uncertaintyRaw) else {
        throw ArchiveJournalPayloadError.unknownUncertainty(uncertaintyRaw)
      }
      uncertainty = value
    } else {
      uncertainty = nil
    }
    try parser.expect("}")
    try parser.expectEnd()
    guard chunk <= UInt64(UInt32.max) else {
      throw ArchiveJournalPayloadError.integerOverflow(field: "chunk_idx")
    }
    for (field, value) in [("avg_level_q15", average), ("peak_level_q15", peak)] {
      guard value == nil || value! <= UInt64(UInt16.max) else {
        throw ArchiveJournalPayloadError.integerOverflow(field: field)
      }
    }
    let payload = try ArchiveJournalPayload(
      reservationID: reservationID,
      roomID: roomID,
      sessionID: sessionID,
      laneID: laneID,
      istDate: istDate,
      chunkIndex: UInt32(chunk),
      sampleStart: sampleStart,
      sampleEnd: sampleEnd,
      startMS: startMS,
      endMS: endMS,
      uncertainty: uncertainty,
      averageLevelQ15: average.map(UInt16.init),
      peakLevelQ15: peak.map(UInt16.init),
      attemptID: attemptID,
      priorState: priorState,
      newState: newState,
      error: error
    )
    guard try encode(payload) == data else {
      throw ArchiveJournalPayloadError.invalidSyntax(offset: 0)
    }
    return payload
  }

  public static func validateRecord(_ record: ArchiveDerivedRecord) throws {
    guard record.header.logicalUnitCount == 1 else {
      throw ArchiveJournalPayloadError.invalidEnvelopeRange
    }
    _ = try decode(record.plaintext)
  }

  fileprivate static func validateEncodedSize(_ payload: ArchiveJournalPayload) throws {
    _ = try encode(payload)
  }

  private static func appendOptionalInteger(_ value: UInt64?, to result: inout Data) {
    if let value {
      appendInteger(value, to: &result)
    } else {
      result.append(contentsOf: "null".utf8)
    }
  }

  private static func appendInteger(_ value: UInt64, to result: inout Data) {
    result.append(contentsOf: String(value).utf8)
  }

  private static func appendOptionalString(_ value: String?, to result: inout Data) {
    if let value {
      appendString(value, to: &result)
    } else {
      result.append(contentsOf: "null".utf8)
    }
  }

  private static func appendString(_ value: String, to result: inout Data) {
    let hexadecimal = Array("0123456789abcdef".utf8)
    result.append(0x22)
    for scalar in value.unicodeScalars {
      switch scalar.value {
      case 0x22: result.append(contentsOf: #"\""#.utf8)
      case 0x5C: result.append(contentsOf: #"\\"#.utf8)
      case 0...0x1F:
        result.append(contentsOf: #"\u00"#.utf8)
        result.append(hexadecimal[Int(scalar.value >> 4)])
        result.append(hexadecimal[Int(scalar.value & 0x0F)])
      default: result.append(contentsOf: String(scalar).utf8)
      }
    }
    result.append(0x22)
  }
}

private struct JournalJSONParser {
  private let bytes: [UInt8]
  private(set) var offset = 0

  init(_ data: Data) {
    bytes = Array(data)
  }

  mutating func expect(_ literal: String) throws {
    let expected = Array(literal.utf8)
    guard offset <= bytes.count, expected.count <= bytes.count - offset,
      Array(bytes[offset..<(offset + expected.count)]) == expected
    else {
      throw ArchiveJournalPayloadError.invalidSyntax(offset: offset)
    }
    offset += expected.count
  }

  mutating func expectEnd() throws {
    guard offset == bytes.count else {
      throw ArchiveJournalPayloadError.invalidSyntax(offset: offset)
    }
  }

  mutating func optionalInteger(field: String) throws -> UInt64? {
    if hasPrefix("null") {
      try expect("null")
      return nil
    }
    return try integer(field: field)
  }

  mutating func integer(field: String) throws -> UInt64 {
    let start = offset
    guard offset < bytes.count, (0x30...0x39).contains(bytes[offset]) else {
      throw ArchiveJournalPayloadError.invalidSyntax(offset: offset)
    }
    if bytes[offset] == 0x30 {
      offset += 1
      if offset < bytes.count, (0x30...0x39).contains(bytes[offset]) {
        throw ArchiveJournalPayloadError.invalidSyntax(offset: offset)
      }
      return 0
    }
    var value: UInt64 = 0
    while offset < bytes.count, (0x30...0x39).contains(bytes[offset]) {
      let multiplied = value.multipliedReportingOverflow(by: 10)
      let added = multiplied.partialValue.addingReportingOverflow(UInt64(bytes[offset] - 0x30))
      guard !multiplied.overflow, !added.overflow else {
        throw ArchiveJournalPayloadError.integerOverflow(field: field)
      }
      value = added.partialValue
      offset += 1
    }
    guard offset > start else {
      throw ArchiveJournalPayloadError.invalidSyntax(offset: offset)
    }
    return value
  }

  mutating func optionalString() throws -> String? {
    if hasPrefix("null") {
      try expect("null")
      return nil
    }
    return try string()
  }

  mutating func string() throws -> String {
    guard offset < bytes.count, bytes[offset] == 0x22 else {
      throw ArchiveJournalPayloadError.invalidSyntax(offset: offset)
    }
    offset += 1
    var decoded = Data()
    while offset < bytes.count {
      let byte = bytes[offset]
      offset += 1
      if byte == 0x22 {
        guard let result = String(data: decoded, encoding: .utf8) else {
          throw ArchiveJournalPayloadError.invalidSyntax(offset: offset - 1)
        }
        return result
      }
      if byte == 0x5C {
        guard offset < bytes.count else {
          throw ArchiveJournalPayloadError.invalidSyntax(offset: offset)
        }
        let escape = bytes[offset]
        offset += 1
        if escape == 0x22 || escape == 0x5C {
          decoded.append(escape)
          continue
        }
        guard escape == 0x75, offset + 4 <= bytes.count,
          bytes[offset] == 0x30, bytes[offset + 1] == 0x30,
          let high = lowercaseHex(bytes[offset + 2]),
          let low = lowercaseHex(bytes[offset + 3]), high * 16 + low <= 0x1F
        else {
          throw ArchiveJournalPayloadError.invalidSyntax(offset: offset - 1)
        }
        decoded.append(high * 16 + low)
        offset += 4
        continue
      }
      guard byte >= 0x20 else {
        throw ArchiveJournalPayloadError.invalidSyntax(offset: offset - 1)
      }
      decoded.append(byte)
    }
    throw ArchiveJournalPayloadError.invalidSyntax(offset: offset)
  }

  private func hasPrefix(_ literal: String) -> Bool {
    let expected = Array(literal.utf8)
    guard offset <= bytes.count, expected.count <= bytes.count - offset else { return false }
    return Array(bytes[offset..<(offset + expected.count)]) == expected
  }

  private func lowercaseHex(_ byte: UInt8) -> UInt8? {
    switch byte {
    case 0x30...0x39: byte - 0x30
    case 0x61...0x66: byte - 0x61 + 10
    default: nil
    }
  }
}
