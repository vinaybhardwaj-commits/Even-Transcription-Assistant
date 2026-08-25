import Foundation
import Testing

@testable import TapeCore

@Suite struct WAVExporterTests {
  @Test func writesCanonicalHeaderAndUnchangedPCM() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let wavURL = directory.appendingPathComponent("tape.wav")
    let pcm = Data([0x00, 0x80, 0xFF, 0x7F, 0x01, 0x00])
    try pcm.write(to: pcmURL)
    try Data(repeating: 0xFF, count: 100).write(to: wavURL)

    try WAVExporter.export(pcmURL: pcmURL, wavURL: wavURL)

    let wav = try Data(contentsOf: wavURL)
    #expect(wav.count == 44 + pcm.count)
    #expect(String(decoding: wav[0..<4], as: UTF8.self) == "RIFF")
    #expect(String(decoding: wav[8..<12], as: UTF8.self) == "WAVE")
    #expect(String(decoding: wav[36..<40], as: UTF8.self) == "data")
    #expect(Array(wav[44...]) == Array(pcm))
    #expect(readUInt32LE(wav, at: 24) == 16_000)
    #expect(readUInt32LE(wav, at: 28) == 32_000)
    #expect(readUInt32LE(wav, at: 40) == UInt32(pcm.count))
  }

  @Test func rejectsOddPCM() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    try Data([1]).write(to: pcmURL)

    #expect(throws: TapeError.oddPCMSize(1)) {
      try WAVExporter.export(pcmURL: pcmURL, wavURL: directory.appendingPathComponent("x.wav"))
    }
  }

  @Test func rejectsIndexDestinationAndAlias() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let indexURL = directory.appendingPathComponent("tape.idx")
    let aliasURL = directory.appendingPathComponent("index-alias")
    try Data([0, 0]).write(to: pcmURL)
    try Data("index\n".utf8).write(to: indexURL)

    #expect(throws: TapeError.io("WAV destination resolves to tape.idx")) {
      try WAVExporter.export(pcmURL: pcmURL, wavURL: indexURL)
    }
    try FileManager.default.linkItem(at: indexURL, to: aliasURL)
    #expect(throws: TapeError.io("WAV destination resolves to tape.idx")) {
      try WAVExporter.export(pcmURL: pcmURL, wavURL: aliasURL)
    }
    #expect(try Data(contentsOf: indexURL) == Data("index\n".utf8))
  }
}

private func readUInt32LE(_ data: Data, at offset: Int) -> UInt32 {
  UInt32(data[offset])
    | UInt32(data[offset + 1]) << 8
    | UInt32(data[offset + 2]) << 16
    | UInt32(data[offset + 3]) << 24
}
