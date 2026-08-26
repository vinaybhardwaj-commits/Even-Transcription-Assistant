import Foundation

public enum ArchiveIndexDiscontinuity: String, CaseIterable, Equatable, Sendable {
  case restart
  case deviceLost = "device_lost"
  case resumed
  case clockDiscontinuity = "clock_discontinuity"
  case formatChange = "format_change"
  case invalidTimestamp = "invalid_timestamp"
  case captureDiscontinuity = "capture_discontinuity"
  case ringOverflow = "ring_overflow"
  case crashRecoveredUnindexed = "crash_recovered_unindexed"
}

public enum ArchiveIndexPayloadError: Error, Equatable, Sendable {
  case invalidTapeSequence(UInt64)
  case invalidTapeTagLength(Int)
  case invalidEncryptedEnd(UInt64)
  case invalidSampleRange(start: UInt64, end: UInt64)
  case invalidDeviceUID
  case invalidRMS(UInt16)
  case incompleteNativeRate
  case invalidInputRate
  case invalidDiscontinuityMetrics
  case invalidRecoveredFields
  case unknownDiscontinuity(String)
  case invalidBase64Tag
  case integerOverflow(field: String)
  case invalidSyntax(offset: Int)
  case payloadTooLarge(Int)
}

public struct ArchiveIndexPayload: Equatable, Sendable {
  public let tapeSequence: UInt64
  public let tapeTag: Data
  public let encryptedEnd: UInt64
  public let sampleStart: UInt64
  public let sampleEnd: UInt64
  public let monoNS: UInt64?
  public let wallNS: UInt64?
  public let deviceUID: String
  public let rmsQ15: UInt16?
  public let nativeFrames: UInt64?
  public let inputRateNumerator: UInt64?
  public let inputRateDenominator: UInt64?
  public let discontinuity: ArchiveIndexDiscontinuity?
  public let reason: String?
  public let gapNS: UInt64?
  public let previousDurableSample: UInt64?
  public let survivingTailBytes: UInt64?

  public init(
    tapeSequence: UInt64,
    tapeTag: Data,
    encryptedEnd: UInt64,
    sampleStart: UInt64,
    sampleEnd: UInt64,
    monoNS: UInt64?,
    wallNS: UInt64?,
    deviceUID: String,
    rmsQ15: UInt16?,
    nativeFrames: UInt64?,
    inputRateNumerator: UInt64?,
    inputRateDenominator: UInt64?,
    discontinuity: ArchiveIndexDiscontinuity?,
    reason: String?,
    gapNS: UInt64?,
    previousDurableSample: UInt64?,
    survivingTailBytes: UInt64?
  ) throws {
    guard tapeSequence > 0 else {
      throw ArchiveIndexPayloadError.invalidTapeSequence(tapeSequence)
    }
    guard tapeTag.count == ArchiveEnvelopeCodec.authenticationTagByteCount else {
      throw ArchiveIndexPayloadError.invalidTapeTagLength(tapeTag.count)
    }
    guard encryptedEnd > 0 else {
      throw ArchiveIndexPayloadError.invalidEncryptedEnd(encryptedEnd)
    }
    guard sampleEnd > sampleStart else {
      throw ArchiveIndexPayloadError.invalidSampleRange(start: sampleStart, end: sampleEnd)
    }
    let deviceBytes = Data(deviceUID.utf8)
    guard !deviceBytes.isEmpty, deviceBytes.count <= 256 else {
      throw ArchiveIndexPayloadError.invalidDeviceUID
    }
    if let rmsQ15, rmsQ15 > 32_767 {
      throw ArchiveIndexPayloadError.invalidRMS(rmsQ15)
    }
    let nativeValues = [
      nativeFrames != nil,
      inputRateNumerator != nil,
      inputRateDenominator != nil,
    ]
    guard nativeValues.allSatisfy({ $0 }) || nativeValues.allSatisfy({ !$0 }) else {
      throw ArchiveIndexPayloadError.incompleteNativeRate
    }
    if inputRateNumerator != nil, let inputRateDenominator, inputRateDenominator == 0 {
      throw ArchiveIndexPayloadError.invalidInputRate
    }
    if discontinuity == nil,
      reason != nil || gapNS != nil || previousDurableSample != nil || survivingTailBytes != nil
    {
      throw ArchiveIndexPayloadError.invalidDiscontinuityMetrics
    }
    if discontinuity == .crashRecoveredUnindexed {
      guard monoNS == nil, wallNS == nil, rmsQ15 == nil,
        nativeFrames == nil, inputRateNumerator == nil, inputRateDenominator == nil,
        gapNS == nil, reason == ArchiveIndexDiscontinuity.crashRecoveredUnindexed.rawValue,
        let previousDurableSample, previousDurableSample <= sampleStart,
        let survivingTailBytes, survivingTailBytes > 0
      else {
        throw ArchiveIndexPayloadError.invalidRecoveredFields
      }
    }

    self.tapeSequence = tapeSequence
    self.tapeTag = tapeTag
    self.encryptedEnd = encryptedEnd
    self.sampleStart = sampleStart
    self.sampleEnd = sampleEnd
    self.monoNS = monoNS
    self.wallNS = wallNS
    self.deviceUID = deviceUID
    self.rmsQ15 = rmsQ15
    self.nativeFrames = nativeFrames
    self.inputRateNumerator = inputRateNumerator
    self.inputRateDenominator = inputRateDenominator
    self.discontinuity = discontinuity
    self.reason = reason
    self.gapNS = gapNS
    self.previousDurableSample = previousDurableSample
    self.survivingTailBytes = survivingTailBytes
    try ArchiveIndexPayloadCodec.validateEncodedSize(self)
  }
}

public enum ArchiveIndexPayloadCodec {
  public static func encode(_ payload: ArchiveIndexPayload) throws -> Data {
    var result = Data()
    result.reserveCapacity(try canonicalEncodedByteCount(payload))
    result.append(0x7B)
    appendKey("device_uid", to: &result)
    appendString(payload.deviceUID, to: &result)
    appendKey("discontinuity", prefix: 0x2C, to: &result)
    appendOptionalString(payload.discontinuity?.rawValue, to: &result)
    appendKey("encrypted_end", prefix: 0x2C, to: &result)
    appendInteger(payload.encryptedEnd, to: &result)
    appendKey("gap_ns", prefix: 0x2C, to: &result)
    appendOptionalInteger(payload.gapNS, to: &result)
    appendKey("input_rate_den", prefix: 0x2C, to: &result)
    appendOptionalInteger(payload.inputRateDenominator, to: &result)
    appendKey("input_rate_num", prefix: 0x2C, to: &result)
    appendOptionalInteger(payload.inputRateNumerator, to: &result)
    appendKey("mono_ns", prefix: 0x2C, to: &result)
    appendOptionalInteger(payload.monoNS, to: &result)
    appendKey("native_frames", prefix: 0x2C, to: &result)
    appendOptionalInteger(payload.nativeFrames, to: &result)
    appendKey("previous_durable_sample", prefix: 0x2C, to: &result)
    appendOptionalInteger(payload.previousDurableSample, to: &result)
    appendKey("reason", prefix: 0x2C, to: &result)
    appendOptionalString(payload.reason, to: &result)
    appendKey("rms_q15", prefix: 0x2C, to: &result)
    appendOptionalInteger(payload.rmsQ15.map(UInt64.init), to: &result)
    appendKey("sample_end", prefix: 0x2C, to: &result)
    appendInteger(payload.sampleEnd, to: &result)
    appendKey("sample_start", prefix: 0x2C, to: &result)
    appendInteger(payload.sampleStart, to: &result)
    appendKey("surviving_tail_bytes", prefix: 0x2C, to: &result)
    appendOptionalInteger(payload.survivingTailBytes, to: &result)
    appendKey("tape_seq", prefix: 0x2C, to: &result)
    appendInteger(payload.tapeSequence, to: &result)
    appendKey("tape_tag_b64", prefix: 0x2C, to: &result)
    appendString(payload.tapeTag.base64EncodedString(), to: &result)
    appendKey("wall_ns", prefix: 0x2C, to: &result)
    appendOptionalInteger(payload.wallNS, to: &result)
    result.append(0x7D)
    return result
  }

  public static func decode(_ data: Data) throws -> ArchiveIndexPayload {
    guard data.count <= Int(ArchiveRecordPurpose.index.maximumPlaintextByteCount) else {
      throw ArchiveIndexPayloadError.payloadTooLarge(data.count)
    }
    var parser = ArchiveIndexParser(data)
    try parser.expect("{\"device_uid\":")
    let deviceUID = try parser.string()
    try parser.expect(",\"discontinuity\":")
    let discontinuityRaw = try parser.optionalString()
    let discontinuity: ArchiveIndexDiscontinuity?
    if let discontinuityRaw {
      guard let value = ArchiveIndexDiscontinuity(rawValue: discontinuityRaw) else {
        throw ArchiveIndexPayloadError.unknownDiscontinuity(discontinuityRaw)
      }
      discontinuity = value
    } else {
      discontinuity = nil
    }
    try parser.expect(",\"encrypted_end\":")
    let encryptedEnd = try parser.integer(field: "encrypted_end")
    try parser.expect(",\"gap_ns\":")
    let gapNS = try parser.optionalInteger(field: "gap_ns")
    try parser.expect(",\"input_rate_den\":")
    let inputRateDenominator = try parser.optionalInteger(field: "input_rate_den")
    try parser.expect(",\"input_rate_num\":")
    let inputRateNumerator = try parser.optionalInteger(field: "input_rate_num")
    try parser.expect(",\"mono_ns\":")
    let monoNS = try parser.optionalInteger(field: "mono_ns")
    try parser.expect(",\"native_frames\":")
    let nativeFrames = try parser.optionalInteger(field: "native_frames")
    try parser.expect(",\"previous_durable_sample\":")
    let previousDurableSample = try parser.optionalInteger(field: "previous_durable_sample")
    try parser.expect(",\"reason\":")
    let reason = try parser.optionalString()
    try parser.expect(",\"rms_q15\":")
    let rmsValue = try parser.optionalInteger(field: "rms_q15")
    guard rmsValue == nil || rmsValue! <= UInt64(UInt16.max) else {
      throw ArchiveIndexPayloadError.integerOverflow(field: "rms_q15")
    }
    try parser.expect(",\"sample_end\":")
    let sampleEnd = try parser.integer(field: "sample_end")
    try parser.expect(",\"sample_start\":")
    let sampleStart = try parser.integer(field: "sample_start")
    try parser.expect(",\"surviving_tail_bytes\":")
    let survivingTailBytes = try parser.optionalInteger(field: "surviving_tail_bytes")
    try parser.expect(",\"tape_seq\":")
    let tapeSequence = try parser.integer(field: "tape_seq")
    try parser.expect(",\"tape_tag_b64\":")
    let tapeTagString = try parser.string()
    guard let tapeTag = Data(base64Encoded: tapeTagString),
      tapeTag.base64EncodedString() == tapeTagString
    else {
      throw ArchiveIndexPayloadError.invalidBase64Tag
    }
    try parser.expect(",\"wall_ns\":")
    let wallNS = try parser.optionalInteger(field: "wall_ns")
    try parser.expect("}")
    try parser.expectEnd()

    return try ArchiveIndexPayload(
      tapeSequence: tapeSequence,
      tapeTag: tapeTag,
      encryptedEnd: encryptedEnd,
      sampleStart: sampleStart,
      sampleEnd: sampleEnd,
      monoNS: monoNS,
      wallNS: wallNS,
      deviceUID: deviceUID,
      rmsQ15: rmsValue.map(UInt16.init),
      nativeFrames: nativeFrames,
      inputRateNumerator: inputRateNumerator,
      inputRateDenominator: inputRateDenominator,
      discontinuity: discontinuity,
      reason: reason,
      gapNS: gapNS,
      previousDurableSample: previousDurableSample,
      survivingTailBytes: survivingTailBytes
    )
  }

  private static func appendKey(_ key: String, prefix: UInt8? = nil, to result: inout Data) {
    if let prefix { result.append(prefix) }
    result.append(0x22)
    result.append(contentsOf: key.utf8)
    result.append(contentsOf: [0x22, 0x3A])
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
      case 0x22:
        result.append(contentsOf: "\\\"".utf8)
      case 0x5C:
        result.append(contentsOf: "\\\\".utf8)
      case 0...0x1F:
        result.append(contentsOf: "\\u00".utf8)
        result.append(hexadecimal[Int(scalar.value >> 4)])
        result.append(hexadecimal[Int(scalar.value & 0x0F)])
      default:
        result.append(contentsOf: String(scalar).utf8)
      }
    }
    result.append(0x22)
  }

  fileprivate static func validateEncodedSize(_ payload: ArchiveIndexPayload) throws {
    _ = try canonicalEncodedByteCount(payload)
  }

  private static func canonicalEncodedByteCount(_ payload: ArchiveIndexPayload) throws -> Int {
    let fields: [(String, Int)] = [
      ("device_uid", stringByteCount(payload.deviceUID)),
      ("discontinuity", optionalStringByteCount(payload.discontinuity?.rawValue)),
      ("encrypted_end", integerByteCount(payload.encryptedEnd)),
      ("gap_ns", optionalIntegerByteCount(payload.gapNS)),
      ("input_rate_den", optionalIntegerByteCount(payload.inputRateDenominator)),
      ("input_rate_num", optionalIntegerByteCount(payload.inputRateNumerator)),
      ("mono_ns", optionalIntegerByteCount(payload.monoNS)),
      ("native_frames", optionalIntegerByteCount(payload.nativeFrames)),
      ("previous_durable_sample", optionalIntegerByteCount(payload.previousDurableSample)),
      ("reason", optionalStringByteCount(payload.reason)),
      ("rms_q15", optionalIntegerByteCount(payload.rmsQ15.map(UInt64.init))),
      ("sample_end", integerByteCount(payload.sampleEnd)),
      ("sample_start", integerByteCount(payload.sampleStart)),
      ("surviving_tail_bytes", optionalIntegerByteCount(payload.survivingTailBytes)),
      ("tape_seq", integerByteCount(payload.tapeSequence)),
      ("tape_tag_b64", stringByteCount(payload.tapeTag.base64EncodedString())),
      ("wall_ns", optionalIntegerByteCount(payload.wallNS)),
    ]
    var count = 2
    for (index, field) in fields.enumerated() {
      for addition in [index == 0 ? 0 : 1, field.0.utf8.count + 3, field.1] {
        let next = count.addingReportingOverflow(addition)
        count = next.overflow ? Int.max : next.partialValue
      }
    }
    guard count <= Int(ArchiveRecordPurpose.index.maximumPlaintextByteCount) else {
      throw ArchiveIndexPayloadError.payloadTooLarge(count)
    }
    return count
  }

  private static func optionalIntegerByteCount(_ value: UInt64?) -> Int {
    value.map(integerByteCount) ?? 4
  }

  private static func integerByteCount(_ value: UInt64) -> Int {
    String(value).utf8.count
  }

  private static func optionalStringByteCount(_ value: String?) -> Int {
    value.map(stringByteCount) ?? 4
  }

  private static func stringByteCount(_ value: String) -> Int {
    let scalarBytes = value.unicodeScalars.reduce(0) { count, scalar in
      let scalarCount: Int
      switch scalar.value {
      case 0x22, 0x5C: scalarCount = 2
      case 0...0x1F: scalarCount = 6
      case 0...0x7F: scalarCount = 1
      case 0...0x7FF: scalarCount = 2
      case 0...0xFFFF: scalarCount = 3
      default: scalarCount = 4
      }
      let next = count.addingReportingOverflow(scalarCount)
      return next.overflow ? Int.max : next.partialValue
    }
    let total = scalarBytes.addingReportingOverflow(2)
    return total.overflow ? Int.max : total.partialValue
  }
}

private struct ArchiveIndexParser {
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
      throw ArchiveIndexPayloadError.invalidSyntax(offset: offset)
    }
    offset += expected.count
  }

  mutating func expectEnd() throws {
    guard offset == bytes.count else {
      throw ArchiveIndexPayloadError.invalidSyntax(offset: offset)
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
      throw ArchiveIndexPayloadError.invalidSyntax(offset: offset)
    }
    if bytes[offset] == 0x30 {
      offset += 1
      if offset < bytes.count, (0x30...0x39).contains(bytes[offset]) {
        throw ArchiveIndexPayloadError.invalidSyntax(offset: offset)
      }
      return 0
    }
    var value: UInt64 = 0
    while offset < bytes.count, (0x30...0x39).contains(bytes[offset]) {
      let digit = UInt64(bytes[offset] - 0x30)
      let multiplied = value.multipliedReportingOverflow(by: 10)
      let added = multiplied.partialValue.addingReportingOverflow(digit)
      guard !multiplied.overflow, !added.overflow else {
        throw ArchiveIndexPayloadError.integerOverflow(field: field)
      }
      value = added.partialValue
      offset += 1
    }
    guard offset > start else {
      throw ArchiveIndexPayloadError.invalidSyntax(offset: offset)
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
      throw ArchiveIndexPayloadError.invalidSyntax(offset: offset)
    }
    offset += 1
    var decoded = Data()
    while offset < bytes.count {
      let byte = bytes[offset]
      offset += 1
      if byte == 0x22 {
        guard let result = String(data: decoded, encoding: .utf8) else {
          throw ArchiveIndexPayloadError.invalidSyntax(offset: offset - 1)
        }
        return result
      }
      if byte == 0x5C {
        guard offset < bytes.count else {
          throw ArchiveIndexPayloadError.invalidSyntax(offset: offset)
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
          let low = lowercaseHex(bytes[offset + 3])
        else {
          throw ArchiveIndexPayloadError.invalidSyntax(offset: offset - 1)
        }
        let control = high * 16 + low
        guard control <= 0x1F else {
          throw ArchiveIndexPayloadError.invalidSyntax(offset: offset)
        }
        decoded.append(control)
        offset += 4
        continue
      }
      guard byte >= 0x20 else {
        throw ArchiveIndexPayloadError.invalidSyntax(offset: offset - 1)
      }
      decoded.append(byte)
    }
    throw ArchiveIndexPayloadError.invalidSyntax(offset: offset)
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
