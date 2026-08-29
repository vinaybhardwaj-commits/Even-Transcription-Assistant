import CryptoKit
import Darwin
import Foundation

public enum ArchiveRolloverStagedStreamKind: String, Sendable {
  case primary
  case control
}

enum ArchiveRetainedLaneCatalogPublicationPoint: Sendable {
  case renamedControl
  case renamedLane
}

struct ArchiveRetainedLaneCatalogHooks: Sendable {
  var didRename: @Sendable (ArchiveRetainedLaneCatalogPublicationPoint) throws -> Void = { _ in }
  var synchronizeDirectory: @Sendable (Int32) -> Bool = { descriptor in
    var result: Int32
    repeat { result = fsync(descriptor) } while result != 0 && errno == EINTR
    return result == 0
  }
}

public enum ArchiveRetainedLaneDescriptorError: Error, Equatable, Sendable {
  case unsupportedFormatVersion(UInt64)
  case unsupportedLane(String)
  case invalidStreamUUID
  case invalidKeywrapDigest
  case invalidSyntax(offset: Int)
  case payloadTooLarge(Int)
}

public struct ArchiveRetainedLaneDescriptor: Equatable, Sendable {
  public static let formatVersion: UInt64 = 1
  public static let maximumEncodedByteCount = 4_096

  public let context: ArchiveContext
  public let initialSamplePosition: UInt64
  public let keywrapDigestHex: String

  public init(
    context: ArchiveContext,
    initialSamplePosition: UInt64,
    keywrapDigestHex: String
  ) throws {
    guard context.laneID == "primary" || context.laneID == "backup" else {
      throw ArchiveRetainedLaneDescriptorError.unsupportedLane(context.laneID)
    }
    guard context.streamUUID.count == 16, context.streamUUID[6] >> 4 == 4,
      context.streamUUID[8] >> 6 == 2
    else {
      throw ArchiveRetainedLaneDescriptorError.invalidStreamUUID
    }
    guard keywrapDigestHex.utf8.count == 64,
      keywrapDigestHex.utf8.allSatisfy({
        (0x30...0x39).contains($0) || (0x61...0x66).contains($0)
      })
    else {
      throw ArchiveRetainedLaneDescriptorError.invalidKeywrapDigest
    }
    _ = try context.encodedBytes()
    _ = try ArchiveISTDay(context.istDate)
    self.context = context
    self.initialSamplePosition = initialSamplePosition
    self.keywrapDigestHex = keywrapDigestHex
    try ArchiveRetainedLaneDescriptorCodec.validateEncodedSize(self)
  }

  public init(identity: ArchiveDailyLaneIdentity) throws {
    try self.init(
      context: identity.context,
      initialSamplePosition: identity.expectedInitialSessionSample,
      keywrapDigestHex: identity.keywrapDigestHex
    )
  }
}

public enum ArchiveRetainedLaneDescriptorCodec {
  public static func encode(_ descriptor: ArchiveRetainedLaneDescriptor) throws -> Data {
    var result = Data()
    result.append(contentsOf: "{\"format_version\":".utf8)
    ArchiveCanonicalJSON.appendInteger(ArchiveRetainedLaneDescriptor.formatVersion, to: &result)
    result.append(contentsOf: ",\"initial_sample_position\":".utf8)
    ArchiveCanonicalJSON.appendInteger(descriptor.initialSamplePosition, to: &result)
    result.append(contentsOf: ",\"ist_date\":".utf8)
    ArchiveCanonicalJSON.appendString(descriptor.context.istDate, to: &result)
    result.append(contentsOf: ",\"keywrap_sha256\":".utf8)
    ArchiveCanonicalJSON.appendString(descriptor.keywrapDigestHex, to: &result)
    result.append(contentsOf: ",\"lane_id\":".utf8)
    ArchiveCanonicalJSON.appendString(descriptor.context.laneID, to: &result)
    result.append(contentsOf: ",\"room_id\":".utf8)
    ArchiveCanonicalJSON.appendString(descriptor.context.roomID, to: &result)
    result.append(contentsOf: ",\"stable_device_uid\":".utf8)
    ArchiveCanonicalJSON.appendString(descriptor.context.stableDeviceUID, to: &result)
    result.append(contentsOf: ",\"stream_uuid_b64\":".utf8)
    ArchiveCanonicalJSON.appendString(
      descriptor.context.streamUUID.base64EncodedString(),
      to: &result
    )
    result.append(0x7D)
    guard result.count <= ArchiveRetainedLaneDescriptor.maximumEncodedByteCount else {
      throw ArchiveRetainedLaneDescriptorError.payloadTooLarge(result.count)
    }
    return result
  }

  public static func decode(_ data: Data) throws -> ArchiveRetainedLaneDescriptor {
    guard data.count <= ArchiveRetainedLaneDescriptor.maximumEncodedByteCount else {
      throw ArchiveRetainedLaneDescriptorError.payloadTooLarge(data.count)
    }
    var parser = ArchiveCanonicalJSONParser(data)
    do {
      try parser.expect("{\"format_version\":")
      let formatVersion = try parser.integer(field: "format_version")
      guard formatVersion == ArchiveRetainedLaneDescriptor.formatVersion else {
        throw ArchiveRetainedLaneDescriptorError.unsupportedFormatVersion(formatVersion)
      }
      try parser.expect(",\"initial_sample_position\":")
      let initialSamplePosition = try parser.integer(field: "initial_sample_position")
      try parser.expect(",\"ist_date\":")
      let istDate = try parser.string()
      try parser.expect(",\"keywrap_sha256\":")
      let keywrapDigestHex = try parser.string()
      try parser.expect(",\"lane_id\":")
      let laneID = try parser.string()
      try parser.expect(",\"room_id\":")
      let roomID = try parser.string()
      try parser.expect(",\"stable_device_uid\":")
      let stableDeviceUID = try parser.string()
      try parser.expect(",\"stream_uuid_b64\":")
      let streamUUIDBase64 = try parser.string()
      try parser.expect("}")
      try parser.expectEnd()
      guard let streamUUID = Data(base64Encoded: streamUUIDBase64),
        streamUUID.base64EncodedString() == streamUUIDBase64
      else {
        throw ArchiveRetainedLaneDescriptorError.invalidStreamUUID
      }
      let descriptor = try ArchiveRetainedLaneDescriptor(
        context: ArchiveContext(
          streamUUID: streamUUID,
          roomID: roomID,
          istDate: istDate,
          laneID: laneID,
          stableDeviceUID: stableDeviceUID
        ),
        initialSamplePosition: initialSamplePosition,
        keywrapDigestHex: keywrapDigestHex
      )
      guard try encode(descriptor) == data else {
        throw ArchiveRetainedLaneDescriptorError.invalidSyntax(offset: 0)
      }
      return descriptor
    } catch ArchiveCanonicalJSONError.invalidSyntax(let offset) {
      throw ArchiveRetainedLaneDescriptorError.invalidSyntax(offset: offset)
    } catch ArchiveCanonicalJSONError.integerOverflow {
      throw ArchiveRetainedLaneDescriptorError.invalidSyntax(offset: 0)
    }
  }

  fileprivate static func validateEncodedSize(
    _ descriptor: ArchiveRetainedLaneDescriptor
  ) throws {
    _ = try encode(descriptor)
  }
}

public struct ArchiveRetainedLaneLayout: Equatable, Sendable {
  public static let archiveDirectoryName = "archive-v1"
  public static let descriptorFileName = "lane.json"

  public let rootURL: URL
  public let directoryURL: URL
  public let descriptorURL: URL
  public let keywrapURL: URL
  public let tapeURL: URL
  public let indexURL: URL
  public let journalURL: URL
  public let levelURL: URL
  public let manifestURL: URL
  public let spoolDirectoryURL: URL

  public init(rootURL: URL, descriptor: ArchiveRetainedLaneDescriptor) throws {
    try self.init(rootURL: rootURL, context: descriptor.context)
  }

  public init(rootURL: URL, context: ArchiveContext) throws {
    guard rootURL.isFileURL, rootURL.path.hasPrefix("/") else {
      throw ArchiveRetainedLaneDescriptorError.invalidSyntax(offset: 0)
    }
    guard context.laneID == "primary" || context.laneID == "backup" else {
      throw ArchiveRetainedLaneDescriptorError.unsupportedLane(context.laneID)
    }
    _ = try context.encodedBytes()
    let root = rootURL
    let directory =
      root
      .appendingPathComponent(Self.archiveDirectoryName, isDirectory: true)
      .appendingPathComponent(context.istDate, isDirectory: true)
      .appendingPathComponent(context.laneID, isDirectory: true)
    self.rootURL = root
    directoryURL = directory
    descriptorURL = directory.appendingPathComponent(Self.descriptorFileName)
    keywrapURL = directory.appendingPathComponent("keywrap.eak")
    tapeURL = directory.appendingPathComponent("lane.tape")
    indexURL = directory.appendingPathComponent("lane.index")
    journalURL = directory.appendingPathComponent("lane.journal")
    levelURL = directory.appendingPathComponent("lane.level")
    manifestURL = directory.appendingPathComponent("lane.manifest")
    spoolDirectoryURL = directory.appendingPathComponent("spool", isDirectory: true)
  }
}

public struct ArchiveRetainedControlDescriptor: Equatable, Sendable {
  public static let formatVersion: UInt64 = 1
  public static let maximumEncodedByteCount = 4_096

  public let context: ArchiveContext
  public let keywrapDigestHex: String

  public init(context: ArchiveContext, keywrapDigestHex: String) throws {
    guard context.laneID == "_control", context.stableDeviceUID.isEmpty else {
      throw ArchiveRetainedLaneDescriptorError.unsupportedLane(context.laneID)
    }
    guard context.streamUUID.count == 16, context.streamUUID[6] >> 4 == 4,
      context.streamUUID[8] >> 6 == 2
    else {
      throw ArchiveRetainedLaneDescriptorError.invalidStreamUUID
    }
    guard keywrapDigestHex.utf8.count == 64,
      keywrapDigestHex.utf8.allSatisfy({
        (0x30...0x39).contains($0) || (0x61...0x66).contains($0)
      })
    else {
      throw ArchiveRetainedLaneDescriptorError.invalidKeywrapDigest
    }
    _ = try context.encodedBytes()
    _ = try ArchiveISTDay(context.istDate)
    self.context = context
    self.keywrapDigestHex = keywrapDigestHex
    _ = try ArchiveRetainedControlDescriptorCodec.encode(self)
  }

  public init(identity: ArchiveDailyControlIdentity) throws {
    try self.init(context: identity.context, keywrapDigestHex: identity.keywrapDigestHex)
  }
}

public enum ArchiveRetainedControlDescriptorCodec {
  public static func encode(_ descriptor: ArchiveRetainedControlDescriptor) throws -> Data {
    var result = Data()
    result.append(contentsOf: "{\"format_version\":".utf8)
    ArchiveCanonicalJSON.appendInteger(ArchiveRetainedControlDescriptor.formatVersion, to: &result)
    result.append(contentsOf: ",\"ist_date\":".utf8)
    ArchiveCanonicalJSON.appendString(descriptor.context.istDate, to: &result)
    result.append(contentsOf: ",\"keywrap_sha256\":".utf8)
    ArchiveCanonicalJSON.appendString(descriptor.keywrapDigestHex, to: &result)
    result.append(contentsOf: ",\"lane_id\":".utf8)
    ArchiveCanonicalJSON.appendString(descriptor.context.laneID, to: &result)
    result.append(contentsOf: ",\"room_id\":".utf8)
    ArchiveCanonicalJSON.appendString(descriptor.context.roomID, to: &result)
    result.append(contentsOf: ",\"stable_device_uid\":".utf8)
    ArchiveCanonicalJSON.appendString(descriptor.context.stableDeviceUID, to: &result)
    result.append(contentsOf: ",\"stream_uuid_b64\":".utf8)
    ArchiveCanonicalJSON.appendString(
      descriptor.context.streamUUID.base64EncodedString(), to: &result)
    result.append(0x7D)
    guard result.count <= ArchiveRetainedControlDescriptor.maximumEncodedByteCount else {
      throw ArchiveRetainedLaneDescriptorError.payloadTooLarge(result.count)
    }
    return result
  }

  public static func decode(_ data: Data) throws -> ArchiveRetainedControlDescriptor {
    guard data.count <= ArchiveRetainedControlDescriptor.maximumEncodedByteCount else {
      throw ArchiveRetainedLaneDescriptorError.payloadTooLarge(data.count)
    }
    var parser = ArchiveCanonicalJSONParser(data)
    do {
      try parser.expect("{\"format_version\":")
      let formatVersion = try parser.integer(field: "format_version")
      guard formatVersion == ArchiveRetainedControlDescriptor.formatVersion else {
        throw ArchiveRetainedLaneDescriptorError.unsupportedFormatVersion(formatVersion)
      }
      try parser.expect(",\"ist_date\":")
      let istDate = try parser.string()
      try parser.expect(",\"keywrap_sha256\":")
      let keywrapDigestHex = try parser.string()
      try parser.expect(",\"lane_id\":")
      let laneID = try parser.string()
      try parser.expect(",\"room_id\":")
      let roomID = try parser.string()
      try parser.expect(",\"stable_device_uid\":")
      let stableDeviceUID = try parser.string()
      try parser.expect(",\"stream_uuid_b64\":")
      let streamUUIDBase64 = try parser.string()
      try parser.expect("}")
      try parser.expectEnd()
      guard let streamUUID = Data(base64Encoded: streamUUIDBase64),
        streamUUID.base64EncodedString() == streamUUIDBase64
      else {
        throw ArchiveRetainedLaneDescriptorError.invalidStreamUUID
      }
      let descriptor = try ArchiveRetainedControlDescriptor(
        context: ArchiveContext(
          streamUUID: streamUUID,
          roomID: roomID,
          istDate: istDate,
          laneID: laneID,
          stableDeviceUID: stableDeviceUID
        ),
        keywrapDigestHex: keywrapDigestHex
      )
      guard try encode(descriptor) == data else {
        throw ArchiveRetainedLaneDescriptorError.invalidSyntax(offset: 0)
      }
      return descriptor
    } catch ArchiveCanonicalJSONError.invalidSyntax(let offset) {
      throw ArchiveRetainedLaneDescriptorError.invalidSyntax(offset: offset)
    } catch ArchiveCanonicalJSONError.integerOverflow {
      throw ArchiveRetainedLaneDescriptorError.invalidSyntax(offset: 0)
    }
  }
}

public struct ArchiveRetainedControlLayout: Equatable, Sendable {
  public static let descriptorFileName = "control.json"
  public static let journalFileName = "control.journal"

  public let rootURL: URL
  public let directoryURL: URL
  public let descriptorURL: URL
  public let keywrapURL: URL
  public let journalURL: URL

  public init(rootURL: URL, descriptor: ArchiveRetainedControlDescriptor) throws {
    try self.init(rootURL: rootURL, context: descriptor.context)
  }

  public init(rootURL: URL, context: ArchiveContext) throws {
    guard rootURL.isFileURL, rootURL.path.hasPrefix("/") else {
      throw ArchiveRetainedLaneDescriptorError.invalidSyntax(offset: 0)
    }
    guard context.laneID == "_control", context.stableDeviceUID.isEmpty else {
      throw ArchiveRetainedLaneDescriptorError.unsupportedLane(context.laneID)
    }
    _ = try context.encodedBytes()
    let directory =
      rootURL
      .appendingPathComponent(ArchiveRetainedLaneLayout.archiveDirectoryName, isDirectory: true)
      .appendingPathComponent(context.istDate, isDirectory: true)
      .appendingPathComponent("_control", isDirectory: true)
    self.rootURL = rootURL
    directoryURL = directory
    descriptorURL = directory.appendingPathComponent(Self.descriptorFileName)
    keywrapURL = directory.appendingPathComponent("keywrap.eak")
    journalURL = directory.appendingPathComponent(Self.journalFileName)
  }
}

public struct ArchiveRetainedRolloverStageLayout: Equatable, Sendable {
  public static let directoryName = ".rollover-staging-v1"

  public let rootURL: URL
  public let stageID: String
  public let transactionDirectoryURL: URL
  public let audioParentDirectoryURL: URL
  public let laneDirectoryURL: URL
  public let controlDayDirectoryURL: URL
  public let controlDirectoryURL: URL

  public init(rootURL: URL, stageID: String) throws {
    guard rootURL.isFileURL, rootURL.path.hasPrefix("/"), Self.isValidStageID(stageID) else {
      throw ArchiveRetainedLaneCatalogError.invalidHierarchy
    }
    self.rootURL = rootURL
    self.stageID = stageID
    transactionDirectoryURL =
      rootURL
      .appendingPathComponent(Self.directoryName, isDirectory: true)
      .appendingPathComponent(stageID, isDirectory: true)
    audioParentDirectoryURL = transactionDirectoryURL.appendingPathComponent(
      "audio", isDirectory: true)
    laneDirectoryURL = audioParentDirectoryURL.appendingPathComponent(
      "primary", isDirectory: true)
    controlDayDirectoryURL = transactionDirectoryURL.appendingPathComponent(
      "control-day", isDirectory: true)
    controlDirectoryURL = controlDayDirectoryURL.appendingPathComponent(
      "_control", isDirectory: true)
  }

  private static func isValidStageID(_ value: String) -> Bool {
    value.utf8.count == 64
      && value.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
  }
}

public enum ArchiveRetainedLaneCatalogError: String, Error, LocalizedError, Sendable {
  case invalidRoot = "archive_catalog_invalid_root"
  case invalidHierarchy = "archive_catalog_invalid_hierarchy"
  case unexpectedEntry = "archive_catalog_unexpected_entry"
  case missingDescriptor = "archive_catalog_missing_descriptor"
  case invalidDescriptor = "archive_catalog_invalid_descriptor"
  case descriptorLocationMismatch = "archive_catalog_descriptor_location_mismatch"
  case missingRequiredArtifact = "archive_catalog_missing_required_artifact"
  case insecureArtifact = "archive_catalog_insecure_artifact"
  case keywrapMismatch = "archive_catalog_keywrap_mismatch"
  case descriptorConflict = "archive_catalog_descriptor_conflict"
  case publicationUncertain = "archive_catalog_publication_uncertain"

  public var errorDescription: String? { rawValue }
}

public struct ArchiveRetainedLaneCatalogEntry: Equatable, Sendable {
  public let descriptor: ArchiveRetainedLaneDescriptor
  public let layout: ArchiveRetainedLaneLayout
}

public struct ArchiveRetainedControlCatalogEntry: Equatable, Sendable {
  public let descriptor: ArchiveRetainedControlDescriptor
  public let layout: ArchiveRetainedControlLayout
  public let journalPresent: Bool
}

public struct ArchiveRetainedCatalogSnapshot: Equatable, Sendable {
  public let lanes: [ArchiveRetainedLaneCatalogEntry]
  public let controls: [ArchiveRetainedControlCatalogEntry]
}

public struct ArchiveOpenedRetainedLane: Sendable {
  public let store: ArchiveLaneStore
  public let keywrap: ArchiveKeywrapInspection
  public let catalogEntry: ArchiveRetainedLaneCatalogEntry
}

public struct ArchivePreparedRetainedControl: Sendable {
  public let keywrap: ArchiveKeywrapInspection
  public let catalogEntry: ArchiveRetainedControlCatalogEntry
}

public struct ArchiveStagedRetainedLane: Sendable {
  public let stageID: String
  public let store: ArchiveLaneStore
  public let keywrap: ArchiveKeywrapInspection
  public let identity: ArchiveDailyLaneIdentity
  public let stageLayout: ArchiveRetainedRolloverStageLayout
  public let catalogEntry: ArchiveRetainedLaneCatalogEntry
}

public struct ArchiveStagedRetainedControl: Sendable {
  public let stageID: String
  public let keywrap: ArchiveKeywrapInspection
  public let identity: ArchiveDailyControlIdentity
  public let stageLayout: ArchiveRetainedRolloverStageLayout
  public let catalogEntry: ArchiveRetainedControlCatalogEntry
}

public struct ArchiveRetainedLaneBuilder: Sendable {
  private let catalog: ArchiveRetainedLaneCatalog
  private let keyLifecycle: ArchiveKeyLifecycle

  public init(
    rootURL: URL,
    keyLifecycle: ArchiveKeyLifecycle = ArchiveKeyLifecycle()
  ) throws {
    catalog = try ArchiveRetainedLaneCatalog(rootURL: rootURL)
    self.keyLifecycle = keyLifecycle
  }

  public static func deterministicRolloverStreamUUID(
    stageID: String,
    kind: ArchiveRolloverStagedStreamKind
  ) throws -> Data {
    _ = try ArchiveRetainedRolloverStageLayout(
      rootURL: URL(fileURLWithPath: "/"), stageID: stageID)
    var input = Data("eta.room-recorder/rollover-staged-stream/v1".utf8)
    input.append(0)
    input.append(contentsOf: kind.rawValue.utf8)
    input.append(0)
    input.append(contentsOf: stageID.utf8)
    var result = Data(SHA256.hash(data: input).prefix(16))
    result[6] = (result[6] & 0x0F) | 0x40
    result[8] = (result[8] & 0x3F) | 0x80
    return result
  }

  public func openLane(
    context: ArchiveContext,
    initialSamplePosition: UInt64 = 0
  ) throws -> ArchiveOpenedRetainedLane {
    let layout = try catalog.prepareLayout(context: context)
    let opened = try keyLifecycle.openLaneStoreWithInspection(
      keywrapURL: layout.keywrapURL,
      tapeURL: layout.tapeURL,
      indexURL: layout.indexURL,
      context: context,
      initialSamplePosition: initialSamplePosition
    )
    return try publish(opened, context: context, initialSamplePosition: initialSamplePosition)
  }

  public func openNextDayLane(
    context: ArchiveContext,
    oldDaySnapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    expectedInitialSamplePosition: UInt64
  ) throws -> ArchiveOpenedRetainedLane {
    let layout = try catalog.prepareLayout(context: context)
    let opened = try keyLifecycle.openNextDayLaneStore(
      keywrapURL: layout.keywrapURL,
      tapeURL: layout.tapeURL,
      indexURL: layout.indexURL,
      context: context,
      oldDaySnapshot: oldDaySnapshot,
      expectedInitialSamplePosition: expectedInitialSamplePosition
    )
    return try publish(
      opened,
      context: context,
      initialSamplePosition: expectedInitialSamplePosition
    )
  }

  public func prepareControl(context: ArchiveContext) throws -> ArchivePreparedRetainedControl {
    let layout = try catalog.prepareControlLayout(context: context)
    let keywrap = try keyLifecycle.prepareControlKeywrapWithInspection(
      keywrapURL: layout.keywrapURL,
      journalURL: layout.journalURL,
      context: context)
    let identity = try ArchiveDailyControlIdentity(context: context, keywrap: keywrap)
    return ArchivePreparedRetainedControl(
      keywrap: keywrap,
      catalogEntry: try catalog.publish(identity: identity))
  }

  public func stageNextDayLane(
    stageID: String,
    context: ArchiveContext,
    oldDaySnapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    expectedInitialSamplePosition: UInt64
  ) throws -> ArchiveStagedRetainedLane {
    guard
      context.streamUUID
        == (try Self.deterministicRolloverStreamUUID(
          stageID: stageID, kind: .primary))
    else { throw ArchiveRetainedLaneCatalogError.descriptorConflict }
    let stageLayout = try catalog.prepareRolloverLaneStage(stageID: stageID)
    if let descriptor = try catalog.stagedLaneDescriptor(stageID: stageID) {
      guard descriptor.context == context,
        descriptor.initialSamplePosition == expectedInitialSamplePosition
      else {
        throw ArchiveRetainedLaneCatalogError.descriptorConflict
      }
    }
    let opened = try keyLifecycle.openNextDayLaneStore(
      keywrapURL: stageLayout.laneDirectoryURL.appendingPathComponent("keywrap.eak"),
      tapeURL: stageLayout.laneDirectoryURL.appendingPathComponent("lane.tape"),
      indexURL: stageLayout.laneDirectoryURL.appendingPathComponent("lane.index"),
      context: context,
      oldDaySnapshot: oldDaySnapshot,
      expectedInitialSamplePosition: expectedInitialSamplePosition)
    do {
      let identity = try ArchiveDailyLaneIdentity(
        context: context,
        expectedInitialSessionSample: expectedInitialSamplePosition,
        keywrap: opened.keywrap)
      let entry = try catalog.sealStagedLane(identity: identity, stageID: stageID)
      return ArchiveStagedRetainedLane(
        stageID: stageID,
        store: opened.store,
        keywrap: opened.keywrap,
        identity: identity,
        stageLayout: stageLayout,
        catalogEntry: entry)
    } catch {
      opened.store.close()
      throw error
    }
  }

  public func reopenStagedNextDayLane(
    stageID: String,
    oldDaySnapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    roomID: String,
    istDate: String,
    stableDeviceUID: String,
    expectedInitialSamplePosition: UInt64
  ) throws -> ArchiveStagedRetainedLane? {
    guard let descriptor = try catalog.stagedLaneDescriptor(stageID: stageID) else { return nil }
    guard descriptor.context.roomID == roomID, descriptor.context.istDate == istDate,
      descriptor.context.laneID == "primary",
      descriptor.context.stableDeviceUID == stableDeviceUID,
      descriptor.initialSamplePosition == expectedInitialSamplePosition
    else {
      throw ArchiveRetainedLaneCatalogError.descriptorConflict
    }
    return try reopenStagedLane(
      stageID: stageID,
      identity: ArchiveDailyLaneIdentity(
        context: descriptor.context,
        expectedInitialSessionSample: descriptor.initialSamplePosition,
        keywrapDigestHex: descriptor.keywrapDigestHex),
      oldDaySnapshot: oldDaySnapshot)
  }

  public func reopenStagedLane(
    stageID: String,
    identity: ArchiveDailyLaneIdentity,
    oldDaySnapshot: ArchiveLaneStore.AuthenticatedSnapshot
  ) throws -> ArchiveStagedRetainedLane? {
    guard let descriptor = try catalog.stagedLaneDescriptor(stageID: stageID) else { return nil }
    guard descriptor == (try ArchiveRetainedLaneDescriptor(identity: identity)) else {
      throw ArchiveRetainedLaneCatalogError.descriptorConflict
    }
    let stageLayout = try ArchiveRetainedRolloverStageLayout(
      rootURL: catalog.rootURL, stageID: stageID)
    let opened = try keyLifecycle.openNextDayLaneStore(
      keywrapURL: stageLayout.laneDirectoryURL.appendingPathComponent("keywrap.eak"),
      tapeURL: stageLayout.laneDirectoryURL.appendingPathComponent("lane.tape"),
      indexURL: stageLayout.laneDirectoryURL.appendingPathComponent("lane.index"),
      context: identity.context,
      oldDaySnapshot: oldDaySnapshot,
      expectedInitialSamplePosition: identity.expectedInitialSessionSample)
    guard opened.keywrap.authenticated,
      opened.keywrap.keywrapDigestHex == identity.keywrapDigestHex
    else {
      opened.store.close()
      throw ArchiveRetainedLaneCatalogError.keywrapMismatch
    }
    return ArchiveStagedRetainedLane(
      stageID: stageID,
      store: opened.store,
      keywrap: opened.keywrap,
      identity: identity,
      stageLayout: stageLayout,
      catalogEntry: ArchiveRetainedLaneCatalogEntry(
        descriptor: descriptor,
        layout: try ArchiveRetainedLaneLayout(rootURL: catalog.rootURL, descriptor: descriptor)))
  }

  public func stageControl(
    stageID: String,
    context: ArchiveContext
  ) throws -> ArchiveStagedRetainedControl {
    guard
      context.streamUUID
        == (try Self.deterministicRolloverStreamUUID(
          stageID: stageID, kind: .control))
    else { throw ArchiveRetainedLaneCatalogError.descriptorConflict }
    let stageLayout = try catalog.prepareRolloverControlStage(stageID: stageID)
    if let descriptor = try catalog.stagedControlDescriptor(stageID: stageID) {
      guard descriptor.context == context else {
        throw ArchiveRetainedLaneCatalogError.descriptorConflict
      }
    }
    let keywrap = try keyLifecycle.prepareControlKeywrapWithInspection(
      keywrapURL: stageLayout.controlDirectoryURL.appendingPathComponent("keywrap.eak"),
      journalURL: stageLayout.controlDirectoryURL.appendingPathComponent(
        ArchiveRetainedControlLayout.journalFileName),
      context: context)
    let identity = try ArchiveDailyControlIdentity(context: context, keywrap: keywrap)
    let entry = try catalog.sealStagedControl(identity: identity, stageID: stageID)
    return ArchiveStagedRetainedControl(
      stageID: stageID,
      keywrap: keywrap,
      identity: identity,
      stageLayout: stageLayout,
      catalogEntry: entry)
  }

  public func reopenStagedControl(
    stageID: String,
    identity: ArchiveDailyControlIdentity? = nil,
    roomID: String? = nil,
    istDate: String? = nil
  ) throws -> ArchiveStagedRetainedControl? {
    guard let descriptor = try catalog.stagedControlDescriptor(stageID: stageID) else { return nil }
    let expectedDescriptor = try identity.map(ArchiveRetainedControlDescriptor.init(identity:))
    guard expectedDescriptor == nil || descriptor == expectedDescriptor,
      roomID == nil || descriptor.context.roomID == roomID,
      istDate == nil || descriptor.context.istDate == istDate
    else {
      throw ArchiveRetainedLaneCatalogError.descriptorConflict
    }
    let stageLayout = try ArchiveRetainedRolloverStageLayout(
      rootURL: catalog.rootURL, stageID: stageID)
    let keywrap = try keyLifecycle.inspectExistingKeywrap(
      keywrapURL: stageLayout.controlDirectoryURL.appendingPathComponent("keywrap.eak"),
      context: descriptor.context)
    let actualIdentity = try ArchiveDailyControlIdentity(
      context: descriptor.context, keywrap: keywrap)
    if let identity, actualIdentity != identity {
      throw ArchiveRetainedLaneCatalogError.keywrapMismatch
    }
    return ArchiveStagedRetainedControl(
      stageID: stageID,
      keywrap: keywrap,
      identity: actualIdentity,
      stageLayout: stageLayout,
      catalogEntry: ArchiveRetainedControlCatalogEntry(
        descriptor: descriptor,
        layout: try ArchiveRetainedControlLayout(rootURL: catalog.rootURL, descriptor: descriptor),
        journalPresent: false))
  }

  public func publishStagedControl(
    _ staged: ArchiveStagedRetainedControl
  ) throws -> ArchiveRetainedControlCatalogEntry {
    guard staged.keywrap.authenticated, staged.identity == (try staged.catalogEntryIdentity) else {
      throw ArchiveRetainedLaneCatalogError.keywrapMismatch
    }
    return try catalog.publishStagedControl(identity: staged.identity, stageID: staged.stageID)
  }

  public func publishStagedLane(
    _ staged: ArchiveStagedRetainedLane
  ) throws -> ArchiveRetainedLaneCatalogEntry {
    guard staged.keywrap.authenticated, staged.identity == (try staged.catalogEntryIdentity) else {
      throw ArchiveRetainedLaneCatalogError.keywrapMismatch
    }
    return try catalog.publishStagedLane(identity: staged.identity, stageID: staged.stageID)
  }

  public func openPublishedLane(
    identity: ArchiveDailyLaneIdentity
  ) throws -> ArchiveOpenedRetainedLane {
    let matches = try catalog.scan().filter {
      $0.descriptor.context == identity.context
        && $0.descriptor.initialSamplePosition == identity.expectedInitialSessionSample
        && $0.descriptor.keywrapDigestHex == identity.keywrapDigestHex
    }
    guard matches.count == 1, let entry = matches.first else {
      throw ArchiveRetainedLaneCatalogError.descriptorConflict
    }
    let opened = try keyLifecycle.openLaneStoreWithInspection(
      keywrapURL: entry.layout.keywrapURL,
      tapeURL: entry.layout.tapeURL,
      indexURL: entry.layout.indexURL,
      context: identity.context,
      initialSamplePosition: identity.expectedInitialSessionSample)
    guard opened.keywrap.authenticated,
      opened.keywrap.keywrapDigestHex == identity.keywrapDigestHex
    else {
      opened.store.close()
      throw ArchiveRetainedLaneCatalogError.keywrapMismatch
    }
    return ArchiveOpenedRetainedLane(
      store: opened.store,
      keywrap: opened.keywrap,
      catalogEntry: entry)
  }

  private func publish(
    _ opened: ArchiveOpenedLane,
    context: ArchiveContext,
    initialSamplePosition: UInt64
  ) throws -> ArchiveOpenedRetainedLane {
    do {
      let identity = try ArchiveDailyLaneIdentity(
        context: context,
        expectedInitialSessionSample: initialSamplePosition,
        keywrap: opened.keywrap
      )
      return ArchiveOpenedRetainedLane(
        store: opened.store,
        keywrap: opened.keywrap,
        catalogEntry: try catalog.publish(identity: identity)
      )
    } catch {
      opened.store.close()
      throw error
    }
  }
}

extension ArchiveStagedRetainedLane {
  fileprivate var catalogEntryIdentity: ArchiveDailyLaneIdentity {
    get throws {
      try ArchiveDailyLaneIdentity(
        context: catalogEntry.descriptor.context,
        expectedInitialSessionSample: catalogEntry.descriptor.initialSamplePosition,
        keywrapDigestHex: catalogEntry.descriptor.keywrapDigestHex)
    }
  }
}

extension ArchiveStagedRetainedControl {
  fileprivate var catalogEntryIdentity: ArchiveDailyControlIdentity {
    get throws {
      try ArchiveDailyControlIdentity(
        context: catalogEntry.descriptor.context,
        keywrapDigestHex: catalogEntry.descriptor.keywrapDigestHex)
    }
  }
}

public struct ArchiveRetainedLaneCatalog: Sendable {
  private struct FileIdentity: Equatable {
    let device: UInt64
    let inode: UInt64

    init(_ value: stat) {
      device = UInt64(value.st_dev)
      inode = UInt64(value.st_ino)
    }
  }

  private static let expectedLaneEntries: Set<String> = [
    ArchiveRetainedLaneLayout.descriptorFileName,
    "keywrap.eak",
    "lane.tape",
    "lane.index",
    "lane.journal",
    "lane.level",
    "lane.manifest",
    "spool",
  ]
  private static let expectedControlEntries: Set<String> = [
    ArchiveRetainedControlLayout.descriptorFileName,
    "keywrap.eak",
    ArchiveRetainedControlLayout.journalFileName,
  ]

  public let rootURL: URL
  private let hooks: ArchiveRetainedLaneCatalogHooks

  public init(rootURL: URL) throws {
    try self.init(rootURL: rootURL, hooks: ArchiveRetainedLaneCatalogHooks())
  }

  init(rootURL: URL, hooks: ArchiveRetainedLaneCatalogHooks) throws {
    guard rootURL.isFileURL, rootURL.path.hasPrefix("/") else {
      throw ArchiveRetainedLaneCatalogError.invalidRoot
    }
    self.rootURL = rootURL
    self.hooks = hooks
  }

  public func prepareLayout(context: ArchiveContext) throws -> ArchiveRetainedLaneLayout {
    let layout = try ArchiveRetainedLaneLayout(rootURL: rootURL, context: context)
    let root = try Self.openPrivateDirectory(at: rootURL)
    defer { _ = Darwin.close(root) }
    let archive = try Self.openOrCreatePrivateDirectory(
      named: ArchiveRetainedLaneLayout.archiveDirectoryName,
      parent: root
    )
    defer { _ = Darwin.close(archive) }
    let day = try Self.openOrCreatePrivateDirectory(named: context.istDate, parent: archive)
    defer { _ = Darwin.close(day) }
    let lane = try Self.openOrCreatePrivateDirectory(named: context.laneID, parent: day)
    defer { _ = Darwin.close(lane) }
    let spool = try Self.openOrCreatePrivateDirectory(named: "spool", parent: lane)
    _ = Darwin.close(spool)
    return layout
  }

  public func prepareControlLayout(context: ArchiveContext) throws -> ArchiveRetainedControlLayout {
    let layout = try ArchiveRetainedControlLayout(rootURL: rootURL, context: context)
    let root = try Self.openPrivateDirectory(at: rootURL)
    defer { _ = Darwin.close(root) }
    let archive = try Self.openOrCreatePrivateDirectory(
      named: ArchiveRetainedLaneLayout.archiveDirectoryName,
      parent: root
    )
    defer { _ = Darwin.close(archive) }
    let day = try Self.openOrCreatePrivateDirectory(named: context.istDate, parent: archive)
    defer { _ = Darwin.close(day) }
    let control = try Self.openOrCreatePrivateDirectory(named: "_control", parent: day)
    _ = Darwin.close(control)
    return layout
  }

  public func prepareRolloverLaneStage(
    stageID: String
  ) throws -> ArchiveRetainedRolloverStageLayout {
    let layout = try ArchiveRetainedRolloverStageLayout(rootURL: rootURL, stageID: stageID)
    let root = try Self.openPrivateDirectory(at: rootURL)
    defer { _ = Darwin.close(root) }
    let staging = try Self.openOrCreatePrivateDirectory(
      named: ArchiveRetainedRolloverStageLayout.directoryName, parent: root)
    defer { _ = Darwin.close(staging) }
    let transaction = try Self.openOrCreatePrivateDirectory(named: stageID, parent: staging)
    defer { _ = Darwin.close(transaction) }
    let audio = try Self.openOrCreatePrivateDirectory(named: "audio", parent: transaction)
    defer { _ = Darwin.close(audio) }
    let lane = try Self.openOrCreatePrivateDirectory(named: "primary", parent: audio)
    defer { _ = Darwin.close(lane) }
    let spool = try Self.openOrCreatePrivateDirectory(named: "spool", parent: lane)
    _ = Darwin.close(spool)
    return layout
  }

  public func prepareRolloverControlStage(
    stageID: String
  ) throws -> ArchiveRetainedRolloverStageLayout {
    let layout = try ArchiveRetainedRolloverStageLayout(rootURL: rootURL, stageID: stageID)
    let root = try Self.openPrivateDirectory(at: rootURL)
    defer { _ = Darwin.close(root) }
    let staging = try Self.openOrCreatePrivateDirectory(
      named: ArchiveRetainedRolloverStageLayout.directoryName, parent: root)
    defer { _ = Darwin.close(staging) }
    let transaction = try Self.openOrCreatePrivateDirectory(named: stageID, parent: staging)
    defer { _ = Darwin.close(transaction) }
    let day = try Self.openOrCreatePrivateDirectory(named: "control-day", parent: transaction)
    defer { _ = Darwin.close(day) }
    let control = try Self.openOrCreatePrivateDirectory(named: "_control", parent: day)
    _ = Darwin.close(control)
    return layout
  }

  public func stagedLaneDescriptor(
    stageID: String
  ) throws -> ArchiveRetainedLaneDescriptor? {
    let layout = try ArchiveRetainedRolloverStageLayout(rootURL: rootURL, stageID: stageID)
    guard FileManager.default.fileExists(atPath: layout.laneDirectoryURL.path) else { return nil }
    let lane = try Self.openPrivateDirectory(at: layout.laneDirectoryURL)
    defer { _ = Darwin.close(lane) }
    guard
      try Self.privateRegularFileExists(
        named: ArchiveRetainedLaneLayout.descriptorFileName, parent: lane)
    else { return nil }
    let entries = try Self.directoryEntries(at: layout.laneDirectoryURL, heldDescriptor: lane)
    guard entries.isSubset(of: Self.expectedLaneEntries),
      entries.contains("keywrap.eak"), entries.contains("lane.tape"),
      entries.contains("lane.index"), entries.contains("spool")
    else {
      throw ArchiveRetainedLaneCatalogError.unexpectedEntry
    }
    let spool = try Self.openPrivateDirectory(
      at: layout.laneDirectoryURL.appendingPathComponent("spool", isDirectory: true))
    _ = Darwin.close(spool)
    do {
      return try ArchiveRetainedLaneDescriptorCodec.decode(
        Self.readPrivateFile(
          named: ArchiveRetainedLaneLayout.descriptorFileName,
          parent: lane,
          maximumByteCount: ArchiveRetainedLaneDescriptor.maximumEncodedByteCount))
    } catch let error as ArchiveRetainedLaneCatalogError {
      throw error
    } catch {
      throw ArchiveRetainedLaneCatalogError.invalidDescriptor
    }
  }

  public func stagedControlDescriptor(
    stageID: String
  ) throws -> ArchiveRetainedControlDescriptor? {
    let layout = try ArchiveRetainedRolloverStageLayout(rootURL: rootURL, stageID: stageID)
    guard FileManager.default.fileExists(atPath: layout.controlDirectoryURL.path) else {
      return nil
    }
    let control = try Self.openPrivateDirectory(at: layout.controlDirectoryURL)
    defer { _ = Darwin.close(control) }
    guard
      try Self.privateRegularFileExists(
        named: ArchiveRetainedControlLayout.descriptorFileName, parent: control)
    else { return nil }
    let entries = try Self.directoryEntries(
      at: layout.controlDirectoryURL, heldDescriptor: control)
    guard entries.isSubset(of: Self.expectedControlEntries),
      entries.contains("keywrap.eak"),
      !entries.contains(ArchiveRetainedControlLayout.journalFileName)
    else {
      throw ArchiveRetainedLaneCatalogError.unexpectedEntry
    }
    do {
      return try ArchiveRetainedControlDescriptorCodec.decode(
        Self.readPrivateFile(
          named: ArchiveRetainedControlLayout.descriptorFileName,
          parent: control,
          maximumByteCount: ArchiveRetainedControlDescriptor.maximumEncodedByteCount))
    } catch let error as ArchiveRetainedLaneCatalogError {
      throw error
    } catch {
      throw ArchiveRetainedLaneCatalogError.invalidDescriptor
    }
  }

  public func sealStagedLane(
    identity: ArchiveDailyLaneIdentity,
    stageID: String
  ) throws -> ArchiveRetainedLaneCatalogEntry {
    let descriptor = try ArchiveRetainedLaneDescriptor(identity: identity)
    let stage = try ArchiveRetainedRolloverStageLayout(rootURL: rootURL, stageID: stageID)
    let lane = try Self.openPrivateDirectory(at: stage.laneDirectoryURL)
    defer { _ = Darwin.close(lane) }
    for name in ["keywrap.eak", "lane.tape", "lane.index"] {
      guard try Self.privateRegularFileExists(named: name, parent: lane) else {
        throw ArchiveRetainedLaneCatalogError.missingRequiredArtifact
      }
    }
    try Self.validateKeywrap(
      at: stage.laneDirectoryURL.appendingPathComponent("keywrap.eak"),
      context: descriptor.context,
      expectedDigestHex: descriptor.keywrapDigestHex)
    try Self.publishCreateOnly(
      ArchiveRetainedLaneDescriptorCodec.encode(descriptor),
      named: ArchiveRetainedLaneLayout.descriptorFileName,
      parent: lane)
    return ArchiveRetainedLaneCatalogEntry(
      descriptor: descriptor,
      layout: try ArchiveRetainedLaneLayout(rootURL: rootURL, descriptor: descriptor))
  }

  public func sealStagedControl(
    identity: ArchiveDailyControlIdentity,
    stageID: String
  ) throws -> ArchiveRetainedControlCatalogEntry {
    let descriptor = try ArchiveRetainedControlDescriptor(identity: identity)
    let stage = try ArchiveRetainedRolloverStageLayout(rootURL: rootURL, stageID: stageID)
    let control = try Self.openPrivateDirectory(at: stage.controlDirectoryURL)
    defer { _ = Darwin.close(control) }
    guard try Self.privateRegularFileExists(named: "keywrap.eak", parent: control) else {
      throw ArchiveRetainedLaneCatalogError.missingRequiredArtifact
    }
    try Self.validateKeywrap(
      at: stage.controlDirectoryURL.appendingPathComponent("keywrap.eak"),
      context: descriptor.context,
      expectedDigestHex: descriptor.keywrapDigestHex)
    try Self.publishCreateOnly(
      ArchiveRetainedControlDescriptorCodec.encode(descriptor),
      named: ArchiveRetainedControlLayout.descriptorFileName,
      parent: control)
    return ArchiveRetainedControlCatalogEntry(
      descriptor: descriptor,
      layout: try ArchiveRetainedControlLayout(rootURL: rootURL, descriptor: descriptor),
      journalPresent: false)
  }

  public func publishStagedControl(
    identity: ArchiveDailyControlIdentity,
    stageID: String
  ) throws -> ArchiveRetainedControlCatalogEntry {
    let expected = try ArchiveRetainedControlDescriptor(identity: identity)
    if let published = try scanIncludingControls().controls.first(where: {
      $0.descriptor.context.istDate == identity.context.istDate
        && $0.descriptor.context.laneID == "_control"
    }) {
      guard published.descriptor == expected else {
        throw ArchiveRetainedLaneCatalogError.descriptorConflict
      }
      try synchronizePublishedDestination(istDate: identity.context.istDate)
      return published
    }
    guard try stagedControlDescriptor(stageID: stageID) == expected else {
      throw ArchiveRetainedLaneCatalogError.descriptorConflict
    }
    let stage = try ArchiveRetainedRolloverStageLayout(rootURL: rootURL, stageID: stageID)
    let root = try Self.openPrivateDirectory(at: rootURL)
    defer { _ = Darwin.close(root) }
    let archive = try Self.openOrCreatePrivateDirectory(
      named: ArchiveRetainedLaneLayout.archiveDirectoryName, parent: root)
    defer { _ = Darwin.close(archive) }
    let transaction = try Self.openPrivateDirectory(at: stage.transactionDirectoryURL)
    defer { _ = Darwin.close(transaction) }
    var dayValue = stat()
    if fstatat(archive, identity.context.istDate, &dayValue, AT_SYMLINK_NOFOLLOW) != 0 {
      guard errno == ENOENT,
        renameatx_np(
          transaction, "control-day", archive, identity.context.istDate, UInt32(RENAME_EXCL)) == 0
      else {
        throw ArchiveRetainedLaneCatalogError.publicationUncertain
      }
      try hooks.didRename(.renamedControl)
      guard hooks.synchronizeDirectory(transaction), hooks.synchronizeDirectory(archive) else {
        throw ArchiveRetainedLaneCatalogError.publicationUncertain
      }
    } else {
      let dayURL =
        rootURL
        .appendingPathComponent(ArchiveRetainedLaneLayout.archiveDirectoryName, isDirectory: true)
        .appendingPathComponent(identity.context.istDate, isDirectory: true)
      let day = try Self.openPrivateDirectory(at: dayURL)
      defer { _ = Darwin.close(day) }
      let stagedDay = try Self.openPrivateDirectory(at: stage.controlDayDirectoryURL)
      defer { _ = Darwin.close(stagedDay) }
      guard renameatx_np(stagedDay, "_control", day, "_control", UInt32(RENAME_EXCL)) == 0 else {
        throw ArchiveRetainedLaneCatalogError.publicationUncertain
      }
      try hooks.didRename(.renamedControl)
      guard hooks.synchronizeDirectory(stagedDay), hooks.synchronizeDirectory(day),
        hooks.synchronizeDirectory(archive)
      else { throw ArchiveRetainedLaneCatalogError.publicationUncertain }
    }
    guard
      let result = try scanIncludingControls().controls.first(where: {
        $0.descriptor == expected
      })
    else {
      throw ArchiveRetainedLaneCatalogError.publicationUncertain
    }
    return result
  }

  public func publishStagedLane(
    identity: ArchiveDailyLaneIdentity,
    stageID: String
  ) throws -> ArchiveRetainedLaneCatalogEntry {
    let expected = try ArchiveRetainedLaneDescriptor(identity: identity)
    if let published = try scan().first(where: {
      $0.descriptor.context.istDate == identity.context.istDate
        && $0.descriptor.context.laneID == identity.context.laneID
    }) {
      guard published.descriptor == expected else {
        throw ArchiveRetainedLaneCatalogError.descriptorConflict
      }
      try synchronizePublishedDestination(istDate: identity.context.istDate)
      return published
    }
    guard try stagedLaneDescriptor(stageID: stageID) == expected else {
      throw ArchiveRetainedLaneCatalogError.descriptorConflict
    }
    let stage = try ArchiveRetainedRolloverStageLayout(rootURL: rootURL, stageID: stageID)
    let target = try ArchiveRetainedLaneLayout(rootURL: rootURL, descriptor: expected)
    let day = try Self.openPrivateDirectory(at: target.directoryURL.deletingLastPathComponent())
    defer { _ = Darwin.close(day) }
    let audio = try Self.openPrivateDirectory(at: stage.audioParentDirectoryURL)
    defer { _ = Darwin.close(audio) }
    guard
      renameatx_np(
        audio, "primary", day, identity.context.laneID, UInt32(RENAME_EXCL)) == 0
    else {
      throw ArchiveRetainedLaneCatalogError.publicationUncertain
    }
    try hooks.didRename(.renamedLane)
    let archive = try Self.openPrivateDirectory(
      at: target.directoryURL.deletingLastPathComponent().deletingLastPathComponent())
    defer { _ = Darwin.close(archive) }
    guard hooks.synchronizeDirectory(audio), hooks.synchronizeDirectory(day),
      hooks.synchronizeDirectory(archive)
    else { throw ArchiveRetainedLaneCatalogError.publicationUncertain }
    guard let result = try scan().first(where: { $0.descriptor == expected }) else {
      throw ArchiveRetainedLaneCatalogError.publicationUncertain
    }
    return result
  }

  @discardableResult
  public func publish(identity: ArchiveDailyLaneIdentity) throws
    -> ArchiveRetainedLaneCatalogEntry
  {
    let descriptor = try ArchiveRetainedLaneDescriptor(identity: identity)
    let layout = try prepareLayout(context: descriptor.context)
    let lane = try Self.openPrivateDirectory(at: layout.directoryURL)
    defer { _ = Darwin.close(lane) }
    for name in ["keywrap.eak", "lane.tape", "lane.index"] {
      guard try Self.privateRegularFileExists(named: name, parent: lane) else {
        throw ArchiveRetainedLaneCatalogError.missingRequiredArtifact
      }
    }

    let keywrap = try ArchiveKeyLifecycle.inspectKeywrap(at: layout.keywrapURL)
    guard keywrap.keywrapDigestHex == descriptor.keywrapDigestHex,
      keywrap.streamUUIDHex == Self.hex(descriptor.context.streamUUID),
      keywrap.contextHashHex == Self.hex(try descriptor.context.sha256())
    else {
      throw ArchiveRetainedLaneCatalogError.keywrapMismatch
    }

    let encoded = try ArchiveRetainedLaneDescriptorCodec.encode(descriptor)
    try Self.publishCreateOnly(
      encoded,
      named: ArchiveRetainedLaneLayout.descriptorFileName,
      parent: lane
    )
    return ArchiveRetainedLaneCatalogEntry(descriptor: descriptor, layout: layout)
  }

  @discardableResult
  public func publish(identity: ArchiveDailyControlIdentity) throws
    -> ArchiveRetainedControlCatalogEntry
  {
    let descriptor = try ArchiveRetainedControlDescriptor(identity: identity)
    let layout = try prepareControlLayout(context: descriptor.context)
    let control = try Self.openPrivateDirectory(at: layout.directoryURL)
    defer { _ = Darwin.close(control) }
    guard try Self.privateRegularFileExists(named: "keywrap.eak", parent: control) else {
      throw ArchiveRetainedLaneCatalogError.missingRequiredArtifact
    }
    let keywrap = try ArchiveKeyLifecycle.inspectKeywrap(at: layout.keywrapURL)
    guard keywrap.keywrapDigestHex == descriptor.keywrapDigestHex,
      keywrap.streamUUIDHex == Self.hex(descriptor.context.streamUUID),
      keywrap.contextHashHex == Self.hex(try descriptor.context.sha256())
    else {
      throw ArchiveRetainedLaneCatalogError.keywrapMismatch
    }
    try Self.publishCreateOnly(
      ArchiveRetainedControlDescriptorCodec.encode(descriptor),
      named: ArchiveRetainedControlLayout.descriptorFileName,
      parent: control
    )
    return ArchiveRetainedControlCatalogEntry(
      descriptor: descriptor,
      layout: layout,
      journalPresent: try Self.privateRegularFileExists(
        named: ArchiveRetainedControlLayout.journalFileName,
        parent: control))
  }

  public func scan() throws -> [ArchiveRetainedLaneCatalogEntry] {
    try scanIncludingControls().lanes
  }

  public func scanIncludingControls() throws -> ArchiveRetainedCatalogSnapshot {
    let root = try Self.openPrivateDirectory(at: rootURL)
    defer { _ = Darwin.close(root) }
    let archiveURL = rootURL.appendingPathComponent(
      ArchiveRetainedLaneLayout.archiveDirectoryName,
      isDirectory: true
    )
    var archiveStat = stat()
    if fstatat(
      root,
      ArchiveRetainedLaneLayout.archiveDirectoryName,
      &archiveStat,
      AT_SYMLINK_NOFOLLOW
    ) != 0 {
      if errno == ENOENT { return ArchiveRetainedCatalogSnapshot(lanes: [], controls: []) }
      throw ArchiveRetainedLaneCatalogError.invalidHierarchy
    }
    let archive = try Self.openPrivateDirectory(at: archiveURL)
    defer { _ = Darwin.close(archive) }

    var lanes: [ArchiveRetainedLaneCatalogEntry] = []
    var controls: [ArchiveRetainedControlCatalogEntry] = []
    for dayName in try Self.directoryEntries(at: archiveURL, heldDescriptor: archive).sorted() {
      guard (try? ArchiveISTDay(dayName)) != nil else {
        throw ArchiveRetainedLaneCatalogError.unexpectedEntry
      }
      let dayURL = archiveURL.appendingPathComponent(dayName, isDirectory: true)
      let day = try Self.openPrivateDirectory(at: dayURL)
      defer { _ = Darwin.close(day) }
      let laneNames = try Self.directoryEntries(at: dayURL, heldDescriptor: day).sorted()
      guard !laneNames.isEmpty else {
        throw ArchiveRetainedLaneCatalogError.missingDescriptor
      }
      var dayRoomID: String?
      for laneName in laneNames {
        if laneName == "_control" {
          let controlURL = dayURL.appendingPathComponent(laneName, isDirectory: true)
          let control = try Self.openPrivateDirectory(at: controlURL)
          defer { _ = Darwin.close(control) }
          let entries = try Self.directoryEntries(at: controlURL, heldDescriptor: control)
          guard entries.isSubset(of: Self.expectedControlEntries) else {
            throw ArchiveRetainedLaneCatalogError.unexpectedEntry
          }
          guard entries.contains(ArchiveRetainedControlLayout.descriptorFileName) else {
            throw ArchiveRetainedLaneCatalogError.missingDescriptor
          }
          guard entries.contains("keywrap.eak"),
            try Self.privateRegularFileExists(named: "keywrap.eak", parent: control)
          else {
            throw ArchiveRetainedLaneCatalogError.missingRequiredArtifact
          }
          if entries.contains(ArchiveRetainedControlLayout.journalFileName) {
            guard
              try Self.privateRegularFileExists(
                named: ArchiveRetainedControlLayout.journalFileName,
                parent: control
              )
            else {
              throw ArchiveRetainedLaneCatalogError.insecureArtifact
            }
          }
          let encoded = try Self.readPrivateFile(
            named: ArchiveRetainedControlLayout.descriptorFileName,
            parent: control,
            maximumByteCount: ArchiveRetainedControlDescriptor.maximumEncodedByteCount
          )
          let descriptor: ArchiveRetainedControlDescriptor
          do {
            descriptor = try ArchiveRetainedControlDescriptorCodec.decode(encoded)
          } catch {
            throw ArchiveRetainedLaneCatalogError.invalidDescriptor
          }
          let layout = try ArchiveRetainedControlLayout(rootURL: rootURL, descriptor: descriptor)
          guard descriptor.context.istDate == dayName, layout.directoryURL == controlURL else {
            throw ArchiveRetainedLaneCatalogError.descriptorLocationMismatch
          }
          guard dayRoomID == nil || dayRoomID == descriptor.context.roomID else {
            throw ArchiveRetainedLaneCatalogError.descriptorLocationMismatch
          }
          try Self.validateKeywrap(
            at: layout.keywrapURL,
            context: descriptor.context,
            expectedDigestHex: descriptor.keywrapDigestHex)
          dayRoomID = descriptor.context.roomID
          controls.append(
            ArchiveRetainedControlCatalogEntry(
              descriptor: descriptor,
              layout: layout,
              journalPresent: entries.contains(ArchiveRetainedControlLayout.journalFileName)))
          continue
        }
        guard laneName == "primary" || laneName == "backup" else {
          throw ArchiveRetainedLaneCatalogError.unexpectedEntry
        }
        let laneURL = dayURL.appendingPathComponent(laneName, isDirectory: true)
        let lane = try Self.openPrivateDirectory(at: laneURL)
        defer { _ = Darwin.close(lane) }
        let entries = try Self.directoryEntries(at: laneURL, heldDescriptor: lane)
        guard entries.isSubset(of: Self.expectedLaneEntries) else {
          throw ArchiveRetainedLaneCatalogError.unexpectedEntry
        }
        guard entries.contains(ArchiveRetainedLaneLayout.descriptorFileName) else {
          throw ArchiveRetainedLaneCatalogError.missingDescriptor
        }
        for name in ["keywrap.eak", "lane.tape", "lane.index"] {
          guard entries.contains(name), try Self.privateRegularFileExists(named: name, parent: lane)
          else {
            throw ArchiveRetainedLaneCatalogError.missingRequiredArtifact
          }
        }
        if entries.contains("spool") {
          let spool = try Self.openPrivateDirectory(
            at: laneURL.appendingPathComponent("spool", isDirectory: true))
          _ = Darwin.close(spool)
        }
        for name in ["lane.journal", "lane.level", "lane.manifest"] where entries.contains(name) {
          guard try Self.privateRegularFileExists(named: name, parent: lane) else {
            throw ArchiveRetainedLaneCatalogError.insecureArtifact
          }
        }

        let encoded = try Self.readPrivateFile(
          named: ArchiveRetainedLaneLayout.descriptorFileName,
          parent: lane,
          maximumByteCount: ArchiveRetainedLaneDescriptor.maximumEncodedByteCount
        )
        let descriptor: ArchiveRetainedLaneDescriptor
        do {
          descriptor = try ArchiveRetainedLaneDescriptorCodec.decode(encoded)
        } catch {
          throw ArchiveRetainedLaneCatalogError.invalidDescriptor
        }
        guard descriptor.context.istDate == dayName, descriptor.context.laneID == laneName else {
          throw ArchiveRetainedLaneCatalogError.descriptorLocationMismatch
        }
        guard dayRoomID == nil || dayRoomID == descriptor.context.roomID else {
          throw ArchiveRetainedLaneCatalogError.descriptorLocationMismatch
        }
        dayRoomID = descriptor.context.roomID
        let layout = try ArchiveRetainedLaneLayout(rootURL: rootURL, descriptor: descriptor)
        guard layout.directoryURL == laneURL else {
          throw ArchiveRetainedLaneCatalogError.descriptorLocationMismatch
        }
        try Self.validateKeywrap(
          at: layout.keywrapURL,
          context: descriptor.context,
          expectedDigestHex: descriptor.keywrapDigestHex)
        lanes.append(ArchiveRetainedLaneCatalogEntry(descriptor: descriptor, layout: layout))
      }
    }
    return ArchiveRetainedCatalogSnapshot(lanes: lanes, controls: controls)
  }

  private static func validateKeywrap(
    at url: URL,
    context: ArchiveContext,
    expectedDigestHex: String
  ) throws {
    do {
      let keywrap = try ArchiveKeyLifecycle.inspectKeywrap(at: url)
      guard keywrap.keywrapDigestHex == expectedDigestHex,
        keywrap.streamUUIDHex == hex(context.streamUUID),
        keywrap.contextHashHex == hex(try context.sha256())
      else {
        throw ArchiveRetainedLaneCatalogError.keywrapMismatch
      }
    } catch let error as ArchiveRetainedLaneCatalogError {
      throw error
    } catch {
      throw ArchiveRetainedLaneCatalogError.keywrapMismatch
    }
  }

  private func synchronizePublishedDestination(istDate: String) throws {
    let archiveURL = rootURL.appendingPathComponent(
      ArchiveRetainedLaneLayout.archiveDirectoryName, isDirectory: true)
    let archive = try Self.openPrivateDirectory(at: archiveURL)
    defer { _ = Darwin.close(archive) }
    let day = try Self.openPrivateDirectory(
      at: archiveURL.appendingPathComponent(istDate, isDirectory: true))
    defer { _ = Darwin.close(day) }
    guard hooks.synchronizeDirectory(day), hooks.synchronizeDirectory(archive) else {
      throw ArchiveRetainedLaneCatalogError.publicationUncertain
    }
  }

  private static func openPrivateDirectory(at url: URL) throws -> Int32 {
    guard url.isFileURL, url.path.hasPrefix("/"), let resolved = realpath(url.path, nil) else {
      throw ArchiveRetainedLaneCatalogError.invalidHierarchy
    }
    defer { Darwin.free(resolved) }
    guard String(cString: resolved) == url.path else {
      throw ArchiveRetainedLaneCatalogError.invalidHierarchy
    }
    let descriptor = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    guard descriptor >= 0 else {
      throw ArchiveRetainedLaneCatalogError.invalidHierarchy
    }
    var value = stat()
    guard fstat(descriptor, &value) == 0, value.st_mode & S_IFMT == S_IFDIR,
      value.st_mode & mode_t(0o777) == mode_t(0o700)
    else {
      _ = Darwin.close(descriptor)
      throw ArchiveRetainedLaneCatalogError.invalidHierarchy
    }
    return descriptor
  }

  private static func openOrCreatePrivateDirectory(named name: String, parent: Int32) throws
    -> Int32
  {
    guard !name.isEmpty, name != ".", name != "..", !name.contains("/") else {
      throw ArchiveRetainedLaneCatalogError.invalidHierarchy
    }
    var descriptor = openat(parent, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    if descriptor < 0, errno == ENOENT {
      var creation: Int32
      repeat {
        creation = mkdirat(parent, name, mode_t(0o700))
      } while creation != 0 && errno == EINTR
      guard creation == 0 || errno == EEXIST else {
        throw ArchiveRetainedLaneCatalogError.publicationUncertain
      }
      descriptor = openat(parent, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
      guard descriptor >= 0 else { throw ArchiveRetainedLaneCatalogError.publicationUncertain }
      if creation == 0 {
        guard fchmod(descriptor, mode_t(0o700)) == 0, Self.sync(descriptor) else {
          _ = Darwin.close(descriptor)
          throw ArchiveRetainedLaneCatalogError.publicationUncertain
        }
        guard Self.sync(parent) else {
          _ = Darwin.close(descriptor)
          throw ArchiveRetainedLaneCatalogError.publicationUncertain
        }
      }
    }
    guard descriptor >= 0 else { throw ArchiveRetainedLaneCatalogError.invalidHierarchy }
    var value = stat()
    guard fstat(descriptor, &value) == 0, value.st_mode & S_IFMT == S_IFDIR,
      value.st_mode & mode_t(0o777) == mode_t(0o700)
    else {
      _ = Darwin.close(descriptor)
      throw ArchiveRetainedLaneCatalogError.invalidHierarchy
    }
    return descriptor
  }

  private static func directoryEntries(at url: URL, heldDescriptor: Int32) throws -> Set<String> {
    var held = stat()
    guard fstat(heldDescriptor, &held) == 0 else {
      throw ArchiveRetainedLaneCatalogError.invalidHierarchy
    }
    let names: [String]
    do {
      names = try FileManager.default.contentsOfDirectory(atPath: url.path)
    } catch {
      throw ArchiveRetainedLaneCatalogError.invalidHierarchy
    }
    var current = stat()
    guard lstat(url.path, &current) == 0, current.st_mode & S_IFMT == S_IFDIR,
      FileIdentity(held) == FileIdentity(current)
    else {
      throw ArchiveRetainedLaneCatalogError.invalidHierarchy
    }
    return Set(names)
  }

  private static func privateRegularFileExists(named name: String, parent: Int32) throws -> Bool {
    var value = stat()
    var result: Int32
    repeat {
      result = fstatat(parent, name, &value, AT_SYMLINK_NOFOLLOW)
    } while result != 0 && errno == EINTR
    if result != 0, errno == ENOENT { return false }
    guard result == 0, value.st_mode & S_IFMT == S_IFREG, value.st_nlink == 1,
      value.st_mode & mode_t(0o777) == mode_t(0o600)
    else {
      throw ArchiveRetainedLaneCatalogError.insecureArtifact
    }
    return true
  }

  private static func readPrivateFile(
    named name: String,
    parent: Int32,
    maximumByteCount: Int
  ) throws -> Data {
    let descriptor = openat(parent, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_SHLOCK | O_NONBLOCK)
    guard descriptor >= 0 else { throw ArchiveRetainedLaneCatalogError.insecureArtifact }
    defer { _ = Darwin.close(descriptor) }
    var before = stat()
    guard fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
      before.st_nlink == 1, before.st_mode & mode_t(0o777) == mode_t(0o600),
      before.st_size >= 0, before.st_size <= maximumByteCount
    else {
      throw ArchiveRetainedLaneCatalogError.insecureArtifact
    }
    var data = Data(count: Int(before.st_size))
    var offset = 0
    while offset < data.count {
      let remaining = data.count - offset
      let count = data.withUnsafeMutableBytes { bytes in
        Darwin.read(descriptor, bytes.baseAddress!.advanced(by: offset), remaining)
      }
      if count < 0, errno == EINTR { continue }
      guard count > 0 else { throw ArchiveRetainedLaneCatalogError.insecureArtifact }
      offset += count
    }
    var after = stat()
    var path = stat()
    guard fstat(descriptor, &after) == 0,
      fstatat(parent, name, &path, AT_SYMLINK_NOFOLLOW) == 0,
      FileIdentity(before) == FileIdentity(after), FileIdentity(before) == FileIdentity(path),
      before.st_size == after.st_size
    else {
      throw ArchiveRetainedLaneCatalogError.insecureArtifact
    }
    return data
  }

  private static func publishCreateOnly(_ data: Data, named name: String, parent: Int32) throws {
    if try privateRegularFileExists(named: name, parent: parent) {
      let existing = try readPrivateFile(
        named: name,
        parent: parent,
        maximumByteCount: ArchiveRetainedLaneDescriptor.maximumEncodedByteCount
      )
      guard existing == data else { throw ArchiveRetainedLaneCatalogError.descriptorConflict }
      return
    }

    let temporaryName = ".\(name).tmp.\(UUID().uuidString.lowercased())"
    let descriptor = openat(
      parent,
      temporaryName,
      O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
      mode_t(0o600)
    )
    guard descriptor >= 0 else { throw ArchiveRetainedLaneCatalogError.publicationUncertain }
    var published = false
    defer {
      _ = Darwin.close(descriptor)
      if !published { _ = unlinkat(parent, temporaryName, 0) }
    }
    var offset = 0
    while offset < data.count {
      let count = data.withUnsafeBytes { bytes in
        Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), data.count - offset)
      }
      if count < 0, errno == EINTR { continue }
      guard count > 0 else { throw ArchiveRetainedLaneCatalogError.publicationUncertain }
      offset += count
    }
    guard fchmod(descriptor, mode_t(0o600)) == 0, fcntl(descriptor, F_FULLFSYNC) == 0 else {
      throw ArchiveRetainedLaneCatalogError.publicationUncertain
    }
    let renameResult = renameatx_np(
      parent,
      temporaryName,
      parent,
      name,
      UInt32(RENAME_EXCL)
    )
    if renameResult != 0, errno == EEXIST {
      let existing = try readPrivateFile(
        named: name,
        parent: parent,
        maximumByteCount: ArchiveRetainedLaneDescriptor.maximumEncodedByteCount
      )
      guard existing == data else { throw ArchiveRetainedLaneCatalogError.descriptorConflict }
      guard unlinkat(parent, temporaryName, 0) == 0 else {
        throw ArchiveRetainedLaneCatalogError.publicationUncertain
      }
    } else {
      guard renameResult == 0 else { throw ArchiveRetainedLaneCatalogError.publicationUncertain }
    }
    published = true
    guard sync(parent) else { throw ArchiveRetainedLaneCatalogError.publicationUncertain }
  }

  private static func sync(_ descriptor: Int32) -> Bool {
    var result: Int32
    repeat { result = fsync(descriptor) } while result != 0 && errno == EINTR
    return result == 0
  }

  private static func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }
}
