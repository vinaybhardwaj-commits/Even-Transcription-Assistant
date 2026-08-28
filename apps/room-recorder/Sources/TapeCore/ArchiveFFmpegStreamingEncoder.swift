import Darwin
import Foundation

public enum ArchiveFFmpegStreamingEncoderError: Error, Equatable, Sendable {
  case invalidExecutable
  case invalidTimeout
  case processLaunch(String)
  case pipeConfigurationFailed(errno: Int32)
  case processFailed(status: Int32, reason: String, standardError: String)
  case timedOut
  case terminationFailed
  case inputFailed(String)
  case outputFailed(String)
}

protocol ArchivePCMSpoolEncoding: Sendable {
  func encode(
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    sampleStart: UInt64,
    sampleEnd: UInt64,
    spoolWriter: ArchiveEncryptedSpoolWriter
  ) throws -> ArchiveEncodedSpoolAttempt
}

public struct ArchiveFFmpegStreamingEncoder: ArchivePCMSpoolEncoding {
  public let command: ArchiveFFmpegCommand
  public let timeout: TimeInterval

  public init(command: ArchiveFFmpegCommand, timeout: TimeInterval = 60) {
    self.command = command
    self.timeout = timeout
  }

  public func encode(
    snapshot: ArchiveLaneStore.AuthenticatedSnapshot,
    sampleStart: UInt64,
    sampleEnd: UInt64,
    spoolWriter: ArchiveEncryptedSpoolWriter
  ) throws -> ArchiveEncodedSpoolAttempt {
    guard command.executableURL.isFileURL, command.executableURL.path.hasPrefix("/") else {
      throw ArchiveFFmpegStreamingEncoderError.invalidExecutable
    }
    guard timeout.isFinite, timeout > 0 else {
      throw ArchiveFFmpegStreamingEncoderError.invalidTimeout
    }
    try FoundationArchiveStreamingProcess.run(
      executableURL: command.executableURL,
      arguments: command.arguments,
      input: { write in
        _ = try snapshot.streamPCMRange(sampleStart: sampleStart, sampleEnd: sampleEnd) { pcm in
          try write(pcm)
        }
      },
      output: { try spoolWriter.append($0) },
      timeout: timeout
    )
    return try spoolWriter.finishEncoding()
  }
}

enum FoundationArchiveStreamingProcess {
  static func run(
    executableURL: URL,
    arguments: [String],
    input: @escaping @Sendable (@escaping @Sendable (Data) throws -> Void) throws -> Void,
    output: @escaping @Sendable (Data) throws -> Void,
    timeout: TimeInterval = 60
  ) throws {
    let process = Process()
    let inputPipe = Pipe()
    let outputPipe = Pipe()
    let errorPipe = Pipe()
    guard fcntl(inputPipe.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else {
      throw ArchiveFFmpegStreamingEncoderError.pipeConfigurationFailed(errno: errno)
    }
    process.executableURL = executableURL
    process.arguments = arguments
    process.standardInput = inputPipe
    process.standardOutput = outputPipe
    process.standardError = errorPipe
    let exited = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in exited.signal() }
    do {
      try process.run()
    } catch {
      throw ArchiveFFmpegStreamingEncoderError.processLaunch(String(describing: error))
    }

    inputPipe.fileHandleForReading.closeFile()
    outputPipe.fileHandleForWriting.closeFile()
    errorPipe.fileHandleForWriting.closeFile()
    let outcome = ArchiveStreamingProcessOutcome(process: process)
    let group = DispatchGroup()
    let queue = DispatchQueue(
      label: "com.evenscribe.room-recorder.archive-encoder",
      qos: .utility,
      attributes: .concurrent
    )

    group.enter()
    queue.async {
      defer {
        try? inputPipe.fileHandleForWriting.close()
        group.leave()
      }
      do {
        try input { data in
          try inputPipe.fileHandleForWriting.write(contentsOf: data)
        }
      } catch {
        outcome.failInput(error)
      }
    }

    group.enter()
    queue.async {
      defer {
        try? outputPipe.fileHandleForReading.close()
        group.leave()
      }
      var acceptsOutput = true
      do {
        while let data = try outputPipe.fileHandleForReading.read(upToCount: 64 * 1_024),
          !data.isEmpty
        {
          if acceptsOutput {
            do {
              try output(data)
            } catch {
              acceptsOutput = false
              outcome.failOutput(error)
            }
          }
        }
      } catch {
        outcome.failOutput(error)
      }
    }

    group.enter()
    queue.async {
      defer {
        try? errorPipe.fileHandleForReading.close()
        group.leave()
      }
      do {
        while let data = try errorPipe.fileHandleForReading.read(upToCount: 4_096), !data.isEmpty {
          outcome.appendStandardError(data)
        }
      } catch {
        outcome.appendStandardError(Data(String(describing: error).utf8))
      }
    }

    let deadline = DispatchTime.now() + timeout
    if exited.wait(timeout: deadline) == .timedOut {
      process.terminate()
      if exited.wait(timeout: .now() + 2) == .timedOut {
        _ = kill(process.processIdentifier, SIGKILL)
        guard exited.wait(timeout: .now() + 2) == .success else {
          throw ArchiveFFmpegStreamingEncoderError.terminationFailed
        }
      }
      guard group.wait(timeout: .now() + 2) == .success else {
        throw ArchiveFFmpegStreamingEncoderError.terminationFailed
      }
      throw ArchiveFFmpegStreamingEncoderError.timedOut
    }
    guard group.wait(timeout: .now() + 2) == .success else {
      throw ArchiveFFmpegStreamingEncoderError.terminationFailed
    }
    if let failure = outcome.failure { throw failure }
    guard process.terminationReason == .exit, process.terminationStatus == 0 else {
      throw ArchiveFFmpegStreamingEncoderError.processFailed(
        status: process.terminationStatus,
        reason: process.terminationReason == .exit ? "exit" : "uncaught_signal",
        standardError: outcome.standardError
      )
    }
  }
}

private final class ArchiveStreamingProcessOutcome: @unchecked Sendable {
  private let lock = NSLock()
  private let process: Process
  private var storedFailure: ArchiveFFmpegStreamingEncoderError?
  private var storedStandardError = Data()

  init(process: Process) {
    self.process = process
  }

  var failure: ArchiveFFmpegStreamingEncoderError? {
    lock.withLock { storedFailure }
  }

  var standardError: String {
    lock.withLock { String(decoding: storedStandardError, as: UTF8.self) }
  }

  func failInput(_ error: Error) {
    fail(.inputFailed(String(describing: error)))
  }

  func failOutput(_ error: Error) {
    fail(.outputFailed(String(describing: error)))
  }

  func appendStandardError(_ data: Data) {
    lock.withLock {
      let remaining = max(0, 4_096 - storedStandardError.count)
      storedStandardError.append(data.prefix(remaining))
    }
  }

  private func fail(_ failure: ArchiveFFmpegStreamingEncoderError) {
    let shouldTerminate = lock.withLock {
      guard storedFailure == nil else { return false }
      storedFailure = failure
      return process.isRunning
    }
    if shouldTerminate { process.terminate() }
  }
}
