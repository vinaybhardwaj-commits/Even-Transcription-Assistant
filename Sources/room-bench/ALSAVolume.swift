import ALSACapture
import BenchCore
import CALSA
import Foundation

/// R4-D4 on Linux: the capture volume of the device's ALSA simple mixer element (the TM20's is `Mic`, capture 0-62).
///
/// THE SCALAR IS LINEAR IN MIXER STEPS: value = (raw - min) / (max - min). The Mac's `input_volume` is CoreAudio's
/// volume scalar, a different scale, so THE SAME input_volume MEANS A DIFFERENT GAIN ON A MAC AND ON LINUX and the Bench
/// cannot assume parity between them (spec deviation V9, ratified 16 Sep 2026).
struct ALSAVolumeControl: InputVolumeControlling {
    struct VolumeError: Error, CustomStringConvertible {
        let description: String
    }

    let enumerator: ALSADeviceEnumerator

    func inputVolume(uid: USBDeviceUID) -> InputVolumeReading? {
        withCaptureElement(uid) { element, min, max in
            guard max > min else { return InputVolumeReading(value: nil, settable: false) }
            var raw: Int = 0
            guard snd_mixer_selem_get_capture_volume(element, SND_MIXER_SCHN_MONO, &raw) == 0 else {
                return InputVolumeReading(value: nil, settable: true)
            }
            return InputVolumeReading(value: Double(raw - min) / Double(max - min), settable: true)
        } ?? nil
    }

    func setInputVolume(uid: USBDeviceUID, value: Double) throws {
        let clamped = Swift.min(Swift.max(value, 0), 1)
        let outcome: Int32? = withCaptureElement(uid) { element, min, max in
            guard max > min else { return -1 }
            let raw = min + Int((Double(max - min) * clamped).rounded())
            return snd_mixer_selem_set_capture_volume_all(element, raw)
        }
        guard let outcome else { throw VolumeError(description: "device \(uid) has no capture volume control") }
        guard outcome == 0 else { throw VolumeError(description: "snd_mixer_selem_set_capture_volume_all: \(outcome)") }
    }

    /// Opens the card's mixer, finds its capture-volume element (`Mic` preferred), runs `body`, closes.
    private func withCaptureElement<T>(_ uid: USBDeviceUID, _ body: (OpaquePointer, Int, Int) -> T) -> T? {
        guard let device = enumerator.usbCaptureDevices().first(where: { $0.uid == uid }) else { return nil }
        var mixer: OpaquePointer?
        guard snd_mixer_open(&mixer, 0) == 0, let mixer else { return nil }
        defer { snd_mixer_close(mixer) }
        guard snd_mixer_attach(mixer, "hw:\(device.card)") == 0, snd_mixer_selem_register(mixer, nil, nil) == 0,
              snd_mixer_load(mixer) == 0 else { return nil }
        var chosen: OpaquePointer?
        var element = snd_mixer_first_elem(mixer)
        while let current = element {
            if snd_mixer_selem_has_capture_volume(current) != 0 {
                let name = snd_mixer_selem_get_name(current).map { String(cString: $0) } ?? ""
                if chosen == nil || name == "Mic" { chosen = current }
            }
            element = snd_mixer_elem_next(current)
        }
        guard let chosen else { return nil }
        var min: Int = 0, max: Int = 0
        guard snd_mixer_selem_get_capture_volume_range(chosen, &min, &max) == 0 else { return nil }
        return body(chosen, min, max)
    }
}
