import CryptoKit
import Darwin
import Foundation
import Testing

@testable import TapeCore

@Suite(.serialized) struct ArchiveEncryptedSpoolTests {
  private let rootKey = Data(UInt8(0)...UInt8(31))
  private let attemptID = "11080b26-5b21-4ef7-aef4-a34a531f4852"

  private var context: ArchiveContext {
    ArchiveContext(
      streamUUID: Data(UInt8(16)...UInt8(31)),
      roomID: "room_spool_test",
      istDate: "2026-08-28",
      laneID: "primary",
      stableDeviceUID: "synthetic-spool-test"
    )
  }

  @Test func boundedRecordsPublishExclusivelyAndRecoverIdempotently() throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let reservation = try initialReservation()
    let encoded = deterministicBytes(
      count: ArchiveEncryptedSpoolWriter.maximumBufferedByteCount + 17)
    let writer = try ArchiveEncryptedSpoolWriter(
      snapshot: fixture.snapshot,
      directoryURL: fixture.directory,
      reservationID: reservation.reservationID,
      attemptID: attemptID
    )
    try writer.append(encoded.prefix(71))
    try writer.append(encoded.dropFirst(71))

    let completed = try writer.finishEncoding()
    #expect(completed.encodedBytes == UInt64(encoded.count))
    #expect(completed.encodedSHA256 == sha256(encoded))
    #expect(FileManager.default.fileExists(atPath: completed.temporaryURL.path))
    #expect(!FileManager.default.fileExists(atPath: writer.finalURL.path))
    let reservedReplay = try #require(
      ArchiveJournalReplay.validate([reservation])[reservation.reservationID]
    )

    let published = try ArchiveEncryptedSpoolPublisher.publish(
      snapshot: fixture.snapshot,
      directoryURL: fixture.directory,
      reservation: reservedReplay,
      expected: completed
    )
    #expect(!FileManager.default.fileExists(atPath: completed.temporaryURL.path))
    #expect(FileManager.default.fileExists(atPath: published.url.path))
    #expect(published.encodedSHA256 == sha256(encoded))

    let recovered = try ArchiveEncryptedSpoolPublisher.publish(
      snapshot: fixture.snapshot,
      directoryURL: fixture.directory,
      reservation: reservedReplay,
      expected: completed
    )
    #expect(recovered == published)
    let scan = try fixture.snapshot.inspectSpool(at: published.url)
    #expect(scan.records.count == 2)
    #expect(scan.records[0].plaintext.count == ArchiveEncryptedSpoolWriter.maximumBufferedByteCount)
    #expect(scan.records[1].plaintext.count == 17)
    #expect(joinedPlaintext(scan) == encoded)

    #expect(throws: ArchiveEncryptedSpoolError.finalAttemptExists) {
      try ArchiveEncryptedSpoolWriter(
        snapshot: fixture.snapshot,
        directoryURL: fixture.directory,
        reservationID: reservation.reservationID,
        attemptID: attemptID
      )
    }
  }

  @Test func spoolPublicationCorrespondsToJournalAndManifest() throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let initial = try initialReservation()
    let bytes = deterministicBytes(count: 4_097)
    let writer = try ArchiveEncryptedSpoolWriter(
      snapshot: fixture.snapshot,
      directoryURL: fixture.directory,
      reservationID: initial.reservationID,
      attemptID: attemptID
    )
    try writer.append(bytes)
    let completed = try writer.finishEncoding()
    let reservedReplay = try #require(
      ArchiveJournalReplay.validate([initial])[initial.reservationID]
    )
    let published = try ArchiveEncryptedSpoolPublisher.publish(
      snapshot: fixture.snapshot,
      directoryURL: fixture.directory,
      reservation: reservedReplay,
      expected: completed
    )
    let encodedTransition = try ArchiveJournalTransition.make(
      from: initial,
      attemptID: attemptID,
      priorState: .reserved,
      newState: .encoded
    )
    let durableTransition = try ArchiveJournalTransition.make(
      from: initial,
      attemptID: attemptID,
      priorState: .encoded,
      newState: .spoolDurable
    )
    let replay = try #require(
      ArchiveJournalReplay.validate([initial, encodedTransition, durableTransition])[
        initial.reservationID
      ])
    let manifest = try makeManifest(initial: initial, completed: completed, fitSegment: 3)
    let scan = try fixture.snapshot.inspectSpool(at: published.url)

    let validated = try ArchiveSpoolCorrespondence.validate(
      reservation: replay,
      manifest: manifest,
      spool: scan,
      spoolURL: published.url,
      expectedFitSegment: 3
    )
    #expect(validated == published)

    let wrongHash = try ArchiveManifestPayload(
      reservationID: manifest.reservationID,
      attemptID: manifest.attemptID,
      sampleStart: manifest.sampleStart,
      sampleEnd: manifest.sampleEnd,
      startMS: manifest.startMS,
      endMS: manifest.endMS,
      uncertainty: manifest.uncertainty,
      fitSegment: manifest.fitSegment,
      averageLevelQ15: manifest.averageLevelQ15,
      peakLevelQ15: manifest.peakLevelQ15,
      mime: manifest.mime,
      encodedBytes: manifest.encodedBytes,
      encodedSHA256: String(repeating: "0", count: 64),
      encoderProvenanceID: manifest.encoderProvenanceID
    )
    #expect(
      throws: ArchiveEncryptedSpoolError.encodedSHA256Mismatch(
        expected: String(repeating: "0", count: 64),
        actual: completed.encodedSHA256
      )
    ) {
      try ArchiveSpoolCorrespondence.validate(
        reservation: replay,
        manifest: wrongHash,
        spool: scan,
        spoolURL: published.url,
        expectedFitSegment: 3
      )
    }
  }

  @Test func privateFilesRejectModeChangesAndHardLinks() throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let url = fixture.directory.appendingPathComponent("hostile.spool")
    let store = try fixture.snapshot.createSpoolStore(at: url)
    _ = try store.append(plaintext: Data([1, 2, 3]), firstLogicalUnit: 0, logicalUnitCount: 3)
    store.close()

    #expect(chmod(url.path, mode_t(0o644)) == 0)
    #expect(throws: ArchiveDerivedPersistenceError.existingModeMismatch(UInt16(0o644))) {
      try fixture.snapshot.inspectSpool(at: url)
    }
    #expect(chmod(url.path, mode_t(0o600)) == 0)
    let alias = fixture.directory.appendingPathComponent("hostile-alias.spool")
    #expect(link(url.path, alias.path) == 0)
    #expect(throws: ArchiveDerivedPersistenceError.hardLinkedFile(2)) {
      try fixture.snapshot.inspectSpool(at: url)
    }
  }

  @Test func insecureSpoolDirectoryIsRefusedBeforeCreation() throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    #expect(chmod(fixture.directory.path, mode_t(0o755)) == 0)
    #expect(throws: ArchiveEncryptedSpoolError.insecureDirectoryMode(UInt16(0o755))) {
      try ArchiveEncryptedSpoolWriter(
        snapshot: fixture.snapshot,
        directoryURL: fixture.directory,
        reservationID: String(repeating: "a", count: 64),
        attemptID: attemptID
      )
    }
  }

  @Test func processDrainsLargeInputAndOutputConcurrently() throws {
    let input = deterministicBytes(count: 2 * 1_024 * 1_024 + 29)
    let captured = LockedData()
    try FoundationArchiveStreamingProcess.run(
      executableURL: URL(fileURLWithPath: "/bin/cat"),
      arguments: [],
      input: { write in
        var offset = 0
        while offset < input.count {
          let end = min(input.count, offset + 8_191)
          try write(input.subdata(in: offset..<end))
          offset = end
        }
      },
      output: { captured.append($0) }
    )
    #expect(captured.data == input)
  }

  @Test func killedProcessLeavesNoPublishableAttempt() throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let reservation = try initialReservation()
    let writer = try ArchiveEncryptedSpoolWriter(
      snapshot: fixture.snapshot,
      directoryURL: fixture.directory,
      reservationID: reservation.reservationID,
      attemptID: attemptID
    )
    let temporaryURL = writer.temporaryURL
    let finalURL = writer.finalURL

    #expect(throws: ArchiveFFmpegStreamingEncoderError.self) {
      try FoundationArchiveStreamingProcess.run(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        arguments: ["-c", "/bin/dd bs=64 count=1 2>/dev/null; kill -9 $$"],
        input: { write in try write(self.deterministicBytes(count: 1_024 * 1_024)) },
        output: { try writer.append($0) }
      )
    }
    #expect(FileManager.default.fileExists(atPath: temporaryURL.path))
    #expect(!FileManager.default.fileExists(atPath: finalURL.path))
    let reservedReplay = try #require(
      ArchiveJournalReplay.validate([reservation])[reservation.reservationID]
    )
    #expect(throws: ArchiveEncryptedSpoolError.completionEvidenceRequired) {
      try ArchiveEncryptedSpoolPublisher.publish(
        snapshot: fixture.snapshot,
        directoryURL: fixture.directory,
        reservation: reservedReplay
      )
    }
  }

  @Test func coordinatorPublishesManifestAndRerunsWithoutReencoding() throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let initial = try coordinatorReservation()
    let paths = try prepareCoordinator(fixture: fixture, initial: initial)
    let calls = EncoderCalls()
    let output = deterministicBytes(count: 9_001)
    let coordinator = ArchiveSpoolCoordinator(
      testEncoder: DeterministicSpoolEncoder(output: output, calls: calls),
      encoderProvenanceID: "ffmpeg-n9.0.1-arm64-test"
    )

    let first = try coordinator.advance(
      snapshot: fixture.snapshot,
      journalURL: paths.journal,
      manifestURL: paths.manifest,
      spoolDirectoryURL: fixture.directory,
      initialReservation: initial,
      fitSegment: 4,
      freshAttemptID: attemptID
    )
    #expect(calls.count == 1)
    #expect(first.journalRecordsWritten == 2)
    #expect(first.manifestWritten)
    #expect(first.published.encodedSHA256 == sha256(output))
    #expect(
      try journalStates(fixture.snapshot, at: paths.journal) == [
        .reserved, .encoded, .spoolDurable,
      ])
    #expect(try manifestCount(fixture.snapshot, at: paths.manifest) == 1)

    let second = try coordinator.advance(
      snapshot: fixture.snapshot,
      journalURL: paths.journal,
      manifestURL: paths.manifest,
      spoolDirectoryURL: fixture.directory,
      initialReservation: initial,
      fitSegment: 4,
      freshAttemptID: "12dff641-711b-4f46-aa9f-acbcd13b20d7"
    )
    #expect(calls.count == 1)
    #expect(second.published == first.published)
    #expect(second.journalRecordsWritten == 0)
    #expect(!second.manifestWritten)
    #expect(try manifestCount(fixture.snapshot, at: paths.manifest) == 1)
  }

  @Test func deliveryWritesEveryWitnessAndRetainsImmutableSpool() async throws {
    let fixture = try makeFixture(
      initialObservation: ArchiveIndexObservation(
        monoNS: 1,
        wallNS: 1_000_000_000,
        rmsQ15: 100,
        nativeFrames: nil,
        inputRateNumerator: nil,
        inputRateDenominator: nil,
        discontinuity: .resumed,
        reason: "resumed",
        gapNS: 27_400_000
      ))
    defer { fixture.remove() }
    let initial = try coordinatorReservation()
    let output = deterministicBytes(count: 9_001)
    let paths = try prepareDurableDelivery(
      fixture: fixture,
      initial: initial,
      output: output
    )
    let wire = MockArchiveDeliveryWire()
    let coordinator = ArchiveDeliveryCoordinator(wire: wire)

    let result = try await coordinator.advance(
      snapshot: fixture.snapshot,
      journalURL: paths.journal,
      manifestURL: paths.manifest,
      spoolDirectoryURL: fixture.directory,
      initialReservation: initial,
      expectedFitSegment: 3
    )

    #expect(result.state == .done)
    #expect(result.journalRecordsWritten == 4)
    #expect(result.uploaded)
    #expect(!result.alreadyVerified)
    #expect(FileManager.default.fileExists(atPath: result.spoolURL.path))
    #expect(
      try journalStates(fixture.snapshot, at: paths.journal) == [
        .reserved, .encoded, .spoolDurable, .putComplete, .headVerified, .rowRegistered, .done,
      ])
    let remote = await wire.snapshot()
    #expect(remote.events == ["presign", "head", "put", "head", "register"])
    #expect(remote.object == output)
    #expect(remote.registered)
    #expect(remote.piece?.gapBeforeMS == 27)
    #expect(remote.piece?.averageLevel == Double(100) / 32_767)
    #expect(remote.piece?.peakLevel == Double(300) / 32_767)

    let rerun = try await coordinator.advance(
      snapshot: fixture.snapshot,
      journalURL: paths.journal,
      manifestURL: paths.manifest,
      spoolDirectoryURL: fixture.directory,
      initialReservation: initial,
      expectedFitSegment: 3
    )
    #expect(rerun.state == .done)
    #expect(rerun.journalRecordsWritten == 0)
    #expect(await wire.snapshot() == remote)
  }

  @Test func deliveryRecoversAmbiguousPutByHeadWithoutUploadingTwice() async throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let initial = try coordinatorReservation()
    let output = deterministicBytes(count: 4_321)
    let paths = try prepareDurableDelivery(
      fixture: fixture,
      initial: initial,
      output: output
    )
    let wire = MockArchiveDeliveryWire(failPutAfterStoreOnce: true)
    let coordinator = ArchiveDeliveryCoordinator(wire: wire)

    do {
      _ = try await coordinator.advance(
        snapshot: fixture.snapshot,
        journalURL: paths.journal,
        manifestURL: paths.manifest,
        spoolDirectoryURL: fixture.directory,
        initialReservation: initial,
        expectedFitSegment: 3
      )
      Issue.record("expected ambiguous PUT failure")
    } catch {
      #expect(error as? ArchiveDeliveryCoordinatorError == .wireFailure(.put))
    }
    #expect(FileManager.default.fileExists(atPath: paths.spool.path))
    #expect(
      try journalStates(fixture.snapshot, at: paths.journal) == [
        .reserved, .encoded, .spoolDurable, .spoolDurable,
      ])

    let recovered = try await coordinator.advance(
      snapshot: fixture.snapshot,
      journalURL: paths.journal,
      manifestURL: paths.manifest,
      spoolDirectoryURL: fixture.directory,
      initialReservation: initial,
      expectedFitSegment: 3
    )
    #expect(recovered.state == .done)
    let remote = await wire.snapshot()
    #expect(remote.putCount == 1)
    #expect(remote.object == output)
    #expect(remote.registered)
  }

  @Test func deliveryRecoversAmbiguousRegistrationIdempotently() async throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let initial = try coordinatorReservation()
    let paths = try prepareDurableDelivery(
      fixture: fixture,
      initial: initial,
      output: deterministicBytes(count: 3_210)
    )
    let wire = MockArchiveDeliveryWire(failRegistrationAfterStoreOnce: true)
    let coordinator = ArchiveDeliveryCoordinator(wire: wire)

    do {
      _ = try await coordinator.advance(
        snapshot: fixture.snapshot,
        journalURL: paths.journal,
        manifestURL: paths.manifest,
        spoolDirectoryURL: fixture.directory,
        initialReservation: initial,
        expectedFitSegment: 3
      )
      Issue.record("expected ambiguous registration failure")
    } catch {
      #expect(error as? ArchiveDeliveryCoordinatorError == .wireFailure(.registration))
    }
    #expect(
      try journalStates(fixture.snapshot, at: paths.journal).suffix(2) == [
        .headVerified, .headVerified,
      ])

    let recovered = try await coordinator.advance(
      snapshot: fixture.snapshot,
      journalURL: paths.journal,
      manifestURL: paths.manifest,
      spoolDirectoryURL: fixture.directory,
      initialReservation: initial,
      expectedFitSegment: 3
    )
    #expect(recovered.state == .done)
    let remote = await wire.snapshot()
    #expect(remote.putCount == 1)
    #expect(remote.registrationCount == 1)
    #expect(remote.registered)
  }

  @Test func diskInventoryReopensAndDrainsDurableWorkAfterRestart() async throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let initial = try coordinatorReservation()
    let paths = try prepareDurableDelivery(
      fixture: fixture,
      initial: initial,
      output: deterministicBytes(count: 2_345)
    )
    fixture.snapshot.close()
    let tapeURL = fixture.directory.appendingPathComponent("primary.tape")
    let indexURL = fixture.directory.appendingPathComponent("primary.idx")
    let lane = ArchiveDeliveryDiskLane(
      journalURL: paths.journal,
      manifestURL: paths.manifest,
      spoolDirectoryURL: fixture.directory
    ) {
      try ArchiveLaneStore.openAuthenticatedSnapshot(
        tapeURL: tapeURL,
        indexURL: indexURL,
        rootKey: self.rootKey,
        context: self.context
      )
    }
    let wire = MockArchiveDeliveryWire()
    let firstProcess = ArchiveDeliverySweeper(
      inventory: ArchiveDeliveryDiskInventory(lanes: [lane], wire: wire),
      sleeper: SweepNeverSleeper()
    )

    let delivered = try await firstProcess.step()
    #expect(delivered.reservationID == initial.reservationID)
    #expect(FileManager.default.fileExists(atPath: paths.spool.path))

    let restartedInventory = ArchiveDeliveryDiskInventory(lanes: [lane], wire: wire)
    let restartedProcess = ArchiveDeliverySweeper(
      inventory: restartedInventory,
      sleeper: SweepNeverSleeper()
    )
    #expect(try await restartedProcess.step() == .idle)
    #expect(
      try await restartedInventory.scan().nextIndex(
        sessionID: initial.sessionID,
        laneID: initial.laneID,
        serverNextIndex: 0
      ) == 8)
    let remote = await wire.snapshot()
    #expect(remote.putCount == 1)
    #expect(remote.registrationCount == 1)
  }

  @Test func alreadyVerifiedRequiresLocalHeadWitness() async throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let initial = try coordinatorReservation()
    let paths = try prepareDurableDelivery(
      fixture: fixture,
      initial: initial,
      output: deterministicBytes(count: 2_101)
    )
    let wire = MockArchiveDeliveryWire(alreadyVerified: true)

    do {
      _ = try await ArchiveDeliveryCoordinator(wire: wire).advance(
        snapshot: fixture.snapshot,
        journalURL: paths.journal,
        manifestURL: paths.manifest,
        spoolDirectoryURL: fixture.directory,
        initialReservation: initial,
        expectedFitSegment: 3
      )
      Issue.record("expected unproven already-verified collision")
    } catch {
      #expect(
        error as? ArchiveDeliveryCoordinatorError
          == .unprovenAlreadyVerified(.spoolDurable))
    }
    #expect(
      try journalStates(fixture.snapshot, at: paths.journal).suffix(2) == [
        .spoolDurable, .spoolDurable,
      ])
    #expect(FileManager.default.fileExists(atPath: paths.spool.path))

    try appendJournal(
      ArchiveJournalTransition.make(
        from: initial,
        attemptID: attemptID,
        priorState: .spoolDurable,
        newState: .putComplete
      ),
      snapshot: fixture.snapshot,
      at: paths.journal
    )
    do {
      _ = try await ArchiveDeliveryCoordinator(wire: wire).advance(
        snapshot: fixture.snapshot,
        journalURL: paths.journal,
        manifestURL: paths.manifest,
        spoolDirectoryURL: fixture.directory,
        initialReservation: initial,
        expectedFitSegment: 3
      )
      Issue.record("expected unproven already-verified collision")
    } catch {
      #expect(
        error as? ArchiveDeliveryCoordinatorError
          == .unprovenAlreadyVerified(.putComplete))
    }

    try appendJournal(
      ArchiveJournalTransition.make(
        from: initial,
        attemptID: attemptID,
        priorState: .putComplete,
        newState: .headVerified
      ),
      snapshot: fixture.snapshot,
      at: paths.journal
    )
    let result = try await ArchiveDeliveryCoordinator(wire: wire).advance(
      snapshot: fixture.snapshot,
      journalURL: paths.journal,
      manifestURL: paths.manifest,
      spoolDirectoryURL: fixture.directory,
      initialReservation: initial,
      expectedFitSegment: 3
    )

    #expect(result.state == .done)
    #expect(result.alreadyVerified)
    #expect(result.journalRecordsWritten == 2)
    #expect(await wire.snapshot().events == ["presign", "presign", "presign"])
    #expect(FileManager.default.fileExists(atPath: paths.spool.path))
  }

  @Test func wrongRemoteSizeFailsClosedAndRetainsSpool() async throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let initial = try coordinatorReservation()
    let paths = try prepareDurableDelivery(
      fixture: fixture,
      initial: initial,
      output: deterministicBytes(count: 2_100)
    )
    let wire = MockArchiveDeliveryWire(existingObject: Data([0]))

    do {
      _ = try await ArchiveDeliveryCoordinator(wire: wire).advance(
        snapshot: fixture.snapshot,
        journalURL: paths.journal,
        manifestURL: paths.manifest,
        spoolDirectoryURL: fixture.directory,
        initialReservation: initial,
        expectedFitSegment: 3
      )
      Issue.record("expected remote size mismatch")
    } catch {
      #expect(
        error as? ArchiveDeliveryCoordinatorError
          == .remoteSizeMismatch(expected: 2_100, actual: 1))
    }
    let remote = await wire.snapshot()
    #expect(remote.putCount == 0)
    #expect(remote.registrationCount == 0)
    #expect(FileManager.default.fileExists(atPath: paths.spool.path))
    #expect(
      try journalStates(fixture.snapshot, at: paths.journal).suffix(2) == [
        .spoolDurable, .spoolDurable,
      ])
  }

  @Test func deliveryRecoversFromEveryDurableWireState() async throws {
    for target in [
      ArchiveJournalState.putComplete,
      ArchiveJournalState.headVerified,
      ArchiveJournalState.rowRegistered,
    ] {
      let fixture = try makeFixture()
      defer { fixture.remove() }
      let initial = try coordinatorReservation()
      let output = deterministicBytes(count: 1_500 + stateRank(target))
      let paths = try prepareDurableDelivery(
        fixture: fixture,
        initial: initial,
        output: output
      )
      var state = ArchiveJournalState.spoolDurable
      while state != target {
        let next: ArchiveJournalState =
          switch state {
          case .spoolDurable: .putComplete
          case .putComplete: .headVerified
          case .headVerified: .rowRegistered
          default: target
          }
        try appendJournal(
          ArchiveJournalTransition.make(
            from: initial,
            attemptID: attemptID,
            priorState: state,
            newState: next
          ),
          snapshot: fixture.snapshot,
          at: paths.journal
        )
        state = next
      }
      let wire = MockArchiveDeliveryWire(existingObject: output)

      let result = try await ArchiveDeliveryCoordinator(wire: wire).advance(
        snapshot: fixture.snapshot,
        journalURL: paths.journal,
        manifestURL: paths.manifest,
        spoolDirectoryURL: fixture.directory,
        initialReservation: initial,
        expectedFitSegment: 3
      )

      #expect(result.state == .done)
      #expect(FileManager.default.fileExists(atPath: paths.spool.path))
      let remote = await wire.snapshot()
      switch target {
      case .putComplete:
        #expect(remote.events == ["presign", "head", "register"])
      case .headVerified:
        #expect(remote.events == ["presign", "register"])
      case .rowRegistered:
        #expect(remote.events.isEmpty)
      default:
        Issue.record("unexpected recovery state")
      }
    }
  }

  @Test func missingPostPutLengthAndRegistrationKeyMismatchFailClosed() async throws {
    do {
      let fixture = try makeFixture()
      defer { fixture.remove() }
      let initial = try coordinatorReservation()
      let paths = try prepareDurableDelivery(
        fixture: fixture,
        initial: initial,
        output: deterministicBytes(count: 1_777)
      )
      let wire = MockArchiveDeliveryWire(omitContentLength: true)
      do {
        _ = try await ArchiveDeliveryCoordinator(wire: wire).advance(
          snapshot: fixture.snapshot,
          journalURL: paths.journal,
          manifestURL: paths.manifest,
          spoolDirectoryURL: fixture.directory,
          initialReservation: initial,
          expectedFitSegment: 3
        )
        Issue.record("expected missing Content-Length")
      } catch {
        #expect(error as? ArchiveDeliveryCoordinatorError == .remoteContentLengthMissing)
      }
      #expect(await wire.snapshot().registrationCount == 0)
      #expect(FileManager.default.fileExists(atPath: paths.spool.path))
    }

    do {
      let fixture = try makeFixture()
      defer { fixture.remove() }
      let initial = try coordinatorReservation()
      let paths = try prepareDurableDelivery(
        fixture: fixture,
        initial: initial,
        output: deterministicBytes(count: 1_778)
      )
      let wire = MockArchiveDeliveryWire(registrationKey: "bench/wrong.webm")
      do {
        _ = try await ArchiveDeliveryCoordinator(wire: wire).advance(
          snapshot: fixture.snapshot,
          journalURL: paths.journal,
          manifestURL: paths.manifest,
          spoolDirectoryURL: fixture.directory,
          initialReservation: initial,
          expectedFitSegment: 3
        )
        Issue.record("expected registration key mismatch")
      } catch {
        #expect(
          error as? ArchiveDeliveryCoordinatorError
            == .registrationKeyMismatch(
              expected: "bench/mock.webm",
              actual: "bench/wrong.webm"
            ))
      }
      #expect(FileManager.default.fileExists(atPath: paths.spool.path))
      #expect(
        try journalStates(fixture.snapshot, at: paths.journal).suffix(2) == [
          .headVerified, .headVerified,
        ])
    }
  }

  @Test func failedEncoderObservationRetriesWithANewAttempt() throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let initial = try coordinatorReservation()
    let paths = try prepareCoordinator(fixture: fixture, initial: initial)
    let failedAttempt = "48624f58-bc75-456d-9df5-c0121da299f2"
    let calls = EncoderCalls()
    let failed = ArchiveSpoolCoordinator(
      testEncoder: DeterministicSpoolEncoder(
        output: deterministicBytes(
          count: ArchiveEncryptedSpoolWriter.maximumBufferedByteCount + 1),
        calls: calls,
        fails: true
      ),
      encoderProvenanceID: "ffmpeg-n9.0.1-arm64-test"
    )
    #expect(throws: ArchiveSpoolCoordinatorError.encoderFailed("syntheticEncoderFailure")) {
      try failed.advance(
        snapshot: fixture.snapshot,
        journalURL: paths.journal,
        manifestURL: paths.manifest,
        spoolDirectoryURL: fixture.directory,
        initialReservation: initial,
        fitSegment: 4,
        freshAttemptID: failedAttempt
      )
    }
    #expect(calls.count == 1)
    #expect(
      !FileManager.default.fileExists(
        atPath: spoolURL(
          fixture.directory,
          reservationID: initial.reservationID,
          attemptID: failedAttempt
        ).path))
    let failedReplay = try replayReservation(fixture.snapshot, at: paths.journal, initial: initial)
    #expect(failedReplay.state == .reserved)
    #expect(failedReplay.attemptID == nil)
    #expect(try manifestCount(fixture.snapshot, at: paths.manifest) == 0)

    let successfulAttempt = "07f21409-2b3a-47c1-866e-c5b512996d06"
    let success = ArchiveSpoolCoordinator(
      testEncoder: DeterministicSpoolEncoder(
        output: deterministicBytes(count: 2_001),
        calls: calls
      ),
      encoderProvenanceID: "ffmpeg-n9.0.1-arm64-test"
    )
    let result = try success.advance(
      snapshot: fixture.snapshot,
      journalURL: paths.journal,
      manifestURL: paths.manifest,
      spoolDirectoryURL: fixture.directory,
      initialReservation: initial,
      fitSegment: 4,
      freshAttemptID: successfulAttempt
    )
    #expect(calls.count == 2)
    #expect(result.published.attemptID == successfulAttempt)
    #expect(
      try journalStates(fixture.snapshot, at: paths.journal) == [
        .reserved, .reserved, .encoded, .spoolDurable,
      ])
  }

  @Test func coordinatorRecoversManifestBeforeJournalWithoutReencoding() throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let initial = try coordinatorReservation()
    let paths = try prepareCoordinator(fixture: fixture, initial: initial)
    let writer = try ArchiveEncryptedSpoolWriter(
      snapshot: fixture.snapshot,
      directoryURL: fixture.directory,
      reservationID: initial.reservationID,
      attemptID: attemptID
    )
    let output = deterministicBytes(count: 3_003)
    try writer.append(output)
    let completed = try writer.finishEncoding()
    let reservedReplay = try replayReservation(
      fixture.snapshot, at: paths.journal, initial: initial)
    let publishedBeforeCrash = try ArchiveEncryptedSpoolPublisher.publish(
      snapshot: fixture.snapshot,
      directoryURL: fixture.directory,
      reservation: reservedReplay,
      expected: completed
    )
    let manifest = try makeManifest(initial: initial, completed: completed, fitSegment: 4)
    try appendManifest(manifest, snapshot: fixture.snapshot, at: paths.manifest)
    let calls = EncoderCalls()
    let coordinator = ArchiveSpoolCoordinator(
      testEncoder: DeterministicSpoolEncoder(output: Data([9]), calls: calls),
      encoderProvenanceID: "ffmpeg-n9.0.1-arm64-test"
    )

    let recovered = try coordinator.advance(
      snapshot: fixture.snapshot,
      journalURL: paths.journal,
      manifestURL: paths.manifest,
      spoolDirectoryURL: fixture.directory,
      initialReservation: initial,
      fitSegment: 4
    )
    #expect(calls.count == 0)
    #expect(recovered.published == publishedBeforeCrash)
    #expect(recovered.journalRecordsWritten == 2)
    #expect(!recovered.manifestWritten)
    #expect(
      try journalStates(fixture.snapshot, at: paths.journal) == [
        .reserved, .encoded, .spoolDurable,
      ])
  }

  @Test func encodedReservationWithMissingAttemptReencodesUnderNewAttempt() throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let initial = try coordinatorReservation()
    let paths = try prepareCoordinator(fixture: fixture, initial: initial)
    let missingAttempt = "49020b1d-ff1e-4494-9f06-b2d567d7b186"
    let replacementAttempt = "14d78c1f-1b05-48d5-876f-8cd0e42127c5"
    let encoded = try ArchiveJournalTransition.make(
      from: initial,
      attemptID: missingAttempt,
      priorState: .reserved,
      newState: .encoded
    )
    try appendJournal(encoded, snapshot: fixture.snapshot, at: paths.journal)
    let calls = EncoderCalls()
    let coordinator = ArchiveSpoolCoordinator(
      testEncoder: DeterministicSpoolEncoder(
        output: deterministicBytes(count: 1_337),
        calls: calls
      ),
      encoderProvenanceID: "ffmpeg-n9.0.1-arm64-test"
    )

    let result = try coordinator.advance(
      snapshot: fixture.snapshot,
      journalURL: paths.journal,
      manifestURL: paths.manifest,
      spoolDirectoryURL: fixture.directory,
      initialReservation: initial,
      fitSegment: 4,
      freshAttemptID: replacementAttempt
    )
    #expect(calls.count == 1)
    #expect(result.published.attemptID == replacementAttempt)
    #expect(result.journalRecordsWritten == 2)
    #expect(
      try journalStates(fixture.snapshot, at: paths.journal) == [
        .reserved, .encoded, .encoded, .spoolDurable,
      ])
  }

  @Test func incompleteEncryptedTailCannotBePublished() throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let initial = try coordinatorReservation()
    let paths = try prepareCoordinator(fixture: fixture, initial: initial)
    let writer = try ArchiveEncryptedSpoolWriter(
      snapshot: fixture.snapshot,
      directoryURL: fixture.directory,
      reservationID: initial.reservationID,
      attemptID: attemptID
    )
    try writer.append(Data([1, 2]))
    let completed = try writer.finishEncoding()
    let firstScan = try fixture.snapshot.inspectSpool(at: writer.temporaryURL)
    let appendStore = try fixture.snapshot.openSpoolStoreForAppend(at: writer.temporaryURL)
    _ = try appendStore.append(
      plaintext: Data([3, 4]),
      firstLogicalUnit: 2,
      logicalUnitCount: 2
    )
    appendStore.close()
    let handle = try FileHandle(forWritingTo: writer.temporaryURL)
    try handle.truncate(atOffset: firstScan.completeByteCount + 16)
    try handle.synchronize()
    try handle.close()
    let encoded = try ArchiveJournalTransition.make(
      from: initial,
      attemptID: attemptID,
      priorState: .reserved,
      newState: .encoded
    )
    try appendJournal(encoded, snapshot: fixture.snapshot, at: paths.journal)
    let replay = try replayReservation(fixture.snapshot, at: paths.journal, initial: initial)

    #expect(throws: ArchiveEncryptedSpoolError.incompleteSpoolRecord(16)) {
      try ArchiveEncryptedSpoolPublisher.publish(
        snapshot: fixture.snapshot,
        directoryURL: fixture.directory,
        reservation: replay,
        expected: completed
      )
    }
    #expect(!FileManager.default.fileExists(atPath: writer.finalURL.path))
  }

  @Test func manifestRejectsRecordAlignedSpoolTruncation() throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let initial = try initialReservation()
    let output = deterministicBytes(
      count: ArchiveEncryptedSpoolWriter.maximumBufferedByteCount + 31)
    let writer = try ArchiveEncryptedSpoolWriter(
      snapshot: fixture.snapshot,
      directoryURL: fixture.directory,
      reservationID: initial.reservationID,
      attemptID: attemptID
    )
    try writer.append(output)
    let completed = try writer.finishEncoding()
    let reserved = try #require(
      ArchiveJournalReplay.validate([initial])[initial.reservationID]
    )
    let published = try ArchiveEncryptedSpoolPublisher.publish(
      snapshot: fixture.snapshot,
      directoryURL: fixture.directory,
      reservation: reserved,
      expected: completed
    )
    let manifest = try makeManifest(initial: initial, completed: completed, fitSegment: 3)
    let completeScan = try fixture.snapshot.inspectSpool(at: published.url)
    let firstRecordEnd = try #require(completeScan.records.first?.encryptedEndOffset)
    let handle = try FileHandle(forWritingTo: published.url)
    try handle.truncate(atOffset: firstRecordEnd)
    try handle.synchronize()
    try handle.close()

    #expect(
      throws: ArchiveEncryptedSpoolError.encodedByteCountMismatch(
        expected: UInt64(output.count),
        actual: UInt64(ArchiveEncryptedSpoolWriter.maximumBufferedByteCount)
      )
    ) {
      try ArchiveEncryptedSpoolPublisher.publish(
        snapshot: fixture.snapshot,
        directoryURL: fixture.directory,
        reservation: reserved,
        manifest: manifest
      )
    }
  }

  @Test func manifestRebindsPreManifestEncodedAttemptAfterCrash() throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let initial = try coordinatorReservation()
    let paths = try prepareCoordinator(fixture: fixture, initial: initial)
    let oldAttempt = "8f3bb5e7-58ea-4d8c-8584-cf34ad802b0f"
    let newAttempt = "30a3e824-a6a8-44af-a1c3-46ec55b843cb"
    let encoded = try ArchiveJournalTransition.make(
      from: initial,
      attemptID: oldAttempt,
      priorState: .reserved,
      newState: .encoded
    )
    try appendJournal(encoded, snapshot: fixture.snapshot, at: paths.journal)
    let oldReplay = try replayReservation(fixture.snapshot, at: paths.journal, initial: initial)
    let writer = try ArchiveEncryptedSpoolWriter(
      snapshot: fixture.snapshot,
      directoryURL: fixture.directory,
      reservationID: initial.reservationID,
      attemptID: newAttempt
    )
    try writer.append(deterministicBytes(count: 2_345))
    let completed = try writer.finishEncoding()
    _ = try ArchiveEncryptedSpoolPublisher.publish(
      snapshot: fixture.snapshot,
      directoryURL: fixture.directory,
      reservation: oldReplay,
      expected: completed
    )
    let manifest = try makeManifest(initial: initial, completed: completed, fitSegment: 4)
    try appendManifest(manifest, snapshot: fixture.snapshot, at: paths.manifest)
    let calls = EncoderCalls()
    let coordinator = ArchiveSpoolCoordinator(
      testEncoder: DeterministicSpoolEncoder(output: Data([9]), calls: calls),
      encoderProvenanceID: "ffmpeg-n9.0.1-arm64-test"
    )

    let recovered = try coordinator.advance(
      snapshot: fixture.snapshot,
      journalURL: paths.journal,
      manifestURL: paths.manifest,
      spoolDirectoryURL: fixture.directory,
      initialReservation: initial,
      fitSegment: 4
    )
    #expect(calls.count == 0)
    #expect(recovered.published.attemptID == newAttempt)
    #expect(recovered.journalRecordsWritten == 2)
    #expect(!recovered.manifestWritten)
    #expect(
      try journalStates(fixture.snapshot, at: paths.journal) == [
        .reserved, .encoded, .encoded, .spoolDurable,
      ])
  }

  @Test func hungProcessIsKilledAfterDeadline() {
    let started = Date()
    #expect(throws: ArchiveFFmpegStreamingEncoderError.timedOut) {
      try FoundationArchiveStreamingProcess.run(
        executableURL: URL(fileURLWithPath: "/bin/sh"),
        arguments: ["-c", "trap '' TERM; while :; do :; done"],
        input: { _ in },
        output: { _ in },
        timeout: 0.05
      )
    }
    #expect(Date().timeIntervalSince(started) < 5)
  }

  @Test func nonfiniteEncoderDeadlineIsRejectedBeforeLaunch() throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let writer = try ArchiveEncryptedSpoolWriter(
      snapshot: fixture.snapshot,
      directoryURL: fixture.directory,
      reservationID: String(repeating: "a", count: 64),
      attemptID: attemptID
    )
    let encoder = ArchiveFFmpegStreamingEncoder(
      command: ArchiveFFmpegCommand(executableURL: URL(fileURLWithPath: "/bin/cat")),
      timeout: .infinity
    )
    #expect(throws: ArchiveFFmpegStreamingEncoderError.invalidTimeout) {
      try encoder.encode(
        snapshot: fixture.snapshot,
        sampleStart: 0,
        sampleEnd: 1,
        spoolWriter: writer
      )
    }
  }

  @Test func completeHeaderTornJournalTailRepairsBeforeRecovery() throws {
    let fixture = try makeFixture()
    defer { fixture.remove() }
    let initial = try coordinatorReservation()
    let paths = try prepareCoordinator(fixture: fixture, initial: initial)
    let firstRecordEnd = UInt64(try Data(contentsOf: paths.journal).count)
    let encoded = try ArchiveJournalTransition.make(
      from: initial,
      attemptID: attemptID,
      priorState: .reserved,
      newState: .encoded
    )
    try appendJournal(encoded, snapshot: fixture.snapshot, at: paths.journal)
    let handle = try FileHandle(forWritingTo: paths.journal)
    try handle.truncate(
      atOffset: firstRecordEnd + UInt64(ArchiveEnvelopeCodec.headerByteCount) + 5
    )
    try handle.synchronize()
    try handle.close()

    let repaired = try fixture.snapshot.openJournalStoreForAppend(at: paths.journal)
    #expect(repaired.scanResult.records.count == 1)
    #expect(repaired.scanResult.incompleteTrailingByteCount == 0)
    #expect(repaired.repairedTrailingByteCount == UInt64(ArchiveEnvelopeCodec.headerByteCount + 5))
    repaired.close()
    #expect(try Data(contentsOf: paths.journal).count == Int(firstRecordEnd))
  }

  private func makeFixture(initialObservation: ArchiveIndexObservation? = nil) throws
    -> SpoolFixture
  {
    let requestedDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent("archive-spool-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
      at: requestedDirectory, withIntermediateDirectories: false)
    guard let resolved = realpath(requestedDirectory.path, nil) else {
      throw ArchiveEncryptedSpoolError.invalidDirectory
    }
    defer { Darwin.free(resolved) }
    let directory = URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
    guard chmod(directory.path, mode_t(0o700)) == 0 else {
      throw ArchiveEncryptedSpoolError.invalidDirectory
    }
    let lane = try ArchiveLaneStore.openRecoveringForAppend(
      tapeURL: directory.appendingPathComponent("primary.tape"),
      indexURL: directory.appendingPathComponent("primary.idx"),
      rootKey: rootKey,
      context: context
    )
    if let initialObservation {
      _ = try lane.appendPCM(Data(repeating: 0, count: 200), observation: initialObservation)
    }
    let snapshot = try lane.authenticatedSnapshot()
    lane.close()
    return SpoolFixture(directory: directory, snapshot: snapshot)
  }

  private func initialReservation() throws -> ArchiveJournalPayload {
    try ArchiveJournalPayload(
      reservationID: String(repeating: "a", count: 64),
      roomID: context.roomID,
      sessionID: "bs_spool_test",
      laneID: context.laneID,
      istDate: context.istDate,
      chunkIndex: 7,
      sampleStart: 16_000,
      sampleEnd: 32_000,
      startMS: 1_000,
      endMS: 2_000,
      uncertainty: nil,
      averageLevelQ15: 100,
      peakLevelQ15: 300,
      attemptID: nil,
      priorState: nil,
      newState: .reserved,
      error: nil
    )
  }

  private func coordinatorReservation() throws -> ArchiveJournalPayload {
    let sessionID = "bs_spool_test"
    let reservationID = try ArchiveReservationIdentity.make(
      context: context,
      sessionID: sessionID,
      chunkIndex: 7,
      sampleStart: 0,
      sampleEnd: 100
    )
    return try ArchiveJournalPayload(
      reservationID: reservationID,
      roomID: context.roomID,
      sessionID: sessionID,
      laneID: context.laneID,
      istDate: context.istDate,
      chunkIndex: 7,
      sampleStart: 0,
      sampleEnd: 100,
      startMS: 1_000,
      endMS: 1_006,
      uncertainty: nil,
      averageLevelQ15: 100,
      peakLevelQ15: 300,
      attemptID: nil,
      priorState: nil,
      newState: .reserved,
      error: nil
    )
  }

  private func prepareCoordinator(
    fixture: SpoolFixture,
    initial: ArchiveJournalPayload
  ) throws -> (journal: URL, manifest: URL) {
    let journal = fixture.directory.appendingPathComponent("primary.jrn")
    let manifest = fixture.directory.appendingPathComponent("primary.manifest")
    let store = try fixture.snapshot.openJournalStoreForAppend(at: journal)
    _ = try store.append(
      plaintext: ArchiveJournalPayloadCodec.encode(initial),
      firstLogicalUnit: 0,
      logicalUnitCount: 1
    )
    store.close()
    return (journal, manifest)
  }

  private func prepareDurableDelivery(
    fixture: SpoolFixture,
    initial: ArchiveJournalPayload,
    output: Data
  ) throws -> (journal: URL, manifest: URL, spool: URL) {
    let paths = try prepareCoordinator(fixture: fixture, initial: initial)
    let durable = try ArchiveSpoolCoordinator(
      testEncoder: DeterministicSpoolEncoder(output: output, calls: EncoderCalls()),
      encoderProvenanceID: "ffmpeg-n9.0.1-arm64-test"
    ).advance(
      snapshot: fixture.snapshot,
      journalURL: paths.journal,
      manifestURL: paths.manifest,
      spoolDirectoryURL: fixture.directory,
      initialReservation: initial,
      fitSegment: 3,
      freshAttemptID: attemptID
    )
    return (paths.journal, paths.manifest, durable.published.url)
  }

  private func appendJournal(
    _ payload: ArchiveJournalPayload,
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    at url: URL
  ) throws {
    let store = try snapshot.openJournalStoreForAppend(at: url)
    defer { store.close() }
    let position = UInt64(store.scanResult.records.count)
    _ = try store.append(
      plaintext: ArchiveJournalPayloadCodec.encode(payload),
      firstLogicalUnit: position,
      logicalUnitCount: 1
    )
  }

  private func appendManifest(
    _ payload: ArchiveManifestPayload,
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    at url: URL
  ) throws {
    let store = try snapshot.openManifestStoreForAppend(at: url)
    defer { store.close() }
    let position = UInt64(store.scanResult.records.count)
    _ = try store.append(
      plaintext: ArchiveManifestPayloadCodec.encode(payload),
      firstLogicalUnit: position,
      logicalUnitCount: 1
    )
  }

  private func replayReservation(
    _ snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    at url: URL,
    initial: ArchiveJournalPayload
  ) throws -> ArchiveJournalReplayReservation {
    let store = try snapshot.openJournalStoreForAppend(at: url)
    defer { store.close() }
    let payloads = try store.scanResult.records.map {
      try ArchiveJournalPayloadCodec.decode($0.plaintext)
    }
    return try #require(ArchiveJournalReplay.validate(payloads)[initial.reservationID])
  }

  private func journalStates(
    _ snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    at url: URL
  ) throws -> [ArchiveJournalState] {
    let store = try snapshot.openJournalStoreForAppend(at: url)
    defer { store.close() }
    return try store.scanResult.records.map {
      try ArchiveJournalPayloadCodec.decode($0.plaintext).newState
    }
  }

  private func manifestCount(
    _ snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    at url: URL
  ) throws -> Int {
    let store = try snapshot.openManifestStoreForAppend(at: url)
    defer { store.close() }
    return store.scanResult.records.count
  }

  private func spoolURL(_ directory: URL, reservationID: String, attemptID: String) -> URL {
    directory.appendingPathComponent("\(reservationID).\(attemptID).spool")
  }

  private func makeManifest(
    initial: ArchiveJournalPayload,
    completed: ArchiveEncodedSpoolAttempt,
    fitSegment: UInt64
  ) throws -> ArchiveManifestPayload {
    try ArchiveManifestPayload(
      reservationID: initial.reservationID,
      attemptID: completed.attemptID,
      sampleStart: initial.sampleStart,
      sampleEnd: initial.sampleEnd,
      startMS: initial.startMS,
      endMS: initial.endMS,
      uncertainty: initial.uncertainty,
      fitSegment: fitSegment,
      averageLevelQ15: initial.averageLevelQ15,
      peakLevelQ15: initial.peakLevelQ15,
      mime: .audioWebM,
      encodedBytes: completed.encodedBytes,
      encodedSHA256: completed.encodedSHA256,
      encoderProvenanceID: "ffmpeg-n9.0.1-arm64-test"
    )
  }

  private func deterministicBytes(count: Int) -> Data {
    Data((0..<count).lazy.map { UInt8(truncatingIfNeeded: $0 &* 31) })
  }

  private func joinedPlaintext(_ scan: ArchiveDerivedScanResult) -> Data {
    scan.records.reduce(into: Data()) { $0.append($1.plaintext) }
  }

  private func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private func stateRank(_ state: ArchiveJournalState) -> Int {
    ArchiveJournalState.allCases.firstIndex(of: state) ?? 0
  }
}

private struct SpoolFixture {
  let directory: URL
  let snapshot: ArchiveLaneStore.AuthenticatedSnapshot

  func remove() {
    try? FileManager.default.removeItem(at: directory)
  }
}

private final class LockedData: @unchecked Sendable {
  private let lock = NSLock()
  private var storage = Data()

  var data: Data {
    lock.withLock { storage }
  }

  func append(_ data: Data) {
    lock.withLock { storage.append(data) }
  }
}

private enum SyntheticEncoderFailure: Error {
  case syntheticEncoderFailure
}

private final class EncoderCalls: @unchecked Sendable {
  private let lock = NSLock()
  private var storage = 0

  var count: Int {
    lock.withLock { storage }
  }

  func increment() {
    lock.withLock { storage += 1 }
  }
}

private struct DeterministicSpoolEncoder: ArchivePCMSpoolEncoding {
  let output: Data
  let calls: EncoderCalls
  var fails = false

  func encode(
    snapshot _: ArchiveLaneStore.AuthenticatedSnapshot,
    sampleStart _: UInt64,
    sampleEnd _: UInt64,
    spoolWriter: ArchiveEncryptedSpoolWriter
  ) throws -> ArchiveEncodedSpoolAttempt {
    calls.increment()
    try spoolWriter.append(output)
    if fails { throw SyntheticEncoderFailure.syntheticEncoderFailure }
    return try spoolWriter.finishEncoding()
  }
}

private struct MockArchiveDeliverySnapshot: Equatable, Sendable {
  let events: [String]
  let object: Data?
  let registered: Bool
  let putCount: Int
  let registrationCount: Int
  let piece: ArchiveDeliveryPiece?
}

private enum MockArchiveDeliveryError: Error {
  case ambiguousPut
  case ambiguousRegistration
}

private actor MockArchiveDeliveryWire: ArchiveDeliveryWire {
  private let putURL = URL(string: "https://r2.test/piece-put")!
  private let headURL = URL(string: "https://r2.test/piece-head")!
  private let alreadyVerified: Bool
  private let omitContentLength: Bool
  private let registrationKey: String
  private var failPutAfterStoreOnce: Bool
  private var failRegistrationAfterStoreOnce: Bool
  private var events: [String] = []
  private var object: Data?
  private var registered = false
  private var putCount = 0
  private var registrationCount = 0
  private var piece: ArchiveDeliveryPiece?

  init(
    alreadyVerified: Bool = false,
    existingObject: Data? = nil,
    failPutAfterStoreOnce: Bool = false,
    failRegistrationAfterStoreOnce: Bool = false,
    omitContentLength: Bool = false,
    registrationKey: String = "bench/mock.webm"
  ) {
    self.alreadyVerified = alreadyVerified
    object = existingObject
    self.failPutAfterStoreOnce = failPutAfterStoreOnce
    self.failRegistrationAfterStoreOnce = failRegistrationAfterStoreOnce
    self.omitContentLength = omitContentLength
    self.registrationKey = registrationKey
  }

  func prepareDelivery(for piece: ArchiveDeliveryPiece) async throws
    -> ArchiveDeliveryPresignResult
  {
    events.append("presign")
    self.piece = piece
    if alreadyVerified || registered { return .alreadyVerified }
    return .upload(putURL: putURL, headURL: headURL, key: "bench/mock.webm")
  }

  func probeDeliveryObject(at _: URL) async throws -> ArchiveDeliveryRemoteObject {
    events.append("head")
    guard let object else { return .missing }
    if omitContentLength { return .present(byteCount: nil) }
    return .present(byteCount: UInt64(object.count))
  }

  func putDeliveryObject(
    chunks: [Data],
    to _: URL,
    contentType: String
  ) async throws {
    events.append("put")
    putCount += 1
    #expect(contentType == "audio/webm")
    object = chunks.reduce(into: Data()) { $0.append($1) }
    if failPutAfterStoreOnce {
      failPutAfterStoreOnce = false
      throw MockArchiveDeliveryError.ambiguousPut
    }
  }

  func registerDelivery(_ piece: ArchiveDeliveryPiece) async throws
    -> ArchiveDeliveryRegistration
  {
    events.append("register")
    registrationCount += 1
    self.piece = piece
    registered = true
    if failRegistrationAfterStoreOnce {
      failRegistrationAfterStoreOnce = false
      throw MockArchiveDeliveryError.ambiguousRegistration
    }
    return ArchiveDeliveryRegistration(
      ok: true,
      key: registrationKey,
      uploadState: "verified"
    )
  }

  func snapshot() -> MockArchiveDeliverySnapshot {
    MockArchiveDeliverySnapshot(
      events: events,
      object: object,
      registered: registered,
      putCount: putCount,
      registrationCount: registrationCount,
      piece: piece
    )
  }
}

private struct SweepNeverSleeper: ArchiveDeliverySleeping {
  func sleep(seconds _: UInt64) async throws {
    Issue.record("unexpected delivery retry")
  }
}

extension ArchiveDeliverySweepOutcome {
  fileprivate var reservationID: String? {
    switch self {
    case .idle: nil
    case .delivered(let reservationID, _), .retryScheduled(let reservationID, _, _):
      reservationID
    }
  }
}
