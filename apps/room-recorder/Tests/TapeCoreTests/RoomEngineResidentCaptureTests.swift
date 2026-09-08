import Foundation
import Testing

@testable import RoomRecorderCore
@testable import TapeCore

@Suite(.serialized) struct RoomEngineResidentCaptureTests {
  @Test func disabledConfigurationNeverConstructsResidentOwner() async throws {
    let root = try configuredRoot(enabled: false, receipt: nil)
    defer { try? FileManager.default.removeItem(at: root) }
    let probe = ResidentFactoryProbe()

    _ = try await RoomEngine.load(
      rootURL: root,
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )

    #expect(probe.factoryCalls == 0)
  }

  @Test func enabledConfigurationFailsClosedBeforeConstructingOwner() async throws {
    let missingRoot = try configuredRoot(enabled: true, receipt: nil)
    defer { try? FileManager.default.removeItem(at: missingRoot) }
    let missingProbe = ResidentFactoryProbe()
    do {
      _ = try await RoomEngine.load(
        rootURL: missingRoot,
        residentRuntimeFactory: { _, _ in missingProbe.makeRuntime() }
      )
      Issue.record("expected missing preflight refusal")
    } catch {
      #expect(error as? RoomEngineError == .residentArchivePreflightRequired)
    }
    #expect(missingProbe.factoryCalls == 0)

    let mismatchRoot = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: mismatchRoot) }
    let receipt = try preflightReceipt(root: URL(fileURLWithPath: "/private/other"))
    try RoomPersistence(root: mismatchRoot).saveConfiguration(
      configuration(enabled: true, receipt: receipt))
    do {
      _ = try await RoomEngine.load(
        rootURL: mismatchRoot,
        residentRuntimeFactory: { _, _ in missingProbe.makeRuntime() }
      )
      Issue.record("expected mismatched preflight refusal")
    } catch {
      #expect(error as? RoomEngineError == .residentArchivePreflightMismatch)
    }
    #expect(missingProbe.factoryCalls == 0)
  }

  @Test func eligibleConfigurationRequiresConcreteRuntime() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))

    do {
      _ = try await RoomEngine.load(
        rootURL: root,
        retainedArchiveRecovery: EncoderCapableRecovery())
      Issue.record("expected unavailable runtime refusal")
    } catch {
      #expect(error as? RoomEngineError == .residentArchiveRuntimeUnavailable)
    }
  }

  @Test func legacyCompletedRolloverWithoutPlanIsSkippedButUnfinishedAndFailedAreRefused()
    throws
  {
    func command(_ id: String, state: ArchiveControlState) -> RoomRecoveredControlCommand {
      RoomRecoveredControlCommand(
        commandID: id,
        commandKind: .rollover,
        sessionID: "bs_legacy",
        state: state,
        failure: state == .rolloverFailed ? .internalIOFailed : nil,
        atMonoNS: 1,
        atWallNS: 1)
    }

    #expect(
      try PrimaryResidentRuntimeFactory.retainedRolloverPlans(
        recovered: ["complete": command("complete", state: .rolloverComplete)],
        roomID: "room_1",
        stableDeviceUID: "device-stable-1"
      ).isEmpty)
    #expect(
      throws: RoomEngineError.retainedArchiveRecoveryFailed(
        "rollover_plan_missing:unfinished")
    ) {
      try PrimaryResidentRuntimeFactory.retainedRolloverPlans(
        recovered: ["unfinished": command("unfinished", state: .rolloverIntent)],
        roomID: "room_1",
        stableDeviceUID: "device-stable-1")
    }
    #expect(
      throws: RoomEngineError.retainedArchiveRecoveryFailed(
        "rollover_failed:failed")
    ) {
      try PrimaryResidentRuntimeFactory.retainedRolloverPlans(
        recovered: ["failed": command("failed", state: .rolloverFailed)],
        roomID: "room_1",
        stableDeviceUID: "device-stable-1")
    }
  }

  @Test func eligibleConfigurationRequiresEncoderCapableRecoveryBeforeRuntimeConstruction()
    async throws
  {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()

    for recovery in [nil, IncapableRecovery()] as [(any RoomRetainedArchiveRecovering)?] {
      do {
        _ = try await RoomEngine.load(
          rootURL: root,
          retainedArchiveRecovery: recovery,
          residentRuntimeFactory: { _, _ in probe.makeRuntime() })
        Issue.record("expected encoder-capable recovery refusal")
      } catch {
        #expect(error as? RoomEngineError == .residentArchiveRecoveryUnavailable)
      }
    }
    #expect(probe.factoryCalls == 0)
  }

  @Test func eligibleRuntimeOwnsStartServiceLevelsAndCancellationStop() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    let remote = ResidentCaptureRemote()
    let launcher = RefusingCaptureLauncher()
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: launcher,
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, context in
        #expect(context.archiveRootURL == root.standardizedFileURL)
        #expect(context.roomID == "room_1")
        return probe.makeRuntime()
      }
    )
    #expect(probe.factoryCalls == 0)

    let task = Task { try await engine.run() }
    try await waitUntil {
      guard probe.owner.startContexts.count == 1 else { return false }
      return await remote.pollCalls() > 0
    }
    task.cancel()
    try await task.value

    #expect(probe.factoryCalls == 1)
    #expect(launcher.launchCalls == 0)
    #expect(
      probe.owner.startContexts == [
        RoomResidentCaptureStartContext(
          roomID: "room_1",
          sessionID: "bs_resident",
          nextPrimaryIndex: 12,
          trigger: .reconciliation)
      ])
    #expect(probe.owner.serviceCalls > 0)
    #expect(probe.owner.stopReasons == [.cancelled])
    #expect(await remote.lastLevels() == BenchLevelPair(peak: 0.75, average: 0.25))
  }

  @Test func residentRuntimeReceivesPauseResumeAndEndLifecycle() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    let remote = ResidentCommandRemote()
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )
    #expect(probe.factoryCalls == 0)

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 3 }
    task.cancel()
    try await task.value

    #expect(probe.owner.startContexts.count == 2)
    #expect(probe.owner.startContexts.map(\.nextPrimaryIndex) == [12, 12])
    #expect(probe.owner.startContexts.allSatisfy { $0.nextBackupIndex == nil })
    #expect(
      probe.owner.startContexts.map(\.trigger) == [
        .reconciliation,
        .resumeDay(commandID: "cmd_resume"),
      ])
    #expect(
      probe.owner.stopReasons == [
        .pause(commandID: "cmd_pause"),
        .end(commandID: "cmd_end"),
      ])
    #expect(await remote.patchedActions() == [.pause, .resume, .end])
    #expect(await remote.acknowledgedCommands() == ["cmd_pause", "cmd_resume", "cmd_end"])
    #expect(probe.owner.finalRangeReservationCalls == 1)
    #expect(probe.owner.finalRangeVerificationCalls == 1)
    #expect(
      probe.journal.states(commandID: "cmd_pause") == [
        .pauseIntent,
        .laneBoundariesDurable,
        .pausePatched,
        .pauseAckReady,
        .pauseAckObserved,
      ])
    #expect(
      probe.journal.states(commandID: "cmd_resume") == [
        .resumeIntent,
        .cleanSegmentOpened,
        .captureDurable,
        .resumePatched,
        .resumeAckReady,
        .resumeAckObserved,
      ])
    #expect(
      probe.journal.states(commandID: "cmd_end") == [
        .endIntent,
        .finalRangesReserved,
        .finalRangesVerified,
        .sessionEndPatched,
        .endAckReady,
        .endAckObserved,
      ])
  }

  @Test func recoveredAckReadyRetriesOnlyTheAcknowledgement() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.journal.seed(
      RoomRecoveredControlCommand(
        commandID: "cmd_pause",
        commandKind: .pauseDay,
        sessionID: "bs_resident",
        state: .pauseAckReady,
        failure: nil,
        atMonoNS: 1,
        atWallNS: 1))
    let remote = ResidentCommandRemote(
      commandsJSON:
        #"[{"id":"cmd_pause","kind":"pause_day","args":{},"created_at":null}]"#)
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )
    #expect(probe.factoryCalls == 0)

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value

    #expect(await remote.patchedActions().isEmpty)
    #expect(probe.owner.stopReasons.isEmpty)
    #expect(
      probe.journal.states(commandID: "cmd_pause") == [
        .pauseAckObserved
      ])
  }

  @Test func residentStartJournalsIntentBeforeOpeningSessionAndAckAfterDurability() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    let remote = ResidentCommandRemote(
      commandsJSON:
        #"[{"id":"cmd_start","kind":"start_day","args":{},"created_at":null}]"#,
      activeSessionJSON:
        #"{"ok":true,"resumable":false,"session":null,"next_idx":{"primary":0,"backup":0},"reason":null,"handover_pending":false,"tab_gone":false}"#,
      createSessionJSON:
        #"{"session":{"id":"bs_started","room_id":"room_1","label":null,"mic_label":"device-stable-1","status":"recording"}}"#
    )
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )
    #expect(probe.factoryCalls == 0)

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value

    #expect(await remote.createCalls() == 1)
    #expect(probe.factoryCalls == 1)
    #expect(
      probe.owner.startContexts.map(\.trigger) == [
        .startDay(commandID: "cmd_start")
      ])
    #expect(
      probe.journal.states(commandID: "cmd_start") == [
        .startIntent,
        .sessionOpened,
        .captureDurable,
        .startAckReady,
        .startAckObserved,
      ])
  }

  @Test func eligibleIdleRoomWithoutCanonicalRoomIDNeverConstructsOrFallsBack() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    let launcher = RefusingCaptureLauncher()
    let remote = ResidentCommandRemote(
      commandsJSON:
        #"[{"id":"cmd_start","kind":"start_day","args":{},"created_at":null}]"#,
      activeSessionJSON:
        #"{"ok":true,"resumable":false,"session":null,"next_idx":{"primary":0,"backup":0},"reason":null,"handover_pending":false,"tab_gone":false}"#,
      pollRoomID: nil)
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: launcher,
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() })

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.commandPollCount() > 0 }
    task.cancel()
    _ = await task.result

    #expect(probe.factoryCalls == 0)
    #expect(launcher.launchCalls == 0)
    #expect(await remote.createCalls() == 0)
    #expect(await remote.acknowledgementCount() == 0)
  }

  @Test func recoveredAmbiguousStartNeverAdoptsCaptureAndFailsClosedBeforeAck() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.journal.seed(
      RoomRecoveredControlCommand(
        commandID: "cmd_start",
        commandKind: .startDay,
        sessionID: nil,
        state: .startIntent,
        failure: nil,
        atMonoNS: 1,
        atWallNS: 1))
    let remote = ResidentCommandRemote(commandsJSON: "[]")
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value

    #expect(probe.owner.startContexts.isEmpty)
    #expect(await remote.createCalls() == 0)
    #expect(
      probe.journal.states(commandID: "cmd_start") == [
        .sessionOpenOutcomeUnobservable,
        .startFailureAckReady,
        .startFailureAckObserved,
      ])
  }

  @Test func recoveredEndIntentCompletesWithoutRestartingCapture() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.journal.seed(
      RoomRecoveredControlCommand(
        commandID: "cmd_end",
        commandKind: .endDay,
        sessionID: "bs_resident",
        state: .endIntent,
        failure: nil,
        atMonoNS: 1,
        atWallNS: 1))
    let remote = ResidentCommandRemote(commandsJSON: "[]")
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value

    #expect(probe.owner.startContexts.isEmpty)
    #expect(probe.owner.finalRangeReservationCalls == 1)
    #expect(probe.owner.finalRangeVerificationCalls == 1)
    #expect(await remote.patchedActions() == [.end])
    #expect(
      probe.journal.states(commandID: "cmd_end") == [
        .finalRangesReserved,
        .finalRangesVerified,
        .sessionEndPatched,
        .endAckReady,
        .endAckObserved,
      ])
  }

  @Test func commandNotPendingMakesRecoveredAckOutcomeExplicitlyUnobservable() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.journal.seed(
      RoomRecoveredControlCommand(
        commandID: "cmd_pause",
        commandKind: .pauseDay,
        sessionID: "bs_resident",
        state: .pauseAckReady,
        failure: nil,
        atMonoNS: 1,
        atWallNS: 1))
    let remote = ResidentCommandRemote(commandsJSON: "[]", acknowledgementMode: .notPending)
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil {
      probe.journal.states(commandID: "cmd_pause") == [.pauseAckOutcomeUnobservable]
    }
    task.cancel()
    try await task.value

    #expect(await remote.acknowledgementAttempts() == 1)
  }

  @Test func resumeJournalFailureStopsTentativeCaptureBeforeFailureAck() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.journal.failNextAdvance(to: .cleanSegmentOpened)
    let remote = ResidentCommandRemote(
      commandsJSON:
        #"[{"id":"cmd_resume","kind":"resume_day","args":{},"created_at":null}]"#,
      activeSessionJSON:
        #"{"ok":true,"resumable":true,"session":{"id":"bs_resident","room_id":"room_1","label":null,"mic_label":"device-stable-1","status":"paused","started_at":null,"last_any_chunk_at":null},"next_idx":{"primary":12,"backup":34},"reason":null,"handover_pending":false,"tab_gone":false}"#
    )
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value

    #expect(probe.owner.startContexts.map(\.trigger) == [.resumeDay(commandID: "cmd_resume")])
    #expect(probe.owner.stopReasons == [.pause(commandID: "cmd_resume")])
    #expect(!probe.owner.isActive)
    #expect(await remote.patchedActions().isEmpty)
    #expect(
      probe.journal.states(commandID: "cmd_resume") == [
        .resumeIntent,
        .resumeFailed,
        .resumeFailureAckReady,
        .resumeFailureAckObserved,
      ])
  }

  @Test func endVerificationFailureNeverPatchesServerEnd() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.owner.failNextFinalRangeVerification()
    let remote = ResidentCommandRemote(
      commandsJSON:
        #"[{"id":"cmd_end","kind":"end_day","args":{},"created_at":null}]"#)
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value

    #expect(probe.owner.finalRangeReservationCalls == 1)
    #expect(probe.owner.finalRangeVerificationCalls == 1)
    #expect(!probe.owner.isActive)
    #expect(await remote.patchedActions().isEmpty)
    #expect(
      probe.journal.states(commandID: "cmd_end") == [
        .endIntent,
        .finalRangesReserved,
        .endFailed,
        .endFailureAckReady,
        .endFailureAckObserved,
      ])
  }

  @Test func startDurabilityJournalFailureStopsCaptureAndEndsOpenedSession() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.journal.failNextAdvance(to: .captureDurable)
    let remote = ResidentCommandRemote(
      commandsJSON:
        #"[{"id":"cmd_start","kind":"start_day","args":{},"created_at":null}]"#,
      activeSessionJSON:
        #"{"ok":true,"resumable":false,"session":null,"next_idx":{"primary":0,"backup":0},"reason":null,"handover_pending":false,"tab_gone":false}"#,
      createSessionJSON:
        #"{"session":{"id":"bs_started","room_id":"room_1","label":null,"mic_label":"device-stable-1","status":"recording"}}"#
    )
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value

    #expect(probe.owner.stopReasons == [.startupFailed])
    #expect(!probe.owner.isActive)
    #expect(await remote.patchedActions() == [.end])
    #expect(
      probe.journal.states(commandID: "cmd_start") == [
        .startIntent,
        .sessionOpened,
        .startCompensationIntent,
        .captureStopped,
        .sessionEndPatched,
        .startFailed,
        .startFailureAckReady,
        .startFailureAckObserved,
      ])
  }

  @Test func recoveredPauseIntentCompletesWithoutReconciliationCapture() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.journal.seed(
      RoomRecoveredControlCommand(
        commandID: "cmd_pause",
        commandKind: .pauseDay,
        sessionID: "bs_resident",
        state: .pauseIntent,
        failure: nil,
        atMonoNS: 1,
        atWallNS: 1))
    let remote = ResidentCommandRemote(commandsJSON: "[]")
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value

    #expect(probe.owner.startContexts.isEmpty)
    #expect(await remote.patchedActions() == [.pause])
    #expect(
      probe.journal.states(commandID: "cmd_pause") == [
        .laneBoundariesDurable,
        .pausePatched,
        .pauseAckReady,
        .pauseAckObserved,
      ])
  }

  @Test func recoveredStartCrashPointsChooseCompensationOrDurableReconciliation() async throws {
    let opened = try await recover(
      commandID: "cmd_start_opened", kind: .startDay, state: .sessionOpened)
    #expect(opened.probe.owner.startContexts.isEmpty)
    #expect(await opened.remote.patchedActions() == [.end])
    #expect(
      opened.probe.journal.states(commandID: "cmd_start_opened") == [
        .startCompensationIntent,
        .captureStopped,
        .sessionEndPatched,
        .startFailed,
        .startFailureAckReady,
        .startFailureAckObserved,
      ])

    let durable = try await recover(
      commandID: "cmd_start_durable", kind: .startDay, state: .captureDurable)
    #expect(durable.probe.owner.startContexts.map(\.trigger) == [.reconciliation])
    #expect(await durable.remote.patchedActions().isEmpty)
    #expect(
      durable.probe.journal.states(commandID: "cmd_start_durable") == [
        .startAckReady,
        .startAckObserved,
      ])
  }

  @Test func recoveredPauseBoundaryRetriesOnlyTheIdempotentPatch() async throws {
    let recovered = try await recover(
      commandID: "cmd_pause_boundary", kind: .pauseDay, state: .laneBoundariesDurable)

    #expect(recovered.probe.owner.startContexts.isEmpty)
    #expect(recovered.probe.owner.stopReasons.isEmpty)
    #expect(await recovered.remote.patchedActions() == [.pause])
    #expect(
      recovered.probe.journal.states(commandID: "cmd_pause_boundary") == [
        .pausePatched,
        .pauseAckReady,
        .pauseAckObserved,
      ])
  }

  @Test func recoveredResumeCrashPointsFailUnprovenWorkAndContinueDurableWork() async throws {
    let pausedSession =
      #"{"ok":true,"resumable":true,"session":{"id":"bs_resident","room_id":"room_1","label":null,"mic_label":"device-stable-1","status":"paused","started_at":null,"last_any_chunk_at":null},"next_idx":{"primary":12,"backup":34},"reason":null,"handover_pending":false,"tab_gone":false}"#
    let intent = try await recover(
      commandID: "cmd_resume_intent", kind: .resumeDay, state: .resumeIntent,
      activeSessionJSON: pausedSession)
    #expect(intent.probe.owner.startContexts.isEmpty)
    #expect(await intent.remote.patchedActions().isEmpty)
    #expect(
      intent.probe.journal.states(commandID: "cmd_resume_intent") == [
        .resumeFailed,
        .resumeFailureAckReady,
        .resumeFailureAckObserved,
      ])

    let durable = try await recover(
      commandID: "cmd_resume_durable", kind: .resumeDay, state: .captureDurable,
      activeSessionJSON: pausedSession)
    #expect(durable.probe.owner.startContexts.map(\.trigger) == [.reconciliation])
    #expect(await durable.remote.patchedActions() == [.resume])
    #expect(
      durable.probe.journal.states(commandID: "cmd_resume_durable") == [
        .resumePatched,
        .resumeAckReady,
        .resumeAckObserved,
      ])
  }

  @Test func recoveredEndCrashPointsVerifyBeforePatchingAndNeverRestart() async throws {
    let intent = try await recover(
      commandID: "cmd_end_intent_all", kind: .endDay, state: .endIntent)
    #expect(intent.probe.owner.startContexts.isEmpty)
    #expect(intent.probe.owner.finalRangeReservationCalls == 1)
    #expect(intent.probe.owner.finalRangeVerificationCalls == 1)
    #expect(await intent.remote.patchedActions() == [.end])

    let reserved = try await recover(
      commandID: "cmd_end_reserved", kind: .endDay, state: .finalRangesReserved)
    #expect(reserved.probe.owner.startContexts.isEmpty)
    #expect(reserved.probe.owner.finalRangeReservationCalls == 0)
    #expect(reserved.probe.owner.finalRangeVerificationCalls == 1)
    #expect(await reserved.remote.patchedActions() == [.end])
    #expect(
      reserved.probe.journal.states(commandID: "cmd_end_reserved") == [
        .finalRangesVerified,
        .sessionEndPatched,
        .endAckReady,
        .endAckObserved,
      ])

    let verified = try await recover(
      commandID: "cmd_end_verified", kind: .endDay, state: .finalRangesVerified)
    #expect(verified.probe.owner.startContexts.isEmpty)
    #expect(verified.probe.owner.finalRangeVerificationCalls == 0)
    #expect(await verified.remote.patchedActions() == [.end])
    #expect(
      verified.probe.journal.states(commandID: "cmd_end_verified") == [
        .sessionEndPatched,
        .endAckReady,
        .endAckObserved,
      ])

    let patched = try await recover(
      commandID: "cmd_end_patched", kind: .endDay, state: .sessionEndPatched)
    #expect(patched.probe.owner.startContexts.isEmpty)
    #expect(patched.probe.owner.finalRangeVerificationCalls == 0)
    #expect(await patched.remote.patchedActions().isEmpty)
    #expect(
      patched.probe.journal.states(commandID: "cmd_end_patched") == [
        .endAckReady, .endAckObserved,
      ])

    let ackReady = try await recover(
      commandID: "cmd_end_ack_ready", kind: .endDay, state: .endAckReady)
    #expect(ackReady.probe.owner.startContexts.isEmpty)
    #expect(await ackReady.remote.patchedActions().isEmpty)
    #expect(
      ackReady.probe.journal.states(commandID: "cmd_end_ack_ready") == [
        .endAckObserved
      ])
  }

  @Test func staleRecoveredCommandCannotActOnAReplacementSession() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.journal.seed(
      RoomRecoveredControlCommand(
        commandID: "cmd_old_end", commandKind: .endDay, sessionID: "bs_old",
        state: .endIntent, failure: nil, atMonoNS: 1, atWallNS: 1))
    let remote = ResidentCommandRemote(commandsJSON: "[]")
    let engine = try await RoomEngine.load(
      rootURL: root, remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() })

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.commandPollCount() > 0 }
    task.cancel()
    try await task.value

    #expect(probe.owner.startContexts.map(\.sessionID) == ["bs_resident"])
    #expect(await remote.patchedActions().isEmpty)
    #expect(await remote.acknowledgementCount() == 0)
    #expect(probe.journal.states(commandID: "cmd_old_end").isEmpty)
  }

  @Test func newestRecoveredEndSupersedesOlderResumeRegardlessOfCommandID() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.journal.seed(
      RoomRecoveredControlCommand(
        commandID: "z_old_resume", commandKind: .resumeDay, sessionID: "bs_resident",
        state: .captureDurable, failure: nil, atMonoNS: 1, atWallNS: 1))
    probe.journal.seed(
      RoomRecoveredControlCommand(
        commandID: "a_new_end", commandKind: .endDay, sessionID: "bs_resident",
        state: .endIntent, failure: nil, atMonoNS: 2, atWallNS: 2))
    let remote = ResidentCommandRemote(commandsJSON: "[]")
    let engine = try await RoomEngine.load(
      rootURL: root, remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() })

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value

    #expect(probe.owner.startContexts.isEmpty)
    #expect(await remote.patchedActions() == [.end])
    #expect(probe.journal.states(commandID: "z_old_resume").isEmpty)
    #expect(probe.journal.states(commandID: "a_new_end").last == .endAckObserved)
  }

  @Test func recoveredNilSessionStartFailureReachesFailureAck() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.journal.seed(
      RoomRecoveredControlCommand(
        commandID: "cmd_start_failed", commandKind: .startDay, sessionID: nil,
        state: .startFailed, failure: .sessionOpenFailed, atMonoNS: 1, atWallNS: 1))
    let remote = ResidentCommandRemote(
      commandsJSON: "[]",
      activeSessionJSON:
        #"{"ok":true,"resumable":false,"session":null,"next_idx":{"primary":0,"backup":0},"reason":null,"handover_pending":false,"tab_gone":false}"#
    )
    let engine = try await RoomEngine.load(
      rootURL: root, remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() })

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value

    #expect(
      probe.journal.states(commandID: "cmd_start_failed") == [
        .startFailureAckReady, .startFailureAckObserved,
      ])
  }

  @Test func startOverridePauseUsesResumeJournalAndAcknowledgementFamily() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    let remote = ResidentCommandRemote(
      commandsJSON:
        #"[{"id":"cmd_override","kind":"start_day","args":{"override_pause":true},"created_at":null}]"#,
      activeSessionJSON:
        #"{"ok":true,"resumable":true,"session":{"id":"bs_resident","room_id":"room_1","label":null,"mic_label":"device-stable-1","status":"paused","started_at":null,"last_any_chunk_at":null},"next_idx":{"primary":12,"backup":34},"reason":null,"handover_pending":false,"tab_gone":false}"#
    )
    let engine = try await RoomEngine.load(
      rootURL: root, remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() })

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value

    #expect(await remote.patchedActions() == [.resume])
    #expect(
      probe.journal.states(commandID: "cmd_override") == [
        .resumeIntent, .cleanSegmentOpened, .captureDurable, .resumePatched,
        .resumeAckReady, .resumeAckObserved,
      ])
  }

  @Test func recoveredResumePatchJournalFailureRetriesWithoutFalseFailureAck() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let pausedSession =
      #"{"ok":true,"resumable":true,"session":{"id":"bs_resident","room_id":"room_1","label":null,"mic_label":"device-stable-1","status":"paused","started_at":null,"last_any_chunk_at":null},"next_idx":{"primary":12,"backup":34},"reason":null,"handover_pending":false,"tab_gone":false}"#
    let probe = ResidentFactoryProbe()
    probe.journal.seed(
      RoomRecoveredControlCommand(
        commandID: "cmd_resume", commandKind: .resumeDay, sessionID: "bs_resident",
        state: .captureDurable, failure: nil, atMonoNS: 1, atWallNS: 1))
    probe.journal.failNextAdvance(to: .resumePatched)
    let firstRemote = ResidentCommandRemote(
      commandsJSON: "[]", activeSessionJSON: pausedSession)
    var firstEngine: RoomEngine? = try await RoomEngine.load(
      rootURL: root, remoteFactory: { _ in firstRemote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() })

    let firstTask = Task { try await firstEngine?.run() }
    try await waitUntil { await firstRemote.patchedActions() == [.resume] }
    #expect(await firstRemote.acknowledgementCount() == 0)
    #expect(probe.journal.states(commandID: "cmd_resume").isEmpty)
    firstTask.cancel()
    try await firstTask.value
    firstEngine = nil

    let secondRemote = ResidentCommandRemote(
      commandsJSON: "[]", activeSessionJSON: pausedSession)
    let secondEngine = try await RoomEngine.load(
      rootURL: root, remoteFactory: { _ in secondRemote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() })
    let secondTask = Task { try await secondEngine.run() }
    try await waitUntil { await secondRemote.acknowledgementCount() == 1 }
    secondTask.cancel()
    try await secondTask.value

    #expect(await secondRemote.patchedActions() == [.resume])
    #expect(
      probe.journal.states(commandID: "cmd_resume") == [
        .resumePatched, .resumeAckReady, .resumeAckObserved,
      ])
  }

  @Test func recoveredCaptureNeverStartsWithoutMatchingAuthoritativeSession() async throws {
    let noSession =
      #"{"ok":true,"resumable":false,"session":null,"next_idx":{"primary":0,"backup":0},"reason":null,"handover_pending":false,"tab_gone":false}"#
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.journal.seed(
      RoomRecoveredControlCommand(
        commandID: "cmd_resume", commandKind: .resumeDay, sessionID: "bs_resident",
        state: .captureDurable, failure: nil, atMonoNS: 1, atWallNS: 1))
    let remote = ResidentCommandRemote(commandsJSON: "[]", activeSessionJSON: noSession)
    let engine = try await RoomEngine.load(
      rootURL: root, remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() })

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.commandPollCount() > 0 }
    task.cancel()
    try await task.value

    #expect(probe.owner.startContexts.isEmpty)
    #expect(await remote.patchedActions().isEmpty)
    #expect(await remote.acknowledgementCount() == 0)
  }

  @Test func recoveredStartDoesNotOverrideAuthoritativePause() async throws {
    let pausedSession =
      #"{"ok":true,"resumable":true,"session":{"id":"bs_resident","room_id":"room_1","label":null,"mic_label":"device-stable-1","status":"paused","started_at":null,"last_any_chunk_at":null},"next_idx":{"primary":12,"backup":34},"reason":null,"handover_pending":false,"tab_gone":false}"#
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.journal.seed(
      RoomRecoveredControlCommand(
        commandID: "cmd_start", commandKind: .startDay, sessionID: "bs_resident",
        state: .captureDurable, failure: nil, atMonoNS: 1, atWallNS: 1))
    let remote = ResidentCommandRemote(commandsJSON: "[]", activeSessionJSON: pausedSession)
    let engine = try await RoomEngine.load(
      rootURL: root, remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() })

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.commandPollCount() > 0 }
    task.cancel()
    try await task.value

    #expect(probe.owner.startContexts.isEmpty)
    #expect(await remote.acknowledgementCount() == 0)
  }

  @Test func recoveredPatchFailuresCompensateAndReachFailureAckInOnePass() async throws {
    let pause = try await recover(
      commandID: "cmd_pause_failed", kind: .pauseDay, state: .laneBoundariesDurable,
      patchesFail: true)
    #expect(
      pause.probe.journal.states(commandID: "cmd_pause_failed") == [
        .pauseFailed, .pauseFailureAckReady, .pauseFailureAckObserved,
      ])

    let pausedSession =
      #"{"ok":true,"resumable":true,"session":{"id":"bs_resident","room_id":"room_1","label":null,"mic_label":"device-stable-1","status":"paused","started_at":null,"last_any_chunk_at":null},"next_idx":{"primary":12,"backup":34},"reason":null,"handover_pending":false,"tab_gone":false}"#
    let resume = try await recover(
      commandID: "cmd_resume_failed", kind: .resumeDay, state: .captureDurable,
      activeSessionJSON: pausedSession, patchesFail: true)
    #expect(resume.probe.owner.stopReasons == [.pause(commandID: "cmd_resume_failed")])
    #expect(
      resume.probe.journal.states(commandID: "cmd_resume_failed") == [
        .resumeCompensationIntent, .captureStopped, .resumeFailed,
        .resumeFailureAckReady, .resumeFailureAckObserved,
      ])

    let end = try await recover(
      commandID: "cmd_end_failed", kind: .endDay, state: .finalRangesVerified,
      patchesFail: true)
    #expect(
      end.probe.journal.states(commandID: "cmd_end_failed") == [
        .endFailed, .endFailureAckReady, .endFailureAckObserved,
      ])
  }

  @Test func alreadyRecordingStartUsesDurableNoOpAckPath() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    let remote = ResidentCommandRemote(
      commandsJSON:
        #"[{"id":"cmd_start","kind":"start_day","args":{},"created_at":null}]"#)
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value

    #expect(probe.owner.startContexts.map(\.trigger) == [.reconciliation])
    #expect(await remote.patchedActions().isEmpty)
    #expect(
      probe.journal.states(commandID: "cmd_start") == [
        .commandNoop,
        .startAckReady,
        .startAckObserved,
      ])
  }

  @Test func noActiveSessionPauseUsesDurableRefusalAckPath() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    let remote = ResidentCommandRemote(
      commandsJSON:
        #"[{"id":"cmd_pause","kind":"pause_day","args":{},"created_at":null}]"#,
      activeSessionJSON:
        #"{"ok":true,"resumable":false,"session":null,"next_idx":{"primary":0,"backup":0},"reason":null,"handover_pending":false,"tab_gone":false}"#
    )
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value

    #expect(probe.owner.startContexts.isEmpty)
    #expect(await remote.patchedActions().isEmpty)
    #expect(
      probe.journal.states(commandID: "cmd_pause") == [
        .commandRefused,
        .pauseFailureAckReady,
        .pauseFailureAckObserved,
      ])
  }

  @Test func residentLossFailsTheEngineAndStopsAdvertisingARecording() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.owner.deactivateOnNextServiceAndFailRestart()
    let remote = ResidentCaptureRemote()
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil {
      let recordingSessionID = await remote.lastRecordingSessionID()
      let status = try? RoomPersistence(root: root).loadStatus()
      return probe.owner.serviceCalls > 0 && recordingSessionID == nil && status?.state == .failed
    }
    task.cancel()
    try await task.value

    #expect(probe.owner.serviceCalls > 0)
    #expect(probe.owner.stopReasons == [.startupFailed])
    #expect(probe.owner.startsWhileFinalizationRequired == 0)
  }

  @Test func terminalRolloverFailureFailsHealthWhileTheMicrophoneRemainsActive() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.owner.failTerminallyOnNextService()
    let remote = ResidentCaptureRemote()
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() })

    let task = Task { try await engine.run() }
    try await waitUntil {
      let status = try? RoomPersistence(root: root).loadStatus()
      let recordingSessionID = await remote.lastRecordingSessionID()
      return probe.owner.serviceCalls > 0
        && probe.owner.isActive
        && recordingSessionID == nil
        && status?.state == .failed
    }
    task.cancel()
    try await task.value

    #expect(probe.owner.terminalFailure == "rollover_effect_failed")
  }

  @Test func serverEndedRegistrationFinalizesResidentDeliveryWithoutEndPatch() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.owner.endByServerOnNextService()
    let remote = ResidentCaptureRemote(serverEndsAfterFirstActiveLookup: true)
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() })

    let task = Task { try await engine.run() }
    try await waitUntil {
      guard probe.owner.finalRangeVerificationCalls == 1 else { return false }
      let status = try? RoomPersistence(root: root).loadStatus()
      return status?.state == .ready && status?.sessionID == nil
        && status?.lastError == RoomEngineError.sessionEndedByServer.localizedDescription
    }
    let status = try RoomPersistence(root: root).loadStatus()
    #expect(status.lastError == RoomEngineError.sessionEndedByServer.localizedDescription)
    await remote.releaseReconciliation()
    task.cancel()
    try await task.value

    #expect(probe.owner.stopReasons == [.serverEnded])
    #expect(probe.owner.finalizationEvents == ["stop", "reserve", "verify"])
    #expect(probe.journal.contains(state: .serverEndedFinalized))
    #expect(!probe.owner.isActive)
    #expect(await remote.patchCalls() == 0)
  }

  @Test func startupServerEndedWitnessFinalizesRetainedTailWithoutActiveSessionOrEndPatch()
    async throws
  {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.owner.seedServerEndedSessionID("bs_retained_tail")
    let remote = ResidentCommandRemote(
      commandsJSON: "[]",
      activeSessionJSON: """
        {
          "ok": true,
          "resumable": false,
          "session": null,
          "next_idx": {"primary": 0, "backup": 0},
          "reason": null,
          "handover_pending": false,
          "tab_gone": false
        }
        """)
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() })

    let task = Task { try await engine.run() }
    try await waitUntil {
      let status = try? RoomPersistence(root: root).loadStatus()
      return probe.owner.finalRangeVerificationCalls == 1
        && status?.state == .ready && status?.sessionID == nil
    }
    task.cancel()
    try await task.value

    #expect(probe.owner.finalizationEvents == ["reserve", "verify"])
    #expect(probe.journal.contains(state: .serverEndedFinalized))
    #expect(await remote.patchedActions().isEmpty)
  }

  @Test func durableLocalFinalizationClearsOnlyItsExactServerEndedEvidence() throws {
    let finalized = RoomRecoveredControlCommand(
      commandID: "local_server_ended",
      commandKind: .serverEndedFinalization,
      sessionID: "bs_finalized",
      state: .serverEndedFinalized,
      failure: nil,
      atMonoNS: 1,
      atWallNS: 1)

    #expect(
      try PrimaryResidentRuntimeFactory.unresolvedServerEndedSessionID(
        evidence: ["bs_finalized"], recovered: [finalized.commandID: finalized]) == nil)
    #expect(
      try PrimaryResidentRuntimeFactory.unresolvedServerEndedSessionID(
        evidence: ["bs_other"], recovered: [finalized.commandID: finalized]) == "bs_other")
    #expect(throws: RoomEngineError.self) {
      try PrimaryResidentRuntimeFactory.unresolvedServerEndedSessionID(
        evidence: ["bs_a", "bs_b"], recovered: [finalized.commandID: finalized])
    }
  }

  @Test func retainedCaptureAuthoritySelectsOnlyOneUnfinalizedSession() throws {
    let old = try captureBinding(sessionID: "bs_old", istDate: "2026-08-28")
    let current = try captureBinding(sessionID: "bs_current", istDate: "2026-08-29")

    #expect(
      try PrimaryResidentRuntimeFactory.retainedUnfinalizedSessionID(
        captureBindings: [current], recovered: [:]) == current.sessionID)
    #expect(throws: RoomEngineError.self) {
      try PrimaryResidentRuntimeFactory.retainedUnfinalizedSessionID(
        captureBindings: [old, current], recovered: [:])
    }

    let ended = RoomRecoveredControlCommand(
      commandID: "cmd_end_old", commandKind: .endDay, sessionID: old.sessionID,
      state: .endAckObserved, failure: nil, atMonoNS: 1, atWallNS: 1)
    #expect(
      try PrimaryResidentRuntimeFactory.retainedUnfinalizedSessionID(
        captureBindings: [old, current], recovered: [ended.commandID: ended])
        == current.sessionID)
  }

  @Test func convergedServerEndAndCompensatedStartExcludeCaptureBindings() throws {
    let serverEnded = try captureBinding(sessionID: "bs_server_ended", istDate: "2026-08-28")
    let compensated = try captureBinding(sessionID: "bs_compensated", istDate: "2026-08-29")
    let serverFinalization = RoomRecoveredControlCommand(
      commandID: "local_server_ended", commandKind: .serverEndedFinalization,
      sessionID: serverEnded.sessionID, state: .serverEndedFinalized, failure: nil,
      atMonoNS: 1, atWallNS: 1)
    let failedStart = RoomRecoveredControlCommand(
      commandID: "cmd_start_failed", commandKind: .startDay,
      sessionID: compensated.sessionID, state: .startFailureAckObserved,
      failure: .noDurableGrowth, atMonoNS: 2, atWallNS: 2)

    #expect(
      try PrimaryResidentRuntimeFactory.retainedUnfinalizedSessionID(
        captureBindings: [serverEnded, compensated],
        recovered: [
          serverFinalization.commandID: serverFinalization,
          failedStart.commandID: failedStart,
        ]) == nil)
  }

  @Test func noActiveResponsePromotesRetainedUnfinalizedTailWithoutEndPatch() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.owner.seedRetainedUnfinalizedSessionID("bs_crash_tail")
    let remote = ResidentCommandRemote(
      commandsJSON: "[]",
      activeSessionJSON: """
        {
          "ok": true,
          "resumable": false,
          "session": null,
          "next_idx": {"primary": 0, "backup": 0},
          "reason": null,
          "handover_pending": false,
          "tab_gone": false
        }
        """)
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() })

    let task = Task { try await engine.run() }
    try await waitUntil {
      let status = try? RoomPersistence(root: root).loadStatus()
      return probe.owner.finalRangeVerificationCalls == 1
        && status?.state == .ready && status?.sessionID == nil
    }
    task.cancel()
    try await task.value

    #expect(probe.owner.markedRetainedServerEnds == ["bs_crash_tail"])
    #expect(probe.owner.finalizationEvents == ["reserve", "verify"])
    #expect(probe.journal.contains(state: .serverEndedFinalized))
    #expect(await remote.patchedActions().isEmpty)
  }

  @Test func failedActiveReadDoesNotPromoteRetainedUnfinalizedTail() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.owner.seedRetainedUnfinalizedSessionID("bs_crash_tail")
    let remote = ResidentCommandRemote(
      commandsJSON: "[]",
      activeSessionJSON: """
        {
          "ok": false,
          "resumable": false,
          "session": null,
          "next_idx": null,
          "reason": "active_read_failed",
          "handover_pending": false,
          "tab_gone": false
        }
        """)
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() })

    let task = Task { try await engine.run() }
    try await waitUntil {
      guard probe.factoryCalls == 1 else { return false }
      return await remote.commandPollCount() > 1
    }
    task.cancel()
    try await task.value

    #expect(probe.owner.markedRetainedServerEnds.isEmpty)
    #expect(probe.owner.finalRangeReservationCalls == 0)
    #expect(probe.owner.finalRangeVerificationCalls == 0)
    #expect(!probe.journal.contains(state: .serverEndedFinalized))
    #expect(await remote.patchedActions().isEmpty)
  }

  @Test func retainedUnfinalizedSessionResumesOnlyTheMatchingServerSession() async throws {
    let matchingRoot = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: matchingRoot) }
    try RoomPersistence(root: matchingRoot).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: matchingRoot)))
    let matchingProbe = ResidentFactoryProbe()
    matchingProbe.owner.seedRetainedUnfinalizedSessionID("bs_resident")
    let matchingRemote = ResidentCaptureRemote()
    let matchingEngine = try await RoomEngine.load(
      rootURL: matchingRoot, remoteFactory: { _ in matchingRemote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in matchingProbe.makeRuntime() })
    let matchingTask = Task { try await matchingEngine.run() }
    try await waitUntil { matchingProbe.owner.startContexts.count == 1 }
    matchingTask.cancel()
    try await matchingTask.value
    #expect(matchingProbe.owner.markedRetainedServerEnds.isEmpty)
    #expect(matchingProbe.owner.startContexts.first?.sessionID == "bs_resident")

    let conflictingRoot = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: conflictingRoot) }
    try RoomPersistence(root: conflictingRoot).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: conflictingRoot)))
    let conflictingProbe = ResidentFactoryProbe()
    conflictingProbe.owner.seedRetainedUnfinalizedSessionID("bs_old")
    let conflictingRemote = ResidentCaptureRemote()
    let conflictingEngine = try await RoomEngine.load(
      rootURL: conflictingRoot, remoteFactory: { _ in conflictingRemote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in conflictingProbe.makeRuntime() })
    let conflictingTask = Task { try await conflictingEngine.run() }
    try await waitUntil {
      (try? RoomPersistence(root: conflictingRoot).loadStatus().state) == .failed
    }
    conflictingTask.cancel()
    try await conflictingTask.value
    #expect(conflictingProbe.owner.startContexts.isEmpty)
    #expect(conflictingProbe.owner.markedRetainedServerEnds.isEmpty)
    #expect(await conflictingRemote.patchCalls() == 0)
  }

  @Test func explicitEndServerEndedDuringFinalVerificationSkipsEndPatchAndStillAcknowledges()
    async throws
  {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.owner.endByServerOnNextFinalRangeVerification()
    let remote = ResidentCommandRemote()
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() })

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 3 }
    task.cancel()
    try await task.value

    #expect(await remote.patchedActions() == [.pause, .resume])
    #expect(
      probe.journal.states(commandID: "cmd_end") == [
        .endIntent, .finalRangesReserved, .finalRangesVerified, .sessionEndPatched,
        .endAckReady, .endAckObserved,
      ])
  }

  @Test func recoveredVerifiedEndWithDurableServerWitnessSkipsEndPatch() async throws {
    let recovered = try await recover(
      commandID: "cmd_end_server_witness", kind: .endDay, state: .finalRangesVerified,
      serverEndedSessionID: "bs_resident")

    #expect(await recovered.remote.patchedActions().isEmpty)
    #expect(
      recovered.probe.journal.states(commandID: "cmd_end_server_witness") == [
        .sessionEndPatched, .endAckReady, .endAckObserved,
      ])
  }

  @Test func failedFinalizationRemainsRetryableAndCannotEndTheSessionEarly() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.owner.failNextFinalizationAfterDeactivation()
    let remote = ResidentRetryEndRemote()
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 2 }
    task.cancel()
    try await task.value

    #expect(
      probe.owner.stopReasons == [
        .end(commandID: "cmd_end_1"),
        .end(commandID: "cmd_end_2"),
      ])
    #expect(
      await remote.acknowledgements() == [
        ResidentCommandAck(id: "cmd_end_1", ok: false),
        ResidentCommandAck(id: "cmd_end_2", ok: true),
      ])
    #expect(await remote.patchedActions() == [.end])
  }

  @Test func cancellationSurfacesAnUnfinishedResidentBoundary() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.owner.failNextFinalizationAfterDeactivation()
    let remote = ResidentCaptureRemote()
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.pollCalls() > 0 }
    task.cancel()
    do {
      try await task.value
      Issue.record("expected unfinished resident boundary")
    } catch {
      #expect(error as? ResidentCaptureTestError == .finalizationFailed)
    }

    #expect(try RoomPersistence(root: root).loadStatus().state == .failed)
    #expect(probe.owner.requiresFinalization)
  }

  @Test func supersessionRetriesCleanupWithoutReconciliationOrRestart() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    probe.owner.failNextFinalizationAfterDeactivation()
    let remote = ResidentSupersededRemote()
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() }
    )

    let task = Task { try await engine.run() }
    try await waitUntil { probe.owner.stopReasons.count == 2 }

    #expect(probe.owner.stopReasons == [.superseded, .superseded])
    #expect(probe.owner.startContexts.count == 1)
    #expect(probe.owner.startsWhileFinalizationRequired == 0)
    #expect(await remote.activeSessionCalls() == 1)

    task.cancel()
    _ = await task.result
  }

  private func configuredRoot(
    enabled: Bool,
    receipt: RoomArchivePreflightReceipt?
  ) throws -> URL {
    let root = try temporaryRoot()
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: enabled, receipt: receipt))
    return root
  }

  private func temporaryRoot() throws -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(
      "room-engine-resident-\(UUID().uuidString)",
      isDirectory: true
    ).standardizedFileURL
  }

  private func configuration(
    enabled: Bool,
    receipt: RoomArchivePreflightReceipt?
  ) throws -> RoomConfiguration {
    try RoomConfiguration(
      origin: #require(URL(string: "https://eta.test/")),
      roomSlug: "home-office",
      deviceUID: "device-stable-1",
      tapewriterPath: "/usr/bin/false",
      ffmpegPath: "/opt/ffmpeg",
      residentArchiveCaptureEnabled: enabled,
      archivePreflightReceipt: receipt
    )
  }

  private func preflightReceipt(root: URL) throws -> RoomArchivePreflightReceipt {
    try RoomArchivePreflightReceipt(
      origin: #require(URL(string: "https://eta.test/")),
      roomSlug: "home-office",
      deviceUID: "device-stable-1",
      ffmpegPath: "/opt/ffmpeg",
      archiveRootPath: root.standardizedFileURL.path,
      archiveProbeSucceeded: true,
      keyProbeSucceeded: true,
      encoderProbeSucceeded: true,
      secureEnclavePublicKeySHA256: String(repeating: "a", count: 64),
      encoderProvenanceID: "ffmpeg-pinned-build-1",
      completedAt: Date(timeIntervalSince1970: 1_777_000_000)
    )
  }

  private func captureBinding(sessionID: String, istDate: String) throws
    -> ArchiveCaptureSessionBinding
  {
    var streamUUID = Data(repeating: UInt8(istDate.suffix(2)) ?? 1, count: 16)
    streamUUID[6] = (streamUUID[6] & 0x0F) | 0x40
    streamUUID[8] = (streamUUID[8] & 0x3F) | 0x80
    return try ArchiveCaptureSessionBinding(
      sessionID: sessionID,
      primaryIdentity: ArchiveDailyLaneIdentity(
        context: ArchiveContext(
          streamUUID: streamUUID,
          roomID: "room_1",
          istDate: istDate,
          laneID: "primary",
          stableDeviceUID: "device-stable-1"),
        expectedInitialSessionSample: 0,
        keywrapDigestHex: String(repeating: "a", count: 64)),
      sessionSampleStart: 0,
      segmentSampleStart: 0)
  }

  private func waitUntil(_ condition: @escaping @Sendable () async -> Bool) async throws {
    for _ in 0..<500 {
      if await condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("timed out waiting for resident capture lifecycle")
  }

  private func recover(
    commandID: String,
    kind: ArchiveControlCommandKind,
    state: ArchiveControlState,
    activeSessionJSON: String? = nil,
    patchesFail: Bool = false,
    serverEndedSessionID: String? = nil
  ) async throws -> (probe: ResidentFactoryProbe, remote: ResidentCommandRemote) {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    try RoomPersistence(root: root).saveConfiguration(
      configuration(enabled: true, receipt: preflightReceipt(root: root)))
    let probe = ResidentFactoryProbe()
    if let serverEndedSessionID {
      probe.owner.seedServerEndedSessionID(serverEndedSessionID)
    }
    probe.journal.seed(
      RoomRecoveredControlCommand(
        commandID: commandID,
        commandKind: kind,
        sessionID: "bs_resident",
        state: state,
        failure: nil,
        atMonoNS: 1,
        atWallNS: 1))
    let remote = ResidentCommandRemote(
      commandsJSON: "[]", activeSessionJSON: activeSessionJSON, patchesFail: patchesFail)
    let engine = try await RoomEngine.load(
      rootURL: root,
      remoteFactory: { _ in remote },
      captureLauncher: RefusingCaptureLauncher(),
      retainedArchiveRecovery: EncoderCapableRecovery(),
      residentRuntimeFactory: { _, _ in probe.makeRuntime() })

    let task = Task { try await engine.run() }
    try await waitUntil { await remote.acknowledgementCount() == 1 }
    task.cancel()
    try await task.value
    return (probe, remote)
  }
}

private final class ResidentFactoryProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var calls = 0
  let owner = ResidentCaptureOwner()
  let journal = ResidentControlJournal()

  var factoryCalls: Int { lock.withLock { calls } }

  func makeRuntime() -> RoomResidentRuntime {
    lock.withLock { calls += 1 }
    return RoomResidentRuntime(capture: owner, controlJournal: journal)
  }
}

private actor EncoderCapableRecovery: RoomRetainedArchiveRecovering {
  nonisolated let encoderCapable = true

  func run() {}
  func state() -> RoomRetainedArchiveRecoveryState { .complete }
}

private actor IncapableRecovery: RoomRetainedArchiveRecovering {
  func run() {}
  func state() -> RoomRetainedArchiveRecoveryState { .complete }
}

private final class ResidentControlJournal: RoomControlJournalOwning, @unchecked Sendable {
  private let lock = NSLock()
  private var commands: [String: RoomRecoveredControlCommand] = [:]
  private var transitions: [RoomControlTransition] = []
  private var failingState: ArchiveControlState?
  private var timestamp: UInt64 = 1

  func recover() throws -> [String: RoomRecoveredControlCommand] {
    lock.withLock { commands }
  }

  func advance(_ transition: RoomControlTransition) throws -> RoomRecoveredControlCommand {
    try lock.withLock {
      if failingState == transition.newState {
        failingState = nil
        throw ResidentCaptureTestError.journalFailed
      }
      let current = commands[transition.commandID]
      guard current?.state == transition.priorState else {
        throw ResidentCaptureTestError.journalFailed
      }
      if let current {
        guard current.commandKind == transition.commandKind else {
          throw ResidentCaptureTestError.journalFailed
        }
      }
      timestamp += 1
      _ = try ArchiveControlPayload(
        commandID: transition.commandID,
        commandKind: transition.commandKind,
        sessionID: transition.sessionID,
        priorState: transition.priorState,
        newState: transition.newState,
        atMonoNS: timestamp,
        atWallNS: timestamp,
        error: transition.failure)
      let recovered = RoomRecoveredControlCommand(
        commandID: transition.commandID,
        commandKind: transition.commandKind,
        sessionID: transition.sessionID,
        state: transition.newState,
        failure: transition.failure ?? commands[transition.commandID]?.failure,
        atMonoNS: timestamp,
        atWallNS: timestamp)
      commands[transition.commandID] = recovered
      transitions.append(transition)
      return recovered
    }
  }

  func states(commandID: String) -> [ArchiveControlState] {
    lock.withLock {
      transitions.filter { $0.commandID == commandID }.map(\.newState)
    }
  }

  func contains(state: ArchiveControlState) -> Bool {
    lock.withLock { transitions.contains { $0.newState == state } }
  }

  func seed(_ recovered: RoomRecoveredControlCommand) {
    lock.withLock {
      commands[recovered.commandID] = recovered
      timestamp = max(timestamp, recovered.atMonoNS, recovered.atWallNS)
    }
  }

  func failNextAdvance(to state: ArchiveControlState) {
    lock.withLock { failingState = state }
  }
}

private final class ResidentCaptureOwner: RoomResidentCaptureOwning, @unchecked Sendable {
  private let lock = NSLock()
  private var active = false
  private var primaryIndex = 0
  private var backupIndex: Int?
  private var finalizationRequired = false
  private var shouldDeactivateOnService = false
  private var shouldFailRestart = false
  private var terminalError: String?
  private var shouldFailTerminallyOnService = false
  private var shouldEndByServerOnService = false
  private var shouldEndByServerOnFinalVerification = false
  private var endedByServerSessionID: String?
  private var retainedUnfinalizedID: String?
  private var markedRetainedIDs: [String] = []
  private var finalizationFailuresRemaining = 0
  private var finalRangeVerificationFailuresRemaining = 0
  private var finalRangeReservations = 0
  private var finalRangeVerifications = 0
  private var unsafeStarts = 0
  private var starts: [RoomResidentCaptureStartContext] = []
  private var services = 0
  private var stops: [RoomResidentCaptureStopReason] = []
  private var finalEvents: [String] = []

  var isActive: Bool { lock.withLock { active } }
  var requiresFinalization: Bool { lock.withLock { finalizationRequired } }
  var nextPrimaryIndex: Int { lock.withLock { primaryIndex } }
  var nextBackupIndex: Int? { lock.withLock { backupIndex } }
  var terminalFailure: String? { lock.withLock { terminalError } }
  var serverEndedSessionID: String? { lock.withLock { endedByServerSessionID } }
  var retainedUnfinalizedSessionID: String? { lock.withLock { retainedUnfinalizedID } }
  var startContexts: [RoomResidentCaptureStartContext] { lock.withLock { starts } }
  var serviceCalls: Int { lock.withLock { services } }
  var stopReasons: [RoomResidentCaptureStopReason] { lock.withLock { stops } }
  var startsWhileFinalizationRequired: Int { lock.withLock { unsafeStarts } }
  var finalRangeReservationCalls: Int { lock.withLock { finalRangeReservations } }
  var finalRangeVerificationCalls: Int { lock.withLock { finalRangeVerifications } }
  var finalizationEvents: [String] { lock.withLock { finalEvents } }
  var markedRetainedServerEnds: [String] { lock.withLock { markedRetainedIDs } }

  func start(context: RoomResidentCaptureStartContext) throws {
    let restartMustFail = lock.withLock {
      if finalizationRequired { unsafeStarts += 1 }
      return shouldFailRestart && !starts.isEmpty
    }
    if restartMustFail { throw ResidentCaptureTestError.restartFailed }
    lock.withLock {
      starts.append(context)
      primaryIndex = context.nextPrimaryIndex
      backupIndex = context.nextBackupIndex
      active = true
      finalizationRequired = true
      endedByServerSessionID = nil
    }
  }

  func service() async throws {
    let terminal = lock.withLock { () -> Bool in
      services += 1
      if shouldDeactivateOnService {
        shouldDeactivateOnService = false
        active = false
      }
      if shouldFailTerminallyOnService {
        shouldFailTerminallyOnService = false
        terminalError = "rollover_effect_failed"
        return true
      }
      if shouldEndByServerOnService {
        shouldEndByServerOnService = false
        endedByServerSessionID = starts.last?.sessionID
      }
      return false
    }
    if terminal { throw ResidentCaptureTestError.serviceFailed }
  }

  func stopAndFinalize(reason: RoomResidentCaptureStopReason) throws {
    let shouldFail = lock.withLock {
      stops.append(reason)
      finalEvents.append("stop")
      active = false
      if finalizationFailuresRemaining > 0 {
        finalizationFailuresRemaining -= 1
        return true
      }
      finalizationRequired = false
      return false
    }
    if shouldFail { throw ResidentCaptureTestError.finalizationFailed }
  }

  func reserveFinalRanges(context _: RoomResidentFinalizationContext) async throws {
    lock.withLock {
      finalRangeReservations += 1
      finalEvents.append("reserve")
    }
  }

  func verifyFinalRanges(context: RoomResidentFinalizationContext) async throws {
    let shouldFail = lock.withLock {
      finalRangeVerifications += 1
      finalEvents.append("verify")
      if shouldEndByServerOnFinalVerification {
        shouldEndByServerOnFinalVerification = false
        endedByServerSessionID = context.sessionID
      }
      if finalRangeVerificationFailuresRemaining > 0 {
        finalRangeVerificationFailuresRemaining -= 1
        return true
      }
      return false
    }
    if shouldFail { throw ResidentCaptureTestError.verificationFailed }
  }

  func currentLevels() -> BenchLevelPair? {
    BenchLevelPair(peak: 0.75, average: 0.25)
  }

  func clearServerEndedSessionID(_ sessionID: String) {
    lock.withLock {
      if endedByServerSessionID == sessionID { endedByServerSessionID = nil }
      if retainedUnfinalizedID == sessionID { retainedUnfinalizedID = nil }
    }
  }

  func markRetainedUnfinalizedSessionAsServerEnded(_ sessionID: String) throws {
    try lock.withLock {
      guard retainedUnfinalizedID == sessionID else {
        throw ResidentCaptureTestError.unexpectedRemoteCall
      }
      markedRetainedIDs.append(sessionID)
      endedByServerSessionID = sessionID
    }
  }

  func deactivateOnNextServiceAndFailRestart() {
    lock.withLock {
      shouldDeactivateOnService = true
      shouldFailRestart = true
    }
  }

  func failNextFinalizationAfterDeactivation() {
    lock.withLock { finalizationFailuresRemaining += 1 }
  }

  func failNextFinalRangeVerification() {
    lock.withLock { finalRangeVerificationFailuresRemaining += 1 }
  }

  func failTerminallyOnNextService() {
    lock.withLock { shouldFailTerminallyOnService = true }
  }

  func endByServerOnNextService() {
    lock.withLock { shouldEndByServerOnService = true }
  }

  func endByServerOnNextFinalRangeVerification() {
    lock.withLock { shouldEndByServerOnFinalVerification = true }
  }

  func seedServerEndedSessionID(_ sessionID: String) {
    lock.withLock { endedByServerSessionID = sessionID }
  }

  func seedRetainedUnfinalizedSessionID(_ sessionID: String) {
    lock.withLock { retainedUnfinalizedID = sessionID }
  }
}

private final class RefusingCaptureLauncher: RoomCaptureLaunching, @unchecked Sendable {
  private let lock = NSLock()
  private var calls = 0
  var launchCalls: Int { lock.withLock { calls } }

  func launch(executable: URL, outputDirectory: URL, deviceUID: String, logURL: URL) throws
    -> any RoomCaptureProcess
  {
    lock.withLock { calls += 1 }
    throw ResidentCaptureTestError.unexpectedLegacyCapture
  }
}

private actor ResidentCaptureRemote: RoomEngineRemote {
  private let serverEndsAfterFirstActiveLookup: Bool
  private var activeLookups = 0
  private var polls = 0
  private var levels: BenchLevelPair?
  private var recordingSessionID: String?
  private var patches = 0
  private var reconciliationContinuation: CheckedContinuation<Void, Never>?
  private var reconciliationReleaseRequested = false

  init(serverEndsAfterFirstActiveLookup: Bool = false) {
    self.serverEndsAfterFirstActiveLookup = serverEndsAfterFirstActiveLookup
  }

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    activeLookups += 1
    if serverEndsAfterFirstActiveLookup, activeLookups > 1 {
      if reconciliationReleaseRequested {
        reconciliationReleaseRequested = false
      } else {
        await withCheckedContinuation { continuation in
          reconciliationContinuation = continuation
        }
      }
      return try JSONDecoder().decode(
        ActiveSessionResponse.self,
        from: Data(
          #"{"ok":true,"resumable":false,"session":null,"next_idx":{"primary":0,"backup":0},"reason":null,"handover_pending":false,"tab_gone":false}"#
            .utf8))
    }
    return try JSONDecoder().decode(
      ActiveSessionResponse.self,
      from: Data(
        #"{"ok":true,"resumable":true,"session":{"id":"bs_resident","room_id":"room_1","label":null,"mic_label":"device-stable-1","status":"recording","started_at":null,"last_any_chunk_at":null},"next_idx":{"primary":12,"backup":34},"reason":null,"handover_pending":false,"tab_gone":false}"#
          .utf8
      )
    )
  }

  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  {
    patches += 1
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func pollCommands(
    tabID: String,
    previousPollAt: String?,
    recordingSessionID: String?,
    paused: Bool,
    primaryLevels: BenchLevelPair?,
    install: InstallPollFields?
  ) async throws -> CommandPollResponse {
    polls += 1
    levels = primaryLevels
    self.recordingSessionID = recordingSessionID
    return try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(
        #"{"ok":true,"room_id":"room_1","superseded":false,"commands":[]}"#.utf8)
    )
  }

  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func pollCalls() -> Int { polls }
  func lastLevels() -> BenchLevelPair? { levels }
  func lastRecordingSessionID() -> String? { recordingSessionID }
  func patchCalls() -> Int { patches }
  func releaseReconciliation() {
    if let reconciliationContinuation {
      reconciliationContinuation.resume()
      self.reconciliationContinuation = nil
    } else {
      reconciliationReleaseRequested = true
    }
  }
}

private actor ResidentCommandRemote: RoomEngineRemote {
  private let commandsJSON: String
  private let activeSessionJSON: String?
  private let createSessionJSON: String?
  private let acknowledgementMode: ResidentAcknowledgementMode
  private let patchesFail: Bool
  private let pollRoomID: String?
  private var commandsReturned = false
  private var createCount = 0
  private var pollCount = 0
  private var acknowledgementAttemptCount = 0
  private var actions: [BenchSessionAction] = []
  private var acknowledgements: [String] = []

  init(
    commandsJSON: String =
      #"[{"id":"cmd_pause","kind":"pause_day","args":{},"created_at":null},{"id":"cmd_resume","kind":"resume_day","args":{},"created_at":null},{"id":"cmd_end","kind":"end_day","args":{},"created_at":null}]"#,
    activeSessionJSON: String? = nil,
    createSessionJSON: String? = nil,
    acknowledgementMode: ResidentAcknowledgementMode = .success,
    patchesFail: Bool = false,
    pollRoomID: String? = "room_1"
  ) {
    self.commandsJSON = commandsJSON
    self.activeSessionJSON = activeSessionJSON
    self.createSessionJSON = createSessionJSON
    self.acknowledgementMode = acknowledgementMode
    self.patchesFail = patchesFail
    self.pollRoomID = pollRoomID
  }

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    if let activeSessionJSON {
      return try JSONDecoder().decode(
        ActiveSessionResponse.self, from: Data(activeSessionJSON.utf8))
    }
    return try residentActiveSession()
  }

  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    guard let createSessionJSON else { throw ResidentCaptureTestError.unexpectedRemoteCall }
    createCount += 1
    return try JSONDecoder().decode(
      CreateSessionResponse.self, from: Data(createSessionJSON.utf8))
  }

  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  {
    actions.append(action)
    if patchesFail { throw ResidentCaptureTestError.unexpectedRemoteCall }
    return try JSONDecoder().decode(BenchOKResponse.self, from: Data(#"{"ok":true}"#.utf8))
  }

  func pollCommands(
    tabID: String,
    previousPollAt: String?,
    recordingSessionID: String?,
    paused: Bool,
    primaryLevels: BenchLevelPair?,
    install: InstallPollFields?
  ) async throws -> CommandPollResponse {
    pollCount += 1
    let commands: String
    if commandsReturned {
      commands = "[]"
    } else {
      commandsReturned = true
      commands = commandsJSON
    }
    let roomIDJSON = pollRoomID.map { "\"\($0)\"" } ?? "null"
    return try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(
        "{\"ok\":true,\"room_id\":\(roomIDJSON),\"superseded\":false,\"commands\":\(commands)}"
          .utf8)
    )
  }

  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  {
    acknowledgementAttemptCount += 1
    if acknowledgementMode == .notPending {
      throw BenchClientError.http(
        BenchHTTPError(
          statusCode: 404,
          body: #"{"error":"command_not_pending"}"#,
          retention: .notApplicable))
    }
    acknowledgements.append(commandID)
    let status = ok ? "acked" : "failed"
    return try JSONDecoder().decode(
      CommandAcknowledgement.self,
      from: Data("{\"ok\":true,\"id\":\"\(commandID)\",\"status\":\"\(status)\"}".utf8))
  }

  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func acknowledgementCount() -> Int { acknowledgements.count }
  func acknowledgedCommands() -> [String] { acknowledgements }
  func patchedActions() -> [BenchSessionAction] { actions }
  func createCalls() -> Int { createCount }
  func commandPollCount() -> Int { pollCount }
  func acknowledgementAttempts() -> Int { acknowledgementAttemptCount }
}

private enum ResidentAcknowledgementMode: Sendable {
  case success
  case notPending
}

private struct ResidentCommandAck: Equatable, Sendable {
  let id: String
  let ok: Bool
}

private actor ResidentRetryEndRemote: RoomEngineRemote {
  private var nextCommand = 0
  private var actions: [BenchSessionAction] = []
  private var commandAcks: [ResidentCommandAck] = []

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    try residentActiveSession()
  }

  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  {
    actions.append(action)
    return try JSONDecoder().decode(BenchOKResponse.self, from: Data(#"{"ok":true}"#.utf8))
  }

  func pollCommands(
    tabID: String,
    previousPollAt: String?,
    recordingSessionID: String?,
    paused: Bool,
    primaryLevels: BenchLevelPair?,
    install: InstallPollFields?
  ) async throws -> CommandPollResponse {
    let commands: String
    switch nextCommand {
    case 0:
      commands =
        #"[{"id":"cmd_end_1","kind":"end_day","args":{},"created_at":null}]"#
    case 1:
      commands =
        #"[{"id":"cmd_end_2","kind":"end_day","args":{},"created_at":null}]"#
    default:
      commands = "[]"
    }
    nextCommand += 1
    return try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(
        "{\"ok\":true,\"room_id\":\"room_1\",\"superseded\":false,\"commands\":\(commands)}"
          .utf8)
    )
  }

  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  {
    commandAcks.append(ResidentCommandAck(id: commandID, ok: ok))
    let status = ok ? "acked" : "failed"
    return try JSONDecoder().decode(
      CommandAcknowledgement.self,
      from: Data("{\"ok\":true,\"id\":\"\(commandID)\",\"status\":\"\(status)\"}".utf8))
  }

  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func acknowledgementCount() -> Int { commandAcks.count }
  func acknowledgements() -> [ResidentCommandAck] { commandAcks }
  func patchedActions() -> [BenchSessionAction] { actions }
}

private actor ResidentSupersededRemote: RoomEngineRemote {
  private var activeCalls = 0

  func activeSession(tabID: String?, since: String?) async throws -> ActiveSessionResponse {
    activeCalls += 1
    return try residentActiveSession()
  }

  func createSession(label: String?, micLabel: String?) async throws -> CreateSessionResponse {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func patchSession(id: String, action: BenchSessionAction, notes: String?) async throws
    -> BenchOKResponse
  {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func pollCommands(
    tabID: String,
    previousPollAt: String?,
    recordingSessionID: String?,
    paused: Bool,
    primaryLevels: BenchLevelPair?,
    install: InstallPollFields?
  ) async throws -> CommandPollResponse {
    try JSONDecoder().decode(
      CommandPollResponse.self,
      from: Data(#"{"ok":true,"room_id":"room_1","superseded":true,"commands":[]}"#.utf8)
    )
  }

  func acknowledge(commandID: String, ok: Bool, sessionID: String?, error: String?) async throws
    -> CommandAcknowledgement
  {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func markConsult(sessionID: String?, at: String) async throws -> ConsultMarkResponse {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func uploadImmutablePiece(_ piece: BenchPiece, bytes: Data) async throws
    -> ImmutablePieceUploadResult
  {
    throw ResidentCaptureTestError.unexpectedRemoteCall
  }

  func activeSessionCalls() -> Int { activeCalls }
}

private func residentActiveSession() throws -> ActiveSessionResponse {
  try JSONDecoder().decode(
    ActiveSessionResponse.self,
    from: Data(
      #"{"ok":true,"resumable":true,"session":{"id":"bs_resident","room_id":"room_1","label":null,"mic_label":"device-stable-1","status":"recording","started_at":null,"last_any_chunk_at":null},"next_idx":{"primary":12,"backup":34},"reason":null,"handover_pending":false,"tab_gone":false}"#
        .utf8
    )
  )
}

private enum ResidentCaptureTestError: Error, Equatable {
  case unexpectedLegacyCapture
  case unexpectedRemoteCall
  case finalizationFailed
  case journalFailed
  case restartFailed
  case serviceFailed
  case verificationFailed
}
