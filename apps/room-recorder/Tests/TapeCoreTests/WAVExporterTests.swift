import Darwin
import Foundation
import Testing

@testable import TapeCore

@Suite struct WAVExporterTests {
  @Test func writesCanonicalHeaderAndUnchangedPCM() throws {
    let directory = try wavTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let wavURL = directory.appendingPathComponent("tape.wav")
    let pcm = Data([0x00, 0x80, 0xFF, 0x7F, 0x01, 0x00])
    try pcm.write(to: pcmURL)
    try Data(repeating: 0xFF, count: 100).write(to: wavURL)

    try WAVExporter.export(pcmURL: pcmURL, wavURL: wavURL)

    let wav = try Data(contentsOf: wavURL)
    #expect(wav.count == 44 + pcm.count)
    #expect(String(decoding: wav[0..<4], as: UTF8.self) == "RIFF")
    #expect(String(decoding: wav[8..<12], as: UTF8.self) == "WAVE")
    #expect(String(decoding: wav[36..<40], as: UTF8.self) == "data")
    #expect(Array(wav[44...]) == Array(pcm))
    #expect(readUInt32LE(wav, at: 24) == 16_000)
    #expect(readUInt32LE(wav, at: 28) == 32_000)
    #expect(readUInt32LE(wav, at: 40) == UInt32(pcm.count))
  }

  @Test func rejectsOddPCM() throws {
    let directory = try wavTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    try Data([1]).write(to: pcmURL)

    #expect(throws: TapeError.oddPCMSize(1)) {
      try WAVExporter.export(pcmURL: pcmURL, wavURL: directory.appendingPathComponent("x.wav"))
    }
  }

  @Test func rejectsPCMDirectHardLinkAndSymlinkAliasesWithoutMutation() throws {
    let directory = try wavTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let hardLinkURL = directory.appendingPathComponent("pcm-hard-link.wav")
    let symlinkURL = directory.appendingPathComponent("pcm-symlink.wav")
    try Data([0x12, 0x34, 0x56, 0x78]).write(to: pcmURL)
    try FileManager.default.linkItem(at: pcmURL, to: hardLinkURL)
    try FileManager.default.createSymbolicLink(at: symlinkURL, withDestinationURL: pcmURL)
    let sourceBefore = try wavEvidence(pcmURL)

    for destination in [pcmURL, hardLinkURL, symlinkURL] {
      #expect(throws: TapeError.io("WAV destination resolves to tape.pcm")) {
        try WAVExporter.export(pcmURL: pcmURL, wavURL: destination)
      }
      #expect(try wavEvidence(pcmURL) == sourceBefore)
      #expect(try wavTemporaryFiles(in: directory).isEmpty)
    }
  }

  @Test func rejectsIndexDirectHardLinkAndSymlinkAliasesWithoutMutation() throws {
    let directory = try wavTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let indexURL = directory.appendingPathComponent("tape.idx")
    let hardLinkURL = directory.appendingPathComponent("index-hard-link.wav")
    let symlinkURL = directory.appendingPathComponent("index-symlink.wav")
    try Data([0, 0]).write(to: pcmURL)
    try Data("index\n".utf8).write(to: indexURL)
    try FileManager.default.linkItem(at: indexURL, to: hardLinkURL)
    try FileManager.default.createSymbolicLink(at: symlinkURL, withDestinationURL: indexURL)
    let sourceBefore = try wavEvidence(pcmURL)
    let indexBefore = try wavEvidence(indexURL)

    for destination in [indexURL, hardLinkURL, symlinkURL] {
      #expect(throws: TapeError.io("WAV destination resolves to tape.idx")) {
        try WAVExporter.export(pcmURL: pcmURL, wavURL: destination)
      }
      #expect(try wavEvidence(pcmURL) == sourceBefore)
      #expect(try wavEvidence(indexURL) == indexBefore)
      #expect(try wavTemporaryFiles(in: directory).isEmpty)
    }
  }

  @Test func rejectsAbsentIndexCaseAndParentSymlinkAliasesWithoutMutation() throws {
    let directory = try wavTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let indexURL = directory.appendingPathComponent("tape.idx")
    let caseAliasURL = directory.appendingPathComponent("TAPE.IDX")
    let parentAliasURL = directory.appendingPathComponent("parent-alias")
    let parentAliasIndexURL = parentAliasURL.appendingPathComponent("tape.idx")
    try Data([0x12, 0x34, 0x56, 0x78]).write(to: pcmURL)
    try FileManager.default.createSymbolicLink(at: parentAliasURL, withDestinationURL: directory)
    let sourceBefore = try wavEvidence(pcmURL)

    for destination in [caseAliasURL, parentAliasIndexURL] {
      #expect(throws: TapeError.io("WAV destination resolves to tape.idx")) {
        try WAVExporter.export(pcmURL: pcmURL, wavURL: destination)
      }
      #expect(try wavEvidence(pcmURL) == sourceBefore)
      #expect(!FileManager.default.fileExists(atPath: indexURL.path))
      #expect(!FileManager.default.fileExists(atPath: caseAliasURL.path))
      #expect(try wavTemporaryFiles(in: directory).isEmpty)
    }
  }

  @Test func exportsOnlyGrowingSourceSnapshot() throws {
    let directory = try wavTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let wavURL = directory.appendingPathComponent("tape.wav")
    let initial = Data([0x10, 0x00, 0x20, 0x00, 0x30, 0x00])
    let suffix = Data([0x40, 0x00, 0x50, 0x00])
    try initial.write(to: pcmURL)
    let sourceBefore = try wavStat(pcmURL)
    var hookCalls = 0

    try WAVExporter.export(
      pcmURL: pcmURL,
      wavURL: wavURL,
      hooks: WAVExporter.Hooks(afterSnapshot: {
        hookCalls += 1
        try wavAppend(suffix, to: pcmURL)
      }))

    var expectedWAV = try WAVExporter.header(dataSize: UInt32(initial.count))
    expectedWAV.append(initial)
    let sourceAfter = try wavStat(pcmURL)
    #expect(hookCalls == 1)
    #expect(try Data(contentsOf: wavURL) == expectedWAV)
    #expect(readUInt32LE(expectedWAV, at: 4) == UInt32(36 + initial.count))
    #expect(readUInt32LE(expectedWAV, at: 40) == UInt32(initial.count))
    #expect(try Data(contentsOf: pcmURL) == initial + suffix)
    #expect(sourceAfter.device == sourceBefore.device)
    #expect(sourceAfter.inode == sourceBefore.inode)
    #expect(sourceAfter.size == off_t(initial.count + suffix.count))
    #expect(try wavTemporaryFiles(in: directory).isEmpty)
  }

  @Test func shrinkingSourcePreservesOldDestination() throws {
    let directory = try wavTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let wavURL = directory.appendingPathComponent("tape.wav")
    let initial = Data([0x10, 0x00, 0x20, 0x00, 0x30, 0x00])
    let shortened = initial.prefix(2)
    let oldDestination = Data("old-wav-evidence".utf8)
    try initial.write(to: pcmURL)
    try oldDestination.write(to: wavURL)
    let destinationBefore = try wavEvidence(wavURL)

    #expect(throws: TapeError.io("tape.pcm became shorter during export")) {
      try WAVExporter.export(
        pcmURL: pcmURL,
        wavURL: wavURL,
        hooks: WAVExporter.Hooks(afterSnapshot: {
          try wavTruncate(pcmURL, to: shortened.count)
        }))
    }

    #expect(try Data(contentsOf: pcmURL) == shortened)
    #expect(try wavEvidence(wavURL) == destinationBefore)
    #expect(try wavTemporaryFiles(in: directory).isEmpty)
  }

  @Test func rejectsBothSizesBeyondAlignedClassicRIFFMaximumWithoutCopying() throws {
    let alignedMaximum: Int64 = 4_294_967_258
    let rawRIFFMaximum = Int64(UInt32.max) - 36
    #expect(WAVExporter.maximumPCMBytes == alignedMaximum)
    #expect(alignedMaximum % Int64(TapeConstants.bytesPerSample) == 0)
    #expect(rawRIFFMaximum == alignedMaximum + 1)
    #expect(throws: TapeError.fileTooLarge("PCM is too large for a classic RIFF/WAV file")) {
      try WAVExporter.header(dataSize: UInt32.max)
    }

    let rejectedSizes = [
      alignedMaximum + 1,
      rawRIFFMaximum + 1,
    ]
    for size in rejectedSizes {
      let directory = try wavTemporaryDirectory()
      defer { try? FileManager.default.removeItem(at: directory) }
      let pcmURL = directory.appendingPathComponent("tape.pcm")
      let wavURL = directory.appendingPathComponent("tape.wav")
      let oldDestination = Data("old-wav-evidence".utf8)
      try wavCreateSparseFile(at: pcmURL, size: size)
      try oldDestination.write(to: wavURL)
      let sourceBefore = try wavStat(pcmURL)
      let destinationBefore = try wavEvidence(wavURL)

      #expect(throws: TapeError.fileTooLarge("PCM is too large for a classic RIFF/WAV file")) {
        try WAVExporter.export(pcmURL: pcmURL, wavURL: wavURL)
      }

      #expect(try wavStat(pcmURL) == sourceBefore)
      #expect(try wavEvidence(wavURL) == destinationBefore)
      #expect(try wavTemporaryFiles(in: directory).isEmpty)
    }
  }

  @Test func readOnlyParentFailsForOrdinaryUserAndPreservesFiles() throws {
    try #require(geteuid() != 0, "WAV permission fixture must not run as root")
    let directory = try wavTemporaryDirectory()
    let originalMode = try wavMode(directory)
    defer {
      _ = chmod(directory.path, originalMode)
      try? FileManager.default.removeItem(at: directory)
    }
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let wavURL = directory.appendingPathComponent("tape.wav")
    try Data([0x10, 0x00, 0x20, 0x00]).write(to: pcmURL)
    try Data("old-wav-evidence".utf8).write(to: wavURL)
    let sourceBefore = try wavEvidence(pcmURL)
    let destinationBefore = try wavEvidence(wavURL)
    try #require(chmod(directory.path, S_IRUSR | S_IXUSR) == 0)
    try #require(access(directory.path, W_OK) != 0)

    #expect(throws: TapeError.io("cannot create temporary WAV file")) {
      try WAVExporter.export(pcmURL: pcmURL, wavURL: wavURL)
    }

    #expect(try wavEvidence(pcmURL) == sourceBefore)
    #expect(try wavEvidence(wavURL) == destinationBefore)
    #expect(try wavTemporaryFiles(in: directory).isEmpty)
  }

  @Test func injectedRenameErrorsReportNumericErrnoAndCleanTemporary() throws {
    let fixtures: [(name: String, errorNumber: Int32, expectedNumber: Int32)] = [
      ("eintr", Int32(EINTR), 4),
      ("eio", Int32(EIO), 5),
    ]

    for fixture in fixtures {
      try #require(fixture.errorNumber == fixture.expectedNumber)
      let directory = try wavTemporaryDirectory()
      defer { try? FileManager.default.removeItem(at: directory) }
      let pcmURL = directory.appendingPathComponent("tape.pcm")
      let wavURL = directory.appendingPathComponent("\(fixture.name).wav")
      try Data([0x10, 0x00, 0x20, 0x00]).write(to: pcmURL)
      try Data("old-wav-evidence".utf8).write(to: wavURL)
      let sourceBefore = try wavEvidence(pcmURL)
      let destinationBefore = try wavEvidence(wavURL)
      var capturedTemporary: URL?
      var capturedDestination: URL?
      var temporaryExistedAtRename = false
      let expectedError = TapeError.io(
        "cannot install WAV file: errno \(fixture.expectedNumber) "
          + "(\(String(cString: strerror(fixture.expectedNumber))))")

      #expect(throws: expectedError) {
        try WAVExporter.export(
          pcmURL: pcmURL,
          wavURL: wavURL,
          hooks: WAVExporter.Hooks(rename: { temporary, destination in
            capturedTemporary = temporary
            capturedDestination = destination
            temporaryExistedAtRename = FileManager.default.fileExists(atPath: temporary.path)
            return fixture.errorNumber
          }))
      }

      let temporary = try #require(capturedTemporary)
      #expect(capturedDestination == wavURL)
      #expect(temporaryExistedAtRename)
      #expect(!FileManager.default.fileExists(atPath: temporary.path))
      #expect(try wavTemporaryFiles(in: directory).isEmpty)
      #expect(try wavEvidence(pcmURL) == sourceBefore)
      #expect(try wavEvidence(wavURL) == destinationBefore)
    }
  }

  @Test func cleanupFailureReportsRetainedTemporary() throws {
    try #require(geteuid() != 0, "WAV cleanup permission fixture must not run as root")
    let directory = try wavTemporaryDirectory()
    let originalMode = try wavMode(directory)
    defer {
      _ = chmod(directory.path, originalMode)
      try? FileManager.default.removeItem(at: directory)
    }
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let wavURL = directory.appendingPathComponent("tape.wav")
    try Data([0x10, 0x00, 0x20, 0x00]).write(to: pcmURL)
    try Data("old-wav-evidence".utf8).write(to: wavURL)
    let sourceBefore = try wavEvidence(pcmURL)
    let destinationBefore = try wavEvidence(wavURL)
    var temporary: URL?

    do {
      try WAVExporter.export(
        pcmURL: pcmURL,
        wavURL: wavURL,
        hooks: WAVExporter.Hooks(rename: { candidate, _ in
          temporary = candidate
          guard chmod(directory.path, S_IRUSR | S_IXUSR) == 0 else { return Int32(errno) }
          return Int32(EIO)
        }))
      Issue.record("expected WAV cleanup failure")
    } catch TapeError.io(let detail) {
      #expect(detail.contains("cannot install WAV file: errno \(EIO)"))
      #expect(detail.contains("temporary WAV retained at"))
    } catch {
      Issue.record("unexpected WAV cleanup error: \(error)")
    }

    try #require(chmod(directory.path, originalMode) == 0)
    let retained = try #require(temporary)
    #expect(FileManager.default.fileExists(atPath: retained.path))
    #expect(try wavEvidence(pcmURL) == sourceBefore)
    #expect(try wavEvidence(wavURL) == destinationBefore)
    try FileManager.default.removeItem(at: retained)
    #expect(try wavTemporaryFiles(in: directory).isEmpty)
  }

  @Test(
    .disabled(
      if: ProcessInfo.processInfo.environment["ETA_WAV_APFS"] != "1",
      "Set ETA_WAV_APFS=1 only for the reviewed disposable WAV APFS acceptance fixtures."
    )
  )
  func isolatedAPFSSparseMaximumAndRealENOSPC() throws {
    try IsolatedAPFSFixture.run(label: "wav-sparse-maximum") { mount in
      let pcmURL = mount.appendingPathComponent("tape.pcm")
      let wavURL = mount.appendingPathComponent("maximum.wav")
      try wavCreateSparseFile(at: pcmURL, size: WAVExporter.maximumPCMBytes)
      let markers: [(offset: Int64, data: Data)] = [
        (0, Data([0x11, 0x22])),
        (2 * 1_048_576, Data([0x33, 0x44])),
        (WAVExporter.maximumPCMBytes - 2, Data([0x55, 0x66])),
      ]
      for marker in markers { try wavWrite(marker.data, to: pcmURL, offset: marker.offset) }
      let sourceBefore = try wavStat(pcmURL)
      let sourceMarkersBefore = try markers.map {
        try wavRead(pcmURL, offset: $0.offset, count: $0.data.count)
      }

      try WAVExporter.export(pcmURL: pcmURL, wavURL: wavURL)

      let outputStat = try wavStat(wavURL)
      let header = try wavRead(wavURL, offset: 0, count: 44)
      #expect(outputStat.size == 44 + WAVExporter.maximumPCMBytes)
      #expect(outputStat.blocks * 512 < 16 * 1_048_576)
      #expect(readUInt32LE(header, at: 4) == UInt32.max - 1)
      #expect(readUInt32LE(header, at: 40) == UInt32(WAVExporter.maximumPCMBytes))
      for marker in markers {
        let exported = try wavRead(
          wavURL, offset: 44 + marker.offset, count: marker.data.count)
        #expect(exported == marker.data)
      }
      #expect(try wavRead(wavURL, offset: 44 + 1_500_000, count: 2) == Data([0, 0]))
      #expect(try wavStat(pcmURL) == sourceBefore)
      #expect(
        try markers.map { try wavRead(pcmURL, offset: $0.offset, count: $0.data.count) }
          == sourceMarkersBefore)
      #expect(try wavTemporaryFiles(in: mount).isEmpty)
      print(
        "WAV-04 logical=\(outputStat.size) allocated=\(outputStat.blocks * 512) "
          + "data=\(readUInt32LE(header, at: 40))"
      )
    }

    let sourceDirectory = try wavTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: sourceDirectory) }
    let sourceURL = sourceDirectory.appendingPathComponent("tape.pcm")
    try wavWritePatternFile(at: sourceURL, byteCount: 32 * 1_048_576, byte: 0xA5)
    let sourceBefore = try wavEvidence(sourceURL)

    try IsolatedAPFSFixture.run(label: "wav-enospc") { mount in
      let wavURL = mount.appendingPathComponent("evidence.wav")
      let reserveURL = mount.appendingPathComponent("reserve.bin")
      let fillerURL = mount.appendingPathComponent("filler.bin")
      let oldDestination = Data("old-wav-evidence".utf8)
      try oldDestination.write(to: wavURL)
      try wavWritePatternFile(at: reserveURL, byteCount: 16 * 1_048_576, byte: 0xB6)
      let fillerBytes = try wavFillToENOSPC(fillerURL, limit: 256 * 1_048_576)
      try FileManager.default.removeItem(at: reserveURL)
      let destinationBefore = try wavEvidence(wavURL)
      let freeBeforeExport = try wavFileSystemFreeBytes(mount)
      try #require(freeBeforeExport < 32 * 1_048_576)

      do {
        try WAVExporter.export(pcmURL: sourceURL, wavURL: wavURL)
        Issue.record("expected real ENOSPC during WAV export")
      } catch TapeError.io(let detail) {
        #expect(
          detail.hasPrefix(
            "cannot write temporary WAV payload: errno \(ENOSPC) "))
      } catch {
        Issue.record("unexpected WAV ENOSPC error: \(error)")
      }

      #expect(try wavEvidence(sourceURL) == sourceBefore)
      #expect(try wavEvidence(wavURL) == destinationBefore)
      #expect(try wavTemporaryFiles(in: mount).isEmpty)
      try FileManager.default.removeItem(at: fillerURL)
      print(
        "WAV-05 ENOSPC errno=\(ENOSPC) filler=\(fillerBytes) "
          + "free_before=\(freeBeforeExport) destination_preserved=true"
      )
    }
  }
}

private struct WAVFileStat: Equatable {
  let device: dev_t
  let inode: ino_t
  let size: off_t
  let blocks: blkcnt_t
}

private struct WAVFileEvidence: Equatable {
  let fileStat: WAVFileStat
  let content: Data
}

private func wavTemporaryDirectory() throws -> URL {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
    "eta-wav-tests-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
  return directory
}

private func wavStat(_ url: URL) throws -> WAVFileStat {
  var value = stat()
  guard stat(url.path, &value) == 0 else {
    throw TapeError.io("cannot stat WAV test fixture: \(String(cString: strerror(errno)))")
  }
  return WAVFileStat(
    device: value.st_dev,
    inode: value.st_ino,
    size: value.st_size,
    blocks: value.st_blocks
  )
}

private func wavEvidence(_ url: URL) throws -> WAVFileEvidence {
  WAVFileEvidence(fileStat: try wavStat(url), content: try Data(contentsOf: url))
}

private func wavMode(_ url: URL) throws -> mode_t {
  var value = stat()
  guard stat(url.path, &value) == 0 else {
    throw TapeError.io("cannot stat WAV test fixture: \(String(cString: strerror(errno)))")
  }
  return value.st_mode & mode_t(0o7777)
}

private func wavTemporaryFiles(in directory: URL) throws -> [URL] {
  try FileManager.default.contentsOfDirectory(
    at: directory,
    includingPropertiesForKeys: nil
  ).filter { url in
    url.lastPathComponent.hasPrefix(".") && url.lastPathComponent.hasSuffix(".tmp")
  }
}

private func wavAppend(_ data: Data, to url: URL) throws {
  let handle = try FileHandle(forWritingTo: url)
  defer { try? handle.close() }
  try handle.seekToEnd()
  try handle.write(contentsOf: data)
  try handle.close()
}

private func wavTruncate(_ url: URL, to size: Int) throws {
  let handle = try FileHandle(forWritingTo: url)
  defer { try? handle.close() }
  try handle.truncate(atOffset: UInt64(size))
  try handle.close()
}

private func wavCreateSparseFile(at url: URL, size: Int64) throws {
  let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
  guard descriptor >= 0 else {
    throw TapeError.io("cannot create sparse WAV test fixture: \(String(cString: strerror(errno)))")
  }
  defer { close(descriptor) }
  guard ftruncate(descriptor, off_t(size)) == 0 else {
    throw TapeError.io("cannot size sparse WAV test fixture: \(String(cString: strerror(errno)))")
  }
}

private func wavRead(_ url: URL, offset: Int64, count: Int) throws -> Data {
  let descriptor = open(url.path, O_RDONLY)
  guard descriptor >= 0 else {
    throw TapeError.io("cannot open WAV acceptance fixture: \(String(cString: strerror(errno)))")
  }
  defer { close(descriptor) }
  var data = Data(repeating: 0, count: count)
  let result = data.withUnsafeMutableBytes { bytes in
    pread(descriptor, bytes.baseAddress, bytes.count, off_t(offset))
  }
  guard result == count else {
    throw TapeError.io("cannot read selected WAV acceptance bytes: errno \(errno)")
  }
  return data
}

private func wavWrite(_ data: Data, to url: URL, offset: Int64) throws {
  let descriptor = open(url.path, O_WRONLY)
  guard descriptor >= 0 else {
    throw TapeError.io("cannot open WAV acceptance fixture: \(String(cString: strerror(errno)))")
  }
  defer { close(descriptor) }
  var written = 0
  try data.withUnsafeBytes { bytes in
    while written < bytes.count {
      let result = pwrite(
        descriptor,
        bytes.baseAddress?.advanced(by: written),
        bytes.count - written,
        off_t(offset) + off_t(written)
      )
      let code = errno
      if result < 0, code == EINTR { continue }
      guard result > 0 else { throw TapeError.io("WAV marker write failed: errno \(code)") }
      written += result
    }
  }
  guard fsync(descriptor) == 0 else {
    throw TapeError.io("WAV marker sync failed: errno \(errno)")
  }
}

private func wavWritePatternFile(at url: URL, byteCount: Int, byte: UInt8) throws {
  let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
  guard descriptor >= 0 else {
    throw TapeError.io("cannot create WAV pattern fixture: \(String(cString: strerror(errno)))")
  }
  defer { close(descriptor) }
  let block = [UInt8](repeating: byte, count: 1_048_576)
  var written = 0
  try block.withUnsafeBytes { bytes in
    while written < byteCount {
      let requested = min(bytes.count, byteCount - written)
      let result = Darwin.write(descriptor, bytes.baseAddress, requested)
      let code = errno
      if result < 0, code == EINTR { continue }
      guard result > 0 else { throw TapeError.io("WAV pattern write failed: errno \(code)") }
      written += result
    }
  }
  guard fsync(descriptor) == 0 else {
    throw TapeError.io("WAV pattern sync failed: errno \(errno)")
  }
}

private func wavFillToENOSPC(_ url: URL, limit: Int) throws -> Int {
  let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
  guard descriptor >= 0 else {
    throw TapeError.io("cannot create WAV filler: \(String(cString: strerror(errno)))")
  }
  defer { close(descriptor) }
  let block = [UInt8](repeating: 0xC7, count: 1_048_576)
  var written = 0
  var sawENOSPC = false
  try block.withUnsafeBytes { bytes in
    while written < limit {
      let result = Darwin.write(descriptor, bytes.baseAddress, bytes.count)
      let code = errno
      if result < 0, code == EINTR { continue }
      if result < 0, code == ENOSPC {
        sawENOSPC = true
        break
      }
      guard result > 0 else { throw TapeError.io("WAV filler write failed: errno \(code)") }
      written += result
      if written.isMultiple(of: 8 * 1_048_576), fsync(descriptor) != 0 {
        if errno == ENOSPC {
          sawENOSPC = true
          break
        }
        throw TapeError.io("WAV filler sync failed: errno \(errno)")
      }
    }
  }
  if fsync(descriptor) != 0 {
    guard errno == ENOSPC else { throw TapeError.io("WAV filler sync failed: errno \(errno)") }
    sawENOSPC = true
  }
  guard sawENOSPC else { throw TapeError.io("WAV filler did not reach ENOSPC") }
  return written
}

private func wavFileSystemFreeBytes(_ url: URL) throws -> Int64 {
  guard
    let value = try FileManager.default.attributesOfFileSystem(forPath: url.path)[.systemFreeSize]
      as? NSNumber
  else { throw TapeError.io("cannot read WAV fixture free space") }
  return value.int64Value
}

private func readUInt32LE(_ data: Data, at offset: Int) -> UInt32 {
  UInt32(data[offset])
    | UInt32(data[offset + 1]) << 8
    | UInt32(data[offset + 2]) << 16
    | UInt32(data[offset + 3]) << 24
}
