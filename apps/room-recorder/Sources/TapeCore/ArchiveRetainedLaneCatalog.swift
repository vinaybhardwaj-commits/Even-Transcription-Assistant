import Darwin
import Foundation

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

public struct ArchiveOpenedRetainedLane: Sendable {
  public let store: ArchiveLaneStore
  public let keywrap: ArchiveKeywrapInspection
  public let catalogEntry: ArchiveRetainedLaneCatalogEntry
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

  public let rootURL: URL

  public init(rootURL: URL) throws {
    guard rootURL.isFileURL, rootURL.path.hasPrefix("/") else {
      throw ArchiveRetainedLaneCatalogError.invalidRoot
    }
    self.rootURL = rootURL
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

  public func scan() throws -> [ArchiveRetainedLaneCatalogEntry] {
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
      if errno == ENOENT { return [] }
      throw ArchiveRetainedLaneCatalogError.invalidHierarchy
    }
    let archive = try Self.openPrivateDirectory(at: archiveURL)
    defer { _ = Darwin.close(archive) }

    var result: [ArchiveRetainedLaneCatalogEntry] = []
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
      for laneName in laneNames {
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
        let layout = try ArchiveRetainedLaneLayout(rootURL: rootURL, descriptor: descriptor)
        guard layout.directoryURL == laneURL else {
          throw ArchiveRetainedLaneCatalogError.descriptorLocationMismatch
        }
        result.append(ArchiveRetainedLaneCatalogEntry(descriptor: descriptor, layout: layout))
      }
    }
    return result
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

    let temporaryName = ".lane.json.tmp.\(UUID().uuidString.lowercased())"
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
