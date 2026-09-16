// The four things the capture asks of the sound system, behind one seam: list capture PCMs, read a card's USB id, probe
// the pinned device, and open it. A release build forwards every call to ALSACapture unchanged. A TAPE_TEST_HOOKS build
// given --test-synthetic-devices answers from a JSON file instead, so the re-pin path can be exercised end to end with
// no sound card and no room audio.
import ALSACapture
import CaptureCore
import Foundation
import RecorderCore

protocol CapturePCM: AnyObject {
    var device: OpenedDevice { get }
    var negotiated: Negotiated { get }
    func start() -> String?
    func read(into buffer: UnsafeMutableRawPointer, frames: Int) -> ALSACapturePCM.ReadResult
}

extension ALSACapturePCM: CapturePCM {}

enum DeviceLayer {
    #if TAPE_TEST_HOOKS
    nonisolated(unsafe) static var synthetic: SyntheticDevices?
    #endif

    static func list() -> [CaptureDevices.Listed] {
        #if TAPE_TEST_HOOKS
        if let synthetic { return synthetic.list() }
        #endif
        return CaptureDevices.list()
    }

    static func usbID(card: Int) -> String? {
        #if TAPE_TEST_HOOKS
        if let synthetic { return synthetic.usbID(card: card) }
        #endif
        return CaptureDevices.usbID(card: card)
    }

    static func probe(pinned: String, expectUSBID: String?) -> DeviceState {
        #if TAPE_TEST_HOOKS
        if let synthetic { return synthetic.probe(pinned: pinned, expectUSBID: expectUSBID) }
        #endif
        return CaptureDevices.probe(pinned: pinned, expectUSBID: expectUSBID)
    }

    static func capabilities(_ listed: CaptureDevices.Listed) throws -> DeviceCapabilities {
        #if TAPE_TEST_HOOKS
        if let synthetic { return try synthetic.capabilities(listed) }
        #endif
        return try CaptureDevices.capabilities(listed)
    }

    static func open(_ listed: CaptureDevices.Listed, channels: UInt32, rate: UInt32, latencyMicros: UInt32) throws -> any CapturePCM {
        #if TAPE_TEST_HOOKS
        if let synthetic { return try synthetic.open(listed, channels: channels, rate: rate) }
        #endif
        return try ALSACapturePCM(device: listed, channels: channels, rate: rate, latencyMicros: latencyMicros)
    }

    static func resolve(_ requested: String?) throws -> CaptureDevices.Listed {
        #if TAPE_TEST_HOOKS
        if let synthetic {
            guard let requested, let found = synthetic.list().first(where: { $0.stableName == requested }) else {
                throw ALSAError(description: "synthetic capture device \(requested ?? "(none)") not found")
            }
            return found
        }
        #endif
        return try CaptureDevices.resolve(requested)
    }

    /// Every capture PCM with its card's USB id, for resolving a `usb:<vid>:<pid>` identity.
    static func listedCaptures() -> [ListedCapture] {
        list().map { ListedCapture(stableName: $0.stableName, card: $0.card, device: $0.device, usbID: usbID(card: $0.card)) }
    }
}
