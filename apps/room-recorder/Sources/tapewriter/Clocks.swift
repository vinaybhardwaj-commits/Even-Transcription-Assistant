import AudioToolbox

@inline(__always)
func monotonicNowNS() -> UInt64 {
  AudioConvertHostTimeToNanos(AudioGetCurrentHostTime())
}

@inline(__always)
func wallNowNS() -> UInt64 {
  clock_gettime_nsec_np(CLOCK_REALTIME)
}
