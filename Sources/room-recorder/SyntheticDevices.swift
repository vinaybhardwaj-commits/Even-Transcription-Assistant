#if TAPE_TEST_HOOKS
// TEST HOOKS ONLY. A file-described set of capture devices producing a 440 Hz tone at 48 kHz, paced in real time. The
// file is re-read on every call, so a test "unplugs" a device by removing it and makes one busy with "busy": true.
//   [{"stable_name": "hw:CARD=SynthA,DEV=0", "usbid": "dead:0001", "channels": 1, "busy": false}, ...]
import ALSACapture
import CaptureCore
import Foundation
#if canImport(Glibc)
import Glibc
#endif

final class SyntheticDevices: @unchecked Sendable {
    struct Entry: Decodable {
        var stable_name: String
        var usbid: String?
        var channels: UInt32
        var busy: Bool?
    }

    let path: String
    init(path: String) { self.path = path }

    func entries() -> [Entry] {
        guard let data = FileManager.default.contents(atPath: path) else { return [] }
        return (try? JSONDecoder().decode([Entry].self, from: data)) ?? []
    }

    /// Card numbers are the entry's position plus 100, so they can never be mistaken for a real card.
    func list() -> [CaptureDevices.Listed] {
        entries().enumerated().map { i, e in
            CaptureDevices.Listed(stableName: e.stable_name, card: 100 + i, device: 0, description: "synthetic \(e.stable_name)")
        }
    }

    func usbID(card: Int) -> String? {
        let all = entries()
        let i = card - 100
        return all.indices.contains(i) ? all[i].usbid : nil
    }

    func probe(pinned: String, expectUSBID: String?) -> DeviceState {
        guard let entry = entries().first(where: { $0.stable_name == pinned }) else { return .absent }
        if let expect = expectUSBID, entry.usbid?.lowercased() != expect.lowercased() {
            return .wrong(found: "\(entry.usbid ?? "no usbid") at \(pinned)")
        }
        return entry.busy == true ? .busy : .ready
    }

    func capabilities(_ listed: CaptureDevices.Listed) throws -> DeviceCapabilities {
        guard let entry = entries().first(where: { $0.stable_name == listed.stableName }) else {
            throw ALSAError(description: "synthetic \(listed.stableName) unplugged")
        }
        let json = #"{"channels_min":\#(entry.channels),"channels_max":\#(entry.channels),"rate_min":48000,"rate_max":48000,"supports_s16_le":true,"supports_48000":true}"#
        return try JSONDecoder().decode(DeviceCapabilities.self, from: Data(json.utf8))
    }

    func open(_ listed: CaptureDevices.Listed, channels: UInt32, rate: UInt32) throws -> any CapturePCM {
        guard let entry = entries().first(where: { $0.stable_name == listed.stableName }), entry.busy != true else {
            throw ALSAError(description: "synthetic \(listed.stableName) cannot be opened")
        }
        return SyntheticPCM(devices: self, listed: listed, channels: channels, rate: rate)
    }
}

final class SyntheticPCM: CapturePCM, @unchecked Sendable {
    let device: OpenedDevice
    let negotiated: Negotiated
    let devices: SyntheticDevices
    let name: String
    let channels: Int
    var frame: Int64 = 0

    init(devices: SyntheticDevices, listed: CaptureDevices.Listed, channels: UInt32, rate: UInt32) {
        self.devices = devices
        self.name = listed.stableName
        self.channels = Int(channels)
        device = try! JSONDecoder().decode(OpenedDevice.self, from: Data(
            #"{"name":"\#(listed.stableName)","card":\#(listed.card),"card_id":"synthetic","device":0,"pcm_id":"synthetic","alsa_lib_version":"synthetic"}"#.utf8))
        negotiated = try! JSONDecoder().decode(Negotiated.self, from: Data(
            #"{"format":"S16_LE","channels":\#(channels),"rate":\#(rate),"buffer_frames":4800,"period_frames":1200}"#.utf8))
    }

    func start() -> String? { nil }

    func read(into buffer: UnsafeMutableRawPointer, frames: Int) -> ALSACapturePCM.ReadResult {
        usleep(UInt32(frames * 1_000_000 / 48_000))
        guard devices.entries().contains(where: { $0.stable_name == name }) else { return .failed("synthetic device unplugged") }
        for i in 0..<frames {
            let value = Int16(8_000 * sin(2 * Double.pi * 440 * Double(frame + Int64(i)) / 48_000))
            for c in 0..<channels {
                buffer.storeBytes(of: value.littleEndian, toByteOffset: (i * channels + c) * 2, as: Int16.self)
            }
        }
        frame += Int64(frames)
        return .frames(frames)
    }
}
#endif
