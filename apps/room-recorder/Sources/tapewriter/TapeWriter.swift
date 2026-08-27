import Darwin
import Foundation
import Synchronization
import TapeCore

final class TapeWriter: @unchecked Sendable {
  private let directory: URL
  private let deviceUID: String
  private let ring: AudioRing
  private let faultPlan: DurabilityFaultPlan?
  private let checkpointIntervalNS: UInt64
  private let unsignedDevelopmentArchive: UnsignedDevelopmentArchiveOptions?
  private let stopping = Atomic<Bool>(false)
  private let durableOffset = Atomic<Int64>(-1)
  private let firstDurableCaptureOffset = Atomic<Int64>(-1)
  private let firstDurableCaptureCompletedNS = Atomic<UInt64>(0)
  private let durableCaptureGeneration = Atomic<UInt64>(0)
  private let readySignaled = Atomic<Bool>(false)
  private let ready = DispatchSemaphore(value: 0)
  private let finished = DispatchSemaphore(value: 0)
  private let resultLock = NSLock()
  private var failure: Error?

  init(
    directory: URL,
    deviceUID: String,
    ring: AudioRing,
    faultPlan: DurabilityFaultPlan? = nil,
    checkpointIntervalNS: UInt64 = 1_250_000_000,
    unsignedDevelopmentArchive: UnsignedDevelopmentArchiveOptions? = nil
  ) {
    self.directory = directory
    self.deviceUID = deviceUID
    self.ring = ring
    self.faultPlan = faultPlan
    self.checkpointIntervalNS = checkpointIntervalNS
    self.unsignedDevelopmentArchive = unsignedDevelopmentArchive
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

  var durableCheckpointOffset: Int64 {
    durableOffset.load(ordering: .acquiring)
  }

  func hasDurableGrowth(
    after baselineOffset: Int64,
    captureGeneration: UInt64,
    completedByNS deadlineNS: UInt64
  ) -> Bool {
    guard durableCaptureGeneration.load(ordering: .acquiring) == captureGeneration else {
      return false
    }
    return firstDurableCaptureOffset.load(ordering: .acquiring) > baselineOffset
      && firstDurableCaptureCompletedNS.load(ordering: .acquiring) <= deadlineNS
  }

  private func signalReady() {
    if !readySignaled.exchange(true, ordering: .acquiringAndReleasing) { ready.signal() }
  }

  private func run() throws {
    if unsignedDevelopmentArchive != nil {
      UnsignedDevelopmentArchiveWriter.printNonConfidentialWarning()
    }
    try createDurableDirectory(directory)
    let pcmURL = directory.appendingPathComponent("tape.pcm")
    let indexURL = directory.appendingPathComponent("tape.idx")
    let existed =
      FileManager.default.fileExists(atPath: pcmURL.path)
      || FileManager.default.fileExists(atPath: indexURL.path)
    let existingPlaintextHasContent: Bool
    if unsignedDevelopmentArchive == nil {
      existingPlaintextHasContent = false
    } else {
      existingPlaintextHasContent = try fileHasContent(pcmURL) || fileHasContent(indexURL)
    }

    let pcmAccess = unsignedDevelopmentArchive == nil ? O_WRONLY : O_RDWR
    let pcmFD = open(pcmURL.path, O_CREAT | pcmAccess | O_APPEND, S_IRUSR | S_IWUSR)
    guard pcmFD >= 0 else { throw RecorderError.posix("cannot open tape.pcm") }
    defer { close(pcmFD) }
    guard flock(pcmFD, LOCK_EX | LOCK_NB) == 0 else {
      throw RecorderError("another tapewriter is already recording to \(directory.path)")
    }
    defer { flock(pcmFD, LOCK_UN) }

    var bytesWritten = lseek(pcmFD, 0, SEEK_END)
    guard bytesWritten >= 0 else { throw RecorderError.posix("cannot seek tape.pcm") }
    var archiveWriter: UnsignedDevelopmentArchiveWriter?
    if let unsignedDevelopmentArchive {
      archiveWriter = try UnsignedDevelopmentArchiveWriter.open(
        directory: directory,
        options: unsignedDevelopmentArchive,
        stableDeviceUID: deviceUID,
        pcmFileDescriptor: pcmFD,
        plaintextByteCount: bytesWritten,
        existingPlaintextHasContent: existingPlaintextHasContent
      )
      bytesWritten = archiveWriter!.logicalByteEnd
    } else if bytesWritten % 2 != 0 {
      guard ftruncate(pcmFD, bytesWritten - 1) == 0 else {
        throw RecorderError.posix("cannot align tape.pcm")
      }
      bytesWritten -= 1
    }
    defer { archiveWriter?.close() }

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
    var latestCaptureGeneration: UInt64?
    var lastRecordOffset = priorOffset
    var resampler: PCMResampler?
    var needsCaptureAnchor = true
    var totalInputFrames: Int64 = prior.records.compactMap(\.inputFrames).last ?? 0
    var currentInputSampleRate: Double?

    func fullSyncTape(_ context: DurabilityRecordContext) throws {
      let operation = DurabilityOperation.tapeFullSync(context)
      let result: Int32
      if let injectedErrno = faultPlan?.injectedErrno(for: operation, offset: bytesWritten) {
        errno = injectedErrno
        result = -1
      } else {
        result = fcntl(pcmFD, F_FULLFSYNC)
      }
      let syncErrno = errno
      guard result == 0 else {
        throw DurabilitySyscallError(
          operation: operation,
          errnoCode: syncErrno,
          offset: bytesWritten
        )
      }
      faultPlan?.perform(.afterTapeFullSync(context), offset: bytesWritten)
    }

    func appendRecord(_ record: IndexRecord, context: DurabilityRecordContext) throws {
      let data = try IndexLog.encodedLine(record)
      let offset = record.byteOffset ?? lastRecordOffset
      let operation = DurabilityOperation.indexWrite(context)
      try data.withUnsafeBytes { bytes in
        try writeAll(
          fd: indexFD,
          pointer: bytes.baseAddress!,
          byteCount: bytes.count,
          operation: operation,
          offset: offset,
          faultPlan: faultPlan
        )
      }
      let syncOperation = DurabilityOperation.indexSync(context)
      let result: Int32
      if let injectedErrno = faultPlan?.injectedErrno(for: syncOperation, offset: offset) {
        errno = injectedErrno
        result = -1
      } else {
        result = fsync(indexFD)
      }
      let syncErrno = errno
      guard result == 0 else {
        throw DurabilitySyscallError(
          operation: syncOperation,
          errnoCode: syncErrno,
          offset: offset
        )
      }
      faultPlan?.perform(.afterIndexSync(context), offset: offset)
      lastRecordOffset = record.byteOffset ?? lastRecordOffset
    }

    func checkpoint(monoNS: UInt64, wallNS: UInt64) throws {
      try fullSyncTape(.checkpoint)
      let rms = rmsSampleCount == 0 ? 0 : min(1, sqrt(squaredSum / Double(rmsSampleCount)))
      try archiveWriter?.mirrorDurablePCM(
        fileDescriptor: pcmFD,
        durableByteEnd: bytesWritten,
        monoNS: monoNS,
        wallNS: wallNS
      )
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
        ),
        context: .checkpoint
      )
      durableOffset.store(bytesWritten, ordering: .releasing)
      if let latestCaptureGeneration,
        latestCaptureGeneration > durableCaptureGeneration.load(ordering: .acquiring)
      {
        firstDurableCaptureOffset.store(bytesWritten, ordering: .relaxed)
        firstDurableCaptureCompletedNS.store(monotonicNowNS(), ordering: .relaxed)
        durableCaptureGeneration.store(latestCaptureGeneration, ordering: .releasing)
      }
      squaredSum = 0
      rmsSampleCount = 0
      lastSyncScheduleNS = monotonicNowNS()
    }

    func writeConverted(_ output: UnsafePointer<Int16>, count: Int) throws {
      let byteCount = count * MemoryLayout<Int16>.size
      let targetOffset = bytesWritten + Int64(byteCount)
      try writeAll(
        fd: pcmFD,
        pointer: output,
        byteCount: byteCount,
        operation: .pcmWrite,
        offset: targetOffset,
        faultPlan: faultPlan
      )
      for index in 0..<count {
        let normalized = Double(output[index]) / 32_768
        squaredSum += normalized * normalized
      }
      rmsSampleCount += Int64(count)
      bytesWritten = targetOffset
      faultPlan?.perform(.afterPCMAppend, offset: bytesWritten)
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
        try fullSyncTape(.discontinuity)
      }
      archiveWriter?.noteDiscontinuity(item)
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
        ),
        context: .discontinuity
      )
      if item.marker == .formatChange { currentInputSampleRate = nil }
      resampler = nil
      latestAudioMonoNS = nil
      latestAudioWallNS = nil
      latestCaptureGeneration = nil
      needsCaptureAnchor = true
      lastSyncScheduleNS = monotonicNowNS()
    }

    if existed {
      let now = monotonicNowNS()
      archiveWriter?.noteDiscontinuity(
        StreamItem(marker: .restart, monoStartNS: now, wallStartNS: wallNowNS()))
      try fullSyncTape(.restart)
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
        ),
        context: .restart
      )
    }
    durableOffset.store(bytesWritten, ordering: .releasing)
    signalReady()

    while !stopping.load(ordering: .acquiring) || !ring.isEmpty {
      let consumed = try ring.withReadableItem { item, samples in
        if item.marker != .none {
          try discontinuity(item)
          return
        }
        guard let samples else { throw RecorderError("audio stream item has no samples") }
        if let currentInputSampleRate, currentInputSampleRate != item.sampleRate {
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
        latestCaptureGeneration = item.captureGeneration == 0 ? nil : item.captureGeneration
      }

      let now = monotonicNowNS()
      if rmsSampleCount > 0, now - lastSyncScheduleNS >= checkpointIntervalNS,
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
    try fullSyncTape(.stopped)
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
      ),
      context: .stopped
    )
  }
}

private func writeAll(
  fd: Int32,
  pointer: UnsafeRawPointer,
  byteCount: Int,
  operation: DurabilityOperation,
  offset: Int64,
  faultPlan: DurabilityFaultPlan?
) throws {
  var remaining = byteCount
  var cursor = pointer
  var completed = 0
  let prefixByteCount: Int?
  if operation.code == .indexWrite, let context = operation.context {
    prefixByteCount = faultPlan?.indexPrefixByteCount(context: context, offset: offset)
    if let prefixByteCount {
      guard prefixByteCount < byteCount,
        pointer.load(fromByteOffset: byteCount - 1, as: UInt8.self) == 0x0A
      else {
        throw RecorderError("durability index prefix must terminate before the final newline")
      }
    }
  } else {
    prefixByteCount = nil
  }
  while remaining > 0 {
    let requestCount = min(remaining, prefixByteCount.map { $0 - completed } ?? remaining)
    let result: Int
    if let injectedErrno = faultPlan?.injectedErrno(for: operation, offset: offset) {
      errno = injectedErrno
      result = -1
    } else {
      result = Darwin.write(fd, cursor, requestCount)
    }
    let writeErrno = errno
    if result < 0 {
      if writeErrno == EINTR { continue }
      throw DurabilitySyscallError(
        operation: operation,
        errnoCode: writeErrno,
        offset: offset
      )
    }
    guard result > 0 else { throw RecorderError("write made no progress") }
    remaining -= result
    cursor = cursor.advanced(by: result)
    completed += result
    if let prefixByteCount, completed == prefixByteCount, let context = operation.context {
      faultPlan?.perform(
        .duringIndexWrite(context, prefixByteCount: prefixByteCount),
        offset: offset
      )
    }
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

private func fileHasContent(_ url: URL) throws -> Bool {
  guard FileManager.default.fileExists(atPath: url.path) else { return false }
  do {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes[.size] as? NSNumber)?.int64Value ?? 0 > 0
  } catch {
    throw RecorderError("cannot inspect \(url.lastPathComponent): \(error.localizedDescription)")
  }
}
