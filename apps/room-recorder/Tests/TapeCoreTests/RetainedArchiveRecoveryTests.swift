import Darwin
import Foundation
import Security
import Testing

@testable import RoomRecorderCore
@testable import TapeCore

@Suite struct RetainedArchiveRecoveryTests {
  @Test func emptyCatalogCompletesWithoutWireTraffic() async throws {
    let root = try makePrivateTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let recovery = try RetainedArchiveRecovery(rootURL: root, wire: UnusedWire())

    await recovery.run()

    #expect(await recovery.state() == .complete)
  }

  @Test func malformedCatalogFailsClosed() async throws {
    let root = try makePrivateTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let archive = root.appendingPathComponent(
      ArchiveRetainedLaneLayout.archiveDirectoryName,
      isDirectory: true
    )
    try FileManager.default.createDirectory(
      at: archive,
      withIntermediateDirectories: false,
      attributes: [.posixPermissions: NSNumber(value: 0o700)]
    )
    _ = chmod(archive.path, mode_t(0o700))
    try Data([0x01]).write(to: archive.appendingPathComponent("unexpected"))
    let recovery = try RetainedArchiveRecovery(rootURL: root, wire: UnusedWire())

    await recovery.run()

    guard case .failed(let reason) = await recovery.state() else {
      Issue.record("malformed catalog was not rejected")
      return
    }
    #expect(reason == ArchiveRetainedLaneCatalogError.unexpectedEntry.localizedDescription)
  }

  @Test func encoderCapabilityRequiresASpoolCoordinator() throws {
    let root = try makePrivateTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }

    let inventoryOnly = try RetainedArchiveRecovery(rootURL: root, wire: UnusedWire())
    let encoderCapable = try RetainedArchiveRecovery(
      rootURL: root,
      wire: UnusedWire(),
      ffmpegURL: URL(fileURLWithPath: "/usr/bin/false"),
      encoderProvenanceID: "test-encoder")

    #expect(!inventoryOnly.encoderCapable)
    #expect(encoderCapable.encoderCapable)
  }

  @Test func preparationOnlyCrashPromotesPrimaryPlanAndReservesOldTailOnReopen()
    async throws
  {
    let fixture = try RolloverRecoveryFixture("preparation")
    defer { fixture.remove() }
    try fixture.persistPreparationOnly()

    try fixture.reopenAndRecoverRollover()

    let commands = try fixture.recoveredCommands()
    let plan = try #require(commands.values.first(where: { $0.commandKind == .rollover }))
    #expect(plan.state == .rolloverComplete)
    #expect(plan.rolloverPlan?.backup == nil)
    #expect(plan.rolloverPlan?.preparationID == fixture.preparation.commandID)
    let inventory = try await fixture.deliveryInventory().scan()
    #expect(inventory.localReservations.count == 1)
    #expect(inventory.blockedReservations.count == 1)
    #expect(inventory.localReservations.first?.chunkIndex == fixture.preparation.nextChunkIndex)
  }

  @Test func pendingPlanReopensThroughAllStatesAndAcceptsAuthenticatedNewAudioGrowth() throws {
    let fixture = try RolloverRecoveryFixture("pending-growth")
    defer { fixture.remove() }
    let plan = try fixture.persistFullPlan(growNewDayBySamples: 80)

    try fixture.reopenAndRecoverRollover()

    let commands = try fixture.recoveredCommands()
    #expect(commands[plan.commandID]?.state == .rolloverComplete)
    #expect(
      try fixture.rolloverStates(commandID: plan.commandID) == [
        .rolloverIntent,
        .oldDayFinalReserved,
        .oldDayFilesClosed,
        .newDayFilesDurable,
        .rolloverComplete,
      ])
  }

  @Test func stagedAudioIsInvisibleUntilRecoveryPersistsThePlan() throws {
    let fixture = try RolloverRecoveryFixture("audio-stage-crash")
    defer { fixture.remove() }
    try fixture.persistAudioStageOnly()

    var visibility = try fixture.nextDayVisibility()
    #expect(!visibility.control && !visibility.audio)
    try fixture.reopenAndRecoverRollover()
    visibility = try fixture.nextDayVisibility()
    #expect(visibility.control && visibility.audio)
    try fixture.reopenAndRecoverRollover()
    visibility = try fixture.nextDayVisibility()
    #expect(visibility.control && visibility.audio)
  }

  @Test func rolloverCommitCrashPointsConvergeWithoutPrePlanAudioVisibility() throws {
    for point in [
      RetainedRolloverCommitPoint.controlStaged,
      .planAppended,
      .controlPublished,
      .audioPublished,
    ] {
      let fixture = try RolloverRecoveryFixture("commit-\(point)")
      defer { fixture.remove() }
      try fixture.crashRollover(at: point)
      let before = try fixture.nextDayVisibility()
      if point == .controlStaged || point == .planAppended {
        #expect(!before.control && !before.audio)
      } else if point == .controlPublished {
        #expect(before.control && !before.audio)
      } else {
        #expect(before.control && before.audio)
      }

      try fixture.reopenAndRecoverRollover()
      var after = try fixture.nextDayVisibility()
      #expect(after.control && after.audio)
      let commands = try fixture.recoveredCommands()
      let plan = try #require(commands.values.first { $0.commandKind == .rollover })
      #expect(plan.state == .rolloverComplete)
      try fixture.reopenAndRecoverRollover()
      after = try fixture.nextDayVisibility()
      #expect(after.control && after.audio)
    }
  }

  @Test func failedRolloverIsRefusedWithoutRetryingEffects() throws {
    let fixture = try RolloverRecoveryFixture("failed")
    defer { fixture.remove() }
    let plan = try fixture.persistFullPlan()
    try fixture.failPersistedPlan(plan)
    let journalSize = try Data(contentsOf: fixture.oldControlJournalURL).count

    #expect(throws: RetainedArchiveRolloverRecoveryError.failedRollover(plan.commandID)) {
      try fixture.reopenAndRecoverRollover()
    }
    #expect(try Data(contentsOf: fixture.oldControlJournalURL).count == journalSize)
  }

  @Test func descriptorlessAudioAndControlStagesReopenWithDeterministicContexts() throws {
    let fixture = try RolloverRecoveryFixture("partial-stage")
    defer { fixture.remove() }

    try fixture.recoverDescriptorlessAudioStage()
    try fixture.recoverDescriptorlessControlStage()
  }

  @Test func renameVisiblePublicationRetryResyncsDestinationAndArchiveParents() throws {
    let fixture = try RolloverRecoveryFixture("rename-visible-retry")
    defer { fixture.remove() }
    let artifacts = try fixture.makeStagedArtifacts()
    defer { artifacts.primary.store.close() }

    let controlProbe = PublicationRetryProbe(point: .renamedControl)
    let controlCatalog = try ArchiveRetainedLaneCatalog(
      rootURL: fixture.root,
      hooks: controlProbe.hooks)
    #expect(throws: PublicationRetryError.injected) {
      try controlCatalog.publishStagedControl(
        identity: artifacts.control.identity,
        stageID: fixture.preparation.commandID)
    }
    _ = try controlCatalog.publishStagedControl(
      identity: artifacts.control.identity,
      stageID: fixture.preparation.commandID)
    #expect(controlProbe.synchronizationsAfterFailure >= 2)

    let audioProbe = PublicationRetryProbe(point: .renamedLane)
    let audioCatalog = try ArchiveRetainedLaneCatalog(
      rootURL: fixture.root,
      hooks: audioProbe.hooks)
    #expect(throws: PublicationRetryError.injected) {
      try audioCatalog.publishStagedLane(
        identity: artifacts.primary.identity,
        stageID: fixture.preparation.commandID)
    }
    _ = try audioCatalog.publishStagedLane(
      identity: artifacts.primary.identity,
      stageID: fixture.preparation.commandID)
    #expect(audioProbe.synchronizationsAfterFailure >= 2)
  }

  private func makePrivateTemporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(
      "retained-recovery-\(UUID().uuidString)",
      isDirectory: true
    )
    try FileManager.default.createDirectory(
      at: url,
      withIntermediateDirectories: false,
      attributes: [.posixPermissions: NSNumber(value: 0o700)]
    )
    _ = chmod(url.path, mode_t(0o700))
    guard let resolved = realpath(url.path, nil) else { throw CocoaError(.fileNoSuchFile) }
    defer { Darwin.free(resolved) }
    return URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
  }
}

private final class RolloverRecoveryFixture {
  let root: URL
  let lifecycle: ArchiveKeyLifecycle
  let oldDay = try! ArchiveISTDay("2026-08-28")
  let newDay = try! ArchiveISTDay("2026-08-29")
  let preparation: ArchiveRolloverPreparation
  let oldIdentity: ArchiveDailyLaneIdentity
  let oldEntry: ArchiveRetainedLaneCatalogEntry
  private var journal: RotatingArchiveRoomControlJournal?

  var oldControlJournalURL: URL {
    try! ArchiveRetainedLaneCatalog(rootURL: root).scanIncludingControls().controls.first {
      $0.descriptor.context.istDate == oldDay.description
    }!.layout.journalURL
  }

  init(_ label: String) throws {
    root = try Self.makeRoot(label)
    let security = RecoverySecurityProvider()
    let random = RecoveryRandom()
    lifecycle = ArchiveKeyLifecycle(
      security: security,
      durableStore: ArchiveKeyDurableStore(),
      applicationSupportRoot: root,
      randomBytes: random.next,
      reservedLaneStoreOpener: {
        tapeURL, indexURL, tapeFD, indexFD, rootKey, context, initialSamplePosition in
        try ArchiveLaneStore.openReservedForAppend(
          tapeURL: tapeURL,
          indexURL: indexURL,
          tapeFileDescriptor: tapeFD,
          indexFileDescriptor: indexFD,
          rootKey: rootKey,
          context: context,
          initialSamplePosition: initialSamplePosition)
      })
    journal = try RotatingArchiveRoomControlJournal(
      rootURL: root,
      roomID: "room_recovery",
      keyLifecycle: lifecycle,
      currentDay: oldDay)
    let builder = try ArchiveRetainedLaneBuilder(rootURL: root, keyLifecycle: lifecycle)
    let opened = try builder.openLane(
      context: ArchiveContext(
        streamUUID: try lifecycle.makeDailyStreamUUID(),
        roomID: "room_recovery",
        istDate: oldDay.description,
        laneID: "primary",
        stableDeviceUID: "synthetic-device"))
    _ = try opened.store.appendPCM(
      Data(repeating: 0, count: 320),
      observation: ArchiveIndexObservation(
        monoNS: 10_000_000,
        wallNS: 1_777_777_777_000_000_000,
        rmsQ15: 0,
        nativeFrames: 160,
        inputRateNumerator: 16_000,
        inputRateDenominator: 1))
    let snapshot = try opened.store.authenticatedSnapshot()
    oldIdentity = try ArchiveDailyLaneIdentity(
      context: opened.catalogEntry.descriptor.context,
      expectedInitialSessionSample: 0,
      keywrap: opened.keywrap)
    oldEntry = opened.catalogEntry
    preparation = try ArchiveRolloverPreparation(
      sessionID: "bs_recovery",
      sessionSampleStart: 0,
      oldDay: oldIdentity,
      boundarySample: 160,
      nextChunkIndex: 7,
      oldAuthenticatedFacts: snapshot.authenticatedFacts,
      targetISTDay: newDay)
    snapshot.close()
    opened.store.close()
  }

  func persistPreparationOnly() throws {
    try journal!.persistRolloverPreparation(preparation)
    journal = nil
  }

  func persistAudioStageOnly() throws {
    try journal!.persistRolloverPreparation(preparation)
    let staged = try makeStagedPrimary().staged
    staged.store.close()
    journal = nil
  }

  func crashRollover(at point: RetainedRolloverCommitPoint) throws {
    try journal!.persistRolloverPreparation(preparation)
    let values = try makeStagedPrimary()
    journal = nil
    journal = try RotatingArchiveRoomControlJournal(
      rootURL: root,
      roomID: "room_recovery",
      keyLifecycle: lifecycle,
      currentDay: oldDay,
      rolloverCheckpoint: {
        if $0 == point { throw RolloverCrash() }
      })
    do {
      _ = try journal!.persistRolloverIntent(
        preparation: preparation,
        primary: values.primary,
        stagedPrimary: values.staged)
      Issue.record("expected injected rollover crash at \(point)")
    } catch is RolloverCrash {
    }
    values.staged.store.close()
    journal = nil
  }

  func nextDayVisibility() throws -> (control: Bool, audio: Bool) {
    let snapshot = try ArchiveRetainedLaneCatalog(rootURL: root).scanIncludingControls()
    return (
      snapshot.controls.contains { $0.descriptor.context.istDate == newDay.description },
      snapshot.lanes.contains { $0.descriptor.context.istDate == newDay.description }
    )
  }

  func persistFullPlan(growNewDayBySamples sampleCount: Int = 0) throws -> ArchiveRolloverPlan {
    try journal!.persistRolloverPreparation(preparation)
    let values = try makeStagedPrimary()
    let staged = values.staged
    let plan = try journal!.persistRolloverIntent(
      preparation: preparation,
      primary: values.primary,
      stagedPrimary: staged)
    staged.store.close()
    let published = try ArchiveRetainedLaneBuilder(rootURL: root, keyLifecycle: lifecycle)
      .openPublishedLane(identity: staged.identity)
    if sampleCount > 0 {
      _ = try published.store.appendPCM(
        Data(repeating: 0, count: sampleCount * 2),
        observation: ArchiveIndexObservation(
          monoNS: 20_000_000,
          wallNS: 1_777_777_778_000_000_000,
          rmsQ15: 0,
          nativeFrames: UInt64(sampleCount),
          inputRateNumerator: 16_000,
          inputRateDenominator: 1))
    }
    published.store.close()
    journal = nil
    return plan
  }

  func makeStagedPrimary() throws -> (
    staged: ArchiveStagedRetainedLane,
    primary: ArchiveRolloverAudioLane
  ) {
    let old = try lifecycle.openExistingLaneSnapshotWithInspection(
      keywrapURL: oldEntry.layout.keywrapURL,
      tapeURL: oldEntry.layout.tapeURL,
      indexURL: oldEntry.layout.indexURL,
      context: oldIdentity.context,
      initialSamplePosition: 0)
    defer { old.snapshot.close() }
    let builder = try ArchiveRetainedLaneBuilder(rootURL: root, keyLifecycle: lifecycle)
    let staged = try builder.stageNextDayLane(
      stageID: preparation.commandID,
      context: ArchiveContext(
        streamUUID: try ArchiveRetainedLaneBuilder.deterministicRolloverStreamUUID(
          stageID: preparation.commandID, kind: .primary),
        roomID: "room_recovery",
        istDate: newDay.description,
        laneID: "primary",
        stableDeviceUID: "synthetic-device"),
      oldDaySnapshot: old.snapshot,
      expectedInitialSamplePosition: preparation.boundarySample)
    let initial = try staged.store.authenticatedSnapshot()
    let newIdentity = staged.identity
    let primary = try ArchiveRolloverAudioLane(
      oldDay: oldIdentity,
      newDay: newIdentity,
      nextChunkIndex: UInt64(preparation.nextChunkIndex),
      boundarySample: preparation.boundarySample,
      oldAuthenticatedFacts: preparation.oldAuthenticatedFacts,
      newAuthenticatedFacts: initial.authenticatedFacts)
    initial.close()
    return (staged, primary)
  }

  func makeStagedArtifacts() throws -> (
    primary: ArchiveStagedRetainedLane,
    control: ArchiveStagedRetainedControl
  ) {
    let primary = try makeStagedPrimary().staged
    let builder = try ArchiveRetainedLaneBuilder(rootURL: root, keyLifecycle: lifecycle)
    let control = try builder.stageControl(
      stageID: preparation.commandID,
      context: ArchiveContext(
        streamUUID: try ArchiveRetainedLaneBuilder.deterministicRolloverStreamUUID(
          stageID: preparation.commandID, kind: .control),
        roomID: "room_recovery",
        istDate: newDay.description,
        laneID: "_control",
        stableDeviceUID: ""))
    return (primary, control)
  }

  func recoverDescriptorlessAudioStage() throws {
    let old = try lifecycle.openExistingLaneSnapshotWithInspection(
      keywrapURL: oldEntry.layout.keywrapURL,
      tapeURL: oldEntry.layout.tapeURL,
      indexURL: oldEntry.layout.indexURL,
      context: oldIdentity.context,
      initialSamplePosition: 0)
    defer { old.snapshot.close() }
    let catalog = try ArchiveRetainedLaneCatalog(rootURL: root)
    let stage = try catalog.prepareRolloverLaneStage(stageID: preparation.commandID)
    let context = ArchiveContext(
      streamUUID: try ArchiveRetainedLaneBuilder.deterministicRolloverStreamUUID(
        stageID: preparation.commandID, kind: .primary),
      roomID: "room_recovery",
      istDate: newDay.description,
      laneID: "primary",
      stableDeviceUID: "synthetic-device")
    let partial = try lifecycle.openNextDayLaneStore(
      keywrapURL: stage.laneDirectoryURL.appendingPathComponent("keywrap.eak"),
      tapeURL: stage.laneDirectoryURL.appendingPathComponent("lane.tape"),
      indexURL: stage.laneDirectoryURL.appendingPathComponent("lane.index"),
      context: context,
      oldDaySnapshot: old.snapshot,
      expectedInitialSamplePosition: preparation.boundarySample)
    partial.store.close()
    #expect(try catalog.stagedLaneDescriptor(stageID: preparation.commandID) == nil)
    let recovered = try ArchiveRetainedLaneBuilder(rootURL: root, keyLifecycle: lifecycle)
      .stageNextDayLane(
        stageID: preparation.commandID,
        context: context,
        oldDaySnapshot: old.snapshot,
        expectedInitialSamplePosition: preparation.boundarySample)
    recovered.store.close()
    #expect(try catalog.stagedLaneDescriptor(stageID: preparation.commandID) != nil)
  }

  func recoverDescriptorlessControlStage() throws {
    let catalog = try ArchiveRetainedLaneCatalog(rootURL: root)
    let stage = try catalog.prepareRolloverControlStage(stageID: preparation.commandID)
    let context = ArchiveContext(
      streamUUID: try ArchiveRetainedLaneBuilder.deterministicRolloverStreamUUID(
        stageID: preparation.commandID, kind: .control),
      roomID: "room_recovery",
      istDate: newDay.description,
      laneID: "_control",
      stableDeviceUID: "")
    _ = try lifecycle.prepareControlKeywrapWithInspection(
      keywrapURL: stage.controlDirectoryURL.appendingPathComponent("keywrap.eak"),
      journalURL: stage.controlDirectoryURL.appendingPathComponent(
        ArchiveRetainedControlLayout.journalFileName),
      context: context)
    #expect(try catalog.stagedControlDescriptor(stageID: preparation.commandID) == nil)
    _ = try ArchiveRetainedLaneBuilder(rootURL: root, keyLifecycle: lifecycle).stageControl(
      stageID: preparation.commandID,
      context: context)
    #expect(try catalog.stagedControlDescriptor(stageID: preparation.commandID) != nil)
  }

  func failPersistedPlan(_ plan: ArchiveRolloverPlan) throws {
    journal = try RotatingArchiveRoomControlJournal(
      rootURL: root,
      roomID: "room_recovery",
      keyLifecycle: lifecycle,
      currentDay: newDay)
    let effects = ArchiveRolloverEffects(
      reserveOldDayFinal: { _ in throw ArchiveRolloverEffectFailure.authenticationFailed },
      closeOldDayFiles: { _ in throw ArchiveRolloverEffectFailure.internalIOFailed },
      makeNewDayFilesDurable: { _ in throw ArchiveRolloverEffectFailure.internalIOFailed })
    do {
      _ = try journal!.resumeRollover(plan, effects: effects)
      Issue.record("expected rollover failure")
    } catch {
      #expect(
        error as? ArchiveRolloverError
          == .effectFailed(.authenticationFailed))
    }
    journal = nil
  }

  func reopenAndRecoverRollover() throws {
    journal = nil
    try RetainedArchiveRolloverRecovery(rootURL: root, keyLifecycle: lifecycle).run()
  }

  func recoveredCommands() throws -> [String: RoomRecoveredControlCommand] {
    try RotatingArchiveRoomControlJournal(
      rootURL: root,
      roomID: "room_recovery",
      keyLifecycle: lifecycle,
      currentDay: newDay
    ).recover()
  }

  func rolloverStates(commandID: String) throws -> [ArchiveControlState] {
    let controls = try ArchiveRetainedLaneCatalog(rootURL: root).scanIncludingControls().controls
    let old = try #require(
      controls.first {
        $0.descriptor.context.istDate == oldDay.description
      })
    let opened = try lifecycle.openExistingControlStoreWithInspection(
      keywrapURL: old.layout.keywrapURL,
      journalURL: old.layout.journalURL,
      context: old.descriptor.context)
    defer { opened.store.close() }
    return try opened.store.scanResult.records.compactMap {
      let payload = try ArchiveControlPayloadCodec.decode($0.plaintext)
      return payload.commandID == commandID ? payload.newState : nil
    }
  }

  func deliveryInventory() throws -> ArchiveDeliveryDiskInventory {
    let entries = try ArchiveRetainedLaneCatalog(rootURL: root).scan()
    let lanes = entries.map { entry in
      ArchiveDeliveryDiskLane(
        journalURL: entry.layout.journalURL,
        manifestURL: entry.layout.manifestURL,
        spoolDirectoryURL: entry.layout.spoolDirectoryURL
      ) {
        let opened = try self.lifecycle.openExistingLaneSnapshotWithInspection(
          keywrapURL: entry.layout.keywrapURL,
          tapeURL: entry.layout.tapeURL,
          indexURL: entry.layout.indexURL,
          context: entry.descriptor.context,
          initialSamplePosition: entry.descriptor.initialSamplePosition)
        return opened.snapshot
      }
    }
    return ArchiveDeliveryDiskInventory(lanes: lanes, wire: UnusedWire())
  }

  func remove() {
    journal = nil
    try? FileManager.default.removeItem(at: root)
  }

  private static func makeRoot(_ label: String) throws -> URL {
    let requested = FileManager.default.temporaryDirectory.appendingPathComponent(
      "rollover-recovery-\(label)-\(UUID().uuidString)",
      isDirectory: true)
    try FileManager.default.createDirectory(
      at: requested,
      withIntermediateDirectories: false,
      attributes: [.posixPermissions: NSNumber(value: 0o700)])
    _ = chmod(requested.path, mode_t(0o700))
    guard let resolved = realpath(requested.path, nil) else {
      throw CocoaError(.fileNoSuchFile)
    }
    defer { Darwin.free(resolved) }
    return URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
  }
}

private enum PublicationRetryError: Error {
  case injected
}

private final class PublicationRetryProbe: @unchecked Sendable {
  private let lock = NSLock()
  private let point: ArchiveRetainedLaneCatalogPublicationPoint
  private var shouldFail = true
  private var syncsAfterFailure = 0

  init(point: ArchiveRetainedLaneCatalogPublicationPoint) {
    self.point = point
  }

  var synchronizationsAfterFailure: Int { lock.withLock { syncsAfterFailure } }

  var hooks: ArchiveRetainedLaneCatalogHooks {
    ArchiveRetainedLaneCatalogHooks(
      didRename: { observed in
        try self.lock.withLock {
          guard self.shouldFail, self.matches(observed) else { return }
          self.shouldFail = false
          throw PublicationRetryError.injected
        }
      },
      synchronizeDirectory: { descriptor in
        self.lock.withLock {
          if !self.shouldFail { self.syncsAfterFailure += 1 }
        }
        return fsync(descriptor) == 0
      })
  }

  private func matches(_ observed: ArchiveRetainedLaneCatalogPublicationPoint) -> Bool {
    switch (point, observed) {
    case (.renamedControl, .renamedControl), (.renamedLane, .renamedLane): return true
    default: return false
    }
  }
}

private struct RolloverCrash: Error {}

private final class RecoveryRandom: @unchecked Sendable {
  private let lock = NSLock()
  private var counter: UInt8 = 1

  func next(count: Int) -> Data {
    lock.withLock {
      let byte = counter
      counter &+= 1
      var result = Data(repeating: byte, count: count)
      if count == 16 {
        result[6] = (result[6] & 0x0F) | 0x40
        result[8] = (result[8] & 0x3F) | 0x80
      }
      return result
    }
  }
}

private final class RecoverySecurityProvider: ArchiveKeySecurityProviding, @unchecked Sendable {
  private let lock = NSLock()
  private var keys: [ArchiveSecurityKey] = []
  private var encrypted: [Data: Data] = [:]
  private var nextCipher: UInt64 = 1

  func makeAccessControl(
    accessibility: CFString,
    flags: SecAccessControlCreateFlags
  ) throws -> AnyObject {
    NSObject()
  }

  func queryKeys(_ query: [String: Any]) throws -> [ArchiveSecurityKey] {
    lock.withLock { keys }
  }

  func createKey(_ attributes: [String: Any]) throws -> ArchiveSecurityKey {
    lock.withLock {
      let key = ArchiveSecurityKey(NSObject())
      keys.append(key)
      return key
    }
  }

  func publicKey(for privateKey: ArchiveSecurityKey) throws -> ArchiveSecurityKey {
    ArchiveSecurityKey(NSObject())
  }

  func externalRepresentation(of key: ArchiveSecurityKey) throws -> Data {
    Data([0x04]) + Data((0..<64).map(UInt8.init))
  }

  func supports(
    _ algorithm: SecKeyAlgorithm,
    operation: SecKeyOperationType,
    key: ArchiveSecurityKey
  ) -> Bool { true }

  func encrypt(
    _ plaintext: Data,
    with key: ArchiveSecurityKey,
    algorithm: SecKeyAlgorithm
  ) throws -> Data {
    lock.withLock {
      var value = nextCipher.littleEndian
      let ciphertext = withUnsafeBytes(of: &value) { Data($0) }
      nextCipher += 1
      encrypted[ciphertext] = plaintext
      return ciphertext
    }
  }

  func decrypt(
    _ ciphertext: Data,
    with key: ArchiveSecurityKey,
    algorithm: SecKeyAlgorithm
  ) throws -> Data {
    try lock.withLock {
      guard let plaintext = encrypted[ciphertext] else {
        throw ArchiveKeyLifecycleFailure.decryptionFailed
      }
      return plaintext
    }
  }

  func deleteKeys(_ query: [String: Any]) throws {
    lock.withLock { keys = [] }
  }
}

private struct UnusedWire: ArchiveDeliveryWire {
  func prepareDelivery(for piece: ArchiveDeliveryPiece) async throws
    -> ArchiveDeliveryPresignResult
  {
    throw UnusedWireError.called
  }

  func probeDeliveryObject(at url: URL) async throws -> ArchiveDeliveryRemoteObject {
    throw UnusedWireError.called
  }

  func putDeliveryObject(chunks: [Data], to url: URL, contentType: String) async throws {
    throw UnusedWireError.called
  }

  func registerDelivery(_ piece: ArchiveDeliveryPiece) async throws
    -> ArchiveDeliveryRegistration
  {
    throw UnusedWireError.called
  }
}

private enum UnusedWireError: Error {
  case called
}
