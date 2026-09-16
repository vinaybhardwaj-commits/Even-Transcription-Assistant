import Foundation

/// Spec S5. Linux has no CoreAudio `device_uid`, so it presents `usb:<VID>:<PID>` — four lower-case hex digits each —
/// and resolves it by EXACT match against the USB capture devices enumerated now. `usb:0d8c:0134` is the TONOR TM20.
public struct USBDeviceUID: Equatable, Hashable, Sendable, CustomStringConvertible {
    public let vendor: String
    public let product: String

    /// Accepts `usb:VVVV:PPPP` only (hex, case-insensitive on input, normalised to lower case).
    public init?(_ raw: String) {
        let parts = raw.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "usb", Self.isHex4(parts[1]), Self.isHex4(parts[2]) else { return nil }
        vendor = parts[1].lowercased()
        product = parts[2].lowercased()
    }

    /// From `/proc/asound/cardN/usbid`'s `VVVV:PPPP`.
    public init?(procUSBID: String) {
        self.init("usb:" + procUSBID.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    public var description: String { "usb:\(vendor):\(product)" }

    static func isHex4(_ s: Substring) -> Bool {
        s.count == 4 && s.allSatisfy { $0.isHexDigit }
    }
}

/// One USB capture device present now.
public struct EnumeratedCaptureDevice: Equatable, Sendable {
    public var uid: USBDeviceUID
    public var name: String
    /// `hw:CARD=<id>,DEV=<n>`, the stable ALSA name, for the capture side.
    public var alsaName: String
    public var card: Int

    public init(uid: USBDeviceUID, name: String, alsaName: String, card: Int) {
        self.uid = uid
        self.name = name
        self.alsaName = alsaName
        self.card = card
    }
}

/// The seam over ALSA: BenchCore has no ALSA import. room-bench provides the real one.
public protocol CaptureDeviceEnumerating: Sendable {
    func usbCaptureDevices() -> [EnumeratedCaptureDevice]
}

/// A capture device's input volume, as `set_audio_input` reads and writes it (R4-D4): a 0-1 scalar, or nil when there
/// is no reading.
public struct InputVolumeReading: Equatable, Sendable {
    public var value: Double?
    public var settable: Bool
    public init(value: Double?, settable: Bool) {
        self.value = value
        self.settable = settable
    }
}

public protocol InputVolumeControlling: Sendable {
    /// Nil when the device is absent or would not answer.
    func inputVolume(uid: USBDeviceUID) -> InputVolumeReading?
    /// Clamped 0-1. Throws when absent or not settable.
    func setInputVolume(uid: USBDeviceUID, value: Double) throws
}

public enum DeviceResolution {
    /// Exact match, or nil. Never a nearest match and never a fallback.
    public static func resolve(_ uid: String, in devices: [EnumeratedCaptureDevice]) -> EnumeratedCaptureDevice? {
        guard let wanted = USBDeviceUID(uid) else { return nil }
        return devices.first { $0.uid == wanted }
    }
}
