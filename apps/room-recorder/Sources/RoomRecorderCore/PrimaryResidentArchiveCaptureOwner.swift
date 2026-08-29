import CryptoKit
import Foundation
import TapeCapture
import TapeCore

enum PrimaryResidentArchiveCaptureOwnerError: Error, Equatable, Sendable {
  case roomIdentityMismatch
  case backupNotSupported
  case captureAlreadyActive
  case noRetainedLane
  case retainedDescriptorMismatch
  case finalBoundaryMissing
  case rolloverJournalUnavailable
  case retainedSessionIdentityUnavailable
}

protocol PrimaryResidentAudioCapturing: AnyObject, Sendable {
  var isActive: Bool { get }
  var requiresFinalization: Bool { get }
  var durableSampleEnd: UInt64 { get }
  var currentLevels: ResidentAudioCaptureLevels? { get }
  func startAndWaitUntilDurable() throws
  func service() throws
  func stopAndDrain() throws
  func authenticatedSnapshot() throws -> ArchiveLaneStore.AuthenticatedSnapshot
}

extension ResidentAudioCaptureLane: PrimaryResidentAudioCapturing {}

public final class PrimaryResidentArchiveCaptureOwner: RoomResidentCaptureOwning,
  @unchecked Sendable
{
  typealias CaptureFactory =
    @Sendable (String, ArchiveLaneStore, ResidentAudioCaptureLane.RolloverStoreFactory?) throws ->
    any PrimaryResidentAudioCapturing

  private struct LaneBinding {
    let identity: ArchiveDailyLaneIdentity
    let layout: ArchiveRetainedLaneLayout
    let sessionID: String
    let sessionSampleStart: UInt64
  }

  private struct CompletedLaneBinding {
    let binding: LaneBinding
    let sampleEnd: UInt64
    var finalReserved: Bool
  }

  private let operationLock = NSLock()
  private let bindingLock = NSLock()
  private let indexLock = NSLock()
  private let processingLock = NSLock()
  private let rootURL: URL
  private let roomID: String
  private let stableDeviceUID: String
  private let keyLifecycle: ArchiveKeyLifecycle
  private let builder: ArchiveRetainedLaneBuilder
  private let catalog: ArchiveRetainedLaneCatalog
  private let pipeline: ArchiveLocalDeliveryPipeline
  private let captureFactory: CaptureFactory
  private let now: @Sendable () -> Date
  private var capture: (any PrimaryResidentAudioCapturing)?
  private var binding: LaneBinding?
  private var completedBindings: [CompletedLaneBinding] = []
  private var snapshotProvider: (@Sendable () throws -> ArchiveLaneStore.AuthenticatedSnapshot)?
  private var pendingRolloverPlans: [ArchiveRolloverPlan] = []
  private var persistRolloverPreparation: (@Sendable (ArchiveRolloverPreparation) throws -> Void)?
  private var persistRolloverIntent:
    (
      @Sendable (
        ArchiveRolloverPreparation, ArchiveRolloverAudioLane, ArchiveStagedRetainedLane
      ) throws -> ArchiveRolloverPlan
    )?
  private var resumeRollover:
    (@Sendable (ArchiveRolloverPlan, ArchiveRolloverEffects) throws -> ArchiveControlState)?
  private var rotateControl: (@Sendable (ArchiveISTDay) throws -> Void)?
  private var activeSessionID: String?
  private var activeSessionSampleStart: UInt64?
  private var primaryIndex = 0
  private var knownPrimaryReservations: [String: ArchiveJournalPayload] = [:]
  private var finalSampleEnd: UInt64?
  private var processingTask: Task<Void, Never>?
  private var lastProcessingError: Error?
  private var serverEndedSignal: String?
  private var retainedUnfinalizedSignal: String?
  private var hydratedRolloverPlanIDs: Set<String> = []
  private var terminalRolloverError: Error?
  private var recoveredCaptureBindings: [ArchiveCaptureSessionBinding] = []
  private var persistCaptureBinding: (@Sendable (ArchiveCaptureSessionBinding) throws -> Void)?

  public convenience init(
    rootURL: URL,
    roomID: String,
    stableDeviceUID: String,
    ffmpegURL: URL,
    encoderProvenanceID: String,
    wire: any ArchiveDeliveryWire,
    keyLifecycle: ArchiveKeyLifecycle = ArchiveKeyLifecycle()
  ) throws {
    try self.init(
      rootURL: rootURL,
      roomID: roomID,
      stableDeviceUID: stableDeviceUID,
      wire: wire,
      spoolCoordinator: ArchiveSpoolCoordinator(
        encoder: ArchiveFFmpegStreamingEncoder(
          command: ArchiveFFmpegCommand(executableURL: ffmpegURL)),
        encoderProvenanceID: encoderProvenanceID),
      keyLifecycle: keyLifecycle,
      captureFactory: { deviceUID, store, rolloverStoreFactory in
        ResidentAudioCaptureLane(
          stableDeviceUID: deviceUID,
          store: store,
          rolloverStoreFactory: rolloverStoreFactory)
      },
      now: { Date() })
  }

  init(
    rootURL: URL,
    roomID: String,
    stableDeviceUID: String,
    wire: any ArchiveDeliveryWire,
    spoolCoordinator: ArchiveSpoolCoordinator,
    keyLifecycle: ArchiveKeyLifecycle,
    captureFactory: @escaping CaptureFactory,
    now: @escaping @Sendable () -> Date
  ) throws {
    self.rootURL = rootURL
    self.roomID = roomID
    self.stableDeviceUID = stableDeviceUID
    self.keyLifecycle = keyLifecycle
    builder = try ArchiveRetainedLaneBuilder(rootURL: rootURL, keyLifecycle: keyLifecycle)
    catalog = try ArchiveRetainedLaneCatalog(rootURL: rootURL)
    pipeline = ArchiveLocalDeliveryPipeline(spoolCoordinator: spoolCoordinator, wire: wire)
    self.captureFactory = captureFactory
    self.now = now
  }

  public var isActive: Bool { operationLock.withLock { capture?.isActive == true } }

  public var requiresFinalization: Bool {
    operationLock.withLock { capture?.requiresFinalization == true }
  }

  public var nextPrimaryIndex: Int { indexLock.withLock { primaryIndex } }
  public var nextBackupIndex: Int? { nil }
  public var terminalFailure: String? {
    bindingLock.withLock { terminalRolloverError.map(String.init(describing:)) }
  }
  public var serverEndedSessionID: String? { processingLock.withLock { serverEndedSignal } }
  public var retainedUnfinalizedSessionID: String? {
    processingLock.withLock { retainedUnfinalizedSignal }
  }

  public func clearServerEndedSessionID(_ sessionID: String) {
    processingLock.withLock {
      if serverEndedSignal == sessionID { serverEndedSignal = nil }
      if retainedUnfinalizedSignal == sessionID { retainedUnfinalizedSignal = nil }
    }
  }

  public func markRetainedUnfinalizedSessionAsServerEnded(_ sessionID: String) throws {
    try processingLock.withLock {
      guard retainedUnfinalizedSignal == sessionID else {
        throw PrimaryResidentArchiveCaptureOwnerError.retainedSessionIdentityUnavailable
      }
      guard serverEndedSignal == nil || serverEndedSignal == sessionID else {
        throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
      }
      serverEndedSignal = sessionID
    }
  }

  func installRolloverHandlers(
    pendingPlans: [ArchiveRolloverPlan],
    captureBindings: [ArchiveCaptureSessionBinding],
    serverEndedSessionID: String? = nil,
    retainedUnfinalizedSessionID: String? = nil,
    persistCaptureBinding:
      @escaping @Sendable (ArchiveCaptureSessionBinding) throws -> Void,
    persistPreparation:
      @escaping @Sendable (ArchiveRolloverPreparation) throws -> Void,
    persistIntent:
      @escaping @Sendable (
        ArchiveRolloverPreparation, ArchiveRolloverAudioLane, ArchiveStagedRetainedLane
      ) throws
      -> ArchiveRolloverPlan,
    resume:
      @escaping @Sendable (ArchiveRolloverPlan, ArchiveRolloverEffects) throws
      -> ArchiveControlState,
    rotateControl: @escaping @Sendable (ArchiveISTDay) throws -> Void
  ) {
    bindingLock.withLock {
      pendingRolloverPlans = pendingPlans.sorted {
        $0.primary.oldDay.context.istDate < $1.primary.oldDay.context.istDate
      }
      recoveredCaptureBindings = captureBindings
      processingLock.withLock {
        serverEndedSignal = serverEndedSessionID
        retainedUnfinalizedSignal = retainedUnfinalizedSessionID
      }
      self.persistCaptureBinding = persistCaptureBinding
      persistRolloverPreparation = persistPreparation
      persistRolloverIntent = persistIntent
      resumeRollover = resume
      self.rotateControl = rotateControl
    }
  }

  public func start(context: RoomResidentCaptureStartContext) throws {
    try operationLock.withLock {
      guard context.roomID == roomID else {
        throw PrimaryResidentArchiveCaptureOwnerError.roomIdentityMismatch
      }
      guard context.nextBackupIndex == nil else {
        throw PrimaryResidentArchiveCaptureOwnerError.backupNotSupported
      }
      guard capture == nil else {
        throw PrimaryResidentArchiveCaptureOwnerError.captureAlreadyActive
      }
      if let terminal = bindingLock.withLock({ terminalRolloverError }) { throw terminal }
      try processingLock.withLock {
        if serverEndedSignal == context.sessionID {
          throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
        }
        serverEndedSignal = nil
      }
      bindingLock.withLock {
        completedBindings.removeAll { $0.binding.sessionID != context.sessionID }
      }
      let day = try ArchiveISTDay(containing: now()).description
      try hydrateRolloverPlans(sessionID: context.sessionID)
      let authority = try retainedAuthority(
        sessionID: context.sessionID,
        serverNextIndex: context.nextPrimaryIndex)
      let entries = try matchingEntries()
      let latest = entries.last
      let opened: ArchiveOpenedRetainedLane
      if let boundIdentity = authority.latestIdentity {
        guard
          let boundEntry = entries.first(where: {
            $0.descriptor.context == boundIdentity.context
              && $0.descriptor.initialSamplePosition == boundIdentity.expectedInitialSessionSample
              && $0.descriptor.keywrapDigestHex == boundIdentity.keywrapDigestHex
          }), latest?.descriptor.context.istDate == boundIdentity.context.istDate
        else { throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch }
        if boundIdentity.context.istDate < day {
          opened = try recoverMissingMidnightRollover(
            from: boundEntry,
            targetDay: try ArchiveISTDay(day),
            sessionID: context.sessionID,
            authority: authority)
        } else {
          guard boundIdentity.context.istDate == day else {
            throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
          }
          opened = try builder.openLane(
            context: boundIdentity.context,
            initialSamplePosition: boundIdentity.expectedInitialSessionSample)
        }
      } else if let latest, latest.descriptor.context.istDate < day, authority.hasSessionEvidence {
        opened = try recoverMissingMidnightRollover(
          from: latest,
          targetDay: try ArchiveISTDay(day),
          sessionID: context.sessionID,
          authority: authority)
      } else {
        if (latest?.descriptor.context.istDate ?? day) < day {
          guard let rotateControl = bindingLock.withLock({ rotateControl }) else {
            throw PrimaryResidentArchiveCaptureOwnerError.rolloverJournalUnavailable
          }
          try rotateControl(ArchiveISTDay(day))
        }
        opened = try openLane(istDate: day)
      }
      let snapshot = try opened.store.authenticatedSnapshot()
      let authenticatedEndBeforeStart = snapshot.authenticatedFacts.authenticatedSampleEnd
      let sessionStart: UInt64
      let segmentStart: UInt64
      let nextIndex: UInt32
      do {
        let reservations = try reservations(snapshot: snapshot, layout: opened.catalogEntry.layout)
        let currentSession = reservations.filter {
          $0.initialReservation.sessionID == context.sessionID
        }
        sessionStart =
          authority.sessionSampleStart
          ?? currentSession.map(\.initialReservation.sampleStart).min()
          ?? reservations.map(\.initialReservation.sampleEnd).max()
          ?? opened.catalogEntry.descriptor.initialSamplePosition
        segmentStart = try segmentSampleStart(
          identityContext: opened.catalogEntry.descriptor.context,
          sessionID: context.sessionID,
          fallback: sessionStart,
          reservations: currentSession.map(\.initialReservation))
        nextIndex = authority.nextChunkIndex
        try mergeKnownReservations(reservations.map(\.initialReservation))
      }
      snapshot.close()
      let residentCapture: any PrimaryResidentAudioCapturing
      do {
        residentCapture = try captureFactory(
          stableDeviceUID,
          opened.store,
          { [weak self] fence in
            guard let self else {
              throw PrimaryResidentArchiveCaptureOwnerError.noRetainedLane
            }
            return try self.openRolloverLane(fence: fence)
          })
      } catch {
        opened.store.close()
        throw error
      }
      let laneIdentity = try ArchiveDailyLaneIdentity(
        context: opened.catalogEntry.descriptor.context,
        expectedInitialSessionSample: opened.catalogEntry.descriptor.initialSamplePosition,
        keywrap: opened.keywrap)
      let captureBinding = try ArchiveCaptureSessionBinding(
        sessionID: context.sessionID,
        primaryIdentity: laneIdentity,
        sessionSampleStart: sessionStart,
        segmentSampleStart: segmentStart)
      do {
        try persistCaptureBindingIfNeeded(captureBinding)
      } catch {
        try? residentCapture.stopAndDrain()
        opened.store.close()
        throw error
      }
      bindingLock.withLock {
        binding = LaneBinding(
          identity: laneIdentity,
          layout: opened.catalogEntry.layout,
          sessionID: context.sessionID,
          sessionSampleStart: segmentStart)
        snapshotProvider = { try residentCapture.authenticatedSnapshot() }
      }
      activeSessionID = context.sessionID
      bindingLock.withLock { activeSessionSampleStart = sessionStart }
      indexLock.withLock { primaryIndex = Int(nextIndex) }
      finalSampleEnd = nil
      do {
        try residentCapture.startAndWaitUntilDurable()
        let durable = try residentCapture.authenticatedSnapshot()
        defer { durable.close() }
        guard let durableBinding = bindingLock.withLock({ binding }),
          durable.authenticatedFacts.context == durableBinding.identity.context,
          durable.authenticatedFacts.initialSamplePosition
            == durableBinding.identity.expectedInitialSessionSample,
          durable.authenticatedFacts.authenticatedSampleEnd
            > max(authenticatedEndBeforeStart, durableBinding.sessionSampleStart)
        else {
          throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
        }
      } catch {
        try? residentCapture.stopAndDrain()
        bindingLock.withLock {
          snapshotProvider = nil
          binding = nil
        }
        activeSessionID = nil
        bindingLock.withLock { activeSessionSampleStart = nil }
        throw error
      }
      capture = residentCapture
    }
  }

  public func service() async throws {
    let hasCapture = try operationLock.withLock { () throws -> Bool in
      guard let capture, activeSessionID != nil else { return false }
      guard bindingLock.withLock({ binding }) != nil else { return false }
      try capture.service()
      return true
    }
    guard hasCapture else { return }
    try await waitForProcessingAndThrow()
    try hydrateRolloverPlans(sessionID: operationLock.withLock { activeSessionID })
    if let sessionID = operationLock.withLock({ activeSessionID }) {
      try ensureAuthenticatedRolloverBindings(sessionID: sessionID)
      try await reserveCompletedRolloverRanges(sessionID: sessionID)
    }
    let work = try operationLock.withLock { () throws -> ProcessingWork? in
      guard let capture, let sessionID = activeSessionID else { return nil }
      guard let binding = bindingLock.withLock({ binding }) else { return nil }
      let snapshot = try capture.authenticatedSnapshot()
      return ProcessingWork(
        snapshot: snapshot,
        binding: binding,
        sessionID: sessionID,
        startingChunkIndex: UInt64(indexLock.withLock { primaryIndex }),
        finalFlush: false)
    }
    if let work { schedule(work) }
  }

  public func stopAndFinalize(reason _: RoomResidentCaptureStopReason) throws {
    try operationLock.withLock {
      guard let capture else { return }
      do {
        try capture.stopAndDrain()
      } catch {
        throw error
      }
      finalSampleEnd = capture.durableSampleEnd
      self.capture = nil
      bindingLock.withLock {
        snapshotProvider = nil
      }
    }
  }

  public func reserveFinalRanges(context: RoomResidentFinalizationContext) async throws {
    try requireFinalizationContext(context)
    try hydrateRolloverPlans(sessionID: context.sessionID)
    try ensureAuthenticatedRolloverBindings(sessionID: context.sessionID)
    try await reserveCompletedRolloverRanges(sessionID: context.sessionID)
    try await waitForProcessingAndThrow()
    let work = try finalWork(context: context)
    defer { work.snapshot.close() }
    let result = try ArchiveLocalDeriver.derive(
      snapshot: work.snapshot,
      journalURL: work.binding.layout.journalURL,
      levelURL: work.binding.layout.levelURL,
      sessionID: work.sessionID,
      finalFlush: true,
      startingChunkIndex: work.startingChunkIndex)
    try reconcilePrimaryIndex(reservations: result.reservations, sessionID: context.sessionID)
  }

  public func verifyFinalRanges(context: RoomResidentFinalizationContext) async throws {
    try requireFinalizationContext(context)
    try hydrateRolloverPlans(sessionID: context.sessionID)
    try ensureAuthenticatedRolloverBindings(sessionID: context.sessionID)
    try await reserveCompletedRolloverRanges(sessionID: context.sessionID)
    try await waitForProcessingAndThrow()
    let completed = bindingLock.withLock {
      completedBindings.filter { $0.binding.sessionID == context.sessionID }
    }
    var expectedStart = completed.first?.binding.sessionSampleStart
    for segment in completed {
      guard expectedStart == nil || segment.binding.sessionSampleStart == expectedStart else {
        throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
      }
      let snapshot = try openSnapshot(binding: segment.binding)
      defer { snapshot.close() }
      let result = try await pipeline.advance(
        snapshot: snapshot,
        layout: segment.binding.layout,
        sessionID: context.sessionID,
        finalFlush: true,
        startingChunkIndex: UInt64(indexLock.withLock { primaryIndex }),
        reservationsDidBecomeDurable: { reservations in
          try self.reconcilePrimaryIndex(
            reservations: reservations,
            sessionID: context.sessionID)
        })
      _ = try ArchiveFinalRangeCoverage.verify(
        reservations: result.reservations,
        sessionID: context.sessionID,
        laneID: "primary",
        sampleStart: segment.binding.sessionSampleStart,
        sampleEnd: segment.sampleEnd)
      updatePrimaryIndex(result, sessionID: context.sessionID)
      expectedStart = segment.sampleEnd
    }
    let work = try finalWork(context: context)
    defer { work.snapshot.close() }
    let result = try await pipeline.advance(
      snapshot: work.snapshot,
      layout: work.binding.layout,
      sessionID: work.sessionID,
      finalFlush: true,
      startingChunkIndex: work.startingChunkIndex,
      reservationsDidBecomeDurable: { reservations in
        try self.reconcilePrimaryIndex(
          reservations: reservations,
          sessionID: work.sessionID)
      })
    let expectedEnd =
      operationLock.withLock { finalSampleEnd }
      ?? work.snapshot.authenticatedFacts.authenticatedSampleEnd
    if let expectedStart, work.binding.sessionSampleStart != expectedStart {
      throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
    }
    _ = try ArchiveFinalRangeCoverage.verify(
      reservations: result.reservations,
      sessionID: context.sessionID,
      laneID: "primary",
      sampleStart: work.binding.sessionSampleStart,
      sampleEnd: expectedEnd)
    updatePrimaryIndex(result, sessionID: context.sessionID)
  }

  public func currentLevels() -> BenchLevelPair? {
    operationLock.withLock {
      guard let levels = capture?.currentLevels else { return nil }
      return BenchLevelPair(
        peak: Double(levels.peakQ15) / 32_767,
        average: Double(levels.averageQ15) / 32_767)
    }
  }

  private struct ProcessingWork: @unchecked Sendable {
    let snapshot: ArchiveLaneStore.AuthenticatedSnapshot
    let binding: LaneBinding
    let sessionID: String
    let startingChunkIndex: UInt64
    let finalFlush: Bool
  }

  private func schedule(_ work: ProcessingWork) {
    processingLock.lock()
    guard processingTask == nil else {
      processingLock.unlock()
      work.snapshot.close()
      return
    }
    lastProcessingError = nil
    processingTask = Task.detached { [weak self] in
      guard let self else {
        work.snapshot.close()
        return
      }
      defer { work.snapshot.close() }
      do {
        let result = try await self.pipeline.advance(
          snapshot: work.snapshot,
          layout: work.binding.layout,
          sessionID: work.sessionID,
          finalFlush: work.finalFlush,
          startingChunkIndex: work.startingChunkIndex,
          reservationsDidBecomeDurable: { reservations in
            try self.reconcilePrimaryIndex(
              reservations: reservations,
              sessionID: work.sessionID)
          })
        self.updatePrimaryIndex(result, sessionID: work.sessionID)
        self.finishProcessing(error: nil)
      } catch {
        self.finishProcessing(error: error)
      }
    }
    processingLock.unlock()
  }

  private func finishProcessing(error: Error?) {
    processingLock.withLock {
      lastProcessingError = error
      processingTask = nil
    }
  }

  private func waitForProcessing() async {
    let task = processingLock.withLock { processingTask }
    await task?.value
  }

  private func waitForProcessingAndThrow() async throws {
    await waitForProcessing()
    if let error = processingLock.withLock({ lastProcessingError }) { throw error }
  }

  private func reserveCompletedRolloverRanges(sessionID: String) async throws {
    try await waitForProcessingAndThrow()
    while let completed = bindingLock.withLock({
      completedBindings.first(where: {
        $0.binding.sessionID == sessionID && !$0.finalReserved
      })
    }) {
      let snapshot = try openSnapshot(binding: completed.binding)
      defer { snapshot.close() }
      let startingIndex = UInt64(indexLock.withLock { primaryIndex })
      let result = try ArchiveLocalDeriver.derive(
        snapshot: snapshot,
        journalURL: completed.binding.layout.journalURL,
        levelURL: completed.binding.layout.levelURL,
        sessionID: completed.binding.sessionID,
        finalFlush: true,
        startingChunkIndex: startingIndex)
      try reconcilePrimaryIndex(
        reservations: result.reservations,
        sessionID: completed.binding.sessionID)
      bindingLock.withLock {
        guard
          let index = completedBindings.firstIndex(where: {
            $0.binding.sessionID == sessionID
              && $0.binding.identity.context == completed.binding.identity.context
          })
        else { return }
        completedBindings[index].finalReserved = true
      }
    }
  }

  private func updatePrimaryIndex(
    _ result: ArchiveLocalDeliveryPipelineResult,
    sessionID: String
  ) {
    if result.endedDisagrees != nil {
      processingLock.withLock { serverEndedSignal = sessionID }
    }
    guard
      let maximum = result.reservations.filter({
        $0.initialReservation.sessionID == sessionID
      }).map(\.initialReservation.chunkIndex).max()
    else { return }
    indexLock.withLock { primaryIndex = max(primaryIndex, Int(maximum) + 1) }
  }

  @discardableResult
  private func reconcilePrimaryIndex(
    reservations: [ArchiveJournalPayload],
    sessionID: String
  ) throws -> UInt32 {
    try indexLock.withLock {
      var reconciled = knownPrimaryReservations
      for reservation in reservations {
        if let existing = reconciled[reservation.reservationID],
          existing != reservation
        {
          throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
        }
        reconciled[reservation.reservationID] = reservation
      }
      let next = try ArchiveReservationIndexReconciler.nextIndex(
        localReservations: Array(reconciled.values),
        sessionID: sessionID,
        laneID: "primary",
        serverNextIndex: UInt64(primaryIndex))
      knownPrimaryReservations = reconciled
      primaryIndex = Int(next)
      return next
    }
  }

  private func hydrateRolloverPlans(sessionID: String?) throws {
    guard let sessionID else { return }
    let plans = bindingLock.withLock {
      pendingRolloverPlans.filter { $0.sessionID == sessionID }.sorted {
        $0.primary.oldDay.context.istDate < $1.primary.oldDay.context.istDate
      }
    }
    var previous: ArchiveRolloverPlan?
    for pending in plans {
      if let previous {
        guard previous.primary.newDay == pending.primary.oldDay,
          previous.primary.boundarySample == pending.primary.oldDay.expectedInitialSessionSample,
          previous.sessionSampleStart == pending.sessionSampleStart
        else {
          throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
        }
      }
      previous = pending
      if bindingLock.withLock({ hydratedRolloverPlanIDs.contains(pending.commandID) }) {
        continue
      }
      do {
        try hydrateRolloverPlan(pending)
      } catch {
        if isTerminalRolloverError(error) {
          bindingLock.withLock { terminalRolloverError = error }
        }
        throw error
      }
    }
  }

  private func hydrateRolloverPlan(_ pending: ArchiveRolloverPlan) throws {
    let oldBinding = try binding(for: pending.primary.oldDay, sessionID: pending.sessionID)
    let oldSnapshot = try openSnapshot(binding: oldBinding)
    let oldReservations: [ArchiveJournalPayload]
    do {
      defer { oldSnapshot.close() }
      guard oldSnapshot.authenticatedFacts == pending.primary.oldAuthenticatedFacts else {
        throw ArchiveRolloverEffectFailure.authenticationFailed
      }
      oldReservations = try reservations(
        snapshot: oldSnapshot,
        layout: oldBinding.layout
      ).map(\.initialReservation)
    }
    try reconcilePrimaryIndex(reservations: oldReservations, sessionID: pending.sessionID)

    let newSnapshot = try rolloverNewDaySnapshot(for: pending)
    let newFacts = newSnapshot.authenticatedFacts
    newSnapshot.close()
    guard newFacts.context == pending.primary.newDay.context,
      newFacts.initialSamplePosition == pending.primary.boundarySample,
      newFacts.authenticatedSampleEnd
        >= pending.primary.newAuthenticatedFacts.authenticatedSampleEnd,
      newFacts.recordCount >= pending.primary.newAuthenticatedFacts.recordCount
    else {
      throw ArchiveRolloverEffectFailure.authenticationFailed
    }
    guard let resume = bindingLock.withLock({ resumeRollover }) else {
      throw PrimaryResidentArchiveCaptureOwnerError.rolloverJournalUnavailable
    }
    let effects = ArchiveRolloverEffects(
      reserveOldDayFinal: { [weak self] plan in
        guard let self else { throw ArchiveRolloverEffectFailure.internalIOFailed }
        return try self.reserveOldDayFinal(plan)
      },
      closeOldDayFiles: { [weak self] plan in
        guard let self else { throw ArchiveRolloverEffectFailure.internalIOFailed }
        return try self.authenticateClosedOldDay(plan)
      },
      makeNewDayFilesDurable: { [weak self] plan in
        guard let self else { throw ArchiveRolloverEffectFailure.internalIOFailed }
        return try self.authenticateDurableNewDay(plan, actualFacts: newFacts)
      })
    guard try resume(pending, effects) == .rolloverComplete else {
      throw ArchiveRolloverEffectFailure.internalIOFailed
    }
    let newBinding = try binding(for: pending.primary.newDay, sessionID: pending.sessionID)
    let segmentStart = max(
      pending.sessionSampleStart,
      pending.primary.oldDay.expectedInitialSessionSample)
    if let completed = bindingLock.withLock({
      completedBindings.first {
        $0.binding.sessionID == pending.sessionID
          && $0.binding.identity.context == pending.primary.oldDay.context
      }
    }) {
      guard completed.binding.sessionSampleStart == segmentStart,
        completed.sampleEnd == pending.primary.boundarySample
      else {
        throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
      }
    }
    bindingLock.withLock {
      if let index = completedBindings.firstIndex(where: {
        $0.binding.sessionID == pending.sessionID
          && $0.binding.identity.context == pending.primary.oldDay.context
      }) {
        completedBindings[index].finalReserved = true
      } else {
        completedBindings.append(
          CompletedLaneBinding(
            binding: LaneBinding(
              identity: oldBinding.identity,
              layout: oldBinding.layout,
              sessionID: pending.sessionID,
              sessionSampleStart: segmentStart),
            sampleEnd: pending.primary.boundarySample,
            finalReserved: true))
      }
      completedBindings.sort {
        $0.binding.identity.context.istDate < $1.binding.identity.context.istDate
      }
      binding = LaneBinding(
        identity: pending.primary.newDay,
        layout: newBinding.layout,
        sessionID: pending.sessionID,
        sessionSampleStart: pending.primary.boundarySample)
      activeSessionSampleStart = pending.sessionSampleStart
      hydratedRolloverPlanIDs.insert(pending.commandID)
    }
  }

  private func reserveOldDayFinal(
    _ plan: ArchiveRolloverPlan
  ) throws -> ArchiveRolloverEffectReceipt {
    let oldBinding = try binding(for: plan.primary.oldDay, sessionID: plan.sessionID)
    let snapshot = try openSnapshot(binding: oldBinding)
    defer { snapshot.close() }
    guard snapshot.authenticatedFacts == plan.primary.oldAuthenticatedFacts else {
      throw ArchiveRolloverEffectFailure.authenticationFailed
    }
    let result = try ArchiveLocalDeriver.derive(
      snapshot: snapshot,
      journalURL: oldBinding.layout.journalURL,
      levelURL: oldBinding.layout.levelURL,
      sessionID: plan.sessionID,
      finalFlush: true,
      startingChunkIndex: UInt64(plan.primary.nextChunkIndex))
    let relevant = result.reservations.filter {
      $0.sessionID == plan.sessionID && $0.laneID == "primary"
    }.sorted {
      if $0.sampleStart != $1.sampleStart { return $0.sampleStart < $1.sampleStart }
      return $0.chunkIndex < $1.chunkIndex
    }
    let expectedStart = max(
      plan.sessionSampleStart,
      plan.primary.oldDay.expectedInitialSessionSample)
    if expectedStart == plan.primary.boundarySample {
      guard relevant.isEmpty else { throw ArchiveRolloverEffectFailure.authenticationFailed }
    } else {
      guard relevant.first?.sampleStart == expectedStart,
        relevant.last?.sampleEnd == plan.primary.boundarySample
      else {
        throw ArchiveRolloverEffectFailure.authenticationFailed
      }
      try ArchiveReservationIndexReconciler.validate(relevant)
    }
    try reconcilePrimaryIndex(reservations: result.reservations, sessionID: plan.sessionID)
    var witness = try rolloverFactsWitness(snapshot.authenticatedFacts)
    for reservation in relevant {
      appendLengthPrefixed(try ArchiveJournalPayloadCodec.encode(reservation), to: &witness)
    }
    return try rolloverReceipt(
      kind: .reserveOldDayFinal,
      plan: plan,
      actualWitness: witness,
      performedDurableMutation: result.journalRecordsWritten > 0 || result.levelRecordsWritten > 0)
  }

  private func authenticateClosedOldDay(
    _ plan: ArchiveRolloverPlan
  ) throws -> ArchiveRolloverEffectReceipt {
    let oldBinding = try binding(for: plan.primary.oldDay, sessionID: plan.sessionID)
    let snapshot = try openSnapshot(binding: oldBinding)
    let facts = snapshot.authenticatedFacts
    snapshot.close()
    guard facts == plan.primary.oldAuthenticatedFacts else {
      throw ArchiveRolloverEffectFailure.authenticationFailed
    }
    return try rolloverReceipt(
      kind: .closeOldDayFiles,
      plan: plan,
      actualWitness: rolloverFactsWitness(facts),
      performedDurableMutation: false)
  }

  private func authenticateDurableNewDay(
    _ plan: ArchiveRolloverPlan,
    actualFacts: ArchiveAuthenticatedLaneFacts
  ) throws -> ArchiveRolloverEffectReceipt {
    guard actualFacts.context == plan.primary.newDay.context,
      actualFacts.initialSamplePosition == plan.primary.boundarySample,
      actualFacts.authenticatedSampleEnd
        >= plan.primary.newAuthenticatedFacts.authenticatedSampleEnd,
      actualFacts.recordCount >= plan.primary.newAuthenticatedFacts.recordCount
    else {
      throw ArchiveRolloverEffectFailure.authenticationFailed
    }
    return try rolloverReceipt(
      kind: .makeNewDayFilesDurable,
      plan: plan,
      actualWitness: rolloverFactsWitness(actualFacts),
      performedDurableMutation: false)
  }

  private func rolloverNewDaySnapshot(
    for plan: ArchiveRolloverPlan
  ) throws -> ArchiveLaneStore.AuthenticatedSnapshot {
    let provider = bindingLock.withLock {
      () -> (
        @Sendable () throws -> ArchiveLaneStore.AuthenticatedSnapshot
      )? in
      guard binding?.identity == plan.primary.newDay else { return nil }
      return snapshotProvider
    }
    if let provider { return try provider() }
    return try openSnapshot(binding: binding(for: plan.primary.newDay, sessionID: plan.sessionID))
  }

  private func binding(
    for identity: ArchiveDailyLaneIdentity,
    sessionID: String
  ) throws -> LaneBinding {
    guard
      let entry = try matchingEntries().first(where: {
        $0.descriptor.context == identity.context
          && $0.descriptor.initialSamplePosition == identity.expectedInitialSessionSample
          && $0.descriptor.keywrapDigestHex == identity.keywrapDigestHex
      })
    else {
      throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
    }
    return LaneBinding(
      identity: identity,
      layout: entry.layout,
      sessionID: sessionID,
      sessionSampleStart: identity.expectedInitialSessionSample)
  }

  private func rolloverReceipt(
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

  private func rolloverFactsWitness(_ facts: ArchiveAuthenticatedLaneFacts) throws -> Data {
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

  private func requireFinalizationContext(_ context: RoomResidentFinalizationContext) throws {
    guard context.roomID == roomID else {
      throw PrimaryResidentArchiveCaptureOwnerError.roomIdentityMismatch
    }
    guard context.nextBackupIndex == nil else {
      throw PrimaryResidentArchiveCaptureOwnerError.backupNotSupported
    }
  }

  private func finalWork(context: RoomResidentFinalizationContext) throws -> ProcessingWork {
    try operationLock.withLock {
      let binding: LaneBinding
      if let current = bindingLock.withLock({ self.binding }), activeSessionID == context.sessionID
      {
        binding = current
      } else {
        binding = try recoverLatestBinding(sessionID: context.sessionID)
        bindingLock.withLock { self.binding = binding }
        activeSessionID = context.sessionID
      }
      let snapshot = try openSnapshot(binding: binding)
      return ProcessingWork(
        snapshot: snapshot,
        binding: binding,
        sessionID: context.sessionID,
        startingChunkIndex: UInt64(
          max(indexLock.withLock { primaryIndex }, context.nextPrimaryIndex)),
        finalFlush: true)
    }
  }

  private func recoverLatestBinding(sessionID: String) throws -> LaneBinding {
    let entries = try matchingEntries()
    let authority = try retainedAuthority(
      sessionID: sessionID,
      serverNextIndex: indexLock.withLock { primaryIndex })
    let entry: ArchiveRetainedLaneCatalogEntry
    if let latestIdentity = authority.latestIdentity {
      guard
        let exact = entries.first(where: {
          $0.descriptor.context == latestIdentity.context
            && $0.descriptor.initialSamplePosition
              == latestIdentity.expectedInitialSessionSample
            && $0.descriptor.keywrapDigestHex == latestIdentity.keywrapDigestHex
        })
      else { throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch }
      entry = exact
    } else if let latest = entries.last {
      entry = latest
    } else {
      throw PrimaryResidentArchiveCaptureOwnerError.noRetainedLane
    }
    let opened = try openSnapshotAndIdentity(entry: entry)
    let snapshot = opened.snapshot
    defer { snapshot.close() }
    let replay = try reservations(snapshot: snapshot, layout: entry.layout)
    let sessionStart =
      authority.sessionSampleStart
      ?? replay.filter { $0.initialReservation.sessionID == sessionID }
      .map(\.initialReservation.sampleStart).min()
      ?? replay.map(\.initialReservation.sampleEnd).max()
      ?? entry.descriptor.initialSamplePosition
    let segmentStart = try segmentSampleStart(
      identityContext: entry.descriptor.context,
      sessionID: sessionID,
      fallback: sessionStart,
      reservations: replay.filter { $0.initialReservation.sessionID == sessionID }
        .map(\.initialReservation))
    return LaneBinding(
      identity: opened.identity,
      layout: entry.layout,
      sessionID: sessionID,
      sessionSampleStart: segmentStart)
  }

  private func openLane(istDate: String) throws -> ArchiveOpenedRetainedLane {
    let entries = try matchingEntries()
    if let existing = entries.first(where: { $0.descriptor.context.istDate == istDate }) {
      guard existing.descriptor.context.stableDeviceUID == stableDeviceUID else {
        throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
      }
      return try builder.openLane(
        context: existing.descriptor.context,
        initialSamplePosition: existing.descriptor.initialSamplePosition)
    }
    var snapshots: [ArchiveLaneStore.AuthenticatedSnapshot] = []
    do {
      snapshots = try entries.map(openSnapshot(entry:))
      let initial = try ArchiveAuthenticatedSampleOriginResolver.resolve(
        roomID: roomID,
        laneID: "primary",
        stableDeviceUID: stableDeviceUID,
        targetISTDate: istDate,
        snapshots: snapshots)
      for snapshot in snapshots { snapshot.close() }
      let context = ArchiveContext(
        streamUUID: try keyLifecycle.makeDailyStreamUUID(),
        roomID: roomID,
        istDate: istDate,
        laneID: "primary",
        stableDeviceUID: stableDeviceUID)
      return try builder.openLane(context: context, initialSamplePosition: initial)
    } catch {
      for snapshot in snapshots { snapshot.close() }
      throw error
    }
  }

  private func openRolloverLane(fence: ResidentArchiveRolloverFence) throws -> ArchiveLaneStore {
    let rolloverState = bindingLock.withLock {
      () -> (
        LaneBinding?,
        (@Sendable (ArchiveRolloverPreparation) throws -> Void)?,
        (
          @Sendable (
            ArchiveRolloverPreparation, ArchiveRolloverAudioLane, ArchiveStagedRetainedLane
          ) throws
            -> ArchiveRolloverPlan
        )?,
        (@Sendable () throws -> ArchiveLaneStore.AuthenticatedSnapshot)?,
        UInt64?
      ) in
      (
        binding, persistRolloverPreparation, persistRolloverIntent, snapshotProvider,
        activeSessionSampleStart
      )
    }
    guard let oldBinding = rolloverState.0,
      let persistPreparation = rolloverState.1, let persistIntent = rolloverState.2
    else {
      throw PrimaryResidentArchiveCaptureOwnerError.rolloverJournalUnavailable
    }
    guard fence.authenticatedFacts.context == oldBinding.identity.context,
      fence.authenticatedFacts.initialSamplePosition
        == oldBinding.identity.expectedInitialSessionSample,
      fence.authenticatedFacts.authenticatedSampleEnd >= oldBinding.sessionSampleStart
    else {
      throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
    }
    let oldDay = try oldBinding.identity.istDay
    let targetDate = Date(timeIntervalSince1970: Double(fence.wallNS) / 1_000_000_000)
    let newDay = try ArchiveISTDay(containing: targetDate)
    guard try oldDay.next == newDay else {
      throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
    }
    let localReservations = indexLock.withLock { Array(knownPrimaryReservations.values) }
    let nextIndex = try reconcilePrimaryIndex(
      reservations: localReservations,
      sessionID: oldBinding.sessionID)
    let preparation = try ArchiveRolloverPreparation(
      sessionID: oldBinding.sessionID,
      sessionSampleStart: rolloverState.4 ?? oldBinding.sessionSampleStart,
      oldDay: oldBinding.identity,
      boundarySample: fence.authenticatedFacts.authenticatedSampleEnd,
      nextChunkIndex: nextIndex,
      oldAuthenticatedFacts: fence.authenticatedFacts,
      targetISTDay: newDay)
    try persistPreparation(preparation)

    guard let snapshotProvider = rolloverState.3 else {
      throw PrimaryResidentArchiveCaptureOwnerError.rolloverJournalUnavailable
    }
    let oldSnapshot = try snapshotProvider()
    defer { oldSnapshot.close() }
    guard oldSnapshot.authenticatedFacts == preparation.oldAuthenticatedFacts else {
      throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
    }
    let staged =
      try builder.reopenStagedNextDayLane(
        stageID: preparation.commandID,
        oldDaySnapshot: oldSnapshot,
        roomID: roomID,
        istDate: newDay.description,
        stableDeviceUID: stableDeviceUID,
        expectedInitialSamplePosition: preparation.boundarySample)
      ?? builder.stageNextDayLane(
        stageID: preparation.commandID,
        context: ArchiveContext(
          streamUUID: try ArchiveRetainedLaneBuilder.deterministicRolloverStreamUUID(
            stageID: preparation.commandID, kind: .primary),
          roomID: roomID,
          istDate: newDay.description,
          laneID: "primary",
          stableDeviceUID: stableDeviceUID),
        oldDaySnapshot: oldSnapshot,
        expectedInitialSamplePosition: preparation.boundarySample)
    var published: ArchiveOpenedRetainedLane?
    do {
      let newIdentity = staged.identity
      let newSnapshot = try staged.store.authenticatedSnapshot()
      let newFacts = newSnapshot.authenticatedFacts
      newSnapshot.close()
      guard staged.catalogEntry.descriptor.initialSamplePosition == preparation.boundarySample,
        newFacts.context == newIdentity.context,
        newFacts.initialSamplePosition == preparation.boundarySample,
        newFacts.authenticatedSampleEnd == preparation.boundarySample,
        newFacts.recordCount == 0
      else {
        throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
      }
      let primary = try ArchiveRolloverAudioLane(
        oldDay: oldBinding.identity,
        newDay: newIdentity,
        nextChunkIndex: UInt64(preparation.nextChunkIndex),
        boundarySample: preparation.boundarySample,
        oldAuthenticatedFacts: preparation.oldAuthenticatedFacts,
        newAuthenticatedFacts: newFacts)
      let plan = try persistIntent(preparation, primary, staged)
      guard plan.preparationID == preparation.commandID, plan.primary == primary,
        plan.backup == nil
      else {
        throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
      }
      staged.store.close()
      let opened = try builder.openPublishedLane(identity: newIdentity)
      published = opened
      try bindingLock.withLock {
        if !completedBindings.contains(where: {
          $0.binding.sessionID == oldBinding.sessionID
            && $0.binding.identity.context == oldBinding.identity.context
        }) {
          completedBindings.append(
            CompletedLaneBinding(
              binding: oldBinding,
              sampleEnd: preparation.boundarySample,
              finalReserved: false))
        }
        binding = LaneBinding(
          identity: newIdentity,
          layout: opened.catalogEntry.layout,
          sessionID: oldBinding.sessionID,
          sessionSampleStart: preparation.boundarySample)
        if let existing = pendingRolloverPlans.first(where: { $0.commandID == plan.commandID }) {
          guard existing == plan else {
            throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
          }
        } else {
          pendingRolloverPlans.append(plan)
          pendingRolloverPlans.sort {
            $0.primary.oldDay.context.istDate < $1.primary.oldDay.context.istDate
          }
        }
      }
    } catch {
      staged.store.close()
      published?.store.close()
      throw error
    }
    guard let published else {
      throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
    }
    return published.store
  }

  private func matchingEntries() throws -> [ArchiveRetainedLaneCatalogEntry] {
    try catalog.scan().filter {
      $0.descriptor.context.roomID == roomID && $0.descriptor.context.laneID == "primary"
    }.sorted { $0.descriptor.context.istDate < $1.descriptor.context.istDate }
  }

  private struct RetainedSessionAuthority {
    let hasSessionEvidence: Bool
    let sessionSampleStart: UInt64?
    let nextChunkIndex: UInt32
    let latestIdentity: ArchiveDailyLaneIdentity?
  }

  private func retainedAuthority(
    sessionID: String,
    serverNextIndex: Int
  ) throws -> RetainedSessionAuthority {
    var allReservations: [ArchiveJournalPayload] = []
    for entry in try matchingEntries() {
      let snapshot = try openSnapshot(entry: entry)
      do {
        allReservations.append(
          contentsOf: try reservations(snapshot: snapshot, layout: entry.layout).map(
            \.initialReservation))
        snapshot.close()
      } catch {
        snapshot.close()
        throw error
      }
    }
    try mergeKnownReservations(allReservations)
    let matching = allReservations.filter { $0.sessionID == sessionID && $0.laneID == "primary" }
    let plans = bindingLock.withLock { pendingRolloverPlans.filter { $0.sessionID == sessionID } }
    let captureBindings = bindingLock.withLock {
      recoveredCaptureBindings.filter { $0.sessionID == sessionID }.sorted {
        $0.primaryIdentity.context.istDate < $1.primaryIdentity.context.istDate
      }
    }
    let sortedPlans = plans.sorted {
      $0.primary.oldDay.context.istDate < $1.primary.oldDay.context.istDate
    }
    let sessionStarts = Set(
      captureBindings.map(\.sessionSampleStart) + sortedPlans.map(\.sessionSampleStart))
    guard sessionStarts.count <= 1 else {
      throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
    }
    var identitiesByDay: [String: ArchiveDailyLaneIdentity] = [:]
    for binding in captureBindings {
      let day = binding.primaryIdentity.context.istDate
      if let existing = identitiesByDay[day], existing != binding.primaryIdentity {
        throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
      }
      identitiesByDay[day] = binding.primaryIdentity
    }
    for plan in sortedPlans {
      for identity in [plan.primary.oldDay, plan.primary.newDay] {
        let day = identity.context.istDate
        if let existing = identitiesByDay[day], existing != identity {
          throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
        }
        identitiesByDay[day] = identity
      }
    }
    for binding in captureBindings {
      guard
        try matchingEntries().contains(where: {
          $0.descriptor.context == binding.primaryIdentity.context
            && $0.descriptor.initialSamplePosition
              == binding.primaryIdentity.expectedInitialSessionSample
            && $0.descriptor.keywrapDigestHex == binding.primaryIdentity.keywrapDigestHex
        })
      else { throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch }
    }
    for identity in identitiesByDay.values {
      guard
        try matchingEntries().contains(where: {
          $0.descriptor.context == identity.context
            && $0.descriptor.initialSamplePosition == identity.expectedInitialSessionSample
            && $0.descriptor.keywrapDigestHex == identity.keywrapDigestHex
        })
      else { throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch }
    }
    if !matching.isEmpty || !plans.isEmpty {
      guard let boundStart = sessionStarts.first,
        matching.allSatisfy({ $0.sampleStart >= boundStart }),
        plans.allSatisfy({ $0.sessionSampleStart == boundStart })
      else { throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch }
    }
    let next = try ArchiveReservationIndexReconciler.nextIndex(
      localReservations: allReservations,
      sessionID: sessionID,
      laneID: "primary",
      serverNextIndex: UInt64(serverNextIndex))
    return RetainedSessionAuthority(
      hasSessionEvidence: !captureBindings.isEmpty || !plans.isEmpty,
      sessionSampleStart: sessionStarts.first,
      nextChunkIndex: next,
      latestIdentity: identitiesByDay.sorted { $0.key < $1.key }.last?.value)
  }

  private func persistCaptureBindingIfNeeded(
    _ captureBinding: ArchiveCaptureSessionBinding
  ) throws {
    guard let persistCaptureBinding = bindingLock.withLock({ persistCaptureBinding }) else {
      throw PrimaryResidentArchiveCaptureOwnerError.rolloverJournalUnavailable
    }
    try bindingLock.withLock {
      if let existing = recoveredCaptureBindings.first(where: {
        $0.sessionID == captureBinding.sessionID
          && $0.primaryIdentity.context.istDate
            == captureBinding.primaryIdentity.context.istDate
      }), existing != captureBinding {
        throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
      }
    }
    try persistCaptureBinding(captureBinding)
    bindingLock.withLock {
      if !recoveredCaptureBindings.contains(captureBinding) {
        recoveredCaptureBindings.append(captureBinding)
      }
    }
  }

  private func ensureAuthenticatedRolloverBindings(sessionID: String) throws {
    let plans = bindingLock.withLock {
      pendingRolloverPlans.filter { $0.sessionID == sessionID }.sorted {
        $0.primary.newDay.context.istDate < $1.primary.newDay.context.istDate
      }
    }
    for plan in plans {
      if bindingLock.withLock({
        recoveredCaptureBindings.contains {
          $0.sessionID == sessionID
            && $0.primaryIdentity.context == plan.primary.newDay.context
        }
      }) {
        continue
      }
      let snapshot = try rolloverNewDaySnapshot(for: plan)
      let facts = snapshot.authenticatedFacts
      snapshot.close()
      guard facts.context == plan.primary.newDay.context,
        facts.initialSamplePosition == plan.primary.boundarySample,
        facts.authenticatedSampleEnd >= plan.primary.boundarySample
      else { throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch }
      guard facts.authenticatedSampleEnd > plan.primary.boundarySample else { continue }
      try persistCaptureBindingIfNeeded(
        ArchiveCaptureSessionBinding(
          sessionID: sessionID,
          primaryIdentity: plan.primary.newDay,
          sessionSampleStart: plan.sessionSampleStart,
          segmentSampleStart: plan.primary.boundarySample))
    }
  }

  private func segmentSampleStart(
    identityContext: ArchiveContext,
    sessionID: String,
    fallback: UInt64,
    reservations: [ArchiveJournalPayload]
  ) throws -> UInt64 {
    if let captureBinding = bindingLock.withLock({
      recoveredCaptureBindings.first {
        $0.sessionID == sessionID && $0.primaryIdentity.context == identityContext
      }
    }) {
      return captureBinding.segmentSampleStart
    }
    if let plan = bindingLock.withLock({
      pendingRolloverPlans.first {
        $0.sessionID == sessionID && $0.primary.newDay.context == identityContext
      }
    }) {
      return plan.primary.boundarySample
    }
    return reservations.map(\.sampleStart).min() ?? fallback
  }

  private func mergeKnownReservations(_ reservations: [ArchiveJournalPayload]) throws {
    try indexLock.withLock {
      for reservation in reservations {
        if let existing = knownPrimaryReservations[reservation.reservationID],
          existing != reservation
        {
          throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
        }
        knownPrimaryReservations[reservation.reservationID] = reservation
      }
    }
  }

  private func recoverMissingMidnightRollover(
    from entry: ArchiveRetainedLaneCatalogEntry,
    targetDay: ArchiveISTDay,
    sessionID: String,
    authority: RetainedSessionAuthority
  ) throws -> ArchiveOpenedRetainedLane {
    guard let sessionSampleStart = authority.sessionSampleStart else {
      throw PrimaryResidentArchiveCaptureOwnerError.retainedSessionIdentityUnavailable
    }
    let old = try openSnapshotAndIdentity(entry: entry)
    defer { old.snapshot.close() }
    let oldDay = try old.identity.istDay
    guard try oldDay.next == targetDay else {
      throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
    }
    let facts = old.snapshot.authenticatedFacts
    guard facts.context == old.identity.context,
      facts.initialSamplePosition == old.identity.expectedInitialSessionSample,
      facts.authenticatedSampleEnd
        >= max(
          sessionSampleStart, old.identity.expectedInitialSessionSample)
    else {
      throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
    }
    guard let persistPreparation = bindingLock.withLock({ persistRolloverPreparation }),
      let persistIntent = bindingLock.withLock({ persistRolloverIntent })
    else {
      throw PrimaryResidentArchiveCaptureOwnerError.rolloverJournalUnavailable
    }
    let preparation = try ArchiveRolloverPreparation(
      sessionID: sessionID,
      sessionSampleStart: sessionSampleStart,
      oldDay: old.identity,
      boundarySample: facts.authenticatedSampleEnd,
      nextChunkIndex: authority.nextChunkIndex,
      oldAuthenticatedFacts: facts,
      targetISTDay: targetDay)
    try persistPreparation(preparation)
    let staged =
      try builder.reopenStagedNextDayLane(
        stageID: preparation.commandID,
        oldDaySnapshot: old.snapshot,
        roomID: roomID,
        istDate: targetDay.description,
        stableDeviceUID: stableDeviceUID,
        expectedInitialSamplePosition: preparation.boundarySample)
      ?? builder.stageNextDayLane(
        stageID: preparation.commandID,
        context: ArchiveContext(
          streamUUID: try ArchiveRetainedLaneBuilder.deterministicRolloverStreamUUID(
            stageID: preparation.commandID, kind: .primary),
          roomID: roomID,
          istDate: targetDay.description,
          laneID: "primary",
          stableDeviceUID: stableDeviceUID),
        oldDaySnapshot: old.snapshot,
        expectedInitialSamplePosition: preparation.boundarySample)
    let plan: ArchiveRolloverPlan
    do {
      let newSnapshot = try staged.store.authenticatedSnapshot()
      let newFacts = newSnapshot.authenticatedFacts
      newSnapshot.close()
      let primary = try ArchiveRolloverAudioLane(
        oldDay: old.identity,
        newDay: staged.identity,
        nextChunkIndex: UInt64(preparation.nextChunkIndex),
        boundarySample: preparation.boundarySample,
        oldAuthenticatedFacts: facts,
        newAuthenticatedFacts: newFacts)
      plan = try persistIntent(preparation, primary, staged)
      guard plan.preparationID == preparation.commandID, plan.primary == primary,
        plan.sessionID == sessionID, plan.backup == nil
      else {
        throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
      }
      staged.store.close()
    } catch {
      staged.store.close()
      throw error
    }
    old.snapshot.close()
    bindingLock.withLock {
      if !pendingRolloverPlans.contains(where: { $0.commandID == plan.commandID }) {
        pendingRolloverPlans.append(plan)
      }
    }
    try hydrateRolloverPlans(sessionID: sessionID)
    return try builder.openPublishedLane(identity: plan.primary.newDay)
  }

  private func isTerminalRolloverError(_ error: Error) -> Bool {
    if error is ArchiveRolloverEffectFailure { return true }
    guard let rollover = error as? ArchiveRolloverError else { return false }
    switch rollover {
    case .effectFailed, .failedControlState:
      return true
    default:
      return false
    }
  }

  private func openSnapshot(binding: LaneBinding) throws
    -> ArchiveLaneStore.AuthenticatedSnapshot
  {
    let opened = try keyLifecycle.openExistingLaneSnapshotWithInspection(
      keywrapURL: binding.layout.keywrapURL,
      tapeURL: binding.layout.tapeURL,
      indexURL: binding.layout.indexURL,
      context: binding.identity.context,
      initialSamplePosition: binding.identity.expectedInitialSessionSample)
    guard opened.keywrap.authenticated,
      opened.keywrap.keywrapDigestHex == binding.identity.keywrapDigestHex
    else {
      opened.snapshot.close()
      throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
    }
    return opened.snapshot
  }

  private func openSnapshot(entry: ArchiveRetainedLaneCatalogEntry) throws
    -> ArchiveLaneStore.AuthenticatedSnapshot
  {
    try openSnapshotAndIdentity(entry: entry).snapshot
  }

  private func openSnapshotAndIdentity(entry: ArchiveRetainedLaneCatalogEntry) throws -> (
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    identity: ArchiveDailyLaneIdentity
  ) {
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
      throw PrimaryResidentArchiveCaptureOwnerError.retainedDescriptorMismatch
    }
    return (
      opened.snapshot,
      try ArchiveDailyLaneIdentity(
        context: entry.descriptor.context,
        expectedInitialSessionSample: entry.descriptor.initialSamplePosition,
        keywrap: opened.keywrap)
    )
  }

  private func reservations(
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    layout: ArchiveRetainedLaneLayout
  ) throws -> [ArchiveJournalReplayReservation] {
    guard FileManager.default.fileExists(atPath: layout.journalURL.path) else { return [] }
    let journal = try snapshot.openJournalStoreForAppend(at: layout.journalURL)
    defer { journal.close() }
    return try Array(
      ArchiveJournalReplay.validate(
        journal.scanResult.records.map {
          try ArchiveJournalPayloadCodec.decode($0.plaintext)
        }
      ).values)
  }
}
