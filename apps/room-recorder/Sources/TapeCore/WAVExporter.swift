import Darwin
import Foundation

public enum WAVExporter {
  static let maximumPCMBytes =
    (Int64(UInt32.max) - 36) / TapeConstants.bytesPerSample * TapeConstants.bytesPerSample

  struct Hooks {
    var afterSnapshot: () throws -> Void = {}
    var rename: (URL, URL) -> Int32? = { source, destination in
      guard Darwin.rename(source.path, destination.path) != 0 else { return nil }
      return errno
    }
  }

  public static func export(pcmURL: URL, wavURL: URL) throws {
    try export(pcmURL: pcmURL, wavURL: wavURL, hooks: Hooks())
  }

  static func export(pcmURL: URL, wavURL: URL, hooks: Hooks) throws {
    guard FileManager.default.fileExists(atPath: pcmURL.path) else {
      throw TapeError.missingFile("tape.pcm")
    }
    let indexURL = pcmURL.deletingLastPathComponent().appendingPathComponent("tape.idx")
    for protected in [pcmURL, indexURL] {
      let samePath = try sameReservedLocation(protected, wavURL)
      let bothExist =
        FileManager.default.fileExists(atPath: protected.path)
        && FileManager.default.fileExists(atPath: wavURL.path)
      let aliasesProtectedFile = bothExist ? try sameFile(protected, wavURL) : false
      if samePath || aliasesProtectedFile {
        throw TapeError.io("WAV destination resolves to \(protected.lastPathComponent)")
      }
    }

    let inputFD = open(pcmURL.path, O_RDONLY)
    guard inputFD >= 0 else {
      throw TapeError.io("cannot open tape.pcm: \(String(cString: strerror(errno)))")
    }
    let input = FileHandle(fileDescriptor: inputFD, closeOnDealloc: true)
    defer { try? input.close() }
    var sourceStat = stat()
    guard fstat(inputFD, &sourceStat) == 0 else {
      throw TapeError.io("cannot stat tape.pcm: \(String(cString: strerror(errno)))")
    }
    let size = sourceStat.st_size
    guard size <= maximumPCMBytes else {
      throw TapeError.fileTooLarge("PCM is too large for a classic RIFF/WAV file")
    }
    guard size % TapeConstants.bytesPerSample == 0 else { throw TapeError.oddPCMSize(size) }
    try hooks.afterSnapshot()

    let temporary = wavURL.deletingLastPathComponent()
      .appendingPathComponent(".\(wavURL.lastPathComponent).\(UUID().uuidString).tmp")
    guard FileManager.default.createFile(atPath: temporary.path, contents: nil) else {
      throw TapeError.io("cannot create temporary WAV file")
    }
    do {
      let output = try performIO("cannot open temporary WAV file") {
        try FileHandle(forWritingTo: temporary)
      }
      defer { try? output.close() }
      try performIO("cannot write temporary WAV header") {
        try output.write(contentsOf: header(dataSize: UInt32(size)))
      }

      var remaining = size
      var outputOffset: UInt64 = 44
      while remaining > 0 {
        let requested = min(1_048_576, Int(remaining))
        let chunk = try performIO("cannot read tape.pcm during export") {
          try input.read(upToCount: requested)
        }
        guard let chunk, !chunk.isEmpty else {
          throw TapeError.io("tape.pcm became shorter during export")
        }
        outputOffset += UInt64(chunk.count)
        if chunk.allSatisfy({ $0 == 0 }) {
          try performIO("cannot seek temporary WAV file") {
            try output.seek(toOffset: outputOffset)
          }
        } else {
          try performIO("cannot write temporary WAV payload") {
            try output.write(contentsOf: chunk)
          }
        }
        remaining -= Int64(chunk.count)
      }
      try performIO("cannot set temporary WAV length") {
        try output.truncate(atOffset: UInt64(44) + UInt64(size))
      }
      try performIO("cannot synchronize temporary WAV file") { try output.synchronize() }
      try performIO("cannot close temporary WAV file") { try output.close() }
      if let renameErrno = hooks.rename(temporary, wavURL) {
        throw TapeError.io(
          "cannot install WAV file: errno \(renameErrno) "
            + "(\(String(cString: strerror(renameErrno))))")
      }
    } catch {
      let exportError = error
      let cleanupResult = unlink(temporary.path)
      let cleanupErrno = errno
      if cleanupResult != 0, cleanupErrno != ENOENT {
        throw TapeError.io(
          "\(exportError.localizedDescription); temporary WAV retained at \(temporary.path): "
            + "errno \(cleanupErrno) (\(String(cString: strerror(cleanupErrno))))"
        )
      }
      throw exportError
    }
  }

  public static func header(dataSize: UInt32) throws -> Data {
    guard Int64(dataSize) <= maximumPCMBytes else {
      throw TapeError.fileTooLarge("PCM is too large for a classic RIFF/WAV file")
    }
    guard Int64(dataSize) % TapeConstants.bytesPerSample == 0 else {
      throw TapeError.oddPCMSize(Int64(dataSize))
    }
    var data = Data()
    func ascii(_ value: String) { data.append(contentsOf: value.utf8) }
    func u16(_ value: UInt16) {
      var little = value.littleEndian
      withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
    }
    func u32(_ value: UInt32) {
      var little = value.littleEndian
      withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
    }
    ascii("RIFF")
    u32(36 + dataSize)
    ascii("WAVE")
    ascii("fmt ")
    u32(16)
    u16(1)
    u16(UInt16(TapeConstants.channels))
    u32(UInt32(TapeConstants.sampleRate))
    u32(UInt32(TapeConstants.bytesPerSecond))
    u16(UInt16(TapeConstants.bytesPerSample))
    u16(UInt16(TapeConstants.bitsPerSample))
    ascii("data")
    u32(dataSize)
    return data
  }

  private static func sameFile(_ lhs: URL, _ rhs: URL) throws -> Bool {
    let leftFD = open(lhs.path, O_RDONLY)
    guard leftFD >= 0 else {
      throw TapeError.io(
        "cannot open protected tape file for identity check: \(String(cString: strerror(errno)))")
    }
    defer { close(leftFD) }
    let rightFD = open(rhs.path, O_RDONLY)
    guard rightFD >= 0 else {
      throw TapeError.io(
        "cannot open WAV destination for identity check: \(String(cString: strerror(errno)))")
    }
    defer { close(rightFD) }
    var left = stat()
    var right = stat()
    guard fstat(leftFD, &left) == 0 else {
      throw TapeError.io("cannot stat protected tape file: \(String(cString: strerror(errno)))")
    }
    guard fstat(rightFD, &right) == 0 else {
      throw TapeError.io("cannot stat WAV destination: \(String(cString: strerror(errno)))")
    }
    return left.st_dev == right.st_dev && left.st_ino == right.st_ino
  }

  private static func sameReservedLocation(_ lhs: URL, _ rhs: URL) throws -> Bool {
    let left = lhs.standardizedFileURL
    let right = rhs.standardizedFileURL
    if left.path == right.path { return true }
    guard
      left.lastPathComponent.caseInsensitiveCompare(right.lastPathComponent) == .orderedSame,
      FileManager.default.fileExists(atPath: left.deletingLastPathComponent().path),
      FileManager.default.fileExists(atPath: right.deletingLastPathComponent().path)
    else { return false }
    return try sameFile(left.deletingLastPathComponent(), right.deletingLastPathComponent())
  }

  private static func performIO<T>(_ context: String, _ operation: () throws -> T) throws -> T {
    do {
      return try operation()
    } catch let tapeError as TapeError {
      throw tapeError
    } catch {
      let nsError = error as NSError
      if let code = posixCode(nsError) {
        throw TapeError.io(
          "\(context): errno \(code) (\(String(cString: strerror(code))))")
      }
      throw TapeError.io("\(context): \(error.localizedDescription)")
    }
  }

  private static func posixCode(_ error: NSError) -> Int32? {
    if error.domain == NSPOSIXErrorDomain, error.code > 0, error.code <= Int(Int32.max) {
      return Int32(error.code)
    }
    if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
      return posixCode(underlying)
    }
    return nil
  }
}
