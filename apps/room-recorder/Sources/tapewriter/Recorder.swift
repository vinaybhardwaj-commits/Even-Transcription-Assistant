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
    var resumeAfterNS: UInt64?
    var expectedSampleTime: AVAudioFramePosition?
    var previousFrameEndNS: UInt64?
    var previousWallOffsetNS: Int64?
    var boundaries = BoundaryBatch()

    init(resumeAfterNS: UInt64?) {
      self.resumeAfterNS = resumeAfterNS
    }

  }

  private let engine = AVAudioEngine()
  private let ring: AudioRing
  private let state: State
  private var didStop = false

  init(device: AudioDeviceInfo, ring: AudioRing, resumeAfterNS: UInt64? = nil) throws {
    self.ring = ring
    state = State(resumeAfterNS: resumeAfterNS)
    try selectDevice(device, on: engine)
    let input = engine.inputNode
    let hardwareFormat = input.outputFormat(forBus: 0)
    guard hardwareFormat.sampleRate > 0, hardwareFormat.channelCount > 0 else {
      throw RecorderError("input device has no active capture format")
    }
    guard hardwareFormat.sampleRate >= 44_100 else {
      throw RecorderError(
        "input sample rate \(hardwareFormat.sampleRate) Hz is below the 44.1 kHz durability envelope"
      )
    }
    guard
      let captureFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: hardwareFormat.sampleRate,
        channels: hardwareFormat.channelCount,
        interleaved: false
      )
    else { throw RecorderError("cannot construct the native capture format") }

    input.installTap(onBus: 0, bufferSize: 4_096, format: captureFormat) {
      [ring, state] buffer, when in
      guard let channels = buffer.floatChannelData else { return }
      let frameCount = Int(buffer.frameLength)
      let sampleRate = buffer.format.sampleRate
      let hasHostTime = when.isHostTimeValid
      let startMono = hasHostTime ? AudioConvertHostTimeToNanos(when.hostTime) : monotonicNowNS()
      let duration = UInt64(Double(frameCount) / sampleRate * 1_000_000_000)
      let endMono = startMono + duration
      let observedMono = monotonicNowNS()
      let observedWall = wallNowNS()
      let callbackLag = observedMono >= startMono ? observedMono - startMono : 0
      let startWall = observedWall >= callbackLag ? observedWall - callbackLag : observedWall
      let endWall = startWall + duration
      if !hasHostTime {
        state.boundaries.append(.invalidTimestamp, monoNS: startMono, wallNS: startWall)
      }
      if when.isSampleTimeValid {
        if let expected = state.expectedSampleTime, when.sampleTime != expected {
          let gap = state.previousFrameEndNS.map { startMono >= $0 ? startMono - $0 : 0 } ?? 0
          state.boundaries.append(
            .captureDiscontinuity, monoNS: startMono, wallNS: startWall, gapNS: gap)
        }
        state.expectedSampleTime = when.sampleTime + AVAudioFramePosition(frameCount)
      } else {
        state.boundaries.append(.invalidTimestamp, monoNS: startMono, wallNS: startWall)
        state.expectedSampleTime = nil
      }
      if let previousEnd = state.previousFrameEndNS {
        let hostDelta = startMono >= previousEnd ? startMono - previousEnd : previousEnd - startMono
        if hostDelta > 2_000_000 {
          state.boundaries.append(
            .captureDiscontinuity,
            monoNS: startMono,
            wallNS: startWall,
            gapNS: startMono >= previousEnd ? startMono - previousEnd : 0
          )
        }
      }
      let wallOffset = Int64(startWall) - Int64(startMono)
      if let previousOffset = state.previousWallOffsetNS {
        let offsetDelta =
          wallOffset >= previousOffset ? wallOffset - previousOffset : previousOffset - wallOffset
        if offsetDelta > 100_000_000 {
          state.boundaries.append(
            .clockJump,
            monoNS: startMono,
            wallNS: startWall,
            gapNS: UInt64(offsetDelta)
          )
        }
      }
      state.previousWallOffsetNS = wallOffset
      state.previousFrameEndNS = endMono
      var publishedBoundaries = state.boundaries
      if let resumeAfter = state.resumeAfterNS {
        publishedBoundaries.append(
          .resumed,
          monoNS: startMono,
          wallNS: startWall,
          gapNS: startMono >= resumeAfter ? startMono - resumeAfter : 0
        )
      }
      let accepted = ring.writeAudio(
        channels: channels,
        channelCount: Int(buffer.format.channelCount),
        frameCount: frameCount,
        sampleRate: sampleRate,
        monoStartNS: startMono,
        monoEndNS: endMono,
        wallStartNS: startWall,
        wallEndNS: endWall,
        boundaries: publishedBoundaries
      )
      if accepted {
        state.resumeAfterNS = nil
        state.boundaries.clear()
        state.lastFrameEndNS.store(endMono, ordering: .releasing)
        state.lastFrameEndWallNS.store(endWall, ordering: .releasing)
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
      try writer.stopAndWait()
      print("Recording stopped cleanly before capture started.")
      return
    }
    let initialCapture: CaptureSession
    do {
      initialCapture = try CaptureSession(device: device, ring: ring)
    } catch {
      try? writer.stopAndWait()
      throw error
    }
    var capture: CaptureSession? = initialCapture

    var lossBoundary: (monoNS: UInt64, wallNS: UInt64)?
    var retryAfterNS: UInt64 = 0
    while !stopping.load(ordering: .acquiring) {
      if writer.hasFailed { break }
      if let active = capture, !AudioDevices.isAlive(device) || active.hasStoppedProducing {
        active.stop()
        capture = nil
        let alive = AudioDevices.isAlive(device)
        let marker: StreamMarker = alive ? .configurationChange : .deviceLost
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
          capture = try CaptureSession(
            device: current, ring: ring, resumeAfterNS: lossBoundary?.monoNS)
          retryAfterNS = UInt64.max
        } catch {
          retryAfterNS = monotonicNowNS() + 5_000_000_000
          fputs("Retry failed: \(error.localizedDescription)\n", stderr)
        }
      }
      Thread.sleep(forTimeInterval: 0.1)
    }
    capture?.stop()
    while !ring.flushPendingOverflow(monoNS: monotonicNowNS(), wallNS: wallNowNS()) {
      if writer.hasFailed { try writer.throwFailure() }
      Thread.sleep(forTimeInterval: 0.005)
    }
    try writer.stopAndWait()
    let statistics = ring.statistics
    print(
      "Capture blocks: \(statistics.acceptedBlocks) accepted, \(statistics.droppedBlocks) dropped")
    print("Recording stopped cleanly.")
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
