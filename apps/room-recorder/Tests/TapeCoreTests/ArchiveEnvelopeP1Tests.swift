import Foundation
import Testing

@testable import TapeCore

@Suite struct ArchiveEnvelopeP1Tests {
  private let streamUUID = Data(hex: "00112233445566778899aabbccddeeff")
  private let contextHash = Data(
    hex: "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f")

  @Test func archive01FreezesContextBytesAndHash() throws {
    let context = ArchiveContext(
      streamUUID: streamUUID,
      roomID: "room_1",
      istDate: "2026-08-26",
      laneID: "primary",
      stableDeviceUID: "AppleUSBAudioEngine:test"
    )

    #expect(
      try context.encodedBytes()
        == Data(
          hex:
            "6574612e726f6f6d2d7265636f726465722f636f6e746578742f76310000112233445566778899aabbccddeeff0600726f6f6d5f310a00323032362d30382d323607007072696d61727918004170706c65555342417564696f456e67696e653a74657374"
        ))
    #expect(
      try context.sha256()
        == Data(hex: "4776785c037085566905aa531bc701b0219c5950076cd21c433df74a8eccd028"))
  }

  @Test func archive01FreezesPurposeMagicAndKindPairs() {
    let expected: [(ArchiveRecordPurpose, String, UInt16)] = [
      (.tape, "ETATAP01", 1),
      (.index, "ETAIDX01", 2),
      (.journal, "ETAJRN01", 3),
      (.control, "ETACTL01", 4),
      (.level, "ETALVL01", 5),
      (.manifest, "ETAMAN01", 6),
      (.spool, "ETASPL01", 7),
    ]

    #expect(ArchiveRecordPurpose.allCases.count == expected.count)
    for (purpose, magic, kind) in expected {
      #expect(purpose.magic == magic)
      #expect(purpose.kind == kind)
      #expect(Data(purpose.magic.utf8).count == 8)
    }
  }

  @Test func archive01EncodesAndDecodesTheGoldenTapeRecord() throws {
    let envelope = goldenEnvelope()
    let expected = Data(
      hex:
        "4554415441503031010080000000000000112233445566778899aabbccddeeff010000000000000008070605040302010400000008000000000102030405060708090a0b00000000000000000000000000000000202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f010001000000000000000000deadbeef00010203a0a1a2a3a4a5a6a7a8a9aaabacadaeaf"
    )

    #expect(try ArchiveEnvelopeCodec.encodeHeader(envelope.header) == Data(expected.prefix(128)))
    #expect(try ArchiveEnvelopeCodec.encodeUnauthenticated(envelope) == expected)
    #expect(
      try ArchiveEnvelopeCodec.decodeUnauthenticated(
        expected, expectedPurpose: .tape, expectedContextHash: contextHash) == envelope)
  }

  @Test func archive01DecodesADataSliceWithoutAssumingZeroBasedIndices() throws {
    let expected = try ArchiveEnvelopeCodec.encodeUnauthenticated(goldenEnvelope())
    var prefixed = Data([0xFF])
    prefixed.append(expected)
    let slice = prefixed.dropFirst()

    #expect(slice.startIndex == 1)
    #expect(
      try ArchiveEnvelopeCodec.decodeUnauthenticated(
        slice, expectedPurpose: .tape, expectedContextHash: contextHash) == goldenEnvelope())
  }

  @Test func archive01RejectsMalformedFixedHeaderFields() throws {
    let valid = try ArchiveEnvelopeCodec.encodeUnauthenticated(goldenEnvelope())
    let mutations: [(Int, UInt8, ArchiveEnvelopeError)] = [
      (8, 2, .unsupportedFormatVersion(2)),
      (10, 127, .invalidHeaderLength(127)),
      (12, 1, .nonzeroFlags(1)),
      (116, 2, .unsupportedPayloadSchemaVersion(2)),
      (118, 2, .wrongRecordKind(expected: 1, actual: 2)),
      (120, 1, .nonzeroReserved(1)),
    ]

    for (offset, byte, expectedError) in mutations {
      var malformed = valid
      malformed[offset] = byte
      #expect(throws: expectedError) {
        try ArchiveEnvelopeCodec.decodeUnauthenticated(
          malformed, expectedPurpose: .tape, expectedContextHash: contextHash)
      }
    }
  }

  @Test func archive01RejectsInvalidFixedFieldLengths() throws {
    let base = goldenEnvelope()
    var invalidHeaders: [(ArchiveEnvelopeHeader, ArchiveEnvelopeError)] = []

    var stream = base.header
    stream.streamUUID = Data(repeating: 0, count: 15)
    invalidHeaders.append(
      (stream, .invalidFieldLength(field: "stream_uuid", expected: 16, actual: 15)))

    var nonce = base.header
    nonce.nonce = Data(repeating: 0, count: 11)
    invalidHeaders.append((nonce, .invalidFieldLength(field: "nonce", expected: 12, actual: 11)))

    var predecessor = base.header
    predecessor.previousCommittedTag = Data(repeating: 0, count: 15)
    invalidHeaders.append(
      (
        predecessor,
        .invalidFieldLength(field: "previous_committed_tag", expected: 16, actual: 15)
      ))

    var context = base.header
    context.contextHash = Data(repeating: 0, count: 31)
    invalidHeaders.append(
      (context, .invalidFieldLength(field: "context_hash", expected: 32, actual: 31)))

    for (header, expectedError) in invalidHeaders {
      #expect(throws: expectedError) {
        try ArchiveEnvelopeCodec.encodeHeader(header)
      }
    }

    #expect(
      throws: ArchiveEnvelopeError.invalidFieldLength(
        field: "authentication_tag", expected: 16, actual: 15)
    ) {
      try ArchiveEnvelopeCodec.encodeUnauthenticated(
        UnauthenticatedArchiveEnvelope(
          header: base.header,
          ciphertext: base.ciphertext,
          authenticationTag: Data(repeating: 0, count: 15)
        ))
    }

    let encoded = try ArchiveEnvelopeCodec.encodeUnauthenticated(base)
    #expect(
      throws: ArchiveEnvelopeError.invalidFieldLength(
        field: "expected_context_hash", expected: 32, actual: 31)
    ) {
      try ArchiveEnvelopeCodec.decodeUnauthenticated(
        encoded, expectedPurpose: .tape, expectedContextHash: Data(repeating: 0, count: 31))
    }
  }

  @Test func archive01RejectsWrongPurposeContextAndUnknownMagic() throws {
    let valid = try ArchiveEnvelopeCodec.encodeUnauthenticated(goldenEnvelope())

    #expect(throws: ArchiveEnvelopeError.wrongPurpose(expected: .index, actual: .tape)) {
      try ArchiveEnvelopeCodec.decodeUnauthenticated(
        valid, expectedPurpose: .index, expectedContextHash: contextHash)
    }
    #expect(throws: ArchiveEnvelopeError.contextMismatch) {
      try ArchiveEnvelopeCodec.decodeUnauthenticated(
        valid, expectedPurpose: .tape, expectedContextHash: Data(repeating: 0xFF, count: 32))
    }
    var unknown = valid
    unknown[0] = 0
    #expect(throws: ArchiveEnvelopeError.unknownMagic) {
      try ArchiveEnvelopeCodec.decodeUnauthenticated(
        unknown, expectedPurpose: .tape, expectedContextHash: contextHash)
    }
  }

  @Test func archive01RejectsTruncationTrailingBytesAndImpossibleTapeCounts() throws {
    let valid = try ArchiveEnvelopeCodec.encodeUnauthenticated(goldenEnvelope())

    #expect(throws: ArchiveEnvelopeError.truncatedHeader(actual: 127)) {
      try ArchiveEnvelopeCodec.decodeUnauthenticated(
        Data(valid.prefix(127)), expectedPurpose: .tape, expectedContextHash: contextHash)
    }
    #expect(throws: ArchiveEnvelopeError.recordLengthMismatch(expected: 152, actual: 151)) {
      try ArchiveEnvelopeCodec.decodeUnauthenticated(
        Data(valid.dropLast()), expectedPurpose: .tape, expectedContextHash: contextHash)
    }
    var trailing = valid
    trailing.append(0)
    #expect(throws: ArchiveEnvelopeError.recordLengthMismatch(expected: 152, actual: 153)) {
      try ArchiveEnvelopeCodec.decodeUnauthenticated(
        trailing, expectedPurpose: .tape, expectedContextHash: contextHash)
    }

    var empty = goldenEnvelope().header
    empty.logicalUnitCount = 0
    empty.plaintextByteCount = 0
    #expect(throws: ArchiveEnvelopeError.emptyTapeRecord) {
      try ArchiveEnvelopeCodec.encodeUnauthenticated(
        UnauthenticatedArchiveEnvelope(
          header: empty, ciphertext: Data(), authenticationTag: Data(repeating: 0, count: 16)))
    }

    var mismatched = goldenEnvelope().header
    mismatched.logicalUnitCount = 3
    #expect(
      throws: ArchiveEnvelopeError.invalidTapeByteCount(logicalUnits: 3, plaintextBytes: 8)
    ) {
      try ArchiveEnvelopeCodec.encodeUnauthenticated(
        UnauthenticatedArchiveEnvelope(
          header: mismatched,
          ciphertext: goldenEnvelope().ciphertext,
          authenticationTag: goldenEnvelope().authenticationTag
        ))
    }

    var overflow = goldenEnvelope().header
    overflow.firstLogicalUnit = UInt64.max - 2
    #expect(
      throws: ArchiveEnvelopeError.logicalRangeOverflow(first: UInt64.max - 2, count: 4)
    ) {
      try ArchiveEnvelopeCodec.encodeHeader(overflow)
    }
  }

  @Test func archive01RejectsInvalidContextFields() {
    #expect(throws: ArchiveContextError.invalidStreamUUIDLength(15)) {
      try ArchiveContext(
        streamUUID: Data(repeating: 0, count: 15),
        roomID: "room_1",
        istDate: "2026-08-26",
        laneID: "primary",
        stableDeviceUID: "device"
      ).encodedBytes()
    }
    #expect(throws: ArchiveContextError.emptyField("room_id")) {
      try ArchiveContext(
        streamUUID: streamUUID,
        roomID: "",
        istDate: "2026-08-26",
        laneID: "primary",
        stableDeviceUID: "device"
      ).encodedBytes()
    }
    #expect(throws: ArchiveContextError.emptyField("lane_id")) {
      try ArchiveContext(
        streamUUID: streamUUID,
        roomID: "room_1",
        istDate: "2026-08-26",
        laneID: "",
        stableDeviceUID: "device"
      ).encodedBytes()
    }
    #expect(throws: ArchiveContextError.invalidISTDate("2026-02-29")) {
      try ArchiveContext(
        streamUUID: streamUUID,
        roomID: "room_1",
        istDate: "2026-02-29",
        laneID: "primary",
        stableDeviceUID: "device"
      ).encodedBytes()
    }
    #expect(throws: ArchiveContextError.invalidControlDeviceUID) {
      try ArchiveContext(
        streamUUID: streamUUID,
        roomID: "room_1",
        istDate: "2026-08-26",
        laneID: "_control",
        stableDeviceUID: "device"
      ).encodedBytes()
    }
    #expect(throws: ArchiveContextError.missingDeviceUID) {
      try ArchiveContext(
        streamUUID: streamUUID,
        roomID: "room_1",
        istDate: "2026-08-26",
        laneID: "primary",
        stableDeviceUID: ""
      ).encodedBytes()
    }
    #expect(throws: ArchiveContextError.fieldTooLong("stable_device_uid", 65_536)) {
      try ArchiveContext(
        streamUUID: streamUUID,
        roomID: "room_1",
        istDate: "2026-08-26",
        laneID: "primary",
        stableDeviceUID: String(repeating: "x", count: 65_536)
      ).encodedBytes()
    }
  }

  @Test func archive01EnforcesEveryPurposePayloadLimit() {
    for purpose in ArchiveRecordPurpose.allCases {
      let byteCount = purpose.maximumPlaintextByteCount + 1
      var header = goldenEnvelope().header
      header.purpose = purpose
      header.recordKind = purpose.kind
      header.plaintextByteCount = byteCount
      if purpose == .tape {
        header.logicalUnitCount = byteCount / 2
      }

      #expect(
        throws: ArchiveEnvelopeError.plaintextTooLarge(
          maximum: purpose.maximumPlaintextByteCount, actual: byteCount)
      ) {
        try ArchiveEnvelopeCodec.encodeHeader(header)
      }
    }
  }

  private func goldenEnvelope() -> UnauthenticatedArchiveEnvelope {
    UnauthenticatedArchiveEnvelope(
      header: ArchiveEnvelopeHeader(
        purpose: .tape,
        streamUUID: streamUUID,
        recordSequence: 1,
        firstLogicalUnit: 0x0102_0304_0506_0708,
        logicalUnitCount: 4,
        plaintextByteCount: 8,
        nonce: Data(hex: "000102030405060708090a0b"),
        previousCommittedTag: Data(repeating: 0, count: 16),
        contextHash: contextHash
      ),
      ciphertext: Data(hex: "deadbeef00010203"),
      authenticationTag: Data(hex: "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf")
    )
  }
}

extension Data {
  fileprivate init(hex: String) {
    precondition(hex.count.isMultiple(of: 2))
    self.init()
    reserveCapacity(hex.count / 2)
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      append(UInt8(hex[index..<next], radix: 16)!)
      index = next
    }
  }
}
