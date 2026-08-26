import CryptoKit
import Foundation
import Testing

@testable import TapeCore

@Suite struct ArchiveIndexPayloadP1Tests {
  private let firstTag = indexHex("5c0b8c5c789140a3c901f0d90cfbf55c")
  private let secondTag = indexHex("51a6835fa3a1de005a5a85d6d88ceb60")

  @Test func archive04FreezesTheIndependentNormalVector() throws {
    let encoded = try ArchiveIndexPayloadCodec.encode(normalPayload())

    #expect(encoded == normalVector)
    #expect(
      indexSHA256(encoded)
        == "0374ba2c92f021dbd110d5a77cea27853747fac4d47e8f92d247cc559a884291")
    #expect(try ArchiveIndexPayloadCodec.decode(encoded) == normalPayload())
  }

  @Test func archive04FreezesTheIndependentRecoveryVector() throws {
    let encoded = try ArchiveIndexPayloadCodec.encode(recoveredPayload())

    #expect(encoded == recoveredVector)
    #expect(
      indexSHA256(encoded)
        == "e46264a40f460963b17d898a95f89eff77708c8aef4dd5944f0ae9d590cdf2e3")
    #expect(try ArchiveIndexPayloadCodec.decode(encoded) == recoveredPayload())
  }

  @Test func archive04RoundTripsUInt64LimitsAndCanonicalStringEscapes() throws {
    let deviceUID = "A\"\\/\u{0000}e\u{0301}"
    let payload = try ArchiveIndexPayload(
      tapeSequence: .max,
      tapeTag: firstTag,
      encryptedEnd: .max,
      sampleStart: UInt64.max - 1,
      sampleEnd: .max,
      monoNS: .max,
      wallNS: .max,
      deviceUID: deviceUID,
      rmsQ15: 32_767,
      nativeFrames: .max,
      inputRateNumerator: .max,
      inputRateDenominator: 1,
      discontinuity: nil,
      reason: nil,
      gapNS: nil,
      previousDurableSample: nil,
      survivingTailBytes: nil
    )
    let encoded = try ArchiveIndexPayloadCodec.encode(payload)
    let text = try #require(String(data: encoded, encoding: .utf8))

    #expect(text.contains(#""device_uid":"A\"\\/\u0000é""#))
    #expect(text.contains(#""encrypted_end":18446744073709551615"#))
    let decoded = try ArchiveIndexPayloadCodec.decode(encoded)
    #expect(Array(decoded.deviceUID.unicodeScalars) == Array(deviceUID.unicodeScalars))
    #expect(try ArchiveIndexPayloadCodec.encode(decoded) == encoded)
  }

  @Test func archive04RejectsNoncanonicalJSONRepresentations() throws {
    let normal = try #require(String(data: normalVector, encoding: .utf8))
    let variants = [
      " " + normal,
      normal + "\n",
      normal.replacingOccurrences(of: "\"encrypted_end\":152", with: "\"encrypted_end\":0152"),
      normal.replacingOccurrences(of: "\"encrypted_end\":152", with: "\"encrypted_end\":152.0"),
      normal.replacingOccurrences(of: ",\"gap_ns\":null", with: ""),
      normal.replacingOccurrences(
        of: ",\"gap_ns\":null",
        with: ",\"gap_ns\":null,\"gap_ns\":null"
      ),
      normal.replacingOccurrences(of: "{\"device_uid\"", with: "{\"unknown\":0,\"device_uid\""),
      normal.replacingOccurrences(
        of: "{\"device_uid\":\"AppleUSBAudioEngine:test\",\"discontinuity\":null",
        with: "{\"discontinuity\":null,\"device_uid\":\"AppleUSBAudioEngine:test\""
      ),
    ]

    for variant in variants {
      #expect(throws: (any Error).self) {
        try ArchiveIndexPayloadCodec.decode(Data(variant.utf8))
      }
    }
  }

  @Test func archive04RejectsInvalidStringsBase64AndDiscontinuities() throws {
    let escapedSlashPayload = try replacingNormal(
      "\"AppleUSBAudioEngine:test\"", with: "\"AppleUSBAudioEngine:\\/test\"")
    #expect(throws: (any Error).self) {
      try ArchiveIndexPayloadCodec.decode(escapedSlashPayload)
    }

    let unpaddedTag = try replacingNormal(
      "XAuMXHiRQKPJAfDZDPv1XA==", with: "XAuMXHiRQKPJAfDZDPv1XA")
    #expect(throws: ArchiveIndexPayloadError.invalidBase64Tag) {
      try ArchiveIndexPayloadCodec.decode(unpaddedTag)
    }
    let shortTag = try replacingNormal("XAuMXHiRQKPJAfDZDPv1XA==", with: "AA==")
    #expect(throws: ArchiveIndexPayloadError.invalidTapeTagLength(1)) {
      try ArchiveIndexPayloadCodec.decode(shortTag)
    }
    let unknown = try replacingNormal(
      "\"discontinuity\":null",
      with: "\"discontinuity\":\"unknown\""
    )
    #expect(throws: ArchiveIndexPayloadError.unknownDiscontinuity("unknown")) {
      try ArchiveIndexPayloadCodec.decode(unknown)
    }

    var invalidUTF8 = normalVector
    let deviceStart = try #require(invalidUTF8.range(of: Data("Apple".utf8))?.lowerBound)
    invalidUTF8[deviceStart] = 0xFF
    #expect(throws: (any Error).self) {
      try ArchiveIndexPayloadCodec.decode(invalidUTF8)
    }
  }

  @Test func archive04RejectsIntegerOverflowAndWrongJSONTypes() throws {
    let overflow = try replacingNormal("\"tape_seq\":1", with: "\"tape_seq\":18446744073709551616")
    #expect(throws: ArchiveIndexPayloadError.integerOverflow(field: "tape_seq")) {
      try ArchiveIndexPayloadCodec.decode(overflow)
    }
    for replacement in ["-1", "true", "\"1\""] {
      let invalid = try replacingNormal("\"tape_seq\":1", with: "\"tape_seq\":\(replacement)")
      #expect(throws: (any Error).self) {
        try ArchiveIndexPayloadCodec.decode(invalid)
      }
    }
  }

  @Test func archive04RejectsInvalidFieldAndNullableGroupBoundaries() throws {
    #expect(throws: ArchiveIndexPayloadError.invalidTapeSequence(0)) {
      try payload(tapeSequence: 0)
    }
    #expect(throws: ArchiveIndexPayloadError.invalidTapeTagLength(15)) {
      try payload(tapeTag: Data(repeating: 0, count: 15))
    }
    #expect(throws: ArchiveIndexPayloadError.invalidEncryptedEnd(0)) {
      try payload(encryptedEnd: 0)
    }
    #expect(throws: ArchiveIndexPayloadError.invalidSampleRange(start: 4, end: 4)) {
      try payload(sampleStart: 4, sampleEnd: 4)
    }
    #expect(throws: ArchiveIndexPayloadError.invalidDeviceUID) {
      try payload(deviceUID: "")
    }
    #expect(throws: ArchiveIndexPayloadError.invalidDeviceUID) {
      try payload(deviceUID: String(repeating: "e", count: 257))
    }
    #expect(throws: ArchiveIndexPayloadError.invalidRMS(32_768)) {
      try payload(rmsQ15: 32_768)
    }
    #expect(throws: ArchiveIndexPayloadError.incompleteNativeRate) {
      try payload(nativeFrames: nil)
    }
    #expect(throws: ArchiveIndexPayloadError.invalidInputRate) {
      try payload(inputRateDenominator: 0)
    }
    #expect(throws: ArchiveIndexPayloadError.invalidDiscontinuityMetrics) {
      try payload(reason: "unexpected")
    }
  }

  @Test func archive04RejectsIncompleteRecoveredMetadata() throws {
    #expect(throws: ArchiveIndexPayloadError.invalidRecoveredFields) {
      try recovered(monoNS: 1)
    }
    #expect(throws: ArchiveIndexPayloadError.invalidRecoveredFields) {
      try recovered(reason: nil)
    }
    #expect(throws: ArchiveIndexPayloadError.invalidRecoveredFields) {
      try recovered(previousDurableSample: nil)
    }
    #expect(throws: ArchiveIndexPayloadError.invalidRecoveredFields) {
      try recovered(previousDurableSample: 5)
    }
    #expect(throws: ArchiveIndexPayloadError.invalidRecoveredFields) {
      try recovered(survivingTailBytes: 0)
    }
  }

  @Test func archive04AllowsDeferredMetricsForEveryOtherDiscontinuity() throws {
    for discontinuity in ArchiveIndexDiscontinuity.allCases
    where discontinuity != .crashRecoveredUnindexed {
      let payload = try ArchiveIndexPayload(
        tapeSequence: 1,
        tapeTag: firstTag,
        encryptedEnd: 152,
        sampleStart: 0,
        sampleEnd: 4,
        monoNS: nil,
        wallNS: 0,
        deviceUID: "AppleUSBAudioEngine:test",
        rmsQ15: nil,
        nativeFrames: 0,
        inputRateNumerator: 0,
        inputRateDenominator: 1,
        discontinuity: discontinuity,
        reason: "",
        gapNS: 0,
        previousDurableSample: 1,
        survivingTailBytes: 0
      )
      let encoded = try ArchiveIndexPayloadCodec.encode(payload)
      #expect(try ArchiveIndexPayloadCodec.decode(encoded) == payload)
    }
  }

  @Test func archive04EnforcesTheExactCanonicalPayloadLimitBeforeEncoding() throws {
    let base = try discontinuityPayload(reason: "")
    let baseCount = try ArchiveIndexPayloadCodec.encode(base).count
    let maximum = Int(ArchiveRecordPurpose.index.maximumPlaintextByteCount)
    let exactReason = String(repeating: "e", count: maximum - baseCount)
    let exact = try discontinuityPayload(reason: exactReason)
    #expect(try ArchiveIndexPayloadCodec.encode(exact).count == maximum)

    #expect(throws: ArchiveIndexPayloadError.payloadTooLarge(maximum + 1)) {
      try discontinuityPayload(reason: exactReason + "e")
    }
  }

  private var normalVector: Data {
    Data(
      """
      {"device_uid":"AppleUSBAudioEngine:test","discontinuity":null,"encrypted_end":152,"gap_ns":null,"input_rate_den":1,"input_rate_num":48000,"mono_ns":1000000000,"native_frames":12,"previous_durable_sample":null,"reason":null,"rms_q15":8192,"sample_end":4,"sample_start":0,"surviving_tail_bytes":null,"tape_seq":1,"tape_tag_b64":"XAuMXHiRQKPJAfDZDPv1XA==","wall_ns":2000000000}
      """.utf8
    )
  }

  private var recoveredVector: Data {
    Data(
      """
      {"device_uid":"AppleUSBAudioEngine:test","discontinuity":"crash_recovered_unindexed","encrypted_end":300,"gap_ns":null,"input_rate_den":null,"input_rate_num":null,"mono_ns":null,"native_frames":null,"previous_durable_sample":4,"reason":"crash_recovered_unindexed","rms_q15":null,"sample_end":6,"sample_start":4,"surviving_tail_bytes":148,"tape_seq":2,"tape_tag_b64":"UaaDX6Oh3gBaWoXW2IzrYA==","wall_ns":null}
      """.utf8
    )
  }

  private func normalPayload() throws -> ArchiveIndexPayload {
    try payload()
  }

  private func recoveredPayload() throws -> ArchiveIndexPayload {
    try recovered()
  }

  private func payload(
    tapeSequence: UInt64 = 1,
    tapeTag: Data? = nil,
    encryptedEnd: UInt64 = 152,
    sampleStart: UInt64 = 0,
    sampleEnd: UInt64 = 4,
    deviceUID: String = "AppleUSBAudioEngine:test",
    rmsQ15: UInt16? = 8_192,
    nativeFrames: UInt64? = 12,
    inputRateNumerator: UInt64? = 48_000,
    inputRateDenominator: UInt64? = 1,
    reason: String? = nil
  ) throws -> ArchiveIndexPayload {
    try ArchiveIndexPayload(
      tapeSequence: tapeSequence,
      tapeTag: tapeTag ?? firstTag,
      encryptedEnd: encryptedEnd,
      sampleStart: sampleStart,
      sampleEnd: sampleEnd,
      monoNS: 1_000_000_000,
      wallNS: 2_000_000_000,
      deviceUID: deviceUID,
      rmsQ15: rmsQ15,
      nativeFrames: nativeFrames,
      inputRateNumerator: inputRateNumerator,
      inputRateDenominator: inputRateDenominator,
      discontinuity: nil,
      reason: reason,
      gapNS: nil,
      previousDurableSample: nil,
      survivingTailBytes: nil
    )
  }

  private func recovered(
    monoNS: UInt64? = nil,
    reason: String? = ArchiveIndexDiscontinuity.crashRecoveredUnindexed.rawValue,
    previousDurableSample: UInt64? = 4,
    survivingTailBytes: UInt64? = 148
  ) throws -> ArchiveIndexPayload {
    try ArchiveIndexPayload(
      tapeSequence: 2,
      tapeTag: secondTag,
      encryptedEnd: 300,
      sampleStart: 4,
      sampleEnd: 6,
      monoNS: monoNS,
      wallNS: nil,
      deviceUID: "AppleUSBAudioEngine:test",
      rmsQ15: nil,
      nativeFrames: nil,
      inputRateNumerator: nil,
      inputRateDenominator: nil,
      discontinuity: .crashRecoveredUnindexed,
      reason: reason,
      gapNS: nil,
      previousDurableSample: previousDurableSample,
      survivingTailBytes: survivingTailBytes
    )
  }

  private func discontinuityPayload(reason: String) throws -> ArchiveIndexPayload {
    try ArchiveIndexPayload(
      tapeSequence: 1,
      tapeTag: firstTag,
      encryptedEnd: 152,
      sampleStart: 0,
      sampleEnd: 4,
      monoNS: nil,
      wallNS: nil,
      deviceUID: "AppleUSBAudioEngine:test",
      rmsQ15: nil,
      nativeFrames: nil,
      inputRateNumerator: nil,
      inputRateDenominator: nil,
      discontinuity: .restart,
      reason: reason,
      gapNS: nil,
      previousDurableSample: nil,
      survivingTailBytes: nil
    )
  }

  private func replacingNormal(_ target: String, with replacement: String) throws -> Data {
    let normal = try #require(String(data: normalVector, encoding: .utf8))
    let replaced = normal.replacingOccurrences(of: target, with: replacement)
    try #require(replaced != normal)
    return Data(replaced.utf8)
  }
}

private func indexSHA256(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func indexHex(_ hex: String) -> Data {
  precondition(hex.count.isMultiple(of: 2))
  var result = Data()
  var index = hex.startIndex
  while index < hex.endIndex {
    let next = hex.index(index, offsetBy: 2)
    result.append(UInt8(hex[index..<next], radix: 16)!)
    index = next
  }
  return result
}
