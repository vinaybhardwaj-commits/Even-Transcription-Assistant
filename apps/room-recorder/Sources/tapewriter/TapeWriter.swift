import Darwin
import Foundation
import Synchronization
import TapeCore

final class TapeWriter: @unchecked Sendable {
  private static let checkpointIntervalNS: UInt64 = 1_250_000_000
  private let directory: URL
  private let deviceUID: String
  private let ring: AudioRing
  private let stopping = Atomic<Bool>(false)
  private let readySignaled = Atomic<Bool>(false)
  private let ready = DispatchSemaphore(value: 0)
  private let finished = DispatchSemaphore(value: 0)
  private let resultLock = NSLock()
  private var failure: Error?

  init(directory: URL, deviceUID: String, ring: AudioRing) {
    self.directory = directory
    self.deviceUID = deviceUID
    self.ring = ring
  }

  func startAndWaitUntilReady() throws {
    Thread.detachNewThread { [self] in
      do { try run() } catch {
        resultLock.withLock { failure = error }
      }
      signalReady()
      finished.signal()
    }
    ready.wait()
    try throwFailure()
  }

  func stopAndWait() throws {
    stopping.store(true, ordering: .releasing)
    finished.wait()
    try throwFailure()
  }

  func throwFailure() throws {
    if let failure = resultLock.withLock({ failure }) { throw failure }
  }

  var hasFailed: Bool {
    resultLock.withLock { failure != nil }
  }

  private func signalReady() {
    if !readySignaled.exchange(true, ordering: .acquiringAndReleasing) { ready.signal() }
  }

  private func run() throws {
    try createDurableDirectory(directory)
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let indexURL = directory.appendingPathComponent("tape.idx")
    let existed =
      FileManager.default.fileExists(atPath: pcmURL.path)
      || FileManager.default.fileExists(atPath: indexURL.path)

    let pcmFD = open(pcmURL.path, O_CREAT | O_WRONLY | O_APPEND, S_IRUSR | S_IWUSR)
    guard pcmFD >= 0 else { throw RecorderError.posix("cannot open tape.pcm") }
    defer { close(pcmFD) }
    guard flock(pcmFD, LOCK_EX | LOCK_NB) == 0 else {
      throw RecorderError("another tapewriter is already recording to \(directory.path)")
    }
    defer { flock(pcmFD, LOCK_UN) }

    var bytesWritten = lseek(pcmFD, 0, SEEK_END)
    guard bytesWritten >= 0 else { throw RecorderError.posix("cannot seek tape.pcm") }
    if bytesWritten % 2 != 0 {
      guard ftruncate(pcmFD, bytesWritten - 1) == 0 else {
        throw RecorderError.posix("cannot align tape.pcm")
      }
      bytesWritten -= 1
    }

    let prior = try IndexLog.read(url: indexURL, pcmSize: bytesWritten, repairTrailingPartial: true)
    let priorOffset = prior.records.compactMap(\.byteOffset).last ?? 0
    let indexFD = open(indexURL.path, O_CREAT | O_WRONLY | O_APPEND, S_IRUSR | S_IWUSR)
    guard indexFD >= 0 else { throw RecorderError.posix("cannot open tape.idx") }
    defer { close(indexFD) }
    try synchronizeDirectory(directory)

    var squaredSum = 0.0
    var rmsSampleCount: Int64 = 0
    var lastSyncScheduleNS = monotonicNowNS()
    var latestAudioMonoNS: UInt64?
    var latestAudioWallNS: UInt64?
    var lastRecordOffset = priorOffset
    var resampler: PCMResampler?
    var needsCaptureAnchor = true
    var totalInputFrames: Int64 = prior.records.compactMap(\.inputFrames).last ?? 0
    var currentInputSampleRate: Double?

    func fullSyncTape() throws {
      guard fcntl(pcmFD, F_FULLFSYNC) == 0 else {
        throw RecorderError.posix("F_FULLFSYNC tape.pcm failed")
      }
    }

    func appendRecord(_ record: IndexRecord) throws {
      let data = try IndexLog.encodedLine(record)
      try data.withUnsafeBytes { bytes in
        try writeAll(fd: indexFD, pointer: bytes.baseAddress!, byteCount: bytes.count)
      }
      guard fsync(indexFD) == 0 else { throw RecorderError.posix("fsync tape.idx failed") }
      lastRecordOffset = record.byteOffset ?? lastRecordOffset
    }

    func checkpoint(monoNS: UInt64, wallNS: UInt64) throws {
      try fullSyncTape()
      let rms = rmsSampleCount == 0 ? 0 : min(1, sqrt(squaredSum / Double(rmsSampleCount)))
      try appendRecord(
        IndexRecord(
          byteOffset: bytesWritten,
          samples: bytesWritten / TapeConstants.bytesPerSample,
          monoNS: monoNS,
          wallNS: wallNS,
          device: deviceUID,
          rms: rms,
          inputFrames: currentInputSampleRate == nil ? nil : totalInputFrames,
          inputSampleRate: currentInputSampleRate
        ))
      squaredSum = 0
      rmsSampleCount = 0
      lastSyncScheduleNS = monotonicNowNS()
    }

    func writeConverted(_ output: UnsafePointer<Int16>, count: Int) throws {
      try writeAll(fd: pcmFD, pointer: output, byteCount: count * MemoryLayout<Int16>.size)
      for index in 0..<count {
        let normalized = Double(output[index]) / 32_768
        squaredSum += normalized * normalized
      }
      rmsSampleCount += Int64(count)
      bytesWritten += Int64(count * MemoryLayout<Int16>.size)
    }

    func finishConversion() throws {
      if let resampler {
        try resampler.finish { output, count in try writeConverted(output, count: count) }
      }
    }

    func discontinuity(_ item: StreamItem) throws {
      try finishConversion()
      if rmsSampleCount > 0, let mono = latestAudioMonoNS, let wall = latestAudioWallNS {
        try checkpoint(monoNS: mono, wallNS: wall)
      } else {
        try fullSyncTape()
      }
      try appendRecord(
        IndexRecord(
          byteOffset: bytesWritten,
          samples: bytesWritten / TapeConstants.bytesPerSample,
          monoNS: item.monoStartNS,
          wallNS: item.wallStartNS,
          device: deviceUID,
          discontinuity: item.marker.indexName,
          gapNS: item.gapNS == 0 ? nil : item.gapNS,
          droppedInputFrames: item.droppedFrames == 0 ? nil : item.droppedFrames,
          inputFrames: currentInputSampleRate == nil ? nil : totalInputFrames,
          inputSampleRate: currentInputSampleRate
        ))
      resampler = nil
      latestAudioMonoNS = nil
      latestAudioWallNS = nil
      needsCaptureAnchor = true
      lastSyncScheduleNS = monotonicNowNS()
    }

    if existed {
      let now = monotonicNowNS()
      try fullSyncTape()
      try appendRecord(
        IndexRecord(
          byteOffset: bytesWritten,
          samples: bytesWritten / TapeConstants.bytesPerSample,
          monoNS: now,
          wallNS: wallNowNS(),
          device: deviceUID,
          discontinuity: "restart",
          previousByteOffset: priorOffset,
          survivingTailBytes: max(0, bytesWritten - priorOffset)
        ))
    }
    signalReady()

    while !stopping.load(ordering: .acquiring) || !ring.isEmpty {
      let consumed = try ring.withReadableItem { item, samples in
        if item.marker != .none {
          try discontinuity(item)
          return
        }
        guard let samples else { throw RecorderError("audio stream item has no samples") }
        if let resampler, resampler.inputSampleRate != item.sampleRate {
          try discontinuity(
            StreamItem(
              marker: .formatChange,
              monoStartNS: item.monoStartNS,
              monoEndNS: item.monoStartNS,
              wallStartNS: item.wallStartNS,
              wallEndNS: item.wallStartNS
            ))
        }
        currentInputSampleRate = item.sampleRate
        if needsCaptureAnchor {
          try checkpoint(monoNS: item.monoStartNS, wallNS: item.wallStartNS)
          needsCaptureAnchor = false
        }
        if resampler == nil || resampler!.inputSampleRate != item.sampleRate {
          resampler = try PCMResampler(inputSampleRate: item.sampleRate)
        }
        try resampler!.convert(samples: samples, frameCount: item.frameCount) { output, count in
          try writeConverted(output, count: count)
        }
        totalInputFrames += Int64(item.frameCount)
        latestAudioMonoNS = item.monoEndNS
        latestAudioWallNS = item.wallEndNS
      }

      let now = monotonicNowNS()
      if rmsSampleCount > 0, now - lastSyncScheduleNS >= Self.checkpointIntervalNS,
        let mono = latestAudioMonoNS, let wall = latestAudioWallNS
      {
        try checkpoint(monoNS: mono, wallNS: wall)
      }
      if !consumed { Thread.sleep(forTimeInterval: 0.005) }
    }

    try finishConversion()
    if rmsSampleCount > 0, let mono = latestAudioMonoNS, let wall = latestAudioWallNS {
      try checkpoint(monoNS: mono, wallNS: wall)
    } else if bytesWritten > lastRecordOffset {
      try checkpoint(monoNS: monotonicNowNS(), wallNS: wallNowNS())
    }
    try fullSyncTape()
    try appendRecord(
      IndexRecord(
        byteOffset: bytesWritten,
        samples: bytesWritten / TapeConstants.bytesPerSample,
        monoNS: monotonicNowNS(),
        wallNS: wallNowNS(),
        device: deviceUID,
        discontinuity: "stopped",
        inputFrames: currentInputSampleRate == nil ? nil : totalInputFrames,
        inputSampleRate: currentInputSampleRate
      ))
  }
}

private func writeAll(fd: Int32, pointer: UnsafeRawPointer, byteCount: Int) throws {
  var remaining = byteCount
  var cursor = pointer
  while remaining > 0 {
    let result = Darwin.write(fd, cursor, remaining)
    if result < 0 {
      if errno == EINTR { continue }
      throw RecorderError.posix("write failed")
    }
    guard result > 0 else { throw RecorderError("write made no progress") }
    remaining -= result
    cursor = cursor.advanced(by: result)
  }
}

private func synchronizeDirectory(_ directory: URL) throws {
  let fd = open(directory.path, O_RDONLY)
  guard fd >= 0 else { throw RecorderError.posix("cannot open output directory for sync") }
  defer { close(fd) }
  guard fsync(fd) == 0 || errno == EINVAL else {
    throw RecorderError.posix("cannot sync output directory")
  }
}

private func createDurableDirectory(_ directory: URL) throws {
  var isDirectory: ObjCBool = false
  if FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) {
    guard isDirectory.boolValue else {
      throw RecorderError("output path is not a directory: \(directory.path)")
    }
    return
  }
  let parent = directory.deletingLastPathComponent()
  guard parent.path != directory.path else {
    throw RecorderError("cannot create output directory: \(directory.path)")
  }
  try createDurableDirectory(parent)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
  try synchronizeDirectory(parent)
}
