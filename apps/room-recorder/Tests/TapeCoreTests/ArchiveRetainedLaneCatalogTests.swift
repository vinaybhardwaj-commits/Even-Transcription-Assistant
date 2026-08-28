import CryptoKit
import Darwin
import Foundation
import Testing

@testable import TapeCore

@Suite struct ArchiveRetainedLaneCatalogTests {
  private let streamUUID = Data([
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x46, 0x77,
    0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF,
  ])

  @Test func descriptorFreezesCanonicalNonsecretDiscoveryBytes() throws {
    let descriptor = try makeDescriptor()
    let encoded = try ArchiveRetainedLaneDescriptorCodec.encode(descriptor)
    let expected = Data(
      (#"{"format_version":1,"initial_sample_position":4800000,"ist_date":"2026-08-28","keywrap_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","lane_id":"primary","room_id":"room_1","stable_device_uid":"AppleUSBAudioEngine:test","stream_uuid_b64":"ABEiM0RVRneImaq7zN3u/w=="}"#)
        .utf8
    )

    #expect(encoded == expected)
    #expect(try ArchiveRetainedLaneDescriptorCodec.decode(encoded) == descriptor)
    #expect(!String(decoding: encoded, as: UTF8.self).contains("session"))
    #expect(throws: ArchiveRetainedLaneDescriptorError.self) {
      try ArchiveRetainedLaneDescriptorCodec.decode(encoded + Data([0x20]))
    }
  }

  @Test func controlDescriptorFreezesDayLevelCanonicalBytes() throws {
    let descriptor = try makeControlDescriptor()
    let encoded = try ArchiveRetainedControlDescriptorCodec.encode(descriptor)
    let expected = Data(
      (#"{"format_version":1,"ist_date":"2026-08-28","keywrap_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","lane_id":"_control","room_id":"room_1","stable_device_uid":"","stream_uuid_b64":"EBEiM0RVRneImaq7zN3u/w=="}"#)
        .utf8
    )

    #expect(encoded == expected)
    #expect(try ArchiveRetainedControlDescriptorCodec.decode(encoded) == descriptor)
    #expect(!String(decoding: encoded, as: UTF8.self).contains("initial_sample"))
  }

  @Test func layoutIsVersionedDeterministicAndLaneBound() throws {
    let descriptor = try makeDescriptor()
    let layout = try ArchiveRetainedLaneLayout(
      rootURL: URL(fileURLWithPath: "/var/private/room-recorder"),
      descriptor: descriptor
    )

    #expect(layout.directoryURL.path == "/var/private/room-recorder/archive-v1/2026-08-28/primary")
    #expect(layout.descriptorURL.lastPathComponent == "lane.json")
    #expect(layout.keywrapURL.lastPathComponent == "keywrap.eak")
    #expect(layout.tapeURL.lastPathComponent == "lane.tape")
    #expect(layout.indexURL.lastPathComponent == "lane.index")
    #expect(layout.journalURL.lastPathComponent == "lane.journal")
    #expect(layout.levelURL.lastPathComponent == "lane.level")
    #expect(layout.manifestURL.lastPathComponent == "lane.manifest")
    #expect(layout.spoolDirectoryURL.lastPathComponent == "spool")

    let control = try ArchiveRetainedControlLayout(
      rootURL: URL(fileURLWithPath: "/var/private/room-recorder"),
      descriptor: makeControlDescriptor()
    )
    #expect(
      control.directoryURL.path == "/var/private/room-recorder/archive-v1/2026-08-28/_control")
    #expect(control.descriptorURL.lastPathComponent == "control.json")
    #expect(control.keywrapURL.lastPathComponent == "keywrap.eak")
    #expect(control.journalURL.lastPathComponent == "control.journal")

    #expect(throws: ArchiveRetainedLaneDescriptorError.unsupportedLane("_control")) {
      try ArchiveRetainedLaneDescriptor(
        context: ArchiveContext(
          streamUUID: streamUUID,
          roomID: "room_1",
          istDate: "2026-08-28",
          laneID: "_control",
          stableDeviceUID: ""
        ),
        initialSamplePosition: 0,
        keywrapDigestHex: String(repeating: "a", count: 64)
      )
    }
  }

  @Test func scannerDiscoversOnlyCanonicalCompleteDescriptorLanes() throws {
    let temporary = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: temporary) }
    let laneContext = try makeDescriptor().context
    let laneKeywrap = try makeKeywrap(context: laneContext, wrappedByte: 0x01)
    let descriptor = try makeDescriptor(keywrapDigestHex: sha256(laneKeywrap))
    let layout = try ArchiveRetainedLaneLayout(rootURL: temporary, descriptor: descriptor)
    let controlContext = try makeControlDescriptor().context
    let controlKeywrap = try makeKeywrap(context: controlContext, wrappedByte: 0x02)
    let controlDescriptor = try makeControlDescriptor(keywrapDigestHex: sha256(controlKeywrap))
    let controlLayout = try ArchiveRetainedControlLayout(
      rootURL: temporary, descriptor: controlDescriptor)
    try makePrivateDirectory(layout.spoolDirectoryURL)
    try makePrivateDirectory(controlLayout.directoryURL)
    try writePrivate(laneKeywrap, to: layout.keywrapURL)
    for url in [layout.tapeURL, layout.indexURL] { try writePrivate(Data([0x01]), to: url) }
    try writePrivate(
      ArchiveRetainedLaneDescriptorCodec.encode(descriptor), to: layout.descriptorURL)
    try writePrivate(controlKeywrap, to: controlLayout.keywrapURL)
    try writePrivate(
      ArchiveRetainedControlDescriptorCodec.encode(controlDescriptor),
      to: controlLayout.descriptorURL)
    try writePrivate(Data([0x03]), to: controlLayout.journalURL)

    for url in [
      temporary, layout.directoryURL.deletingLastPathComponent().deletingLastPathComponent(),
      layout.directoryURL.deletingLastPathComponent(), layout.directoryURL,
      layout.spoolDirectoryURL, controlLayout.directoryURL,
    ] {
      var value = stat()
      #expect(lstat(url.path, &value) == 0)
      #expect(value.st_mode & mode_t(0o777) == mode_t(0o700))
    }

    let entries = try ArchiveRetainedLaneCatalog(rootURL: temporary).scan()

    #expect(entries == [ArchiveRetainedLaneCatalogEntry(descriptor: descriptor, layout: layout)])

    try writePrivate(Data([0x02]), to: controlLayout.keywrapURL)
    #expect(throws: ArchiveRetainedLaneCatalogError.keywrapMismatch) {
      try ArchiveRetainedLaneCatalog(rootURL: temporary).scan()
    }
    try writePrivate(controlKeywrap, to: controlLayout.keywrapURL)

    try writePrivate(Data([0x01]), to: layout.keywrapURL)
    #expect(throws: ArchiveRetainedLaneCatalogError.keywrapMismatch) {
      try ArchiveRetainedLaneCatalog(rootURL: temporary).scan()
    }
    try writePrivate(laneKeywrap, to: layout.keywrapURL)

    try writePrivate(
      ArchiveRetainedControlDescriptorCodec.encode(
        makeControlDescriptor(roomID: "room_other", keywrapDigestHex: sha256(controlKeywrap))),
      to: controlLayout.descriptorURL)
    #expect(throws: ArchiveRetainedLaneCatalogError.keywrapMismatch) {
      try ArchiveRetainedLaneCatalog(rootURL: temporary).scan()
    }
  }

  @Test func scannerRejectsOrphansAndDescriptorAliases() throws {
    let temporary = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: temporary) }
    let descriptor = try makeDescriptor()
    let layout = try ArchiveRetainedLaneLayout(rootURL: temporary, descriptor: descriptor)
    try makePrivateDirectory(layout.spoolDirectoryURL)
    for url in [layout.keywrapURL, layout.tapeURL, layout.indexURL] {
      try writePrivate(Data([0x01]), to: url)
    }
    let catalog = try ArchiveRetainedLaneCatalog(rootURL: temporary)
    #expect(throws: ArchiveRetainedLaneCatalogError.missingDescriptor) {
      try catalog.scan()
    }

    let outside = temporary.appendingPathComponent("outside.json")
    try writePrivate(ArchiveRetainedLaneDescriptorCodec.encode(descriptor), to: outside)
    try FileManager.default.createSymbolicLink(
      at: layout.descriptorURL, withDestinationURL: outside)
    #expect(throws: ArchiveRetainedLaneCatalogError.insecureArtifact) {
      try catalog.scan()
    }
  }

  private func makeDescriptor(
    keywrapDigestHex: String = String(repeating: "a", count: 64)
  ) throws -> ArchiveRetainedLaneDescriptor {
    try ArchiveRetainedLaneDescriptor(
      context: ArchiveContext(
        streamUUID: streamUUID,
        roomID: "room_1",
        istDate: "2026-08-28",
        laneID: "primary",
        stableDeviceUID: "AppleUSBAudioEngine:test"
      ),
      initialSamplePosition: 4_800_000,
      keywrapDigestHex: keywrapDigestHex
    )
  }

  private func makeControlDescriptor(
    roomID: String = "room_1",
    keywrapDigestHex: String = String(repeating: "b", count: 64)
  ) throws
    -> ArchiveRetainedControlDescriptor
  {
    var controlStreamUUID = streamUUID
    controlStreamUUID[0] = 0x10
    return try ArchiveRetainedControlDescriptor(
      context: ArchiveContext(
        streamUUID: controlStreamUUID,
        roomID: roomID,
        istDate: "2026-08-28",
        laneID: "_control",
        stableDeviceUID: ""
      ),
      keywrapDigestHex: keywrapDigestHex
    )
  }

  private func makeKeywrap(context: ArchiveContext, wrappedByte: UInt8) throws -> Data {
    try ArchiveKeywrapCodec.encode(
      ArchiveKeywrapOuter(
        streamUUID: context.streamUUID,
        contextHash: context.sha256(),
        publicKeyHash: Data(repeating: 0x03, count: 32),
        wrappedData: Data([wrappedByte])))
  }

  private func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private func makeTemporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(
      "archive-catalog-\(UUID().uuidString)", isDirectory: true)
    try makePrivateDirectory(url)
    guard let resolved = realpath(url.path, nil) else { throw CocoaError(.fileNoSuchFile) }
    defer { Darwin.free(resolved) }
    return URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
  }

  private func makePrivateDirectory(_ url: URL) throws {
    try FileManager.default.createDirectory(
      at: url,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: NSNumber(value: 0o700)]
    )
    guard let temporaryResolved = realpath(FileManager.default.temporaryDirectory.path, nil) else {
      throw CocoaError(.fileNoSuchFile)
    }
    defer { Darwin.free(temporaryResolved) }
    let temporaryPath = String(cString: temporaryResolved)
    var current = url
    while current.path != temporaryPath,
      current.path.hasPrefix(temporaryPath)
    {
      _ = chmod(current.path, mode_t(0o700))
      current.deleteLastPathComponent()
    }
  }

  private func writePrivate(_ data: Data, to url: URL) throws {
    try data.write(to: url)
    guard chmod(url.path, mode_t(0o600)) == 0 else {
      throw CocoaError(.fileWriteNoPermission)
    }
  }
}
