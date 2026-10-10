import Foundation
import Testing

@testable import RoomRecorderCore

/// 0.1.25 — the schedule rules (a port of tests/unit/room-schedule.test.ts) and auto-start at
/// clinic open. IST wall clock -> instant: 2026-09-28 is a Monday, 2026-09-27 a Sunday.
private func ist(_ day: String, _ hhmm: String) -> Date {
  let f = ISO8601DateFormatter()
  return f.date(from: "\(day)T\(hhmm):00+05:30")!
}

private let orbox = RoomSchedule(
  utcOffsetMinutes: 330,
  windows: [RoomScheduleWindow(days: [0, 1, 2, 3, 4, 5, 6], start: "06:00", end: "02:00")])

@Suite struct RoomScheduleRuleTests {
  @Test func clinicIsSevenDaysEightThirtyToTwentyThirty() {
    let s = RoomSchedule.defaultClinic
    for day in ["2026-09-27", "2026-09-28", "2026-10-03"] {  // Sunday, Monday, Saturday
      #expect(s.activeWindow(at: ist(day, "08:30")) != nil)
      #expect(s.activeWindow(at: ist(day, "20:29")) != nil)
      #expect(s.activeWindow(at: ist(day, "08:29")) == nil)
      #expect(s.activeWindow(at: ist(day, "20:30")) == nil)
    }
    let w = s.activeWindow(at: ist("2026-09-28", "10:00"))!
    #expect(Date(timeIntervalSince1970: Double(w.startMs) / 1000) == ist("2026-09-28", "08:30"))
  }

  @Test func aWindowThatCrossesMidnightIsInsideAtOneThirty() {
    let w = orbox.activeWindow(at: ist("2026-09-29", "01:30"))
    #expect(w != nil)
    #expect(Date(timeIntervalSince1970: Double(w!.startMs) / 1000) == ist("2026-09-28", "06:00"))
    #expect(Date(timeIntervalSince1970: Double(w!.endMs) / 1000) == ist("2026-09-29", "02:00"))
    #expect(orbox.activeWindow(at: ist("2026-09-29", "01:59")) != nil)
    #expect(orbox.activeWindow(at: ist("2026-09-29", "02:00")) == nil)
    #expect(orbox.activeWindow(at: ist("2026-09-29", "05:59")) == nil)
    #expect(orbox.activeWindow(at: ist("2026-09-29", "06:00")) != nil)
  }

  @Test func aClinicWindowDoesNotSpillPastTwentyThirty() {
    #expect(RoomSchedule.defaultClinic.activeWindow(at: ist("2026-09-29", "00:30")) == nil)
  }
}

@Suite struct RoomAutoStartDecisionTests {
  let s = RoomSchedule.defaultClinic
  let inside = ist("2026-09-28", "09:00")
  let windowStart = Int64(ist("2026-09-28", "08:30").timeIntervalSince1970 * 1000)

  @Test func startsOnlyFromReadyInsideTheWindowOncePerWindow() {
    #expect(
      RoomAutoStart.decide(schedule: s, now: inside, phase: .ready, lastStartedWindowMs: nil, disabled: false)
        == .start(windowStartMs: windowStart))
    // already started by hand / paused by the desk / failed / ending: left alone
    for phase: RoomEnginePhase in [.recording, .paused, .failed, .ending, .superseded] {
      #expect(
        RoomAutoStart.decide(schedule: s, now: inside, phase: phase, lastStartedWindowMs: nil, disabled: false)
          == .notDue)
    }
    // ended by the desk after a start in THIS window: not restarted; a start in an EARLIER window does not block
    #expect(
      RoomAutoStart.decide(schedule: s, now: inside, phase: .ready, lastStartedWindowMs: windowStart, disabled: false)
        == .notDue)
    #expect(
      RoomAutoStart.decide(schedule: s, now: inside, phase: .ready, lastStartedWindowMs: windowStart - 86_400_000, disabled: false)
        == .start(windowStartMs: windowStart))
  }

  @Test func neverOutsideTheWindowOrWhenDisabled() {
    #expect(
      RoomAutoStart.decide(schedule: s, now: ist("2026-09-28", "08:29"), phase: .ready, lastStartedWindowMs: nil, disabled: false)
        == .notDue)
    #expect(
      RoomAutoStart.decide(schedule: s, now: inside, phase: .ready, lastStartedWindowMs: nil, disabled: true) == .notDue)
    #expect(RoomAutoStart.disabledBySlug("dietary-1-ab12"))
    #expect(RoomAutoStart.disabledBySlug("room-4-1-after-cards-before-5-494q"))
    #expect(RoomAutoStart.disabledBySlug("Dietary"))
    #expect(!RoomAutoStart.disabledBySlug("opd-4-ortho-778q"))
  }

  @Test func orboxAtOneThirtyWithNothingStartedIsDueAgainstYesterdaysWindow() {
    let at = ist("2026-09-29", "01:30")
    let start = Int64(ist("2026-09-28", "06:00").timeIntervalSince1970 * 1000)
    #expect(
      RoomAutoStart.decide(schedule: orbox, now: at, phase: .ready, lastStartedWindowMs: nil, disabled: false)
        == .start(windowStartMs: start))
    #expect(
      RoomAutoStart.decide(schedule: orbox, now: at, phase: .ready, lastStartedWindowMs: start, disabled: false)
        == .notDue)
  }
}

@Suite(.serialized) struct RoomAutoStartEngineTests {
  private func run(
    clock: Date, enable: Bool = true, prepare: (URL) throws -> Void = { _ in }
  ) async throws -> (creates: Int, launched: [String], root: URL) {
    let root = R4Fixture.temporaryRoot()
    try RoomPersistence(root: root).saveConfiguration(try R4Fixture.configuration())
    try prepare(root)
    let remote = R4Remote(activeSessionJSON: R4Fixture.idleActiveJSON, polls: [])
    let launcher = R4FakeLauncher()
    let engine = try await RoomEngine.load(
      rootURL: root,
      enrolmentReader: R4Fixture.enrolled,
      remoteFactory: { _ in remote },
      captureLauncher: launcher,
      pieceRunner: R4FakeEncoder(),
      updaterFactory: { _, _, _ in nil },
      log: { _ in })
    if enable { await engine.enableAutoStart(clock: { clock }) }
    let task = Task { try await engine.run() }
    try await Task.sleep(nanoseconds: 1_500_000_000)
    task.cancel()
    try await task.value
    return (await remote.createCalls(), launcher.launchedDevices, root)
  }

  @Test func insideTheWindowTheDayStartsByItselfOnce() async throws {
    let r = try await run(clock: ist("2026-09-28", "09:00"))
    defer { try? FileManager.default.removeItem(at: r.root) }
    #expect(r.creates == 1)
    #expect(r.launched == ["device-a"])
    #expect(RoomAutoStartMarker(root: r.root).read() != nil)
  }

  @Test func outsideTheWindowNothingStarts() async throws {
    let r = try await run(clock: ist("2026-09-28", "07:00"))
    defer { try? FileManager.default.removeItem(at: r.root) }
    #expect(r.creates == 0)
    #expect(r.launched.isEmpty)
  }

  @Test func withoutEnableAutoStartNothingStartsWhateverTheClock() async throws {
    let r = try await run(clock: ist("2026-09-28", "09:00"), enable: false)
    defer { try? FileManager.default.removeItem(at: r.root) }
    #expect(r.creates == 0)
  }

  @Test func aDayEndedByTheDeskInThisWindowIsNotRestarted() async throws {
    let start = Int64(ist("2026-09-28", "08:30").timeIntervalSince1970 * 1000)
    let r = try await run(clock: ist("2026-09-28", "12:00")) { root in
      RoomAutoStartMarker(root: root).write(windowStartMs: start)
    }
    defer { try? FileManager.default.removeItem(at: r.root) }
    #expect(r.creates == 0)
  }

  @Test func theKillSwitchFileStopsIt() async throws {
    let r = try await run(clock: ist("2026-09-28", "09:00")) { root in
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      FileManager.default.createFile(atPath: root.appendingPathComponent("auto-start-off").path, contents: Data())
    }
    defer { try? FileManager.default.removeItem(at: r.root) }
    #expect(r.creates == 0)
  }
}
