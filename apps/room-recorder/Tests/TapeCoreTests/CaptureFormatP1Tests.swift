import Testing

@testable import TapeCapture

@Suite struct CaptureFormatP1Tests {
  @Test func cap02AdmitsTheSupportedNativeRateMatrix() {
    for sampleRate in [44_100.0, 48_000, 96_000, 192_000] {
      for channelCount in [1, 2] {
        #expect(
          captureFormatRejection(
            sampleRate: sampleRate,
            channelCount: channelCount,
            isFloat32: true,
            isInterleaved: false
          ) == nil
        )
      }
    }
  }

  @Test func cap02RejectsInactiveOrUnsupportedFormatsExplicitly() {
    for sampleRate in [0.0, .nan, .infinity] {
      #expect(
        captureFormatRejection(
          sampleRate: sampleRate,
          channelCount: 1,
          isFloat32: true,
          isInterleaved: false
        ) == "input device has no active capture format"
      )
    }
    #expect(
      captureFormatRejection(
        sampleRate: 48_000,
        channelCount: 0,
        isFloat32: true,
        isInterleaved: false
      ) == "input device has no active capture format"
    )
    #expect(
      captureFormatRejection(
        sampleRate: 16_000,
        channelCount: 1,
        isFloat32: true,
        isInterleaved: false
      ) == "input sample rate 16000.0 Hz is below the 44.1 kHz durability envelope"
    )
    #expect(
      captureFormatRejection(
        sampleRate: 48_000,
        channelCount: 1,
        isFloat32: false,
        isInterleaved: false
      ) == "input device does not provide noninterleaved Float32 audio"
    )
    #expect(
      captureFormatRejection(
        sampleRate: 48_000,
        channelCount: 2,
        isFloat32: true,
        isInterleaved: true
      ) == "input device does not provide noninterleaved Float32 audio"
    )
  }
}
