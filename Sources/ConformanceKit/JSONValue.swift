import Foundation

/// A schema-agnostic JSON value. C2 round-trips index lines through this so the
/// suite never has to name index fields it does not know, while still exercising
/// the platform JSONEncoder (swift-foundation on Linux) on every byte.
public enum JSONValue: Codable, Equatable, Sendable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case int(Int64)
    case double(Double)
    case bool(Bool)
    case null

    struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ s: String) { stringValue = s }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    public init(from decoder: Decoder) throws {
        if let c = try? decoder.container(keyedBy: Key.self) {
            var d: [String: JSONValue] = [:]
            for k in c.allKeys { d[k.stringValue] = try c.decode(JSONValue.self, forKey: k) }
            self = .object(d)
            return
        }
        if var c = try? decoder.unkeyedContainer() {
            var a: [JSONValue] = []
            while !c.isAtEnd { a.append(try c.decode(JSONValue.self)) }
            self = .array(a)
            return
        }
        let s = try decoder.singleValueContainer()
        if s.decodeNil() { self = .null; return }
        if let i = try? s.decode(Int64.self) { self = .int(i); return }
        if let v = try? s.decode(Double.self) { self = .double(v); return }
        if let b = try? s.decode(Bool.self) { self = .bool(b); return }
        self = .string(try s.decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .object(let d):
            var c = encoder.container(keyedBy: Key.self)
            for (k, v) in d { try c.encode(v, forKey: Key(k)) }
        case .array(let a):
            var c = encoder.unkeyedContainer()
            for v in a { try c.encode(v) }
        case .string(let v):
            var c = encoder.singleValueContainer(); try c.encode(v)
        case .int(let v):
            var c = encoder.singleValueContainer(); try c.encode(v)
        case .double(let v):
            var c = encoder.singleValueContainer(); try c.encode(v)
        case .bool(let v):
            var c = encoder.singleValueContainer(); try c.encode(v)
        case .null:
            var c = encoder.singleValueContainer(); try c.encodeNil()
        }
    }

    public var int64: Int64? {
        if case .int(let v) = self { return v }
        return nil
    }
}

/// The index line codec: sorted keys, no escaped slashes, no whitespace.
public enum IndexLineCodec {
    public static func makeEncoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }

    public static func decodeObject(_ line: [UInt8]) throws -> [String: JSONValue] {
        let v = try JSONDecoder().decode(JSONValue.self, from: Data(line))
        guard case .object(let o) = v else { throw IndexLogError.invalidRecord(line: 0, reason: "not a JSON object") }
        return o
    }

    public static func encodeObject(_ o: [String: JSONValue]) throws -> [UInt8] {
        [UInt8](try makeEncoder().encode(JSONValue.object(o)))
    }
}
