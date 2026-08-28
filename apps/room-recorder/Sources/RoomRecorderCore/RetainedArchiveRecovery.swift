import Foundation
import TapeCore

public enum RoomRetainedArchiveRecoveryState: Equatable, Sendable {
  case pending
  case complete
  case failed(String)
}

public protocol RoomRetainedArchiveRecovering: Sendable {
  func run() async
  func state() async -> RoomRetainedArchiveRecoveryState
}

public enum RetainedArchiveRecoveryError: String, Error, LocalizedError, Sendable {
  case descriptorAuthenticationFailed = "archive_descriptor_authentication_failed"
  case unfinishedLocalReservation = "archive_unfinished_local_reservation"
  case recoveryDidNotConverge = "archive_recovery_did_not_converge"

  public var errorDescription: String? { rawValue }
}

public actor RetainedArchiveRecovery: RoomRetainedArchiveRecovering {
  private let catalog: ArchiveRetainedLaneCatalog
  private let wire: any ArchiveDeliveryWire
  private let keyLifecycle: ArchiveKeyLifecycle
  private var currentState: RoomRetainedArchiveRecoveryState = .pending
  private var started = false

  public init(
    rootURL: URL,
    wire: any ArchiveDeliveryWire,
    keyLifecycle: ArchiveKeyLifecycle = ArchiveKeyLifecycle()
  ) throws {
    catalog = try ArchiveRetainedLaneCatalog(rootURL: rootURL)
    self.wire = wire
    self.keyLifecycle = keyLifecycle
  }

  public func state() -> RoomRetainedArchiveRecoveryState { currentState }

  public func run() async {
    guard !started else { return }
    started = true
    do {
      let catalogSnapshot = try catalog.scanIncludingControls()
      for entry in catalogSnapshot.controls where entry.journalPresent {
        try Task.checkCancellation()
        let opened = try keyLifecycle.openExistingControlStoreWithInspection(
          keywrapURL: entry.layout.keywrapURL,
          journalURL: entry.layout.journalURL,
          context: entry.descriptor.context)
        guard opened.keywrap.authenticated,
          opened.keywrap.keywrapDigestHex == entry.descriptor.keywrapDigestHex
        else {
          opened.store.close()
          throw RetainedArchiveRecoveryError.descriptorAuthenticationFailed
        }
        opened.store.close()
      }

      var lanes: [ArchiveDeliveryDiskLane] = []
      for entry in catalogSnapshot.lanes {
        try Task.checkCancellation()
        let opened = try open(entry)
        opened.close()
        let lifecycle = keyLifecycle
        lanes.append(
          ArchiveDeliveryDiskLane(
            journalURL: entry.layout.journalURL,
            manifestURL: entry.layout.manifestURL,
            spoolDirectoryURL: entry.layout.spoolDirectoryURL
          ) {
            try Self.open(entry, keyLifecycle: lifecycle)
          }
        )
      }

      let inventory = ArchiveDeliveryDiskInventory(lanes: lanes, wire: wire)
      let initial = try await inventory.scan()
      guard initial.blockedReservations.isEmpty else {
        throw RetainedArchiveRecoveryError.unfinishedLocalReservation
      }
      try await ArchiveDeliverySweeper(inventory: inventory).drain()
      let final = try await inventory.scan()
      guard final.blockedReservations.isEmpty else {
        throw RetainedArchiveRecoveryError.unfinishedLocalReservation
      }
      guard final.candidates.isEmpty else {
        throw RetainedArchiveRecoveryError.recoveryDidNotConverge
      }
      currentState = .complete
    } catch is CancellationError {
      return
    } catch {
      currentState = .failed(Self.bounded(error))
    }
  }

  private func open(_ entry: ArchiveRetainedLaneCatalogEntry) throws
    -> ArchiveLaneStore.AuthenticatedSnapshot
  {
    try Self.open(entry, keyLifecycle: keyLifecycle)
  }

  private static func open(
    _ entry: ArchiveRetainedLaneCatalogEntry,
    keyLifecycle: ArchiveKeyLifecycle
  ) throws -> ArchiveLaneStore.AuthenticatedSnapshot {
    let descriptor = entry.descriptor
    let opened = try keyLifecycle.openExistingLaneSnapshotWithInspection(
      keywrapURL: entry.layout.keywrapURL,
      tapeURL: entry.layout.tapeURL,
      indexURL: entry.layout.indexURL,
      context: descriptor.context,
      initialSamplePosition: descriptor.initialSamplePosition
    )
    guard opened.keywrap.authenticated,
      opened.keywrap.keywrapDigestHex == descriptor.keywrapDigestHex
    else {
      opened.snapshot.close()
      throw RetainedArchiveRecoveryError.descriptorAuthenticationFailed
    }
    return opened.snapshot
  }

  private static func bounded(_ error: Error) -> String {
    let description = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    return String(description.prefix(200))
  }
}
