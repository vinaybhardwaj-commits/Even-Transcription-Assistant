import Foundation
import Testing

@testable import TapeCore

@Suite struct ArchiveCanonicalJSONTests {
  @Test func stringEscapingSlashAndUnicodeAreExact() throws {
    let value = "\"\\/\u{0000}\n\u{001f}e\u{0301}éक😀"
    var encoded = Data()
    ArchiveCanonicalJSON.appendString(value, to: &encoded)
    let expected = Data(#""\"\\/\u0000\u000a\u001fééक😀""#.utf8)
    #expect(encoded == expected)
    var slash = Data()
    ArchiveCanonicalJSON.appendString("/", to: &slash)
    #expect(slash == Data(#""/""#.utf8))

    var parser = ArchiveCanonicalJSONParser(encoded)
    #expect(try parser.string() == value)
    try parser.expectEnd()
  }

  @Test func malformedEscapesControlsAndUTF8AreRejected() {
    let malformed: [Data] = [
      Data(#""\/""#.utf8),
      Data(#""\u000A""#.utf8),
      Data(#""\u001F""#.utf8),
      Data(#""\ud800""#.utf8),
      Data([0x22, 0x0A, 0x22]),
      Data([0x22, 0xC3, 0x28, 0x22]),
      Data([0x22, 0x5C, 0x22]),
    ]
    for data in malformed {
      #expect(throws: ArchiveCanonicalJSONError.self) {
        var parser = ArchiveCanonicalJSONParser(data)
        _ = try parser.string()
        try parser.expectEnd()
      }
    }
  }

  @Test func integerCanonicalFormAndOverflowAreStrict() throws {
    var maximum = ArchiveCanonicalJSONParser(Data(String(UInt64.max).utf8))
    #expect(try maximum.integer(field: "value") == UInt64.max)
    try maximum.expectEnd()

    for data in ["00", "01", "-1", "1.0", "1e2", "18446744073709551616"] {
      #expect(throws: ArchiveCanonicalJSONError.self) {
        var parser = ArchiveCanonicalJSONParser(Data(data.utf8))
        _ = try parser.integer(field: "value")
        try parser.expectEnd()
      }
    }
  }
}
