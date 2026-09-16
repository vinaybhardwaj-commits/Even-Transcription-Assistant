import ALSACapture
import BenchCore
import Foundation

/// USB capture devices, from ALSA's own listing (/proc/asound/pcm) and each card's /proc/asound/cardN/usbid — the same
/// two sources the capture side pins by (DeviceProbe.swift). A card with no usbid (the Yoga's own DMIC) is not a USB
/// device and cannot carry an S5 identity, so it is not listed.
struct ALSADeviceEnumerator: CaptureDeviceEnumerating {
    func usbCaptureDevices() -> [EnumeratedCaptureDevice] {
        var seen = Set<USBDeviceUID>()
        var out: [EnumeratedCaptureDevice] = []
        for listed in CaptureDevices.list() {
            guard let raw = CaptureDevices.usbID(card: listed.card), let uid = USBDeviceUID(procUSBID: raw),
                  !seen.contains(uid) else { continue }
            seen.insert(uid)
            out.append(EnumeratedCaptureDevice(uid: uid, name: listed.description, alsaName: listed.stableName, card: listed.card))
        }
        return out
    }
}
