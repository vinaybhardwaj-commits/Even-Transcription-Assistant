#if BENCH_TEST_HOOKS
// TEST HOOKS ONLY: the same synthetic device file room-recorder's --test-synthetic-devices reads, so room-bench and the
// capture agree on what is attached in a dry run.
import BenchCore
import Foundation

struct SyntheticDeviceEnumerator: CaptureDeviceEnumerating {
    struct Entry: Decodable {
        var stable_name: String
        var usbid: String?
    }
    let path: String

    func usbCaptureDevices() -> [EnumeratedCaptureDevice] {
        guard let data = FileManager.default.contents(atPath: path),
              let entries = try? JSONDecoder().decode([Entry].self, from: data) else { return [] }
        return entries.enumerated().compactMap { i, e in
            guard let raw = e.usbid, let uid = USBDeviceUID(procUSBID: raw) else { return nil }
            return EnumeratedCaptureDevice(uid: uid, name: "synthetic \(e.stable_name)", alsaName: e.stable_name, card: 100 + i)
        }
    }
}

struct NoVolumeControl: InputVolumeControlling {
    func inputVolume(uid: USBDeviceUID) -> InputVolumeReading? { nil }
    func setInputVolume(uid: USBDeviceUID, value: Double) throws { throw CaptureSwitchError.notPresent }
}
#endif
