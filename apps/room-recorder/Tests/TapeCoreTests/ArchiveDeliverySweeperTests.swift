import Foundation
import Testing

@testable import TapeCore

@Suite struct ArchiveDeliverySweeperTests {
  @Test func scansAgainAndDeliversOldestReservationFirst() async throws {
    let older = try reservation(seed: "a", index: 3, startMS: 100, sampleStart: 0)
    let newer = try reservation(seed: "b", index: 4, startMS: 200, sampleStart: 100)
    let inventory = SweepInventory(reservations: [newer, older])
    let sleeper = SweepSleeper()
    let sweeper = ArchiveDeliverySweeper(inventory: inventory, sleeper: sleeper)

    let first = try await sweeper.step()
    let second = try await sweeper.step()
    let third = try await sweeper.step()

    #expect(first.reservationID == older.reservationID)
    #expect(second.reservationID == newer.reservationID)
    #expect(third == .idle)
    #expect(await inventory.attempts() == [older.reservationID, newer.reservationID])
    #expect(await inventory.scanCount() == 3)
    #expect(await sleeper.delays().isEmpty)
  }

  @Test func retriesTheOldestFromInventoryWithBoundedBackoffAndResetsAfterSuccess()
    async throws
  {
    let older = try reservation(seed: "a", index: 3, startMS: 100, sampleStart: 0)
    let newer = try reservation(seed: "b", index: 4, startMS: 200, sampleStart: 100)
    let inventory = SweepInventory(
      reservations: [newer, older],
      failures: [older.reservationID: 6, newer.reservationID: 1]
    )
    let sleeper = SweepSleeper()
    let sweeper = ArchiveDeliverySweeper(inventory: inventory, sleeper: sleeper)

    for expectedDelay in [5, 10, 20, 40, 60, 60] as [UInt64] {
      let outcome = try await sweeper.step()
      #expect(outcome.retryDelay == expectedDelay)
      #expect(outcome.reservationID == older.reservationID)
    }
    #expect(try await sweeper.step().reservationID == older.reservationID)
    #expect(try await sweeper.step().retryDelay == 5)
    #expect(try await sweeper.step().reservationID == newer.reservationID)
    #expect(try await sweeper.step() == .idle)
    #expect(await sleeper.delays() == [5, 10, 20, 40, 60, 60, 5])
  }

  @Test func localCollisionAndUnprovenVerificationStopWithoutSleeping() async throws {
    let first = try reservation(seed: "a", index: 3, startMS: 100, sampleStart: 0)
    let duplicate = try reservation(seed: "b", index: 3, startMS: 200, sampleStart: 100)
    let sleeper = SweepSleeper()
    let collisionSweeper = ArchiveDeliverySweeper(
      inventory: SweepInventory(reservations: [first, duplicate]),
      sleeper: sleeper
    )
    do {
      _ = try await collisionSweeper.step()
      Issue.record("expected local index collision")
    } catch {
      #expect(error is ArchiveReservationIndexError)
    }

    let unprovenInventory = SweepInventory(
      reservations: [first],
      terminalErrors: [first.reservationID: .unprovenAlreadyVerified(.spoolDurable)]
    )
    let unprovenSweeper = ArchiveDeliverySweeper(
      inventory: unprovenInventory,
      sleeper: sleeper
    )
    do {
      _ = try await unprovenSweeper.step()
      Issue.record("expected unproven already-verified failure")
    } catch {
      #expect(
        error as? ArchiveDeliveryCoordinatorError
          == .unprovenAlreadyVerified(.spoolDurable))
    }
    #expect(await sleeper.delays().isEmpty)
  }

  @Test func concurrentStepsAreRejectedWhileTheFirstScanIsSuspended() async throws {
    let inventory = SuspendedSweepInventory()
    let sweeper = ArchiveDeliverySweeper(inventory: inventory, sleeper: SweepSleeper())
    let first = Task { try await sweeper.step() }
    await inventory.waitUntilScanning()

    do {
      _ = try await sweeper.step()
      Issue.record("expected single-flight rejection")
    } catch {
      #expect(error as? ArchiveDeliverySweeperError == .alreadyRunning)
    }
    await inventory.resumeScan()
    #expect(try await first.value == .idle)
  }

  private func reservation(
    seed: Character,
    index: UInt32,
    startMS: UInt64,
    sampleStart: UInt64
  ) throws -> ArchiveJournalPayload {
    try ArchiveJournalPayload(
      reservationID: String(repeating: seed, count: 64),
      roomID: "room_sweep",
      sessionID: "bs_sweep",
      laneID: "primary",
      istDate: "2026-08-28",
      chunkIndex: index,
      sampleStart: sampleStart,
      sampleEnd: sampleStart + 100,
      startMS: startMS,
      endMS: startMS + 6,
      uncertainty: nil,
      averageLevelQ15: 100,
      peakLevelQ15: 300,
      attemptID: nil,
      priorState: nil,
      newState: .reserved,
      error: nil
    )
  }
}

private actor SweepInventory: ArchiveDeliveryInventory {
  private let reservations: [ArchiveJournalPayload]
  private var pending: Set<String>
  private var failures: [String: Int]
  private let terminalErrors: [String: ArchiveDeliveryCoordinatorError]
  private var attempted: [String] = []
  private var scans = 0

  init(
    reservations: [ArchiveJournalPayload],
    failures: [String: Int] = [:],
    terminalErrors: [String: ArchiveDeliveryCoordinatorError] = [:]
  ) {
    self.reservations = reservations
    pending = Set(reservations.map(\.reservationID))
    self.failures = failures
    self.terminalErrors = terminalErrors
  }

  func scan() async throws -> ArchiveDeliveryInventorySnapshot {
    scans += 1
    return ArchiveDeliveryInventorySnapshot(
      localReservations: reservations,
      candidates: reservations.reversed().compactMap { reservation in
        guard pending.contains(reservation.reservationID) else { return nil }
        return ArchiveDeliveryCandidate(initialReservation: reservation) {
          try await self.advance(reservation)
        }
      }
    )
  }

  func attempts() -> [String] {
    attempted
  }

  func scanCount() -> Int {
    scans
  }

  private func advance(_ reservation: ArchiveJournalPayload) throws -> ArchiveDeliveryResult {
    attempted.append(reservation.reservationID)
    if let error = terminalErrors[reservation.reservationID] { throw error }
    let remaining = failures[reservation.reservationID, default: 0]
    if remaining > 0 {
      failures[reservation.reservationID] = remaining - 1
      throw ArchiveDeliveryCoordinatorError.wireFailure(.put)
    }
    pending.remove(reservation.reservationID)
    return ArchiveDeliveryResult(
      state: .done,
      journalRecordsWritten: 1,
      uploaded: true,
      alreadyVerified: false,
      spoolURL: URL(fileURLWithPath: "/retained/\(reservation.reservationID).spool"),
      endedDisagrees: nil
    )
  }
}

private actor SweepSleeper: ArchiveDeliverySleeping {
  private var slept: [UInt64] = []

  func sleep(seconds: UInt64) async throws {
    slept.append(seconds)
  }

  func delays() -> [UInt64] {
    slept
  }
}

private actor SuspendedSweepInventory: ArchiveDeliveryInventory {
  private var scanning = false
  private var scanWaiters: [CheckedContinuation<Void, Never>] = []
  private var scanContinuation: CheckedContinuation<Void, Never>?

  func scan() async throws -> ArchiveDeliveryInventorySnapshot {
    scanning = true
    for waiter in scanWaiters { waiter.resume() }
    scanWaiters.removeAll()
    await withCheckedContinuation { scanContinuation = $0 }
    return ArchiveDeliveryInventorySnapshot(localReservations: [], candidates: [])
  }

  func waitUntilScanning() async {
    if scanning { return }
    await withCheckedContinuation { scanWaiters.append($0) }
  }

  func resumeScan() {
    scanContinuation?.resume()
    scanContinuation = nil
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

  fileprivate var retryDelay: UInt64? {
    guard case .retryScheduled(_, let delay, _) = self else { return nil }
    return delay
  }
}
