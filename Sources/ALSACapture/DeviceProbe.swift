// U2 S3 — the hardware half of the bounded wait. The decision logic is in CaptureCore/DeviceWait.swift and has no
// ALSA in it; this file is the part that must touch a sound card, and it does exactly one probe per call.
import CALSA
import CaptureCore
import Foundation
#if canImport(Glibc)
import Glibc
#endif

extension CaptureDevices {
    /// The USB vendor:product behind an ALSA card, as `/proc/asound/cardN/usbid` reports it (e.g. "0d8c:0134" for
    /// the TONOR TM20). Nil for a non-USB card — the Yoga's own DMIC has no usbid file — which is not an error and
    /// is not "wrong": it simply cannot be identity-checked this way.
    public static func usbID(card: Int) -> String? {
        guard let text = try? String(contentsOfFile: "/proc/asound/card\(card)/usbid", encoding: .utf8) else { return nil }
        let id = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return id.isEmpty ? nil : id
    }

    /// One probe of the pinned device, classified into S3's three cases.
    ///
    /// `expectUSBID` is what makes WRONG detectable at all. Without it the pin is a NAME, and ALSA card ids are not
    /// unique hardware identities: "Device" is the generic id a USB audio interface gets from its product string, so
    /// a different generic USB mic plugged into the same slot can legitimately claim `hw:CARD=Device,DEV=0` and be
    /// indistinguishable from ours by name alone. With it, the pin is a name AND a vendor:product, and a stranger
    /// answering to our name is caught rather than recorded. The caller says out loud when it is not set.
    public static func probe(pinned: String, expectUSBID: String?) -> DeviceState {
        guard let found = list().first(where: { $0.stableName == pinned }) else { return .absent }

        if let expect = expectUSBID {
            let actual = usbID(card: found.card)
            // A card that reports no usbid at all under our pinned name is WRONG, not absent: something IS there
            // answering to the pinned name, and it is provably not the USB device we pinned.
            guard let actual else {
                return .wrong(found: "\(found.stableName) (\(found.description)) reports no USB id; not the pinned \(expect)")
            }
            guard actual.caseInsensitiveCompare(expect) == .orderedSame else {
                return .wrong(found: "\(actual) at \(found.stableName) (\(found.description))")
            }
        }

        // Present and ours by identity. The only question left is whether it opens, and EBUSY is the one negative
        // answer that is worth waiting on: M2.2 measured PipeWire holding the PCM for exactly 5.0 s after its last
        // client exits. Any other open failure is a real fault and is surfaced by the caller's normal open path.
        var handle: OpaquePointer?
        let rc = snd_pcm_open(&handle, pinned, SND_PCM_STREAM_CAPTURE, 0)
        if rc >= 0, let handle { snd_pcm_close(handle); return .ready }
        if rc == -Int32(EBUSY) { return .busy }
        // Not busy, not open. Treat as absent so the bounded wait still applies: a device mid-enumeration can fail
        // an open for reasons other than EBUSY, and the named timeout error is the right end for that too. It is not
        // reported as .ready, so nothing records from it.
        return .absent
    }
}
