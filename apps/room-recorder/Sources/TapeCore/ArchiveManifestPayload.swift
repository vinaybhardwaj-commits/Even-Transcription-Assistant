import Foundation

public enum ArchiveManifestMIME: String, CaseIterable, Equatable, Sendable {
  case audioWebM = "audio/webm"
}

public enum ArchiveManifestPayloadError: Error, Equatable, Sendable {
  case invalidID(String)
  case invalidReservationID
  case invalidSampleRange(start: UInt64, end: UInt64)
  case incompleteTiming
  case missingUncertainty
  case incompleteLevels
  case invalidLevels(average: UInt16, peak: UInt16)
  case invalidEncodedByteCount(UInt64)
  case invalidEncodedSHA256
  case unknownMIME(String)
  case unknownUncertainty(String)
  case integerOverflow(field: String)
  case invalidSyntax(offset: Int)
  case invalidEnvelope
  case duplicateReservationID(String)
  case duplicateAttemptID(String)
  case payloadTooLarge(Int)
}

public struct ArchiveManifestPayload: Equatable, Sendable {
  public let reservationID: String
  public let attemptID: String
  public let sampleStart: UInt64
  public let sampleEnd: UInt64
  public let startMS: UInt64?
  public let endMS: UInt64?
  public let uncertainty: ArchiveTimestampUncertainty?
  public let fitSegment: UInt64
  public let averageLevelQ15: UInt16?
  public let peakLevelQ15: UInt16?
  public let mime: ArchiveManifestMIME
  public let encodedBytes: UInt64
  public let encodedSHA256: String
  public let encoderProvenanceID: String

  public init(
    reservationID: String,
    attemptID: String,
    sampleStart: UInt64,
    sampleEnd: UInt64,
    startMS: UInt64?,
    endMS: UInt64?,
    uncertainty: ArchiveTimestampUncertainty?,
    fitSegment: UInt64,
    averageLevelQ15: UInt16?,
    peakLevelQ15: UInt16?,
    mime: ArchiveManifestMIME,
    encodedBytes: UInt64,
    encodedSHA256: String,
    encoderProvenanceID: String
  ) throws {
    guard Self.validID(reservationID) else {
      throw ArchiveManifestPayloadError.invalidID("reservation_id")
    }
    guard Self.validLowercaseSHA256(reservationID) else {
      throw ArchiveManifestPayloadError.invalidReservationID
    }
    for (field, value) in [
      ("attempt_id", attemptID), ("encoder_provenance_id", encoderProvenanceID),
    ] where !Self.validID(value) {
      throw ArchiveManifestPayloadError.invalidID(field)
    }
    guard sampleEnd > sampleStart else {
      throw ArchiveManifestPayloadError.invalidSampleRange(start: sampleStart, end: sampleEnd)
    }
    guard (startMS == nil) == (endMS == nil) else {
      throw ArchiveManifestPayloadError.incompleteTiming
    }
    if startMS == nil, uncertainty == nil {
      throw ArchiveManifestPayloadError.missingUncertainty
    }
    guard (averageLevelQ15 == nil) == (peakLevelQ15 == nil) else {
      throw ArchiveManifestPayloadError.incompleteLevels
    }
    if let averageLevelQ15, let peakLevelQ15,
      averageLevelQ15 > 32_767 || peakLevelQ15 > 32_767 || averageLevelQ15 > peakLevelQ15
    {
      throw ArchiveManifestPayloadError.invalidLevels(
        average: averageLevelQ15, peak: peakLevelQ15)
    }
    guard encodedBytes > 0 else {
      throw ArchiveManifestPayloadError.invalidEncodedByteCount(encodedBytes)
    }
    guard Self.validLowercaseSHA256(encodedSHA256) else {
      throw ArchiveManifestPayloadError.invalidEncodedSHA256
    }

    self.reservationID = reservationID
    self.attemptID = attemptID
    self.sampleStart = sampleStart
    self.sampleEnd = sampleEnd
    self.startMS = startMS
    self.endMS = endMS
    self.uncertainty = uncertainty
    self.fitSegment = fitSegment
    self.averageLevelQ15 = averageLevelQ15
    self.peakLevelQ15 = peakLevelQ15
    self.mime = mime
    self.encodedBytes = encodedBytes
    self.encodedSHA256 = encodedSHA256
    self.encoderProvenanceID = encoderProvenanceID
    try ArchiveManifestPayloadCodec.validateEncodedSize(self)
  }

  private static func validID(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 256
  }

  private static func validLowercaseSHA256(_ value: String) -> Bool {
    value.utf8.count == 64
      && value.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
  }
}

public enum ArchiveManifestReplay {
  // Cross-file reservation and spool correspondence remains an encoder-integration invariant.
  public static func validate(_ payloads: [ArchiveManifestPayload]) throws
    -> [String: ArchiveManifestPayload]
  {
    var manifests: [String: ArchiveManifestPayload] = [:]
    var attemptIDs: Set<String> = []
    for payload in payloads {
      guard manifests[payload.reservationID] == nil else {
        throw ArchiveManifestPayloadError.duplicateReservationID(payload.reservationID)
      }
      guard attemptIDs.insert(payload.attemptID).inserted else {
        throw ArchiveManifestPayloadError.duplicateAttemptID(payload.attemptID)
      }
      manifests[payload.reservationID] = payload
    }
    return manifests
  }
}

public enum ArchiveManifestPayloadCodec {
  public static func encode(_ payload: ArchiveManifestPayload) throws -> Data {
    var result = Data()
    result.append(contentsOf: "{\"attempt_id\":".utf8)
    ArchiveCanonicalJSON.appendString(payload.attemptID, to: &result)
    result.append(contentsOf: ",\"avg_level_q15\":".utf8)
    ArchiveCanonicalJSON.appendOptionalInteger(
      payload.averageLevelQ15.map(UInt64.init), to: &result)
    result.append(contentsOf: ",\"encoded_bytes\":".utf8)
    ArchiveCanonicalJSON.appendInteger(payload.encodedBytes, to: &result)
    result.append(contentsOf: ",\"encoded_sha256\":".utf8)
    ArchiveCanonicalJSON.appendString(payload.encodedSHA256, to: &result)
    result.append(contentsOf: ",\"encoder_provenance_id\":".utf8)
    ArchiveCanonicalJSON.appendString(payload.encoderProvenanceID, to: &result)
    result.append(contentsOf: ",\"end_ms\":".utf8)
    ArchiveCanonicalJSON.appendOptionalInteger(payload.endMS, to: &result)
    result.append(contentsOf: ",\"fit_segment\":".utf8)
    ArchiveCanonicalJSON.appendInteger(payload.fitSegment, to: &result)
    result.append(contentsOf: ",\"mime\":".utf8)
    ArchiveCanonicalJSON.appendString(payload.mime.rawValue, to: &result)
    result.append(contentsOf: ",\"peak_level_q15\":".utf8)
    ArchiveCanonicalJSON.appendOptionalInteger(payload.peakLevelQ15.map(UInt64.init), to: &result)
    result.append(contentsOf: ",\"reservation_id\":".utf8)
    ArchiveCanonicalJSON.appendString(payload.reservationID, to: &result)
    result.append(contentsOf: ",\"sample_end\":".utf8)
    ArchiveCanonicalJSON.appendInteger(payload.sampleEnd, to: &result)
    result.append(contentsOf: ",\"sample_start\":".utf8)
    ArchiveCanonicalJSON.appendInteger(payload.sampleStart, to: &result)
    result.append(contentsOf: ",\"start_ms\":".utf8)
    ArchiveCanonicalJSON.appendOptionalInteger(payload.startMS, to: &result)
    result.append(contentsOf: ",\"uncertainty\":".utf8)
    ArchiveCanonicalJSON.appendOptionalString(payload.uncertainty?.rawValue, to: &result)
    result.append(0x7D)
    guard result.count <= Int(ArchiveRecordPurpose.manifest.maximumPlaintextByteCount) else {
      throw ArchiveManifestPayloadError.payloadTooLarge(result.count)
    }
    return result
  }

  public static func decode(_ data: Data) throws -> ArchiveManifestPayload {
    guard data.count <= Int(ArchiveRecordPurpose.manifest.maximumPlaintextByteCount) else {
      throw ArchiveManifestPayloadError.payloadTooLarge(data.count)
    }
    var parser = ArchiveCanonicalJSONParser(data)
    do {
      try parser.expect("{\"attempt_id\":")
      let attemptID = try parser.string()
      try parser.expect(",\"avg_level_q15\":")
      let average = try parser.optionalInteger(field: "avg_level_q15")
      try parser.expect(",\"encoded_bytes\":")
      let encodedBytes = try parser.integer(field: "encoded_bytes")
      try parser.expect(",\"encoded_sha256\":")
      let encodedSHA256 = try parser.string()
      try parser.expect(",\"encoder_provenance_id\":")
      let encoderProvenanceID = try parser.string()
      try parser.expect(",\"end_ms\":")
      let endMS = try parser.optionalInteger(field: "end_ms")
      try parser.expect(",\"fit_segment\":")
      let fitSegment = try parser.integer(field: "fit_segment")
      try parser.expect(",\"mime\":")
      let mimeRaw = try parser.string()
      guard let mime = ArchiveManifestMIME(rawValue: mimeRaw) else {
        throw ArchiveManifestPayloadError.unknownMIME(mimeRaw)
      }
      try parser.expect(",\"peak_level_q15\":")
      let peak = try parser.optionalInteger(field: "peak_level_q15")
      try parser.expect(",\"reservation_id\":")
      let reservationID = try parser.string()
      try parser.expect(",\"sample_end\":")
      let sampleEnd = try parser.integer(field: "sample_end")
      try parser.expect(",\"sample_start\":")
      let sampleStart = try parser.integer(field: "sample_start")
      try parser.expect(",\"start_ms\":")
      let startMS = try parser.optionalInteger(field: "start_ms")
      try parser.expect(",\"uncertainty\":")
      let uncertaintyRaw = try parser.optionalString()
      let uncertainty: ArchiveTimestampUncertainty?
      if let uncertaintyRaw {
        guard let value = ArchiveTimestampUncertainty(rawValue: uncertaintyRaw) else {
          throw ArchiveManifestPayloadError.unknownUncertainty(uncertaintyRaw)
        }
        uncertainty = value
      } else {
        uncertainty = nil
      }
      try parser.expect("}")
      try parser.expectEnd()
      for (field, value) in [("avg_level_q15", average), ("peak_level_q15", peak)] {
        guard value == nil || value! <= UInt64(UInt16.max) else {
          throw ArchiveManifestPayloadError.integerOverflow(field: field)
        }
      }
      let payload = try ArchiveManifestPayload(
        reservationID: reservationID,
        attemptID: attemptID,
        sampleStart: sampleStart,
        sampleEnd: sampleEnd,
        startMS: startMS,
        endMS: endMS,
        uncertainty: uncertainty,
        fitSegment: fitSegment,
        averageLevelQ15: average.map(UInt16.init),
        peakLevelQ15: peak.map(UInt16.init),
        mime: mime,
        encodedBytes: encodedBytes,
        encodedSHA256: encodedSHA256,
        encoderProvenanceID: encoderProvenanceID
      )
      guard try encode(payload) == data else {
        throw ArchiveManifestPayloadError.invalidSyntax(offset: 0)
      }
      return payload
    } catch ArchiveCanonicalJSONError.invalidSyntax(let offset) {
      throw ArchiveManifestPayloadError.invalidSyntax(offset: offset)
    } catch ArchiveCanonicalJSONError.integerOverflow(let field) {
      throw ArchiveManifestPayloadError.integerOverflow(field: field)
    }
  }

  public static func validateRecord(_ record: ArchiveDerivedRecord) throws {
    guard record.header.purpose == .manifest, record.header.logicalUnitCount == 1,
      UInt64(record.header.plaintextByteCount) == UInt64(record.plaintext.count),
      record.header.recordSequence > 0,
      record.header.firstLogicalUnit == record.header.recordSequence - 1
    else {
      throw ArchiveManifestPayloadError.invalidEnvelope
    }
    _ = try decode(record.plaintext)
  }

  fileprivate static func validateEncodedSize(_ payload: ArchiveManifestPayload) throws {
    _ = try encode(payload)
  }
}
