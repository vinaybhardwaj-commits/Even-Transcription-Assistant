import Foundation
import Testing

@testable import RoomRecorderCore

/// 0.1.25 item 1 — `tape_advancing` follows `tape.pcm`, not `tape.idx`.
@Suite struct TapeGrowthProbeTests {
  private func scratch() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(
      "tgp-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  private func append(_ bytes: Int, to url: URL) throws {
    if !FileManager.default.fileExists(atPath: url.path) {
      FileManager.default.createFile(atPath: url.path, contents: nil)
    }
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    try handle.seekToEnd()
    try handle.write(contentsOf: Data(count: bytes))
  }

  @Test func firstReadingIsFalseThenGrowthIsTrueThenAFlatFileIsFalse() throws {
    let pcm = try scratch().appendingPathComponent("tape.pcm")
    try append(1000, to: pcm)
    var probe = TapeGrowthProbe()
    #expect(probe.advanced(pcm: pcm) == false)
    try append(500, to: pcm)
    #expect(probe.advanced(pcm: pcm) == true)
    #expect(probe.advanced(pcm: pcm) == false)
  }

  /// The defect: the index did not move (a lagging checkpoint, a repeated marker record) while
  /// audio kept landing in tape.pcm. The old reading said false; this one must say true.
  @Test func pcmGrowingWithAnIndexThatDoesNotMoveIsAdvancing() throws {
    let dir = try scratch()
    let pcm = dir.appendingPathComponent("tape.pcm")
    let idx = dir.appendingPathComponent("tape.idx")
    try append(10, to: idx)
    try append(1000, to: pcm)
    var probe = TapeGrowthProbe()
    _ = probe.advanced(pcm: pcm)
    try append(96_000, to: pcm)  // idx untouched
    #expect(probe.advanced(pcm: pcm) == true)
  }

  /// And the converse: an index that grows (marker records) with a flat pcm is NOT advancing.
  @Test func indexGrowingWithAFlatPcmIsNotAdvancing() throws {
    let dir = try scratch()
    let pcm = dir.appendingPathComponent("tape.pcm")
    let idx = dir.appendingPathComponent("tape.idx")
    try append(1000, to: pcm)
    try append(10, to: idx)
    var probe = TapeGrowthProbe()
    _ = probe.advanced(pcm: pcm)
    try append(400, to: idx)
    #expect(probe.advanced(pcm: pcm) == false)
  }

  @Test func aDifferentFileStartsAgainAndAMissingFileForgets() throws {
    let dir = try scratch()
    let a = dir.appendingPathComponent("a.pcm")
    let b = dir.appendingPathComponent("b.pcm")
    try append(100, to: a)
    try append(5_000, to: b)
    var probe = TapeGrowthProbe()
    _ = probe.advanced(pcm: a)
    #expect(probe.advanced(pcm: b) == false)  // larger, but a different file
    try append(1, to: b)
    #expect(probe.advanced(pcm: b) == true)
    #expect(probe.advanced(pcm: nil) == false)
    #expect(probe.advanced(pcm: b) == false)  // forgot: first reading again
    try FileManager.default.removeItem(at: b)
    #expect(probe.advanced(pcm: b) == false)
  }
}
