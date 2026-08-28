import Darwin
import Foundation

struct ArchiveKeyIOHooks {
  var openPath: (String, Int32, mode_t) -> Int32 = { Darwin.open($0, $1, $2) }
  var openAt: (Int32, String, Int32, mode_t) -> Int32 = { Darwin.openat($0, $1, $2, $3) }
  var read: (Int32, UnsafeMutableRawPointer, Int) -> Int = Darwin.read
  var write: (Int32, UnsafeRawPointer, Int) -> Int = Darwin.write
  var fstat: (Int32, UnsafeMutablePointer<stat>) -> Int32 = Darwin.fstat
  var fstatAt: (Int32, String, UnsafeMutablePointer<stat>, Int32) -> Int32 = {
    Darwin.fstatat($0, $1, $2, $3)
  }
  var fullSync: (Int32) -> Int32 = { fcntl($0, F_FULLFSYNC) }
  var directorySync: (Int32) -> Int32 = Darwin.fsync
  var lockFile: (Int32, Int32) -> Int32 = { descriptor, operation in
    flock(descriptor, operation)
  }
  var makeDirectoryAt: (Int32, String, mode_t) -> Int32 = { directory, name, permissions in
    name.withCString { Darwin.mkdirat(directory, $0, permissions) }
  }
  var changeMode: (Int32, mode_t) -> Int32 = Darwin.fchmod
  var duplicate: (Int32) -> Int32 = { fcntl($0, F_DUPFD_CLOEXEC, 0) }
  var close: (Int32) -> Int32 = Darwin.close
  var renameExclusiveAt: (Int32, String, String) -> Int32 = { directory, source, destination in
    source.withCString { sourcePath in
      destination.withCString { destinationPath in
        renameatx_np(directory, sourcePath, directory, destinationPath, UInt32(RENAME_EXCL))
      }
    }
  }
  var unlinkAt: (Int32, String) -> Int32 = { Darwin.unlinkat($0, $1, 0) }
  var temporarySuffix: () -> String = { UUID().uuidString }
}

struct ArchiveFileIdentity: Equatable, Hashable {
  let device: UInt64
  let inode: UInt64

  init(_ value: stat) {
    device = UInt64(value.st_dev)
    inode = UInt64(value.st_ino)
  }
}

struct ArchiveFileSnapshot: Equatable {
  let identity: ArchiveFileIdentity
  let size: Int64
  let links: UInt64
  let mode: mode_t
  let modifiedSeconds: Int
  let modifiedNanoseconds: Int
  let changedSeconds: Int
  let changedNanoseconds: Int

  init(_ value: stat) {
    identity = ArchiveFileIdentity(value)
    size = value.st_size
    links = UInt64(value.st_nlink)
    mode = value.st_mode
    modifiedSeconds = value.st_mtimespec.tv_sec
    modifiedNanoseconds = value.st_mtimespec.tv_nsec
    changedSeconds = value.st_ctimespec.tv_sec
    changedNanoseconds = value.st_ctimespec.tv_nsec
  }
}

final class ArchiveDirectoryHandle {
  let url: URL
  let descriptor: Int32
  let identity: ArchiveFileIdentity
  private let closeDescriptor: (Int32) -> Int32

  init(
    url: URL, descriptor: Int32, identity: ArchiveFileIdentity, close: @escaping (Int32) -> Int32
  ) {
    self.url = url
    self.descriptor = descriptor
    self.identity = identity
    closeDescriptor = close
  }

  deinit { _ = closeDescriptor(descriptor) }
}

struct ArchiveResolvedFile {
  let url: URL
  let directory: ArchiveDirectoryHandle
  let name: String

  var identityKey: String {
    let foldedName = name.precomposedStringWithCanonicalMapping.folding(
      options: [.caseInsensitive], locale: Locale(identifier: "en_US_POSIX"))
    return "\(directory.identity.device):\(directory.identity.inode):\(foldedName)"
  }
}

struct ArchiveValidatedKeyPaths {
  let keywrap: ArchiveResolvedFile
  let tape: ArchiveResolvedFile
  let index: ArchiveResolvedFile

  init(
    keywrapURL: URL,
    tapeURL: URL,
    indexURL: URL,
    hooks: ArchiveKeyIOHooks
  ) throws {
    keywrap = try Self.resolve(keywrapURL, hooks: hooks)
    tape = try Self.resolve(tapeURL, hooks: hooks)
    index = try Self.resolve(indexURL, hooks: hooks)
    let values = [keywrap, tape, index]
    guard Set(values.map(\.identityKey)).count == values.count else {
      throw ArchiveKeyLifecycleFailure.pathAlias
    }
  }

  static func resolve(_ url: URL, hooks: ArchiveKeyIOHooks) throws -> ArchiveResolvedFile {
    guard url.isFileURL, url.path.hasPrefix("/") else {
      throw ArchiveKeyLifecycleFailure.invalidPath
    }
    let components = url.path.split(separator: "/", omittingEmptySubsequences: false)
    guard !components.contains("."), !components.contains("..") else {
      throw ArchiveKeyLifecycleFailure.invalidPath
    }
    let preserved = URL(fileURLWithPath: url.path)
    let name = preserved.lastPathComponent
    guard !name.isEmpty, name != ".", name != "..", !name.contains("/") else {
      throw ArchiveKeyLifecycleFailure.invalidPath
    }
    let directoryURL = preserved.deletingLastPathComponent()
    guard let resolvedPointer = Darwin.realpath(directoryURL.path, nil) else {
      throw ArchiveKeyLifecycleFailure.fileOpenFailed(errno: errno)
    }
    defer { Darwin.free(resolvedPointer) }
    guard String(cString: resolvedPointer) == directoryURL.path else {
      throw ArchiveKeyLifecycleFailure.symlinkParent(directoryURL.path)
    }
    let descriptor = retryingOpenPath(
      directoryURL.path,
      flags: O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
      permissions: 0,
      hooks: hooks)
    guard descriptor >= 0 else {
      throw ArchiveKeyLifecycleFailure.fileOpenFailed(errno: errno)
    }
    var directoryStat = stat()
    guard retryingFstat(descriptor, &directoryStat, hooks: hooks) == 0,
      directoryStat.st_mode & S_IFMT == S_IFDIR
    else {
      let savedErrno = errno
      _ = hooks.close(descriptor)
      throw ArchiveKeyLifecycleFailure.fileStatFailed(errno: savedErrno)
    }
    return ArchiveResolvedFile(
      url: preserved,
      directory: ArchiveDirectoryHandle(
        url: directoryURL,
        descriptor: descriptor,
        identity: ArchiveFileIdentity(directoryStat),
        close: hooks.close),
      name: name)
  }

  static func resolveDirectory(_ url: URL, hooks: ArchiveKeyIOHooks) throws
    -> ArchiveDirectoryHandle
  {
    guard url.isFileURL, url.path.hasPrefix("/") else {
      throw ArchiveKeyLifecycleFailure.invalidPath
    }
    let components = url.path.split(separator: "/", omittingEmptySubsequences: false)
    guard !components.contains("."), !components.contains("..") else {
      throw ArchiveKeyLifecycleFailure.invalidPath
    }
    let preserved = URL(fileURLWithPath: url.path, isDirectory: true)
    guard let resolvedPointer = Darwin.realpath(preserved.path, nil) else {
      throw ArchiveKeyLifecycleFailure.globalLockFailed(errno: errno)
    }
    defer { Darwin.free(resolvedPointer) }
    guard String(cString: resolvedPointer) == preserved.path else {
      throw ArchiveKeyLifecycleFailure.symlinkParent(preserved.path)
    }
    let descriptor = retryingOpenPath(
      preserved.path,
      flags: O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
      permissions: 0,
      hooks: hooks)
    guard descriptor >= 0 else {
      throw ArchiveKeyLifecycleFailure.globalLockFailed(errno: errno)
    }
    var directoryStat = stat()
    guard retryingFstat(descriptor, &directoryStat, hooks: hooks) == 0,
      directoryStat.st_mode & S_IFMT == S_IFDIR
    else {
      let savedErrno = errno
      _ = hooks.close(descriptor)
      throw ArchiveKeyLifecycleFailure.globalLockFailed(errno: savedErrno)
    }
    return ArchiveDirectoryHandle(
      url: preserved,
      descriptor: descriptor,
      identity: ArchiveFileIdentity(directoryStat),
      close: hooks.close)
  }
}

struct ArchiveValidatedControlPaths {
  let keywrap: ArchiveResolvedFile
  let journal: ArchiveResolvedFile

  init(keywrapURL: URL, journalURL: URL, hooks: ArchiveKeyIOHooks) throws {
    keywrap = try ArchiveValidatedKeyPaths.resolve(keywrapURL, hooks: hooks)
    journal = try ArchiveValidatedKeyPaths.resolve(journalURL, hooks: hooks)
    guard keywrap.identityKey != journal.identityKey else {
      throw ArchiveKeyLifecycleFailure.pathAlias
    }
  }
}

final class ArchiveProvisioningLock {
  private let descriptor: Int32
  private let closeDescriptor: (Int32) -> Int32

  init(path: ArchiveResolvedFile, hooks: ArchiveKeyIOHooks) throws {
    var created = false
    var opened: Int32
    while true {
      opened = retryingOpenAt(
        path, flags: O_RDWR | O_CLOEXEC | O_NOFOLLOW, permissions: 0, hooks: hooks)
      if opened >= 0 { break }
      let openErrno = errno
      guard openErrno == ENOENT else {
        throw ArchiveKeyLifecycleFailure.globalLockFailed(errno: openErrno)
      }
      opened = retryingOpenAt(
        path,
        flags: O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
        permissions: S_IRUSR | S_IWUSR,
        hooks: hooks)
      if opened >= 0 {
        created = true
        break
      }
      if errno != EEXIST {
        throw ArchiveKeyLifecycleFailure.globalLockFailed(errno: errno)
      }
    }
    do {
      _ = try validateSecureFile(opened, path: path, maximumSize: nil, hooks: hooks)
      while hooks.lockFile(opened, LOCK_EX) != 0 {
        let lockErrno = errno
        if lockErrno == EINTR { continue }
        throw ArchiveKeyLifecycleFailure.globalLockFailed(errno: lockErrno)
      }
      _ = try validateSecureFile(opened, path: path, maximumSize: nil, hooks: hooks)
      if created {
        try fullSync(opened, hooks: hooks)
        try syncDirectory(path.directory, hooks: hooks)
      }
    } catch {
      _ = hooks.close(opened)
      throw error
    }
    descriptor = opened
    closeDescriptor = hooks.close
  }

  deinit { _ = closeDescriptor(descriptor) }
}

final class ArchiveHeldKeywrap {
  let bytes: Data
  let identity: ArchiveFileIdentity
  private let descriptor: Int32
  private let closeDescriptor: (Int32) -> Int32

  init(
    bytes: Data, identity: ArchiveFileIdentity, descriptor: Int32, close: @escaping (Int32) -> Int32
  ) {
    self.bytes = bytes
    self.identity = identity
    self.descriptor = descriptor
    closeDescriptor = close
  }

  deinit { _ = closeDescriptor(descriptor) }
}

enum ArchiveDurablePublishResult {
  case published(ArchiveHeldKeywrap)
  case alreadyExists(ArchiveHeldKeywrap)
}

final class ArchiveLaneReservation {
  let tapeDescriptor: Int32
  let indexDescriptor: Int32
  private let tape: ArchiveResolvedFile
  private let index: ArchiveResolvedFile
  private let tapeSnapshot: ArchiveFileSnapshot
  private let indexSnapshot: ArchiveFileSnapshot
  private let createdTape: Bool
  private let createdIndex: Bool
  private let hooks: ArchiveKeyIOHooks
  private var ownsDescriptors = true
  private var ownsCreatedPaths = true

  init(
    tape: ArchiveResolvedFile,
    index: ArchiveResolvedFile,
    tapeDescriptor: Int32,
    indexDescriptor: Int32,
    tapeSnapshot: ArchiveFileSnapshot,
    indexSnapshot: ArchiveFileSnapshot,
    createdTape: Bool,
    createdIndex: Bool,
    hooks: ArchiveKeyIOHooks
  ) {
    self.tape = tape
    self.index = index
    self.tapeDescriptor = tapeDescriptor
    self.indexDescriptor = indexDescriptor
    self.tapeSnapshot = tapeSnapshot
    self.indexSnapshot = indexSnapshot
    self.createdTape = createdTape
    self.createdIndex = createdIndex
    self.hooks = hooks
  }

  func validateForHandoff() throws {
    let currentTape = try validateSecureFile(
      tapeDescriptor, path: tape, maximumSize: nil, hooks: hooks)
    let currentIndex = try validateSecureFile(
      indexDescriptor, path: index, maximumSize: nil, hooks: hooks)
    guard currentTape == tapeSnapshot, currentIndex == indexSnapshot else {
      throw ArchiveKeyLifecycleFailure.snapshotChanged
    }
    try validateDirectoryIdentity(tape.directory, hooks: hooks)
    try validateDirectoryIdentity(index.directory, hooks: hooks)
  }

  func completeHandoff() {
    ownsDescriptors = false
    ownsCreatedPaths = false
  }

  func cleanup() throws {
    var firstFailure: ArchiveKeyLifecycleFailure?
    let createdPaths = [
      (index, indexSnapshot.identity, createdIndex),
      (tape, tapeSnapshot.identity, createdTape),
    ]
    for (path, identity, created) in createdPaths where ownsCreatedPaths && created {
      do {
        var value = stat()
        guard retryingFstatAt(path, &value, hooks: hooks) == 0 else {
          throw ArchiveKeyLifecycleFailure.reservationCleanupFailed(errno: errno)
        }
        guard ArchiveFileIdentity(value) == identity, value.st_size == 0 else {
          throw ArchiveKeyLifecycleFailure.pathIdentityChanged
        }
        while hooks.unlinkAt(path.directory.descriptor, path.name) != 0 {
          let unlinkErrno = errno
          if unlinkErrno == EINTR { continue }
          throw ArchiveKeyLifecycleFailure.reservationCleanupFailed(errno: unlinkErrno)
        }
      } catch let failure as ArchiveKeyLifecycleFailure {
        if firstFailure == nil { firstFailure = failure }
      } catch {
        if firstFailure == nil {
          firstFailure = .reservationCleanupFailed(errno: EIO)
        }
      }
    }
    if ownsCreatedPaths, createdTape || createdIndex {
      do {
        try syncDistinctDirectories([tape.directory, index.directory], hooks: hooks)
      } catch let failure as ArchiveKeyLifecycleFailure {
        if firstFailure == nil { firstFailure = failure }
      } catch {
        if firstFailure == nil { firstFailure = .reservationCleanupFailed(errno: EIO) }
      }
    }
    if ownsDescriptors {
      _ = hooks.close(indexDescriptor)
      _ = hooks.close(tapeDescriptor)
      ownsDescriptors = false
    }
    ownsCreatedPaths = false
    if let firstFailure { throw firstFailure }
  }

  deinit { try? cleanup() }
}

final class ArchiveFileReservation {
  let fileDescriptor: Int32
  let directoryDescriptor: Int32
  private let path: ArchiveResolvedFile
  private let snapshot: ArchiveFileSnapshot
  private let created: Bool
  private let hooks: ArchiveKeyIOHooks
  private var ownsDescriptors = true
  private var ownsCreatedPath = true

  init(
    path: ArchiveResolvedFile,
    fileDescriptor: Int32,
    directoryDescriptor: Int32,
    snapshot: ArchiveFileSnapshot,
    created: Bool,
    hooks: ArchiveKeyIOHooks
  ) {
    self.path = path
    self.fileDescriptor = fileDescriptor
    self.directoryDescriptor = directoryDescriptor
    self.snapshot = snapshot
    self.created = created
    self.hooks = hooks
  }

  func validateForHandoff() throws {
    let current = try validateSecureFile(
      fileDescriptor, path: path, maximumSize: nil, hooks: hooks)
    guard current == snapshot else { throw ArchiveKeyLifecycleFailure.snapshotChanged }
    try validateDirectoryIdentity(path.directory, hooks: hooks)
  }

  func validatePathIdentityAfterOpen() throws {
    let current = try validateSecureFile(
      fileDescriptor, path: path, maximumSize: nil, hooks: hooks)
    guard current.identity == snapshot.identity,
      current.links == snapshot.links,
      current.mode == snapshot.mode
    else {
      throw ArchiveKeyLifecycleFailure.pathIdentityChanged
    }
    try validateDirectoryIdentity(path.directory, hooks: hooks)
  }

  func completeHandoff() {
    ownsDescriptors = false
    ownsCreatedPath = false
  }

  func cleanup() throws {
    var firstFailure: ArchiveKeyLifecycleFailure?
    if ownsCreatedPath, created {
      do {
        var value = stat()
        guard retryingFstatAt(path, &value, hooks: hooks) == 0 else {
          throw ArchiveKeyLifecycleFailure.reservationCleanupFailed(errno: errno)
        }
        guard ArchiveFileIdentity(value) == snapshot.identity, value.st_size == 0 else {
          throw ArchiveKeyLifecycleFailure.pathIdentityChanged
        }
        while hooks.unlinkAt(path.directory.descriptor, path.name) != 0 {
          let unlinkErrno = errno
          if unlinkErrno == EINTR { continue }
          throw ArchiveKeyLifecycleFailure.reservationCleanupFailed(errno: unlinkErrno)
        }
        try syncDistinctDirectories([path.directory], hooks: hooks)
      } catch let failure as ArchiveKeyLifecycleFailure {
        firstFailure = failure
      } catch {
        firstFailure = .reservationCleanupFailed(errno: EIO)
      }
    }
    if ownsDescriptors {
      _ = hooks.close(directoryDescriptor)
      _ = hooks.close(fileDescriptor)
      ownsDescriptors = false
    }
    ownsCreatedPath = false
    if let firstFailure { throw firstFailure }
  }

  deinit {
    if ownsDescriptors {
      _ = hooks.close(directoryDescriptor)
      _ = hooks.close(fileDescriptor)
    }
  }
}

struct ArchiveKeyDurableStore {
  let hooks: ArchiveKeyIOHooks

  init(hooks: ArchiveKeyIOHooks = ArchiveKeyIOHooks()) { self.hooks = hooks }

  func acquireGlobalLock(_ path: ArchiveResolvedFile) throws -> ArchiveProvisioningLock {
    try ArchiveProvisioningLock(path: path, hooks: hooks)
  }

  func canonicalProvisioningLock(applicationSupportRoot: URL) throws -> ArchiveResolvedFile {
    let root = try ArchiveValidatedKeyPaths.resolveDirectory(applicationSupportRoot, hooks: hooks)
    let evenScribe = try openOrCreatePrivateDirectory(
      named: "EvenScribe", parent: root, hooks: hooks)
    let roomRecorder = try openOrCreatePrivateDirectory(
      named: "RoomRecorder", parent: evenScribe, hooks: hooks)
    return ArchiveResolvedFile(
      url: roomRecorder.url.appendingPathComponent("archive-wrap-v1.lock"),
      directory: roomRecorder,
      name: "archive-wrap-v1.lock")
  }

  func existingArtifactIdentity(_ path: ArchiveResolvedFile) throws -> ArchiveFileIdentity? {
    var value = stat()
    let result = retryingFstatAt(path, &value, hooks: hooks)
    if result != 0, errno == ENOENT { return nil }
    guard result == 0 else { throw ArchiveKeyLifecycleFailure.fileStatFailed(errno: errno) }
    try validateSecureStat(value, maximumSize: nil)
    return ArchiveFileIdentity(value)
  }

  func loadKeywrapIfExists(_ path: ArchiveResolvedFile) throws -> ArchiveHeldKeywrap? {
    let descriptor = retryingOpenAt(
      path,
      flags: O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | O_EXLOCK,
      permissions: 0,
      hooks: hooks)
    if descriptor < 0, errno == ENOENT { return nil }
    guard descriptor >= 0 else {
      throw ArchiveKeyLifecycleFailure.fileOpenFailed(errno: errno)
    }
    do {
      let before = try validateSecureFile(
        descriptor,
        path: path,
        maximumSize: Int64(
          ArchiveKeywrapCodec.headerByteCount + ArchiveKeywrapCodec.maximumWrappedByteCount),
        hooks: hooks)
      let bytes = try readExactly(descriptor, count: Int(before.size), hooks: hooks)
      let after = try validateSecureFile(
        descriptor,
        path: path,
        maximumSize: Int64(
          ArchiveKeywrapCodec.headerByteCount + ArchiveKeywrapCodec.maximumWrappedByteCount),
        hooks: hooks)
      guard before == after else { throw ArchiveKeyLifecycleFailure.snapshotChanged }
      try fullSync(descriptor, hooks: hooks)
      try syncDirectory(path.directory, hooks: hooks)
      return ArchiveHeldKeywrap(
        bytes: bytes, identity: before.identity, descriptor: descriptor, close: hooks.close)
    } catch {
      _ = hooks.close(descriptor)
      throw error
    }
  }

  func publishCreateOnly(_ data: Data, at path: ArchiveResolvedFile) throws
    -> ArchiveDurablePublishResult
  {
    let temporaryName = ".\(path.name).tmp.\(hooks.temporarySuffix())"
    let temporary = ArchiveResolvedFile(
      url: path.directory.url.appendingPathComponent(temporaryName),
      directory: path.directory,
      name: temporaryName)
    let descriptor = retryingOpenAt(
      temporary,
      flags: O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | O_EXLOCK,
      permissions: S_IRUSR | S_IWUSR,
      hooks: hooks)
    guard descriptor >= 0 else {
      throw ArchiveKeyLifecycleFailure.temporaryOpenFailed(errno: errno)
    }
    var temporaryExists = true
    var descriptorOwned = true
    var cleanupAttempted = false
    func closeOwnedDescriptor() {
      guard descriptorOwned else { return }
      _ = hooks.close(descriptor)
      descriptorOwned = false
    }
    do {
      _ = try validateSecureFile(descriptor, path: temporary, maximumSize: nil, hooks: hooks)
      try writeAll(descriptor, data: data, hooks: hooks)
      try fullSync(descriptor, hooks: hooks)
      while hooks.renameExclusiveAt(path.directory.descriptor, temporaryName, path.name) != 0 {
        let renameErrno = errno
        if renameErrno == EINTR { continue }
        if renameErrno == EEXIST {
          closeOwnedDescriptor()
          cleanupAttempted = true
          try cleanupTemporary(temporary, hooks: hooks)
          temporaryExists = false
          guard let existing = try loadKeywrapIfExists(path) else {
            throw ArchiveKeyLifecycleFailure.pathIdentityChanged
          }
          return .alreadyExists(existing)
        }
        throw ArchiveKeyLifecycleFailure.renameFailed(errno: renameErrno)
      }
      temporaryExists = false
      do {
        try syncDirectory(path.directory, hooks: hooks)
      } catch {
        closeOwnedDescriptor()
        throw ArchiveKeyLifecycleFailure.publicationUncertain
      }
      var value = stat()
      guard retryingFstat(descriptor, &value, hooks: hooks) == 0 else {
        throw ArchiveKeyLifecycleFailure.fileStatFailed(errno: errno)
      }
      let held = ArchiveHeldKeywrap(
        bytes: data,
        identity: ArchiveFileIdentity(value),
        descriptor: descriptor,
        close: hooks.close)
      descriptorOwned = false
      return .published(held)
    } catch {
      closeOwnedDescriptor()
      if temporaryExists, !cleanupAttempted {
        cleanupAttempted = true
        do {
          try cleanupTemporary(temporary, hooks: hooks)
        } catch let cleanupFailure as ArchiveKeyLifecycleFailure {
          throw cleanupFailure
        } catch {
          throw ArchiveKeyLifecycleFailure.temporaryCleanupFailed(errno: EIO)
        }
      }
      throw error
    }
  }

  func reserveLanePair(
    tape: ArchiveResolvedFile,
    index: ArchiveResolvedFile,
    expectedIdentities: (tape: ArchiveFileIdentity, index: ArchiveFileIdentity)?
  ) throws
    -> ArchiveLaneReservation
  {
    var opened: [ReservedLaneOpen] = []
    do {
      for (position, path) in [tape, index].enumerated() {
        let expectedIdentity = position == 0 ? expectedIdentities?.tape : expectedIdentities?.index
        let created = expectedIdentity == nil
        let flags =
          O_RDWR | O_APPEND | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | O_EXLOCK
          | (created ? O_CREAT | O_EXCL : 0)
        let descriptor = retryingOpenAt(
          path,
          flags: flags,
          permissions: S_IRUSR | S_IWUSR,
          hooks: hooks)
        guard descriptor >= 0 else {
          throw ArchiveKeyLifecycleFailure.reservationFailed(errno: errno)
        }
        let openedLane = ReservedLaneOpen(
          path: path, descriptor: descriptor, created: created, hooks: hooks)
        opened.append(openedLane)
        try openedLane.captureIdentity()
        let snapshot = try validateSecureFile(
          descriptor, path: path, maximumSize: created ? 0 : nil, hooks: hooks)
        guard let capturedIdentity = openedLane.identity,
          snapshot.identity == capturedIdentity,
          expectedIdentity == nil || snapshot.identity == expectedIdentity
        else {
          throw ArchiveKeyLifecycleFailure.pathIdentityChanged
        }
        try fullSync(descriptor, hooks: hooks)
        let durableSnapshot = try validateSecureFile(
          descriptor, path: path, maximumSize: created ? 0 : nil, hooks: hooks)
        guard durableSnapshot.identity == snapshot.identity,
          durableSnapshot.size == snapshot.size
        else {
          throw ArchiveKeyLifecycleFailure.snapshotChanged
        }
        openedLane.snapshot = durableSnapshot
      }
      try syncDistinctDirectories([tape.directory, index.directory], hooks: hooks)
      return ArchiveLaneReservation(
        tape: tape,
        index: index,
        tapeDescriptor: opened[0].descriptor,
        indexDescriptor: opened[1].descriptor,
        tapeSnapshot: try opened[0].requireSnapshot(),
        indexSnapshot: try opened[1].requireSnapshot(),
        createdTape: opened[0].created,
        createdIndex: opened[1].created,
        hooks: hooks)
    } catch {
      var cleanupFailure: ArchiveKeyLifecycleFailure?
      for openedLane in opened.reversed() where openedLane.created {
        do {
          try openedLane.removeOwnedPath()
        } catch let failure as ArchiveKeyLifecycleFailure {
          if cleanupFailure == nil { cleanupFailure = failure }
        } catch {
          if cleanupFailure == nil { cleanupFailure = .reservationCleanupFailed(errno: EIO) }
        }
      }
      if !opened.isEmpty {
        do {
          try syncDistinctDirectories(
            opened.filter(\.created).map { $0.path.directory }, hooks: hooks)
        } catch let failure as ArchiveKeyLifecycleFailure {
          cleanupFailure = failure
        } catch {
          cleanupFailure = .reservationCleanupFailed(errno: EIO)
        }
      }
      for openedLane in opened { openedLane.closeOnce() }
      if let cleanupFailure { throw cleanupFailure }
      throw error
    }
  }

  func reserveFile(
    _ path: ArchiveResolvedFile,
    expectedIdentity: ArchiveFileIdentity?
  ) throws -> ArchiveFileReservation {
    let created = expectedIdentity == nil
    let flags =
      O_RDWR | O_APPEND | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | O_EXLOCK
      | (created ? O_CREAT | O_EXCL : 0)
    let descriptor = retryingOpenAt(
      path,
      flags: flags,
      permissions: S_IRUSR | S_IWUSR,
      hooks: hooks)
    guard descriptor >= 0 else {
      throw ArchiveKeyLifecycleFailure.reservationFailed(errno: errno)
    }
    var directoryDescriptor: Int32 = -1
    var createdIdentity: ArchiveFileIdentity?
    do {
      var value = stat()
      guard retryingFstat(descriptor, &value, hooks: hooks) == 0 else {
        throw ArchiveKeyLifecycleFailure.fileStatFailed(errno: errno)
      }
      createdIdentity = ArchiveFileIdentity(value)
      let initial = try validateSecureFile(
        descriptor, path: path, maximumSize: created ? 0 : nil, hooks: hooks)
      guard expectedIdentity == nil || initial.identity == expectedIdentity else {
        throw ArchiveKeyLifecycleFailure.pathIdentityChanged
      }
      try fullSync(descriptor, hooks: hooks)
      let durable = try validateSecureFile(
        descriptor, path: path, maximumSize: created ? 0 : nil, hooks: hooks)
      guard durable.identity == initial.identity, durable.size == initial.size else {
        throw ArchiveKeyLifecycleFailure.snapshotChanged
      }
      try syncDistinctDirectories([path.directory], hooks: hooks)
      directoryDescriptor = hooks.duplicate(path.directory.descriptor)
      guard directoryDescriptor >= 0 else {
        throw ArchiveKeyLifecycleFailure.reservationFailed(errno: errno)
      }
      return ArchiveFileReservation(
        path: path,
        fileDescriptor: descriptor,
        directoryDescriptor: directoryDescriptor,
        snapshot: durable,
        created: created,
        hooks: hooks)
    } catch {
      var cleanupFailure: ArchiveKeyLifecycleFailure?
      if created {
        do {
          guard let createdIdentity else {
            throw ArchiveKeyLifecycleFailure.pathIdentityChanged
          }
          var value = stat()
          guard retryingFstatAt(path, &value, hooks: hooks) == 0,
            ArchiveFileIdentity(value) == createdIdentity,
            value.st_size == 0
          else {
            throw ArchiveKeyLifecycleFailure.pathIdentityChanged
          }
          while hooks.unlinkAt(path.directory.descriptor, path.name) != 0 {
            let unlinkErrno = errno
            if unlinkErrno == EINTR { continue }
            throw ArchiveKeyLifecycleFailure.reservationCleanupFailed(errno: unlinkErrno)
          }
          try syncDistinctDirectories([path.directory], hooks: hooks)
        } catch let failure as ArchiveKeyLifecycleFailure {
          cleanupFailure = failure
        } catch {
          cleanupFailure = .reservationCleanupFailed(errno: EIO)
        }
      }
      if directoryDescriptor >= 0 { _ = hooks.close(directoryDescriptor) }
      _ = hooks.close(descriptor)
      if let cleanupFailure { throw cleanupFailure }
      throw error
    }
  }
}

private func openOrCreatePrivateDirectory(
  named name: String,
  parent: ArchiveDirectoryHandle,
  hooks: ArchiveKeyIOHooks
) throws -> ArchiveDirectoryHandle {
  let url = parent.url.appendingPathComponent(name, isDirectory: true)
  var created = false
  var descriptor: Int32 = -1
  while descriptor < 0 {
    descriptor = retryingOpenDirectoryAt(parent.descriptor, name: name, hooks: hooks)
    if descriptor >= 0 { break }
    let openErrno = errno
    guard openErrno == ENOENT else {
      throw ArchiveKeyLifecycleFailure.globalLockFailed(errno: openErrno)
    }
    var mkdirResult: Int32
    repeat {
      mkdirResult = hooks.makeDirectoryAt(parent.descriptor, name, mode_t(0o700))
    } while mkdirResult != 0 && errno == EINTR
    if mkdirResult == 0 {
      created = true
      descriptor = retryingOpenDirectoryAt(parent.descriptor, name: name, hooks: hooks)
      guard descriptor >= 0 else {
        throw ArchiveKeyLifecycleFailure.globalLockFailed(errno: errno)
      }
      break
    }
    guard errno == EEXIST else {
      throw ArchiveKeyLifecycleFailure.globalLockFailed(errno: errno)
    }
  }

  do {
    if created {
      while hooks.changeMode(descriptor, mode_t(0o700)) != 0 {
        let modeErrno = errno
        if modeErrno == EINTR { continue }
        throw ArchiveKeyLifecycleFailure.globalLockFailed(errno: modeErrno)
      }
    }
    var value = stat()
    guard retryingFstat(descriptor, &value, hooks: hooks) == 0 else {
      throw ArchiveKeyLifecycleFailure.globalLockFailed(errno: errno)
    }
    guard value.st_mode & S_IFMT == S_IFDIR,
      value.st_mode & mode_t(0o777) == mode_t(0o700)
    else {
      throw ArchiveKeyLifecycleFailure.globalLockFailed(errno: EACCES)
    }
    if created {
      try syncDirectoryDescriptor(descriptor, hooks: hooks)
      try syncDirectory(parent, hooks: hooks)
    }
    return ArchiveDirectoryHandle(
      url: url,
      descriptor: descriptor,
      identity: ArchiveFileIdentity(value),
      close: hooks.close)
  } catch {
    _ = hooks.close(descriptor)
    throw error
  }
}

private func retryingOpenDirectoryAt(
  _ parent: Int32,
  name: String,
  hooks: ArchiveKeyIOHooks
) -> Int32 {
  var descriptor: Int32
  repeat {
    descriptor = hooks.openAt(
      parent, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW, 0)
  } while descriptor < 0 && errno == EINTR
  return descriptor
}

private func syncDirectoryDescriptor(_ descriptor: Int32, hooks: ArchiveKeyIOHooks) throws {
  while hooks.directorySync(descriptor) != 0 {
    let syncErrno = errno
    if syncErrno == EINTR { continue }
    throw ArchiveKeyLifecycleFailure.globalLockFailed(errno: syncErrno)
  }
}

private func validateDirectoryIdentity(
  _ directory: ArchiveDirectoryHandle,
  hooks: ArchiveKeyIOHooks
) throws {
  var held = stat()
  guard retryingFstat(directory.descriptor, &held, hooks: hooks) == 0,
    held.st_mode & S_IFMT == S_IFDIR,
    ArchiveFileIdentity(held) == directory.identity
  else {
    throw ArchiveKeyLifecycleFailure.pathIdentityChanged
  }
  let currentDescriptor = retryingOpenPath(
    directory.url.path,
    flags: O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
    permissions: 0,
    hooks: hooks)
  guard currentDescriptor >= 0 else { throw ArchiveKeyLifecycleFailure.pathIdentityChanged }
  defer { _ = hooks.close(currentDescriptor) }
  var current = stat()
  guard retryingFstat(currentDescriptor, &current, hooks: hooks) == 0,
    ArchiveFileIdentity(current) == directory.identity
  else {
    throw ArchiveKeyLifecycleFailure.pathIdentityChanged
  }
}

private final class ReservedLaneOpen {
  let path: ArchiveResolvedFile
  let descriptor: Int32
  let created: Bool
  private let hooks: ArchiveKeyIOHooks
  private(set) var identity: ArchiveFileIdentity?
  var snapshot: ArchiveFileSnapshot?
  private var descriptorOwned = true

  init(path: ArchiveResolvedFile, descriptor: Int32, created: Bool, hooks: ArchiveKeyIOHooks) {
    self.path = path
    self.descriptor = descriptor
    self.created = created
    self.hooks = hooks
  }

  func captureIdentity() throws {
    var value = stat()
    guard retryingFstat(descriptor, &value, hooks: hooks) == 0 else {
      throw ArchiveKeyLifecycleFailure.fileStatFailed(errno: errno)
    }
    identity = ArchiveFileIdentity(value)
  }

  func requireSnapshot() throws -> ArchiveFileSnapshot {
    guard let snapshot else { throw ArchiveKeyLifecycleFailure.snapshotChanged }
    return snapshot
  }

  func removeOwnedPath() throws {
    guard created else { return }
    if identity == nil { try captureIdentity() }
    guard let identity else { throw ArchiveKeyLifecycleFailure.pathIdentityChanged }
    var value = stat()
    guard retryingFstatAt(path, &value, hooks: hooks) == 0 else {
      throw ArchiveKeyLifecycleFailure.reservationCleanupFailed(errno: errno)
    }
    guard ArchiveFileIdentity(value) == identity else {
      throw ArchiveKeyLifecycleFailure.pathIdentityChanged
    }
    while hooks.unlinkAt(path.directory.descriptor, path.name) != 0 {
      let unlinkErrno = errno
      if unlinkErrno == EINTR { continue }
      throw ArchiveKeyLifecycleFailure.reservationCleanupFailed(errno: unlinkErrno)
    }
  }

  func closeOnce() {
    guard descriptorOwned else { return }
    _ = hooks.close(descriptor)
    descriptorOwned = false
  }
}

private func validateSecureFile(
  _ descriptor: Int32,
  path: ArchiveResolvedFile,
  maximumSize: Int64?,
  hooks: ArchiveKeyIOHooks
) throws -> ArchiveFileSnapshot {
  var descriptorStat = stat()
  guard retryingFstat(descriptor, &descriptorStat, hooks: hooks) == 0 else {
    throw ArchiveKeyLifecycleFailure.fileStatFailed(errno: errno)
  }
  try validateSecureStat(descriptorStat, maximumSize: maximumSize)
  var pathStat = stat()
  guard retryingFstatAt(path, &pathStat, hooks: hooks) == 0 else {
    throw ArchiveKeyLifecycleFailure.pathIdentityChanged
  }
  let descriptorSnapshot = ArchiveFileSnapshot(descriptorStat)
  let pathSnapshot = ArchiveFileSnapshot(pathStat)
  guard descriptorSnapshot.identity == pathSnapshot.identity,
    descriptorSnapshot.size == pathSnapshot.size,
    descriptorSnapshot.links == pathSnapshot.links,
    descriptorSnapshot.mode == pathSnapshot.mode
  else {
    throw ArchiveKeyLifecycleFailure.pathIdentityChanged
  }
  return descriptorSnapshot
}

private func validateSecureStat(_ value: stat, maximumSize: Int64?) throws {
  guard value.st_mode & S_IFMT == S_IFREG else {
    throw ArchiveKeyLifecycleFailure.notRegularFile
  }
  guard value.st_nlink == 1 else {
    throw ArchiveKeyLifecycleFailure.hardLinkedFile(UInt64(value.st_nlink))
  }
  let mode = value.st_mode & mode_t(0o777)
  guard mode == mode_t(0o600) else {
    throw ArchiveKeyLifecycleFailure.existingModeMismatch(mode)
  }
  guard value.st_size >= 0 else {
    throw ArchiveKeyLifecycleFailure.fileTooLarge(value.st_size)
  }
  if let maximumSize, value.st_size > maximumSize {
    throw ArchiveKeyLifecycleFailure.fileTooLarge(value.st_size)
  }
}

private func readExactly(_ descriptor: Int32, count: Int, hooks: ArchiveKeyIOHooks) throws -> Data {
  var result = Data(count: count)
  try result.withUnsafeMutableBytes { bytes in
    var completed = 0
    while completed < count {
      let readCount = hooks.read(
        descriptor, bytes.baseAddress!.advanced(by: completed), count - completed)
      let readErrno = errno
      if readCount < 0 {
        if readErrno == EINTR { continue }
        throw ArchiveKeyLifecycleFailure.fileReadFailed(errno: readErrno)
      }
      guard readCount > 0 else { throw ArchiveKeyLifecycleFailure.unexpectedEndOfFile }
      completed += readCount
    }
  }
  return result
}

private func writeAll(_ descriptor: Int32, data: Data, hooks: ArchiveKeyIOHooks) throws {
  try data.withUnsafeBytes { bytes in
    var completed = 0
    while completed < bytes.count {
      let written = hooks.write(
        descriptor, bytes.baseAddress!.advanced(by: completed), bytes.count - completed)
      let writeErrno = errno
      if written < 0 {
        if writeErrno == EINTR { continue }
        throw ArchiveKeyLifecycleFailure.writeFailed(errno: writeErrno)
      }
      guard written > 0 else { throw ArchiveKeyLifecycleFailure.writeMadeNoProgress }
      completed += written
    }
  }
}

private func cleanupTemporary(_ path: ArchiveResolvedFile, hooks: ArchiveKeyIOHooks) throws {
  while hooks.unlinkAt(path.directory.descriptor, path.name) != 0 {
    let unlinkErrno = errno
    if unlinkErrno == EINTR { continue }
    if unlinkErrno == ENOENT { return }
    throw ArchiveKeyLifecycleFailure.temporaryCleanupFailed(errno: unlinkErrno)
  }
  try syncDirectory(path.directory, hooks: hooks)
}

private func fullSync(_ descriptor: Int32, hooks: ArchiveKeyIOHooks) throws {
  while hooks.fullSync(descriptor) != 0 {
    let syncErrno = errno
    if syncErrno == EINTR { continue }
    throw ArchiveKeyLifecycleFailure.fullSyncFailed(errno: syncErrno)
  }
}

private func syncDirectory(_ directory: ArchiveDirectoryHandle, hooks: ArchiveKeyIOHooks) throws {
  while hooks.directorySync(directory.descriptor) != 0 {
    let syncErrno = errno
    if syncErrno == EINTR { continue }
    throw ArchiveKeyLifecycleFailure.directorySyncFailed(errno: syncErrno)
  }
}

private func syncDistinctDirectories(
  _ directories: [ArchiveDirectoryHandle], hooks: ArchiveKeyIOHooks
) throws {
  var synchronized: Set<ArchiveFileIdentity> = []
  for directory in directories where synchronized.insert(directory.identity).inserted {
    try syncDirectory(directory, hooks: hooks)
  }
}

private func retryingOpenPath(
  _ path: String, flags: Int32, permissions: mode_t, hooks: ArchiveKeyIOHooks
) -> Int32 {
  var descriptor: Int32
  repeat {
    descriptor = hooks.openPath(path, flags, permissions)
  } while descriptor < 0
    && errno == EINTR
  return descriptor
}

private func retryingOpenAt(
  _ path: ArchiveResolvedFile, flags: Int32, permissions: mode_t, hooks: ArchiveKeyIOHooks
) -> Int32 {
  var descriptor: Int32
  repeat {
    descriptor = hooks.openAt(path.directory.descriptor, path.name, flags, permissions)
  } while descriptor < 0 && errno == EINTR
  return descriptor
}

private func retryingFstat(
  _ descriptor: Int32, _ value: inout stat, hooks: ArchiveKeyIOHooks
) -> Int32 {
  var result: Int32
  repeat { result = hooks.fstat(descriptor, &value) } while result != 0 && errno == EINTR
  return result
}

private func retryingFstatAt(
  _ path: ArchiveResolvedFile, _ value: inout stat, hooks: ArchiveKeyIOHooks
) -> Int32 {
  var result: Int32
  repeat {
    result = hooks.fstatAt(
      path.directory.descriptor, path.name, &value, AT_SYMLINK_NOFOLLOW)
  } while result != 0 && errno == EINTR
  return result
}
