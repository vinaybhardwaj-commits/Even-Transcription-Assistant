import CryptoKit
import Darwin
import Foundation
import Testing

@testable import TapeCapture
@testable import TapeCore

@Suite(.serialized)
struct TapeWriterDurabilityP1Tests {
  @Test(
    .enabled(
      if: ProcessInfo.processInfo.environment["ETA_DUR_PROBE_PATH"] != nil,
      "Set ETA_DUR_PROBE_PATH to the matching DurabilityFaultProbe executable."
    )
  )
  func dur02CrashAfterPCMAppend() throws {
    try durP1RunCrashScenario(.dur02)
  }

  @Test(
    .enabled(
      if: ProcessInfo.processInfo.environment["ETA_DUR_PROBE_PATH"] != nil,
      "Set ETA_DUR_PROBE_PATH to the matching DurabilityFaultProbe executable."
    )
  )
  func dur03CrashAfterTapeFullSync() throws {
    try durP1RunCrashScenario(.dur03)
  }

  @Test(
    .enabled(
      if: ProcessInfo.processInfo.environment["ETA_DUR_PROBE_PATH"] != nil,
      "Set ETA_DUR_PROBE_PATH to the matching DurabilityFaultProbe executable."
    )
  )
  func dur04CrashDuringExactPartialIndexAppend() throws {
    try durP1RunCrashScenario(.dur04)
  }

  @Test(
    .enabled(
      if: ProcessInfo.processInfo.environment["ETA_DUR_PROBE_PATH"] != nil,
      "Set ETA_DUR_PROBE_PATH to the matching DurabilityFaultProbe executable."
    )
  )
  func dur05CrashAfterIndexSync() throws {
    try durP1RunCrashScenario(.dur05)
  }

  @Test func dur09PCMWriteEIO() throws {
    try durP1RunEIOFixture(operation: .pcmWrite, useRecorderFinalizer: false)
  }

  @Test func dur09CheckpointTapeFullSyncEIO() throws {
    try durP1RunEIOFixture(operation: .tapeFullSync(.checkpoint), useRecorderFinalizer: false)
  }

  @Test func dur09CheckpointIndexWriteEIO() throws {
    try durP1RunEIOFixture(operation: .indexWrite(.checkpoint), useRecorderFinalizer: false)
  }

  @Test func dur09CheckpointIndexSyncEIOAndRecorderStopOwnership() throws {
    try durP1RunEIOFixture(operation: .indexSync(.checkpoint), useRecorderFinalizer: true)
  }

  @Test func dur08FreshDirectoryPermissionFailureIsLoud() throws {
    try #require(geteuid() != 0, "DUR-08 permission fixtures must not run as root")
    let root = try durP1TemporaryDirectory(label: "permission-create")
    defer { try? FileManager.default.removeItem(at: root) }
    let originalMode = try durP1Mode(root)
    defer { _ = chmod(root.path, originalMode) }
    try #require(chmod(root.path, S_IRUSR | S_IXUSR) == 0)

    let output = root.appendingPathComponent("fresh", isDirectory: true)
    let writer = TapeWriter(directory: output, deviceUID: durP1Device, ring: AudioRing())
    do {
      try writer.startAndWaitUntilReady()
      try? writer.stopAndWait()
      Issue.record("DUR-08 fresh-directory startup unexpectedly succeeded")
    } catch {}
    #expect(!FileManager.default.fileExists(atPath: output.path))
    #expect(writer.hasFailed)
  }

  @Test func dur08ReadOnlyExistingIndexPreservesCommittedState() throws {
    try #require(geteuid() != 0, "DUR-08 permission fixtures must not run as root")
    let directory = try durP1TemporaryDirectory(label: "permission-index")
    defer { try? FileManager.default.removeItem(at: directory) }
    let baseline = try durP1MakeBaseline(directory: directory)
    let indexURL = directory.appendingPathComponent("tape.idx")
    let originalMode = try durP1Mode(indexURL)
    var restored = false
    defer {
      if !restored { _ = chmod(indexURL.path, originalMode) }
    }
    try #require(chmod(indexURL.path, S_IRUSR) == 0)

    let writer = TapeWriter(directory: directory, deviceUID: durP1Device, ring: AudioRing())
    do {
      try writer.startAndWaitUntilReady()
      try? writer.stopAndWait()
      Issue.record("DUR-08 read-only index startup unexpectedly succeeded")
    } catch {}
    #expect(writer.hasFailed)
    #expect(try Data(contentsOf: baseline.pcmURL) == baseline.pcm)
    #expect(try Data(contentsOf: baseline.indexURL) == baseline.index)
    #expect(durP1SHA256(try Data(contentsOf: baseline.pcmURL)) == baseline.pcmSHA256)
    #expect(durP1SHA256(try Data(contentsOf: baseline.indexURL)) == baseline.indexSHA256)

    try #require(chmod(indexURL.path, originalMode) == 0)
    restored = true
    let read = try IndexLog.read(url: indexURL, pcmSize: baseline.pcmSize)
    #expect(read.records == baseline.records)
    #expect(read.discardedTrailingBytes == 0)
    #expect(try TapeVerifier.verify(directory: directory).passed)
  }

  @Test(
    .enabled(
      if: ProcessInfo.processInfo.environment["ETA_DUR08_ENOSPC"] == "1",
      "Set ETA_DUR08_ENOSPC=1 only for the reviewed disposable APFS acceptance fixture."
    )
  )
  func dur08IsolatedAPFSENOSPCFailureAndRecovery() throws {
    try durP1RunIsolatedENOSPCFixture()
  }
}

private let durP1Device = "dur-p1-fixture"
private let durP1FrameCount = 4_096
private let durP1CrashPrefixByteCount = 31
private let durP1FingerprintSourcePaths = [
  "Package.swift",
  "Sources/TapeCore/TapeFormat.swift",
  "Sources/TapeCore/TapeVerifier.swift",
  "Sources/TapeCore/WAVExporter.swift",
  "Sources/tapewriter/AudioDevices.swift",
  "Sources/tapewriter/AudioRing.swift",
  "Sources/tapewriter/CaptureTimeline.swift",
  "Sources/tapewriter/Clocks.swift",
  "Sources/tapewriter/DurabilityFaultBuild.swift",
  "Sources/tapewriter/DurabilityFaults.swift",
  "Sources/tapewriter/PCMResampler.swift",
  "Sources/tapewriter/Recorder.swift",
  "Sources/tapewriter/TapeWriter.swift",
  "Tests/DurabilityFaultProbe/main.swift",
]

private struct DurP1Baseline {
  let pcmURL: URL
  let indexURL: URL
  let pcm: Data
  let index: Data
  let pcmSHA256: String
  let indexSHA256: String
  let pcmSize: Int64
  let records: [IndexRecord]
}

private struct DurP1ProbeEvent: Codable, Equatable {
  let scenario: String
  let boundary: String
  let context: String
  let offset: Int64
  let prefixBytes: Int
  let sourceSHA256: String

  enum CodingKeys: String, CodingKey {
    case scenario, boundary, context, offset
    case prefixBytes = "prefix_bytes"
    case sourceSHA256 = "source_sha256"
  }
}

private enum DurP1CrashScenario: String {
  case dur02, dur03, dur04, dur05

  var boundary: String {
    switch self {
    case .dur02: "after_pcm_append"
    case .dur03: "after_tape_full_sync"
    case .dur04: "during_index_write"
    case .dur05: "after_index_sync"
    }
  }

  var expectedPrefixBytes: Int { self == .dur04 ? durP1CrashPrefixByteCount : 0 }
  var targetIsIndexed: Bool { self == .dur05 }
}

private final class DurP1AsyncResult: @unchecked Sendable {
  private let lock = NSLock()
  private var storedError: (any Error)?
  private var storedStopCount = 0
  private var storedStopPrecededError = false

  func stopped() {
    lock.withLock { storedStopCount += 1 }
  }

  func failed(_ error: any Error) {
    lock.withLock {
      storedStopPrecededError = storedStopCount == 1
      storedError = error
    }
  }

  var error: (any Error)? { lock.withLock { storedError } }
  var stopCount: Int { lock.withLock { storedStopCount } }
  var stopPrecededError: Bool { lock.withLock { storedStopPrecededError } }
}

private func durP1RunCrashScenario(_ scenario: DurP1CrashScenario) throws {
  let directory = try durP1TemporaryDirectory(label: scenario.rawValue)
  var cleanupAllowed = true
  defer {
    if cleanupAllowed {
      try? FileManager.default.removeItem(at: directory)
    } else {
      print(
        "\(scenario.rawValue) retained fixture after uncertain probe termination: \(directory.path)"
      )
    }
  }
  let baseline = try durP1MakeBaseline(directory: directory)
  let probe = try durP1ProbeExecutable()
  let event = try durP1LaunchProbe(
    probe,
    scenario: scenario,
    directory: directory,
    baselineOffset: baseline.pcmSize,
    cleanupAllowed: &cleanupAllowed
  )

  #expect(event.scenario == scenario.rawValue)
  #expect(event.boundary == scenario.boundary)
  #expect(event.context == "checkpoint")
  #expect(event.offset > baseline.pcmSize)
  #expect(event.offset.isMultiple(of: TapeConstants.bytesPerSample))
  #expect(event.prefixBytes == scenario.expectedPrefixBytes)
  #expect(event.sourceSHA256 == (try durP1CurrentSourceSHA256()))

  let crashedPCM = try Data(contentsOf: baseline.pcmURL)
  let crashedIndex = try Data(contentsOf: baseline.indexURL)
  let crashedPCMHash = durP1SHA256(crashedPCM)
  let crashedIndexHash = durP1SHA256(crashedIndex)
  let targetBytes = event.offset - baseline.pcmSize
  #expect(crashedPCM.count == Int(event.offset))
  #expect(crashedPCM.count.isMultiple(of: Int(TapeConstants.bytesPerSample)))
  #expect(crashedPCM.prefix(baseline.pcm.count) == baseline.pcm)
  #expect(crashedIndex.prefix(baseline.index.count) == baseline.index)
  #expect(targetBytes > 0)

  let preRestart = try IndexLog.read(
    url: baseline.indexURL,
    pcmSize: Int64(crashedPCM.count),
    repairTrailingPartial: false
  )
  let report = try TapeVerifier.verify(directory: directory)
  let expectedTail = scenario.targetIsIndexed ? 0 : targetBytes
  #expect(preRestart.discardedTrailingBytes == scenario.expectedPrefixBytes)
  #expect(report.discardedTrailingIndexBytes == scenario.expectedPrefixBytes)
  #expect(report.currentTailBytes == expectedTail)
  #expect(preRestart.records.allSatisfy { ($0.byteOffset ?? 0) <= Int64(crashedPCM.count) })
  #expect(
    preRestart.records.filter { $0.discontinuity == "stopped" }.count
      == baseline.records.filter { $0.discontinuity == "stopped" }.count)
  #expect(!preRestart.records.contains { $0.discontinuity == "ring_overflow" })
  let probeRecords = Array(preRestart.records.dropFirst(baseline.records.count))
  if scenario.targetIsIndexed {
    #expect(
      probeRecords.map { $0.discontinuity ?? "checkpoint" } == [
        "restart", "checkpoint", "checkpoint",
      ])
    #expect(preRestart.records.last?.byteOffset == event.offset)
    #expect(crashedIndex.count > baseline.index.count)
    #expect(crashedIndex.last == 0x0A)
  } else {
    #expect(probeRecords.map { $0.discontinuity ?? "checkpoint" } == ["restart", "checkpoint"])
    #expect(preRestart.records.last?.byteOffset == baseline.pcmSize)
    #expect(crashedIndex.count > baseline.index.count + scenario.expectedPrefixBytes)
    if scenario == .dur04 {
      #expect(crashedIndex.last != 0x0A)
      #expect(crashedIndex.count - preRestart.discardedTrailingBytes > baseline.index.count)
    } else {
      #expect(crashedIndex.last == 0x0A)
    }
  }

  let wavURL = directory.appendingPathComponent("crash.wav")
  try WAVExporter.export(pcmURL: baseline.pcmURL, wavURL: wavURL)
  let wav = try Data(contentsOf: wavURL)
  #expect(wav.count == 44 + crashedPCM.count)
  #expect(wav.dropFirst(44).prefix(baseline.pcm.count) == baseline.pcm)
  try FileManager.default.removeItem(at: wavURL)

  #expect(durP1SHA256(try Data(contentsOf: baseline.pcmURL)) == crashedPCMHash)
  #expect(durP1SHA256(try Data(contentsOf: baseline.indexURL)) == crashedIndexHash)

  let survivingOffset = preRestart.records.last?.byteOffset ?? 0
  let restartWriter = TapeWriter(
    directory: directory,
    deviceUID: durP1Device,
    ring: AudioRing()
  )
  try restartWriter.startAndWaitUntilReady()
  try restartWriter.stopAndWait()

  let recoveredPCM = try Data(contentsOf: baseline.pcmURL)
  let recoveredIndex = try Data(contentsOf: baseline.indexURL)
  let durableCrashIndex = crashedIndex.dropLast(event.prefixBytes)
  #expect(recoveredIndex.starts(with: durableCrashIndex))
  let recovered = try IndexLog.read(url: baseline.indexURL, pcmSize: Int64(recoveredPCM.count))
  let recoveredReport = try TapeVerifier.verify(directory: directory)
  let restart = try #require(recovered.records.last { $0.discontinuity == "restart" })
  #expect(restart.previousByteOffset == survivingOffset)
  #expect(restart.survivingTailBytes == expectedTail)
  #expect(restart.byteOffset == event.offset)
  #expect(recovered.discardedTrailingBytes == 0)
  #expect(recoveredReport.currentTailBytes == 0)
  #expect(recoveredReport.worstTailBytes == expectedTail)
  #expect(recoveredPCM == crashedPCM)
  #expect(durP1SHA256(recoveredPCM) == crashedPCMHash)
  #expect(recovered.records.allSatisfy { ($0.byteOffset ?? 0) <= Int64(recoveredPCM.count) })

  print(
    "\(scenario.rawValue.uppercased()) signal=SIGKILL baseline_pcm=\(baseline.pcmSize) "
      + "crash_pcm=\(crashedPCM.count) tail=\(expectedTail) discarded="
      + "\(scenario.expectedPrefixBytes) pcm_sha256=\(crashedPCMHash) "
      + "index_sha256=\(crashedIndexHash)"
  )
}

private func durP1RunEIOFixture(
  operation: DurabilityOperation,
  useRecorderFinalizer: Bool
) throws {
  let directory = try durP1TemporaryDirectory(label: "eio-\(operation.code.rawValue)")
  var cleanupAllowed = true
  defer {
    if cleanupAllowed {
      try? FileManager.default.removeItem(at: directory)
    } else {
      print("DUR-09 retained fixture after uncertain writer termination: \(directory.path)")
    }
  }
  let baseline = try durP1MakeBaseline(directory: directory)
  let targetOffset = baseline.pcmSize + (try durP1ConvertedByteCount(frameCount: durP1FrameCount))
  let specification = try DurabilityFaultSpecification(
    baselineOffset: baseline.pcmSize,
    targetOffset: targetOffset,
    point: .operation(operation),
    action: .fail(errno: EIO)
  )
  let plan = DurabilityFaultPlan(specification)
  let ring = AudioRing(slotCount: 6, framesPerSlot: durP1FrameCount)
  let writer = TapeWriter(
    directory: directory,
    deviceUID: durP1Device,
    ring: ring,
    faultPlan: plan
  )
  try writer.startAndWaitUntilReady()
  try durP1PublishAudio(ring, frameCount: durP1FrameCount)

  let completion = DispatchSemaphore(value: 0)
  let result = DurP1AsyncResult()
  DispatchQueue.global().async {
    do {
      if useRecorderFinalizer {
        try Recorder.finalizeCapture(
          stopCapture: { result.stopped() },
          ring: ring,
          writer: writer
        )
      } else {
        try writer.stopAndWait()
      }
    } catch {
      result.failed(error)
    }
    completion.signal()
  }
  if completion.wait(timeout: .now() + 5) != .success {
    cleanupAllowed = false
    throw DurP1TestError("DUR-09 writer did not terminate within five seconds")
  }
  #expect(writer.hasFailed)
  #expect(plan.wasClaimed)
  #expect(plan.injectedErrno(for: operation, offset: targetOffset) == nil)
  let syscallError = try #require(result.error as? DurabilitySyscallError)
  #expect(syscallError.errnoCode == EIO)
  #expect(syscallError.operationCode == operation.code.rawValue)
  #expect(syscallError.operation == operation)
  #expect(syscallError.operation.context == operation.context)
  #expect(syscallError.offset == targetOffset)
  if useRecorderFinalizer {
    #expect(result.stopCount == 1)
    #expect(result.stopPrecededError)
  }

  let failedPCM = try Data(contentsOf: baseline.pcmURL)
  let failedIndex = try Data(contentsOf: baseline.indexURL)
  let parsed = try IndexLog.read(
    url: baseline.indexURL,
    pcmSize: Int64(failedPCM.count),
    repairTrailingPartial: false
  )
  #expect(failedPCM.prefix(baseline.pcm.count) == baseline.pcm)
  #expect(failedIndex.prefix(baseline.index.count) == baseline.index)
  #expect(parsed.discardedTrailingBytes == 0)
  switch operation.code {
  case .pcmWrite, .tapeFullSync, .indexWrite:
    #expect(parsed.records.count == baseline.records.count + 2)
    #expect(parsed.records.last?.discontinuity == nil)
    #expect(parsed.records.last?.byteOffset == baseline.pcmSize)
  case .indexSync:
    #expect(parsed.records.count == baseline.records.count + 3)
    #expect(parsed.records.last?.discontinuity == nil)
    #expect(parsed.records.last?.byteOffset == targetOffset)
  }
  #expect(parsed.records.allSatisfy { ($0.byteOffset ?? 0) <= Int64(failedPCM.count) })
  #expect(
    parsed.records.filter { $0.discontinuity == "stopped" }.count
      == baseline.records.filter { $0.discontinuity == "stopped" }.count)
  #expect(
    !parsed.records.dropFirst(baseline.records.count).contains { $0.discontinuity == "stopped" })

  let recovery = TapeWriter(directory: directory, deviceUID: durP1Device, ring: AudioRing())
  try recovery.startAndWaitUntilReady()
  try recovery.stopAndWait()
  let recoveredPCM = try Data(contentsOf: baseline.pcmURL)
  let recovered = try IndexLog.read(url: baseline.indexURL, pcmSize: Int64(recoveredPCM.count))
  #expect(recovered.discardedTrailingBytes == 0)
  #expect(recovered.records.allSatisfy { ($0.byteOffset ?? 0) <= Int64(recoveredPCM.count) })
  #expect(try TapeVerifier.verify(directory: directory).passed)

  print(
    "DUR-09 operation=\(operation.code.rawValue) context="
      + "\(operation.context?.rawValue ?? "none") offset=\(targetOffset) errno=\(EIO) "
      + "pcm=\(failedPCM.count) index=\(failedIndex.count)"
  )
}

private func durP1MakeBaseline(directory: URL) throws -> DurP1Baseline {
  let ring = AudioRing(slotCount: 6, framesPerSlot: durP1FrameCount)
  let writer = TapeWriter(directory: directory, deviceUID: durP1Device, ring: ring)
  try writer.startAndWaitUntilReady()
  var stopAttempted = false
  defer {
    if !stopAttempted { try? writer.stopAndWait() }
  }
  try durP1PublishAudio(ring, frameCount: durP1FrameCount)
  stopAttempted = true
  try writer.stopAndWait()

  let pcmURL = directory.appendingPathComponent("tape.pcm")
  let indexURL = directory.appendingPathComponent("tape.idx")
  let pcm = try Data(contentsOf: pcmURL)
  let index = try Data(contentsOf: indexURL)
  let parsed = try IndexLog.read(url: indexURL, pcmSize: Int64(pcm.count))
  try #require(!pcm.isEmpty)
  try #require(pcm.count.isMultiple(of: Int(TapeConstants.bytesPerSample)))
  try #require(!parsed.records.isEmpty)
  try #require(parsed.records.last?.byteOffset == Int64(pcm.count))
  try #require(parsed.discardedTrailingBytes == 0)
  try #require(TapeVerifier.verify(directory: directory).passed)
  return DurP1Baseline(
    pcmURL: pcmURL,
    indexURL: indexURL,
    pcm: pcm,
    index: index,
    pcmSHA256: durP1SHA256(pcm),
    indexSHA256: durP1SHA256(index),
    pcmSize: Int64(pcm.count),
    records: parsed.records
  )
}

private func durP1PublishAudio(_ ring: AudioRing, frameCount: Int) throws {
  try #require(durP1TryPublishAudio(ring, frameCount: frameCount))
}

private func durP1TryPublishAudio(_ ring: AudioRing, frameCount: Int) -> Bool {
  var samples = durP1Samples(frameCount: frameCount)
  let monoStart = monotonicNowNS()
  let wallStart = wallNowNS()
  let duration = UInt64(frameCount) * 1_000_000_000 / UInt64(TapeConstants.sampleRate)
  return samples.withUnsafeMutableBufferPointer { buffer in
    var channel = buffer.baseAddress!
    return withUnsafePointer(to: &channel) { channels in
      ring.writeAudio(
        channels: channels,
        channelCount: 1,
        frameCount: frameCount,
        sampleRate: Double(TapeConstants.sampleRate),
        monoStartNS: monoStart,
        monoEndNS: monoStart + duration,
        wallStartNS: wallStart,
        wallEndNS: wallStart + duration,
        boundaries: BoundaryBatch()
      )
    }
  }
}

private func durP1Samples(frameCount: Int) -> [Float] {
  (0..<frameCount).map { index in
    Float(0.125 * sin(2 * Double.pi * Double(index % 257) / 257))
  }
}

private func durP1ConvertedByteCount(frameCount: Int) throws -> Int64 {
  let converter = try PCMResampler(inputSampleRate: Double(TapeConstants.sampleRate))
  var samples = durP1Samples(frameCount: frameCount)
  var outputFrames: Int64 = 0
  try samples.withUnsafeMutableBufferPointer { buffer in
    try converter.convert(samples: buffer.baseAddress!, frameCount: buffer.count) { _, count in
      outputFrames += Int64(count)
    }
  }
  try converter.finish { _, count in outputFrames += Int64(count) }
  return outputFrames * TapeConstants.bytesPerSample
}

private func durP1ProbeExecutable() throws -> URL {
  let environment = ProcessInfo.processInfo.environment
  let path = try #require(environment["ETA_DUR_PROBE_PATH"])
  try #require(path.hasPrefix("/"), "ETA_DUR_PROBE_PATH must be absolute")
  let supplied = URL(fileURLWithPath: path).standardizedFileURL
  let resolved = supplied.resolvingSymlinksInPath()
  try #require(supplied.path == path, "ETA_DUR_PROBE_PATH must name the exact standardized path")
  try #require(supplied == resolved, "ETA_DUR_PROBE_PATH must not be a symlink")
  try #require(resolved.lastPathComponent == "DurabilityFaultProbe")
  try #require(FileManager.default.isExecutableFile(atPath: resolved.path))

  let products = resolved.deletingLastPathComponent()
  let testExecutable = products.appendingPathComponent(
    "TapeCoreTests.xctest/Contents/MacOS/TapeCoreTests")
  try #require(
    FileManager.default.isExecutableFile(atPath: testExecutable.path),
    "DurabilityFaultProbe must have the matching test bundle beside it"
  )

  let package = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  let probeDate = try #require(
    (try FileManager.default.attributesOfItem(atPath: resolved.path)[.modificationDate]) as? Date)
  for relativePath in durP1FingerprintSourcePaths {
    let source = package.appendingPathComponent(relativePath)
    let sourceDate = try #require(
      (try FileManager.default.attributesOfItem(atPath: source.path)[.modificationDate]) as? Date)
    try #require(
      probeDate >= sourceDate,
      "DurabilityFaultProbe is stale relative to \(relativePath)"
    )
  }
  let testDate = try #require(
    (try FileManager.default.attributesOfItem(atPath: testExecutable.path)[.modificationDate])
      as? Date)
  let testSource = package.appendingPathComponent(
    "Tests/TapeCoreTests/TapeWriterDurabilityP1Tests.swift")
  let testSourceDate = try #require(
    (try FileManager.default.attributesOfItem(atPath: testSource.path)[.modificationDate]) as? Date)
  try #require(testDate >= testSourceDate, "the durability test bundle is stale")
  return resolved
}

private func durP1LaunchProbe(
  _ executable: URL,
  scenario: DurP1CrashScenario,
  directory: URL,
  baselineOffset: Int64,
  cleanupAllowed: inout Bool
) throws -> DurP1ProbeEvent {
  let standardOutput = Pipe()
  let standardError = Pipe()
  let process = Process()
  process.executableURL = executable
  var arguments = [
    "--scenario", scenario.rawValue,
    "--directory", directory.path,
    "--baseline-offset", String(baselineOffset),
    "--event-fd", String(STDOUT_FILENO),
  ]
  if scenario == .dur04 {
    arguments += ["--prefix-count", String(durP1CrashPrefixByteCount)]
  }
  process.arguments = arguments
  process.standardOutput = standardOutput
  process.standardError = standardError
  try process.run()

  let deadline = Date().addingTimeInterval(10)
  while process.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
  if process.isRunning {
    _ = kill(process.processIdentifier, SIGKILL)
    let killDeadline = Date().addingTimeInterval(2)
    while process.isRunning, Date() < killDeadline { Thread.sleep(forTimeInterval: 0.01) }
    if !process.isRunning { process.waitUntilExit() }
    Issue.record("\(scenario.rawValue) probe timed out and was killed by the parent")
    if process.isRunning { cleanupAllowed = false }
    try #require(!process.isRunning, "probe remained alive after SIGKILL")
    throw DurP1TestError("probe termination timeout")
  }
  process.waitUntilExit()
  let eventData = try standardOutput.fileHandleForReading.readToEnd() ?? Data()
  let errorData = try standardError.fileHandleForReading.readToEnd() ?? Data()
  let stderrText = String(decoding: errorData, as: UTF8.self)
  try #require(stderrText.isEmpty, "probe wrote stderr: \(stderrText)")
  try #require(process.terminationReason == .uncaughtSignal, "probe exited normally")
  try #require(process.terminationStatus == SIGKILL, "probe died from the wrong signal")

  let lines = eventData.split(separator: 0x0A, omittingEmptySubsequences: true)
  try #require(lines.count == 1, "probe must emit exactly one structured event")
  return try JSONDecoder().decode(DurP1ProbeEvent.self, from: Data(lines[0]))
}

private struct DurP1TestError: Error, LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

private func durP1SHA256(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func durP1CurrentSourceSHA256() throws -> String {
  let package = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  var hasher = SHA256()
  for relativePath in durP1FingerprintSourcePaths {
    hasher.update(data: Data(relativePath.utf8))
    hasher.update(data: Data([0]))
    let source = try Data(contentsOf: package.appendingPathComponent(relativePath))
    if relativePath == "Sources/tapewriter/DurabilityFaultBuild.swift" {
      let text = String(decoding: source, as: UTF8.self)
      let expression = try NSRegularExpression(
        pattern: "(package static let sourceSHA256\\s*=\\s*)\"[0-9a-f]{64}\""
      )
      let range = NSRange(text.startIndex..<text.endIndex, in: text)
      guard expression.numberOfMatches(in: text, range: range) == 1 else {
        throw DurP1TestError("durability source fingerprint carrier must contain one digest literal")
      }
      let normalized = expression.stringByReplacingMatches(
        in: text,
        range: range,
        withTemplate: "$1\"SOURCE_SHA256\""
      )
      hasher.update(data: Data(normalized.utf8))
    } else {
      hasher.update(data: source)
    }
  }
  return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

private func durP1TemporaryDirectory(label: String) throws -> URL {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
    "eta-dur-p1-\(label)-\(UUID().uuidString)",
    isDirectory: true
  )
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
  return directory
}

private func durP1Mode(_ url: URL) throws -> mode_t {
  var value = stat()
  guard stat(url.path, &value) == 0 else {
    throw DurP1TestError("cannot stat \(url.path): \(String(cString: strerror(errno)))")
  }
  return value.st_mode & mode_t(0o7777)
}

private struct DurP1CommandResult {
  let stdout: Data
  let stderr: String
}

private func durP1Command(_ executable: String, _ arguments: [String], timeout: TimeInterval = 30)
  throws -> DurP1CommandResult
{
  let captureDirectory = try durP1TemporaryDirectory(label: "command-output")
  defer { try? FileManager.default.removeItem(at: captureDirectory) }
  let outputURL = captureDirectory.appendingPathComponent("stdout")
  let errorURL = captureDirectory.appendingPathComponent("stderr")
  try #require(FileManager.default.createFile(atPath: outputURL.path, contents: nil))
  try #require(FileManager.default.createFile(atPath: errorURL.path, contents: nil))
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
    if process.isRunning {
      _ = kill(process.processIdentifier, SIGKILL)
      let killDeadline = Date().addingTimeInterval(2)
      while process.isRunning, Date() < killDeadline { Thread.sleep(forTimeInterval: 0.05) }
    }
    if !process.isRunning { process.waitUntilExit() }
    try #require(!process.isRunning, "command remained alive after SIGKILL: \(executable)")
    throw DurP1TestError("command timed out: \(executable) \(arguments.joined(separator: " "))")
  }
  process.waitUntilExit()
  let stdout = try Data(contentsOf: outputURL)
  let stderr = String(decoding: try Data(contentsOf: errorURL), as: UTF8.self)
  guard process.terminationReason == .exit, process.terminationStatus == 0 else {
    throw DurP1TestError(
      "command failed (\(process.terminationStatus)): \(executable) "
        + "\(arguments.joined(separator: " ")): \(stderr)"
    )
  }
  return DurP1CommandResult(stdout: stdout, stderr: stderr)
}

private struct DurP1Attachment {
  let imageURL: URL
  let mountURL: URL
  let mountedDevice: String
  let wholeDevice: String
}

private struct DurP1MountedImage {
  let attachment: DurP1Attachment
  let deviceIdentifier: String
  let parentWholeDisk: String
  let volumeUUID: String

  var imageURL: URL { attachment.imageURL }
  var mountURL: URL { attachment.mountURL }
  var mountedDevice: String { attachment.mountedDevice }
  var wholeDevice: String { attachment.wholeDevice }
}

private func durP1ImageSizeMiB() throws -> Int {
  let raw = ProcessInfo.processInfo.environment["ETA_DUR08_IMAGE_MIB"] ?? "128"
  guard let value = Int(raw), value >= 128,
    value <= Int(Int64.max / (3 * 1_024 * 1_024))
  else {
    throw DurP1TestError("ETA_DUR08_IMAGE_MIB must be an integer of at least 128")
  }
  return value
}

private func durP1RunIsolatedENOSPCFixture() throws {
  let imageMiB = try durP1ImageSizeMiB()
  let imageBytes = Int64(imageMiB) * 1_024 * 1_024
  let root = try durP1TemporaryDirectory(label: "enospace-image")
  var attachment: DurP1Attachment?
  var mounted: DurP1MountedImage?
  var attachAttempted = false
  var cleanupUncertain = false
  var writerMayBeRunning = false
  var writerStopInFlight = false
  defer {
    if writerMayBeRunning {
      print("DUR-08 retained fixture because the writer may still be running: \(root.path)")
    } else if cleanupUncertain {
      print("DUR-08 retained uncertain fixture for manual inspection: \(root.path)")
    } else if let mounted {
      if durP1Detach(mounted) {
        _ = durP1RemoveDetachedFixture(root: root, fixture: mounted.attachment)
      }
    } else if let attachment {
      if durP1Detach(attachment) {
        _ = durP1RemoveDetachedFixture(root: root, fixture: attachment)
      }
    } else if !attachAttempted {
      _ = durP1RemoveUnattachedFixture(root: root)
    } else {
      print("DUR-08 retained unidentified attachment for manual inspection: \(root.path)")
    }
  }

  let free = try #require(
    (try FileManager.default.attributesOfFileSystem(forPath: root.path)[.systemFreeSize]
      as? NSNumber)?.int64Value)
  try #require(
    free >= imageBytes * 3,
    "DUR-08 ENOSPC host preflight requires at least \(imageMiB * 3) MiB free"
  )
  let fixtureID = UUID().uuidString.lowercased()
  let imageURL = root.appendingPathComponent("\(fixtureID).sparseimage")
  let mountURL = root.appendingPathComponent("mount-\(fixtureID)", isDirectory: true)
  try FileManager.default.createDirectory(at: mountURL, withIntermediateDirectories: false)
  let volumeName = "eta-dur08-\(fixtureID)"
  _ = try durP1Command(
    "/usr/bin/hdiutil",
    [
      "create", "-size", "\(imageMiB)m", "-fs", "APFS", "-volname", volumeName,
      "-type", "SPARSE", "-ov", imageURL.path,
    ],
    timeout: 60
  )
  do {
    attachAttempted = true
    let attach = try durP1Command(
      "/usr/bin/hdiutil",
      ["attach", "-plist", "-nobrowse", "-mountpoint", mountURL.path, imageURL.path],
      timeout: 60
    )
    attachment = try durP1ParseAttachment(
      attach.stdout,
      imageURL: imageURL,
      mountURL: mountURL
    )
  } catch {
    attachment = durP1DiscoverAttachment(imageURL: imageURL, mountURL: mountURL)
    if attachment == nil {
      cleanupUncertain = true
      print(
        "DUR-08 attach failed without a recoverable device identity; inspect before deleting "
          + "\(imageURL.path): /usr/bin/hdiutil info -plist"
      )
    }
    throw error
  }
  mounted = try durP1VerifyMount(try #require(attachment))
  let fixture = try #require(mounted)

  let tapeDirectory = mountURL.appendingPathComponent("tape", isDirectory: true)
  try FileManager.default.createDirectory(at: tapeDirectory, withIntermediateDirectories: false)
  let baseline = try durP1MakeBaseline(directory: tapeDirectory)
  let fillerURL = mountURL.appendingPathComponent("filler-\(fixtureID).bin")
  let fillerFD = open(fillerURL.path, O_CREAT | O_EXCL | O_WRONLY, S_IRUSR | S_IWUSR)
  try #require(fillerFD >= 0, "cannot create isolated-volume filler")
  var fillerOpen = true
  defer { if fillerOpen { close(fillerFD) } }
  let ring = AudioRing(slotCount: 8, framesPerSlot: durP1FrameCount)
  let writer = TapeWriter(directory: tapeDirectory, deviceUID: durP1Device, ring: ring)
  defer {
    if writerMayBeRunning, !writerStopInFlight {
      if fillerOpen {
        close(fillerFD)
        fillerOpen = false
      }
      try? FileManager.default.removeItem(at: fillerURL)
      let completion = DispatchSemaphore(value: 0)
      DispatchQueue.global().async {
        try? writer.stopAndWait()
        completion.signal()
      }
      if completion.wait(timeout: .now() + 10) == .success {
        writerMayBeRunning = false
      } else {
        cleanupUncertain = true
      }
    }
  }
  writerMayBeRunning = true
  do {
    try writer.startAndWaitUntilReady()
  } catch {
    writerMayBeRunning = false
    throw error
  }
  let blockSize = 1_048_576
  let block = [UInt8](repeating: 0xA5, count: blockSize)
  var fillerBytes: Int64 = 0
  var sawENOSPC = false
  try block.withUnsafeBytes { bytes in
    while fillerBytes < imageBytes * 2 {
      let result = Darwin.write(fillerFD, bytes.baseAddress!, bytes.count)
      let writeErrno = errno
      if result < 0 {
        if writeErrno == EINTR { continue }
        if writeErrno == ENOSPC {
          sawENOSPC = true
          break
        }
        throw DurP1TestError("filler write failed with errno \(writeErrno)")
      }
      guard result > 0 else { throw DurP1TestError("filler write made no progress") }
      fillerBytes += Int64(result)
      if fillerBytes.isMultiple(of: 8 * 1_048_576) {
        let syncResult = fsync(fillerFD)
        if syncResult != 0, errno == ENOSPC {
          sawENOSPC = true
          break
        }
        guard syncResult == 0 else {
          throw DurP1TestError("filler fsync failed with errno \(errno)")
        }
      }
    }
  }
  if fsync(fillerFD) != 0 {
    try #require(errno == ENOSPC)
    sawENOSPC = true
  }
  try #require(sawENOSPC, "isolated APFS filler did not reach ENOSPC")

  var submitted = 0
  let inputDeadline = Date().addingTimeInterval(20)
  while !writer.hasFailed, submitted < 1_024, Date() < inputDeadline {
    if durP1TryPublishAudio(ring, frameCount: durP1FrameCount) {
      submitted += 1
    } else {
      Thread.sleep(forTimeInterval: 0.001)
    }
    let waitUntil = Date().addingTimeInterval(0.02)
    while !ring.isEmpty, !writer.hasFailed, Date() < waitUntil {
      Thread.sleep(forTimeInterval: 0.001)
    }
  }

  let completion = DispatchSemaphore(value: 0)
  let result = DurP1AsyncResult()
  writerStopInFlight = true
  DispatchQueue.global().async {
    do { try writer.stopAndWait() } catch { result.failed(error) }
    completion.signal()
  }
  if completion.wait(timeout: .now() + 10) != .success {
    close(fillerFD)
    fillerOpen = false
    try? FileManager.default.removeItem(at: fillerURL)
    if completion.wait(timeout: .now() + 10) != .success {
      cleanupUncertain = true
      throw DurP1TestError(
        "DUR-08 writer remained live after ENOSPC space was restored; fixture retained"
      )
    }
  }
  writerMayBeRunning = false
  writerStopInFlight = false
  try #require(writer.hasFailed, "DUR-08 ENOSPC writer stopped cleanly instead of failing loudly")
  let syscallError = try #require(result.error as? DurabilitySyscallError)
  try #require(syscallError.errnoCode == ENOSPC)

  let fullPCM = try Data(contentsOf: baseline.pcmURL)
  let fullIndex = try Data(contentsOf: baseline.indexURL)
  let fullPCMHash = durP1SHA256(fullPCM)
  let fullIndexHash = durP1SHA256(fullIndex)
  let fullRead = try IndexLog.read(
    url: baseline.indexURL,
    pcmSize: Int64(fullPCM.count),
    repairTrailingPartial: false
  )
  #expect(fullPCM.prefix(baseline.pcm.count) == baseline.pcm)
  #expect(fullIndex.prefix(baseline.index.count) == baseline.index)
  #expect(fullRead.records.allSatisfy { ($0.byteOffset ?? 0) <= Int64(fullPCM.count) })
  #expect(
    fullRead.records.filter { $0.discontinuity == "stopped" }.count
      == baseline.records.filter { $0.discontinuity == "stopped" }.count)
  let survivingOffset = fullRead.records.last?.byteOffset ?? 0
  let expectedTail = Int64(fullPCM.count) - survivingOffset
  _ = try TapeVerifier.verify(directory: tapeDirectory)
  #expect(durP1SHA256(try Data(contentsOf: baseline.pcmURL)) == fullPCMHash)
  #expect(durP1SHA256(try Data(contentsOf: baseline.indexURL)) == fullIndexHash)

  if fillerOpen {
    close(fillerFD)
    fillerOpen = false
  }
  if FileManager.default.fileExists(atPath: fillerURL.path) {
    try FileManager.default.removeItem(at: fillerURL)
  }
  let mountFD = open(mountURL.path, O_RDONLY)
  if mountFD >= 0 {
    _ = fsync(mountFD)
    close(mountFD)
  }

  let recovery = TapeWriter(directory: tapeDirectory, deviceUID: durP1Device, ring: AudioRing())
  try recovery.startAndWaitUntilReady()
  try recovery.stopAndWait()
  let recoveredPCM = try Data(contentsOf: baseline.pcmURL)
  let recovered = try IndexLog.read(url: baseline.indexURL, pcmSize: Int64(recoveredPCM.count))
  let recoveryReport = try TapeVerifier.verify(directory: tapeDirectory)
  let restart = try #require(recovered.records.last { $0.discontinuity == "restart" })
  #expect(restart.previousByteOffset == survivingOffset)
  #expect(restart.survivingTailBytes == expectedTail)
  #expect(restart.byteOffset == Int64(recoveredPCM.count))
  #expect(recovered.discardedTrailingBytes == 0)
  #expect(recovered.records.allSatisfy { ($0.byteOffset ?? 0) <= Int64(recoveredPCM.count) })
  #expect(recoveryReport.currentTailBytes == 0)
  #expect(recoveryReport.worstTailBytes == expectedTail)

  print(
    "DUR-08 ENOSPC image_mib=\(imageMiB) image=\(fixture.imageURL.path) "
      + "device=\(fixture.wholeDevice) errno=\(syscallError.errnoCode) "
      + "operation=\(syscallError.operationCode) "
      + "mount=\(fixture.mountURL.path) filler=\(fillerBytes) submitted=\(submitted) "
      + "pcm=\(fullPCM.count) index=\(fullIndex.count)"
  )
}

private func durP1ParseAttachment(
  _ plistData: Data,
  imageURL: URL,
  mountURL: URL
) throws -> DurP1Attachment {
  let plist = try #require(
    try PropertyListSerialization.propertyList(from: plistData, format: nil)
      as? [String: Any])
  let entities = try #require(plist["system-entities"] as? [[String: Any]])
  let mountedEntity = try #require(
    entities.first {
      guard let path = $0["mount-point"] as? String else { return false }
      return durP1PathsEqual(URL(fileURLWithPath: path), mountURL)
    })
  let mountedDevice = try #require(mountedEntity["dev-entry"] as? String)
  let wholeEntity = try #require(
    entities.first {
      guard let entry = $0["dev-entry"] as? String else { return false }
      let diskNumber = entry.dropFirst("/dev/disk".count)
      return $0["content-hint"] as? String == "GUID_partition_scheme"
        && entry.hasPrefix("/dev/disk") && !diskNumber.isEmpty
        && diskNumber.allSatisfy(\.isNumber)
    })
  let wholeDevice = try #require(wholeEntity["dev-entry"] as? String)
  try #require(mountedDevice.hasPrefix("/dev/disk"))
  try #require(wholeDevice.hasPrefix("/dev/disk"))
  return DurP1Attachment(
    imageURL: durP1CanonicalURL(imageURL),
    mountURL: durP1CanonicalURL(mountURL),
    mountedDevice: mountedDevice,
    wholeDevice: wholeDevice
  )
}

private func durP1DiscoverAttachment(imageURL: URL, mountURL: URL) -> DurP1Attachment? {
  guard
    let result = try? durP1Command("/usr/bin/hdiutil", ["info", "-plist"], timeout: 10),
    let object = try? PropertyListSerialization.propertyList(from: result.stdout, format: nil),
    let plist = object as? [String: Any],
    let images = plist["images"] as? [[String: Any]],
    let image = images.first(where: {
      guard let path = $0["image-path"] as? String else { return false }
      return durP1PathsEqual(URL(fileURLWithPath: path), imageURL)
    }),
    let entities = image["system-entities"] as? [[String: Any]],
    let mountedDevice = entities.first(where: {
      guard let path = $0["mount-point"] as? String else { return false }
      return durP1PathsEqual(URL(fileURLWithPath: path), mountURL)
    })?["dev-entry"] as? String,
    let wholeDevice = entities.first(where: {
      guard let entry = $0["dev-entry"] as? String else { return false }
      let diskNumber = entry.dropFirst("/dev/disk".count)
      return $0["content-hint"] as? String == "GUID_partition_scheme"
        && entry.hasPrefix("/dev/disk") && !diskNumber.isEmpty
        && diskNumber.allSatisfy(\.isNumber)
    })?["dev-entry"] as? String
  else { return nil }
  return DurP1Attachment(
    imageURL: durP1CanonicalURL(imageURL),
    mountURL: durP1CanonicalURL(mountURL),
    mountedDevice: mountedDevice,
    wholeDevice: wholeDevice
  )
}

private func durP1VerifyMount(_ attachment: DurP1Attachment) throws -> DurP1MountedImage {
  try #require(durP1ImageIdentityMatches(attachment))
  let infoData = try durP1Command(
    "/usr/sbin/diskutil", ["info", "-plist", attachment.mountedDevice]
  ).stdout
  let info = try #require(
    try PropertyListSerialization.propertyList(from: infoData, format: nil)
      as? [String: Any])
  let identifier = try #require(info["DeviceIdentifier"] as? String)
  let parent = try #require(info["ParentWholeDisk"] as? String)
  let volumeUUID = try #require(info["VolumeUUID"] as? String)
  try #require((info["FilesystemType"] as? String)?.lowercased() == "apfs")
  try #require(
    (info["MountPoint"] as? String).map {
      durP1PathsEqual(URL(fileURLWithPath: $0), attachment.mountURL)
    } == true)

  var filesystem = statfs()
  try #require(statfs(attachment.mountURL.path, &filesystem) == 0)
  let filesystemType = withUnsafePointer(to: &filesystem.f_fstypename) {
    $0.withMemoryRebound(to: CChar.self, capacity: Int(MFSNAMELEN)) { String(cString: $0) }
  }
  let mountedFrom = withUnsafePointer(to: &filesystem.f_mntfromname) {
    $0.withMemoryRebound(to: CChar.self, capacity: Int(MNAMELEN)) { String(cString: $0) }
  }
  let mountedOn = withUnsafePointer(to: &filesystem.f_mntonname) {
    $0.withMemoryRebound(to: CChar.self, capacity: Int(MNAMELEN)) { String(cString: $0) }
  }
  try #require(filesystemType.lowercased() == "apfs")
  try #require(mountedFrom == attachment.mountedDevice)
  try #require(durP1PathsEqual(URL(fileURLWithPath: mountedOn), attachment.mountURL))

  var hostFilesystem = statfs()
  try #require(
    statfs(attachment.imageURL.deletingLastPathComponent().path, &hostFilesystem) == 0)
  try #require(
    hostFilesystem.f_fsid.val.0 != filesystem.f_fsid.val.0
      || hostFilesystem.f_fsid.val.1 != filesystem.f_fsid.val.1)

  return DurP1MountedImage(
    attachment: attachment,
    deviceIdentifier: identifier,
    parentWholeDisk: parent,
    volumeUUID: volumeUUID
  )
}

private func durP1MountIdentityMatches(_ fixture: DurP1MountedImage) -> Bool {
  guard
    durP1ImageIdentityMatches(fixture.attachment),
    let result = try? durP1Command(
      "/usr/sbin/diskutil", ["info", "-plist", fixture.mountedDevice], timeout: 10),
    let object = try? PropertyListSerialization.propertyList(from: result.stdout, format: nil),
    let info = object as? [String: Any]
  else { return false }
  return info["DeviceIdentifier"] as? String == fixture.deviceIdentifier
    && info["ParentWholeDisk"] as? String == fixture.parentWholeDisk
    && info["VolumeUUID"] as? String == fixture.volumeUUID
    && (info["MountPoint"] as? String).map {
      durP1PathsEqual(URL(fileURLWithPath: $0), fixture.mountURL)
    } == true
    && (info["FilesystemType"] as? String)?.lowercased() == "apfs"
}

private func durP1Detach(_ fixture: DurP1MountedImage) -> Bool {
  durP1Detach(fixture.attachment) { durP1MountIdentityMatches(fixture) }
}

private func durP1ImageIdentityMatches(_ fixture: DurP1Attachment) -> Bool {
  guard
    let result = try? durP1Command("/usr/bin/hdiutil", ["info", "-plist"], timeout: 10),
    let object = try? PropertyListSerialization.propertyList(from: result.stdout, format: nil),
    let plist = object as? [String: Any],
    let images = plist["images"] as? [[String: Any]],
    let image = images.first(where: {
      guard let path = $0["image-path"] as? String else { return false }
      return durP1PathsEqual(URL(fileURLWithPath: path), fixture.imageURL)
    }),
    let entities = image["system-entities"] as? [[String: Any]]
  else { return false }
  let devices = Set(entities.compactMap { $0["dev-entry"] as? String })
  return devices.contains(fixture.wholeDevice) && devices.contains(fixture.mountedDevice)
}

private func durP1ImageAttachmentState(_ fixture: DurP1Attachment) -> Bool? {
  guard
    let result = try? durP1Command("/usr/bin/hdiutil", ["info", "-plist"], timeout: 10),
    let object = try? PropertyListSerialization.propertyList(from: result.stdout, format: nil),
    let plist = object as? [String: Any],
    let images = plist["images"] as? [[String: Any]]
  else { return nil }
  return images.contains {
    guard let path = $0["image-path"] as? String else { return false }
    return durP1PathsEqual(URL(fileURLWithPath: path), fixture.imageURL)
  }
}

private func durP1Detach(_ fixture: DurP1Attachment) -> Bool {
  durP1Detach(fixture) { durP1ImageIdentityMatches(fixture) }
}

private func durP1Detach(
  _ fixture: DurP1Attachment,
  identityMatches: () -> Bool
) -> Bool {
  guard let attached = durP1ImageAttachmentState(fixture) else {
    print("DUR-08 cleanup could not establish image attachment state: \(fixture.imageURL.path)")
    return false
  }
  if !attached { return true }
  guard identityMatches() else {
    print(
      "DUR-08 cleanup image identity mismatch; inspect before manual detach: "
        + "/usr/bin/hdiutil detach \(fixture.wholeDevice)"
    )
    return false
  }
  _ = try? durP1Command("/usr/bin/hdiutil", ["detach", fixture.wholeDevice], timeout: 30)
  if durP1ImageAttachmentState(fixture) == false { return true }
  guard identityMatches() else {
    print(
      "DUR-08 normal detach failed and identity changed; inspect manually: "
        + "/usr/bin/hdiutil detach \(fixture.wholeDevice)"
    )
    return false
  }
  _ = try? durP1Command(
    "/usr/bin/hdiutil", ["detach", "-force", fixture.wholeDevice], timeout: 30)
  if durP1ImageAttachmentState(fixture) == false { return true }
  print("DUR-08 manual cleanup required: /usr/bin/hdiutil detach -force \(fixture.wholeDevice)")
  return false
}

private func durP1RemoveDetachedFixture(root: URL, fixture: DurP1Attachment) -> Bool {
  guard durP1ImageAttachmentState(fixture) == false else {
    print("DUR-08 retained fixture because detach could not be verified: \(root.path)")
    return false
  }
  guard durP1Rmdir(fixture.mountURL) else {
    print("DUR-08 retained fixture because mount directory is not safely removable: \(root.path)")
    return false
  }
  if unlink(fixture.imageURL.path) != 0, errno != ENOENT {
    print("DUR-08 retained image after unlink failure errno=\(errno): \(fixture.imageURL.path)")
    return false
  }
  guard durP1Rmdir(root) else {
    print("DUR-08 retained non-empty fixture root: \(root.path)")
    return false
  }
  return true
}

private func durP1RemoveUnattachedFixture(root: URL) -> Bool {
  do {
    try FileManager.default.removeItem(at: root)
    return true
  } catch {
    print("DUR-08 could not remove unattached fixture root \(root.path): \(error)")
    return false
  }
}

private func durP1Rmdir(_ url: URL) -> Bool {
  rmdir(url.path) == 0 || errno == ENOENT
}

private func durP1CanonicalURL(_ url: URL) -> URL {
  url.standardizedFileURL.resolvingSymlinksInPath()
}

private func durP1PathsEqual(_ lhs: URL, _ rhs: URL) -> Bool {
  durP1CanonicalURL(lhs) == durP1CanonicalURL(rhs)
}
