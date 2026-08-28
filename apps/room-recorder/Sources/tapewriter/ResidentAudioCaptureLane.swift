import AVFoundation
import Foundation
import Synchronization
import TapeCore

package enum ResidentAudioCaptureLaneError: String, Error, LocalizedError, Sendable {
  case alreadyStarted = "resident_capture_already_started"
  case microphoneAuthorizationRequired = "resident_capture_microphone_authorization_required"
  case cancelled = "resident_capture_cancelled"
  case physicalFallbackRequired = "resident_capture_physical_fallback_required"
  case stoppedUnexpectedly = "resident_capture_stopped_unexpectedly"

  package var errorDescription: String? { rawValue }
}

package struct ResidentAudioCaptureLevels: Equatable, Sendable {
  package let averageQ15: UInt16
  package let peakQ15: UInt16

  package init(averageQ15: UInt16, peakQ15: UInt16) {
    self.averageQ15 = averageQ15
    self.peakQ15 = peakQ15
  }
}

protocol ResidentAudioCaptureSession: AnyObject {
  var hasStoppedProducing: Bool { get }
  var lastAcceptedFrameEnd: (monoNS: UInt64, wallNS: UInt64)? { get }
  func stop()
}

extension CaptureSession: ResidentAudioCaptureSession {}

package final class ResidentAudioCaptureLane: @unchecked Sendable {
  typealias SessionFactory = (_ generation: Int, _ resumeAfterNS: UInt64?) throws ->
    any ResidentAudioCaptureSession

  private let ring: AudioRing
  private let writer: ResidentArchiveLaneWriter
  private let authorize: () throws -> Void
  private let sessionFactory: SessionFactory
  private let isCancelled: () -> Bool
  private let nowNS: () -> UInt64
  private let sleepNS: (UInt64) -> Void
  private let operationLock = NSLock()
  private let stateLock = NSLock()
  private let stopRequested = Atomic<Bool>(false)
  private var session: (any ResidentAudioCaptureSession)?
  private var didStart = false
  private var active = false
  private var finalizationRequired = false

  package convenience init(stableDeviceUID: String, store: ArchiveLaneStore) {
    let ring = AudioRing()
    self.init(
      ring: ring,
      writer: ResidentArchiveLaneWriter(ring: ring, store: store),
      authorize: { try Self.validateInput(stableDeviceUID: stableDeviceUID) },
      sessionFactory: { generation, resumeAfterNS in
        let device = try AudioDevices.selected(uid: stableDeviceUID)
        return try CaptureSession(
          device: device,
          ring: ring,
          captureGeneration: UInt64(generation),
          resumeAfterNS: resumeAfterNS)
      },
      isCancelled: { withUnsafeCurrentTask { $0?.isCancelled ?? false } },
      nowNS: monotonicNowNS,
      sleepNS: { Thread.sleep(forTimeInterval: Double($0) / 1_000_000_000) }
    )
  }

  init(
    ring: AudioRing,
    writer: ResidentArchiveLaneWriter,
    authorize: @escaping () throws -> Void = {},
    sessionFactory: @escaping SessionFactory,
    isCancelled: @escaping () -> Bool = { false },
    nowNS: @escaping () -> UInt64 = monotonicNowNS,
    sleepNS: @escaping (UInt64) -> Void = {
      Thread.sleep(forTimeInterval: Double($0) / 1_000_000_000)
    }
  ) {
    self.ring = ring
    self.writer = writer
    self.authorize = authorize
    self.sessionFactory = sessionFactory
    self.isCancelled = isCancelled
    self.nowNS = nowNS
    self.sleepNS = sleepNS
  }

  deinit {
    try? stopAndDrain()
  }

  package static func validateInput(stableDeviceUID: String) throws {
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
      throw ResidentAudioCaptureLaneError.microphoneAuthorizationRequired
    }
    _ = try AudioDevices.selected(uid: stableDeviceUID)
  }

  package var isActive: Bool {
    stateLock.withLock { active && writer.isRunning }
  }

  package var requiresFinalization: Bool {
    stateLock.withLock { finalizationRequired }
  }
  package var durableSampleEnd: UInt64 { writer.durableSampleEnd }

  package var currentLevels: ResidentAudioCaptureLevels? {
    writer.currentLevels.map {
      ResidentAudioCaptureLevels(averageQ15: $0.averageQ15, peakQ15: $0.peakQ15)
    }
  }

  package func startAndWaitUntilDurable() throws {
    operationLock.lock()
    defer { operationLock.unlock() }
    guard stateLock.withLock({ !didStart }) else {
      throw ResidentAudioCaptureLaneError.alreadyStarted
    }
    try authorize()
    do {
      try writer.start()
    } catch {
      throw error
    }
    stateLock.withLock {
      didStart = true
      finalizationRequired = true
    }
    let baseline = writer.durableSampleEnd
    var retryResumeAfterNS: UInt64?

    do {
      let readiness = try CaptureReadinessCoordinator.acquire(
        isCancelled: { [self] in
          stopRequested.load(ordering: .acquiring) || isCancelled()
        },
        nowNS: nowNS,
        sleepNS: sleepNS,
        hasDurableGrowth: { [writer] generation, deadlineNS in
          writer.hasDurableGrowth(
            after: baseline,
            captureGeneration: UInt64(generation),
            completedByNS: deadlineNS)
        },
        checkWriter: { [writer] in try writer.throwFailure() },
        startAttempt: { [sessionFactory] generation in
          try sessionFactory(generation, retryResumeAfterNS)
        },
        stopAttempt: { attempt in
          attempt.stop()
          retryResumeAfterNS = attempt.lastAcceptedFrameEnd?.monoNS ?? retryResumeAfterNS
        }
      )
      switch readiness.outcome {
      case .ready:
        guard let ready = readiness.session else {
          throw ResidentAudioCaptureLaneError.stoppedUnexpectedly
        }
        guard !ready.hasStoppedProducing else {
          ready.stop()
          try finishWithoutActiveCapture()
          throw ResidentAudioCaptureLaneError.stoppedUnexpectedly
        }
        try writer.throwFailure()
        stateLock.withLock {
          session = ready
          active = true
        }
      case .cancelled:
        try finishWithoutActiveCapture()
        throw ResidentAudioCaptureLaneError.cancelled
      case .physicalFallbackRequired:
        try finishWithoutActiveCapture()
        throw ResidentAudioCaptureLaneError.physicalFallbackRequired
      }
    } catch {
      if writer.isRunning {
        do {
          try finishWithoutActiveCapture()
        } catch {
          throw error
        }
      }
      throw error
    }
  }

  package func service() throws {
    operationLock.lock()
    defer { operationLock.unlock() }
    try writer.throwFailure()
    let state = stateLock.withLock { (active, session, finalizationRequired) }
    guard state.0, let session = state.1 else {
      if state.2 { throw ResidentAudioCaptureLaneError.stoppedUnexpectedly }
      return
    }
    guard !session.hasStoppedProducing else {
      stateLock.withLock { active = false }
      throw ResidentAudioCaptureLaneError.stoppedUnexpectedly
    }
  }

  package func stopAndDrain() throws {
    stopRequested.store(true, ordering: .releasing)
    operationLock.lock()
    defer { operationLock.unlock() }
    guard stateLock.withLock({ finalizationRequired }) else { return }
    let activeSession = stateLock.withLock { () -> (any ResidentAudioCaptureSession)? in
      let value = session
      session = nil
      active = false
      return value
    }
    activeSession?.stop()
    while !ring.flushPendingOverflow(monoNS: monotonicNowNS(), wallNS: wallNowNS()) {
      try writer.throwFailure()
      Thread.sleep(forTimeInterval: 0.005)
    }
    try writer.stopAndWait()
    stateLock.withLock { finalizationRequired = false }
  }

  private func finishWithoutActiveCapture() throws {
    stateLock.withLock {
      session = nil
      active = false
    }
    while !ring.flushPendingOverflow(monoNS: monotonicNowNS(), wallNS: wallNowNS()) {
      try writer.throwFailure()
      Thread.sleep(forTimeInterval: 0.005)
    }
    try writer.stopAndWait()
    stateLock.withLock { finalizationRequired = false }
  }
}
