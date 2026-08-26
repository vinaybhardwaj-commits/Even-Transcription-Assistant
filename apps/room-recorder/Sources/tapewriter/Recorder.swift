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
  private var didStop = false

  init(device: AudioDeviceInfo, ring: AudioRing, resumeAfterNS: UInt64? = nil) throws {
    self.ring = ring
    state = State(resumeAfterNS: resumeAfterNS)
    if !AudioDevices.isDefaultInput(device) { try selectDevice(device, on: engine) }
    let input = engine.inputNode
    let hardwareFormat = input.inputFormat(forBus: 0)
    guard hardwareFormat.sampleRate > 0, hardwareFormat.channelCount > 0 else {
      throw RecorderError("input device has no active capture format")
    }
    guard hardwareFormat.sampleRate >= 44_100 else {
      throw RecorderError(
        "input sample rate \(hardwareFormat.sampleRate) Hz is below the 44.1 kHz durability envelope"
      )
    }
    guard hardwareFormat.commonFormat == .pcmFormatFloat32, !hardwareFormat.isInterleaved else {
      throw RecorderError("input device does not provide noninterleaved Float32 audio")
    }
    print("Capture format: \(hardwareFormat)")

    input.installTap(onBus: 0, bufferSize: 8_192, format: hardwareFormat) {
      [ring, state] buffer, when in
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
        boundaries: timing.boundaries
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
  public static func run(outputDirectory: URL, requestedDeviceUID: String?) throws {
    try requireMicrophonePermission()
    let device = try AudioDevices.selected(uid: requestedDeviceUID)
    print("Input device: \(device.name) [\(device.uid)]")
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
    let writer = TapeWriter(directory: outputDirectory, deviceUID: device.uid, ring: ring)
    try writer.startAndWaitUntilReady()
    if stopping.load(ordering: .acquiring) {
      try finalizeCapture(stopCapture: {}, ring: ring, writer: writer)
      print("Recording stopped cleanly before capture started.")
      return
    }
    var currentDevice = device
    var capture: CaptureSession?
    var lossBoundary: (monoNS: UInt64, wallNS: UInt64)?
    var lossMarkedDeviceLost = false
    var retryAfterNS = UInt64.max
    do {
      capture = try CaptureSession(device: device, ring: ring)
    } catch {
      let boundary = (monoNS: monotonicNowNS(), wallNS: wallNowNS())
      lossBoundary = boundary
      retryAfterNS = boundary.monoNS + 5_000_000_000
      fputs(
        "Initial audio unavailable; retrying every 5 seconds: \(error.localizedDescription)\n",
        stderr)
    }

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
          let current = try AudioDevices.selected(uid: device.uid)
          let replacement = try CaptureSession(
            device: current, ring: ring, resumeAfterNS: lossBoundary?.monoNS)
          currentDevice = current
          capture = replacement
          lossMarkedDeviceLost = false
          retryAfterNS = UInt64.max
        } catch {
          if !lossMarkedDeviceLost, AudioDevices.presence(uid: device.uid) == false,
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
