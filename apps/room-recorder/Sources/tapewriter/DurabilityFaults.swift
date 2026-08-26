import Darwin
import Foundation
import Synchronization
import TapeCore

enum DurabilityRecordContext: String, Sendable {
  case checkpoint
  case restart
  case discontinuity
  case stopped
}

enum DurabilityOperationCode: Int32, Sendable {
  case pcmWrite = 1
  case tapeFullSync = 2
  case indexWrite = 3
  case indexSync = 4
}

struct DurabilityOperation: Equatable, Sendable {
  let code: DurabilityOperationCode
  let context: DurabilityRecordContext?

  private init(code: DurabilityOperationCode, context: DurabilityRecordContext?) {
    self.code = code
    self.context = context
  }

  static let pcmWrite = DurabilityOperation(code: .pcmWrite, context: nil)

  static func tapeFullSync(_ context: DurabilityRecordContext) -> DurabilityOperation {
    DurabilityOperation(code: .tapeFullSync, context: context)
  }

  static func indexWrite(_ context: DurabilityRecordContext) -> DurabilityOperation {
    DurabilityOperation(code: .indexWrite, context: context)
  }

  static func indexSync(_ context: DurabilityRecordContext) -> DurabilityOperation {
    DurabilityOperation(code: .indexSync, context: context)
  }
}

enum DurabilityBoundary: Equatable, Sendable {
  case afterPCMAppend
  case afterTapeFullSync(DurabilityRecordContext)
  case duringIndexWrite(DurabilityRecordContext, prefixByteCount: Int)
  case afterIndexSync(DurabilityRecordContext)

  var eventName: String {
    switch self {
    case .afterPCMAppend: "after_pcm_append"
    case .afterTapeFullSync: "after_tape_full_sync"
    case .duringIndexWrite: "during_index_write"
    case .afterIndexSync: "after_index_sync"
    }
  }

  var context: DurabilityRecordContext {
    switch self {
    case .afterPCMAppend: .checkpoint
    case .afterTapeFullSync(let context), .duringIndexWrite(let context, _),
      .afterIndexSync(let context):
      context
    }
  }

  var prefixByteCount: Int? {
    if case .duringIndexWrite(_, let count) = self { return count }
    return nil
  }
}

enum DurabilityFaultPoint: Equatable, Sendable {
  case operation(DurabilityOperation)
  case boundary(DurabilityBoundary)
}

#if ETA_DURABILITY_FAULT_PROBE
  enum DurabilityProbeScenario: String, Sendable {
    case dur02
    case dur03
    case dur04
    case dur05
  }
#endif

enum DurabilityFaultAction: Sendable {
  case fail(errno: Int32)
  #if ETA_DURABILITY_FAULT_PROBE
    case terminateProbe(scenario: DurabilityProbeScenario, eventFD: Int32)
  #endif
}

struct DurabilityFaultSpecification: Sendable {
  let baselineOffset: Int64
  let targetOffset: Int64
  let point: DurabilityFaultPoint
  let action: DurabilityFaultAction

  init(
    baselineOffset: Int64,
    targetOffset: Int64,
    point: DurabilityFaultPoint,
    action: DurabilityFaultAction
  ) throws {
    guard baselineOffset >= 0, targetOffset > baselineOffset else {
      throw RecorderError("durability fault target offset must be greater than its baseline")
    }
    switch (point, action) {
    case (.operation, .fail(let errorNumber)):
      guard errorNumber > 0 else {
        throw RecorderError("durability fault errno must be positive")
      }
    #if ETA_DURABILITY_FAULT_PROBE
      case (.boundary(.duringIndexWrite(_, let prefixByteCount)), .terminateProbe(_, let eventFD)):
        guard prefixByteCount > 0 else {
          throw RecorderError("durability index prefix must be positive")
        }
        guard eventFD == STDOUT_FILENO else {
          throw RecorderError("durability event fd must be stdout (1)")
        }
      case (.boundary, .terminateProbe(_, let eventFD)):
        guard eventFD == STDOUT_FILENO else {
          throw RecorderError("durability event fd must be stdout (1)")
        }
    #endif
    default:
      throw RecorderError("durability fault action does not match its point")
    }
    self.baselineOffset = baselineOffset
    self.targetOffset = targetOffset
    self.point = point
    self.action = action
  }
}

final class DurabilityFaultPlan: @unchecked Sendable {
  let specification: DurabilityFaultSpecification
  private let claimed = Atomic<Bool>(false)

  init(_ specification: DurabilityFaultSpecification) {
    self.specification = specification
  }

  var wasClaimed: Bool { claimed.load(ordering: .acquiring) }

  func injectedErrno(for operation: DurabilityOperation, offset: Int64) -> Int32? {
    let point = DurabilityFaultPoint.operation(operation)
    guard specification.point == point,
      case .fail(let errorNumber) = specification.action,
      claim(point, offset: offset)
    else { return nil }
    return errorNumber
  }

  func indexPrefixByteCount(context: DurabilityRecordContext, offset: Int64) -> Int? {
    guard offset == specification.targetOffset, !wasClaimed,
      case .boundary(.duringIndexWrite(let targetContext, let count)) = specification.point,
      targetContext == context
    else { return nil }
    return count
  }

  func perform(_ boundary: DurabilityBoundary, offset: Int64) {
    #if ETA_DURABILITY_FAULT_PROBE
      let point = DurabilityFaultPoint.boundary(boundary)
      guard claim(point, offset: offset),
        case .terminateProbe(let scenario, let eventFD) = specification.action
      else { return }
      terminateProbe(scenario: scenario, boundary: boundary, offset: offset, eventFD: eventFD)
    #endif
  }

  private func claim(_ point: DurabilityFaultPoint, offset: Int64) -> Bool {
    guard offset > specification.baselineOffset, offset == specification.targetOffset,
      point == specification.point
    else { return false }
    return !claimed.exchange(true, ordering: .acquiringAndReleasing)
  }
}

struct DurabilitySyscallError: Error, LocalizedError, Sendable {
  let operation: DurabilityOperation
  let operationCode: Int32
  let errnoCode: Int32
  let offset: Int64

  init(operation: DurabilityOperation, errnoCode: Int32, offset: Int64) {
    self.operation = operation
    operationCode = operation.code.rawValue
    self.errnoCode = errnoCode
    self.offset = offset
  }

  var errorDescription: String? {
    "durability syscall \(operationCode) failed at offset \(offset) with errno \(errnoCode): "
      + String(cString: strerror(errnoCode))
  }
}

#if ETA_DURABILITY_FAULT_PROBE
  package func runDurabilityFaultProbe(arguments: [String]) throws {
    let options = try DurabilityProbeOptions(arguments: arguments)
    signal(SIGPIPE, SIG_IGN)

    let pcmURL = options.directory.appendingPathComponent("tape.pcm")
    let indexURL = options.directory.appendingPathComponent("tape.idx")
    let attributes = try FileManager.default.attributesOfItem(atPath: pcmURL.path)
    guard let pcmSize = (attributes[.size] as? NSNumber)?.int64Value,
      pcmSize == options.baselineOffset
    else {
      throw RecorderError("probe baseline offset does not equal tape.pcm size")
    }
    let prior = try IndexLog.read(
      url: indexURL,
      pcmSize: pcmSize,
      repairTrailingPartial: false
    )
    guard prior.discardedTrailingBytes == 0,
      prior.records.last?.byteOffset == options.baselineOffset
    else {
      throw RecorderError("probe requires a complete committed baseline index")
    }

    let frameCount = 4_096
    var samples = (0..<frameCount).map { index in
      Float(0.125 * sin(2 * Double.pi * Double(index % 257) / 257))
    }
    let sizingConverter = try PCMResampler(inputSampleRate: Double(TapeConstants.sampleRate))
    var outputFrames: Int64 = 0
    try samples.withUnsafeBufferPointer { buffer in
      try sizingConverter.convert(samples: buffer.baseAddress!, frameCount: buffer.count) {
        _, count in
        outputFrames += Int64(count)
      }
    }
    try sizingConverter.finish { _, count in outputFrames += Int64(count) }
    guard outputFrames > 0, outputFrames <= Int64.max / TapeConstants.bytesPerSample else {
      throw RecorderError("probe converter produced an invalid output size")
    }
    let byteCount = outputFrames * TapeConstants.bytesPerSample
    let (targetOffset, overflow) = options.baselineOffset.addingReportingOverflow(byteCount)
    guard !overflow else { throw RecorderError("probe target offset overflowed") }

    let boundary: DurabilityBoundary
    switch options.scenario {
    case .dur02:
      boundary = .afterPCMAppend
    case .dur03:
      boundary = .afterTapeFullSync(.checkpoint)
    case .dur04:
      boundary = .duringIndexWrite(
        .checkpoint,
        prefixByteCount: options.prefixByteCount!
      )
    case .dur05:
      boundary = .afterIndexSync(.checkpoint)
    }
    let specification = try DurabilityFaultSpecification(
      baselineOffset: options.baselineOffset,
      targetOffset: targetOffset,
      point: .boundary(boundary),
      action: .terminateProbe(scenario: options.scenario, eventFD: options.eventFD)
    )
    let plan = DurabilityFaultPlan(specification)
    let ring = AudioRing(slotCount: 4, framesPerSlot: frameCount)
    let writer = TapeWriter(
      directory: options.directory,
      deviceUID: "durability-fault-probe",
      ring: ring,
      faultPlan: plan
    )
    try writer.startAndWaitUntilReady()

    let start = monotonicNowNS()
    let wallStart = wallNowNS()
    let duration = UInt64(frameCount) * 1_000_000_000 / UInt64(TapeConstants.sampleRate)
    let accepted = samples.withUnsafeMutableBufferPointer { buffer in
      var channel = buffer.baseAddress!
      return withUnsafePointer(to: &channel) { channels in
        ring.writeAudio(
          channels: channels,
          channelCount: 1,
          frameCount: frameCount,
          sampleRate: Double(TapeConstants.sampleRate),
          monoStartNS: start,
          monoEndNS: start + duration,
          wallStartNS: wallStart,
          wallEndNS: wallStart + duration,
          boundaries: BoundaryBatch()
        )
      }
    }
    guard accepted else { throw RecorderError("probe synthetic audio was not accepted") }
    do {
      try writer.stopAndWait()
    } catch {
      if options.scenario == .dur04 { _exit(73) }
      throw error
    }
    throw RecorderError(
      plan.wasClaimed
        ? "probe fault returned after being claimed"
        : "probe fault did not reach its target offset"
    )
  }

  private struct DurabilityProbeOptions {
    let scenario: DurabilityProbeScenario
    let directory: URL
    let baselineOffset: Int64
    let eventFD: Int32
    let prefixByteCount: Int?

    init(arguments: [String]) throws {
      guard arguments.count.isMultiple(of: 2) else {
        throw RecorderError("probe arguments must be --name value pairs")
      }
      var values: [String: String] = [:]
      var index = 0
      while index < arguments.count {
        let name = arguments[index]
        guard
          ["--scenario", "--directory", "--baseline-offset", "--event-fd", "--prefix-count"]
            .contains(name)
        else { throw RecorderError("unknown probe argument: \(name)") }
        guard values.updateValue(arguments[index + 1], forKey: name) == nil else {
          throw RecorderError("duplicate probe argument: \(name)")
        }
        index += 2
      }
      guard let scenarioValue = values["--scenario"],
        let scenario = DurabilityProbeScenario(rawValue: scenarioValue)
      else { throw RecorderError("invalid or missing --scenario") }
      guard let directoryPath = values["--directory"], directoryPath.hasPrefix("/") else {
        throw RecorderError("--directory must be an absolute path")
      }
      guard let baselineValue = values["--baseline-offset"],
        let baselineOffset = Int64(baselineValue), baselineOffset > 0,
        baselineOffset.isMultiple(of: TapeConstants.bytesPerSample)
      else { throw RecorderError("--baseline-offset must be a positive even integer") }
      guard let eventValue = values["--event-fd"], let eventFD = Int32(eventValue),
        eventFD == STDOUT_FILENO
      else { throw RecorderError("--event-fd must be stdout (1)") }

      let prefixByteCount = values["--prefix-count"].flatMap(Int.init)
      if scenario == .dur04 {
        guard prefixByteCount != nil, prefixByteCount! > 0 else {
          throw RecorderError("dur04 requires a positive --prefix-count")
        }
      } else if values["--prefix-count"] != nil {
        throw RecorderError("--prefix-count is valid only for dur04")
      }
      self.scenario = scenario
      directory = URL(fileURLWithPath: directoryPath, isDirectory: true).standardizedFileURL
      self.baselineOffset = baselineOffset
      self.eventFD = eventFD
      self.prefixByteCount = prefixByteCount
    }
  }
#endif

#if ETA_DURABILITY_FAULT_PROBE
  private func terminateProbe(
    scenario: DurabilityProbeScenario,
    boundary: DurabilityBoundary,
    offset: Int64,
    eventFD: Int32
  ) -> Never {
    let event =
      "{\"scenario\":\"\(scenario.rawValue)\",\"boundary\":\"\(boundary.eventName)\","
      + "\"context\":\"\(boundary.context.rawValue)\",\"offset\":\(offset),"
      + "\"prefix_bytes\":\(boundary.prefixByteCount ?? 0),"
      + "\"source_sha256\":\"\(DurabilityFaultBuild.sourceSHA256)\"}\n"
    let bytes = Array(event.utf8)
    bytes.withUnsafeBytes { buffer in
      var cursor = buffer.baseAddress!
      var remaining = buffer.count
      while remaining > 0 {
        let result = Darwin.write(eventFD, cursor, remaining)
        let writeErrno = errno
        if result < 0 {
          if writeErrno == EINTR { continue }
          _exit(70)
        }
        guard result > 0 else { _exit(71) }
        cursor = cursor.advanced(by: result)
        remaining -= result
      }
    }
    guard kill(getpid(), SIGKILL) == 0 else { _exit(72) }
    while true { _ = Darwin.pause() }
  }
#endif
