import CryptoKit
import Foundation
import TapeCore

enum RetainedArchiveRolloverRecoveryError: Error, Equatable {
  case failedRollover(String)
  case retainedDescriptorMismatch
  case preparationHasBackup
  case incompleteRollover(String)
}

struct RetainedArchiveRolloverRecovery: Sendable {
  let rootURL: URL
  let keyLifecycle: ArchiveKeyLifecycle

  func run() throws {
    let catalog = try ArchiveRetainedLaneCatalog(rootURL: rootURL)
    let controls = try catalog.scanIncludingControls().controls.filter(\.journalPresent)
    let grouped = Dictionary(grouping: controls, by: { $0.descriptor.context.roomID })
    var rooms:
      [(
        journal: RotatingArchiveRoomControlJournal,
        recovered: [String: RoomRecoveredControlCommand]
      )] = []

    for roomID in grouped.keys.sorted() {
      guard let roomControls = grouped[roomID],
        let currentDay = try roomControls.map({
          try ArchiveISTDay($0.descriptor.context.istDate)
        }).max(by: { $0.description < $1.description })
      else { continue }
      let journal = try RotatingArchiveRoomControlJournal(
        rootURL: rootURL,
        roomID: roomID,
        keyLifecycle: keyLifecycle,
        currentDay: currentDay)
      let recovered = try journal.recover()
      try rejectFailedRollovers(recovered)
      rooms.append((journal, recovered))
    }

    for room in rooms {
      let journal = room.journal
      var recovered = room.recovered
      let preparationCommands = recovered.values.filter {
        $0.commandKind == .rolloverPreparation
      }.sorted(by: Self.controlOrder)
      for command in preparationCommands {
        guard let preparation = command.rolloverPreparation else {
          throw RetainedArchiveRolloverRecoveryError.retainedDescriptorMismatch
        }
        let hasPlan = recovered.values.contains {
          $0.commandKind == .rollover && $0.rolloverPlan?.preparationID == preparation.commandID
        }
        if !hasPlan {
          _ = try promote(preparation, with: journal)
          recovered = try journal.recover()
          try rejectFailedRollovers(recovered)
        }
      }

      let pending = recovered.values.compactMap { command -> ArchiveRolloverPlan? in
        guard command.commandKind == .rollover,
          command.state != .rolloverComplete,
          command.state != .rolloverFailed
        else { return nil }
        return command.rolloverPlan
      }.sorted {
        $0.primary.oldDay.context.istDate < $1.primary.oldDay.context.istDate
      }
      for plan in pending {
        try journal.publishRolloverArtifacts(plan)
        try authenticatePlanFacts(plan)
        let effects = retainedEffects()
        guard try journal.resumeRollover(plan, effects: effects) == .rolloverComplete else {
          throw RetainedArchiveRolloverRecoveryError.incompleteRollover(plan.commandID)
        }
      }
    }
  }

  private func authenticatePlanFacts(_ plan: ArchiveRolloverPlan) throws {
    for lane in audioLanes(plan) {
      let old = try openExact(lane.oldDay)
      let oldFacts = old.snapshot.authenticatedFacts
      old.snapshot.close()
      guard oldFacts == lane.oldAuthenticatedFacts else {
        throw ArchiveRolloverEffectFailure.authenticationFailed
      }

      let new = try openExact(lane.newDay)
      let newFacts = new.snapshot.authenticatedFacts
      new.snapshot.close()
      guard newFacts.context == lane.newDay.context,
        newFacts.initialSamplePosition == lane.boundarySample,
        newFacts.authenticatedSampleEnd >= lane.newAuthenticatedFacts.authenticatedSampleEnd,
        newFacts.recordCount >= lane.newAuthenticatedFacts.recordCount
      else {
        throw ArchiveRolloverEffectFailure.authenticationFailed
      }
    }
  }

  private func rejectFailedRollovers(
    _ recovered: [String: RoomRecoveredControlCommand]
  ) throws {
    if let failed = recovered.values.first(where: {
      $0.commandKind == .rollover && $0.state == .rolloverFailed
    }) {
      throw RetainedArchiveRolloverRecoveryError.failedRollover(failed.commandID)
    }
  }

  private func promote(
    _ preparation: ArchiveRolloverPreparation,
    with journal: RotatingArchiveRoomControlJournal
  ) throws -> ArchiveRolloverPlan {
    let old = try openExact(preparation.oldDay)
    defer { old.snapshot.close() }
    guard old.snapshot.authenticatedFacts == preparation.oldAuthenticatedFacts else {
      throw RetainedArchiveRolloverRecoveryError.retainedDescriptorMismatch
    }

    let catalog = try ArchiveRetainedLaneCatalog(rootURL: rootURL)
    let retainedLanes = try catalog.scan()
    guard
      !retainedLanes.contains(
        where: {
          $0.descriptor.context.roomID == preparation.oldDay.roomID
            && $0.descriptor.context.laneID == "backup"
            && ($0.descriptor.context.istDate == preparation.oldDay.context.istDate
              || $0.descriptor.context.istDate == preparation.targetISTDay.description)
        }
      )
    else {
      throw RetainedArchiveRolloverRecoveryError.preparationHasBackup
    }
    let adjacent = retainedLanes.filter {
      $0.descriptor.context.roomID == preparation.oldDay.roomID
        && $0.descriptor.context.istDate == preparation.targetISTDay.description
        && $0.descriptor.context.laneID == "primary"
    }
    guard adjacent.count <= 1 else {
      throw RetainedArchiveRolloverRecoveryError.retainedDescriptorMismatch
    }

    guard adjacent.isEmpty else {
      throw RetainedArchiveRolloverRecoveryError.retainedDescriptorMismatch
    }
    let builder = try ArchiveRetainedLaneBuilder(rootURL: rootURL, keyLifecycle: keyLifecycle)
    let staged =
      try builder.reopenStagedNextDayLane(
        stageID: preparation.commandID,
        oldDaySnapshot: old.snapshot,
        roomID: preparation.oldDay.roomID,
        istDate: preparation.targetISTDay.description,
        stableDeviceUID: preparation.oldDay.stableDeviceUID,
        expectedInitialSamplePosition: preparation.boundarySample)
      ?? builder.stageNextDayLane(
        stageID: preparation.commandID,
        context: ArchiveContext(
          streamUUID: try ArchiveRetainedLaneBuilder.deterministicRolloverStreamUUID(
            stageID: preparation.commandID, kind: .primary),
          roomID: preparation.oldDay.roomID,
          istDate: preparation.targetISTDay.description,
          laneID: "primary",
          stableDeviceUID: preparation.oldDay.stableDeviceUID),
        oldDaySnapshot: old.snapshot,
        expectedInitialSamplePosition: preparation.boundarySample)
    defer { staged.store.close() }
    let newIdentity = staged.identity
    let newSnapshot = try staged.store.authenticatedSnapshot()
    let newFacts = newSnapshot.authenticatedFacts
    newSnapshot.close()
    guard newFacts.context == newIdentity.context,
      newFacts.initialSamplePosition == preparation.boundarySample,
      newFacts.authenticatedSampleEnd == preparation.boundarySample,
      newFacts.recordCount == 0
    else {
      throw RetainedArchiveRolloverRecoveryError.retainedDescriptorMismatch
    }
    let primary = try ArchiveRolloverAudioLane(
      oldDay: preparation.oldDay,
      newDay: newIdentity,
      nextChunkIndex: UInt64(preparation.nextChunkIndex),
      boundarySample: preparation.boundarySample,
      oldAuthenticatedFacts: preparation.oldAuthenticatedFacts,
      newAuthenticatedFacts: newFacts)
    let plan = try journal.persistRolloverIntent(
      preparation: preparation,
      primary: primary,
      stagedPrimary: staged)
    guard plan.preparationID == preparation.commandID, plan.primary == primary,
      plan.backup == nil
    else {
      throw RetainedArchiveRolloverRecoveryError.retainedDescriptorMismatch
    }
    return plan
  }

  private func retainedEffects() -> ArchiveRolloverEffects {
    ArchiveRolloverEffects(
      reserveOldDayFinal: { try reserveOldDayFinal($0) },
      closeOldDayFiles: { try authenticateOldDay($0) },
      makeNewDayFilesDurable: { try authenticateNewDay($0) })
  }

  private func reserveOldDayFinal(
    _ plan: ArchiveRolloverPlan
  ) throws -> ArchiveRolloverEffectReceipt {
    var witness = Data()
    var mutated = false
    for lane in audioLanes(plan) {
      let opened = try openExact(lane.oldDay)
      defer { opened.snapshot.close() }
      guard opened.snapshot.authenticatedFacts == lane.oldAuthenticatedFacts else {
        throw ArchiveRolloverEffectFailure.authenticationFailed
      }
      let result = try ArchiveLocalDeriver.derive(
        snapshot: opened.snapshot,
        journalURL: opened.entry.layout.journalURL,
        levelURL: opened.entry.layout.levelURL,
        sessionID: plan.sessionID,
        finalFlush: true,
        startingChunkIndex: UInt64(lane.nextChunkIndex))
      let relevant = result.reservations.filter {
        $0.sessionID == plan.sessionID && $0.laneID == lane.oldDay.laneID
      }.sorted {
        if $0.sampleStart != $1.sampleStart { return $0.sampleStart < $1.sampleStart }
        return $0.chunkIndex < $1.chunkIndex
      }
      let expectedStart = max(
        plan.sessionSampleStart,
        lane.oldDay.expectedInitialSessionSample)
      try validateCoverage(
        relevant,
        expectedStart: expectedStart,
        expectedEnd: lane.boundarySample)
      appendLengthPrefixed(try factsWitness(opened.snapshot.authenticatedFacts), to: &witness)
      for reservation in relevant {
        appendLengthPrefixed(try ArchiveJournalPayloadCodec.encode(reservation), to: &witness)
      }
      mutated = mutated || result.journalRecordsWritten > 0 || result.levelRecordsWritten > 0
    }
    return try receipt(
      kind: .reserveOldDayFinal,
      plan: plan,
      actualWitness: witness,
      performedDurableMutation: mutated)
  }

  private func authenticateOldDay(
    _ plan: ArchiveRolloverPlan
  ) throws -> ArchiveRolloverEffectReceipt {
    var witness = Data()
    for lane in audioLanes(plan) {
      let opened = try openExact(lane.oldDay)
      let facts = opened.snapshot.authenticatedFacts
      opened.snapshot.close()
      guard facts == lane.oldAuthenticatedFacts else {
        throw ArchiveRolloverEffectFailure.authenticationFailed
      }
      appendLengthPrefixed(try factsWitness(facts), to: &witness)
    }
    return try receipt(
      kind: .closeOldDayFiles,
      plan: plan,
      actualWitness: witness,
      performedDurableMutation: false)
  }

  private func authenticateNewDay(
    _ plan: ArchiveRolloverPlan
  ) throws -> ArchiveRolloverEffectReceipt {
    var witness = Data()
    for lane in audioLanes(plan) {
      let opened = try openExact(lane.newDay)
      let facts = opened.snapshot.authenticatedFacts
      opened.snapshot.close()
      guard facts.context == lane.newDay.context,
        facts.initialSamplePosition == lane.boundarySample,
        facts.authenticatedSampleEnd >= lane.newAuthenticatedFacts.authenticatedSampleEnd,
        facts.recordCount >= lane.newAuthenticatedFacts.recordCount
      else {
        throw ArchiveRolloverEffectFailure.authenticationFailed
      }
      appendLengthPrefixed(try factsWitness(facts), to: &witness)
    }
    return try receipt(
      kind: .makeNewDayFilesDurable,
      plan: plan,
      actualWitness: witness,
      performedDurableMutation: false)
  }

  private func audioLanes(_ plan: ArchiveRolloverPlan) -> [ArchiveRolloverAudioLane] {
    [plan.primary, plan.backup].compactMap { $0 }
  }

  private func validateCoverage(
    _ reservations: [ArchiveJournalPayload],
    expectedStart: UInt64,
    expectedEnd: UInt64
  ) throws {
    if expectedStart == expectedEnd {
      guard reservations.isEmpty else { throw ArchiveRolloverEffectFailure.authenticationFailed }
      return
    }
    guard reservations.first?.sampleStart == expectedStart,
      reservations.last?.sampleEnd == expectedEnd
    else {
      throw ArchiveRolloverEffectFailure.authenticationFailed
    }
    do {
      try ArchiveReservationIndexReconciler.validate(reservations)
    } catch {
      throw ArchiveRolloverEffectFailure.authenticationFailed
    }
  }

  private func openExact(
    _ identity: ArchiveDailyLaneIdentity,
    expectedEntry: ArchiveRetainedLaneCatalogEntry? = nil
  ) throws -> (
    entry: ArchiveRetainedLaneCatalogEntry,
    identity: ArchiveDailyLaneIdentity,
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot
  ) {
    let matches = try ArchiveRetainedLaneCatalog(rootURL: rootURL).scan().filter {
      $0.descriptor.context == identity.context
        && $0.descriptor.initialSamplePosition == identity.expectedInitialSessionSample
        && $0.descriptor.keywrapDigestHex == identity.keywrapDigestHex
    }
    guard matches.count == 1, let entry = matches.first,
      expectedEntry == nil || expectedEntry == entry
    else {
      throw RetainedArchiveRolloverRecoveryError.retainedDescriptorMismatch
    }
    let opened = try keyLifecycle.openExistingLaneSnapshotWithInspection(
      keywrapURL: entry.layout.keywrapURL,
      tapeURL: entry.layout.tapeURL,
      indexURL: entry.layout.indexURL,
      context: identity.context,
      initialSamplePosition: identity.expectedInitialSessionSample)
    guard opened.keywrap.authenticated,
      opened.keywrap.keywrapDigestHex == identity.keywrapDigestHex
    else {
      opened.snapshot.close()
      throw RetainedArchiveRolloverRecoveryError.retainedDescriptorMismatch
    }
    let actualIdentity: ArchiveDailyLaneIdentity
    do {
      actualIdentity = try ArchiveDailyLaneIdentity(
        context: entry.descriptor.context,
        expectedInitialSessionSample: entry.descriptor.initialSamplePosition,
        keywrap: opened.keywrap)
    } catch {
      opened.snapshot.close()
      throw error
    }
    guard actualIdentity == identity else {
      opened.snapshot.close()
      throw RetainedArchiveRolloverRecoveryError.retainedDescriptorMismatch
    }
    return (entry, actualIdentity, opened.snapshot)
  }

  private func identity(
    for entry: ArchiveRetainedLaneCatalogEntry,
    keyLifecycle: ArchiveKeyLifecycle
  ) throws -> ArchiveDailyLaneIdentity {
    let opened = try keyLifecycle.openExistingLaneSnapshotWithInspection(
      keywrapURL: entry.layout.keywrapURL,
      tapeURL: entry.layout.tapeURL,
      indexURL: entry.layout.indexURL,
      context: entry.descriptor.context,
      initialSamplePosition: entry.descriptor.initialSamplePosition)
    defer { opened.snapshot.close() }
    guard opened.keywrap.authenticated,
      opened.keywrap.keywrapDigestHex == entry.descriptor.keywrapDigestHex
    else {
      throw RetainedArchiveRolloverRecoveryError.retainedDescriptorMismatch
    }
    return try ArchiveDailyLaneIdentity(
      context: entry.descriptor.context,
      expectedInitialSessionSample: entry.descriptor.initialSamplePosition,
      keywrap: opened.keywrap)
  }

  private func receipt(
    kind: ArchiveRolloverEffectKind,
    plan: ArchiveRolloverPlan,
    actualWitness: Data,
    performedDurableMutation: Bool
  ) throws -> ArchiveRolloverEffectReceipt {
    var canonical = Data("eta.room-recorder/rollover-effect-witness/v1".utf8)
    appendLengthPrefixed(try ArchiveRolloverPlanCodec.encode(plan), to: &canonical)
    appendLengthPrefixed(Data(kind.rawValue.utf8), to: &canonical)
    appendLengthPrefixed(actualWitness, to: &canonical)
    let digest = Data(SHA256.hash(data: canonical)).map { String(format: "%02x", $0) }.joined()
    return ArchiveRolloverEffectReceipt(
      kind: kind,
      commandID: plan.commandID,
      expectedDurableDigestHex: digest,
      observedDurableDigestHex: digest,
      performedDurableMutation: performedDurableMutation)
  }

  private func factsWitness(_ facts: ArchiveAuthenticatedLaneFacts) throws -> Data {
    var result = Data()
    appendLengthPrefixed(try facts.context.encodedBytes(), to: &result)
    append(facts.initialSamplePosition, to: &result)
    append(facts.authenticatedSampleEnd, to: &result)
    append(UInt64(facts.recordCount), to: &result)
    return result
  }

  private func appendLengthPrefixed(_ value: Data, to data: inout Data) {
    append(UInt64(value.count), to: &data)
    data.append(value)
  }

  private func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
    for index in 0..<MemoryLayout<T>.size {
      data.append(UInt8(truncatingIfNeeded: value >> T(index * 8)))
    }
  }

  private static func controlOrder(
    _ left: RoomRecoveredControlCommand,
    _ right: RoomRecoveredControlCommand
  ) -> Bool {
    (left.atWallNS, left.atMonoNS, left.commandID)
      < (right.atWallNS, right.atMonoNS, right.commandID)
  }
}
