import Foundation

enum ArchiveCanonicalJSONError: Error, Equatable {
  case integerOverflow(field: String)
  case invalidSyntax(offset: Int)
}

enum ArchiveCanonicalJSON {
  static func appendInteger(_ value: UInt64, to result: inout Data) {
    result.append(contentsOf: String(value).utf8)
  }

  static func appendOptionalInteger(_ value: UInt64?, to result: inout Data) {
    if let value {
      appendInteger(value, to: &result)
    } else {
      result.append(contentsOf: "null".utf8)
    }
  }

  static func appendString(_ value: String, to result: inout Data) {
    let hexadecimal = Array("0123456789abcdef".utf8)
    result.append(0x22)
    for scalar in value.unicodeScalars {
      switch scalar.value {
      case 0x22:
        result.append(contentsOf: #"\""#.utf8)
      case 0x5C:
        result.append(contentsOf: #"\\"#.utf8)
      case 0...0x1F:
        result.append(contentsOf: #"\u00"#.utf8)
        result.append(hexadecimal[Int(scalar.value >> 4)])
        result.append(hexadecimal[Int(scalar.value & 0x0F)])
      default:
        result.append(contentsOf: String(scalar).utf8)
      }
    }
    result.append(0x22)
  }

  static func appendOptionalString(_ value: String?, to result: inout Data) {
    if let value {
      appendString(value, to: &result)
    } else {
      result.append(contentsOf: "null".utf8)
    }
  }
}

struct ArchiveCanonicalJSONParser {
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
      throw ArchiveCanonicalJSONError.invalidSyntax(offset: offset)
    }
    offset += expected.count
  }

  mutating func expectEnd() throws {
    guard offset == bytes.count else {
      throw ArchiveCanonicalJSONError.invalidSyntax(offset: offset)
    }
  }

  mutating func consume(_ literal: String) -> Bool {
    guard hasPrefix(literal) else { return false }
    offset += literal.utf8.count
    return true
  }

  mutating func integer(field: String) throws -> UInt64 {
    let start = offset
    guard offset < bytes.count, (0x30...0x39).contains(bytes[offset]) else {
      throw ArchiveCanonicalJSONError.invalidSyntax(offset: offset)
    }
    if bytes[offset] == 0x30 {
      offset += 1
      if offset < bytes.count, (0x30...0x39).contains(bytes[offset]) {
        throw ArchiveCanonicalJSONError.invalidSyntax(offset: offset)
      }
      return 0
    }
    var value: UInt64 = 0
    while offset < bytes.count, (0x30...0x39).contains(bytes[offset]) {
      let multiplied = value.multipliedReportingOverflow(by: 10)
      let added = multiplied.partialValue.addingReportingOverflow(UInt64(bytes[offset] - 0x30))
      guard !multiplied.overflow, !added.overflow else {
        throw ArchiveCanonicalJSONError.integerOverflow(field: field)
      }
      value = added.partialValue
      offset += 1
    }
    guard offset > start else {
      throw ArchiveCanonicalJSONError.invalidSyntax(offset: offset)
    }
    return value
  }

  mutating func optionalInteger(field: String) throws -> UInt64? {
    if hasPrefix("null") {
      try expect("null")
      return nil
    }
    return try integer(field: field)
  }

  mutating func string() throws -> String {
    guard offset < bytes.count, bytes[offset] == 0x22 else {
      throw ArchiveCanonicalJSONError.invalidSyntax(offset: offset)
    }
    offset += 1
    var decoded = Data()
    while offset < bytes.count {
      let byte = bytes[offset]
      offset += 1
      if byte == 0x22 {
        guard let result = String(data: decoded, encoding: .utf8) else {
          throw ArchiveCanonicalJSONError.invalidSyntax(offset: offset - 1)
        }
        return result
      }
      if byte == 0x5C {
        guard offset < bytes.count else {
          throw ArchiveCanonicalJSONError.invalidSyntax(offset: offset)
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
          throw ArchiveCanonicalJSONError.invalidSyntax(offset: offset - 1)
        }
        decoded.append(high * 16 + low)
        offset += 4
        continue
      }
      guard byte >= 0x20 else {
        throw ArchiveCanonicalJSONError.invalidSyntax(offset: offset - 1)
      }
      decoded.append(byte)
    }
    throw ArchiveCanonicalJSONError.invalidSyntax(offset: offset)
  }

  mutating func optionalString() throws -> String? {
    if hasPrefix("null") {
      try expect("null")
      return nil
    }
    return try string()
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
