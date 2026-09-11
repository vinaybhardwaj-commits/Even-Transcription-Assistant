import Foundation
import Testing

@testable import TapeCore

@Suite struct IndexLogTests {
  @Test func verifierRejectsMissingAndEmptyIndexWithoutMutatingFixtures() throws {
    for emptyIndex in [false, true] {
      let directory = try temporaryDirectory()
      defer { try? FileManager.default.removeItem(at: directory) }
      let pcmURL = directory.appendingPathComponent("tape.pcm")
      let indexURL = directory.appendingPathComponent("tape.idx")
      let pcm = Data((0..<64).map(UInt8.init))
      try pcm.write(to: pcmURL)
      if emptyIndex {
        try Data().write(to: indexURL)
      }

      let pcmBefore = try Data(contentsOf: pcmURL)
      let indexBefore = emptyIndex ? try Data(contentsOf: indexURL) : nil
      do {
        _ = try TapeVerifier.verify(directory: directory)
        Issue.record("expected \(emptyIndex ? "empty" : "missing") index integrity failure")
      } catch let error as TapeError {
        #expect(error == (emptyIndex ? .emptyIndex : .missingFile("tape.idx")))
        #expect(error.errorDescription?.isEmpty == false)
      } catch {
        Issue.record("unexpected error: \(error)")
      }

      #expect(try Data(contentsOf: pcmURL) == pcmBefore)
      #expect(FileManager.default.fileExists(atPath: indexURL.path) == emptyIndex)
      if let indexBefore {
        #expect(try Data(contentsOf: indexURL) == indexBefore)
      }
    }
  }

  @Test func rejectsCommittedRecordShapeMatrixAtExactLine() throws {
    let valid =
      #"{"byte_offset":0,"samples":0,"mono_ns":1,"wall_ns":1,"device":"fixture","rms":0,"input_frames":0,"input_sample_rate":48000}"#
    let fixtures = [
      RawIndexFailure(
        "omitted byte_offset", 1, .invalid,
        #"{"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0}"#),
      RawIndexFailure(
        "omitted samples", 2, .invalid,
        #"{"byte_offset":2,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0}"#),
      RawIndexFailure(
        "omitted mono_ns", 1, .malformed,
        #"{"byte_offset":2,"samples":1,"wall_ns":2,"device":"fixture","rms":0}"#),
      RawIndexFailure(
        "omitted wall_ns", 2, .malformed,
        #"{"byte_offset":2,"samples":1,"mono_ns":2,"device":"fixture","rms":0}"#),
      RawIndexFailure(
        "omitted device", 1, .invalid,
        #"{"byte_offset":2,"samples":1,"mono_ns":2,"wall_ns":2,"rms":0}"#),
      RawIndexFailure(
        "neither byte_offset nor samples", 2, .invalid,
        #"{"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0}"#),
      RawIndexFailure(
        "byte_offset without samples", 1, .invalid,
        #"{"byte_offset":2,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0}"#),
      RawIndexFailure(
        "samples without byte_offset", 2, .invalid,
        #"{"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0}"#),
      RawIndexFailure(
        "input_frames without input_sample_rate", 1, .invalid,
        #"{"byte_offset":2,"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0,"input_frames":1}"#
      ),
      RawIndexFailure(
        "input_sample_rate without input_frames", 2, .invalid,
        #"{"byte_offset":2,"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0,"input_sample_rate":48000}"#
      ),
      RawIndexFailure(
        "empty device", 1, .invalid,
        #"{"byte_offset":2,"samples":1,"mono_ns":2,"wall_ns":2,"device":"","rms":0}"#),
      RawIndexFailure(
        "empty discontinuity", 2, .invalid,
        #"{"byte_offset":2,"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","discontinuity":""}"#
      ),
      RawIndexFailure(
        "checkpoint without rms", 1, .invalid,
        #"{"byte_offset":2,"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture"}"#),
      RawIndexFailure(
        "rms below zero", 2, .invalid,
        #"{"byte_offset":2,"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":-0.0001}"#),
      RawIndexFailure(
        "rms above one", 1, .invalid,
        #"{"byte_offset":2,"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":1.0001}"#),
      RawIndexFailure(
        "negative byte_offset", 2, .invalid,
        #"{"byte_offset":-2,"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0}"#),
      RawIndexFailure(
        "negative samples", 1, .invalid,
        #"{"byte_offset":2,"samples":-1,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0}"#),
      RawIndexFailure(
        "negative input_frames", 2, .invalid,
        #"{"byte_offset":2,"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0,"input_frames":-1,"input_sample_rate":48000}"#
      ),
      RawIndexFailure(
        "zero input_sample_rate", 1, .invalid,
        #"{"byte_offset":2,"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0,"input_frames":1,"input_sample_rate":0}"#
      ),
      RawIndexFailure(
        "negative input_sample_rate", 2, .invalid,
        #"{"byte_offset":2,"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0,"input_frames":1,"input_sample_rate":-48000}"#
      ),
      RawIndexFailure(
        "malformed input_sample_rate", 1, .malformed,
        #"{"byte_offset":2,"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0,"input_frames":1,"input_sample_rate":"fast"}"#
      ),
      RawIndexFailure(
        "non-finite input_sample_rate", 2, .malformed,
        #"{"byte_offset":2,"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0,"input_frames":1,"input_sample_rate":1e999}"#
      ),
    ]

    for fixture in fixtures {
      let lines = fixture.line == 1 ? [fixture.json] : [valid, fixture.json]
      try expectRawIndexFailure(fixture, data: committedJSONL(lines))
    }
  }

  @Test func handlesInt64ArithmeticLimitsWithoutOverflow() throws {
    let safeSamples = Int64.max / TapeConstants.bytesPerSample
    let safeOffset = safeSamples * TapeConstants.bytesPerSample
    let validLimit =
      "{\"byte_offset\":\(safeOffset),\"samples\":\(safeSamples),\"mono_ns\":1,\"wall_ns\":1,\"device\":\"fixture\",\"rms\":0}"
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("tape.idx")
    try committedJSONL([validLimit]).write(to: url)

    let read = try IndexLog.read(url: url)
    #expect(read.records.count == 1)
    #expect(read.records[0].byteOffset == safeOffset)
    #expect(read.records[0].samples == safeSamples)

    let failures = [
      RawIndexFailure(
        "Int64.min byte_offset", 1, .invalid,
        "{\"byte_offset\":\(Int64.min),\"samples\":0,\"mono_ns\":1,\"wall_ns\":1,\"device\":\"fixture\",\"rms\":0}"
      ),
      RawIndexFailure(
        "Int64.max byte_offset", 1, .invalid,
        "{\"byte_offset\":\(Int64.max),\"samples\":\(safeSamples),\"mono_ns\":1,\"wall_ns\":1,\"device\":\"fixture\",\"rms\":0}"
      ),
      RawIndexFailure(
        "Int64.min samples", 1, .invalid,
        "{\"byte_offset\":0,\"samples\":\(Int64.min),\"mono_ns\":1,\"wall_ns\":1,\"device\":\"fixture\",\"rms\":0}"
      ),
      RawIndexFailure(
        "Int64.max samples", 1, .invalid,
        "{\"byte_offset\":\(Int64.max),\"samples\":\(Int64.max),\"mono_ns\":1,\"wall_ns\":1,\"device\":\"fixture\",\"rms\":0}"
      ),
      RawIndexFailure(
        "one sample above safe multiplication", 1, .invalid,
        "{\"byte_offset\":\(Int64.max),\"samples\":\(safeSamples + 1),\"mono_ns\":1,\"wall_ns\":1,\"device\":\"fixture\",\"rms\":0}"
      ),
    ]
    for failure in failures {
      try expectRawIndexFailure(failure, data: committedJSONL([failure.json]))
    }
  }

  @Test func handlesExtremeConverterArithmeticThroughParserAndVerifier() throws {
    let tinyRateLines = [
      #"{"byte_offset":0,"samples":0,"mono_ns":1,"wall_ns":1,"device":"fixture","rms":0,"input_frames":0,"input_sample_rate":5e-324}"#,
      "{\"byte_offset\":2,\"samples\":1,\"mono_ns\":2,\"wall_ns\":2,\"device\":\"fixture\",\"rms\":0,\"input_frames\":\(Int64.max),\"input_sample_rate\":5e-324}",
    ]
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("tape.idx")
    try committedJSONL(tinyRateLines).write(to: url)
    let records = try IndexLog.read(url: url, pcmSize: 2).records

    #expect(
      throws: TapeError.invalidIndex(
        line: 2, detail: "converter sample accounting is out of range")
    ) {
      try TapeVerifier.verify(pcmSize: 2, records: records)
    }

  }

  @Test func rejectsByteSampleAndInputRegressionsIndependently() throws {
    let baseline =
      #"{"byte_offset":4,"samples":2,"mono_ns":1,"wall_ns":1,"device":"fixture","rms":0,"input_frames":10,"input_sample_rate":48000}"#
    let failures = [
      RawIndexFailure(
        "byte_offset consistency", 2, .invalid,
        #"{"byte_offset":2,"samples":2,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0,"input_frames":11,"input_sample_rate":48000}"#,
        "byte_offset must equal samples * 2"
      ),
      RawIndexFailure(
        "sample consistency", 2, .invalid,
        #"{"byte_offset":4,"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0,"input_frames":11,"input_sample_rate":48000}"#,
        "byte_offset must equal samples * 2"
      ),
      RawIndexFailure(
        "paired byte and sample regression", 2, .invalid,
        #"{"byte_offset":2,"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0,"input_frames":11,"input_sample_rate":48000}"#,
        "offset or sample count regressed"
      ),
      RawIndexFailure(
        "input_frames only", 2, .invalid,
        #"{"byte_offset":6,"samples":3,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0,"input_frames":9,"input_sample_rate":48000}"#,
        "input_frames regressed without a discontinuity"
      ),
      RawIndexFailure(
        "global byte and sample clocks across format_change", 2, .invalid,
        #"{"byte_offset":2,"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","discontinuity":"format_change"}"#,
        "offset or sample count regressed"
      ),
      RawIndexFailure(
        "global byte and sample clocks across lower-monotonic restart", 2, .invalid,
        #"{"byte_offset":2,"samples":1,"mono_ns":0,"wall_ns":2,"device":"fixture","discontinuity":"restart","previous_byte_offset":4,"surviving_tail_bytes":0}"#,
        "offset or sample count regressed"
      ),
    ]

    for failure in failures {
      try expectRawIndexFailure(failure, data: committedJSONL([baseline, failure.json]))
    }
  }

  @Test func acceptsSegmentLocalInputResetWithGloballyMonotonicTapePositions() throws {
    let lines = [
      #"{"byte_offset":0,"samples":0,"mono_ns":1,"wall_ns":1,"device":"fixture","rms":0,"input_frames":48000,"input_sample_rate":48000}"#,
      #"{"byte_offset":32000,"samples":16000,"mono_ns":1000000001,"wall_ns":1000000001,"device":"fixture","rms":0,"input_frames":96000,"input_sample_rate":48000}"#,
      #"{"byte_offset":32000,"samples":16000,"mono_ns":1000000002,"wall_ns":1000000002,"device":"fixture","discontinuity":"format_change"}"#,
      #"{"byte_offset":32000,"samples":16000,"mono_ns":1000000003,"wall_ns":1000000003,"device":"fixture","rms":0,"input_frames":0,"input_sample_rate":44100}"#,
      #"{"byte_offset":64000,"samples":32000,"mono_ns":2000000003,"wall_ns":2000000003,"device":"fixture","rms":0,"input_frames":44100,"input_sample_rate":44100}"#,
    ]
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("tape.idx")
    try committedJSONL(lines).write(to: url)

    let records = try IndexLog.read(url: url, pcmSize: 64_000).records
    let report = try TapeVerifier.verify(pcmSize: 64_000, records: records)
    #expect(records.map(\.byteOffset) == [0, 32_000, 32_000, 32_000, 64_000])
    #expect(records.map(\.samples) == [0, 16_000, 16_000, 16_000, 32_000])
    #expect(report.discontinuities.map(\.kind) == ["format_change"])
    #expect(report.nativeDriftRecords.map(\.index) == [1, 2, 4, 5])
    #expect(report.passed)
  }

  @Test func enforcesMarkedInputRateTransitions() throws {
    let sameRate = [
      #"{"byte_offset":0,"samples":0,"mono_ns":1,"wall_ns":1,"device":"fixture","rms":0,"input_frames":0,"input_sample_rate":48000}"#,
      #"{"byte_offset":32000,"samples":16000,"mono_ns":1000000001,"wall_ns":1000000001,"device":"fixture","rms":0,"input_frames":48000,"input_sample_rate":48000}"#,
    ]
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("tape.idx")
    try committedJSONL(sameRate).write(to: url)
    #expect(try IndexLog.read(url: url, pcmSize: 32_000).records.count == 2)

    let unmarked = RawIndexFailure(
      "unmarked input rate transition", 2, .invalid,
      #"{"byte_offset":32000,"samples":16000,"mono_ns":1000000001,"wall_ns":1000000001,"device":"fixture","rms":0,"input_frames":44100,"input_sample_rate":44100}"#
    )
    try expectRawIndexFailure(unmarked, data: committedJSONL([sameRate[0], unmarked.json]))

    let marked = [
      sameRate[0],
      #"{"byte_offset":0,"samples":0,"mono_ns":2,"wall_ns":2,"device":"fixture","discontinuity":"format_change"}"#,
      #"{"byte_offset":0,"samples":0,"mono_ns":3,"wall_ns":3,"device":"fixture","rms":0,"input_frames":0,"input_sample_rate":44100}"#,
      #"{"byte_offset":32000,"samples":16000,"mono_ns":1000000003,"wall_ns":1000000003,"device":"fixture","rms":0,"input_frames":44100,"input_sample_rate":44100}"#,
    ]
    try committedJSONL(marked).write(to: url)
    let records = try IndexLog.read(url: url, pcmSize: 32_000).records
    #expect(records.map(\.inputSampleRate) == [48_000, nil, 44_100, 44_100])
  }

  @Test func preservesRestartChainAndRepairsOnlyTornFinalLine() throws {
    let committedLines = [
      #"{"byte_offset":100,"samples":50,"mono_ns":1,"wall_ns":1,"device":"fixture","rms":0}"#,
      #"{"byte_offset":120,"samples":60,"mono_ns":2,"wall_ns":2,"device":"fixture","discontinuity":"restart","previous_byte_offset":100,"surviving_tail_bytes":20}"#,
      #"{"byte_offset":140,"samples":70,"mono_ns":3,"wall_ns":3,"device":"fixture","rms":0}"#,
      #"{"byte_offset":140,"samples":70,"mono_ns":4,"wall_ns":4,"device":"fixture","discontinuity":"restart","previous_byte_offset":140,"surviving_tail_bytes":0}"#,
      #"{"byte_offset":160,"samples":80,"mono_ns":5,"wall_ns":5,"device":"fixture","rms":0}"#,
      #"{"byte_offset":170,"samples":85,"mono_ns":6,"wall_ns":6,"device":"fixture","discontinuity":"restart","previous_byte_offset":160,"surviving_tail_bytes":10}"#,
      #"{"byte_offset":180,"samples":90,"mono_ns":7,"wall_ns":7,"device":"fixture","rms":0}"#,
    ]
    let tornSuffix = #"{"byte_offset":200,"samples"#
    let committed = committedJSONL(committedLines)
    var fixture = committed
    fixture.append(Data(tornSuffix.utf8))
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("tape.idx")
    try fixture.write(to: url)

    let inspected = try IndexLog.read(url: url, pcmSize: 180, repairTrailingPartial: false)
    #expect(inspected.records.count == committedLines.count)
    #expect(inspected.discardedTrailingBytes == tornSuffix.utf8.count)
    #expect(try Data(contentsOf: url) == fixture)
    let restarts = inspected.records.filter { $0.discontinuity == "restart" }
    #expect(restarts.map(\.previousByteOffset) == [100, 140, 160])
    #expect(restarts.map(\.survivingTailBytes) == [20, 0, 10])

    let report = try TapeVerifier.verify(
      pcmSize: 180,
      records: inspected.records,
      discardedTrailingIndexBytes: inspected.discardedTrailingBytes
    )
    #expect(report.currentTailBytes == 0)
    #expect(report.worstTailBytes == 20)
    #expect(report.discardedTrailingIndexBytes == tornSuffix.utf8.count)

    let repaired = try IndexLog.read(url: url, pcmSize: 180, repairTrailingPartial: true)
    #expect(repaired.records == inspected.records)
    #expect(repaired.discardedTrailingBytes == tornSuffix.utf8.count)
    #expect(try Data(contentsOf: url) == committed)
  }

  @Test func acceptsRebootMonotonicResetWithoutCrossRebootFit() throws {
    let lines = [
      #"{"byte_offset":0,"samples":0,"mono_ns":10000000000,"wall_ns":1000000000,"device":"fixture","rms":0}"#,
      #"{"byte_offset":32000,"samples":16000,"mono_ns":11000000000,"wall_ns":2000000000,"device":"fixture","rms":0}"#,
      #"{"byte_offset":32000,"samples":16000,"mono_ns":100,"wall_ns":3000000000,"device":"fixture","discontinuity":"restart","previous_byte_offset":32000,"surviving_tail_bytes":0}"#,
      #"{"byte_offset":32000,"samples":16000,"mono_ns":200,"wall_ns":3000000100,"device":"fixture","rms":0}"#,
      #"{"byte_offset":64000,"samples":32000,"mono_ns":1000000200,"wall_ns":4000000100,"device":"fixture","rms":0}"#,
    ]
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let indexURL = directory.appendingPathComponent("tape.idx")
    try Data(repeating: 0, count: 64_000).write(to: pcmURL)
    try committedJSONL(lines).write(to: indexURL)

    let parsed = try IndexLog.read(url: indexURL, pcmSize: 64_000).records
    #expect(parsed[2].monoNS < parsed[1].monoNS)
    let report = try TapeVerifier.verify(directory: directory)
    #expect(report.discontinuities.map(\.kind) == ["restart"])
    #expect(report.driftRecords.map(\.index) == [1, 2, 4, 5])
    #expect(report.driftRecords.allSatisfy { abs($0.driftMS) < 0.000_1 })
    #expect(abs(try #require(report.fittedPPM)) < 0.001)
    #expect(abs(try #require(report.largestCheckpointGapSeconds) - 1) < 0.000_1)
    #expect(abs(try #require(report.largestDurableRecordGapSeconds) - 1) < 0.000_1)
    #expect(report.passed)
  }

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

  // MARK: - Release B2 (D7): `peak` and `zero_ratio` beside `rms`

  @Test func aCheckpointWrittenBefore020WithoutPeakOrZeroRatioStillDecodes() throws {
    // Every tape on every clinic Mac today was written by 0.1.19 or earlier, and 0.1.20 has to
    // read them: after an update, a room resumes onto the index its previous version wrote.
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("tape.idx")
    try committedJSONL([
      #"{"byte_offset":0,"device":"fixture","input_frames":0,"input_sample_rate":48000,"mono_ns":1,"rms":0.25,"samples":0,"wall_ns":1}"#
    ]).write(to: url)

    let record = try #require(IndexLog.read(url: url).records.first)
    #expect(record.rms == 0.25)
    #expect(record.peak == nil)
    #expect(record.zeroRatio == nil)
  }

  @Test func aCheckpointWithPeakAndZeroRatioRoundTrips() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("tape.idx")
    let line =
      #"{"byte_offset":32000,"device":"fixture","mono_ns":1,"peak":0.5,"rms":0.25,"samples":16000,"wall_ns":1,"zero_ratio":0.4576}"#
    try committedJSONL([line]).write(to: url)

    let record = try #require(IndexLog.read(url: url).records.first)
    #expect(record.peak == 0.5)
    #expect(record.zeroRatio == 0.4576)
    // The writer's own encoding gives back the same bytes, keys named exactly as the poll names
    // them, so nothing between tapewriter and the card renames a field.
    #expect(try IndexLog.encodedLine(record) == Data((line + "\n").utf8))
  }

  @Test func peakOrZeroRatioOutsideZeroToOneIsRejectedTheWayRmsIs() throws {
    let base = #"{"byte_offset":2,"samples":1,"mono_ns":2,"wall_ns":2,"device":"fixture","rms":0"#
    for (name, extra) in [
      ("peak below zero", #","peak":-0.0001"#),
      ("peak above one", #","peak":1.0001"#),
      ("zero_ratio below zero", #","zero_ratio":-0.0001"#),
      ("zero_ratio above one", #","zero_ratio":1.0001"#),
    ] {
      try expectRawIndexFailure(
        RawIndexFailure(name, 1, .invalid, base + extra + "}"),
        data: committedJSONL([base + extra + "}"]))
    }
  }
}

private enum RawIndexFailureKind {
  case malformed
  case invalid
}

private struct RawIndexFailure {
  let name: String
  let line: Int
  let kind: RawIndexFailureKind
  let json: String
  let detail: String?

  init(
    _ name: String,
    _ line: Int,
    _ kind: RawIndexFailureKind,
    _ json: String,
    _ detail: String? = nil
  ) {
    self.name = name
    self.line = line
    self.kind = kind
    self.json = json
    self.detail = detail
  }
}

private func committedJSONL(_ lines: [String]) -> Data {
  Data((lines.joined(separator: "\n") + "\n").utf8)
}

private func expectRawIndexFailure(_ fixture: RawIndexFailure, data: Data) throws {
  let directory = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: directory) }
  let url = directory.appendingPathComponent("tape.idx")
  try data.write(to: url)

  do {
    _ = try IndexLog.read(url: url)
    Issue.record("\(fixture.name): expected committed index failure")
  } catch TapeError.malformedIndex(let line, let detail) {
    #expect(fixture.kind == .malformed)
    #expect(line == fixture.line)
    if let expected = fixture.detail { #expect(detail == expected) }
  } catch TapeError.invalidIndex(let line, let detail) {
    #expect(fixture.kind == .invalid)
    #expect(line == fixture.line)
    if let expected = fixture.detail { #expect(detail == expected) }
  } catch {
    Issue.record("\(fixture.name): unexpected error: \(error)")
  }
}

func temporaryDirectory() throws -> URL {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent(
    UUID().uuidString, isDirectory: true)
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}
