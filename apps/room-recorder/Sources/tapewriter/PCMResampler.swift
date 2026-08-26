import AVFoundation

final class PCMResampler {
  let inputSampleRate: Double
  private let converter: AVAudioConverter
  private let inputBuffer: AVAudioPCMBuffer
  private let outputBuffer: AVAudioPCMBuffer

  init(inputSampleRate: Double, maximumInputFrames: AVAudioFrameCount = 65_536) throws {
    self.inputSampleRate = inputSampleRate
    guard
      let inputFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: inputSampleRate,
        channels: 1,
        interleaved: false
      ),
      let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
      ), let converter = AVAudioConverter(from: inputFormat, to: outputFormat),
      let inputBuffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: maximumInputFrames)
    else {
      throw RecorderError("cannot create the native-to-16-kHz PCM converter")
    }
    let ratio = 16_000 / inputSampleRate
    let outputCapacity = AVAudioFrameCount(ceil(Double(maximumInputFrames) * ratio) + 256)
    guard
      let outputBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: outputCapacity)
    else {
      throw RecorderError("cannot allocate the 16-kHz PCM conversion buffer")
    }
    converter.primeMethod = .none
    self.converter = converter
    self.inputBuffer = inputBuffer
    self.outputBuffer = outputBuffer
  }

  func convert(
    samples: UnsafePointer<Float>,
    frameCount: Int,
    body: (UnsafePointer<Int16>, Int) throws -> Void
  ) throws {
    guard frameCount > 0 else {
      throw RecorderError("native input block is empty")
    }
    guard frameCount <= inputBuffer.frameCapacity, let input = inputBuffer.floatChannelData?[0]
    else {
      throw RecorderError("native input block exceeds converter capacity")
    }
    input.update(from: samples, count: frameCount)
    inputBuffer.frameLength = AVAudioFrameCount(frameCount)
    outputBuffer.frameLength = 0
    var suppliedInput = false
    var conversionError: NSError?
    let status = converter.convert(to: outputBuffer, error: &conversionError) { _, inputStatus in
      if suppliedInput {
        inputStatus.pointee = .noDataNow
        return nil
      }
      suppliedInput = true
      inputStatus.pointee = .haveData
      return self.inputBuffer
    }
    if status == .error {
      throw conversionError ?? RecorderError("PCM sample-rate conversion failed")
    }
    guard let output = outputBuffer.int16ChannelData?[0] else {
      throw RecorderError("PCM converter returned no Int16 channel")
    }
    try body(output, Int(outputBuffer.frameLength))
  }

  func finish(body: (UnsafePointer<Int16>, Int) throws -> Void) throws {
    while true {
      outputBuffer.frameLength = 0
      var conversionError: NSError?
      let status = converter.convert(to: outputBuffer, error: &conversionError) { _, inputStatus in
        inputStatus.pointee = .endOfStream
        return nil
      }
      if status == .error {
        throw conversionError ?? RecorderError("PCM sample-rate converter flush failed")
      }
      guard let output = outputBuffer.int16ChannelData?[0] else {
        throw RecorderError("PCM converter flush returned no Int16 channel")
      }
      let count = Int(outputBuffer.frameLength)
      if count > 0 { try body(output, count) }
      if status == .endOfStream || count == 0 { break }
    }
  }
}
