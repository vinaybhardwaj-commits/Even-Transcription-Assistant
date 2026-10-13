import CryptoKit
import Darwin
import Foundation
import KioskHealthCore

/// Everything an update does to the disk and the network, behind one seam so the state machine can be driven without a pkg,
/// a bundle or a server. The real implementation is `SystemUpdateDisk`; tests use it on temp directories (everything except
/// ownership, which needs root) and fake only the download.
public protocol UpdateDisk: Sendable {
  func ensureDirectory(_ path: String) -> Bool
  func exists(_ path: String) -> Bool
  func write(_ data: Data, to path: String, mode: UInt16) -> Bool
  func read(_ path: String, maxBytes: Int) -> Data?
  func remove(_ path: String)
  func rename(_ from: String, to: String) -> Bool
  func sha256(ofFileAt path: String) -> String?
  func size(ofFileAt path: String) -> Int64?
  /// The user's bundle, copied AS THE USER into a root-only directory (nothing of that tree is read as root).
  func snapshotBundle(_ app: String, user: String, to destination: String) -> Bool
  /// A root-owned tree, copied (symlinks stay symlinks) and handed to the user.
  func restoreTree(from source: String, to destination: String, uid: UInt32, gid: UInt32) -> Bool
  func download(_ url: URL, to path: String, maxBytes: Int64) -> Bool
  /// The root-only marker the watchdog honours while an install is in flight.
  func touchInstallMarker()
  func clearInstallMarker()
}

public struct SystemUpdateDisk: UpdateDisk {
  let reader: UserFileAccess
  let supportDirectory: String
  /// False in tests, which cannot become root.
  let setOwner: Bool
  let downloader: UpdateDownloading

  public init(
    reader: UserFileAccess, supportDirectory: String = HelperPaths.supportDirectory, setOwner: Bool = true,
    downloader: UpdateDownloading = URLSessionUpdateDownloader()
  ) {
    self.reader = reader
    self.supportDirectory = supportDirectory
    self.setOwner = setOwner
    self.downloader = downloader
  }

  public func ensureDirectory(_ path: String) -> Bool {
    var info = stat()
    if lstat(path, &info) == 0 { return (info.st_mode & S_IFMT) == S_IFDIR }
    do { try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) } catch { return false }
    return true
  }

  public func exists(_ path: String) -> Bool {
    var info = stat()
    return lstat(path, &info) == 0
  }

  public func write(_ data: Data, to path: String, mode: UInt16) -> Bool {
    SystemChromePolicyFiles(setOwner: setOwner).writeAtomic(path, data: data, mode: mode)
  }

  public func read(_ path: String, maxBytes: Int) -> Data? { HardenedFile.readWhole(path, maxBytes: maxBytes) }

  public func remove(_ path: String) { try? FileManager.default.removeItem(atPath: path) }

  public func rename(_ from: String, to: String) -> Bool { Darwin.rename(from, to) == 0 }

  public func sha256(ofFileAt path: String) -> String? {
    guard let handle = FileHandle(forReadingAtPath: path) else { return nil }
    defer { try? handle.close() }
    var hasher = SHA256()
    while let chunk = try? handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  public func size(ofFileAt path: String) -> Int64? {
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return nil }
    return Int64(info.st_size)
  }

  public func download(_ url: URL, to path: String, maxBytes: Int64) -> Bool {
    downloader.download(url, to: path, maxBytes: maxBytes)
  }

  public func touchInstallMarker() {
    let marker = supportDirectory + "/" + HelperPaths.installMarkerFile
    _ = write(Data("helper update in progress\n".utf8), to: marker, mode: 0o644)
  }

  public func clearInstallMarker() { remove(supportDirectory + "/" + HelperPaths.installMarkerFile) }

  // MARK: Snapshot, as the user

  /// Limits for one bundle: the recorder app is ~100 MB with its encoder.
  static let maxBundleBytes: Int64 = 1 << 30
  static let maxBundleEntries = 20_000
  static let maxDepth = 24

  public func snapshotBundle(_ app: String, user: String, to destination: String) -> Bool {
    remove(destination)
    var budget = (bytes: Int64(0), entries: 0)
    let ok = copyAsUser(from: app, to: destination, user: user, depth: 0, budget: &budget)
    if !ok { remove(destination) }
    return ok
  }

  private func copyAsUser(from source: String, to target: String, user: String, depth: Int, budget: inout (bytes: Int64, entries: Int)) -> Bool {
    guard depth <= Self.maxDepth, budget.entries < Self.maxBundleEntries, let info = reader.info(source, user: user) else { return false }
    budget.entries += 1
    if info.isSymlink {
      // A link is copied AS A LINK; what it points at is never read.
      guard let link = reader.linkTarget(source, user: user) else { return false }
      return symlink(link, target) == 0
    }
    if info.isDirectory {
      guard mkdir(target, 0o755) == 0, let names = reader.entries(source, user: user) else { return false }
      for name in names.sorted() {
        guard !name.contains("/"), name != ".", name != ".." else { return false }
        if !copyAsUser(from: source + "/" + name, to: target + "/" + name, user: user, depth: depth + 1, budget: &budget) { return false }
      }
      return true
    }
    // A plain file with ONE link only: a hard link to something else is refused, not copied.
    guard info.isRegular, info.nlink == 1 else { return false }
    budget.bytes += Int64(info.size)
    guard budget.bytes <= Self.maxBundleBytes else { return false }
    let fd = open(target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var offset: UInt64 = 0
    while offset < info.size {
      guard let chunk = reader.readRange(source, user: user, offset: offset, maxBytes: 1 << 20), !chunk.isEmpty else { return false }
      let written = chunk.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
      guard written == chunk.count else { return false }
      offset += UInt64(chunk.count)
    }
    // Executable bits survive; setuid and setgid never do.
    return fsync(fd) == 0 && fchmod(fd, mode_t(info.mode & 0o755)) == 0
  }

  // MARK: Restore, from root's own copy

  public func restoreTree(from source: String, to destination: String, uid: UInt32, gid: UInt32) -> Bool {
    remove(destination)
    do { try FileManager.default.copyItem(atPath: source, toPath: destination) } catch { return false }
    guard setOwner else { return true }
    return chownTree(destination, uid: uid, gid: gid)
  }

  /// `lchown` on a tree that root has just made and that nobody else can reach yet (it sits in a root-only directory).
  private func chownTree(_ path: String, uid: UInt32, gid: UInt32) -> Bool {
    guard lchown(path, uid, gid) == 0 else { return false }
    var info = stat()
    guard lstat(path, &info) == 0 else { return false }
    guard (info.st_mode & S_IFMT) == S_IFDIR, let names = try? FileManager.default.contentsOfDirectory(atPath: path) else { return true }
    for name in names where !chownTree(path + "/" + name, uid: uid, gid: gid) { return false }
    return true
  }
}

// MARK: - The download

public protocol UpdateDownloading: Sendable {
  func download(_ url: URL, to path: String, maxBytes: Int64) -> Bool
}

/// HTTPS to an allowed host only, redirects included, at most `maxBytes`, into a root-only file. No cookie, no credential.
public struct URLSessionUpdateDownloader: UpdateDownloading {
  public init() {}

  final class Fence: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
      _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
      completionHandler: @escaping (URLRequest?) -> Void
    ) {
      // A redirect to a host that is not on the list, or off https, is not followed.
      completionHandler(request.url.flatMap { ReleaseRecord.validatedURL($0.absoluteString) } == nil ? nil : request)
    }
  }

  public func download(_ url: URL, to path: String, maxBytes: Int64) -> Bool {
    guard ReleaseRecord.validatedURL(url.absoluteString) != nil else { return false }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.timeoutIntervalForRequest = 60
    configuration.timeoutIntervalForResource = 20 * 60
    let session = URLSession(configuration: configuration, delegate: Fence(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
    request.httpShouldHandleCookies = false
    let done = DispatchSemaphore(value: 0)
    let outcome = Outcome()
    session.downloadTask(with: request) { location, response, error in
      defer { done.signal() }
      guard error == nil, let location, let http = response as? HTTPURLResponse, http.statusCode == 200 else { return }
      var info = stat()
      guard stat(location.path, &info) == 0, Int64(info.st_size) <= maxBytes else { return }
      // Moved into place: the temporary file is root's, in a directory the user cannot reach.
      try? FileManager.default.removeItem(atPath: path)
      guard (try? FileManager.default.moveItem(atPath: location.path, toPath: path)) != nil else { return }
      chmod(path, 0o600)
      outcome.ok = true
    }.resume()
    _ = done.wait(timeout: .now() + 25 * 60)
    return outcome.ok
  }

  private final class Outcome: @unchecked Sendable { var ok = false }
}
