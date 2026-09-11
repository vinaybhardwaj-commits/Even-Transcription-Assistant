import Foundation
import Testing

@testable import RoomRecorderCore
@testable import TapeCapture
@testable import TapeCore

/// Tier 1 §3 — the three operator verbs (`check_update_now`, `report_diag`, `restart_engine`), the
/// config.json channel lock, and the 0.1.22 heartbeat (`clip_count`, `silence_ms`, `channel_locked`).
///
/// The engine runs the plain capture path with the R4 fakes (`R4FakeLauncher`, `R4FakeEncoder`,
/// `R4AudioInputs`) and a remote of its own that records each ack's verb fields and the order in
/// which acks and the process exit happen. Nothing here touches CoreAudio, launchd or the network.
@Suite(.serialized) struct RoomOperatorVerbTests {

  // -------------------------------------------------------------------------
  // The wire
  // -------------------------------------------------------------------------

  @Test func theThreeVerbsRoundTripAndDecodeAsThemselves() throws {
    let kinds: [(String, BenchCommandKind)] = [
      ("check_update_now", .checkUpdateNow), ("report_diag", .reportDiag),
      ("restart_engine", .restartEngine),
    ]
    for (raw, kind) in kinds {
      #expect(BenchCommandKind(rawValue: raw) == kind)
      #expect(kind.rawValue == raw)
      #expect(String(decoding: try JSONEncoder().encode(kind), as: UTF8.self) == "\"\(raw)\"")
    }
    let response = try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(
        #"{"ok":true,"assigned_channel":"test","commands":[{"id":"c1","kind":"report_diag","args":{"log_lines":5}},{"id":"c2","kind":"restart_engine"}]}"#
          .utf8))
    #expect(response.commands.map(\.kind) == [.reportDiag, .restartEngine])
    #expect(response.commands[1].args == .null)
    #expect(response.assignedChannel == "test")
  }

  @Test func theAckCarriesVerbFieldsOnlyWhenThereAreSome() async throws {
    let client = try VerbStubHTTP.client()
    let bodies = LockedList<[String: Any]>()
    VerbStubHTTP.handler = { request in
      let body = try VerbStubHTTP.body(request)
      bodies.append(try #require(JSONSerialization.jsonObject(with: body) as? [String: Any]))
      let id = request.url!.pathComponents.dropLast().last!
      return VerbStubHTTP.stub(request, body: "{\"ok\":true,\"id\":\"\(id)\",\"status\":\"acked\"}")
    }
    defer { VerbStubHTTP.handler = nil }

    _ = try await client.acknowledge(
      commandID: "cmd_1", ok: true, sessionID: nil, error: nil, audioInput: nil,
      verb: OperatorVerbAcknowledgement(
        checkedAt: "2026-09-11T16:00:00Z", offeredVersion: "0.1.23", deferred: false, held: false))
    _ = try await client.acknowledge(
      commandID: "cmd_2", ok: true, sessionID: nil, error: nil, audioInput: nil,
      verb: OperatorVerbAcknowledgement(
        restarting: true, diag: .object(["app_version": .string("0.1.22")])))
    _ = try await client.acknowledge(commandID: "cmd_3", ok: true, sessionID: "bs_1")

    let seen = bodies.all
    #expect(seen.count == 3)
    #expect(seen[0]["checked_at"] as? String == "2026-09-11T16:00:00Z")
    #expect(seen[0]["offered_version"] as? String == "0.1.23")
    #expect(seen[0]["deferred"] as? Bool == false)
    #expect(seen[0]["held"] as? Bool == false)
    #expect(seen[1]["restarting"] as? Bool == true)
    #expect((seen[1]["diag"] as? [String: Any])?["app_version"] as? String == "0.1.22")
    // A day verb's ack carries exactly the keys it always did.
    #expect(Set(seen[2].keys) == ["ok", "session_id"])
  }

  // -------------------------------------------------------------------------
  // check_update_now — the interval is bypassed, and nothing else is
  // -------------------------------------------------------------------------

  @Test func forceBypassesTheIntervalAndNothingElse() async throws {
    let now = Date()
    let schedule = RoomUpdateSchedule(lastCheckedAt: now.addingTimeInterval(-60))
    #expect(!schedule.isDue(now: now, sessionJustEnded: false))
    #expect(schedule.isDue(now: now, sessionJustEnded: false, force: true))

    let root = R4Fixture.temporaryRoot()
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let events = EventLog()
    let updater = RoomUpdater(
      rootURL: root,
      residentBundleURL: root.appendingPathComponent("EvenScribe Room Recorder.app"),
      runningVersion: "0.1.22",
      channel: "test",
      fetcher: VerbFetcher(version: "0.1.23"),
      downloader: RecordingFailingDownloader(events: events),
      runner: RefusingRunner(),
      log: { _ in })

    // A session is open: the forced check still defers, downloads nothing, and never says "staging".
    let deferred = await updater.check(
      sessionIsOpen: true, willStage: { version in events.add("will_stage:\(version)") })
    #expect(deferred == .deferredWhileRecording(version: "0.1.23"))
    #expect(events.all.isEmpty)

    // Idle: the hook hears the version BEFORE the first byte is asked for.
    let staged = await updater.check(
      sessionIsOpen: false, willStage: { version in events.add("will_stage:\(version)") })
    #expect(events.all == ["will_stage:0.1.23", "download"])
    guard case .stopped(let outcome, _) = staged else {
      Issue.record("expected the failing download to stop the update, got \(staged)")
      return
    }
    #expect(outcome == .downloadFailed)
  }

  @Test func checkUpdateNowBypassesTheIntervalAndSaysWhatItFound() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let fetcher = CountingVerbFetcher(version: "0.1.22")
    let remote = VerbRemote(polls: ["[]", Self.command("cmd_check", "check_update_now", nil)])
    let engine = try await Self.engine(
      root: root, remote: remote,
      updater: { configuration, _, root in
        RoomUpdater(
          rootURL: root,
          residentBundleURL: root.appendingPathComponent("EvenScribe Room Recorder.app"),
          runningVersion: "0.1.22", channel: configuration.updateChannel, fetcher: fetcher,
          downloader: RecordingFailingDownloader(events: EventLog()), runner: RefusingRunner(),
          log: { _ in })
      })

    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.acks.count == 1 }
    task.cancel()
    try await task.value

    // The launch check on the first poll, then the forced one on the second, seconds apart.
    #expect(await fetcher.count == 2)
    let ack = try #require(await remote.acks.first)
    #expect(ack.ok)
    #expect(ack.verb?.deferred == false)
    #expect(ack.verb?.offeredVersion == nil)
    // The engine's own stamp: internet date-time with fractional seconds, as every other it sends.
    let stamp = ISO8601DateFormatter()
    stamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    #expect(ack.verb?.checkedAt.flatMap { stamp.date(from: $0) } != nil)
  }

  /// An update that goes ahead is acked from INSIDE the check, before the first byte is downloaded —
  /// the swap script it would spawn boots this process out at once — and acked exactly once.
  @Test func checkUpdateNowAcksBeforeStagingWhenAnUpdateGoesAhead() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let events = EventLog()
    let remote = VerbRemote(
      polls: ["[]", Self.command("cmd_go", "check_update_now", nil)], events: events)
    let offered = CountingVerbFetcher(version: "0.1.22")
    let engine = try await Self.engine(
      root: root, remote: remote, events: events,
      updater: { configuration, _, root in
        RoomUpdater(
          rootURL: root,
          residentBundleURL: root.appendingPathComponent("EvenScribe Room Recorder.app"),
          // Running 0.1.21 against a channel that offers 0.1.22: an update, idle, not held.
          runningVersion: "0.1.21", channel: configuration.updateChannel, fetcher: offered,
          downloader: RecordingFailingDownloader(events: events), runner: RefusingRunner(),
          log: { _ in })
      })
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.acks.contains { $0.id == "cmd_go" } }
    try await R4Fixture.waitUntil { events.all.filter { $0 == "download" }.count >= 2 }
    task.cancel()
    try await task.value

    let acks = await remote.acks.filter { $0.id == "cmd_go" }
    #expect(acks.count == 1)
    #expect(acks.first?.ok == true)
    #expect(acks.first?.verb?.offeredVersion == "0.1.22")
    #expect(acks.first?.verb?.deferred == false)
    // The launch check downloads first (poll 1); on poll 2 the ack precedes that check's download.
    let order = events.all.filter { $0 == "download" || $0 == "ack:cmd_go" }
    #expect(order.prefix(3) == ["download", "ack:cmd_go", "download"])
  }

  @Test func checkUpdateNowWithoutAnUpdaterSaysSoAndArgsAreRefused() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = VerbRemote(polls: [
      Self.command("cmd_1", "check_update_now", nil),
      Self.command("cmd_2", "check_update_now", #"{"force":true}"#),
    ])
    let engine = try await Self.engine(root: root, remote: remote)
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.acks.count == 2 }
    task.cancel()
    try await task.value
    let acks = await remote.acks
    #expect(acks.map(\.error) == ["update_unavailable", "bad_args"])
    #expect(acks.allSatisfy { !$0.ok })
  }

  // -------------------------------------------------------------------------
  // restart_engine — refused while open unless forced; ack, then a relaunchable exit
  // -------------------------------------------------------------------------

  @Test func restartRefusesWhileASessionIsOpenUnlessForced() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let events = EventLog()
    let remote = VerbRemote(
      activeSessionJSON: R4Fixture.recordingActiveJSON,
      polls: [
        Self.command("cmd_plain", "restart_engine", nil),
        Self.command("cmd_force", "restart_engine", #"{"force":true}"#),
      ],
      events: events)
    let engine = try await Self.engine(root: root, remote: remote, events: events)

    try await engine.run()  // returns on its own: the forced restart ends the loop

    let acks = await remote.acks
    #expect(acks.count == 2)
    #expect(acks[0].id == "cmd_plain")
    #expect(!acks[0].ok)
    #expect(acks[0].error == "session_open")
    #expect(acks[1].id == "cmd_force")
    #expect(acks[1].ok)
    #expect(acks[1].verb?.restarting == true)
    // Ack first, then the exit — and the exit is the relaunchable one, never 0.
    #expect(events.all.suffix(2) == ["ack:cmd_force", "exit:\(RoomEngine.restartExitCode)"])
    #expect(RoomEngine.restartExitCode != 0)
    // The session was NOT ended: the relaunched process reconciles it and records on.
    #expect(!(await remote.patches).contains(.end))
  }

  @Test func restartWhileIdleAcksThenExits() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let events = EventLog()
    let remote = VerbRemote(polls: [Self.command("cmd_r", "restart_engine", "{}")], events: events)
    let engine = try await Self.engine(root: root, remote: remote, events: events)
    try await engine.run()
    #expect(events.all == ["ack:cmd_r", "exit:75"])
    #expect(await remote.pollCount == 1)  // no poll after the restart was armed
  }

  @Test func aRestartWhoseAckNeverLandsDoesNotRestart() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let events = EventLog()
    let remote = VerbRemote(
      polls: [Self.command("cmd_r", "restart_engine", nil)], events: events, failAcks: true)
    let engine = try await Self.engine(root: root, remote: remote, events: events)
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.pollCount >= 3 }
    task.cancel()
    try await task.value
    #expect(!events.all.contains { $0.hasPrefix("exit:") })
    #expect(await remote.ackAttempts == 3)
  }

  // -------------------------------------------------------------------------
  // report_diag
  // -------------------------------------------------------------------------

  @Test func reportDiagNeverCarriesTheSessionOrKeychainMaterial() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let log = [
      "room-recorder: canary passed for 0.1.21",
      "room-recorder: Cookie: eta_room_session=abc.def.ghi",
      "room-recorder: poll ok",
      "room-recorder: SCRIBE_MCP_TOKEN=should-never-leave",
      "room-recorder: recording device set to device-b by the desk (was device-a)",
    ].joined(separator: "\n") + "\n"
    try Data(log.utf8).write(to: root.appendingPathComponent("launchd.log"))
    let remote = VerbRemote(polls: [Self.command("cmd_diag", "report_diag", #"{"log_lines":3}"#)])
    let engine = try await Self.engine(root: root, remote: remote)

    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.acks.count == 1 }
    task.cancel()
    try await task.value

    let ack = try #require(await remote.acks.first)
    #expect(ack.ok)
    let diag = try #require(ack.verb?.diag)
    let text = String(decoding: try JSONEncoder().encode(diag), as: UTF8.self)
    // The engine was loaded with the fixture session in memory; none of it may leave.
    for forbidden in [
      "test.session.jwt", "eta_room_session", "etaRoomSession", "commandVerifyKey", "SCRIBE_MCP_TOKEN",
      "abc.def.ghi", "should-never-leave",
    ] {
      #expect(!text.contains(forbidden), "\(forbidden) leaked into report_diag")
    }
    guard case .object(let report) = diag else {
      Issue.record("diag is not an object")
      return
    }
    #expect(
      report["log_lines"]
        == .array([
          .string("room-recorder: poll ok"), .string("[redacted]"),
          .string("room-recorder: recording device set to device-b by the desk (was device-a)"),
        ]))
    guard case .array(let devices) = report["input_devices"] else {
      Issue.record("no input_devices")
      return
    }
    #expect(devices.count == 3)
    #expect(report["tapewriter_version"] == .string("fake-helper --version"))
    #expect(report["ffmpeg_version"] == .string("fake-helper -version"))
    guard case .object(let config) = report["config"] else {
      Issue.record("no config")
      return
    }
    #expect(config["device_uid"] == .string("device-a"))
    #expect(config["eta_room_session"] == nil)
  }

  @Test func reportDiagDefaultsToAHundredLinesAndRefusesBadArgs() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let log = (1...150).map { "line \($0)" }.joined(separator: "\n") + "\n"
    try Data(log.utf8).write(to: root.appendingPathComponent("launchd.log"))
    let remote = VerbRemote(polls: [
      Self.command("cmd_default", "report_diag", nil),
      Self.command("cmd_big", "report_diag", #"{"log_lines":501}"#),
      Self.command("cmd_key", "report_diag", #"{"lines":5}"#),
      Self.command("cmd_frac", "report_diag", #"{"log_lines":2.5}"#),
    ])
    let engine = try await Self.engine(root: root, remote: remote)
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.acks.count == 4 }
    task.cancel()
    try await task.value
    let acks = await remote.acks
    guard case .object(let report)? = acks[0].verb?.diag, case .array(let lines)? = report["log_lines"]
    else {
      Issue.record("no report")
      return
    }
    #expect(lines.count == 100)
    #expect(lines.first == .string("line 51"))
    #expect(lines.last == .string("line 150"))
    #expect(acks.dropFirst().map(\.error) == ["bad_args", "bad_args", "bad_args"])
  }

  @Test func aLogLineIsBoundedAndALongLogIsReadFromItsTail() throws {
    let root = R4Fixture.temporaryRoot()
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("launchd.log")
    let long = String(repeating: "x", count: 1_000)
    // ~600 KB: more than the 256 KB window, so the head of the file is never read.
    let body = (1...600).map { "\($0) \(long)" }.joined(separator: "\n") + "\nlast line\n"
    try Data(body.utf8).write(to: url)
    let tail = RoomEngine.logTail(url, lines: 3)
    #expect(tail.count == 3)
    #expect(tail.last == "last line")
    #expect(tail[0].count == RoomEngine.reportDiagLineMax)
    #expect(RoomEngine.logTail(url, lines: 0).isEmpty)
    #expect(RoomEngine.redactedLogLine("Authorization: Bearer x") == "[redacted]")
  }

  // -------------------------------------------------------------------------
  // channelLocked (D1 amended)
  // -------------------------------------------------------------------------

  @Test func channelLockedIgnoresTheAssignedChannel() throws {
    func mac(_ channel: String, locked: Bool) throws -> RoomConfiguration {
      try RoomConfiguration(
        origin: #require(URL(string: "https://eta.test")), roomSlug: "home-office",
        deviceUID: "device-a", tapewriterPath: "/x/tapewriter", ffmpegPath: "/x/ffmpeg",
        updateChannel: channel, channelLocked: locked)
    }
    // Unlocked, the server may now move a Mac either way.
    var unlockedStable = try mac("stable", locked: false)
    let movedToTest = unlockedStable.applyServerAssignedChannel("test")
    #expect(movedToTest)
    #expect(unlockedStable.updateChannel == "test")
    var unlockedTest = try mac("test", locked: false)
    let movedToStable = unlockedTest.applyServerAssignedChannel("stable")
    #expect(movedToStable)
    // Locked, it moves for nothing the server says.
    for (channel, assigned) in [("stable", "test"), ("test", "stable")] {
      var locked = try mac(channel, locked: true)
      let moved = locked.applyServerAssignedChannel(assigned)
      #expect(!moved)
      #expect(locked.updateChannel == channel)
    }
    // Absent in config.json is unlocked; present round-trips through the one writer.
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let persistence = RoomPersistence(root: root)
    try persistence.saveConfiguration(try mac("test", locked: true))
    #expect(try persistence.loadConfiguration().channelLocked)
    let legacy =
      #"{"origin":"https://eta.test/","room_slug":"x","device_uid":"d","tapewriter_path":"/t","ffmpeg_path":"/f","update_channel":"test"}"#
    #expect(try !JSONDecoder().decode(RoomConfiguration.self, from: Data(legacy.utf8)).channelLocked)
  }

  @Test func aLockedMacReportsTheLockAndStaysOnItsChannel() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    var configuration = try R4Fixture.configuration()  // on test
    configuration.channelLocked = true
    let remote = VerbRemote(polls: [], assigned: "stable")
    let lines = LockedList<String>()
    let engine = try await Self.engine(
      root: root, remote: remote, configuration: configuration, log: { lines.append($0) })
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.pollCount >= 3 }
    task.cancel()
    try await task.value
    #expect(try RoomPersistence(root: root).loadConfiguration().updateChannel == "test")
    let installs = await remote.installs
    #expect(installs.allSatisfy { $0?.channelLocked == true && $0?.updateChannel == "test" })
    #expect(lines.all.filter { $0.contains("channel locked") }.count == 1)
  }

  // -------------------------------------------------------------------------
  // The heartbeat
  // -------------------------------------------------------------------------

  @Test func thePCMScanCountsFullScaleSamplesAndTimesTheSilence() {
    func pcm(_ samples: [Int16]) -> Data {
      var data = Data()
      for sample in samples { withUnsafeBytes(of: sample.littleEndian) { data.append(contentsOf: $0) } }
      return data
    }
    // 58 is below −55 dBFS, 59 is above it; ±full scale are clips and are loud.
    let scanned = PCMTailMeter.scan(pcm([0, 32767, -32768, 58, 59, 0, 0]), samplesSinceLoud: 0)
    #expect(scanned.clips == 2)
    #expect(scanned.samplesSinceLoud == 2)
    #expect(PCMTailMeter.scan(pcm([0, 0, 58, -58]), samplesSinceLoud: 5).samplesSinceLoud == 9)
    #expect(PCMTailMeter.scan(pcm([0, -59]), samplesSinceLoud: 900).samplesSinceLoud == 0)
    // A trailing odd byte is not a sample.
    #expect(PCMTailMeter.scan(pcm([32767]) + Data([0x7F]), samplesSinceLoud: 0).clips == 1)
  }

  @Test func theMeterReadsOnlyDurableAudioOnceAndCapsItsWindow() throws {
    let root = R4Fixture.temporaryRoot()
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("tape.pcm")
    // One second of digital silence, then one clipped sample.
    var data = Data(count: 16_000 * 2)
    withUnsafeBytes(of: Int16.max.littleEndian) { data.append(contentsOf: $0) }
    try data.write(to: url)
    let meter = PCMTailMeter(url: url)
    #expect(meter.measure(durableSamples: nil) == nil)
    // Only the durable second is read: silent for 1000 ms, nothing clipped.
    #expect(meter.measure(durableSamples: 16_000) == .init(clipCount: 0, silenceMS: 1_000))
    // The next read starts where that one stopped: one clip, which is also loud.
    #expect(meter.measure(durableSamples: 16_001) == .init(clipCount: 1, silenceMS: 0))
    // Nothing new: nothing counted twice.
    #expect(meter.measure(durableSamples: 16_001) == .init(clipCount: 0, silenceMS: 0))

    // Forty seconds of silence in one read: only the last thirty are read and timed.
    let long = root.appendingPathComponent("long.pcm")
    try Data(count: 40 * 16_000 * 2).write(to: long)
    #expect(
      PCMTailMeter(url: long).measure(durableSamples: 40 * 16_000)
        == .init(clipCount: 0, silenceMS: 30_000))
  }

  @Test func theHeartbeatRidesThePollOnlyWhenMeasured() {
    func items(_ fields: InstallPollFields) -> [String: String] {
      Dictionary(uniqueKeysWithValues: fields.queryItems().map { ($0.name, $0.value ?? "") })
    }
    let measured = items(
      InstallPollFields(
        installID: "install_1", tapeAdvancing: true, clipCount: 3, silenceMS: 4_500,
        channelLocked: false))
    #expect(measured["clip_count"] == "3")
    #expect(measured["silence_ms"] == "4500")
    #expect(measured["channel_locked"] == "false")
    let absent = items(InstallPollFields(installID: "install_1", tapeAdvancing: true))
    #expect(absent["clip_count"] == nil)
    #expect(absent["silence_ms"] == nil)
    #expect(absent["channel_locked"] == nil)
    let negative = items(
      InstallPollFields(installID: "install_1", tapeAdvancing: true, clipCount: -1, silenceMS: -5))
    #expect(negative["clip_count"] == nil)
    #expect(negative["silence_ms"] == nil)
  }

  @Test func anIdleRoomsPollCarriesTheLockAndNoAudioMeasures() async throws {
    let root = R4Fixture.temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let remote = VerbRemote(polls: [])
    let engine = try await Self.engine(root: root, remote: remote)
    let task = Task { try await engine.run() }
    try await R4Fixture.waitUntil { await remote.pollCount >= 2 }
    task.cancel()
    try await task.value
    let install = try #require(await remote.installs.first ?? nil)
    #expect(install.channelLocked == false)
    #expect(install.clipCount == nil)
    #expect(install.silenceMS == nil)
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  static func command(_ id: String, _ kind: String, _ args: String?) -> String {
    "[{\"id\":\"\(id)\",\"kind\":\"\(kind)\"\(args.map { ",\"args\":\($0)" } ?? ""),\"created_at\":null}]"
  }

  static func engine(
    root: URL,
    remote: VerbRemote,
    events: EventLog = EventLog(),
    configuration: RoomConfiguration? = nil,
    log: @escaping @Sendable (String) -> Void = { _ in },
    updater: @escaping @Sendable (RoomConfiguration, any RoomEngineRemote, URL) -> RoomUpdater? = {
      _, _, _ in nil
    }
  ) async throws -> RoomEngine {
    try RoomPersistence(root: root).saveConfiguration(configuration ?? R4Fixture.configuration())
    let audio = R4AudioInputs.standard()
    return try await RoomEngine.load(
      rootURL: root,
      enrolmentReader: R4Fixture.enrolled,
      remoteFactory: { _ in remote },
      captureLauncher: R4FakeLauncher(),
      pieceRunner: R4FakeEncoder(),
      updaterFactory: updater,
      log: log,
      audioInputs: audio,
      machineFacts: { uid in audio.facts(forUID: uid) },
      processExit: { code in events.add("exit:\(code)") },
      helperVersion: { _, arguments in "fake-helper \(arguments.joined(separator: " "))" })
  }
}

// MARK: - Doubles

/// A list many threads may append to, read once the engine has stopped.
final class LockedList<Element>: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [Element] = []
  func append(_ item: Element) { lock.withLock { items.append(item) } }
  var all: [Element] { lock.withLock { items } }
}

/// The order things happened in, across the remote and the process exit.
final class EventLog: @unchecked Sendable {
  private let list = LockedList<String>()
  func add(_ event: String) { list.append(event) }
  var all: [String] { list.all }
}

struct VerbAck: Sendable {
  let id: String
  let ok: Bool
  let error: String?
  let verb: OperatorVerbAcknowledgement?
}

/// The server, as the verbs meet it: `polls` is each poll's `commands` array in turn (then `[]`),
/// every poll answers `assigned_channel`, and each ack is recorded with its verb fields.
actor VerbRemote: RoomEngineRemote {
  private let activeSessionJSON: String
  private var polls: [String]
  private let assigned: String?
  private let events: EventLog
  private let failAcks: Bool
  private(set) var acks: [VerbAck] = []
  private(set) var ackAttempts = 0
  private(set) var installs: [InstallPollFields?] = []
  private(set) var patches: [BenchSessionAction] = []

  init(
    activeSessionJSON: String = R4Fixture.idleActiveJSON, polls: [String], assigned: String? = nil,
    events: EventLog = EventLog(), failAcks: Bool = false
  ) {
    self.activeSessionJSON = activeSessionJSON
    self.polls = polls
    self.assigned = assigned
    self.events = events
    self.failAcks = failAcks
  }

  var pollCount: Int { installs.count }

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    try JSONDecoder().decode(ActiveSessionResponse.self, from: Data(activeSessionJSON.utf8))
  }

  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    try JSONDecoder().decode(
      CreateSessionResponse.self,
      from: Data(
        #"{"session":{"id":"bs_new","room_id":"room_1","label":null,"mic_label":"device-a","status":"recording"}}"#
          .utf8))
  }

  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  {
    patches.append(action)
    return try JSONDecoder().decode(BenchOKResponse.self, from: Data(#"{"ok":true}"#.utf8))
  }

  func pollCommands(
    tabID: String, previousPollAt: String?, recordingSessionID: String?, paused: Bool,
    primaryLevels: BenchLevelPair?, install: InstallPollFields?
  ) async throws -> CommandPollResponse {
    installs.append(install)
    let commands = polls.isEmpty ? "[]" : polls.removeFirst()
    let channel = assigned.map { "\"\($0)\"" } ?? "null"
    return try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(
        "{\"ok\":true,\"room_id\":\"room_1\",\"superseded\":false,\"assigned_channel\":\(channel),\"commands\":\(commands)}"
          .utf8))
  }

  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  {
    try await acknowledge(
      commandID: commandID, ok: ok, sessionID: sessionID, error: error, audioInput: nil, verb: nil)
  }

  func acknowledge(
    commandID: String, ok: Bool, sessionID: String?, error: String?,
    audioInput: AudioInputAcknowledgement?
  ) async throws -> CommandAcknowledgement {
    try await acknowledge(
      commandID: commandID, ok: ok, sessionID: sessionID, error: error, audioInput: audioInput,
      verb: nil)
  }

  func acknowledge(
    commandID: String, ok: Bool, sessionID: String?, error: String?,
    audioInput: AudioInputAcknowledgement?, verb: OperatorVerbAcknowledgement?
  ) async throws -> CommandAcknowledgement {
    ackAttempts += 1
    if failAcks { throw RoomEngineError.io("the ack route is down") }
    acks.append(VerbAck(id: commandID, ok: ok, error: error, verb: verb))
    events.add("ack:\(commandID)")
    return R4Remote.acknowledgement(commandID, ok)
  }

  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw CancellationError()
  }

  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  {
    .alreadyVerified
  }
}

struct VerbFetcher: RoomReleaseFetching {
  let version: String
  func fetchRelease(channel: String) async -> RoomReleaseDescriptor? {
    RoomReleaseDescriptor(
      version: version, sha256: String(repeating: "0", count: 64), sizeBytes: 1,
      blobURL: "https://blob.test/room-recorder.zip")
  }
}

actor CountingVerbFetcher: RoomReleaseFetching {
  let version: String
  private(set) var count = 0
  init(version: String) { self.version = version }
  func fetchRelease(channel: String) async -> RoomReleaseDescriptor? {
    count += 1
    return RoomReleaseDescriptor(
      version: version, sha256: String(repeating: "0", count: 64), sizeBytes: 1,
      blobURL: "https://blob.test/room-recorder.zip")
  }
}

struct RecordingFailingDownloader: RoomUpdateDownloading {
  let events: EventLog
  func download(from url: URL) async throws -> Data {
    events.add("download")
    throw RoomUpdateError.download("the test refuses every download")
  }
}

struct RefusingRunner: RoomUpdateCommandRunning {
  func run(_ executable: String, _ arguments: [String]) -> Int32 { 1 }
  func spawnDetached(_ executable: String, _ arguments: [String]) throws {
    throw RoomUpdateError.spawn("the test spawns nothing")
  }
}

/// A URLProtocol stub for this suite's one BenchClient wire test; its own handler, so it cannot
/// race the R4 suite's.
enum VerbStubHTTP {
  nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

  final class StubProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
      do {
        let handler = try #require(VerbStubHTTP.handler)
        let (response, data) = try handler(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !data.isEmpty { client?.urlProtocol(self, didLoad: data) }
        client?.urlProtocolDidFinishLoading(self)
      } catch {
        client?.urlProtocol(self, didFailWithError: error)
      }
    }
    override func stopLoading() {}
  }

  static func client() throws -> BenchClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubProtocol.self]
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    var room = try R4Fixture.configuration()
    room.etaRoomSession = "signed.jwt"
    return BenchClient(configuration: room, session: URLSession(configuration: configuration))
  }

  static func body(_ request: URLRequest) throws -> Data {
    try R4StubHTTP.body(request)
  }

  static func stub(_ request: URLRequest, body: String) -> (HTTPURLResponse, Data) {
    R4StubHTTP.stub(request, body: body)
  }
}
