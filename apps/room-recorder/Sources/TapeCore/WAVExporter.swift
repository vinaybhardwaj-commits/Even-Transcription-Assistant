import Darwin
import Foundation

public enum WAVExporter {
  public static func export(pcmURL: URL, wavURL: URL) throws {
    guard FileManager.default.fileExists(atPath: pcmURL.path) else {
      throw TapeError.missingFile("tape.pcm")
    }
    let indexURL = pcmURL.deletingLastPathComponent().appendingPathComponent("tape.idx")
    for protected in [pcmURL, indexURL] {
      let samePath = protected.standardizedFileURL.path == wavURL.standardizedFileURL.path
      let bothExist =
        FileManager.default.fileExists(atPath: protected.path)
        && FileManager.default.fileExists(atPath: wavURL.path)
      let aliasesProtectedFile = bothExist ? try sameFile(protected, wavURL) : false
      if samePath || aliasesProtectedFile {
        throw TapeError.io("WAV destination resolves to \(protected.lastPathComponent)")
      }
    }
    let attributes = try FileManager.default.attributesOfItem(atPath: pcmURL.path)
    let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
    guard size % TapeConstants.bytesPerSample == 0 else { throw TapeError.oddPCMSize(size) }
    guard size <= Int64(UInt32.max) - 36 else {
      throw TapeError.fileTooLarge("PCM is too large for a classic RIFF/WAV file")
    }

    let temporary = wavURL.deletingLastPathComponent()
      .appendingPathComponent(".\(wavURL.lastPathComponent).\(UUID().uuidString).tmp")
    guard FileManager.default.createFile(atPath: temporary.path, contents: nil) else {
      throw TapeError.io("cannot create temporary WAV file")
    }
    var installed = false
    defer { if !installed { try? FileManager.default.removeItem(at: temporary) } }

    let output = try FileHandle(forWritingTo: temporary)
    defer { try? output.close() }
    try output.write(contentsOf: header(dataSize: UInt32(size)))

    let input = try FileHandle(forReadingFrom: pcmURL)
    defer { try? input.close() }
    var remaining = size
    while remaining > 0 {
      let requested = min(1_048_576, Int(remaining))
      guard let chunk = try input.read(upToCount: requested), !chunk.isEmpty else {
        throw TapeError.io("tape.pcm became shorter during export")
      }
      try output.write(contentsOf: chunk)
      remaining -= Int64(chunk.count)
    }
    try output.synchronize()
    try output.close()
    guard Darwin.rename(temporary.path, wavURL.path) == 0 else {
      throw TapeError.io("cannot install WAV file: \(String(cString: strerror(errno)))")
    }
    installed = true
  }

  public static func header(dataSize: UInt32) -> Data {
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
}
