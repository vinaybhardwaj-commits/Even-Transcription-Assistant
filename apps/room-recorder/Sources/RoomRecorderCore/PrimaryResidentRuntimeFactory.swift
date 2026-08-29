import Foundation
import TapeCapture
import TapeCore

public enum PrimaryResidentRuntimeFactory {
  public static func make(
    configuration: RoomConfiguration,
    context: RoomResidentRuntimeContext,
    keyLifecycle: ArchiveKeyLifecycle = ArchiveKeyLifecycle(),
    now: @escaping @Sendable () -> Date = { Date() }
  ) throws -> RoomResidentRuntime {
    guard
      configuration.residentArchiveEligibility(archiveRootURL: context.archiveRootURL) == .eligible,
      let receipt = configuration.archivePreflightReceipt
    else {
      throw RoomEngineError.residentArchivePreflightMismatch
    }
    guard let wire = context.archiveDeliveryWire else {
      throw RoomEngineError.residentArchiveRuntimeUnavailable
    }
    let day = try ArchiveISTDay(containing: now())
    let retainedPrimary = try ArchiveRetainedLaneCatalog(rootURL: context.archiveRootURL).scan()
      .filter {
        $0.descriptor.context.roomID == context.roomID
          && $0.descriptor.context.laneID == "primary"
      }
      .sorted { $0.descriptor.context.istDate < $1.descriptor.context.istDate }
    let journalDay: ArchiveISTDay
    if let latest = retainedPrimary.last,
      latest.descriptor.context.istDate < day.description
    {
      journalDay = try ArchiveISTDay(latest.descriptor.context.istDate)
    } else {
      journalDay = day
    }
    let controlJournal = try RotatingArchiveRoomControlJournal(
      rootURL: context.archiveRootURL,
      roomID: context.roomID,
      keyLifecycle: keyLifecycle,
      currentDay: journalDay)
    let recovered = try controlJournal.recover()
    let pendingPlans = try retainedRolloverPlans(
      recovered: recovered,
      roomID: context.roomID,
      stableDeviceUID: configuration.deviceUID)
    let captureBindings: [ArchiveCaptureSessionBinding] = try recovered.values.compactMap {
      command in
      guard command.commandKind == .captureSessionBinding else { return nil }
      guard command.state == .captureSessionBound, let binding = command.captureSessionBinding,
        binding.primaryIdentity.roomID == context.roomID,
        binding.primaryIdentity.laneID == "primary",
        binding.primaryIdentity.stableDeviceUID == configuration.deviceUID
      else {
        throw RoomEngineError.retainedArchiveRecoveryFailed(
          "capture_binding_owner_mismatch:\(command.commandID)")
      }
      return binding
    }
    var serverEndedSessionIDs: Set<String> = []
    for entry in retainedPrimary
    where FileManager.default.fileExists(atPath: entry.layout.journalURL.path) {
      let opened = try keyLifecycle.openExistingLaneSnapshotWithInspection(
        keywrapURL: entry.layout.keywrapURL,
        tapeURL: entry.layout.tapeURL,
        indexURL: entry.layout.indexURL,
        context: entry.descriptor.context,
        initialSamplePosition: entry.descriptor.initialSamplePosition)
      guard opened.keywrap.authenticated,
        opened.keywrap.keywrapDigestHex == entry.descriptor.keywrapDigestHex
      else {
        opened.snapshot.close()
        throw RoomEngineError.retainedArchiveRecoveryFailed("retained_descriptor_mismatch")
      }
      let journal = try opened.snapshot.openJournalStoreForAppend(at: entry.layout.journalURL)
      let replay: [String: ArchiveJournalReplayReservation]
      do {
        replay = try ArchiveJournalReplay.validate(
          journal.scanResult.records.map {
            try ArchiveJournalPayloadCodec.decode($0.plaintext)
          })
        journal.close()
        opened.snapshot.close()
      } catch {
        journal.close()
        opened.snapshot.close()
        throw error
      }
      serverEndedSessionIDs.formUnion(
        replay.values.compactMap {
          $0.serverEndedObserved ? $0.initialReservation.sessionID : nil
        })
    }
    let serverEndedSessionID = try unresolvedServerEndedSessionID(
      evidence: serverEndedSessionIDs,
      recovered: recovered)
    let retainedUnfinalizedSessionID = try retainedUnfinalizedSessionID(
      captureBindings: captureBindings,
      recovered: recovered)
    let capture = try PrimaryResidentArchiveCaptureOwner(
      rootURL: context.archiveRootURL,
      roomID: context.roomID,
      stableDeviceUID: configuration.deviceUID,
      wire: wire,
      spoolCoordinator: ArchiveSpoolCoordinator(
        encoder: ArchiveFFmpegStreamingEncoder(
          command: ArchiveFFmpegCommand(
            executableURL: URL(fileURLWithPath: configuration.ffmpegPath))),
        encoderProvenanceID: receipt.encoderProvenanceID),
      keyLifecycle: keyLifecycle,
      captureFactory: { deviceUID, store, rolloverStoreFactory in
        ResidentAudioCaptureLane(
          stableDeviceUID: deviceUID,
          store: store,
          rolloverStoreFactory: rolloverStoreFactory)
      },
      now: now)
    capture.installRolloverHandlers(
      pendingPlans: pendingPlans,
      captureBindings: captureBindings,
      serverEndedSessionID: serverEndedSessionID,
      retainedUnfinalizedSessionID: retainedUnfinalizedSessionID,
      persistCaptureBinding: { try controlJournal.persistCaptureSessionBinding($0) },
      persistPreparation: { try controlJournal.persistRolloverPreparation($0) },
      persistIntent: {
        try controlJournal.persistRolloverIntent(
          preparation: $0, primary: $1, stagedPrimary: $2)
      },
      resume: { try controlJournal.resumeRollover($0, effects: $1) },
      rotateControl: { try controlJournal.rotate(to: $0) })
    return RoomResidentRuntime(
      capture: capture,
      controlJournal: controlJournal)
  }

  static func unresolvedServerEndedSessionID(
    evidence: Set<String>,
    recovered: [String: RoomRecoveredControlCommand]
  ) throws -> String? {
    var unresolved = evidence
    let locallyEndedSessionIDs = Set(
      recovered.values.compactMap { command -> String? in
        let explicitEndConverged =
          command.commandKind == .endDay
          && [
            ArchiveControlState.sessionEndPatched, .endAckReady, .endAckObserved,
            .endAckOutcomeUnobservable,
          ].contains(command.state)
        let serverEndConverged =
          command.commandKind == .serverEndedFinalization
          && command.state == .serverEndedFinalized
        guard explicitEndConverged || serverEndConverged else { return nil }
        return command.sessionID
      })
    unresolved.subtract(locallyEndedSessionIDs)
    guard unresolved.count <= 1 else {
      throw RoomEngineError.retainedArchiveRecoveryFailed(
        "conflicting_server_ended_sessions")
    }
    return unresolved.first
  }

  static func retainedUnfinalizedSessionID(
    captureBindings: [ArchiveCaptureSessionBinding],
    recovered: [String: RoomRecoveredControlCommand]
  ) throws -> String? {
    var unfinalized = Set(captureBindings.map(\.sessionID))
    let converged = Set(
      recovered.values.compactMap { command -> String? in
        let explicitEndConverged =
          command.commandKind == .endDay
          && [
            ArchiveControlState.sessionEndPatched, .endAckReady, .endAckObserved,
            .endAckOutcomeUnobservable,
          ].contains(command.state)
        let serverEndConverged =
          command.commandKind == .serverEndedFinalization
          && command.state == .serverEndedFinalized
        let compensatedStartConverged =
          command.commandKind == .startDay
          && [
            ArchiveControlState.sessionEndPatched, .startFailed, .startFailureAckReady,
            .startFailureAckObserved, .startFailureAckOutcomeUnobservable,
          ].contains(command.state)
        guard explicitEndConverged || serverEndConverged || compensatedStartConverged else {
          return nil
        }
        return command.sessionID
      })
    unfinalized.subtract(converged)
    guard unfinalized.count <= 1 else {
      throw RoomEngineError.retainedArchiveRecoveryFailed(
        "conflicting_unfinalized_capture_sessions")
    }
    return unfinalized.first
  }

  static func retainedRolloverPlans(
    recovered: [String: RoomRecoveredControlCommand],
    roomID: String,
    stableDeviceUID: String
  ) throws -> [ArchiveRolloverPlan] {
    if let failed = recovered.values.first(where: {
      $0.commandKind == .rollover && $0.state == .rolloverFailed
    }) {
      throw RoomEngineError.retainedArchiveRecoveryFailed(
        "rollover_failed:\(failed.commandID)")
    }
    return try recovered.values.compactMap { command -> ArchiveRolloverPlan? in
      guard command.commandKind == .rollover else { return nil }
      guard let plan = command.rolloverPlan else {
        if command.state == .rolloverComplete { return nil }
        throw RoomEngineError.retainedArchiveRecoveryFailed(
          "rollover_plan_missing:\(command.commandID)")
      }
      guard plan.primary.oldDay.roomID == roomID,
        plan.primary.newDay.roomID == roomID,
        plan.primary.oldDay.stableDeviceUID == stableDeviceUID,
        plan.primary.newDay.stableDeviceUID == stableDeviceUID,
        plan.backup == nil
      else {
        throw RoomEngineError.retainedArchiveRecoveryFailed(
          "rollover_plan_owner_mismatch:\(command.commandID)")
      }
      return plan
    }
  }
}
