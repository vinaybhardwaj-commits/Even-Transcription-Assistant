import CryptoKit
import Foundation

public enum ArchiveCaptureSessionBindingError: Error, Equatable, Sendable {
  case invalidSessionID
  case invalidLane
  case invalidSampleRange
  case payloadTooLarge(Int)
  case invalidMagic
  case unsupportedVersion(UInt16)
  case invalidUTF8
  case invalidLength
  case commandIDMismatch
  case noncanonical
}

public struct ArchiveCaptureSessionBinding: Equatable, Sendable {
  public let commandID: String
  public let sessionID: String
  public let primaryIdentity: ArchiveDailyLaneIdentity
  public let sessionSampleStart: UInt64
  public let segmentSampleStart: UInt64

  public init(
    sessionID: String,
    primaryIdentity: ArchiveDailyLaneIdentity,
    sessionSampleStart: UInt64,
    segmentSampleStart: UInt64
  ) throws {
    guard !sessionID.isEmpty, sessionID.utf8.count <= 256 else {
      throw ArchiveCaptureSessionBindingError.invalidSessionID
    }
    guard primaryIdentity.laneID == "primary" else {
      throw ArchiveCaptureSessionBindingError.invalidLane
    }
    guard sessionSampleStart <= segmentSampleStart,
      primaryIdentity.expectedInitialSessionSample <= segmentSampleStart
    else {
      throw ArchiveCaptureSessionBindingError.invalidSampleRange
    }
    self.sessionID = sessionID
    self.primaryIdentity = primaryIdentity
    self.sessionSampleStart = sessionSampleStart
    self.segmentSampleStart = segmentSampleStart
    commandID = Self.makeCommandID(
      sessionID: sessionID,
      primaryIdentity: primaryIdentity,
      sessionSampleStart: sessionSampleStart,
      segmentSampleStart: segmentSampleStart)
  }

  private static func makeCommandID(
    sessionID: String,
    primaryIdentity: ArchiveDailyLaneIdentity,
    sessionSampleStart: UInt64,
    segmentSampleStart: UInt64
  ) -> String {
    var bytes = Data("eta.room-recorder/capture-session-binding/v1".utf8)
    append(Data(sessionID.utf8), to: &bytes)
    append(primaryIdentity.context.streamUUID, to: &bytes)
    append(Data(primaryIdentity.context.roomID.utf8), to: &bytes)
    append(Data(primaryIdentity.context.istDate.utf8), to: &bytes)
    append(Data(primaryIdentity.context.laneID.utf8), to: &bytes)
    append(Data(primaryIdentity.context.stableDeviceUID.utf8), to: &bytes)
    append(primaryIdentity.expectedInitialSessionSample, to: &bytes)
    append(Data(primaryIdentity.keywrapDigestHex.utf8), to: &bytes)
    append(sessionSampleStart, to: &bytes)
    append(segmentSampleStart, to: &bytes)
    return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
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

public enum ArchiveCaptureSessionBindingCodec {
  private static let magic = Data("ETACSB01".utf8)
  private static let version: UInt16 = 1
  public static let maximumEncodedByteCount = 16_384

  public static func encode(_ binding: ArchiveCaptureSessionBinding) throws -> Data {
    var writer = Writer()
    writer.data.append(magic)
    writer.append(version)
    try writer.append(binding.commandID)
    try writer.append(binding.sessionID)
    try writer.append(binding.primaryIdentity.context.streamUUID)
    try writer.append(binding.primaryIdentity.context.roomID)
    try writer.append(binding.primaryIdentity.context.istDate)
    try writer.append(binding.primaryIdentity.context.laneID)
    try writer.append(binding.primaryIdentity.context.stableDeviceUID)
    writer.append(binding.primaryIdentity.expectedInitialSessionSample)
    try writer.append(binding.primaryIdentity.keywrapDigestHex)
    writer.append(binding.sessionSampleStart)
    writer.append(binding.segmentSampleStart)
    guard writer.data.count <= maximumEncodedByteCount else {
      throw ArchiveCaptureSessionBindingError.payloadTooLarge(writer.data.count)
    }
    return writer.data
  }

  public static func decode(_ data: Data) throws -> ArchiveCaptureSessionBinding {
    guard data.count <= maximumEncodedByteCount else {
      throw ArchiveCaptureSessionBindingError.payloadTooLarge(data.count)
    }
    var reader = Reader(data: data)
    guard try reader.read(count: magic.count) == magic else {
      throw ArchiveCaptureSessionBindingError.invalidMagic
    }
    let encodedVersion: UInt16 = try reader.integer()
    guard encodedVersion == version else {
      throw ArchiveCaptureSessionBindingError.unsupportedVersion(encodedVersion)
    }
    let commandID = try reader.string()
    let sessionID = try reader.string()
    let identity = try ArchiveDailyLaneIdentity(
      context: ArchiveContext(
        streamUUID: reader.lengthPrefixedData(),
        roomID: reader.string(),
        istDate: reader.string(),
        laneID: reader.string(),
        stableDeviceUID: reader.string()),
      expectedInitialSessionSample: reader.integer(),
      keywrapDigestHex: reader.string())
    let binding = try ArchiveCaptureSessionBinding(
      sessionID: sessionID,
      primaryIdentity: identity,
      sessionSampleStart: reader.integer(),
      segmentSampleStart: reader.integer())
    guard reader.isAtEnd else { throw ArchiveCaptureSessionBindingError.invalidLength }
    guard binding.commandID == commandID else {
      throw ArchiveCaptureSessionBindingError.commandIDMismatch
    }
    guard try encode(binding) == data else {
      throw ArchiveCaptureSessionBindingError.noncanonical
    }
    return binding
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
        throw ArchiveCaptureSessionBindingError.invalidLength
      }
      append(UInt32(value.count))
      data.append(value)
    }

    mutating func append(_ value: String) throws {
      try append(Data(value.utf8))
    }
  }

  private struct Reader {
    let data: Data
    var offset = 0
    var isAtEnd: Bool { offset == data.count }

    mutating func integer<T: FixedWidthInteger>() throws -> T {
      guard data.count - offset >= MemoryLayout<T>.size else {
        throw ArchiveCaptureSessionBindingError.invalidLength
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
        throw ArchiveCaptureSessionBindingError.invalidLength
      }
      defer { offset += count }
      return data.subdata(in: offset..<(offset + count))
    }

    mutating func lengthPrefixedData() throws -> Data {
      let count: UInt32 = try integer()
      guard let count = Int(exactly: count) else {
        throw ArchiveCaptureSessionBindingError.invalidLength
      }
      return try read(count: count)
    }

    mutating func string() throws -> String {
      let bytes = try lengthPrefixedData()
      guard let result = String(data: bytes, encoding: .utf8), Data(result.utf8) == bytes else {
        throw ArchiveCaptureSessionBindingError.invalidUTF8
      }
      return result
    }
  }
}
