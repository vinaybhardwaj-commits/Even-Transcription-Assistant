import CALSA
import Foundation
#if canImport(Glibc)
import Glibc
#endif

// alsa-lib linked dynamically against its real headers (libasound2-dev in the build image): every call is checked
// by the compiler, and libasound.so.2 appears in ldd, where the install line can see it.

public struct ALSAError: Error, CustomStringConvertible {
    public let description: String
    public init(description: String) { self.description = description }
}

func alsaMessage(_ err: Int32) -> String { snd_strerror(err).map { String(cString: $0) } ?? "error \(err)" }

/// What was actually opened, as ALSA and the kernel report it.
public struct OpenedDevice: Codable, Sendable {
    /// The stable identifier the device was opened by, and the value recorded in the index's `device` key.
    public var name: String
    public var card: Int
    public var cardID: String
    public var device: Int
    public var pcmID: String
    public var alsaLibVersion: String
    enum CodingKeys: String, CodingKey {
        case name, card, device
        case cardID = "card_id", pcmID = "pcm_id", alsaLibVersion = "alsa_lib_version"
    }
}

public struct Negotiated: Codable, Sendable {
    public var format: String
    public var channels: UInt32
    public var rate: UInt32
    public var bufferFrames: UInt
    public var periodFrames: UInt
    enum CodingKeys: String, CodingKey {
        case format, channels, rate
        case bufferFrames = "buffer_frames", periodFrames = "period_frames"
    }
}

public enum CaptureDevices {
    public struct Listed: Sendable {
        public var stableName: String
        public var card: Int
        public var device: Int
        public var description: String
    }

    /// Every capture PCM the kernel lists in /proc/asound/pcm, named in stable form hw:CARD=<id>,DEV=<n>.
    public static func list() -> [Listed] {
        guard let text = try? String(contentsOfFile: "/proc/asound/pcm", encoding: .utf8) else { return [] }
        var out: [Listed] = []
        for line in text.split(separator: "\n") where line.contains("capture") {
            let ids = line.prefix(5).split(separator: "-")
            guard ids.count == 2, let c = Int(ids[0]), let d = Int(ids[1]) else { continue }
            let fields = line.split(separator: ":", omittingEmptySubsequences: false)
            let description = fields.count > 1 ? fields[1].trimmingCharacters(in: .whitespaces) : ""
            out.append(Listed(stableName: "hw:CARD=\(cardID(c)),DEV=\(d)", card: c, device: d, description: description))
        }
        return out
    }

    public static func cardID(_ card: Int) -> String {
        ((try? String(contentsOfFile: "/proc/asound/card\(card)/id", encoding: .utf8)) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A capture device must be named, in stable form, and must exist. Never a default, never a substitute.
    public static func resolve(_ requested: String?) throws -> Listed {
        let devices = list()
        let listing = devices.map { "  \($0.stableName)    \($0.description)" }.joined(separator: "\n")
        guard let requested else {
            throw ALSAError(description: "no capture device named: pass --device in stable form. Capture devices:\n\(listing)")
        }
        guard let found = devices.first(where: { $0.stableName == requested }) else {
            throw ALSAError(description: "capture device \(requested) not found; name one in stable form hw:CARD=<id>,DEV=<n>. Capture devices:\n\(listing)")
        }
        return found
    }
}

/// A capture PCM opened with alsa-lib in blocking mode, S16_LE, interleaved.
public final class ALSACapturePCM: @unchecked Sendable {
    let pcm: OpaquePointer
    public let device: OpenedDevice
    public let negotiated: Negotiated

    public init(device listed: CaptureDevices.Listed, channels: UInt32, rate: UInt32, latencyMicros: UInt32) throws {
        var handle: OpaquePointer?
        let rc = snd_pcm_open(&handle, listed.stableName, SND_PCM_STREAM_CAPTURE, 0)
        guard rc >= 0, let handle else { throw ALSAError(description: "snd_pcm_open(\(listed.stableName)): \(alsaMessage(rc))") }
        pcm = handle
        let sp = snd_pcm_set_params(pcm, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED, channels, rate, 0, latencyMicros)
        guard sp >= 0 else {
            snd_pcm_close(pcm)
            throw ALSAError(description: "snd_pcm_set_params(\(listed.stableName), S16_LE, \(channels) ch, \(rate) Hz, no soft resample): \(alsaMessage(sp))")
        }

        var hw: OpaquePointer?
        snd_pcm_hw_params_malloc(&hw)
        var gotRate: UInt32 = 0, dir: Int32 = 0, gotChannels: UInt32 = 0
        var gotFormat = SND_PCM_FORMAT_UNKNOWN
        if let hw {
            snd_pcm_hw_params_current(pcm, hw)
            snd_pcm_hw_params_get_rate(hw, &gotRate, &dir)
            snd_pcm_hw_params_get_channels(hw, &gotChannels)
            snd_pcm_hw_params_get_format(hw, &gotFormat)
            snd_pcm_hw_params_free(hw)
        }
        var buffer: snd_pcm_uframes_t = 0, period: snd_pcm_uframes_t = 0
        snd_pcm_get_params(pcm, &buffer, &period)
        negotiated = Negotiated(format: gotFormat == SND_PCM_FORMAT_S16_LE ? "S16_LE" : "format \(gotFormat.rawValue)",
                                channels: gotChannels, rate: gotRate, bufferFrames: UInt(buffer), periodFrames: UInt(period))

        var info: OpaquePointer?
        snd_pcm_info_malloc(&info)
        var card = -1, dev = -1, pcmID = ""
        if let info {
            if snd_pcm_info(pcm, info) >= 0 {
                card = Int(snd_pcm_info_get_card(info))
                dev = Int(snd_pcm_info_get_device(info))
                pcmID = snd_pcm_info_get_id(info).map { String(cString: $0) } ?? ""
            }
            snd_pcm_info_free(info)
        }
        device = OpenedDevice(name: listed.stableName, card: card, cardID: CaptureDevices.cardID(card), device: dev,
                              pcmID: pcmID, alsaLibVersion: String(cString: snd_asoundlib_version()))
    }

    public enum ReadResult { case frames(Int), overrun(String), failed(String) }

    /// Starts the stream explicitly. snd_pcm_set_params sets start_threshold to the buffer size, and a capture stream
    /// only starts on a read of at least that many frames; reads of one period would otherwise wait and fail with EIO.
    public func start() -> String? {
        let rc = snd_pcm_start(pcm)
        return rc >= 0 ? nil : "snd_pcm_start: \(alsaMessage(rc))"
    }

    /// Blocking read of up to `frames` frames. An overrun (-EPIPE) is recovered, restarted and reported, never hidden.
    public func read(into buffer: UnsafeMutableRawPointer, frames: Int) -> ReadResult {
        let n = snd_pcm_readi(pcm, buffer, snd_pcm_uframes_t(frames))
        if n >= 0 { return .frames(Int(n)) }
        let err = Int32(n)
        let text = alsaMessage(err)
        if snd_pcm_recover(pcm, err, 1) >= 0 {
            if let startError = start() { return .failed("\(text); restart after recovery failed: \(startError)") }
            return err == -EPIPE ? .overrun(text) : .overrun("recovered from \(text)")
        }
        return .failed(text)
    }

    deinit { snd_pcm_close(pcm) }
}
