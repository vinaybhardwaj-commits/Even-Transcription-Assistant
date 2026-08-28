import Darwin
import Foundation
import RoomRecorderCore
import TapeCore
import Testing

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
