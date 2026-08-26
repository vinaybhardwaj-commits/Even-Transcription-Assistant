import CryptoKit
import Foundation

public enum ArchiveRecordPurpose: CaseIterable, Equatable, Sendable {
  case tape
  case index
  case journal
  case control
  case level
  case manifest
  case spool

  public var magic: String {
    switch self {
    case .tape: return "ETATAP01"
    case .index: return "ETAIDX01"
    case .journal: return "ETAJRN01"
    case .control: return "ETACTL01"
    case .level: return "ETALVL01"
    case .manifest: return "ETAMAN01"
    case .spool: return "ETASPL01"
    }
  }

  public var kind: UInt16 {
    switch self {
    case .tape: return 1
    case .index: return 2
    case .journal: return 3
    case .control: return 4
    case .level: return 5
    case .manifest: return 6
    case .spool: return 7
    }
  }

  public var maximumPlaintextByteCount: UInt32 {
    switch self {
    case .tape: return 32_000
    case .level: return 240
    case .index, .journal, .control, .manifest, .spool: return 1_048_576
    }
  }

  fileprivate static func purpose(magicBytes: Data) -> ArchiveRecordPurpose? {
    allCases.first { Data($0.magic.utf8) == magicBytes }
  }
}

public enum ArchiveContextError: Error, Equatable, Sendable {
  case invalidStreamUUIDLength(Int)
  case emptyField(String)
  case fieldTooLong(String, Int)
  case invalidISTDate(String)
  case invalidControlDeviceUID
  case missingDeviceUID
}

public struct ArchiveContext: Equatable, Sendable {
  public let streamUUID: Data
  public let roomID: String
  public let istDate: String
  public let laneID: String
  public let stableDeviceUID: String

  public init(
    streamUUID: Data,
    roomID: String,
    istDate: String,
    laneID: String,
    stableDeviceUID: String
  ) {
    self.streamUUID = streamUUID
    self.roomID = roomID
    self.istDate = istDate
    self.laneID = laneID
    self.stableDeviceUID = stableDeviceUID
  }

  public func encodedBytes() throws -> Data {
    guard streamUUID.count == 16 else {
      throw ArchiveContextError.invalidStreamUUIDLength(streamUUID.count)
    }
    guard !roomID.isEmpty else { throw ArchiveContextError.emptyField("room_id") }
    guard !laneID.isEmpty else { throw ArchiveContextError.emptyField("lane_id") }
    guard Self.isValidISTDate(istDate) else {
      throw ArchiveContextError.invalidISTDate(istDate)
    }
    if laneID == "_control" {
      guard stableDeviceUID.isEmpty else { throw ArchiveContextError.invalidControlDeviceUID }
    } else {
      guard !stableDeviceUID.isEmpty else { throw ArchiveContextError.missingDeviceUID }
    }

    var result = Data("eta.room-recorder/context/v1".utf8)
    result.append(0)
    result.append(streamUUID)
    for (name, value) in [
      ("room_id", roomID),
      ("ist_date", istDate),
      ("lane_id", laneID),
      ("stable_device_uid", stableDeviceUID),
    ] {
      let bytes = Data(value.utf8)
      guard bytes.count <= Int(UInt16.max) else {
        throw ArchiveContextError.fieldTooLong(name, bytes.count)
      }
      result.appendLittleEndian(UInt16(bytes.count))
      result.append(bytes)
    }
    return result
  }

  public func sha256() throws -> Data {
    Data(SHA256.hash(data: try encodedBytes()))
  }

  private static func isValidISTDate(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard bytes.count == 10, bytes[4] == 0x2D, bytes[7] == 0x2D else { return false }
    let digitPositions = [0, 1, 2, 3, 5, 6, 8, 9]
    guard digitPositions.allSatisfy({ (0x30...0x39).contains(bytes[$0]) }) else { return false }

    func number(_ range: ClosedRange<Int>) -> Int {
      range.reduce(0) { $0 * 10 + Int(bytes[$1] - 0x30) }
    }
    let year = number(0...3)
    let month = number(5...6)
    let day = number(8...9)
    guard year > 0, (1...12).contains(month) else { return false }
    let leap = year.isMultiple(of: 4) && (!year.isMultiple(of: 100) || year.isMultiple(of: 400))
    let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return (1...days[month - 1]).contains(day)
  }
}

public struct ArchiveEnvelopeHeader: Equatable, Sendable {
  public var purpose: ArchiveRecordPurpose
  public var formatVersion: UInt16
  public var headerLength: UInt16
  public var flags: UInt32
  public var streamUUID: Data
  public var recordSequence: UInt64
  public var firstLogicalUnit: UInt64
  public var logicalUnitCount: UInt32
  public var plaintextByteCount: UInt32
  public var nonce: Data
  public var previousCommittedTag: Data
  public var contextHash: Data
  public var payloadSchemaVersion: UInt16
  public var recordKind: UInt16
  public var reserved: UInt64

  public init(
    purpose: ArchiveRecordPurpose,
    streamUUID: Data,
    recordSequence: UInt64,
    firstLogicalUnit: UInt64,
    logicalUnitCount: UInt32,
    plaintextByteCount: UInt32,
    nonce: Data,
    previousCommittedTag: Data,
    contextHash: Data,
    payloadSchemaVersion: UInt16 = 1,
    formatVersion: UInt16 = 1,
    headerLength: UInt16 = 128,
    flags: UInt32 = 0,
    recordKind: UInt16? = nil,
    reserved: UInt64 = 0
  ) {
    self.purpose = purpose
    self.formatVersion = formatVersion
    self.headerLength = headerLength
    self.flags = flags
    self.streamUUID = streamUUID
    self.recordSequence = recordSequence
    self.firstLogicalUnit = firstLogicalUnit
    self.logicalUnitCount = logicalUnitCount
    self.plaintextByteCount = plaintextByteCount
    self.nonce = nonce
    self.previousCommittedTag = previousCommittedTag
    self.contextHash = contextHash
    self.payloadSchemaVersion = payloadSchemaVersion
    self.recordKind = recordKind ?? purpose.kind
    self.reserved = reserved
  }
}

public struct UnauthenticatedArchiveEnvelope: Equatable, Sendable {
  public let header: ArchiveEnvelopeHeader
  public let ciphertext: Data
  public let authenticationTag: Data

  public init(header: ArchiveEnvelopeHeader, ciphertext: Data, authenticationTag: Data) {
    self.header = header
    self.ciphertext = ciphertext
    self.authenticationTag = authenticationTag
  }
}

public enum ArchiveEnvelopeError: Error, Equatable, Sendable {
  case truncatedHeader(actual: Int)
  case unknownMagic
  case wrongPurpose(expected: ArchiveRecordPurpose, actual: ArchiveRecordPurpose)
  case unsupportedFormatVersion(UInt16)
  case invalidHeaderLength(UInt16)
  case nonzeroFlags(UInt32)
  case invalidFieldLength(field: String, expected: Int, actual: Int)
  case unsupportedPayloadSchemaVersion(UInt16)
  case wrongRecordKind(expected: UInt16, actual: UInt16)
  case nonzeroReserved(UInt64)
  case plaintextTooLarge(maximum: UInt32, actual: UInt32)
  case logicalRangeOverflow(first: UInt64, count: UInt32)
  case emptyTapeRecord
  case invalidTapeByteCount(logicalUnits: UInt32, plaintextBytes: UInt32)
  case recordLengthMismatch(expected: Int, actual: Int)
  case contextMismatch
}

public enum ArchiveEnvelopeCodec {
  public static let headerByteCount = 128
  public static let authenticationTagByteCount = 16

  public static func encodeHeader(_ header: ArchiveEnvelopeHeader) throws -> Data {
    try validate(header: header)
    var result = Data()
    result.reserveCapacity(headerByteCount)
    result.append(Data(header.purpose.magic.utf8))
    result.appendLittleEndian(header.formatVersion)
    result.appendLittleEndian(header.headerLength)
    result.appendLittleEndian(header.flags)
    result.append(header.streamUUID)
    result.appendLittleEndian(header.recordSequence)
    result.appendLittleEndian(header.firstLogicalUnit)
    result.appendLittleEndian(header.logicalUnitCount)
    result.appendLittleEndian(header.plaintextByteCount)
    result.append(header.nonce)
    result.append(header.previousCommittedTag)
    result.append(header.contextHash)
    result.appendLittleEndian(header.payloadSchemaVersion)
    result.appendLittleEndian(header.recordKind)
    result.appendLittleEndian(header.reserved)
    return result
  }

  public static func encodeUnauthenticated(_ envelope: UnauthenticatedArchiveEnvelope) throws
    -> Data
  {
    var result = try encodeHeader(envelope.header)
    guard envelope.ciphertext.count == Int(envelope.header.plaintextByteCount) else {
      throw ArchiveEnvelopeError.recordLengthMismatch(
        expected: Int(envelope.header.plaintextByteCount), actual: envelope.ciphertext.count)
    }
    guard envelope.authenticationTag.count == authenticationTagByteCount else {
      throw ArchiveEnvelopeError.invalidFieldLength(
        field: "authentication_tag", expected: authenticationTagByteCount,
        actual: envelope.authenticationTag.count)
    }

    result.reserveCapacity(headerByteCount + envelope.ciphertext.count + authenticationTagByteCount)
    result.append(envelope.ciphertext)
    result.append(envelope.authenticationTag)
    return result
  }

  public static func decodeUnauthenticated(
    _ data: Data,
    expectedPurpose: ArchiveRecordPurpose,
    expectedContextHash: Data
  ) throws -> UnauthenticatedArchiveEnvelope {
    let header = try decodeHeaderPrefix(
      data, expectedPurpose: expectedPurpose, expectedContextHash: expectedContextHash)

    let expectedCount =
      headerByteCount + Int(header.plaintextByteCount) + authenticationTagByteCount
    guard data.count == expectedCount else {
      throw ArchiveEnvelopeError.recordLengthMismatch(expected: expectedCount, actual: data.count)
    }
    let ciphertextEnd = headerByteCount + Int(header.plaintextByteCount)
    return UnauthenticatedArchiveEnvelope(
      header: header,
      ciphertext: data.bytes(atOffsets: headerByteCount..<ciphertextEnd),
      authenticationTag: data.bytes(atOffsets: ciphertextEnd..<expectedCount)
    )
  }

  static func decodeHeaderPrefix(
    _ data: Data,
    expectedPurpose: ArchiveRecordPurpose,
    expectedContextHash: Data
  ) throws -> ArchiveEnvelopeHeader {
    guard data.count >= headerByteCount else {
      throw ArchiveEnvelopeError.truncatedHeader(actual: data.count)
    }
    guard expectedContextHash.count == 32 else {
      throw ArchiveEnvelopeError.invalidFieldLength(
        field: "expected_context_hash", expected: 32, actual: expectedContextHash.count)
    }

    let magicBytes = data.bytes(atOffsets: 0..<8)
    guard let purpose = ArchiveRecordPurpose.purpose(magicBytes: magicBytes) else {
      throw ArchiveEnvelopeError.unknownMagic
    }
    guard purpose == expectedPurpose else {
      throw ArchiveEnvelopeError.wrongPurpose(expected: expectedPurpose, actual: purpose)
    }

    let header = ArchiveEnvelopeHeader(
      purpose: purpose,
      streamUUID: data.bytes(atOffsets: 16..<32),
      recordSequence: data.uint64LittleEndian(at: 32),
      firstLogicalUnit: data.uint64LittleEndian(at: 40),
      logicalUnitCount: data.uint32LittleEndian(at: 48),
      plaintextByteCount: data.uint32LittleEndian(at: 52),
      nonce: data.bytes(atOffsets: 56..<68),
      previousCommittedTag: data.bytes(atOffsets: 68..<84),
      contextHash: data.bytes(atOffsets: 84..<116),
      payloadSchemaVersion: data.uint16LittleEndian(at: 116),
      formatVersion: data.uint16LittleEndian(at: 8),
      headerLength: data.uint16LittleEndian(at: 10),
      flags: data.uint32LittleEndian(at: 12),
      recordKind: data.uint16LittleEndian(at: 118),
      reserved: data.uint64LittleEndian(at: 120)
    )
    try validate(header: header)
    guard header.contextHash == expectedContextHash else {
      throw ArchiveEnvelopeError.contextMismatch
    }
    return header
  }

  private static func validate(header: ArchiveEnvelopeHeader) throws {
    guard header.formatVersion == 1 else {
      throw ArchiveEnvelopeError.unsupportedFormatVersion(header.formatVersion)
    }
    guard header.headerLength == UInt16(headerByteCount) else {
      throw ArchiveEnvelopeError.invalidHeaderLength(header.headerLength)
    }
    guard header.flags == 0 else { throw ArchiveEnvelopeError.nonzeroFlags(header.flags) }
    for (field, bytes, expected) in [
      ("stream_uuid", header.streamUUID, 16),
      ("nonce", header.nonce, 12),
      ("previous_committed_tag", header.previousCommittedTag, 16),
      ("context_hash", header.contextHash, 32),
    ] {
      guard bytes.count == expected else {
        throw ArchiveEnvelopeError.invalidFieldLength(
          field: field, expected: expected, actual: bytes.count)
      }
    }
    guard header.payloadSchemaVersion == 1 else {
      throw ArchiveEnvelopeError.unsupportedPayloadSchemaVersion(header.payloadSchemaVersion)
    }
    guard header.recordKind == header.purpose.kind else {
      throw ArchiveEnvelopeError.wrongRecordKind(
        expected: header.purpose.kind, actual: header.recordKind)
    }
    guard header.reserved == 0 else {
      throw ArchiveEnvelopeError.nonzeroReserved(header.reserved)
    }
    guard header.plaintextByteCount <= header.purpose.maximumPlaintextByteCount else {
      throw ArchiveEnvelopeError.plaintextTooLarge(
        maximum: header.purpose.maximumPlaintextByteCount,
        actual: header.plaintextByteCount)
    }
    guard !header.firstLogicalUnit.addingReportingOverflow(UInt64(header.logicalUnitCount)).overflow
    else {
      throw ArchiveEnvelopeError.logicalRangeOverflow(
        first: header.firstLogicalUnit, count: header.logicalUnitCount)
    }
    if header.purpose == .tape {
      guard header.logicalUnitCount > 0, header.plaintextByteCount > 0 else {
        throw ArchiveEnvelopeError.emptyTapeRecord
      }
      guard UInt64(header.logicalUnitCount) * 2 == UInt64(header.plaintextByteCount) else {
        throw ArchiveEnvelopeError.invalidTapeByteCount(
          logicalUnits: header.logicalUnitCount, plaintextBytes: header.plaintextByteCount)
      }
    }
  }
}

extension Data {
  fileprivate mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
    for byteIndex in 0..<MemoryLayout<T>.size {
      append(UInt8(truncatingIfNeeded: value >> T(byteIndex * 8)))
    }
  }

  fileprivate func bytes(atOffsets offsets: Range<Int>) -> Data {
    let lower = index(startIndex, offsetBy: offsets.lowerBound)
    let upper = index(startIndex, offsetBy: offsets.upperBound)
    return Data(self[lower..<upper])
  }

  fileprivate func byte(atOffset offset: Int) -> UInt8 {
    self[index(startIndex, offsetBy: offset)]
  }

  fileprivate func uint16LittleEndian(at offset: Int) -> UInt16 {
    UInt16(byte(atOffset: offset)) | (UInt16(byte(atOffset: offset + 1)) << 8)
  }

  fileprivate func uint32LittleEndian(at offset: Int) -> UInt32 {
    UInt32(byte(atOffset: offset))
      | (UInt32(byte(atOffset: offset + 1)) << 8)
      | (UInt32(byte(atOffset: offset + 2)) << 16)
      | (UInt32(byte(atOffset: offset + 3)) << 24)
  }

  fileprivate func uint64LittleEndian(at offset: Int) -> UInt64 {
    (0..<8).reduce(UInt64(0)) { result, byteIndex in
      result | (UInt64(byte(atOffset: offset + byteIndex)) << UInt64(byteIndex * 8))
    }
  }
}
