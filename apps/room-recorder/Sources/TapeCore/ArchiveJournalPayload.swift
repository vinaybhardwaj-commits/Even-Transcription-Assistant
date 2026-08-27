import Foundation

public enum ArchiveJournalState: String, CaseIterable, Equatable, Hashable, Sendable {
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
  case invalidTransition(prior: ArchiveJournalState?, new: ArchiveJournalState)
  case missingAttemptID(ArchiveJournalState)
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
    // The local-derivation handoff freezes reservation identity as lowercase SHA-256.
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
    if let error, error.isEmpty || error.utf8.count > 256 {
      throw ArchiveJournalPayloadError.invalidError
    }
    if priorState == nil, newState == .reserved {
      guard attemptID == nil, error == nil else {
        throw ArchiveJournalPayloadError.invalidInitialReservation
      }
    } else if error != nil {
      guard priorState == newState else {
        throw ArchiveJournalPayloadError.invalidTransition(prior: priorState, new: newState)
      }
    } else {
      let isPreManifestReencode = priorState == .encoded && newState == .encoded
      guard isPreManifestReencode || priorState == Self.successPredecessor(of: newState) else {
        throw ArchiveJournalPayloadError.invalidTransition(prior: priorState, new: newState)
      }
      if newState != .reserved, attemptID == nil {
        throw ArchiveJournalPayloadError.missingAttemptID(newState)
      }
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

  private static func successPredecessor(of state: ArchiveJournalState) -> ArchiveJournalState? {
    switch state {
    case .reserved: nil
    case .encoded: .reserved
    case .spoolDurable: .encoded
    case .putComplete: .spoolDurable
    case .headVerified: .putComplete
    case .rowRegistered: .headVerified
    case .done: .rowRegistered
    }
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

public enum ArchiveJournalReplayError: Error, Equatable, Sendable {
  case missingInitialReservation(String)
  case immutableReservationFactsChanged(String)
  case stateMismatch(
    reservationID: String,
    expected: ArchiveJournalState,
    actual: ArchiveJournalState?
  )
  case attemptRequired(reservationID: String, state: ArchiveJournalState)
  case sameAttemptReencode(String)
  case attemptSubstitution(reservationID: String)
}

public struct ArchiveJournalReplayReservation: Equatable, Sendable {
  public let initialReservation: ArchiveJournalPayload
  public let state: ArchiveJournalState
  public let attemptID: String?
}

public enum ArchiveJournalReplay {
  public static func validate(_ payloads: [ArchiveJournalPayload]) throws
    -> [String: ArchiveJournalReplayReservation]
  {
    var reservations: [String: ArchiveJournalReplayReservation] = [:]
    for payload in payloads {
      guard let previous = reservations[payload.reservationID] else {
        guard payload.priorState == nil, payload.newState == .reserved, payload.error == nil,
          payload.attemptID == nil
        else {
          throw ArchiveJournalReplayError.missingInitialReservation(payload.reservationID)
        }
        reservations[payload.reservationID] = ArchiveJournalReplayReservation(
          initialReservation: payload,
          state: .reserved,
          attemptID: nil
        )
        continue
      }
      guard immutableFacts(of: payload) == immutableFacts(of: previous.initialReservation) else {
        throw ArchiveJournalReplayError.immutableReservationFactsChanged(payload.reservationID)
      }
      guard payload.priorState == previous.state else {
        throw ArchiveJournalReplayError.stateMismatch(
          reservationID: payload.reservationID,
          expected: previous.state,
          actual: payload.priorState
        )
      }

      if payload.error != nil {
        if previous.state == .reserved {
          reservations[payload.reservationID] = ArchiveJournalReplayReservation(
            initialReservation: previous.initialReservation,
            state: previous.state,
            attemptID: nil
          )
        } else {
          guard let attemptID = payload.attemptID else {
            throw ArchiveJournalReplayError.attemptRequired(
              reservationID: payload.reservationID,
              state: payload.newState
            )
          }
          guard attemptID == previous.attemptID else {
            throw ArchiveJournalReplayError.attemptSubstitution(
              reservationID: payload.reservationID)
          }
        }
        continue
      }

      guard let attemptID = payload.attemptID else {
        throw ArchiveJournalReplayError.attemptRequired(
          reservationID: payload.reservationID,
          state: payload.newState
        )
      }
      if previous.state == .encoded, payload.newState == .encoded {
        guard attemptID != previous.attemptID else {
          throw ArchiveJournalReplayError.sameAttemptReencode(payload.reservationID)
        }
        reservations[payload.reservationID] = ArchiveJournalReplayReservation(
          initialReservation: previous.initialReservation,
          state: .encoded,
          attemptID: attemptID
        )
        continue
      }
      if let boundAttemptID = previous.attemptID, attemptID != boundAttemptID {
        throw ArchiveJournalReplayError.attemptSubstitution(reservationID: payload.reservationID)
      }
      reservations[payload.reservationID] = ArchiveJournalReplayReservation(
        initialReservation: previous.initialReservation,
        state: payload.newState,
        attemptID: attemptID
      )
    }
    return reservations
  }

  private struct ImmutableFacts: Equatable {
    let roomID: String
    let sessionID: String
    let laneID: String
    let istDate: String
    let chunkIndex: UInt32
    let sampleStart: UInt64
    let sampleEnd: UInt64
    let startMS: UInt64?
    let endMS: UInt64?
    let uncertainty: ArchiveTimestampUncertainty?
    let averageLevelQ15: UInt16?
    let peakLevelQ15: UInt16?
  }

  private static func immutableFacts(of payload: ArchiveJournalPayload) -> ImmutableFacts {
    ImmutableFacts(
      roomID: payload.roomID,
      sessionID: payload.sessionID,
      laneID: payload.laneID,
      istDate: payload.istDate,
      chunkIndex: payload.chunkIndex,
      sampleStart: payload.sampleStart,
      sampleEnd: payload.sampleEnd,
      startMS: payload.startMS,
      endMS: payload.endMS,
      uncertainty: payload.uncertainty,
      averageLevelQ15: payload.averageLevelQ15,
      peakLevelQ15: payload.peakLevelQ15
    )
  }
}

public enum ArchiveJournalPayloadCodec {
  public static func encode(_ payload: ArchiveJournalPayload) throws -> Data {
    var result = Data()
    result.append(contentsOf: "{\"attempt_id\":".utf8)
    ArchiveCanonicalJSON.appendOptionalString(payload.attemptID, to: &result)
    result.append(contentsOf: ",\"avg_level_q15\":".utf8)
    ArchiveCanonicalJSON.appendOptionalInteger(
      payload.averageLevelQ15.map(UInt64.init), to: &result)
    result.append(contentsOf: ",\"chunk_idx\":".utf8)
    ArchiveCanonicalJSON.appendInteger(UInt64(payload.chunkIndex), to: &result)
    result.append(contentsOf: ",\"end_ms\":".utf8)
    ArchiveCanonicalJSON.appendOptionalInteger(payload.endMS, to: &result)
    result.append(contentsOf: ",\"error\":".utf8)
    ArchiveCanonicalJSON.appendOptionalString(payload.error, to: &result)
    result.append(contentsOf: ",\"ist_date\":".utf8)
    ArchiveCanonicalJSON.appendString(payload.istDate, to: &result)
    result.append(contentsOf: ",\"lane_id\":".utf8)
    ArchiveCanonicalJSON.appendString(payload.laneID, to: &result)
    result.append(contentsOf: ",\"new_state\":".utf8)
    ArchiveCanonicalJSON.appendString(payload.newState.rawValue, to: &result)
    result.append(contentsOf: ",\"peak_level_q15\":".utf8)
    ArchiveCanonicalJSON.appendOptionalInteger(payload.peakLevelQ15.map(UInt64.init), to: &result)
    result.append(contentsOf: ",\"prior_state\":".utf8)
    ArchiveCanonicalJSON.appendOptionalString(payload.priorState?.rawValue, to: &result)
    result.append(contentsOf: ",\"reservation_id\":".utf8)
    ArchiveCanonicalJSON.appendString(payload.reservationID, to: &result)
    result.append(contentsOf: ",\"room_id\":".utf8)
    ArchiveCanonicalJSON.appendString(payload.roomID, to: &result)
    result.append(contentsOf: ",\"sample_end\":".utf8)
    ArchiveCanonicalJSON.appendInteger(payload.sampleEnd, to: &result)
    result.append(contentsOf: ",\"sample_start\":".utf8)
    ArchiveCanonicalJSON.appendInteger(payload.sampleStart, to: &result)
    result.append(contentsOf: ",\"session_id\":".utf8)
    ArchiveCanonicalJSON.appendString(payload.sessionID, to: &result)
    result.append(contentsOf: ",\"start_ms\":".utf8)
    ArchiveCanonicalJSON.appendOptionalInteger(payload.startMS, to: &result)
    result.append(contentsOf: ",\"uncertainty\":".utf8)
    ArchiveCanonicalJSON.appendOptionalString(payload.uncertainty?.rawValue, to: &result)
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
    var parser = ArchiveCanonicalJSONParser(data)
    do {
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
    } catch ArchiveCanonicalJSONError.invalidSyntax(let offset) {
      throw ArchiveJournalPayloadError.invalidSyntax(offset: offset)
    } catch ArchiveCanonicalJSONError.integerOverflow(let field) {
      throw ArchiveJournalPayloadError.integerOverflow(field: field)
    }
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

}
