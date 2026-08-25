import Foundation
import Testing

@testable import TapeCore

@Suite struct IndexLogTests {
  @Test func ignoresAndRepairsTrailingPartialRecord() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("tape.idx")
    let record = IndexRecord(
      byteOffset: 64_000,
      samples: 32_000,
      monoNS: 2_000_000_000,
      wallNS: 10,
      device: "fixture",
      rms: 0.25
    )
    var bytes = try IndexLog.encodedLine(record)
    bytes.append(contentsOf: Data("{\"byte_offset\":".utf8))
    try bytes.write(to: url)

    let result = try IndexLog.read(url: url, pcmSize: 64_000, repairTrailingPartial: true)

    #expect(result.records == [record])
    #expect(result.discardedTrailingBytes == 15)
    #expect(try Data(contentsOf: url) == IndexLog.encodedLine(record))
  }

  @Test func rejectsMalformedCommittedInteriorRecord() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("tape.idx")
    var data = try IndexLog.encodedLine(
      .init(
        byteOffset: 0,
        samples: 0,
        monoNS: 1,
        wallNS: 1,
        device: "fixture",
        rms: 0
      ))
    data.append(contentsOf: Data("not-json\n".utf8))
    try data.write(to: url)

    do {
      _ = try IndexLog.read(url: url)
      Issue.record("expected malformed index failure")
    } catch TapeError.malformedIndex(line: 2, _) {
      // Expected.
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test func rejectsOffsetBeyondPCM() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("tape.idx")
    try IndexLog.encodedLine(
      .init(
        byteOffset: 20,
        samples: 10,
        monoNS: 1,
        wallNS: 1,
        device: "fixture",
        rms: 0
      )
    ).write(to: url)

    do {
      _ = try IndexLog.read(url: url, pcmSize: 18)
      Issue.record("expected out-of-range index failure")
    } catch TapeError.indexBeyondPCM(line: 1, offset: 20, pcmSize: 18) {
      // Expected.
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test func rejectsInconsistentRestartTail() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("tape.idx")
    var data = try IndexLog.encodedLine(
      .init(
        byteOffset: 64_000,
        samples: 32_000,
        monoNS: 1,
        wallNS: 1,
        device: "fixture",
        rms: 0
      ))
    data.append(
      try IndexLog.encodedLine(
        .init(
          byteOffset: 96_000,
          samples: 48_000,
          monoNS: 2,
          wallNS: 2,
          device: "fixture",
          discontinuity: "restart",
          previousByteOffset: 64_000,
          survivingTailBytes: 1
        )))
    try data.write(to: url)

    #expect(
      throws: TapeError.invalidIndex(
        line: 2,
        detail: "restart tail fields do not match the preceding durable offset"
      )
    ) {
      try IndexLog.read(url: url, pcmSize: 96_000)
    }
  }
}

func temporaryDirectory() throws -> URL {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent(
    UUID().uuidString, isDirectory: true)
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}
