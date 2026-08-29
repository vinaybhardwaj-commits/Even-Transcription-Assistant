import Foundation

public struct ArchiveLocalDeliveryPipelineResult: Sendable {
  public let derivation: ArchiveLocalDerivationResult
  public let reservations: [ArchiveJournalReplayReservation]
  public let deliveredReservationIDs: [String]
  public let endedDisagrees: String?

  public init(
    derivation: ArchiveLocalDerivationResult,
    reservations: [ArchiveJournalReplayReservation],
    deliveredReservationIDs: [String],
    endedDisagrees: String? = nil
  ) {
    self.derivation = derivation
    self.reservations = reservations
    self.deliveredReservationIDs = deliveredReservationIDs
    self.endedDisagrees = endedDisagrees
  }
}

public struct ArchiveLocalDeliveryPipeline: Sendable {
  private let spoolCoordinator: ArchiveSpoolCoordinator
  private let deliveryCoordinator: ArchiveDeliveryCoordinator

  public init(
    spoolCoordinator: ArchiveSpoolCoordinator,
    wire: any ArchiveDeliveryWire
  ) {
    self.spoolCoordinator = spoolCoordinator
    deliveryCoordinator = ArchiveDeliveryCoordinator(wire: wire)
  }

  /// Reserves deterministic authenticated ranges before encoding, then advances each immutable range
  /// through durable encrypted spooling and server-verified registration in sample order.
  public func advance(
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    layout: ArchiveRetainedLaneLayout,
    sessionID: String,
    finalFlush: Bool,
    startingChunkIndex: UInt64,
    reservationsDidBecomeDurable:
      (@Sendable ([ArchiveJournalPayload]) throws -> Void)? = nil
  ) async throws -> ArchiveLocalDeliveryPipelineResult {
    let derivation = try ArchiveLocalDeriver.derive(
      snapshot: snapshot,
      journalURL: layout.journalURL,
      levelURL: layout.levelURL,
      sessionID: sessionID,
      finalFlush: finalFlush,
      startingChunkIndex: startingChunkIndex)
    try reservationsDidBecomeDurable?(derivation.reservations)
    var replay = try currentReservations(snapshot: snapshot, journalURL: layout.journalURL)
    var deliveredReservationIDs: [String] = []
    var endedDisagrees: String?
    for piece in derivation.reservedPieces.sorted(by: {
      if $0.reservation.sampleStart != $1.reservation.sampleStart {
        return $0.reservation.sampleStart < $1.reservation.sampleStart
      }
      return $0.reservation.chunkIndex < $1.reservation.chunkIndex
    }) {
      if replay[piece.reservation.reservationID]?.state == .done { continue }
      _ = try spoolCoordinator.advance(
        snapshot: snapshot,
        journalURL: layout.journalURL,
        manifestURL: layout.manifestURL,
        spoolDirectoryURL: layout.spoolDirectoryURL,
        initialReservation: piece.reservation,
        fitSegment: piece.fitSegment)
      let delivered = try await deliveryCoordinator.advance(
        snapshot: snapshot,
        journalURL: layout.journalURL,
        manifestURL: layout.manifestURL,
        spoolDirectoryURL: layout.spoolDirectoryURL,
        initialReservation: piece.reservation,
        expectedFitSegment: piece.fitSegment)
      guard delivered.state == .done else {
        throw ArchiveFinalRangeCoverageError.reservationNotDone(
          reservationID: piece.reservation.reservationID,
          state: delivered.state)
      }
      endedDisagrees = endedDisagrees ?? delivered.endedDisagrees
      deliveredReservationIDs.append(piece.reservation.reservationID)
      replay = try currentReservations(snapshot: snapshot, journalURL: layout.journalURL)
    }
    if endedDisagrees == nil,
      replay.values.contains(where: {
        $0.initialReservation.sessionID == sessionID && $0.serverEndedObserved
      })
    {
      endedDisagrees = "server_ended"
    }
    return ArchiveLocalDeliveryPipelineResult(
      derivation: derivation,
      reservations: replay.values.sorted(by: {
        let left = $0.initialReservation
        let right = $1.initialReservation
        if left.sampleStart != right.sampleStart { return left.sampleStart < right.sampleStart }
        if left.sampleEnd != right.sampleEnd { return left.sampleEnd < right.sampleEnd }
        return left.chunkIndex < right.chunkIndex
      }),
      deliveredReservationIDs: deliveredReservationIDs,
      endedDisagrees: endedDisagrees)
  }

  private func currentReservations(
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    journalURL: URL
  ) throws -> [String: ArchiveJournalReplayReservation] {
    guard FileManager.default.fileExists(atPath: journalURL.path) else { return [:] }
    let journal = try snapshot.openJournalStoreForAppend(at: journalURL)
    defer { journal.close() }
    return try ArchiveJournalReplay.validate(
      journal.scanResult.records.map {
        try ArchiveJournalPayloadCodec.decode($0.plaintext)
      })
  }
}
