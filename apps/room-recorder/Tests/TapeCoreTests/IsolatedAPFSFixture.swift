import Darwin
import Foundation

struct IsolatedAPFSFixture {
  let rootURL: URL
  let imageURL: URL
  let mountURL: URL
  let mountedDevice: String
  let wholeDevice: String
  let deviceIdentifier: String
  let parentWholeDisk: String
  let volumeUUID: String

  static func run(
    label: String,
    imageMiB: Int = 128,
    body: (URL) throws -> Void
  ) throws {
    guard imageMiB >= 128 else { throw IsolatedAPFSError("image must be at least 128 MiB") }
    let imageBytes = Int64(imageMiB) * 1_024 * 1_024
    let free = try fileSystemFreeBytes(FileManager.default.temporaryDirectory)
    guard free >= imageBytes * 3 else {
      throw IsolatedAPFSError(
        "APFS fixture requires at least \(imageMiB * 3) MiB host free space")
    }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "eta-apfs-\(label)-\(UUID().uuidString.lowercased())",
      isDirectory: true
    )
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    let identifier = UUID().uuidString.lowercased()
    let image = root.appendingPathComponent("\(identifier).sparseimage")
    let mount = root.appendingPathComponent("mount-\(identifier)", isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: mount, withIntermediateDirectories: false)
    } catch {
      do {
        try FileManager.default.removeItem(at: root)
      } catch let cleanupError {
        throw IsolatedAPFSError(
          "mount-directory creation failed: \(error.localizedDescription); cleanup failed: "
            + cleanupError.localizedDescription)
      }
      throw error
    }
    do {
      _ = try command(
        "/usr/bin/hdiutil",
        [
          "create", "-size", "\(imageMiB)m", "-fs", "APFS",
          "-volname", "eta-\(label)-\(identifier)", "-type", "SPARSE", "-ov", image.path,
        ],
        timeout: 60
      )
    } catch {
      do {
        try FileManager.default.removeItem(at: root)
      } catch let cleanupError {
        throw IsolatedAPFSError(
          "image creation failed: \(error.localizedDescription); cleanup failed: "
            + cleanupError.localizedDescription)
      }
      throw error
    }

    let fixture: IsolatedAPFSFixture
    do {
      let result = try command(
        "/usr/bin/hdiutil",
        ["attach", "-plist", "-nobrowse", "-mountpoint", mount.path, image.path],
        timeout: 60
      )
      fixture = try parseAndVerifyAttachment(result.stdout, imageURL: image, mountURL: mount)
    } catch {
      print("APFS fixture retained after unidentified attach attempt: \(root.path)")
      throw error
    }

    var bodyError: Error?
    do {
      try body(fixture.mountURL)
    } catch {
      bodyError = error
    }
    let bodyContext = bodyError.map { "; body failed: \($0.localizedDescription)" } ?? ""
    guard fixture.detach() else {
      throw IsolatedAPFSError(
        "APFS fixture retained because detach was not verified: \(root.path)" + bodyContext)
    }
    guard fixture.removeDetached() else {
      throw IsolatedAPFSError(
        "detached APFS fixture artifacts were retained: \(root.path)" + bodyContext)
    }
    if let bodyError { throw bodyError }
  }

  private static func parseAndVerifyAttachment(
    _ plistData: Data,
    imageURL: URL,
    mountURL: URL
  ) throws -> IsolatedAPFSFixture {
    let plist = try require(
      try PropertyListSerialization.propertyList(from: plistData, format: nil) as? [String: Any],
      "attach output is not a property list"
    )
    let entities = try require(plist["system-entities"] as? [[String: Any]], "missing entities")
    let mounted = try require(
      entities.first {
        guard let path = $0["mount-point"] as? String else { return false }
        return pathsEqual(URL(fileURLWithPath: path), mountURL)
      },
      "attach output does not identify the requested mount"
    )
    let mountedDevice = try require(mounted["dev-entry"] as? String, "missing mounted device")
    let whole = try require(
      entities.first {
        guard let entry = $0["dev-entry"] as? String else { return false }
        let suffix = entry.dropFirst("/dev/disk".count)
        return $0["content-hint"] as? String == "GUID_partition_scheme"
          && entry.hasPrefix("/dev/disk") && !suffix.isEmpty && suffix.allSatisfy(\.isNumber)
      },
      "attach output does not identify the whole disk"
    )
    let wholeDevice = try require(whole["dev-entry"] as? String, "missing whole device")
    let infoData = try command(
      "/usr/sbin/diskutil", ["info", "-plist", mountedDevice], timeout: 30
    ).stdout
    let info = try require(
      try PropertyListSerialization.propertyList(from: infoData, format: nil) as? [String: Any],
      "disk info is not a property list"
    )
    let deviceIdentifier = try require(info["DeviceIdentifier"] as? String, "missing device id")
    let parentWholeDisk = try require(info["ParentWholeDisk"] as? String, "missing parent disk")
    let volumeUUID = try require(info["VolumeUUID"] as? String, "missing volume UUID")
    guard (info["FilesystemType"] as? String)?.lowercased() == "apfs" else {
      throw IsolatedAPFSError("attached fixture is not APFS")
    }
    guard
      (info["MountPoint"] as? String).map({
        pathsEqual(URL(fileURLWithPath: $0), mountURL)
      }) == true
    else { throw IsolatedAPFSError("disk info mount does not match fixture") }

    var mountedFS = statfs()
    guard statfs(mountURL.path, &mountedFS) == 0 else {
      throw IsolatedAPFSError("cannot stat mounted fixture errno \(errno)")
    }
    let type = withUnsafePointer(to: &mountedFS.f_fstypename) {
      $0.withMemoryRebound(to: CChar.self, capacity: Int(MFSNAMELEN)) { String(cString: $0) }
    }
    let from = withUnsafePointer(to: &mountedFS.f_mntfromname) {
      $0.withMemoryRebound(to: CChar.self, capacity: Int(MNAMELEN)) { String(cString: $0) }
    }
    let on = withUnsafePointer(to: &mountedFS.f_mntonname) {
      $0.withMemoryRebound(to: CChar.self, capacity: Int(MNAMELEN)) { String(cString: $0) }
    }
    guard type.lowercased() == "apfs", from == mountedDevice,
      pathsEqual(URL(fileURLWithPath: on), mountURL)
    else { throw IsolatedAPFSError("mounted filesystem identity does not match attach output") }

    var hostFS = statfs()
    guard statfs(imageURL.deletingLastPathComponent().path, &hostFS) == 0 else {
      throw IsolatedAPFSError("cannot stat host filesystem errno \(errno)")
    }
    guard
      hostFS.f_fsid.val.0 != mountedFS.f_fsid.val.0
        || hostFS.f_fsid.val.1 != mountedFS.f_fsid.val.1
    else { throw IsolatedAPFSError("fixture is not isolated from the host filesystem") }

    return IsolatedAPFSFixture(
      rootURL: canonical(imageURL.deletingLastPathComponent()),
      imageURL: canonical(imageURL),
      mountURL: canonical(mountURL),
      mountedDevice: mountedDevice,
      wholeDevice: wholeDevice,
      deviceIdentifier: deviceIdentifier,
      parentWholeDisk: parentWholeDisk,
      volumeUUID: volumeUUID
    )
  }

  private func identityMatches() -> Bool {
    guard imageIdentityMatches(),
      let result = try? Self.command(
        "/usr/sbin/diskutil", ["info", "-plist", mountedDevice], timeout: 10),
      let object = try? PropertyListSerialization.propertyList(from: result.stdout, format: nil),
      let info = object as? [String: Any]
    else { return false }
    return info["DeviceIdentifier"] as? String == deviceIdentifier
      && info["ParentWholeDisk"] as? String == parentWholeDisk
      && info["VolumeUUID"] as? String == volumeUUID
      && (info["MountPoint"] as? String).map {
        Self.pathsEqual(URL(fileURLWithPath: $0), mountURL)
      } == true
      && (info["FilesystemType"] as? String)?.lowercased() == "apfs"
  }

  private func imageIdentityMatches() -> Bool {
    guard let result = try? Self.command("/usr/bin/hdiutil", ["info", "-plist"], timeout: 10),
      let object = try? PropertyListSerialization.propertyList(from: result.stdout, format: nil),
      let plist = object as? [String: Any],
      let images = plist["images"] as? [[String: Any]],
      let image = images.first(where: {
        guard let path = $0["image-path"] as? String else { return false }
        return Self.pathsEqual(URL(fileURLWithPath: path), imageURL)
      }),
      let entities = image["system-entities"] as? [[String: Any]]
    else { return false }
    let devices = Set(entities.compactMap { $0["dev-entry"] as? String })
    return devices.contains(wholeDevice) && devices.contains(mountedDevice)
  }

  private func attachmentState() -> Bool? {
    guard let result = try? Self.command("/usr/bin/hdiutil", ["info", "-plist"], timeout: 10),
      let object = try? PropertyListSerialization.propertyList(from: result.stdout, format: nil),
      let plist = object as? [String: Any],
      let images = plist["images"] as? [[String: Any]]
    else { return nil }
    return images.contains {
      guard let path = $0["image-path"] as? String else { return false }
      return Self.pathsEqual(URL(fileURLWithPath: path), imageURL)
    }
  }

  private func detach() -> Bool {
    guard let attached = attachmentState() else { return false }
    if !attached { return true }
    guard identityMatches() else { return false }
    _ = try? Self.command("/usr/bin/hdiutil", ["detach", wholeDevice], timeout: 30)
    if attachmentState() == false { return true }
    guard identityMatches() else { return false }
    _ = try? Self.command(
      "/usr/bin/hdiutil", ["detach", "-force", wholeDevice], timeout: 30)
    return attachmentState() == false
  }

  private func removeDetached() -> Bool {
    guard attachmentState() == false else { return false }
    guard rmdir(mountURL.path) == 0 || errno == ENOENT else { return false }
    guard unlink(imageURL.path) == 0 || errno == ENOENT else { return false }
    return rmdir(rootURL.path) == 0 || errno == ENOENT
  }

  private static func fileSystemFreeBytes(_ url: URL) throws -> Int64 {
    guard
      let value = try FileManager.default.attributesOfFileSystem(forPath: url.path)[.systemFreeSize]
        as? NSNumber
    else { throw IsolatedAPFSError("cannot read host free space") }
    return value.int64Value
  }

  private static func command(
    _ executable: String,
    _ arguments: [String],
    timeout: TimeInterval = 30
  ) throws -> CommandResult {
    let capture = FileManager.default.temporaryDirectory.appendingPathComponent(
      "eta-apfs-command-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: capture, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: capture) }
    let outputURL = capture.appendingPathComponent("stdout")
    let errorURL = capture.appendingPathComponent("stderr")
    guard FileManager.default.createFile(atPath: outputURL.path, contents: nil),
      FileManager.default.createFile(atPath: errorURL.path, contents: nil)
    else { throw IsolatedAPFSError("cannot create command output files") }
    let output = try FileHandle(forWritingTo: outputURL)
    let error = try FileHandle(forWritingTo: errorURL)
    defer {
      try? output.close()
      try? error.close()
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = output
    process.standardError = error
    try process.run()
    let deadline = Date().addingTimeInterval(timeout)
    while process.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
    if process.isRunning {
      process.terminate()
      let terminationDeadline = Date().addingTimeInterval(2)
      while process.isRunning, Date() < terminationDeadline { Thread.sleep(forTimeInterval: 0.05) }
      if process.isRunning { _ = kill(process.processIdentifier, SIGKILL) }
      let killDeadline = Date().addingTimeInterval(2)
      while process.isRunning, Date() < killDeadline { Thread.sleep(forTimeInterval: 0.05) }
      if !process.isRunning { process.waitUntilExit() }
      guard !process.isRunning else {
        throw IsolatedAPFSError("command remained alive after SIGKILL: \(executable)")
      }
      throw IsolatedAPFSError(
        "command timed out: \(executable) \(arguments.joined(separator: " "))")
    }
    process.waitUntilExit()
    let stdout = try Data(contentsOf: outputURL)
    let stderr = String(decoding: try Data(contentsOf: errorURL), as: UTF8.self)
    guard process.terminationReason == .exit, process.terminationStatus == 0 else {
      throw IsolatedAPFSError(
        "command failed \(process.terminationStatus): \(executable) "
          + "\(arguments.joined(separator: " ")): \(stderr)"
      )
    }
    return CommandResult(stdout: stdout)
  }

  private static func require<T>(_ value: T?, _ message: String = "missing fixture value") throws
    -> T
  {
    guard let value else { throw IsolatedAPFSError(message) }
    return value
  }

  private static func canonical(_ url: URL) -> URL {
    url.standardizedFileURL.resolvingSymlinksInPath()
  }

  private static func pathsEqual(_ lhs: URL, _ rhs: URL) -> Bool {
    canonical(lhs) == canonical(rhs)
  }
}

private struct CommandResult {
  let stdout: Data
}

struct IsolatedAPFSError: Error, LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
