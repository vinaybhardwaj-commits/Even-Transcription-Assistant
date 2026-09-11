import Foundation
import Testing

@testable import RoomRecorderCore
@testable import TapeCapture
@testable import TapeCore

/// Release B2 — what the tape says about itself, measured in the writer and read in the app.
///
/// D7: true peak and the exact-zero ratio, beside rms, in every checkpoint. On 9 Sep OPD 3 was
/// 45.76 % bit-exact zero and nobody could see it: rms alone hides both a clipping input and a
/// dead one.
/// D8: `tape_advancing` compared an index file's byte length with a sample count.
/// D9: `currentLevels()` reparsed the whole index every 1.5 s, a cost that grows across a 7-hour day.
@Suite struct ReleaseB2TapeMeasurementTests {

  // MARK: - D7: the writer

  @Test func checkpointLevelsMeasureTruePeakAndTheExactZeroRatio() {
    var levels = CheckpointLevels()
    // Empty window: rms is 0 as it always was, and there is no peak or ratio to divide out — an
    // anchor checkpoint written before any audio carries neither key.
    #expect(levels.rms == 0)
    #expect(levels.peak == nil)
    #expect(levels.zeroRatio == nil)

    // Five of eight samples are exactly zero; the loudest is Int16.min, a full-scale negative.
    let first: [Int16] = [0, 0, 16_384, -32_768, 0, 8_192, 0, 0]
    first.withUnsafeBufferPointer { levels.add($0.baseAddress!, count: $0.count) }
    #expect(levels.peak == 1.0)
    #expect(levels.zeroRatio == 5.0 / 8.0)

    // The window keeps accumulating until the checkpoint resets it: 7 of 12 zero now.
    let second: [Int16] = [100, -16_384, 0, 0]
    second.withUnsafeBufferPointer { levels.add($0.baseAddress!, count: $0.count) }
    #expect(levels.peak == 1.0)
    #expect(levels.zeroRatio == 7.0 / 12.0)

    levels.reset()
    #expect(levels.peak == nil)
    #expect(levels.zeroRatio == nil)
    let third: [Int16] = [100, -16_384, 0, 0]
    third.withUnsafeBufferPointer { levels.add($0.baseAddress!, count: $0.count) }
    #expect(levels.peak == 0.5)
    #expect(levels.zeroRatio == 0.5)
    // RMS is computed exactly as before 0.1.20.
    let expectedRMS = sqrt(((100.0 / 32_768) * (100.0 / 32_768) + 0.25) / 4)
    #expect(levels.rms == expectedRMS)
  }

  @Test func aSilentCaptureWritesAnExactZeroRatioOfOneIntoTheIndex() throws {
    // End to end through the real writer: samples in, `tape.idx` out, read back through TapeCore.
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let frameCount = 8_192
    let ring = AudioRing(slotCount: 6, framesPerSlot: frameCount)
    let writer = TapeWriter(directory: directory, deviceUID: "b2-fixture", ring: ring)
    try writer.startAndWaitUntilReady()

    var samples = [Float](repeating: 0, count: frameCount)
    let durationNS = UInt64(Double(frameCount) / 16_000 * 1_000_000_000)
    let accepted = samples.withUnsafeMutableBufferPointer { buffer in
      var channel = buffer.baseAddress!
      return withUnsafePointer(to: &channel) { channels in
        ring.writeAudio(
          channels: channels, channelCount: 1, frameCount: frameCount, sampleRate: 16_000,
          monoStartNS: 1_000_000_000, monoEndNS: 1_000_000_000 + durationNS,
          wallStartNS: 11_000_000_000, wallEndNS: 11_000_000_000 + durationNS,
          boundaries: BoundaryBatch())
      }
    }
    try #require(accepted)
    try writer.stopAndWait()

    let records = try IndexLog.read(url: directory.appendingPathComponent("tape.idx")).records
    let measured = try #require(records.last { $0.discontinuity == nil && $0.zeroRatio != nil })
    #expect(measured.zeroRatio == 1)
    #expect(measured.peak == 0)
    #expect(measured.rms == 0)
    // The anchor checkpoint, written before any sample, has nothing to divide by and says so.
    let anchor = try #require(records.first { $0.discontinuity == nil })
    #expect(anchor.zeroRatio == nil)
    #expect(anchor.peak == nil)
  }

  // MARK: - D8: like with like

  @Test func theDurableSampleIndexIsCountedInSamplesOnBothSides() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("tape.idx")
    let tail = TapeIndexTail(url: url)

    // Poll 1: capture is running and nothing is durable yet, so the piece cursor stands in —
    // 480 000 samples, thirty seconds at 16 kHz, already cut into pieces.
    let previous = RoomEngine.durableSampleIndex(tail: tail, cursor: 480_000)

    // Poll 2: tapewriter has made two checkpoints durable, the second at 500 000 samples. The
    // file holding them is a few hundred BYTES long.
    try Self.lines([480_000, 500_000]).write(to: url)
    let size = try #require(
      (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value)
    #expect(size < 480_000, "the fixture has to be the mismatch: \(size) bytes")

    let current = RoomEngine.durableSampleIndex(tail: tail, cursor: 480_000)
    #expect(current == 500_000)
    // The tape moved. Compared the old way — `size` bytes against 480 000 samples — it did not.
    #expect(current > previous)
  }

  // MARK: - D9: the tail, not the whole

  @Test func theTapeIndexIsParsedOnceAndThenOnlyItsTail() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("tape.idx")
    let count = 500
    try Self.lines((0..<count).map { Int64($0) * 16_000 }).write(to: url)

    let tail = TapeIndexTail(url: url)
    tail.refresh()
    #expect(tail.decodedRecordCount == count)

    // Three more checkpoints, appended the way tapewriter appends them.
    try Self.append(Self.lines((count..<count + 3).map { Int64($0) * 16_000 }), to: url)
    tail.refresh()
    #expect(tail.decodedRecordCount == count + 3, "the whole index was parsed again")

    // Nothing new, nothing parsed.
    tail.refresh()
    #expect(tail.decodedRecordCount == count + 3)

    // THE SAME OUTPUT as the whole-file read `currentLevels()` used to do every 1.5 s.
    Self.expectSameAsWholeRead(tail, url: url)
  }

  @Test func aHalfWrittenLineWaitsForTheNextRead() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("tape.idx")
    try Self.lines([0, 16_000]).write(to: url)
    let tail = TapeIndexTail(url: url)
    tail.refresh()

    let next = Self.lines([32_000])
    try Self.append(next.prefix(next.count / 2), to: url)
    tail.refresh()
    #expect(tail.lastSamples == 16_000)
    #expect(tail.decodedRecordCount == 2)

    try Self.append(next.suffix(from: next.startIndex + next.count / 2), to: url)
    tail.refresh()
    #expect(tail.lastSamples == 32_000)
    #expect(tail.decodedRecordCount == 3)
    Self.expectSameAsWholeRead(tail, url: url)
  }

  @Test func aTruncatedReplacedOrRewrittenIndexIsReadAgainFromTheTop() throws {
    // The refuter's fourth question. An offset remembered from one file must never be applied
    // to another: each case below would hand back the old file's numbers if it were.
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("tape.idx")
    try Self.lines([0, 16_000, 32_000, 48_000, 64_000]).write(to: url)
    let tail = TapeIndexTail(url: url)
    tail.refresh()
    #expect(tail.lastSamples == 64_000)

    // Replaced: a new file at the same path (a new inode), shorter than the old one.
    try Self.lines([0, 8_000]).write(to: url, options: .atomic)
    tail.refresh()
    #expect(tail.lastSamples == 8_000)
    Self.expectSameAsWholeRead(tail, url: url)

    // Truncated in place.
    let first = Self.lines([0])
    let handle = try FileHandle(forWritingTo: url)
    try handle.truncate(atOffset: UInt64(first.count))
    try handle.close()
    tail.refresh()
    #expect(tail.lastSamples == 0)
    Self.expectSameAsWholeRead(tail, url: url)

    // Rewritten in place, same inode, and LONGER than what was already read — the case a size
    // check alone cannot see.
    try Self.lines([0, 4_000, 12_000]).write(to: url)
    tail.refresh()
    try Self.rewriteInPlace(url, with: Self.lines([0, 2_000, 6_000, 10_000]))
    tail.refresh()
    #expect(tail.lastSamples == 10_000)
    Self.expectSameAsWholeRead(tail, url: url)

    // Gone: nothing is reported rather than the last file's numbers.
    try FileManager.default.removeItem(at: url)
    tail.refresh()
    #expect(tail.lastSamples == nil)
    #expect(tail.lastRMS == nil)
  }

  // MARK: - Helpers

  /// Checkpoint lines at these sample positions, with rms, peak and zero ratio that differ per
  /// line so "the last one" is checkable.
  static func lines(_ samples: [Int64]) -> Data {
    var data = Data()
    for (index, position) in samples.enumerated() {
      let level = Double((index * 7) % 100) / 100
      // Force-try: every value here is valid, and a fixture that cannot encode is a broken test.
      data.append(
        try! IndexLog.encodedLine(
          IndexRecord(
            byteOffset: position * TapeConstants.bytesPerSample, samples: position,
            monoNS: UInt64(index + 1), wallNS: UInt64(index + 1), device: "fixture",
            rms: level, peak: min(1, level * 2), zeroRatio: 1 - level)))
    }
    return data
  }

  static func append(_ data: Data, to url: URL) throws {
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    try handle.seekToEnd()
    try handle.write(contentsOf: data)
  }

  /// Truncate to nothing and write `data` through the same descriptor: same inode, new bytes.
  static func rewriteInPlace(_ url: URL, with data: Data) throws {
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    try handle.truncate(atOffset: 0)
    try handle.write(contentsOf: data)
  }

  static func expectSameAsWholeRead(
    _ tail: TapeIndexTail, url: URL, sourceLocation: SourceLocation = #_sourceLocation
  ) {
    let whole = (try? IndexLog.read(url: url).records) ?? []
    #expect(tail.lastSamples == whole.last?.samples, sourceLocation: sourceLocation)
    #expect(
      tail.lastRMS == whole.reversed().compactMap(\.rms).first, sourceLocation: sourceLocation)
    #expect(
      tail.lastPeak == whole.reversed().compactMap(\.peak).first, sourceLocation: sourceLocation)
    #expect(
      tail.lastZeroRatio == whole.reversed().compactMap(\.zeroRatio).first,
      sourceLocation: sourceLocation)
  }
}
