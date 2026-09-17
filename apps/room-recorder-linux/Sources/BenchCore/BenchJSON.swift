import Foundation

/// A JSON value as the Bench sends it. Decoded in the Mac's order (`BenchClient.swift` `JSONValue`): null, Bool, number,
/// string, array, object — Bool BEFORE number, so `true` is never read as 1.
public indirect enum BenchJSON: Codable, Equatable, Sendable {
    case object([String: BenchJSON])
    case array([BenchJSON])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() {
            self = .null
        } else if let decoded = try? value.decode(Bool.self) {
            self = .bool(decoded)
        } else if let decoded = try? value.decode(Double.self) {
            self = .number(decoded)
        } else if let decoded = try? value.decode(String.self) {
            self = .string(decoded)
        } else if let decoded = try? value.decode([BenchJSON].self) {
            self = .array(decoded)
        } else {
            self = .object(try value.decode([String: BenchJSON].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let object): try value.encode(object)
        case .array(let array): try value.encode(array)
        case .string(let string): try value.encode(string)
        case .number(let number): try value.encode(number)
        case .bool(let bool): try value.encode(bool)
        case .null: try value.encodeNil()
        }
    }
}
