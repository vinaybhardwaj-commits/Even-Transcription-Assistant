import Foundation
import TapeCore

extension BenchClient: ArchiveDeliveryWire {
  public func prepareDelivery(for piece: ArchiveDeliveryPiece) async throws
    -> ArchiveDeliveryPresignResult
  {
    let response = try await presign(try benchPiece(piece))
    if response.alreadyVerified { return .alreadyVerified }
    guard let putURL = response.url, let headURL = response.headURL, let key = response.key,
      !key.isEmpty
    else {
      throw BenchClientError.invalidResponse(retention: .retainLocalPiece)
    }
    return .upload(putURL: putURL, headURL: headURL, key: key)
  }

  public func probeDeliveryObject(at url: URL) async throws -> ArchiveDeliveryRemoteObject {
    switch try await probeHead(url: url) {
    case .missing:
      return .missing
    case .present(let contentLength):
      guard let contentLength else { return .present(byteCount: nil) }
      guard contentLength >= 0 else {
        throw BenchClientError.invalidResponse(retention: .retainLocalPiece)
      }
      return .present(byteCount: UInt64(contentLength))
    }
  }

  public func putDeliveryObject(
    chunks: [Data],
    to url: URL,
    contentType: String
  ) async throws {
    var bytes = Data()
    bytes.reserveCapacity(chunks.reduce(0) { $0 + $1.count })
    for chunk in chunks { bytes.append(chunk) }
    try await put(bytes: bytes, to: url, contentType: contentType)
  }

  public func registerDelivery(_ piece: ArchiveDeliveryPiece) async throws
    -> ArchiveDeliveryRegistration
  {
    let response = try await register(try benchPiece(piece))
    return ArchiveDeliveryRegistration(
      ok: response.ok,
      key: response.key,
      uploadState: response.uploadState,
      endedDisagrees: response.endedDisagrees
    )
  }

  private func benchPiece(_ piece: ArchiveDeliveryPiece) throws -> BenchPiece {
    guard let index = Int(exactly: piece.index),
      let durationMS = Int(exactly: piece.durationMS),
      let sizeBytes = Int64(exactly: piece.sizeBytes),
      let gapBeforeMS = Int(exactly: piece.gapBeforeMS)
    else {
      throw BenchClientError.invalidResponse(retention: .retainLocalPiece)
    }
    let source: BenchPieceSource = piece.source == .primary ? .primary : .backup
    return BenchPiece(
      sessionID: piece.sessionID,
      index: index,
      contentType: piece.contentType,
      startedAt: Self.deliveryTimestamp(piece.startedAtMS),
      endedAt: Self.deliveryTimestamp(piece.endedAtMS),
      durationMS: durationMS,
      sizeBytes: sizeBytes,
      gapBeforeMS: gapBeforeMS,
      peakLevel: piece.peakLevel,
      averageLevel: piece.averageLevel,
      source: source
    )
  }

  private static func deliveryTimestamp(_ milliseconds: UInt64) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(
      from: Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1_000)
    )
  }
}
