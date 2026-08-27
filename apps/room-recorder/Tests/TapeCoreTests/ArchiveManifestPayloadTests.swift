import Foundation
import Testing

@testable import TapeCore

@Suite struct ArchiveManifestPayloadTests {
  @Test func goldenBytesRoundTripExactly() throws {
    let payload = try manifest()
    let expected = Data(
      (#"{"attempt_id":"attempt_1","avg_level_q15":100,"encoded_bytes":12345,"encoded_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","encoder_provenance_id":"ffmpeg_arm64_1","end_ms":2000,"fit_segment":2,"mime":"audio/webm","peak_level_q15":300,"reservation_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sample_end":32000,"sample_start":16000,"start_ms":1000,"uncertainty":"boundary_beyond_newest_anchor"}"#)
        .utf8
    )

    let encoded = try ArchiveManifestPayloadCodec.encode(payload)
    #expect(encoded == expected)
    #expect(try ArchiveManifestPayloadCodec.decode(encoded) == payload)
  }

  @Test func malformedAndNoncanonicalPayloadsAreRejected() throws {
    let encoded = try ArchiveManifestPayloadCodec.encode(manifest())
    for malformed in [
      replacing(encoded, "\"attempt_id\"", with: "\"unknown\""),
      replacing(encoded, "\"audio/webm\"", with: "\"audio/ogg\""),
      replacing(encoded, "\"fit_segment\":2", with: "\"fit_segment\":02"),
      replacing(encoded, "\"encoded_bytes\":12345", with: "\"encoded_bytes\":1.2345e4"),
      encoded + Data([0x20]),
    ] {
      #expect(throws: ArchiveManifestPayloadError.self) {
        try ArchiveManifestPayloadCodec.decode(malformed)
      }
    }

    #expect(throws: ArchiveManifestPayloadError.invalidEncodedSHA256) {
      try manifest(encodedSHA256: String(repeating: "B", count: 64))
    }
    #expect(throws: ArchiveManifestPayloadError.incompleteLevels) {
      try manifest(average: 100, peak: nil)
    }
    #expect(throws: ArchiveManifestPayloadError.invalidLevels(average: 301, peak: 300)) {
      try manifest(average: 301, peak: 300)
    }
    #expect(throws: ArchiveManifestPayloadError.incompleteTiming) {
      try manifest(startMS: 1_000, endMS: nil)
    }
    #expect(throws: ArchiveManifestPayloadError.missingUncertainty) {
      try manifest(startMS: nil, endMS: nil, uncertainty: nil)
    }
    #expect(throws: ArchiveManifestPayloadError.invalidEncodedByteCount(0)) {
      try manifest(encodedBytes: 0)
    }
  }

  @Test func exactEnvelopeValidatorRejectsWrongPurposeRangeAndOrdinal() throws {
    let plaintext = try ArchiveManifestPayloadCodec.encode(manifest())
    let valid = record(
      purpose: .manifest,
      sequence: 1,
      firstLogicalUnit: 0,
      logicalUnitCount: 1,
      plaintext: plaintext
    )
    try ArchiveManifestPayloadCodec.validateRecord(valid)

    for invalid in [
      record(
        purpose: .journal,
        sequence: 1,
        firstLogicalUnit: 0,
        logicalUnitCount: 1,
        plaintext: plaintext
      ),
      record(
        purpose: .manifest,
        sequence: 1,
        firstLogicalUnit: 0,
        logicalUnitCount: 2,
        plaintext: plaintext
      ),
      record(
        purpose: .manifest,
        sequence: 2,
        firstLogicalUnit: 0,
        logicalUnitCount: 1,
        plaintext: plaintext
      ),
    ] {
      #expect(throws: ArchiveManifestPayloadError.invalidEnvelope) {
        try ArchiveManifestPayloadCodec.validateRecord(invalid)
      }
    }
  }

  @Test func replayRejectsDuplicateReservationAndAttemptIdentities() throws {
    let first = try manifest()
    let duplicateReservation = try manifest(attemptID: "attempt_2")
    #expect(
      throws: ArchiveManifestPayloadError.duplicateReservationID(first.reservationID)
    ) {
      try ArchiveManifestReplay.validate([first, duplicateReservation])
    }

    let duplicateAttempt = try manifest(
      reservationID: String(repeating: "c", count: 64)
    )
    #expect(throws: ArchiveManifestPayloadError.duplicateAttemptID(first.attemptID)) {
      try ArchiveManifestReplay.validate([first, duplicateAttempt])
    }
  }

  private func manifest(
    reservationID: String = String(repeating: "a", count: 64),
    attemptID: String = "attempt_1",
    startMS: UInt64? = 1_000,
    endMS: UInt64? = 2_000,
    uncertainty: ArchiveTimestampUncertainty? = .boundaryBeyondNewestAnchor,
    average: UInt16? = 100,
    peak: UInt16? = 300,
    encodedBytes: UInt64 = 12_345,
    encodedSHA256: String = String(repeating: "b", count: 64)
  ) throws -> ArchiveManifestPayload {
    try ArchiveManifestPayload(
      reservationID: reservationID,
      attemptID: attemptID,
      sampleStart: 16_000,
      sampleEnd: 32_000,
      startMS: startMS,
      endMS: endMS,
      uncertainty: uncertainty,
      fitSegment: 2,
      averageLevelQ15: average,
      peakLevelQ15: peak,
      mime: .audioWebM,
      encodedBytes: encodedBytes,
      encodedSHA256: encodedSHA256,
      encoderProvenanceID: "ffmpeg_arm64_1"
    )
  }

  private func replacing(_ data: Data, _ target: String, with replacement: String) -> Data {
    Data(
      String(decoding: data, as: UTF8.self).replacingOccurrences(of: target, with: replacement).utf8
    )
  }

  private func record(
    purpose: ArchiveRecordPurpose,
    sequence: UInt64,
    firstLogicalUnit: UInt64,
    logicalUnitCount: UInt32,
    plaintext: Data
  ) -> ArchiveDerivedRecord {
    ArchiveDerivedRecord(
      header: ArchiveEnvelopeHeader(
        purpose: purpose,
        streamUUID: Data(repeating: 0, count: 16),
        recordSequence: sequence,
        firstLogicalUnit: firstLogicalUnit,
        logicalUnitCount: logicalUnitCount,
        plaintextByteCount: UInt32(plaintext.count),
        nonce: Data(repeating: 0, count: 12),
        previousCommittedTag: Data(repeating: 0, count: 16),
        contextHash: Data(repeating: 0, count: 32)
      ),
      plaintext: plaintext,
      authenticationTag: Data(repeating: 0, count: 16),
      encryptedStartOffset: 0,
      encryptedEndOffset: 0
    )
  }
}
