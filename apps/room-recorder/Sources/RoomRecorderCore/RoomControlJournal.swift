import Foundation
import TapeCore

public struct RoomControlTransition: Equatable, Sendable {
  public let commandID: String
  public let commandKind: ArchiveControlCommandKind
  public let sessionID: String?
  public let priorState: ArchiveControlState?
  public let newState: ArchiveControlState
  public let failure: ArchiveControlFailure?
  public let captureSessionBinding: ArchiveCaptureSessionBinding?
  public let rolloverPlan: ArchiveRolloverPlan?
  public let rolloverPreparation: ArchiveRolloverPreparation?

  public init(
    commandID: String,
    commandKind: ArchiveControlCommandKind,
    sessionID: String?,
    priorState: ArchiveControlState?,
    newState: ArchiveControlState,
    failure: ArchiveControlFailure? = nil,
    captureSessionBinding: ArchiveCaptureSessionBinding? = nil,
    rolloverPlan: ArchiveRolloverPlan? = nil,
    rolloverPreparation: ArchiveRolloverPreparation? = nil
  ) {
    self.commandID = commandID
    self.commandKind = commandKind
    self.sessionID = sessionID
    self.priorState = priorState
    self.newState = newState
    self.failure = failure
    self.captureSessionBinding = captureSessionBinding
    self.rolloverPlan = rolloverPlan
    self.rolloverPreparation = rolloverPreparation
  }
}

public struct RoomRecoveredControlCommand: Equatable, Sendable {
  public let commandID: String
  public let commandKind: ArchiveControlCommandKind
  public let sessionID: String?
  public let state: ArchiveControlState
  public let failure: ArchiveControlFailure?
  public let atMonoNS: UInt64
  public let atWallNS: UInt64
  public let captureSessionBinding: ArchiveCaptureSessionBinding?
  public let rolloverPlan: ArchiveRolloverPlan?
  public let rolloverPreparation: ArchiveRolloverPreparation?

  public init(
    commandID: String,
    commandKind: ArchiveControlCommandKind,
    sessionID: String?,
    state: ArchiveControlState,
    failure: ArchiveControlFailure?,
    atMonoNS: UInt64,
    atWallNS: UInt64,
    captureSessionBinding: ArchiveCaptureSessionBinding? = nil,
    rolloverPlan: ArchiveRolloverPlan? = nil,
    rolloverPreparation: ArchiveRolloverPreparation? = nil
  ) {
    self.commandID = commandID
    self.commandKind = commandKind
    self.sessionID = sessionID
    self.state = state
    self.failure = failure
    self.atMonoNS = atMonoNS
    self.atWallNS = atWallNS
    self.captureSessionBinding = captureSessionBinding
    self.rolloverPlan = rolloverPlan
    self.rolloverPreparation = rolloverPreparation
  }
}

public protocol RoomControlJournalOwning: AnyObject, Sendable {
  func recover() throws -> [String: RoomRecoveredControlCommand]
  @discardableResult
  func advance(_ transition: RoomControlTransition) throws -> RoomRecoveredControlCommand
}

public final class ArchiveRoomControlJournal: RoomControlJournalOwning, @unchecked Sendable {
  public typealias Clock = @Sendable () -> (monotonicNS: UInt64, wallNS: UInt64)

  private let lock = NSLock()
  private let store: ArchiveDerivedStore
  private let clock: Clock

  public init(
    store: ArchiveDerivedStore,
    clock: @escaping Clock = {
      (DispatchTime.now().uptimeNanoseconds, UInt64(Date().timeIntervalSince1970 * 1_000_000_000))
    }
  ) {
    self.store = store
    self.clock = clock
  }

  deinit { store.close() }

  public func recover() throws -> [String: RoomRecoveredControlCommand] {
    try lock.withLock { try replay() }
  }

  func persistRolloverIntent(_ plan: ArchiveRolloverPlan) throws -> ArchiveControlState {
    try lock.withLock {
      try ArchiveRolloverCoordinator.persistIntent(
        plan: plan,
        controlStore: store,
        clock: ArchiveRolloverClock(now: clock))
    }
  }

  func resumeRollover(
    _ plan: ArchiveRolloverPlan,
    effects: ArchiveRolloverEffects
  ) throws -> ArchiveControlState {
    try lock.withLock {
      try ArchiveRolloverCoordinator.resume(
        plan: plan,
        controlStore: store,
        effects: effects,
        clock: ArchiveRolloverClock(now: clock))
    }
  }

  @discardableResult
  public func advance(_ transition: RoomControlTransition) throws -> RoomRecoveredControlCommand {
    try lock.withLock {
      let records = store.scanResult.records
      let payloads = try records.map { try ArchiveControlPayloadCodec.decode($0.plaintext) }
      let replay = try ArchiveControlReplay.validate(payloads)
      let lastPayload = payloads.last { $0.commandID == transition.commandID }
      let lastFailure = payloads.last {
        $0.commandID == transition.commandID && $0.error != nil
      }?.error

      if let current = replay[transition.commandID], current.state == transition.newState {
        guard let lastPayload,
          lastPayload.commandKind == transition.commandKind,
          lastPayload.sessionID == transition.sessionID,
          lastPayload.priorState == transition.priorState,
          lastPayload.error == transition.failure,
          lastPayload.captureSessionBinding == transition.captureSessionBinding,
          lastPayload.rolloverPlan == transition.rolloverPlan,
          lastPayload.rolloverPreparation == transition.rolloverPreparation
        else {
          throw ArchiveControlPayloadError.replayStateMismatch(
            commandID: transition.commandID,
            expected: current.state,
            actual: transition.priorState)
        }
        return recovered(
          commandID: transition.commandID,
          payload: lastPayload,
          failure: lastFailure)
      }

      let expectedPrior = replay[transition.commandID]?.state
      guard expectedPrior == transition.priorState else {
        throw ArchiveControlPayloadError.replayStateMismatch(
          commandID: transition.commandID,
          expected: expectedPrior,
          actual: transition.priorState)
      }

      let now = clock()
      let payload = try ArchiveControlPayload(
        commandID: transition.commandID,
        commandKind: transition.commandKind,
        sessionID: transition.sessionID,
        priorState: transition.priorState,
        newState: transition.newState,
        atMonoNS: max(lastPayload?.atMonoNS ?? 0, now.monotonicNS),
        atWallNS: max(lastPayload?.atWallNS ?? 0, now.wallNS),
        error: transition.failure,
        captureSessionBinding: transition.captureSessionBinding,
        rolloverPlan: transition.rolloverPlan,
        rolloverPreparation: transition.rolloverPreparation)
      _ = try store.append(
        plaintext: ArchiveControlPayloadCodec.encode(payload),
        firstLogicalUnit: UInt64(records.count),
        logicalUnitCount: 1)
      return recovered(
        commandID: transition.commandID,
        payload: payload,
        failure: transition.failure ?? lastFailure)
    }
  }

  private func replay() throws -> [String: RoomRecoveredControlCommand] {
    let payloads = try store.scanResult.records.map {
      try ArchiveControlPayloadCodec.decode($0.plaintext)
    }
    let replay = try ArchiveControlReplay.validate(payloads)
    var result: [String: RoomRecoveredControlCommand] = [:]
    var failures: [String: ArchiveControlFailure] = [:]
    for payload in payloads {
      if let failure = payload.error { failures[payload.commandID] = failure }
    }
    for (commandID, command) in replay {
      result[commandID] = RoomRecoveredControlCommand(
        commandID: commandID,
        commandKind: command.commandKind,
        sessionID: command.sessionID,
        state: command.state,
        failure: failures[commandID],
        atMonoNS: command.atMonoNS,
        atWallNS: command.atWallNS,
        captureSessionBinding: command.captureSessionBinding,
        rolloverPlan: command.rolloverPlan,
        rolloverPreparation: command.rolloverPreparation)
    }
    return result
  }

  private func recovered(
    commandID: String,
    payload: ArchiveControlPayload,
    failure: ArchiveControlFailure?
  ) -> RoomRecoveredControlCommand {
    RoomRecoveredControlCommand(
      commandID: commandID,
      commandKind: payload.commandKind,
      sessionID: payload.sessionID,
      state: payload.newState,
      failure: failure,
      atMonoNS: payload.atMonoNS,
      atWallNS: payload.atWallNS,
      captureSessionBinding: payload.captureSessionBinding,
      rolloverPlan: payload.rolloverPlan,
      rolloverPreparation: payload.rolloverPreparation)
  }
}

enum RotatingRoomControlJournalError: Error, Equatable {
  case nonAdjacentDay
  case duplicateCommand(String)
  case retainedDescriptorMismatch
}

enum RetainedRolloverCommitPoint: Equatable, Sendable {
  case controlStaged
  case planAppended
  case controlPublished
  case audioPublished
}

final class RotatingArchiveRoomControlJournal: RoomControlJournalOwning, @unchecked Sendable {
  private struct DailyJournal {
    let day: ArchiveISTDay
    let identity: ArchiveDailyControlIdentity
    let journal: ArchiveRoomControlJournal
  }

  private let lock = NSLock()
  private let roomID: String
  private let builder: ArchiveRetainedLaneBuilder
  private let catalog: ArchiveRetainedLaneCatalog
  private let keyLifecycle: ArchiveKeyLifecycle
  private let rolloverCheckpoint: @Sendable (RetainedRolloverCommitPoint) throws -> Void
  private var journals: [DailyJournal]
  private var currentDay: ArchiveISTDay

  init(
    rootURL: URL,
    roomID: String,
    keyLifecycle: ArchiveKeyLifecycle,
    currentDay: ArchiveISTDay,
    rolloverCheckpoint: @escaping @Sendable (RetainedRolloverCommitPoint) throws -> Void = { _ in }
  ) throws {
    self.roomID = roomID
    self.keyLifecycle = keyLifecycle
    self.rolloverCheckpoint = rolloverCheckpoint
    builder = try ArchiveRetainedLaneBuilder(rootURL: rootURL, keyLifecycle: keyLifecycle)
    catalog = try ArchiveRetainedLaneCatalog(rootURL: rootURL)
    self.currentDay = currentDay
    journals = []

    let controls = try catalog.scanIncludingControls().controls.filter {
      $0.descriptor.context.roomID == roomID
        && ($0.journalPresent || $0.descriptor.context.istDate == currentDay.description)
    }.sorted { $0.descriptor.context.istDate < $1.descriptor.context.istDate }
    for entry in controls {
      journals.append(try Self.open(entry: entry, keyLifecycle: keyLifecycle))
    }
    if !journals.contains(where: { $0.day == currentDay }) {
      journals.append(try makeJournal(day: currentDay))
    }
  }

  func recover() throws -> [String: RoomRecoveredControlCommand] {
    try lock.withLock { try recoverLocked().commands }
  }

  @discardableResult
  func advance(_ transition: RoomControlTransition) throws -> RoomRecoveredControlCommand {
    try lock.withLock {
      let recovered = try recoverLocked()
      let journal =
        recovered.owners[transition.commandID]?.journal
        ?? journals.first(where: { $0.day == currentDay })?.journal
      guard let journal else { throw RotatingRoomControlJournalError.retainedDescriptorMismatch }
      return try journal.advance(transition)
    }
  }

  func rotate(to day: ArchiveISTDay) throws {
    try lock.withLock {
      let nextDay = try currentDay.next
      guard day == currentDay || nextDay == day else {
        throw RotatingRoomControlJournalError.nonAdjacentDay
      }
      if !journals.contains(where: { $0.day == day }) {
        journals.append(try makeJournal(day: day))
        journals.sort { $0.day.description < $1.day.description }
      }
      currentDay = day
    }
  }

  func persistRolloverPreparation(_ preparation: ArchiveRolloverPreparation) throws {
    try lock.withLock {
      guard preparation.oldDay.roomID == roomID,
        preparation.oldDay.context.istDate == currentDay.description,
        let journal = journals.first(where: { $0.day == currentDay })?.journal
      else {
        throw RotatingRoomControlJournalError.retainedDescriptorMismatch
      }
      _ = try journal.advance(
        RoomControlTransition(
          commandID: preparation.commandID,
          commandKind: .rolloverPreparation,
          sessionID: preparation.sessionID,
          priorState: nil,
          newState: .rolloverPreparation,
          rolloverPreparation: preparation))
    }
  }

  func persistCaptureSessionBinding(_ binding: ArchiveCaptureSessionBinding) throws {
    try lock.withLock {
      guard binding.primaryIdentity.roomID == roomID,
        let journal = journals.first(where: {
          $0.day.description == binding.primaryIdentity.context.istDate
        })?.journal
      else {
        throw RotatingRoomControlJournalError.retainedDescriptorMismatch
      }
      _ = try journal.advance(
        RoomControlTransition(
          commandID: binding.commandID,
          commandKind: .captureSessionBinding,
          sessionID: binding.sessionID,
          priorState: nil,
          newState: .captureSessionBound,
          captureSessionBinding: binding))
    }
  }

  func persistRolloverIntent(
    preparation: ArchiveRolloverPreparation,
    primary: ArchiveRolloverAudioLane,
    stagedPrimary: ArchiveStagedRetainedLane
  ) throws -> ArchiveRolloverPlan {
    try lock.withLock {
      let oldDay = try preparation.oldDay.istDay
      let targetDay = try primary.newDay.istDay
      guard
        preparation.commandID
          == (try ArchiveRolloverPreparation(
            sessionID: preparation.sessionID,
            sessionSampleStart: preparation.sessionSampleStart,
            oldDay: primary.oldDay,
            boundarySample: primary.boundarySample,
            nextChunkIndex: primary.nextChunkIndex,
            oldAuthenticatedFacts: primary.oldAuthenticatedFacts,
            targetISTDay: targetDay)).commandID,
        preparation.targetISTDay == targetDay,
        stagedPrimary.stageID == preparation.commandID,
        stagedPrimary.identity == primary.newDay,
        let old = journals.first(where: { $0.day == oldDay })
      else {
        throw RotatingRoomControlJournalError.retainedDescriptorMismatch
      }
      guard
        try old.journal.recover()[preparation.commandID]?.rolloverPreparation == preparation
      else {
        throw RotatingRoomControlJournalError.retainedDescriptorMismatch
      }
      let nextDay = try oldDay.next
      let stagedControl = try stagedRolloverControl(
        preparationID: preparation.commandID,
        day: nextDay)
      try rolloverCheckpoint(.controlStaged)
      let plan = try ArchiveRolloverPlan(
        sessionID: preparation.sessionID,
        sessionSampleStart: preparation.sessionSampleStart,
        preparationID: preparation.commandID,
        primary: primary,
        backup: nil,
        oldControl: old.identity,
        newControl: stagedControl.identity)
      _ = try old.journal.persistRolloverIntent(plan)
      try rolloverCheckpoint(.planAppended)
      let controlEntry = try builder.publishStagedControl(stagedControl)
      try rolloverCheckpoint(.controlPublished)
      _ = try builder.publishStagedLane(stagedPrimary)
      try rolloverCheckpoint(.audioPublished)
      try adoptPublishedControl(controlEntry, expectedIdentity: plan.newControl)
      if currentDay.description < nextDay.description { currentDay = nextDay }
      return plan
    }
  }

  func publishRolloverArtifacts(_ plan: ArchiveRolloverPlan) throws {
    try lock.withLock {
      let recovered = try recoverLocked()
      let expectedPreparation = try ArchiveRolloverPreparation(
        sessionID: plan.sessionID,
        sessionSampleStart: plan.sessionSampleStart,
        oldDay: plan.primary.oldDay,
        boundarySample: plan.primary.boundarySample,
        nextChunkIndex: plan.primary.nextChunkIndex,
        oldAuthenticatedFacts: plan.primary.oldAuthenticatedFacts,
        targetISTDay: plan.primary.newDay.istDay)
      guard let owner = recovered.owners[plan.commandID], owner.identity == plan.oldControl,
        plan.preparationID == expectedPreparation.commandID,
        recovered.commands[plan.preparationID]?.rolloverPreparation == expectedPreparation
      else {
        throw RotatingRoomControlJournalError.retainedDescriptorMismatch
      }

      let snapshot = try catalog.scanIncludingControls()
      let controls = snapshot.controls.filter {
        $0.descriptor.context.istDate == plan.newControl.context.istDate
          && $0.descriptor.context.roomID == roomID
      }
      let controlEntry: ArchiveRetainedControlCatalogEntry
      if controls.isEmpty {
        guard
          let staged = try builder.reopenStagedControl(
            stageID: plan.preparationID, identity: plan.newControl)
        else {
          throw RotatingRoomControlJournalError.retainedDescriptorMismatch
        }
        controlEntry = try builder.publishStagedControl(staged)
      } else {
        guard controls.count == 1,
          controls[0].descriptor
            == (try ArchiveRetainedControlDescriptor(identity: plan.newControl))
        else {
          throw RotatingRoomControlJournalError.retainedDescriptorMismatch
        }
        controlEntry = controls[0]
      }

      let lanes = try catalog.scan().filter {
        $0.descriptor.context.istDate == plan.primary.newDay.context.istDate
          && $0.descriptor.context.roomID == roomID
          && $0.descriptor.context.laneID == "primary"
      }
      if lanes.isEmpty {
        let oldEntry = try exactLaneEntry(plan.primary.oldDay)
        let old = try keyLifecycle.openExistingLaneSnapshotWithInspection(
          keywrapURL: oldEntry.layout.keywrapURL,
          tapeURL: oldEntry.layout.tapeURL,
          indexURL: oldEntry.layout.indexURL,
          context: plan.primary.oldDay.context,
          initialSamplePosition: plan.primary.oldDay.expectedInitialSessionSample)
        defer { old.snapshot.close() }
        guard old.keywrap.authenticated,
          old.keywrap.keywrapDigestHex == plan.primary.oldDay.keywrapDigestHex,
          let staged = try builder.reopenStagedLane(
            stageID: plan.preparationID,
            identity: plan.primary.newDay,
            oldDaySnapshot: old.snapshot)
        else {
          throw RotatingRoomControlJournalError.retainedDescriptorMismatch
        }
        defer { staged.store.close() }
        _ = try builder.publishStagedLane(staged)
      } else {
        guard lanes.count == 1,
          lanes[0].descriptor == (try ArchiveRetainedLaneDescriptor(identity: plan.primary.newDay))
        else {
          throw RotatingRoomControlJournalError.retainedDescriptorMismatch
        }
      }
      try adoptPublishedControl(controlEntry, expectedIdentity: plan.newControl)
      let newDay = try plan.newControl.istDay
      if currentDay.description < newDay.description { currentDay = newDay }
    }
  }

  func resumeRollover(
    _ plan: ArchiveRolloverPlan,
    effects: ArchiveRolloverEffects
  ) throws -> ArchiveControlState {
    try lock.withLock {
      let recovered = try recoverLocked()
      guard let owner = recovered.owners[plan.commandID] else {
        throw RotatingRoomControlJournalError.retainedDescriptorMismatch
      }
      guard owner.identity == plan.oldControl else {
        throw RotatingRoomControlJournalError.retainedDescriptorMismatch
      }
      return try owner.journal.resumeRollover(plan, effects: effects)
    }
  }

  private func recoverLocked() throws -> (
    commands: [String: RoomRecoveredControlCommand],
    owners: [String: DailyJournal]
  ) {
    var commands: [String: RoomRecoveredControlCommand] = [:]
    var owners: [String: DailyJournal] = [:]
    for daily in journals {
      for (commandID, command) in try daily.journal.recover() {
        guard commands[commandID] == nil else {
          throw RotatingRoomControlJournalError.duplicateCommand(commandID)
        }
        commands[commandID] = command
        owners[commandID] = daily
      }
    }
    var captureBindings: [String: ArchiveCaptureSessionBinding] = [:]
    for command in commands.values where command.commandKind == .captureSessionBinding {
      guard let binding = command.captureSessionBinding else {
        throw RotatingRoomControlJournalError.retainedDescriptorMismatch
      }
      let key = "\(binding.sessionID)\u{0}\(binding.primaryIdentity.context.istDate)"
      if let existing = captureBindings[key], existing != binding {
        throw RotatingRoomControlJournalError.retainedDescriptorMismatch
      }
      captureBindings[key] = binding
    }
    return (commands, owners)
  }

  private func makeJournal(day: ArchiveISTDay) throws -> DailyJournal {
    let existing = try catalog.scanIncludingControls().controls.first {
      $0.descriptor.context.roomID == roomID
        && $0.descriptor.context.istDate == day.description
    }
    let entry: ArchiveRetainedControlCatalogEntry
    if let existing {
      entry = existing
    } else {
      let context = ArchiveContext(
        streamUUID: try keyLifecycle.makeDailyStreamUUID(),
        roomID: roomID,
        istDate: day.description,
        laneID: "_control",
        stableDeviceUID: "")
      entry = try builder.prepareControl(context: context).catalogEntry
    }
    return try Self.open(entry: entry, keyLifecycle: keyLifecycle)
  }

  private func stagedRolloverControl(
    preparationID: String,
    day: ArchiveISTDay
  ) throws -> ArchiveStagedRetainedControl {
    if let existing = try builder.reopenStagedControl(
      stageID: preparationID,
      roomID: roomID,
      istDate: day.description)
    {
      return existing
    }
    return try builder.stageControl(
      stageID: preparationID,
      context: ArchiveContext(
        streamUUID: try ArchiveRetainedLaneBuilder.deterministicRolloverStreamUUID(
          stageID: preparationID, kind: .control),
        roomID: roomID,
        istDate: day.description,
        laneID: "_control",
        stableDeviceUID: ""))
  }

  private func adoptPublishedControl(
    _ entry: ArchiveRetainedControlCatalogEntry,
    expectedIdentity: ArchiveDailyControlIdentity
  ) throws {
    if let existing = journals.first(where: {
      $0.day.description == expectedIdentity.context.istDate
    }) {
      guard existing.identity == expectedIdentity else {
        throw RotatingRoomControlJournalError.retainedDescriptorMismatch
      }
      return
    }
    let opened = try Self.open(entry: entry, keyLifecycle: keyLifecycle)
    guard opened.identity == expectedIdentity else {
      throw RotatingRoomControlJournalError.retainedDescriptorMismatch
    }
    journals.append(opened)
    journals.sort { $0.day.description < $1.day.description }
  }

  private func exactLaneEntry(
    _ identity: ArchiveDailyLaneIdentity
  ) throws -> ArchiveRetainedLaneCatalogEntry {
    let matches = try catalog.scan().filter {
      $0.descriptor.context == identity.context
        && $0.descriptor.initialSamplePosition == identity.expectedInitialSessionSample
        && $0.descriptor.keywrapDigestHex == identity.keywrapDigestHex
    }
    guard matches.count == 1, let entry = matches.first else {
      throw RotatingRoomControlJournalError.retainedDescriptorMismatch
    }
    return entry
  }

  private static func open(
    entry: ArchiveRetainedControlCatalogEntry,
    keyLifecycle: ArchiveKeyLifecycle
  ) throws -> DailyJournal {
    let opened = try keyLifecycle.openControlStoreWithInspection(
      keywrapURL: entry.layout.keywrapURL,
      journalURL: entry.layout.journalURL,
      context: entry.descriptor.context)
    guard opened.keywrap.authenticated,
      opened.keywrap.keywrapDigestHex == entry.descriptor.keywrapDigestHex
    else {
      opened.store.close()
      throw RotatingRoomControlJournalError.retainedDescriptorMismatch
    }
    return DailyJournal(
      day: try ArchiveISTDay(entry.descriptor.context.istDate),
      identity: try ArchiveDailyControlIdentity(
        context: entry.descriptor.context,
        keywrap: opened.keywrap),
      journal: ArchiveRoomControlJournal(store: opened.store))
  }
}
