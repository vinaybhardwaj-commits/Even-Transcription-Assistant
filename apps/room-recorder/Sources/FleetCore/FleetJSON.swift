import Foundation

/// JSON as the control plane means it: integers only, keys of the form `[a-z_][a-z0-9_]*`, and a
/// canonical writer that matches the server's `JSON.stringify(sortKeys(x))` (lib/steward/tickets.ts,
/// PRD §5.3). A float anywhere is a parse error here, because the signature could not be reproduced.
public indirect enum FleetJSON: Equatable, Sendable {
  case null
  case bool(Bool)
  case int(Int64)
  case string(String)
  case array([FleetJSON])
  case object([String: FleetJSON])

  public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
  public var intValue: Int64? { if case .int(let i) = self { return i }; return nil }
  public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
  public var objectValue: [String: FleetJSON]? { if case .object(let o) = self { return o }; return nil }
  public var arrayValue: [FleetJSON]? { if case .array(let a) = self { return a }; return nil }

  // MARK: - Canonical writer

  /// Keys sorted bytewise at every depth, no whitespace, UTF-8, strings escaped as `JSON.stringify` does.
  public var canonical: String {
    switch self {
    case .null: return "null"
    case .bool(let b): return b ? "true" : "false"
    case .int(let i): return String(i)
    case .string(let s): return Self.quote(s)
    case .array(let a): return "[" + a.map(\.canonical).joined(separator: ",") + "]"
    case .object(let o):
      let keys = o.keys.sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }
      return "{" + keys.map { Self.quote($0) + ":" + o[$0]!.canonical }.joined(separator: ",") + "}"
    }
  }

  public var canonicalData: Data { Data(canonical.utf8) }

  /// `JSON.stringify` string escaping: `"` `\` and C0 controls only. `/`, DEL and non-ASCII stay literal.
  static func quote(_ text: String) -> String {
    var out = "\""
    for scalar in text.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\u{08}": out += "\\b"
      case "\u{0C}": out += "\\f"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if scalar.value < 0x20 {
          out += String(format: "\\u%04x", scalar.value)
        } else {
          out.unicodeScalars.append(scalar)
        }
      }
    }
    return out + "\""
  }

  // MARK: - Strict parser

  public static let maxDepth = 8
  /// Integers outside the range a JS number holds exactly would not round-trip through the server.
  static let maxSafeInt: Int64 = 9_007_199_254_740_991

  public static func parse(_ data: Data) throws -> FleetJSON {
    var parser = Parser(bytes: Array(data))
    let value = try parser.value(depth: 0)
    parser.skipSpace()
    guard parser.index == parser.bytes.count else { throw FleetError.badJSON }
    return value
  }

  /// Every object key, at every depth, matches `[a-z_][a-z0-9_]*`.
  public var keysCanonical: Bool {
    switch self {
    case .array(let a): return a.allSatisfy(\.keysCanonical)
    case .object(let o): return o.allSatisfy { Self.keyIsCanonical($0.key) && $0.value.keysCanonical }
    default: return true
    }
  }

  static func keyIsCanonical(_ key: String) -> Bool {
    guard let first = key.utf8.first, !key.isEmpty else { return false }
    func lower(_ b: UInt8) -> Bool { b >= 97 && b <= 122 }
    guard lower(first) || first == 95 else { return false }
    return key.utf8.allSatisfy { lower($0) || $0 == 95 || ($0 >= 48 && $0 <= 57) }
  }

  private struct Parser {
    let bytes: [UInt8]
    var index = 0

    mutating func skipSpace() {
      while index < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[index]) { index += 1 }
    }

    mutating func value(depth: Int) throws -> FleetJSON {
      guard depth <= FleetJSON.maxDepth else { throw FleetError.badJSON }
      skipSpace()
      guard index < bytes.count else { throw FleetError.badJSON }
      switch bytes[index] {
      case UInt8(ascii: "{"): return try object(depth: depth)
      case UInt8(ascii: "["): return try array(depth: depth)
      case UInt8(ascii: "\""): return .string(try string())
      case UInt8(ascii: "t"): try literal("true"); return .bool(true)
      case UInt8(ascii: "f"): try literal("false"); return .bool(false)
      case UInt8(ascii: "n"): try literal("null"); return .null
      default: return try number()
      }
    }

    mutating func literal(_ word: String) throws {
      let w = Array(word.utf8)
      guard index + w.count <= bytes.count, Array(bytes[index..<index + w.count]) == w else {
        throw FleetError.badJSON
      }
      index += w.count
    }

    mutating func number() throws -> FleetJSON {
      let start = index
      if index < bytes.count, bytes[index] == UInt8(ascii: "-") { index += 1 }
      let digitsStart = index
      while index < bytes.count, bytes[index] >= 48, bytes[index] <= 57 { index += 1 }
      guard index > digitsStart else { throw FleetError.badJSON }
      // No leading zeros, and no fraction or exponent: a float cannot be signed reproducibly.
      if bytes[digitsStart] == 48, index - digitsStart > 1 { throw FleetError.badJSON }
      if index < bytes.count, [UInt8(ascii: "."), UInt8(ascii: "e"), UInt8(ascii: "E")].contains(bytes[index]) {
        throw FleetError.badJSON
      }
      guard let n = Int64(String(decoding: bytes[start..<index], as: UTF8.self)),
        abs(n) <= FleetJSON.maxSafeInt
      else { throw FleetError.badJSON }
      return .int(n)
    }

    mutating func string() throws -> String {
      index += 1  // opening quote
      var scalars = String.UnicodeScalarView()
      var raw: [UInt8] = []
      func flush() throws {
        guard !raw.isEmpty else { return }
        guard let text = String(validatingUTF8: raw.map { CChar(bitPattern: $0) } + [0]) else {
          throw FleetError.badJSON
        }
        scalars.append(contentsOf: text.unicodeScalars)
        raw.removeAll()
      }
      while index < bytes.count {
        let b = bytes[index]
        if b == UInt8(ascii: "\"") {
          try flush()
          index += 1
          return String(scalars)
        }
        if b < 0x20 { throw FleetError.badJSON }
        if b != UInt8(ascii: "\\") {
          raw.append(b)
          index += 1
          continue
        }
        try flush()
        index += 1
        guard index < bytes.count else { throw FleetError.badJSON }
        let e = bytes[index]
        index += 1
        switch e {
        case UInt8(ascii: "\""): scalars.append("\"")
        case UInt8(ascii: "\\"): scalars.append("\\")
        case UInt8(ascii: "/"): scalars.append("/")
        case UInt8(ascii: "b"): scalars.append("\u{08}")
        case UInt8(ascii: "f"): scalars.append("\u{0C}")
        case UInt8(ascii: "n"): scalars.append("\n")
        case UInt8(ascii: "r"): scalars.append("\r")
        case UInt8(ascii: "t"): scalars.append("\t")
        case UInt8(ascii: "u"):
          let high = try hex4()
          if (0xD800...0xDBFF).contains(high) {
            // A pair, or nothing: a lone surrogate is refused (Postgres text refuses it too).
            guard index + 1 < bytes.count, bytes[index] == UInt8(ascii: "\\"), bytes[index + 1] == UInt8(ascii: "u")
            else { throw FleetError.badJSON }
            index += 2
            let low = try hex4()
            guard (0xDC00...0xDFFF).contains(low),
              let scalar = Unicode.Scalar(0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00))
            else { throw FleetError.badJSON }
            scalars.append(scalar)
          } else {
            guard !(0xDC00...0xDFFF).contains(high), let scalar = Unicode.Scalar(high) else {
              throw FleetError.badJSON
            }
            scalars.append(scalar)
          }
        default: throw FleetError.badJSON
        }
      }
      throw FleetError.badJSON
    }

    mutating func hex4() throws -> UInt32 {
      guard index + 4 <= bytes.count,
        let value = UInt32(String(decoding: bytes[index..<index + 4], as: UTF8.self), radix: 16)
      else { throw FleetError.badJSON }
      index += 4
      return value
    }

    mutating func array(depth: Int) throws -> FleetJSON {
      index += 1
      var items: [FleetJSON] = []
      skipSpace()
      if index < bytes.count, bytes[index] == UInt8(ascii: "]") { index += 1; return .array(items) }
      while true {
        items.append(try value(depth: depth + 1))
        skipSpace()
        guard index < bytes.count else { throw FleetError.badJSON }
        if bytes[index] == UInt8(ascii: ",") { index += 1; continue }
        if bytes[index] == UInt8(ascii: "]") { index += 1; return .array(items) }
        throw FleetError.badJSON
      }
    }

    mutating func object(depth: Int) throws -> FleetJSON {
      index += 1
      var members: [String: FleetJSON] = [:]
      skipSpace()
      if index < bytes.count, bytes[index] == UInt8(ascii: "}") { index += 1; return .object(members) }
      while true {
        skipSpace()
        guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else { throw FleetError.badJSON }
        let key = try string()
        guard members[key] == nil else { throw FleetError.badJSON }  // duplicate key
        skipSpace()
        guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else { throw FleetError.badJSON }
        index += 1
        members[key] = try value(depth: depth + 1)
        skipSpace()
        guard index < bytes.count else { throw FleetError.badJSON }
        if bytes[index] == UInt8(ascii: ",") { index += 1; continue }
        if bytes[index] == UInt8(ascii: "}") { index += 1; return .object(members) }
        throw FleetError.badJSON
      }
    }
  }
}
