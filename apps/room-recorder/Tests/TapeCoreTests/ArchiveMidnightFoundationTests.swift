import CryptoKit
import Darwin
import Foundation
import RoomRecorderCore
import Testing

@testable import TapeCore

@Suite(.serialized) struct ArchiveMidnightFoundationTests {
  @Test func istDayIsStrictAndComputesExactNormalYearAndLeapBoundaries() throws {
    let cases = [
      ("2026-08-27", "2026-08-28", "2026-08-27T18:30:00Z"),
      ("2026-12-31", "2027-01-01", "2026-12-31T18:30:00Z"),
      ("2028-02-28", "2028-02-29", "2028-02-28T18:30:00Z"),
      ("2028-02-29", "2028-03-01", "2028-02-29T18:30:00Z"),
    ]
    for (value, next, midnightUTC) in cases {
      let day = try ArchiveISTDay(value)
      #expect(try day.next.description == next)
      #expect(try day.next.previous == day)
      #expect(try day.nextMidnight == isoDate(midnightUTC))
    }
    for invalid in ["2026-2-03", "2026/02/03", "2026-02-30", "2027-02-29", "abcd-ef-gh"] {
      #expect(throws: ArchiveISTDayError.self) { try ArchiveISTDay(invalid) }
    }
    let injected = isoDate("2026-08-27T18:29:59Z")
    #expect(try ArchiveISTDay.current(now: { injected }).description == "2026-08-27")
    #expect(try ArchiveISTDay.nextMidnight(now: { injected }) == isoDate("2026-08-27T18:30:00Z"))
  }

  @Test func dailyIdentityContainsOnlyAuthenticatedNonsecretKeywrapFacts() throws {
    let context = laneContext(date: "2026-08-27", lane: "primary", streamByte: 0x11)
    let inspection = keywrapInspection(context: context, digestByte: 0x21)
    let identity = try ArchiveDailyLaneIdentity(
      context: context,
      expectedInitialSessionSample: 100,
      keywrap: inspection)
    #expect(identity.context == context)
    #expect(identity.keywrapDigestHex == inspection.keywrapDigestHex)
    #expect(identity.expectedInitialSessionSample == 100)

    let wrongContext = laneContext(date: "2026-08-27", lane: "primary", streamByte: 0x12)
    #expect(throws: ArchiveDailyLaneIdentityError.keywrapContextMismatch) {
      try ArchiveDailyLaneIdentity(
        context: wrongContext,
        expectedInitialSessionSample: 100,
        keywrap: inspection)
    }
    #expect(throws: ArchiveDailyLaneIdentityError.invalidKeywrapDigest) {
      try ArchiveDailyLaneIdentity(
        context: context,
        expectedInitialSessionSample: 100,
        keywrapDigestHex: "ABC")
    }
  }

  @Test func authenticatedWitnessesFixTheExactSeamAndRejectEmptyNewOriginMismatch() throws {
    let fixture = try PlanFixture()
    defer { fixture.close() }
    #expect(fixture.plan.primary.oldAuthenticatedFacts.authenticatedSampleEnd == 104)
    #expect(fixture.plan.primary.newAuthenticatedFacts.initialSamplePosition == 104)
    #expect(fixture.plan.primary.newAuthenticatedFacts.recordCount == 0)

    let wrongDirectory = try temporaryDirectory("wrong-empty-origin")
    defer { try? FileManager.default.removeItem(at: wrongDirectory) }
    let wrongContext = fixture.plan.primary.newDay.context
    let wrongStore = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: wrongDirectory.appendingPathComponent("primary.tape"),
      indexURL: wrongDirectory.appendingPathComponent("primary.index"),
      rootKey: Data(repeating: 0xF1, count: 32),
      context: wrongContext,
      initialSamplePosition: 105)
    let wrongSnapshot = try wrongStore.authenticatedSnapshot()
    wrongStore.close()
    let tapeBefore = try Data(contentsOf: wrongDirectory.appendingPathComponent("primary.tape"))
    let indexBefore = try Data(contentsOf: wrongDirectory.appendingPathComponent("primary.index"))
    #expect(
      throws: ArchiveRolloverError.authenticatedBoundaryMismatch(
        laneID: "primary", expected: 104, actual: 105)
    ) {
      try ArchiveRolloverAudioLane(
        oldDay: fixture.plan.primary.oldDay,
        newDay: fixture.plan.primary.newDay,
        nextChunkIndex: 7,
        boundarySample: 104,
        oldAuthenticatedFacts: fixture.plan.primary.oldAuthenticatedFacts,
        newAuthenticatedFacts: wrongSnapshot.authenticatedFacts)
    }
    #expect(
      try Data(contentsOf: wrongDirectory.appendingPathComponent("primary.tape")) == tapeBefore)
    #expect(
      try Data(contentsOf: wrongDirectory.appendingPathComponent("primary.index")) == indexBefore)
    wrongSnapshot.close()
  }

  @Test func plansCoverPrimaryOptionalBackupAndControlAtomically() throws {
    let primaryOnly = try PlanFixture(backup: false)
    defer { primaryOnly.close() }
    #expect(primaryOnly.plan.backup == nil)
    #expect(primaryOnly.plan.primary.oldDay.laneID == "primary")
    #expect(primaryOnly.plan.oldControl.laneID == "_control")
    #expect(primaryOnly.plan.primary.nextChunkIndex == 7)

    let twoLane = try PlanFixture(backup: true)
    defer { twoLane.close() }
    #expect(twoLane.plan.backup?.oldDay.laneID == "backup")
    #expect(twoLane.plan.backup?.nextChunkIndex == 19)
    #expect(twoLane.plan.backup?.oldAuthenticatedFacts.authenticatedSampleEnd == 104)
    #expect(twoLane.plan.commandID != primaryOnly.plan.commandID)

    let distinctBoundaries = try PlanFixture(backup: true, backupBoundary: 106)
    defer { distinctBoundaries.close() }
    #expect(distinctBoundaries.plan.primary.boundarySample == 104)
    #expect(distinctBoundaries.plan.backup?.boundarySample == 106)
    #expect(distinctBoundaries.plan.commandID != twoLane.plan.commandID)

    let backup = try #require(twoLane.plan.backup)
    let reusedDigestIdentity = try ArchiveDailyLaneIdentity(
      context: backup.newDay.context,
      expectedInitialSessionSample: 104,
      keywrapDigestHex: twoLane.plan.primary.newDay.keywrapDigestHex)
    let reusedDigestBackup = try ArchiveRolloverAudioLane(
      oldDay: backup.oldDay,
      newDay: reusedDigestIdentity,
      nextChunkIndex: UInt64(backup.nextChunkIndex),
      boundarySample: 104,
      oldAuthenticatedFacts: backup.oldAuthenticatedFacts,
      newAuthenticatedFacts: backup.newAuthenticatedFacts)
    #expect(throws: ArchiveRolloverError.invalidLaneConfiguration) {
      try ArchiveRolloverPlan(
        sessionID: twoLane.plan.sessionID,
        primary: twoLane.plan.primary,
        backup: reusedDigestBackup,
        oldControl: twoLane.plan.oldControl,
        newControl: twoLane.plan.newControl)
    }

    let substitutedControl = try controlIdentity(
      date: "2026-08-28", room: "room_other", streamByte: 0x76, digestByte: 0x86)
    #expect(throws: ArchiveDailyControlIdentityError.contextSubstitution) {
      try ArchiveRolloverPlan(
        sessionID: twoLane.plan.sessionID,
        primary: twoLane.plan.primary,
        backup: twoLane.plan.backup,
        oldControl: twoLane.plan.oldControl,
        newControl: substitutedControl)
    }
  }

  @Test func rolloverPlanCodecIsStrictDeterministicAndCoversOptionalBackup() throws {
    for hasBackup in [false, true] {
      let fixture = try PlanFixture(backup: hasBackup)
      defer { fixture.close() }
      let encoded = try ArchiveRolloverPlanCodec.encode(fixture.plan)
      #expect(try ArchiveRolloverPlanCodec.encode(fixture.plan) == encoded)
      #expect(try ArchiveRolloverPlanCodec.decode(encoded) == fixture.plan)
      #expect(encoded.count <= ArchiveRolloverPlanCodec.maximumEncodedByteCount)

      var trailing = encoded
      trailing.append(0)
      #expect(throws: ArchiveRolloverPlanCodecError.self) {
        try ArchiveRolloverPlanCodec.decode(trailing)
      }
      var substituted = encoded
      substituted[substituted.count - 1] ^= 1
      #expect(throws: (any Error).self) {
        try ArchiveRolloverPlanCodec.decode(substituted)
      }
    }
  }

  @Test func rolloverPreparationIsStrictVersionedAndBindsEveryWitness() throws {
    let fixture = try PlanFixture()
    defer { fixture.close() }
    let prepared = try preparation(for: fixture.plan)
    let encoded = try ArchiveRolloverPreparationCodec.encode(prepared)
    let targetISTDay = try fixture.plan.primary.newDay.istDay

    #expect(prepared.commandID.count == 64)
    #expect(prepared.commandID == prepared.commandID.lowercased())
    #expect(prepared.sessionSampleStart == fixture.plan.primary.oldDay.expectedInitialSessionSample)
    #expect(prepared.targetISTDay == targetISTDay)
    #expect(try ArchiveRolloverPreparationCodec.encode(prepared) == encoded)
    #expect(try ArchiveRolloverPreparationCodec.decode(encoded) == prepared)

    var trailing = encoded
    trailing.append(0)
    #expect(throws: ArchiveRolloverPreparationCodecError.self) {
      try ArchiveRolloverPreparationCodec.decode(trailing)
    }
    var substitutedID = encoded
    substitutedID[14] ^= 1
    #expect(throws: ArchiveRolloverPreparationCodecError.commandIDMismatch) {
      try ArchiveRolloverPreparationCodec.decode(substitutedID)
    }

    let earlierSessionStart = try preparation(for: fixture.plan, sessionSampleStart: 99)
    #expect(earlierSessionStart.commandID != prepared.commandID)
    #expect(throws: ArchiveRolloverPreparationError.invalidSessionSampleStart) {
      try preparation(for: fixture.plan, sessionSampleStart: 105)
    }
    #expect(throws: ArchiveRolloverPreparationError.nonAdjacentTargetDay) {
      try ArchiveRolloverPreparation(
        sessionID: prepared.sessionID,
        sessionSampleStart: prepared.sessionSampleStart,
        oldDay: prepared.oldDay,
        boundarySample: prepared.boundarySample,
        nextChunkIndex: prepared.nextChunkIndex,
        oldAuthenticatedFacts: prepared.oldAuthenticatedFacts,
        targetISTDay: ArchiveISTDay("2026-08-29"))
    }
  }

  @Test func preparationPayloadIsCanonicalTerminalAndRetainedByReplay() throws {
    let fixture = try PlanFixture()
    defer { fixture.close() }
    let preparation = try preparation(for: fixture.plan)
    let payload = try ArchiveControlPayload(
      commandID: preparation.commandID,
      commandKind: .rolloverPreparation,
      sessionID: preparation.sessionID,
      priorState: nil,
      newState: .rolloverPreparation,
      atMonoNS: 8,
      atWallNS: 9,
      error: nil,
      rolloverPreparation: preparation)
    let encoded = try ArchiveControlPayloadCodec.encode(payload)

    #expect(String(decoding: encoded, as: UTF8.self).contains("\"rollover_preparation\":"))
    #expect(try ArchiveControlPayloadCodec.decode(encoded) == payload)
    #expect(
      try ArchiveControlReplay.validate([payload])[preparation.commandID]?.rolloverPreparation
        == preparation)
    #expect(
      throws: ArchiveControlPayloadError.invalidTransition(
        commandKind: .rolloverPreparation,
        priorState: .rolloverPreparation,
        newState: .rolloverPreparation)
    ) {
      try ArchiveControlPayload(
        commandID: preparation.commandID,
        commandKind: .rolloverPreparation,
        sessionID: preparation.sessionID,
        priorState: .rolloverPreparation,
        newState: .rolloverPreparation,
        atMonoNS: 10,
        atWallNS: 10,
        error: nil,
        rolloverPreparation: preparation)
    }
    #expect(
      throws: ArchiveControlPayloadError.invalidRolloverPreparation(
        commandID: preparation.commandID)
    ) {
      try ArchiveControlPayload(
        commandID: preparation.commandID,
        commandKind: .rollover,
        sessionID: preparation.sessionID,
        priorState: nil,
        newState: .rolloverIntent,
        atMonoNS: 10,
        atWallNS: 10,
        error: nil,
        rolloverPreparation: preparation)
    }
  }

  @Test func rolloverIntentAtomicallyCarriesTheCanonicalPlan() throws {
    let fixture = try PlanFixture(backup: true)
    defer { fixture.close() }
    let payload = try ArchiveControlPayload(
      commandID: fixture.plan.commandID,
      commandKind: .rollover,
      sessionID: fixture.plan.sessionID,
      priorState: nil,
      newState: .rolloverIntent,
      atMonoNS: 10,
      atWallNS: 20,
      error: nil,
      rolloverPlan: fixture.plan)
    let encoded = try ArchiveControlPayloadCodec.encode(payload)
    #expect(String(decoding: encoded, as: UTF8.self).contains("\"rollover_plan\":"))
    #expect(try ArchiveControlPayloadCodec.decode(encoded) == payload)
    #expect(
      try ArchiveControlReplay.validate([payload])[fixture.plan.commandID]?.rolloverPlan
        == fixture.plan)

    let legacy = try ArchiveControlPayload(
      commandID: fixture.plan.commandID,
      commandKind: .rollover,
      sessionID: fixture.plan.sessionID,
      priorState: nil,
      newState: .rolloverIntent,
      atMonoNS: 10,
      atWallNS: 20,
      error: nil)
    #expect(
      throws: ArchiveControlPayloadError.missingRolloverPlan(
        commandID: fixture.plan.commandID)
    ) {
      try ArchiveControlReplay.validate([legacy])
    }
  }

  @Test func roomControlJournalRecoversThePersistedPlanAfterReopen() throws {
    let fixture = try PlanFixture()
    defer { fixture.close() }
    var control = try fixture.openControlStore()
    var journal: ArchiveRoomControlJournal? = ArchiveRoomControlJournal(store: control)
    let recovered = try journal!.advance(
      RoomControlTransition(
        commandID: fixture.plan.commandID,
        commandKind: .rollover,
        sessionID: fixture.plan.sessionID,
        priorState: nil,
        newState: .rolloverIntent,
        rolloverPlan: fixture.plan))
    #expect(recovered.rolloverPlan == fixture.plan)
    _ = try journal!.advance(
      RoomControlTransition(
        commandID: fixture.plan.commandID,
        commandKind: .rollover,
        sessionID: fixture.plan.sessionID,
        priorState: .rolloverIntent,
        newState: .oldDayFinalReserved))
    journal = nil

    control = try fixture.openControlStore()
    journal = ArchiveRoomControlJournal(store: control)
    #expect(try journal!.recover()[fixture.plan.commandID]?.rolloverPlan == fixture.plan)
    #expect(try journal!.recover()[fixture.plan.commandID]?.state == .oldDayFinalReserved)
    journal = nil
  }

  @Test func commandIDBindsEveryPlanCategoryAndSubstitutionCannotResumeHistory() throws {
    let baseline = try PlanFixture()
    defer { baseline.close() }
    let variants = try [
      PlanFixture(sessionID: "bs_other"),
      PlanFixture(sessionSampleStart: 99),
      PlanFixture(boundary: 105),
      PlanFixture(oldDate: "2026-08-28", newDate: "2026-08-29"),
      PlanFixture(room: "room_other"),
      PlanFixture(device: "device_other"),
      PlanFixture(primaryNextChunk: 8),
      PlanFixture(streamOffset: 10),
      PlanFixture(digestOffset: 10),
      PlanFixture(backup: true),
    ]
    defer {
      for variant in variants { variant.close() }
    }
    #expect(variants.allSatisfy { $0.plan.commandID != baseline.plan.commandID })
    #expect(baseline.plan.commandID.count == 64)
    #expect(baseline.plan.commandID == baseline.plan.commandID.lowercased())
    let baselinePreparation = try preparation(for: baseline.plan)
    #expect(baseline.plan.preparationID == baselinePreparation.commandID)
    #expect(throws: ArchiveRolloverError.preparationMismatch) {
      try ArchiveRolloverPlan(
        sessionID: baseline.plan.sessionID,
        sessionSampleStart: baseline.plan.sessionSampleStart,
        preparationID: String(repeating: "0", count: 64),
        primary: baseline.plan.primary,
        backup: baseline.plan.backup,
        oldControl: baseline.plan.oldControl,
        newControl: baseline.plan.newControl)
    }

    var control = try baseline.openControlStore()
    #expect(throws: MidnightCrash.self) {
      try ArchiveRolloverCoordinator.resume(
        plan: baseline.plan,
        controlStore: control,
        effects: crashingBeforeFirstEffect(),
        clock: MidnightClock().value)
    }
    control.close()
    control = try baseline.openControlStore()
    #expect(
      try ArchiveRolloverCoordinator.recoverPendingPlan(controlStore: control) == baseline.plan)
    for variant in variants {
      #expect(throws: ArchiveRolloverError.planHistoryMismatch) {
        try ArchiveRolloverCoordinator.resume(
          plan: variant.plan,
          controlStore: control,
          effects: unusedEffects(),
          clock: MidnightClock().value)
      }
    }
    #expect(control.scanResult.records.count == 1)
    control.close()
  }

  @Test func processCrashRetriesFreshDurableEffectsWithoutDuplicateExecution() throws {
    for crashKind in ArchiveRolloverEffectKind.allTestCases {
      let fixture = try PlanFixture(label: "crash-\(crashKind.rawValue)")
      defer { fixture.close() }
      let effectsDirectory = fixture.directory.appendingPathComponent("effects", isDirectory: true)
      try FileManager.default.createDirectory(
        at: effectsDirectory, withIntermediateDirectories: false)
      let clock = MidnightClock()
      var control = try fixture.openControlStore()
      #expect(throws: MidnightCrash.self) {
        try ArchiveRolloverCoordinator.resume(
          plan: fixture.plan,
          controlStore: control,
          effects: DiskRolloverEffects(directory: effectsDirectory, crashKind: crashKind).value,
          clock: clock.value)
      }
      control.close()

      let hashesBefore = try durableEffectHashes(effectsDirectory)
      control = try fixture.openControlStore()
      #expect(
        try ArchiveRolloverCoordinator.resumePersisted(
          controlStore: control,
          effects: DiskRolloverEffects(directory: effectsDirectory, crashKind: nil).value,
          clock: clock.value) == .rolloverComplete)
      #expect(
        try durableEffectHashes(effectsDirectory)
          == hashesBefore.merging(
            try durableEffectHashes(effectsDirectory), uniquingKeysWith: { _, new in new }))
      #expect(try durableMarkerCount(effectsDirectory) == 3)
      #expect(try invocationCount(effectsDirectory, kind: crashKind) == 2)
      for kind in ArchiveRolloverEffectKind.allTestCases where kind != crashKind {
        #expect(try invocationCount(effectsDirectory, kind: kind) == 1)
      }
      #expect(control.scanResult.records.count == 5)
      control.close()
    }
  }

  @Test func coordinatorRecordsAuthenticationAndIOFailuresAndStops() throws {
    for (failure, expected) in [
      (
        ArchiveRolloverEffectFailure.authenticationFailed,
        ArchiveControlFailure.authenticationFailed
      ),
      (ArchiveRolloverEffectFailure.internalIOFailed, ArchiveControlFailure.internalIOFailed),
    ] {
      let fixture = try PlanFixture(label: "failure-\(expected.rawValue)")
      defer { fixture.close() }
      let control = try fixture.openControlStore()
      let effects = ArchiveRolloverEffects(
        reserveOldDayFinal: { _ in throw failure },
        closeOldDayFiles: { _ in throw failure },
        makeNewDayFilesDurable: { _ in throw failure })
      #expect(throws: ArchiveRolloverError.effectFailed(expected)) {
        try ArchiveRolloverCoordinator.resume(
          plan: fixture.plan,
          controlStore: control,
          effects: effects,
          clock: MidnightClock().value)
      }
      let payloads = try control.scanResult.records.map {
        try ArchiveControlPayloadCodec.decode($0.plaintext)
      }
      #expect(payloads.map(\.newState) == [.rolloverIntent, .rolloverFailed])
      #expect(payloads.last?.error == expected)
      control.close()
    }
  }

  @Test func duplicatedSnapshotKeepsWriterFlockAfterWriterCloseUntilSnapshotClose() throws {
    let directory = try temporaryDirectory("snapshot-flock")
    defer { try? FileManager.default.removeItem(at: directory) }
    let tape = directory.appendingPathComponent("primary.tape")
    let index = directory.appendingPathComponent("primary.index")
    let context = laneContext(date: "2026-08-27", lane: "primary", streamByte: 0x91)
    let root = Data(repeating: 0x92, count: 32)
    let writer = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: tape, indexURL: index, rootKey: root, context: context)
    _ = try writer.appendPCM(pcm([1, 2]), observation: observation())
    let first = try writer.authenticatedSnapshot()
    let second = try writer.authenticatedSnapshot()
    writer.close()

    #expect(throws: ArchiveLanePersistenceError.self) {
      try ArchiveLaneStore.openRecoveringForAppend(
        tapeURL: tape, indexURL: index, rootKey: root, context: context)
    }
    first.close()
    #expect(throws: ArchiveLanePersistenceError.self) {
      try ArchiveLaneStore.openRecoveringForAppend(
        tapeURL: tape, indexURL: index, rootKey: root, context: context)
    }
    second.close()
    let reopened = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: tape, indexURL: index, rootKey: root, context: context)
    reopened.close()
  }

  @Test func overflowWrongRootAndNonzeroBoundsFailClosedWithoutMutation() throws {
    let directory = try temporaryDirectory("fail-closed")
    defer { try? FileManager.default.removeItem(at: directory) }
    let tape = directory.appendingPathComponent("primary.tape")
    let index = directory.appendingPathComponent("primary.index")
    let context = laneContext(date: "2026-08-28", lane: "primary", streamByte: 0xA1)
    let root = Data(repeating: 0xA2, count: 32)
    let store = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: tape,
      indexURL: index,
      rootKey: root,
      context: context,
      initialSamplePosition: UInt64.max)
    let tapeBefore = try Data(contentsOf: tape)
    let indexBefore = try Data(contentsOf: index)
    #expect(throws: (any Error).self) {
      try store.appendPCM(pcm([1]), observation: observation())
    }
    #expect(try Data(contentsOf: tape) == tapeBefore)
    #expect(try Data(contentsOf: index) == indexBefore)
    store.close()
    let bounded = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: tape,
      indexURL: index,
      rootKey: root,
      context: context,
      initialSamplePosition: UInt64.max)
    let snapshot = try bounded.authenticatedSnapshot()
    #expect(
      throws: ArchiveLanePersistenceError.invalidReadRange(start: UInt64.max - 1, end: UInt64.max)
    ) {
      try snapshot.readPCMRange(sampleStart: UInt64.max - 1, sampleEnd: UInt64.max)
    }
    snapshot.close()
    bounded.close()

    let nonemptyTape = directory.appendingPathComponent("nonempty.tape")
    let nonemptyIndex = directory.appendingPathComponent("nonempty.index")
    let nonempty = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: nonemptyTape,
      indexURL: nonemptyIndex,
      rootKey: root,
      context: context,
      initialSamplePosition: 100)
    _ = try nonempty.appendPCM(pcm([1]), observation: observation())
    nonempty.close()
    let nonemptyTapeBefore = try Data(contentsOf: nonemptyTape)
    let nonemptyIndexBefore = try Data(contentsOf: nonemptyIndex)
    #expect(throws: ArchiveCryptoError.authenticationFailed) {
      try ArchiveLaneStore.inspect(
        tapeURL: nonemptyTape,
        indexURL: nonemptyIndex,
        rootKey: Data(repeating: 0xFF, count: 32),
        context: context,
        initialSamplePosition: 100)
    }
    #expect(try Data(contentsOf: nonemptyTape) == nonemptyTapeBefore)
    #expect(try Data(contentsOf: nonemptyIndex) == nonemptyIndexBefore)
  }
}

private final class PlanFixture {
  let directory: URL
  let plan: ArchiveRolloverPlan
  private var snapshots: [ArchiveLaneStore.AuthenticatedSnapshot]

  init(
    label: String = UUID().uuidString,
    sessionID: String = "bs_same_session",
    sessionSampleStart: UInt64? = nil,
    boundary: UInt64 = 104,
    oldDate: String = "2026-08-27",
    newDate: String = "2026-08-28",
    room: String = "room_1",
    device: String = "device_1",
    primaryNextChunk: UInt64 = 7,
    backup: Bool = false,
    backupBoundary: UInt64? = nil,
    streamOffset: UInt8 = 0,
    digestOffset: UInt8 = 0
  ) throws {
    directory = try temporaryDirectory("plan-\(label)")
    var retained: [ArchiveLaneStore.AuthenticatedSnapshot] = []
    let primary = try Self.audioLane(
      directory: directory,
      lane: "primary",
      oldDate: oldDate,
      newDate: newDate,
      room: room,
      device: device,
      boundary: boundary,
      nextChunk: primaryNextChunk,
      streamBase: 0x11 &+ streamOffset,
      digestBase: 0x21 &+ digestOffset,
      retained: &retained)
    let backupLane =
      try backup
      ? Self.audioLane(
        directory: directory,
        lane: "backup",
        oldDate: oldDate,
        newDate: newDate,
        room: room,
        device: device,
        boundary: backupBoundary ?? boundary,
        nextChunk: 19,
        streamBase: 0x31 &+ streamOffset,
        digestBase: 0x41 &+ digestOffset,
        retained: &retained)
      : nil
    let oldControl = try controlIdentity(
      date: oldDate, room: room,
      streamByte: 0x51 &+ streamOffset, digestByte: 0x61 &+ digestOffset)
    let newControl = try controlIdentity(
      date: newDate, room: room,
      streamByte: 0x52 &+ streamOffset, digestByte: 0x62 &+ digestOffset)
    plan = try ArchiveRolloverPlan(
      sessionID: sessionID,
      sessionSampleStart: sessionSampleStart,
      primary: primary,
      backup: backupLane,
      oldControl: oldControl,
      newControl: newControl)
    snapshots = retained
  }

  func openControlStore() throws -> ArchiveDerivedStore {
    try ArchiveDerivedStore.openRecoveringForAppend(
      url: directory.appendingPathComponent("control.ctl"),
      purpose: .control,
      rootKey: Data(repeating: 0xC1, count: 32),
      context: plan.oldControl.context,
      validator: { try ArchiveControlPayloadCodec.validateRecord($0) })
  }

  func close() {
    for snapshot in snapshots { snapshot.close() }
    snapshots.removeAll()
    try? FileManager.default.removeItem(at: directory)
  }

  private static func audioLane(
    directory: URL,
    lane: String,
    oldDate: String,
    newDate: String,
    room: String,
    device: String,
    boundary: UInt64,
    nextChunk: UInt64,
    streamBase: UInt8,
    digestBase: UInt8,
    retained: inout [ArchiveLaneStore.AuthenticatedSnapshot]
  ) throws -> ArchiveRolloverAudioLane {
    let oldContext = laneContext(
      date: oldDate, lane: lane, streamByte: streamBase, room: room, device: device)
    let newContext = laneContext(
      date: newDate, lane: lane, streamByte: streamBase &+ 1, room: room, device: device)
    let oldIdentity = try dailyIdentity(
      context: oldContext, digestByte: digestBase, initial: 100)
    let newIdentity = try dailyIdentity(
      context: newContext, digestByte: digestBase &+ 1, initial: boundary)
    let laneDirectory = directory.appendingPathComponent(lane, isDirectory: true)
    try FileManager.default.createDirectory(at: laneDirectory, withIntermediateDirectories: false)
    let oldStore = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: laneDirectory.appendingPathComponent("old.tape"),
      indexURL: laneDirectory.appendingPathComponent("old.index"),
      rootKey: Data(repeating: streamBase, count: 32),
      context: oldContext,
      initialSamplePosition: 100)
    guard boundary > 100, boundary - 100 <= UInt64(Int.max) else {
      throw ArchiveRolloverError.authenticatedBoundaryMismatch(
        laneID: lane, expected: 101, actual: boundary)
    }
    _ = try oldStore.appendPCM(
      pcm(Array(repeating: 1, count: Int(boundary - 100))), observation: observation())
    let oldSnapshot = try oldStore.authenticatedSnapshot()
    oldStore.close()
    let newStore = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: laneDirectory.appendingPathComponent("new.tape"),
      indexURL: laneDirectory.appendingPathComponent("new.index"),
      rootKey: Data(repeating: streamBase &+ 1, count: 32),
      context: newContext,
      initialSamplePosition: boundary)
    let newSnapshot = try newStore.authenticatedSnapshot()
    newStore.close()
    retained.append(contentsOf: [oldSnapshot, newSnapshot])
    return try ArchiveRolloverAudioLane(
      oldDay: oldIdentity,
      newDay: newIdentity,
      nextChunkIndex: nextChunk,
      boundarySample: boundary,
      oldAuthenticatedFacts: oldSnapshot.authenticatedFacts,
      newAuthenticatedFacts: newSnapshot.authenticatedFacts)
  }
}

private struct MidnightCrash: Error, ArchiveRolloverProcessCrashSignal {}

private struct DiskRolloverEffects {
  let directory: URL
  let crashKind: ArchiveRolloverEffectKind?

  var value: ArchiveRolloverEffects {
    ArchiveRolloverEffects(
      reserveOldDayFinal: { try perform(.reserveOldDayFinal, plan: $0) },
      closeOldDayFiles: { try perform(.closeOldDayFiles, plan: $0) },
      makeNewDayFilesDurable: { try perform(.makeNewDayFilesDurable, plan: $0) })
  }

  private func perform(
    _ kind: ArchiveRolloverEffectKind,
    plan: ArchiveRolloverPlan
  ) throws -> ArchiveRolloverEffectReceipt {
    let invocation = directory.appendingPathComponent(
      "invoke-\(kind.rawValue)-\(UUID().uuidString)")
    try Data("invoked".utf8).write(to: invocation)
    let marker = directory.appendingPathComponent("durable-\(kind.rawValue)")
    let expected = Data("\(plan.commandID)|\(kind.rawValue)".utf8)
    let performed: Bool
    if FileManager.default.fileExists(atPath: marker.path) {
      guard try Data(contentsOf: marker) == expected else {
        throw ArchiveRolloverEffectFailure.authenticationFailed
      }
      performed = false
    } else {
      try expected.write(to: marker, options: .atomic)
      performed = true
    }
    if crashKind == kind { throw MidnightCrash() }
    return ArchiveRolloverEffectReceipt(
      kind: kind,
      commandID: plan.commandID,
      expectedDurableDigestHex: sha256(expected),
      observedDurableDigestHex: sha256(try Data(contentsOf: marker)),
      performedDurableMutation: performed)
  }
}

private final class MidnightClock: @unchecked Sendable {
  private let lock = NSLock()
  private var tick: UInt64 = 100

  var value: ArchiveRolloverClock {
    ArchiveRolloverClock {
      self.lock.withLock {
        self.tick += 1
        return (self.tick, self.tick)
      }
    }
  }
}

extension ArchiveRolloverEffectKind {
  fileprivate static let allTestCases: [ArchiveRolloverEffectKind] = [
    .reserveOldDayFinal, .closeOldDayFiles, .makeNewDayFilesDurable,
  ]
}

private func crashingBeforeFirstEffect() -> ArchiveRolloverEffects {
  ArchiveRolloverEffects(
    reserveOldDayFinal: { _ in throw MidnightCrash() },
    closeOldDayFiles: { _ in throw MidnightCrash() },
    makeNewDayFilesDurable: { _ in throw MidnightCrash() })
}

private func unusedEffects() -> ArchiveRolloverEffects {
  ArchiveRolloverEffects(
    reserveOldDayFinal: { _ in throw ArchiveRolloverEffectFailure.internalIOFailed },
    closeOldDayFiles: { _ in throw ArchiveRolloverEffectFailure.internalIOFailed },
    makeNewDayFilesDurable: { _ in throw ArchiveRolloverEffectFailure.internalIOFailed })
}

private func preparation(
  for plan: ArchiveRolloverPlan,
  sessionSampleStart: UInt64? = nil
) throws -> ArchiveRolloverPreparation {
  try ArchiveRolloverPreparation(
    sessionID: plan.sessionID,
    sessionSampleStart: sessionSampleStart ?? plan.sessionSampleStart,
    oldDay: plan.primary.oldDay,
    boundarySample: plan.primary.boundarySample,
    nextChunkIndex: plan.primary.nextChunkIndex,
    oldAuthenticatedFacts: plan.primary.oldAuthenticatedFacts,
    targetISTDay: plan.primary.newDay.istDay)
}

private func dailyIdentity(
  date: String,
  room: String,
  lane: String,
  device: String,
  streamByte: UInt8,
  digestByte: UInt8,
  initial: UInt64
) throws -> ArchiveDailyLaneIdentity {
  try dailyIdentity(
    context: laneContext(
      date: date, lane: lane, streamByte: streamByte, room: room, device: device),
    digestByte: digestByte,
    initial: initial)
}

private func controlIdentity(
  date: String,
  room: String,
  streamByte: UInt8,
  digestByte: UInt8
) throws -> ArchiveDailyControlIdentity {
  try ArchiveDailyControlIdentity(
    context: laneContext(
      date: date, lane: "_control", streamByte: streamByte, room: room, device: ""),
    keywrapDigestHex: String(repeating: String(format: "%02x", digestByte), count: 32))
}

private func dailyIdentity(
  context: ArchiveContext,
  digestByte: UInt8,
  initial: UInt64
) throws -> ArchiveDailyLaneIdentity {
  try ArchiveDailyLaneIdentity(
    context: context,
    expectedInitialSessionSample: initial,
    keywrapDigestHex: String(repeating: String(format: "%02x", digestByte), count: 32))
}

private func laneContext(
  date: String,
  lane: String,
  streamByte: UInt8,
  room: String = "room_1",
  device: String = "device_1"
) -> ArchiveContext {
  var streamUUID = Data(repeating: streamByte, count: 16)
  streamUUID[6] = (streamUUID[6] & 0x0F) | 0x40
  streamUUID[8] = (streamUUID[8] & 0x3F) | 0x80
  return ArchiveContext(
    streamUUID: streamUUID,
    roomID: room,
    istDate: date,
    laneID: lane,
    stableDeviceUID: lane == "_control" ? "" : device)
}

private func keywrapInspection(
  context: ArchiveContext,
  digestByte: UInt8
) -> ArchiveKeywrapInspection {
  ArchiveKeywrapInspection(
    authenticated: true,
    formatVersion: 1,
    algorithmID: 1,
    streamUUIDHex: context.streamUUID.map { String(format: "%02x", $0) }.joined(),
    contextHashHex: (try! context.sha256()).map { String(format: "%02x", $0) }.joined(),
    publicKeyHashHex: String(repeating: "1", count: 64),
    keywrapDigestHex: String(repeating: String(format: "%02x", digestByte), count: 32),
    wrappedByteCount: 128)
}

private func durableEffectHashes(_ directory: URL) throws -> [String: String] {
  let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
    .filter { $0.hasPrefix("durable-") }
  return try Dictionary(
    uniqueKeysWithValues: names.map { name in
      let data = try Data(contentsOf: directory.appendingPathComponent(name))
      return (name, sha256(data))
    })
}

private func durableMarkerCount(_ directory: URL) throws -> Int {
  try FileManager.default.contentsOfDirectory(atPath: directory.path)
    .filter { $0.hasPrefix("durable-") }.count
}

private func invocationCount(_ directory: URL, kind: ArchiveRolloverEffectKind) throws -> Int {
  try FileManager.default.contentsOfDirectory(atPath: directory.path)
    .filter { $0.hasPrefix("invoke-\(kind.rawValue)-") }.count
}

private func sha256(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func observation() -> ArchiveIndexObservation {
  ArchiveIndexObservation(
    monoNS: nil, wallNS: nil, rmsQ15: 0, nativeFrames: nil,
    inputRateNumerator: nil, inputRateDenominator: nil)
}

private func pcm(_ samples: [Int16]) -> Data {
  var result = Data()
  result.reserveCapacity(samples.count * 2)
  for sample in samples {
    let bits = UInt16(bitPattern: sample)
    result.append(UInt8(truncatingIfNeeded: bits))
    result.append(UInt8(truncatingIfNeeded: bits >> 8))
  }
  return result
}

private func temporaryDirectory(_ label: String) throws -> URL {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent(
    "eta-midnight-\(label)-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
  return url
}

private func isoDate(_ value: String) -> Date {
  ISO8601DateFormatter().date(from: value)!
}
