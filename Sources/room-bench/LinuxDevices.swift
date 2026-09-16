import ALSACapture
import BenchCore
import CALSA
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
            out.append(EnumeratedCaptureDevice(uid: uid, name: Self.cardName(listed.card) ?? listed.description,
                                               alsaName: listed.stableName, card: listed.card))
        }
        return out
    }

    /// The card's own name as ALSA reports it ("TONOR TM20 Audio Device"), rather than the PCM's generic "USB Audio".
    static func cardName(_ card: Int) -> String? {
        var name: UnsafeMutablePointer<CChar>?
        guard snd_card_get_name(Int32(card), &name) == 0, let name else { return nil }
        defer { free(name) }
        let text = String(cString: name).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }
}
