import Darwin
import Foundation
import Testing

@testable import FleetCore
@testable import HelperCore
@testable import RoomRecorderCore
@testable import TapeCapture
@testable import TapeCore

/// Encounter Buddy, L2 (0.1.42): the runner, its chunk contract, the send gate and the display gate, and the D5 page.
///
/// Nothing here calls newcat. The transport, the tape and the clock are doubles; the real HTTP transport is tested
/// against a loopback server the test owns. The text used in fixtures carries a marker so a log scan can prove it never
/// reaches a log line.
@Suite(.serialized) struct BuddyL2Tests {

  // MARK: - Doubles

  /// Time that moves only when something sleeps or the test says so. `sleep` yields for real so other tasks run.
  final class FakeClock: BuddyRunnerClock, @unchecked Sendable {
    private let lock = NSLock()
    private var current: TimeInterval = 1_000
    private var slept: [TimeInterval] = []
    var now: TimeInterval { lock.withLock { current } }
    var sleeps: [TimeInterval] { lock.withLock { slept } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current += seconds } }
    func sleep(seconds: TimeInterval) async {
      lock.withLock { current += seconds; slept.append(seconds) }
      try? await Task.sleep(nanoseconds: 300_000)
    }
  }

  final class SpyWindow: BuddyRunnerWindowControlling, @unchecked Sendable {
    private let lock = NSLock()
    private var calls: [String] = []
    var all: [String] { lock.withLock { calls } }
    func setWindow(open: Bool, reason: String) { lock.withLock { calls.append(open ? "open" : "close") } }
  }

  /// The tape as the tap would show it: bytes that grow, under a segment id.
  final class FakeTape: BuddyPCMReading, @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = Data()
    private var segmentID = "seg_1"
    private var capture = true
    private var requested: [Int64] = []
    private var refusing = false
    init(initial: Data = Data()) { bytes = initial }
    func grow(_ data: Data) { lock.withLock { bytes.append(data) } }
    func growSeconds(_ seconds: Int, fill: UInt8 = 0x11) { grow(Data(repeating: fill, count: seconds * 32_000)) }
    func newCapture(_ id: String) { lock.withLock { segmentID = id; bytes = Data() } }
    func setCapture(_ on: Bool) { lock.withLock { capture = on } }
    func refuse() { lock.withLock { refusing = true } }
    var offsetsAsked: [Int64] { lock.withLock { requested } }
    var size: Int { lock.withLock { bytes.count } }
    func read(from: Int64, max: Int) async -> BuddyPCMRead {
      lock.withLock {
        requested.append(from)
        if refusing { return .refused(status: 403) }
        guard capture else { return .noCapture }
        let size = Int64(bytes.count) & ~Int64(1)
        guard from <= size else { return .pastEnd(size: size) }
        let count = Int(Swift.min(Int64(max) & ~Int64(1), size - from))
        return .bytes(Data(bytes[Int(from)..<Int(from) + count]), segment: segmentID, size: size)
      }
    }
  }

  /// A transport the test scripts. `chunkHandler` sees every chunk and the attempt number for that seq.
  final class ScriptedTransport: BuddyRunnerTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var tokenIssues = 0
    private var flagQueue: [BuddyFlagsResult] = []
    private var lastFlags: BuddyFlagsResult = .ok(BuddyFlags(window: false, live: true, reasonCode: "fleet_off"))
    private var sent: [BuddyChunk] = []
    private var attempts: [Int: Int] = [:]
    private var flagCalls = 0
    private var tokenOutcomes: [BuddyTokenResult] = []
    var chunkHandler: @Sendable (BuddyChunk, Int) async -> BuddyChunkReply = { chunk, _ in
      BuddyChunkReply(status: 200, seq: chunk.seq, text: "hello \(chunk.seq)", hasText: true)
    }
    init() {}
    func script(flags: [BuddyFlagsResult]) { lock.withLock { flagQueue = flags } }
    func setFlags(_ flags: BuddyFlags) { lock.withLock { flagQueue = []; lastFlags = .ok(flags) } }
    func script(tokens: [BuddyTokenResult]) { lock.withLock { tokenOutcomes = tokens } }
    var posted: [BuddyChunk] { lock.withLock { sent } }
    var flagPollCount: Int { lock.withLock { flagCalls } }
    var tokenIssueCount: Int { lock.withLock { tokenIssues } }
    func issueToken() async -> BuddyTokenResult {
      lock.withLock {
        tokenIssues += 1
        return tokenOutcomes.isEmpty ? .ok(token: "tok-SECRET-\(tokenIssues)", ttlSeconds: 900) : tokenOutcomes.removeFirst()
      }
    }
    func flags(token: String, opaqueID: String) async -> BuddyFlagsResult {
      lock.withLock {
        flagCalls += 1
        if !flagQueue.isEmpty { lastFlags = flagQueue.removeFirst() }
        return lastFlags
      }
    }
    func sendChunk(token: String, chunk: BuddyChunk) async -> BuddyChunkReply {
      let attempt: Int = lock.withLock {
        sent.append(chunk)
        attempts[chunk.seq, default: 0] += 1
        return attempts[chunk.seq]!
      }
      return await chunkHandler(chunk, attempt)
    }
  }

  /// Reads the real tap but answers the consult-start probe as an empty tape, so the runner reads a fixture tape that the
  /// burst tapewriter wrote in one go.
  struct FromStartReader: BuddyPCMReading {
    let base: BuddyTapReader
    func read(from: Int64, max: Int) async -> BuddyPCMRead {
      if from == 0, max == 2, case .bytes(_, let segment, _) = await base.read(from: 0, max: 2) {
        return .bytes(Data(), segment: segment, size: 0)
      }
      return await base.read(from: from, max: max)
    }
  }

  /// 14 s of a known non-zero ramp.
  static let fourteenSeconds: Data = {
    var data = Data()
    for index in 0..<224_000 {
      var sample = Int16(truncatingIfNeeded: (index * 37) % 20_000 - 10_000).littleEndian
      withUnsafeBytes(of: &sample) { data.append(contentsOf: $0) }
    }
    return data
  }()

  static let live = BuddyFlags(window: true, live: true, reasonCode: nil)
  static let shadow = BuddyFlags(window: false, live: true, reasonCode: "fleet_off")

  struct Harness {
    let runner: BuddyRunner
    let transport: ScriptedTransport
    let tape: FakeTape
    let window: SpyWindow
    let transcript: BuddyLiveTranscript
    let clock: FakeClock
    let logs: LockedList<String>
  }

  static func harness(flags: BuddyFlags = live, tape: FakeTape = FakeTape()) -> Harness {
    let clock = FakeClock()
    let transport = ScriptedTransport()
    transport.setFlags(flags)
    let window = SpyWindow()
    let transcript = BuddyLiveTranscript(opaqueID: "opq_l2", clock: { clock.now })
    let logs = LockedList<String>()
    let runner = BuddyRunner(
      opaqueID: "opq_l2", transport: transport, pcm: tape, window: window, transcript: transcript, clock: clock,
      log: { logs.append($0) })
    return Harness(runner: runner, transport: transport, tape: tape, window: window, transcript: transcript, clock: clock, logs: logs)
  }

  /// One probe tick (reads where the consult starts), then `seconds` of audio, then ticks until it is all cut and settled.
  static func feed(_ h: Harness, seconds: Int, fill: UInt8 = 0x11) async {
    await h.runner.tick()  // the consult's start: flags, token, the tape probe
    h.tape.growSeconds(seconds, fill: fill)
    for _ in 0..<(seconds / 12 + 3) {
      await h.runner.tick()
      await h.runner.settle()
    }
  }

  // MARK: - The chunk contract

  @Test func aChunkIsACanonicalWAVOfTwelveSecondsThatEndsAtItsDataChunk() throws {
    let pcm = Data((0..<384_000).map { UInt8(truncatingIfNeeded: $0 &* 7) })
    let wav = BuddyWAV.wrap(pcm: pcm)
    #expect(wav.count == 44 + 384_000, "nothing after the data chunk")
    func u32(_ at: Int) -> UInt32 { wav[at..<at + 4].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }.littleEndian }
    func u16(_ at: Int) -> UInt16 { wav[at..<at + 2].withUnsafeBytes { $0.loadUnaligned(as: UInt16.self) }.littleEndian }
    #expect(String(decoding: wav[0..<4], as: UTF8.self) == "RIFF" && String(decoding: wav[8..<12], as: UTF8.self) == "WAVE")
    #expect(u32(4) == 36 + 384_000 && u32(16) == 16 && u16(20) == 1, "PCM")
    #expect(u16(22) == 1 && u32(24) == 16_000 && u32(28) == 32_000 && u16(32) == 2 && u16(34) == 16, "16 kHz mono PCM16")
    #expect(String(decoding: wav[36..<40], as: UTF8.self) == "data" && u32(40) == 384_000)
    #expect(Data(wav[44...]) == pcm)
    #expect(Double(u32(40)) / Double(u32(28)) * 1000 == Double(BuddyRunner.chunkMilliseconds), "the header's own duration is 12 s")
  }

  @Test func chunksAreTwelveSecondsInOrderCutAtTheConsultStartAndNeverOverlap() async throws {
    let tape = FakeTape(initial: Data(repeating: 0x99, count: 5 * 32_000))  // five seconds BEFORE the consult
    let h = Self.harness(tape: tape)
    await Self.feed(h, seconds: 30, fill: 0x11)
    let posted = h.transport.posted
    #expect(posted.map(\.seq) == [0, 1], "30 s is two whole chunks; the 6 s left waits for its 12 s")
    #expect(posted.map(\.startMs) == [0, 12_000] && posted.allSatisfy { $0.durationMs == 12_000 && $0.opaqueID == "opq_l2" })
    for chunk in posted {
      #expect(chunk.wav.count == 44 + 384_000)
      #expect(chunk.wav[44...].allSatisfy { $0 == 0x11 }, "audio from before the consult is never read")
    }
    h.tape.growSeconds(6)
    await Self.feed(h, seconds: 0)
    #expect(h.transport.posted.map(\.seq) == [0, 1, 2])
  }

  @Test func theRealTransportSendsTheEnvelopeInHeadersAndTheWAVAsTheBody() async throws {
    let server = try FakeRunnerServer()
    defer { server.stop() }
    server.respond(path: "/runner/v1/token", status: 200, body: #"{"token":"brt-abc","expires_in":900}"#)
    server.respond(path: "/runner/v1/flags", status: 200, body: #"{"window":true,"live":true,"reason_code":null}"#)
    server.respond(path: "/runner/v1/chunks", status: 200, body: #"{"seq":4,"text":"hello"}"#)
    let config = BuddyRunnerConfig(base: URL(string: "http://127.0.0.1:\(server.port)")!, key: "consumer-key-1")
    let transport = BuddyHTTPTransport(config: config)

    #expect(await transport.issueToken() == .ok(token: "brt-abc", ttlSeconds: 900))
    #expect(await transport.flags(token: "brt-abc", opaqueID: "opq_l2") == .ok(BuddyFlags(window: true, live: true)))
    let wav = BuddyWAV.wrap(pcm: Data(repeating: 3, count: 640))
    let reply = await transport.sendChunk(
      token: "brt-abc", chunk: BuddyChunk(opaqueID: "opq_l2", seq: 4, startMs: 48_000, durationMs: 20, wav: wav))
    #expect(reply == BuddyChunkReply(status: 200, seq: 4, text: "hello", hasText: true))

    let requests = server.requests
    #expect(requests.map(\.line) == ["POST /runner/v1/token", "GET /runner/v1/flags?opaque_id=opq_l2", "POST /runner/v1/chunks"])
    #expect(requests[0].headers["authorization"] == "Bearer consumer-key-1")
    #expect(requests[1].headers["authorization"] == "Bearer brt-abc")
    let chunk = requests[2]
    #expect(chunk.headers["authorization"] == "Bearer brt-abc")
    #expect(chunk.headers["x-chunk-opaque-id"] == "opq_l2" && chunk.headers["x-chunk-seq"] == "4")
    #expect(chunk.headers["x-chunk-start-ms"] == "48000" && chunk.headers["x-chunk-duration-ms"] == "20")
    #expect(chunk.headers["content-type"] == "audio/wav" && chunk.body == wav, "the body is the WAV, byte for byte")
  }

  @Test func theRealTransportReadsRefusalCodesAndATextlessReply() async throws {
    let server = try FakeRunnerServer()
    defer { server.stop() }
    let transport = BuddyHTTPTransport(config: BuddyRunnerConfig(base: URL(string: "http://127.0.0.1:\(server.port)")!, key: "k"))
    let chunk = BuddyChunk(opaqueID: "opq_l2", seq: 0, startMs: 0, durationMs: 20, wav: BuddyWAV.wrap(pcm: Data(count: 640)))
    server.respond(path: "/runner/v1/chunks", status: 200, body: #"{"seq":0}"#)
    #expect(await transport.sendChunk(token: "t", chunk: chunk) == BuddyChunkReply(status: 200, seq: 0, text: nil, hasText: false))
    server.respond(path: "/runner/v1/chunks", status: 200, body: #"{"seq":0,"text":null}"#)
    #expect(await transport.sendChunk(token: "t", chunk: chunk).hasText == false, "a null text is no text")
    for (status, error) in [(403, "killed"), (409, "duplicate_seq"), (409, "busy"), (429, "allowance_exhausted"), (503, "usage_unavailable"), (502, "gateway_failed")] {
      // newcat's own shape (runner-listener fail()): error is an object with a type and a message.
      server.respond(
        path: "/runner/v1/chunks", status: status,
        body: "{\"trace_id\":\"x\",\"status\":\"failed\",\"error\":{\"type\":\"\(error)\",\"message\":\"words that are never read\"}}")
      #expect(await transport.sendChunk(token: "t", chunk: chunk) == BuddyChunkReply(status: status, error: error))
    }
    server.respond(path: "/runner/v1/chunks", status: 409, body: #"{"error":"busy"}"#)
    #expect(await transport.sendChunk(token: "t", chunk: chunk) == BuddyChunkReply(status: 409, error: "busy"), "a bare string is read too")
    server.respond(path: "/runner/v1/chunks", status: 302, body: "", headers: ["Location": "http://127.0.0.1:\(server.port)/elsewhere"])
    let redirected = await transport.sendChunk(token: "t", chunk: chunk)
    #expect(redirected.status == 302, "a redirect is not followed with the bearer")
    #expect(!server.requests.contains { $0.line.contains("/elsewhere") })
    server.stop()
    #expect(await transport.sendChunk(token: "t", chunk: chunk).status == 0, "no answer at all is status 0")
  }

  // MARK: - Stop codes, retries, one in flight

  struct StopCase: CustomTestStringConvertible, Sendable {
    var status: Int
    var error: String
    var closesWindow: Bool
    var testDescription: String { "\(status) \(error)" }
  }

  @Test(arguments: [
    StopCase(status: 403, error: "killed", closesWindow: true),
    StopCase(status: 409, error: "duplicate_seq", closesWindow: false),
    StopCase(status: 429, error: "allowance_exhausted", closesWindow: true),
    StopCase(status: 503, error: "usage_unavailable", closesWindow: false),
  ])
  func aStopCodeStopsTheConsultAndNoAudioIsEverSentAgain(_ stop: StopCase) async throws {
    let h = Self.harness()
    h.transport.chunkHandler = { _, _ in BuddyChunkReply(status: stop.status, error: stop.error) }
    await Self.feed(h, seconds: 14)
    #expect(h.transport.posted.count == 1, "one send, no retry of a stop code")
    #expect(await h.runner.isStopped)
    #expect(await h.runner.stats.stopStatus == stop.status)
    #expect(await h.runner.stats.ringBytes == 0, "the ring is dropped")
    let polls = h.transport.flagPollCount
    #expect(polls >= 2, "the flags are re-polled at a stop")
    // More audio, more ticks, more time: nothing goes out.
    await Self.feed(h, seconds: 60)
    h.clock.advance(120)
    await Self.feed(h, seconds: 30)
    #expect(h.transport.posted.count == 1, "after a stop, audio is never sent again")
    #expect(h.transcript.snapshot().state == .unavailable && h.transcript.snapshot().segments.isEmpty)
    #expect(h.transcript.snapshot().stale, "unavailable is shown with the stale indicator")
    #expect(h.window.all == (stop.closesWindow ? ["open", "close"] : ["open"]))
  }

  @Test(arguments: zip([502, 409], ["gateway_failed", "busy"]))
  func aRetryableAnswerIsRetriedAtMostTwiceWithBackoffThenBecomesAGap(_ status: Int, _ error: String) async throws {
    let h = Self.harness()
    h.transport.chunkHandler = { chunk, _ in
      chunk.seq == 0 ? BuddyChunkReply(status: status, error: error.isEmpty ? nil : error) : BuddyChunkReply(status: 200, seq: chunk.seq, text: "next", hasText: true)
    }
    await Self.feed(h, seconds: 26)
    let seq0 = h.transport.posted.filter { $0.seq == 0 }
    #expect(seq0.count == 3, "one send and two retries, never a third: \(seq0.count)")
    #expect(seq0.allSatisfy { $0.wav == seq0[0].wav }, "a retry carries the same audio")
    #expect(h.clock.sleeps.filter { $0 == 1 || $0 == 2 }.prefix(2).elementsEqual([1, 2]), "capped backoff 1 s then 2 s")
    #expect(await h.runner.stats.gaps == 1, "then a gap, and on")
    #expect(!(await h.runner.isStopped))
    #expect(h.transport.posted.contains { $0.seq == 1 }, "the next chunk goes")
    #expect(h.transcript.snapshot().segments.first?.gap == true)
  }

  @Test func noAnswerAtAllIsAGapAndNeverAResend() async throws {
    // A timeout may mean newcat still holds the chunk: a resend could be a duplicate, and the addendum retries only on
    // 502 and 409 busy.
    let h = Self.harness()
    h.transport.chunkHandler = { chunk, _ in
      chunk.seq == 0 ? BuddyChunkReply(status: 0) : BuddyChunkReply(status: 200, seq: chunk.seq, text: "next", hasText: true)
    }
    await Self.feed(h, seconds: 26)
    #expect(h.transport.posted.filter { $0.seq == 0 }.count == 1, "sent once, never resent")
    let stats = await h.runner.stats
    let stopped = await h.runner.isStopped
    #expect(stats.gaps == 1 && !stopped && h.transport.posted.contains { $0.seq == 1 })
    #expect(h.logs.all.contains { $0.contains("gap (no_answer)") })
  }

  @Test func theSixtySecondRuleCountsFromCaptureNotFromTheCut() async throws {
    let h = Self.harness()
    let release = Gate()
    h.transport.chunkHandler = { chunk, _ in
      if chunk.seq == 0 { await release.wait() }
      return BuddyChunkReply(status: 200, seq: chunk.seq, text: "t", hasText: true)
    }
    await h.runner.tick()
    h.tape.growSeconds(24)  // captured now
    await h.runner.tick()  // chunk 0 is cut and stalls; the other 12 s wait in the ring
    try await R4Fixture.waitUntil { h.transport.posted.count == 1 }  // chunk 0 is really in flight
    h.clock.advance(70)  // the stall goes on for 70 s
    release.open()
    await h.runner.settle()
    await h.runner.tick()  // the ring's 12 s are cut now, but they were captured 70 s ago
    await h.runner.settle()
    #expect(h.transport.posted.map(\.seq) == [0], "audio captured more than 60 s ago is never sent")
    let stats = await h.runner.stats
    #expect(stats.gaps == 1)
  }

  @Test func aHaltedRunnerCutsAndSendsNothingMore() async throws {
    let h = Self.harness()
    await h.runner.tick()
    h.runner.haltNow()  // synchronous, from outside the actor
    h.tape.growSeconds(40)
    for _ in 0..<4 { await h.runner.tick(); await h.runner.settle() }
    #expect(h.transport.posted.isEmpty)
  }

  @Test func aRetryThatSucceedsIsOneChunkAndNoGap() async throws {
    let h = Self.harness()
    h.transport.chunkHandler = { chunk, attempt in
      attempt < 3 ? BuddyChunkReply(status: 502, error: "gateway_failed") : BuddyChunkReply(status: 200, seq: chunk.seq, text: "ok", hasText: true)
    }
    await Self.feed(h, seconds: 14)
    let stats = await h.runner.stats
    #expect(h.transport.posted.count == 3 && stats.chunksOK == 1 && stats.gaps == 0)
  }

  @Test func otherAnswersAreAGapWithNoRetryAndTheConsultGoesOn() async throws {
    for status in [400, 404, 413, 500] {
      let h = Self.harness()
      h.transport.chunkHandler = { chunk, _ in
        chunk.seq == 0 ? BuddyChunkReply(status: status, error: "other") : BuddyChunkReply(status: 200, seq: chunk.seq, hasText: false)
      }
      await Self.feed(h, seconds: 26)
      #expect(h.transport.posted.filter { $0.seq == 0 }.count == 1, "\(status): not retried")
      let stats = await h.runner.stats
      let stopped = await h.runner.isStopped
      #expect(stats.gaps == 1 && !stopped, "\(status)")
      #expect(h.transport.posted.contains { $0.seq == 1 })
    }
  }

  @Test func neverTwoChunksInFlightAndTheNextSeqWaitsForAFinalAnswer() async throws {
    let h = Self.harness()
    let release = Gate()
    h.transport.chunkHandler = { chunk, _ in
      if chunk.seq == 0 { await release.wait() }
      return BuddyChunkReply(status: 200, seq: chunk.seq, text: "t\(chunk.seq)", hasText: true)
    }
    await h.runner.tick()
    h.tape.growSeconds(50)
    for _ in 0..<6 { await h.runner.tick() }
    #expect(h.transport.posted.map(\.seq) == [0], "seq 1 is not sent while seq 0 has no answer")
    release.open()
    await h.runner.settle()
    for _ in 0..<4 {
      await h.runner.tick()
      await h.runner.settle()
    }
    #expect(h.transport.posted.map(\.seq) == [0, 1, 2, 3])
    #expect(await h.runner.stats.maxInFlight == 1)
  }

  @Test func aStaleChunkIsNeverReplayedAfterSixtySeconds() async throws {
    let h = Self.harness()
    h.transport.chunkHandler = { [clock = h.clock] _, _ in
      clock.advance(61)  // the answer took 61 s to be a 502
      return BuddyChunkReply(status: 502, error: "gateway_failed")
    }
    await Self.feed(h, seconds: 14)
    #expect(h.transport.posted.count == 1, "older than 60 s: no second send")
    #expect(await h.runner.stats.gaps == 1)
  }

  @Test func anExpiredTokenIsReissuedOnceAndTheSameSeqIsResent() async throws {
    let h = Self.harness()
    h.transport.chunkHandler = { chunk, attempt in
      attempt == 1 ? BuddyChunkReply(status: 401) : BuddyChunkReply(status: 200, seq: chunk.seq, text: "ok", hasText: true)
    }
    await Self.feed(h, seconds: 14)
    #expect(h.transport.posted.count == 2 && h.transport.posted.allSatisfy { $0.seq == 0 })
    #expect(h.transport.tokenIssueCount == 2)
    // A second 401 is a gap, not a loop.
    let again = Self.harness()
    again.transport.chunkHandler = { _, _ in BuddyChunkReply(status: 401) }
    await Self.feed(again, seconds: 14)
    let againStats = await again.runner.stats
    #expect(again.transport.posted.count == 2 && againStats.gaps == 1)
  }

  @Test func noTokenMeansNoFlagsNoTapReadsNoPostsAndNoWindow() async throws {
    let h = Self.harness()
    h.transport.script(tokens: Array(repeating: .failed(status: 0), count: 6))
    await Self.feed(h, seconds: 30)
    #expect(h.transport.posted.isEmpty && h.transport.flagPollCount == 0 && h.tape.offsetsAsked.isEmpty && h.window.all.isEmpty)
  }

  // MARK: - The send gate and the display gate

  @Test func flagsOffMeansZeroChunkPostsAndNoTapReads() async throws {
    let h = Self.harness(flags: BuddyFlags(window: false, live: false, reasonCode: "fleet_off"))
    await Self.feed(h, seconds: 60)
    #expect(h.transport.posted.isEmpty, "live false: zero chunk POSTs")
    #expect(h.tape.offsetsAsked.isEmpty, "and the tape is not even read")
    let finished = await h.runner.isFinished
    #expect(finished && h.window.all.isEmpty)
    #expect(h.transcript.snapshot().state == .off)
    let polls = h.transport.flagPollCount
    h.clock.advance(300)
    await h.runner.tick()
    #expect(h.transport.flagPollCount == polls, "no more polls once live is false")
  }

  @Test func aShadowSessionSendsChunksAndOpensNoWindowAndStoresNoText() async throws {
    let h = Self.harness(flags: Self.shadow)
    h.transport.chunkHandler = { chunk, _ in BuddyChunkReply(status: 200, seq: chunk.seq, text: "SHOULD-NOT-BE-KEPT", hasText: true) }
    await Self.feed(h, seconds: 38)
    #expect(h.transport.posted.count >= 3, "live true, window false: chunks are sent")
    #expect(h.window.all.isEmpty, "and the window is never touched")
    #expect(h.transcript.snapshot().segments.isEmpty, "text is held only while a window exists")
  }

  @Test func aReplyWithoutTextIsNormalNoErrorNoRetryNothingRendered() async throws {
    let h = Self.harness(flags: Self.live)
    h.transport.chunkHandler = { chunk, _ in BuddyChunkReply(status: 200, seq: chunk.seq) }
    await Self.feed(h, seconds: 38)
    let posted = h.transport.posted
    #expect(posted.count >= 3 && Set(posted.map(\.seq)).count == posted.count, "every seq sent once: no retry")
    let stats = await h.runner.stats
    let stopped = await h.runner.isStopped
    #expect(stats.textless == posted.count && stats.gaps == 0 && !stopped)
    #expect(h.transcript.snapshot().segments.isEmpty && h.transcript.snapshot().state == .live)
    #expect(!h.logs.all.contains { $0.contains("error") || $0.contains("fail") })
  }

  @Test func aLiveSessionKeepsTheTextOfItsOwnChunksInOrder() async throws {
    let h = Self.harness(flags: Self.live)
    await Self.feed(h, seconds: 26)
    #expect(h.window.all == ["open"])
    #expect(h.transcript.snapshot().segments.map(\.text) == ["hello 0", "hello 1"])
    #expect(!h.transcript.snapshot().stale)
  }

  @Test func theFlagsAreRepolledEverySixtySecondsAndStopWhenLiveGoesFalse() async throws {
    let h = Self.harness(flags: Self.live)
    await h.runner.tick()
    #expect(h.transport.flagPollCount == 1)
    h.clock.advance(59)
    await h.runner.tick()
    #expect(h.transport.flagPollCount == 1, "not before 60 s")
    h.clock.advance(2)
    await h.runner.tick()
    #expect(h.transport.flagPollCount == 2)
    h.transport.setFlags(BuddyFlags(window: false, live: false, reasonCode: "kill"))
    h.clock.advance(61)
    await h.runner.tick()
    let finished = await h.runner.isFinished
    #expect(h.transport.flagPollCount == 3 && finished)
    #expect(h.window.all == ["open", "close"], "a kill closes the window")
    h.clock.advance(600)
    await h.runner.tick()
    #expect(h.transport.flagPollCount == 3, "stopped polling")
  }

  @Test func aFirstPollThatFailsIsRetriedSoonerThanSixtySeconds() async throws {
    let h = Self.harness()
    h.transport.script(flags: [.failed(status: 503), .ok(Self.live)])
    await h.runner.tick()
    #expect(h.window.all.isEmpty && h.transport.posted.isEmpty, "nothing shows until newcat has answered")
    h.clock.advance(10)
    await h.runner.tick()
    #expect(h.window.all == ["open"])
  }

  @Test func aWindowTrueUnderAKilledFleetIsABreachCountedAndKeptShutWhileSendingContinues() async throws {
    // The reply says the fleet is killed.
    let h = Self.harness(flags: BuddyFlags(window: true, live: true, reasonCode: nil, fleetKill: true))
    await Self.feed(h, seconds: 26)
    let breaches = await h.runner.stats.breaches
    #expect(breaches >= 1 && h.window.all.isEmpty, "the window stays shut")
    #expect(h.transport.posted.count == 2, "sending follows `live`")
    #expect(h.logs.all.contains { $0.contains("window_breach count 1") })

    // A shadow session whose window goes true later: the earlier reply said fleet_off.
    let later = Self.harness(flags: Self.shadow)
    await later.runner.tick()
    later.transport.setFlags(Self.live)
    later.clock.advance(61)
    await later.runner.tick()
    let laterBreaches = await later.runner.stats.breaches
    #expect(laterBreaches == 1 && later.window.all.isEmpty, "never opened")

    // The control: no fleet information and a window true opens.
    let clean = Self.harness(flags: Self.live)
    await clean.runner.tick()
    let cleanBreaches = await clean.runner.stats.breaches
    #expect(cleanBreaches == 0 && clean.window.all == ["open"])
  }

  @Test func theWindowFollowsTheFlagsBothWays() async throws {
    let h = Self.harness(flags: Self.live)
    await h.runner.tick()
    h.transport.setFlags(Self.shadow)  // a doctor opts out mid-consult
    h.clock.advance(61)
    await h.runner.tick()
    let finished = await h.runner.isFinished
    #expect(h.window.all == ["open", "close"] && !finished, "still sending, no longer shown")
  }

  // MARK: - The ring

  @Test func aStalledServerNeverBlocksReadingTheTapAndTheRingStaysUnderSixtySeconds() async throws {
    let h = Self.harness(flags: Self.shadow)
    h.transport.chunkHandler = { _, _ in
      try? await Task.sleep(nanoseconds: 3_600_000_000_000)  // the server never answers
      return BuddyChunkReply(status: 0)
    }
    await h.runner.tick()
    for _ in 0..<12 {
      h.tape.growSeconds(10)
      await h.runner.tick()
    }
    // 120 s of audio went by with chunk 0 unanswered.
    let stats = await h.runner.stats
    #expect(h.transport.posted.count == 1, "one in flight, the stalled one")
    #expect(stats.ringBytes <= 60 * 32_000, "the ring is bounded: \(stats.ringBytes)")
    #expect(stats.droppedMilliseconds > 0, "the oldest frames dropped")
    #expect(h.tape.offsetsAsked.max() ?? 0 >= Int64(h.tape.size) - 262_144, "and the tape reader kept up the whole time")
    #expect(h.logs.all.contains { $0.contains("ring full") })
    await h.runner.stop()
    await h.runner.settle()
  }

  @Test func theChunkAfterAGapStartsWhereItsAudioStartsNotWhereTheLastOneEnded() async throws {
    let h = Self.harness(flags: Self.shadow)
    let release = Gate()
    h.transport.chunkHandler = { chunk, _ in
      if chunk.seq == 0 { await release.wait() }
      return BuddyChunkReply(status: 200, seq: chunk.seq, hasText: false)
    }
    await h.runner.tick()
    for _ in 0..<9 {
      h.tape.growSeconds(10)
      await h.runner.tick()
    }
    release.open()
    await h.runner.settle()
    await h.runner.tick()
    await h.runner.settle()
    let second = try #require(h.transport.posted.dropFirst().first)
    #expect(second.seq == 1 && second.startMs > 12_000, "the dropped audio is a gap in time, not silence slid together")
    #expect(second.startMs % 2 == 0)
  }

  @Test func aNewCaptureNeverSplicesTwoTapesIntoOneChunk() async throws {
    let h = Self.harness(flags: Self.shadow)
    await h.runner.tick()
    h.tape.growSeconds(6, fill: 0xAA)
    await h.runner.tick()
    h.tape.newCapture("seg_2")
    h.tape.growSeconds(30, fill: 0xBB)
    for _ in 0..<5 {
      await h.runner.tick()
      await h.runner.settle()
    }
    let posted = h.transport.posted
    #expect(!posted.isEmpty)
    for chunk in posted { #expect(Set(chunk.wav[44...]).count == 1, "each chunk is one tape") }
    #expect(posted.allSatisfy { $0.wav[44...].allSatisfy { $0 == 0xBB } }, "the partial chunk of the old capture was dropped")
  }

  @Test func theTapClosingUnderTheRunnerEndsReading() async throws {
    let h = Self.harness(flags: Self.shadow)
    await h.runner.tick()
    h.tape.refuse()
    h.tape.growSeconds(30)
    await h.runner.tick()
    await h.runner.tick()
    let stopped = await h.runner.isStopped
    #expect(stopped && h.transport.posted.isEmpty)
  }

  // MARK: - The transcript

  @Test func theStaleIndicatorShowsAtThirtySecondsAndNewTextClearsIt() {
    final class Time: @unchecked Sendable { var now = 0.0 }
    let time = Time()
    let transcript = BuddyLiveTranscript(opaqueID: "opq_s", clock: { time.now })
    time.now = 29
    #expect(!transcript.snapshot().stale)
    time.now = 30
    #expect(transcript.snapshot().stale, "30 s with nothing new")
    transcript.append(text: "x")
    #expect(!transcript.snapshot().stale)
    time.now = 59.9
    #expect(!transcript.snapshot().stale)
    time.now = 60
    #expect(transcript.snapshot().stale)
    transcript.setState(.unavailable)
    time.now = 0
    #expect(transcript.snapshot().stale && transcript.snapshot().segments.isEmpty)
    transcript.setState(.off)
    #expect(!transcript.snapshot().stale)
  }

  @Test func theTranscriptIsBoundedAndGapsCollapse() {
    let transcript = BuddyLiveTranscript(opaqueID: "opq_b")
    transcript.appendGap()
    transcript.appendGap()
    #expect(transcript.snapshot().segments.count == 1)
    for index in 0..<1_000 { transcript.append(text: "line \(index)") }
    let kept = transcript.snapshot().segments
    #expect(kept.count <= BuddyLiveTranscript.maxSegments && kept.last?.text == "line 999")
  }

  // MARK: - C8V3-C4

  @Test func aQuestionWhoseFactRefsNameAnotherSnapshotIsDroppedAndCountedWithoutItsText() {
    let logs = LockedList<String>()
    let guardrail = BuddyQuestionGuard(boundSnapshotID: "ms-aaaa1111", log: { logs.append($0) })
    #expect(guardrail.admit(factRefs: ["ms-aaaa1111#labs.0", "ms-aaaa1111#vitals.2"]), "all refs on the bound snapshot")
    #expect(guardrail.admit(factRefs: ["ms-aaaa1111"]), "a bare snapshot id")
    #expect(guardrail.breachCount == 0)
    // The cross-wired fixture: one ref from another patient's snapshot.
    #expect(!guardrail.admit(factRefs: ["ms-aaaa1111#labs.0", "ms-bbbb2222#labs.0"]))
    #expect(!guardrail.admit(factRefs: ["ms-bbbb2222#x"]))
    #expect(!guardrail.admit(factRefs: ["ms-aaaa11112#x"]), "a longer id that merely starts the same is another snapshot")
    #expect(!guardrail.admit(factRefs: ["ms-aaaa#x"]), "so is a shorter one")
    #expect(!guardrail.admit(factRefs: ["#x"]) && !guardrail.admit(factRefs: [""]))
    #expect(guardrail.breachCount == 6)
    #expect(logs.all.first == "buddy page: wrong_snapshot_breach count 1")
    #expect(logs.all.allSatisfy { $0.hasPrefix("buddy page: wrong_snapshot_breach count ") && !$0.contains("ms-") && !$0.contains("labs") })
    #expect(!BuddyQuestionGuard(boundSnapshotID: "", log: { _ in }).admit(factRefs: ["ms-x#y"]), "nothing is bound: nothing is admitted")
  }

  // MARK: - The page (D5) and the window

  /// A controller with a real server, a spy window and a fake runner, for the page tests.
  struct Consult {
    let controller: BuddyConsultController
    let presenter: BuddyL1Tests.SpyPresenter
    let root: URL
    let state: BuddyStateBox
    let h: Harness
    let logs: LockedList<String>
  }

  static func consult(flags: BuddyFlags, runner: Bool = true) throws -> Consult {
    let root = R4Fixture.temporaryRoot()
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let presenter = BuddyL1Tests.SpyPresenter()
    let state = BuddyStateBox()
    state.set(.init(recording: true, micState: "authorized", pcmURL: nil, segmentID: nil))
    let logs = LockedList<String>()
    let clock = FakeClock()
    let transport = ScriptedTransport()
    transport.setFlags(flags)
    let tape = FakeTape()
    let harness = Harness(
      runner: BuddyRunner(
        opaqueID: "opq_l2", transport: transport, pcm: tape, window: SpyWindow(), transcript: BuddyLiveTranscript(opaqueID: "unused"),
        clock: clock, log: { _ in }),
      transport: transport, tape: tape, window: SpyWindow(), transcript: BuddyLiveTranscript(opaqueID: "unused"), clock: clock, logs: logs)
    var plan: BuddyRunnerPlan?
    if runner {
      plan = {
        { context in
          BuddyRunner(
            opaqueID: context.opaqueID, transport: transport, pcm: tape, window: context.window, transcript: context.transcript,
            clock: clock, log: { logs.append($0) })
        }
      }
    }
    let controller = BuddyConsultController(
      root: root, state: state, presenter: presenter, log: { logs.append($0) }, makeToken: { String(repeating: "c", count: 64) },
      runnerPlan: plan)
    return Consult(controller: controller, presenter: presenter, root: root, state: state, h: harness, logs: logs)
  }

  static func stateObject(port: Int, id: String) -> [String: Any]? {
    BuddyL1Tests.get(port: port, path: "/encounter/\(id)/state").flatMap { try? JSONSerialization.jsonObject(with: $0.body) as? [String: Any] }
  }

  @Test func aShadowConsultHasNoWindowNoPageNoStateAndNoActivation() async throws {
    let c = try Self.consult(flags: Self.shadow)
    defer { c.controller.shutdown() }  // ends any consult left open, which halts and stops its runner
    defer { try? FileManager.default.removeItem(at: c.root) }
    guard case .opened(let port) = c.controller.consultStarted(opaqueID: "opq_l2", buddyOff: false) else { Issue.record("not opened"); return }
    try await R4Fixture.waitUntil { c.h.transport.flagPollCount >= 1 }
    c.h.tape.growSeconds(2)
    try await Task.sleep(nanoseconds: 300_000_000)
    #expect(c.presenter.all.isEmpty, "no window call at all")
    #expect(BuddyL1Tests.get(port: Int(port), path: "/encounter/opq_l2")?.status == 404, "no page route")
    #expect(BuddyL1Tests.get(port: Int(port), path: "/encounter/opq_l2/state")?.status == 404, "no state route")
    #expect(BuddyL1Tests.get(port: Int(port), path: "/tap/pcm?from=0&max=2", token: String(repeating: "c", count: 64))?.status == 404, "the tap still answers its own routes")
    _ = c.controller.consultEnded(opaqueID: "opq_l2")
    #expect(c.presenter.all.isEmpty, "ending a consult that never had a window closes no window")
    #expect(!c.logs.all.contains { $0.contains("window open") || $0.contains("window closed") })
  }

  @Test func aLiveConsultOpensItsWindowOnlyWhenWindowIsTrueAndTheEndClosesItAndDropsTheRunner() async throws {
    let c = try Self.consult(flags: Self.live)
    defer { c.controller.shutdown() }  // ends any consult left open, which halts and stops its runner
    defer { try? FileManager.default.removeItem(at: c.root) }
    guard case .opened(let port) = c.controller.consultStarted(opaqueID: "opq_l2", buddyOff: false) else { Issue.record("not opened"); return }
    #expect(c.presenter.all.isEmpty, "not at consult_started: only once the flags say window")
    try await R4Fixture.waitUntil { c.presenter.all == ["open:opq_l2"] }
    #expect(BuddyL1Tests.get(port: Int(port), path: "/encounter/opq_l2")?.status == 200)
    _ = c.controller.consultEnded(opaqueID: "opq_l2")
    #expect(c.presenter.all == ["open:opq_l2", "close:opq_l2"])
    #expect(BuddyL1Tests.get(port: Int(port), path: "/encounter/opq_l2/state") == nil, "the server is gone with the consult")
    let posted = c.h.transport.posted.count
    c.h.tape.growSeconds(40)
    try await Task.sleep(nanoseconds: 300_000_000)
    #expect(c.h.transport.posted.count == posted, "nothing is sent after the end")
  }

  @Test func theKillSwitchOnALiveConsultStopsTheRunnerAndClosesTheWindow() async throws {
    let c = try Self.consult(flags: Self.live)
    defer { c.controller.shutdown() }  // ends any consult left open, which halts and stops its runner
    defer { try? FileManager.default.removeItem(at: c.root) }
    _ = c.controller.consultStarted(opaqueID: "opq_l2", buddyOff: false)
    try await R4Fixture.waitUntil { c.presenter.all == ["open:opq_l2"] }
    #expect(c.controller.consultStarted(opaqueID: "opq_l2", buddyOff: true) == .off)
    #expect(c.presenter.all == ["open:opq_l2", "close:opq_l2"] && !c.controller.isLive)
  }

  @Test func theD5PageShowsExactlyTheD5FieldsAndNoQuestionOrSuggestionExists() async throws {
    let c = try Self.consult(flags: Self.live)
    defer { c.controller.shutdown() }  // ends any consult left open, which halts and stops its runner
    defer { try? FileManager.default.removeItem(at: c.root) }
    guard case .opened(let port) = c.controller.consultStarted(opaqueID: "opq_l2", buddyOff: false) else { Issue.record("not opened"); return }
    try await R4Fixture.waitUntil { c.presenter.all == ["open:opq_l2"] }
    let object = try #require(Self.stateObject(port: Int(port), id: "opq_l2"))
    #expect(
      Set(object.keys) == ["opaque_id", "recording", "mic_state", "live_state", "stale", "notice", "transcript"],
      "only D5: \(object.keys.sorted())")
    for key in object.keys { for word in ["question", "suggest", "flag", "differential", "engine", "advice"] { #expect(!key.lowercased().contains(word)) } }
    #expect((object["notice"] as? String)?.contains("Encounter Buddy") == true && (object["notice"] as? String)?.contains("opt out") == true)
    #expect(object["recording"] as? Bool == true && object["mic_state"] as? String == "authorized", "recording and mic_state, separately")
    #expect(object["opaque_id"] as? String == "opq_l2")
    let page = try #require(BuddyL1Tests.get(port: Int(port), path: "/encounter/opq_l2"))
    let html = String(decoding: page.body, as: UTF8.self)
    for need in ["Encounter Buddy", "Live transcript", "<details", "stale", "live transcript unavailable", "live transcript off", "opq_l2", "s.opaque_id!==ME", "textContent"] {
      #expect(html.contains(need), "the page has \(need)")
    }
    for word in ["question", "suggest", "differential", "copilot", "innerHTML"] { #expect(!html.lowercased().contains(word.lowercased()), "the page must not mention \(word)") }
    #expect(page.headers["content-security-policy"]?.contains("default-src 'none'") == true)
  }

  @Test func theTranscriptOfOneConsultNeverAppearsInTheNext() async throws {
    let c = try Self.consult(flags: Self.live)
    defer { c.controller.shutdown() }  // ends any consult left open, which halts and stops its runner
    defer { try? FileManager.default.removeItem(at: c.root) }
    guard case .opened(let firstPort) = c.controller.consultStarted(opaqueID: "opq_one", buddyOff: false) else { Issue.record("not opened"); return }
    try await R4Fixture.waitUntil { c.presenter.all == ["open:opq_one"] }
    try await R4Fixture.waitUntil { c.h.tape.offsetsAsked.count >= 1 }  // the consult has started on the tape
    c.h.tape.growSeconds(26)
    try await R4Fixture.waitUntil {
      (Self.stateObject(port: Int(firstPort), id: "opq_one")?["transcript"] as? [[String: Any]])?.isEmpty == false
    }
    _ = c.controller.consultEnded(opaqueID: "opq_one")
    guard case .opened(let secondPort) = c.controller.consultStarted(opaqueID: "opq_two", buddyOff: false) else { Issue.record("not opened"); return }
    try await R4Fixture.waitUntil { c.presenter.all.contains("open:opq_two") }
    let object = try #require(Self.stateObject(port: Int(secondPort), id: "opq_two"))
    #expect((object["transcript"] as? [[String: Any]])?.isEmpty == true, "a new consult starts with nothing")
    #expect(BuddyL1Tests.get(port: Int(secondPort), path: "/encounter/opq_one/state")?.status == 404, "the other consult has no route")
    _ = c.controller.consultEnded(opaqueID: "opq_two")
  }

  @Test func withNoRunnerOnThisMacTheWindowBehavesExactlyAsIn0141() async throws {
    let c = try Self.consult(flags: Self.live, runner: false)
    defer { c.controller.shutdown() }  // ends any consult left open, which halts and stops its runner
    defer { try? FileManager.default.removeItem(at: c.root) }
    guard case .opened(let port) = c.controller.consultStarted(opaqueID: "opq_l2", buddyOff: false) else { Issue.record("not opened"); return }
    #expect(c.presenter.all == ["open:opq_l2"], "opened at once, as in 0.1.41")
    let object = try #require(Self.stateObject(port: Int(port), id: "opq_l2"))
    #expect(Set(object.keys) == ["opaque_id", "recording", "mic_state"], "the 0.1.41 state, byte for byte")
    #expect(c.h.transport.posted.isEmpty && c.h.transport.flagPollCount == 0, "and nothing is sent")
    _ = c.controller.consultEnded(opaqueID: "opq_l2")
    #expect(c.presenter.all == ["open:opq_l2", "close:opq_l2"])
  }

  // MARK: - Through the engine

  static func engineRig(
    plan: @escaping BuddyRunnerPlan, pcm: Data = BuddyL1Tests.fixturePCM
  ) async throws -> (root: URL, engine: RoomEngine, remote: BuddyL1Tests.PushRemote, presenter: BuddyL1Tests.SpyPresenter, launcher: BuddyL1Tests.BurstLauncher, encoder: BuddyL1Tests.EchoEncoder, logs: LockedList<String>) {
    let root = R4Fixture.temporaryRoot()
    try RoomPersistence(root: root).saveConfiguration(try R4Fixture.configuration())
    let remote = BuddyL1Tests.PushRemote()
    let presenter = BuddyL1Tests.SpyPresenter()
    let launcher = BuddyL1Tests.BurstLauncher(pcm: pcm)
    let encoder = BuddyL1Tests.EchoEncoder()
    let logs = LockedList<String>()
    let audio = R4AudioInputs.standard()
    let engine = try await RoomEngine.load(
      rootURL: root, enrolmentReader: R4Fixture.enrolled, remoteFactory: { _ in remote },
      captureLauncher: launcher, pieceRunner: encoder, updaterFactory: { _, _, _ in nil },
      log: { logs.append($0) }, audioInputs: audio, inputReadyWait: .disabled,
      machineFacts: { uid in audio.facts(forUID: uid) })
    await engine.setMicStateProvider { "authorized" }
    await engine.attachBuddy(presenter: presenter, runnerPlan: plan)
    return (root, engine, remote, presenter, launcher, encoder, logs)
  }

  @Test func theCloudChunksAreByteIdenticalWithTheRunnerSendingAndTheServerStalled() async throws {
    func run(runnerOn: Bool) async throws -> (pieces: [Data], posted: [BuddyChunk]) {
      let transport = ScriptedTransport()
      transport.setFlags(Self.shadow)
      transport.chunkHandler = { _, _ in
        try? await Task.sleep(nanoseconds: 3_600_000_000_000)  // the server never answers
        return BuddyChunkReply(status: 0)
      }
      // The real tap reader on the real tap: the runner reads the recorder's own tape while it cuts pieces.
      let plan: BuddyRunnerPlan = {
        { context in
          BuddyRunner(
            opaqueID: context.opaqueID, transport: transport,
            pcm: FromStartReader(base: BuddyTapReader(port: context.tapPort, token: context.tapToken)),
            window: context.window, transcript: context.transcript, clock: BuddySystemClock(), log: { _ in })
        }
      }
      var chosen: BuddyRunnerPlan = { nil }
      if runnerOn { chosen = plan }
      let rig = try await Self.engineRig(plan: chosen, pcm: Self.fourteenSeconds)
      defer { try? FileManager.default.removeItem(at: rig.root) }
      let task = Task { try await rig.engine.run() }
      await rig.remote.push(BuddyL1Tests.command("c1", "start_day"))
      try await R4Fixture.waitUntil { rig.launcher.launchCount == 1 }
      if runnerOn {
        await rig.remote.push(BuddyL1Tests.command("c2", "consult_started", #"{"opaque_id":"opq_same"}"#))
        try await R4Fixture.waitUntil { transport.posted.count == 1 }
        try await Task.sleep(nanoseconds: 500_000_000)
        #expect(transport.posted.count == 1, "the stalled chunk holds the only slot")
      }
      if runnerOn {
        // End the consult: this halts the runner and cancels the chunk the stalled transport is parked in.
        await rig.remote.push(BuddyL1Tests.command("c8", "consult_ended", #"{"opaque_id":"opq_same"}"#))
        try await R4Fixture.waitUntil { await rig.remote.acks.contains { $0.id == "c8" } }
      }
      await rig.remote.push(BuddyL1Tests.command("c9", "end_day"))
      try await R4Fixture.waitUntil { await rig.remote.acks.contains { $0.id == "c9" } }
      task.cancel()
      try await task.value
      return (rig.encoder.pieces, transport.posted)
    }
    let off = try await run(runnerOn: false)
    let on = try await run(runnerOn: true)
    #expect(!off.pieces.isEmpty && off.pieces.reduce(Data(), +) == Self.fourteenSeconds)
    #expect(on.pieces == off.pieces, "the same pieces, byte for byte, with the runner reading and a stalled server (C2)")
    let sent = try #require(on.posted.first)
    #expect(sent.seq == 0 && sent.startMs == 0 && sent.wav[44...] == Self.fourteenSeconds[0..<384_000], "and the runner's chunk IS the tape's first 12 s")
  }

  @Test func theRunnerWritesNoAudioAndNoTextToDisk() async throws {
    let transport = ScriptedTransport()
    transport.setFlags(Self.live)
    let tape = FakeTape()
    let plan: BuddyRunnerPlan = {
      { context in
        BuddyRunner(
          opaqueID: context.opaqueID, transport: transport, pcm: tape, window: context.window, transcript: context.transcript,
          clock: FakeClock(), log: { _ in })
      }
    }
    let rig = try await Self.engineRig(plan: plan)
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    await rig.remote.push(BuddyL1Tests.command("c1", "start_day"))
    try await R4Fixture.waitUntil { rig.launcher.launchCount == 1 }
    let before = BuddyL1Tests.tree(rig.root).filter { !$0.contains("status.json") && !$0.contains("tape.") }
    await rig.remote.push(BuddyL1Tests.command("c2", "consult_started", #"{"opaque_id":"opq_files"}"#))
    try await R4Fixture.waitUntil { BuddyL1Tests.tapFile(rig.root) != nil }
    try await R4Fixture.waitUntil { rig.presenter.all == ["open:opq_files"] }
    try await R4Fixture.waitUntil { tape.offsetsAsked.count >= 1 }  // the consult has started on the tape
    tape.growSeconds(42)
    try await R4Fixture.waitUntil { transport.posted.count >= 3 }
    let during = BuddyL1Tests.tree(rig.root).filter { !$0.contains("status.json") && !$0.contains("tape.") }
    let added = Set(during).subtracting(before)
    #expect(added.count == 1 && added.first?.contains("/\(BuddyConsultController.tapFileName) ") == true, "only the L1 token file: \(added)")
    await rig.remote.push(BuddyL1Tests.command("c3", "consult_ended", #"{"opaque_id":"opq_files"}"#))
    try await R4Fixture.waitUntil { rig.presenter.all.count == 2 }
    await rig.remote.push(BuddyL1Tests.command("c4", "end_day"))
    try await R4Fixture.waitUntil { await rig.remote.acks.contains { $0.id == "c4" } }
    task.cancel()
    try await task.value
    #expect(BuddyL1Tests.tree(rig.root).filter { $0.contains(".pcm") || $0.contains(".wav") }.count == 1, "only the recorder's own tape.pcm")
  }

  @Test func theWindowOfEachCommandKindIsUnchangedFromTheL1Contract() async throws {
    // The same command round trip the 0.1.41 suite pins, here with a runner plan that finds no runner.
    let rig = try await Self.engineRig(plan: { nil })
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let task = Task { try await rig.engine.run() }
    await rig.remote.push(BuddyL1Tests.command("c1", "consult_started", #"{"opaque_id":"opq_win"}"#))
    try await R4Fixture.waitUntil { rig.presenter.all == ["open:opq_win"] }
    await rig.remote.push(BuddyL1Tests.command("c2", "consult_started", #"{"opaque_id":"opq_win"}"#))
    try await R4Fixture.waitUntil { await rig.remote.acks.count == 2 }
    #expect(rig.presenter.all == ["open:opq_win"], "no re-open while the consult is live (A2-C3)")
    await rig.remote.push(BuddyL1Tests.command("c3", "consult_ended", #"{"opaque_id":"opq_win"}"#))
    try await R4Fixture.waitUntil { rig.presenter.all.count == 2 }
    #expect(rig.presenter.all == ["open:opq_win", "close:opq_win"])
    task.cancel()
    try await task.value
  }

  // MARK: - Logs, config, sources

  @Test func noLogLineCarriesTextATokenOrAKey() async throws {
    let h = Self.harness(flags: Self.live)
    h.transport.chunkHandler = { chunk, attempt in
      chunk.seq == 0 && attempt == 1
        ? BuddyChunkReply(status: 502, error: "TEXT-MARKER-NOT-A-CODE")
        : BuddyChunkReply(status: 200, seq: chunk.seq, text: "TEXT-MARKER-PATIENT-WORDS", hasText: true)
    }
    await Self.feed(h, seconds: 38)
    let lines = h.logs.all
    #expect(lines.count >= 5)
    for line in lines {
      #expect(!line.contains("TEXT-MARKER") && !line.contains("PATIENT-WORDS"), "no text, no server words: \(line)")
      #expect(!line.contains("tok-SECRET") && !line.lowercased().contains("bearer"), "no token: \(line)")
      #expect(line.hasPrefix("buddy runner: "), "\(line)")
    }
    #expect(lines.contains { $0.contains("chunk seq 0 status 502 other ") }, "a server word that is not a short code is logged as `other`")
    #expect(lines.contains { $0.contains("chunk seq 1 status 200 ms ") && $0.contains("audio_ms 12000") }, "counts, codes and timings")
  }

  @Test func theRunnerConfigIsReadOnlyFromAPrivateFileAndTheKeyIsNeverLogged() throws {
    let root = R4Fixture.temporaryRoot()
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let logs = LockedList<String>()
    #expect(BuddyRunnerConfig.load(root: root, log: { logs.append($0) }) == nil, "no file, no runner")
    let url = root.appendingPathComponent(BuddyRunnerConfig.fileName)
    try Data(#"{"base":"http://c4:43124","key":"KEY-SECRET-1"}"#.utf8).write(to: url)
    chmod(url.path, 0o644)
    #expect(BuddyRunnerConfig.load(root: root, log: { logs.append($0) }) == nil, "readable by others: refused")
    chmod(url.path, 0o600)
    let config = try #require(BuddyRunnerConfig.load(root: root, log: { logs.append($0) }))
    #expect(config.base.absoluteString == "http://c4:43124" && config.key == "KEY-SECRET-1")
    try Data(#"{"base":"ftp://c4","key":"KEY-SECRET-1"}"#.utf8).write(to: url)
    chmod(url.path, 0o600)
    #expect(BuddyRunnerConfig.load(root: root, log: { logs.append($0) }) == nil, "not http or https")
    try Data(#"{"base":"http://c4:43124"}"#.utf8).write(to: url)
    chmod(url.path, 0o600)
    #expect(BuddyRunnerConfig.load(root: root, log: { logs.append($0) }) == nil, "no key")
    #expect(!logs.all.contains { $0.contains("KEY-SECRET") }, "the key is never logged")
  }

  @Test func theTapReaderReadsTheRealTapAndSeesItsRefusals() async throws {
    let state = BuddyStateBox()
    let token = String(repeating: "d", count: 64)
    let server = BuddyTapServer(token: token, opaqueID: "opq_x", state: state)
    let port = try server.start()
    defer { server.stop() }
    let reader = BuddyTapReader(port: port, token: token)
    #expect(await reader.read(from: 0, max: 64) == .noCapture, "no capture running")
    let pcm = FileManager.default.temporaryDirectory.appendingPathComponent("buddy-l2-\(UUID().uuidString).pcm")
    try BuddyL1Tests.fixturePCM.write(to: pcm)
    defer { try? FileManager.default.removeItem(at: pcm) }
    state.set(.init(recording: true, micState: "authorized", pcmURL: pcm, segmentID: "seg_9"))
    let size = Int64(BuddyL1Tests.fixturePCM.count)
    #expect(await reader.read(from: 10, max: 100) == .bytes(BuddyL1Tests.fixturePCM[10..<110], segment: "seg_9", size: size))
    #expect(await reader.read(from: size + 2, max: 100) == .pastEnd(size: size))
    #expect(await BuddyTapReader(port: port, token: "wrong").read(from: 0, max: 2) == .refused(status: 401))
    server.stopServing()
    #expect(await reader.read(from: 0, max: 2) == .refused(status: 403))
  }

  @Test func theRunnerSourcesHoldNoIdentifierNoDiskWriteAndNoPrint() throws {
    for name in ["BuddyRunner.swift", "BuddyQuestionGuard.swift"] {
      let code = try BuddyL1Tests.sourceWithoutComments(name).lowercased()
      for forbidden in ["doctor_uid", "consult_uid", "presc_uid", "copilot", "sarvam", "nsworkspace", "process(", "osascript", "python3"] {
        #expect(!code.contains(forbidden), "\(name) mentions \(forbidden)")
      }
      for forbidden in ["filehandle", "createfile", ".write(to", "fopen(", "o_wronly", "o_creat", "filemanager", "print(", "nslog(", "os_log", "userdefaults"] {
        #expect(!code.contains(forbidden), "\(name) must not touch the disk or print: \(forbidden)")
      }
    }
    // The config reader opens one file read-only; that is the only file this module reads.
    let runner = try BuddyL1Tests.sourceWithoutComments("BuddyRunner.swift")
    #expect(runner.contains("Data(contentsOf: url)") && !runner.contains("O_RDWR"))
  }

  @Test func theRunnerNamesTheChunkContractTheWayNewcatB3Does() throws {
    let code = try BuddyL1Tests.sourceWithoutComments("BuddyRunner.swift")
    for need in ["/runner/v1/chunks", "x-chunk-opaque-id", "x-chunk-seq", "x-chunk-start-ms", "x-chunk-duration-ms", "audio/wav", "/runner/v1/token", "/runner/v1/flags"] {
      #expect(code.contains(need), "the runner must send \(need)")
    }
    #expect(BuddyRunner.chunkMilliseconds == 12_000 && BuddyRunner.ringMilliseconds == 60_000)
  }
}

// MARK: - Test support

/// Holds a task until the test opens it.
final class Gate: @unchecked Sendable {
  private let lock = NSLock()
  private var isOpen = false
  func open() { lock.withLock { isOpen = true } }
  func wait() async {
    while !lock.withLock({ isOpen }) { try? await Task.sleep(nanoseconds: 1_000_000) }
  }
}

/// A one-connection-at-a-time HTTP server on 127.0.0.1 for the real transport to talk to. It records every request.
final class FakeRunnerServer: @unchecked Sendable {
  struct Request { var line = ""; var headers: [String: String] = [:]; var body = Data() }
  private let lock = NSLock()
  private var fd: Int32 = -1
  private var stopped = false
  private var routes: [String: (Int, String, [String: String])] = [:]
  private var seen: [Request] = []
  let port: UInt16

  var requests: [Request] { lock.withLock { seen } }

  func respond(path: String, status: Int, body: String, headers: [String: String] = [:]) {
    lock.withLock { routes[path] = (status, body, headers) }
  }

  init() throws {
    let socketFD = socket(AF_INET, SOCK_STREAM, 0)
    guard socketFD >= 0 else { throw CocoaError(.fileReadUnknown) }
    var yes: Int32 = 1
    setsockopt(socketFD, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = 0
    address.sin_addr = in_addr(s_addr: UInt32(INADDR_LOOPBACK).bigEndian)
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(socketFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard bound == 0, listen(socketFD, 8) == 0 else { close(socketFD); throw CocoaError(.fileReadUnknown) }
    var actual = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &actual) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(socketFD, $0, &length) } }
    port = UInt16(bigEndian: actual.sin_port)
    fd = socketFD
    let thread = Thread { [self] in loop(socketFD) }
    thread.start()
  }

  func stop() {
    let toClose: Int32 = lock.withLock {
      stopped = true
      let current = fd
      fd = -1
      return current
    }
    if toClose >= 0 { close(toClose) }
  }

  private func loop(_ listener: Int32) {
    while !lock.withLock({ stopped }) {
      var descriptor = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
      if poll(&descriptor, 1, 100) <= 0 { continue }
      let client = accept(listener, nil, nil)
      if client < 0 { continue }
      handle(client)
      close(client)
    }
  }

  private func handle(_ client: Int32) {
    var timeout = timeval(tv_sec: 3, tv_usec: 0)
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 65_536)
    var headEnd: Range<Data.Index>?
    while headEnd == nil {
      let n = recv(client, &chunk, chunk.count, 0)
      if n <= 0 { return }
      buffer.append(contentsOf: chunk[0..<n])
      headEnd = buffer.range(of: Data("\r\n\r\n".utf8))
    }
    let head = String(decoding: buffer[..<headEnd!.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
    var request = Request()
    let parts = head[0].split(separator: " ")
    request.line = "\(parts[0]) \(parts[1])"
    for line in head.dropFirst() {
      if let colon = line.firstIndex(of: ":") {
        request.headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      }
    }
    var body = Data(buffer[headEnd!.upperBound...])
    let expected = Int(request.headers["content-length"] ?? "0") ?? 0
    while body.count < expected {
      let n = recv(client, &chunk, chunk.count, 0)
      if n <= 0 { break }
      body.append(contentsOf: chunk[0..<n])
    }
    request.body = body
    let path = String(parts[1].split(separator: "?")[0])
    let route: (Int, String, [String: String]) = lock.withLock {
      seen.append(request)
      return routes[path] ?? (404, "{}", [:])
    }
    var response = "HTTP/1.1 \(route.0) X\r\nContent-Type: application/json\r\nContent-Length: \(route.1.utf8.count)\r\nConnection: close\r\n"
    for (key, value) in route.2 { response += "\(key): \(value)\r\n" }
    response += "\r\n" + route.1
    _ = response.withCString { send(client, $0, strlen($0), 0) }
  }
}
