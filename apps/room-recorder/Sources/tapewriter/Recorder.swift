import AVFoundation
import AudioToolbox
import Foundation
import Synchronization
import TapeCore

public struct RecorderError: Error, LocalizedError {
  public let message: String

  public init(_ message: String) { self.message = message }
  public var errorDescription: String? { message }

  static func posix(_ prefix: String) -> RecorderError {
    RecorderError("\(prefix): \(String(cString: strerror(errno)))")
  }
}

func captureFormatRejection(
  sampleRate: Double,
  channelCount: Int,
  isFloat32: Bool,
  isInterleaved: Bool
) -> String? {
  guard sampleRate.isFinite, sampleRate > 0, channelCount > 0 else {
    return "input device has no active capture format"
  }
  guard sampleRate >= 44_100 else {
    return "input sample rate \(sampleRate) Hz is below the 44.1 kHz durability envelope"
  }
  guard isFloat32, !isInterleaved else {
    return "input device does not provide noninterleaved Float32 audio"
  }
  return nil
}

final class CaptureSession: @unchecked Sendable {
  private final class State: @unchecked Sendable {
    let lastCallbackNS = Atomic<UInt64>(monotonicNowNS())
    let lastFrameEndNS = Atomic<UInt64>(monotonicNowNS())
    let lastFrameEndWallNS = Atomic<UInt64>(wallNowNS())
    let hasAcceptedFrame = Atomic<Bool>(false)
    var timeline: CaptureTimeline

    init(resumeAfterNS: UInt64?) {
      timeline = CaptureTimeline(resumeAfterNS: resumeAfterNS)
    }

  }

  private let engine = AVAudioEngine()
  private let ring: AudioRing
  private let state: State
  let captureGeneration: UInt64
  private var didStop = false

  init(
    device: AudioDeviceInfo,
    ring: AudioRing,
    captureGeneration: UInt64 = 0,
    resumeAfterNS: UInt64? = nil
  ) throws {
    self.ring = ring
    self.captureGeneration = captureGeneration
    state = State(resumeAfterNS: resumeAfterNS)
    if !AudioDevices.isDefaultInput(device) { try selectDevice(device, on: engine) }
    let input = engine.inputNode
    let hardwareFormat = input.inputFormat(forBus: 0)
    if let rejection = captureFormatRejection(
      sampleRate: hardwareFormat.sampleRate,
      channelCount: Int(hardwareFormat.channelCount),
      isFloat32: hardwareFormat.commonFormat == .pcmFormatFloat32,
      isInterleaved: hardwareFormat.isInterleaved
    ) {
      throw RecorderError(rejection)
    }
    print("Capture format: \(hardwareFormat)")

    input.installTap(onBus: 0, bufferSize: 8_192, format: hardwareFormat) {
      [ring, state, captureGeneration] buffer, when in
      guard let channels = buffer.floatChannelData else { return }
      let frameCount = Int(buffer.frameLength)
      let sampleRate = buffer.format.sampleRate
      let hasHostTime = when.isHostTimeValid
      let observedMono = monotonicNowNS()
      let observedWall = wallNowNS()
      let timing = state.timeline.classify(
        CaptureObservation(
          frameCount: frameCount,
          sampleRate: sampleRate,
          hostStartNS: hasHostTime ? AudioConvertHostTimeToNanos(when.hostTime) : nil,
          sampleTime: when.isSampleTimeValid ? when.sampleTime : nil,
          observedMonoNS: observedMono,
          observedWallNS: observedWall
        ))
      let accepted = ring.writeAudio(
        channels: channels,
        channelCount: Int(buffer.format.channelCount),
        frameCount: frameCount,
        sampleRate: sampleRate,
        monoStartNS: timing.monoStartNS,
        monoEndNS: timing.monoEndNS,
        wallStartNS: timing.wallStartNS,
        wallEndNS: timing.wallEndNS,
        boundaries: timing.boundaries,
        captureGeneration: captureGeneration
      )
      if accepted {
        state.timeline.didPublishFrame()
        state.lastFrameEndNS.store(timing.monoEndNS, ordering: .releasing)
        state.lastFrameEndWallNS.store(timing.wallEndNS, ordering: .releasing)
        state.hasAcceptedFrame.store(true, ordering: .releasing)
      }
      state.lastCallbackNS.store(observedMono, ordering: .releasing)
    }

    engine.prepare()
    try engine.start()
  }

  deinit { stop() }

  func stop() {
    guard !didStop else { return }
    didStop = true
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
  }

  var hasStoppedProducing: Bool {
    if !engine.isRunning { return true }
    let last = state.lastCallbackNS.load(ordering: .acquiring)
    let now = monotonicNowNS()
    return now >= last && now - last > 2_000_000_000
  }

  var lastAcceptedFrameEnd: (monoNS: UInt64, wallNS: UInt64)? {
    guard state.hasAcceptedFrame.load(ordering: .acquiring) else { return nil }
    return (
      state.lastFrameEndNS.load(ordering: .acquiring),
      state.lastFrameEndWallNS.load(ordering: .acquiring)
    )
  }
}

public enum Recorder {
  public static func run(
    outputDirectory: URL,
    requestedDeviceUID: String?,
    unsignedDevelopmentArchive: UnsignedDevelopmentArchiveOptions? = nil
  ) throws {
    try requireMicrophonePermission()
    let validatedDevice = try AudioDevices.selected(uid: requestedDeviceUID)
    let stableDeviceUID = validatedDevice.uid
    print("Writing: \(outputDirectory.path)")
    print("Press Ctrl-C to stop cleanly.")

    let stopping = Atomic<Bool>(false)
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
    let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    interrupt.setEventHandler { stopping.store(true, ordering: .releasing) }
    terminate.setEventHandler { stopping.store(true, ordering: .releasing) }
    interrupt.resume()
    terminate.resume()
    defer {
      interrupt.cancel()
      terminate.cancel()
    }

    let ring = AudioRing()
    let writer = TapeWriter(
      directory: outputDirectory,
      deviceUID: stableDeviceUID,
      ring: ring,
      unsignedDevelopmentArchive: unsignedDevelopmentArchive
    )
    try writer.startAndWaitUntilReady()
    if stopping.load(ordering: .acquiring) {
      try finalizeCapture(stopCapture: {}, ring: ring, writer: writer)
      print("Recording stopped cleanly before capture started.")
      return
    }
    var resolvedDevice: AudioDeviceInfo?
    let acquisitionBoundary = (monoNS: monotonicNowNS(), wallNS: wallNowNS())
    var retryResumeAfterNS = acquisitionBoundary.monoNS
    let baselineDurableOffset = writer.durableCheckpointOffset
    let readiness = try CaptureReadinessCoordinator.acquire(
      isCancelled: { stopping.load(ordering: .acquiring) },
      nowNS: monotonicNowNS,
      sleepNS: { Thread.sleep(forTimeInterval: Double($0) / 1_000_000_000) },
      hasDurableGrowth: { attempt, deadlineNS in
        writer.hasDurableGrowth(
          after: baselineDurableOffset,
          captureGeneration: UInt64(attempt),
          completedByNS: deadlineNS
        )
      },
      checkWriter: { try writer.throwFailure() },
      startAttempt: { attempt in
        let resolved = try AudioDevices.selected(uid: stableDeviceUID)
        let session = try CaptureSession(
          device: resolved,
          ring: ring,
          captureGeneration: UInt64(attempt),
          resumeAfterNS: attempt == 1 ? nil : retryResumeAfterNS
        )
        resolvedDevice = resolved
        return session
      },
      stopAttempt: {
        $0.stop()
        if let boundary = $0.lastAcceptedFrameEnd { retryResumeAfterNS = boundary.monoNS }
      },
      attemptDidNotGrow: { attempt, error in
        if let error {
          fputs(
            "Audio acquisition cycle \(attempt) failed: \(error.localizedDescription)\n", stderr)
        } else {
          fputs("Audio acquisition cycle \(attempt) produced no durable growth.\n", stderr)
        }
      }
    )
    if readiness.outcome == .cancelled {
      try finalizeCapture(stopCapture: {}, ring: ring, writer: writer)
      print("Recording stopped cleanly before durable capture began.")
      return
    }
    if readiness.outcome == .physicalFallbackRequired {
      try finalizeCapture(stopCapture: {}, ring: ring, writer: writer)
      throw RecorderError(
        "physical_fallback_required: durable audio did not grow after two five-second acquisition retries; unplug the input USB device for at least five seconds, then reconnect it"
      )
    }
    guard let readyCapture = readiness.session else {
      try finalizeCapture(stopCapture: {}, ring: ring, writer: writer)
      throw RecorderError("capture readiness returned without an active session")
    }
    if stopping.load(ordering: .acquiring) {
      try finalizeCapture(stopCapture: { readyCapture.stop() }, ring: ring, writer: writer)
      print("Recording stopped cleanly before durable capture began.")
      return
    }
    try writer.throwFailure()
    guard let readyDevice = resolvedDevice else {
      try finalizeCapture(stopCapture: { readyCapture.stop() }, ring: ring, writer: writer)
      throw RecorderError("capture readiness returned without a resolved input device")
    }
    var capture: CaptureSession? = readyCapture
    var currentDevice = readyDevice
    print("Input device: \(readyDevice.name) [\(readyDevice.uid)]")
    print("Recording ready after durable checkpoint growth.")

    var lossBoundary: (monoNS: UInt64, wallNS: UInt64)?
    var lossMarkedDeviceLost = false
    var retryAfterNS = UInt64.max

    while !stopping.load(ordering: .acquiring) {
      if writer.hasFailed { break }
      if let active = capture,
        !AudioDevices.isAlive(currentDevice) || active.hasStoppedProducing
      {
        active.stop()
        capture = nil
        let alive = AudioDevices.isAlive(currentDevice)
        let marker: StreamMarker = alive ? .configurationChange : .deviceLost
        lossMarkedDeviceLost = !alive
        if let boundary = active.lastAcceptedFrameEnd {
          lossBoundary = boundary
          try enqueue(
            marker, monoNS: boundary.monoNS, wallNS: boundary.wallNS, ring: ring, writer: writer)
        } else if lossBoundary == nil {
          let boundary = (monoNS: monotonicNowNS(), wallNS: wallNowNS())
          lossBoundary = boundary
          try enqueue(
            marker, monoNS: boundary.monoNS, wallNS: boundary.wallNS, ring: ring, writer: writer)
        }
        retryAfterNS = monotonicNowNS() + (alive ? 0 : 5_000_000_000)
        fputs(
          alive
            ? "Audio configuration changed; rebuilding capture.\n"
            : "Input device lost; retrying every 5 seconds.\n", stderr)
      }
      if capture == nil, monotonicNowNS() >= retryAfterNS {
        do {
          let current = try AudioDevices.selected(uid: stableDeviceUID)
          let replacement = try CaptureSession(
            device: current,
            ring: ring,
            captureGeneration: readyCapture.captureGeneration,
            resumeAfterNS: lossBoundary?.monoNS
          )
          currentDevice = current
          capture = replacement
          lossMarkedDeviceLost = false
          retryAfterNS = UInt64.max
        } catch {
          if !lossMarkedDeviceLost, AudioDevices.presence(uid: stableDeviceUID) == false,
            let boundary = lossBoundary
          {
            try enqueue(
              .deviceLost,
              monoNS: boundary.monoNS,
              wallNS: boundary.wallNS,
              ring: ring,
              writer: writer)
            lossMarkedDeviceLost = true
          }
          retryAfterNS = monotonicNowNS() + 5_000_000_000
          fputs("Retry failed: \(error.localizedDescription)\n", stderr)
        }
      }
      Thread.sleep(forTimeInterval: 0.1)
    }
    try finalizeCapture(stopCapture: { capture?.stop() }, ring: ring, writer: writer)
    let statistics = ring.statistics
    print(
      "Capture blocks: \(statistics.acceptedBlocks) accepted, \(statistics.droppedBlocks) dropped")
    print("Recording stopped cleanly.")
  }

  static func finalizeCapture(
    stopCapture: () -> Void,
    ring: AudioRing,
    writer: TapeWriter
  ) throws {
    stopCapture()
    while !ring.flushPendingOverflow(monoNS: monotonicNowNS(), wallNS: wallNowNS()) {
      if writer.hasFailed { try writer.throwFailure() }
      Thread.sleep(forTimeInterval: 0.005)
    }
    try writer.stopAndWait()
  }

  private static func requireMicrophonePermission() throws {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
      return
    case .notDetermined:
      let completed = DispatchSemaphore(value: 0)
      var granted = false
      AVCaptureDevice.requestAccess(for: .audio) { allowed in
        granted = allowed
        completed.signal()
      }
      completed.wait()
      guard granted else { throw RecorderError("microphone permission was not granted") }
    case .denied, .restricted:
      throw RecorderError(
        "microphone permission is denied; allow it for this terminal in System Settings > Privacy & Security > Microphone"
      )
    @unknown default:
      throw RecorderError("unknown microphone permission state")
    }
  }

  private static func enqueue(
    _ marker: StreamMarker,
    monoNS: UInt64,
    wallNS: UInt64,
    ring: AudioRing,
    writer: TapeWriter
  ) throws {
    while !ring.writeMarker(marker, monoNS: monoNS, wallNS: wallNS) {
      if writer.hasFailed { try writer.throwFailure() }
      Thread.sleep(forTimeInterval: 0.005)
    }
  }
}
