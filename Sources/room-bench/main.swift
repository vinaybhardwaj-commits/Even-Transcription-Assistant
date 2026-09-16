// U3: the server side of the room recorder — enrol, the Bench poll and command bus, pieces and upload.
// A separate process from `room-recorder record`, whose unit is PrivateNetwork=yes: this one talks to the network and
// only READS the tape (tape.idx, and byte ranges of tape.pcm through the piece pipeline).
import BenchCore
import Foundation
#if canImport(Glibc)
import Glibc
#endif

let usage = """
usage:
  room-bench enrol --origin https://www.evenscribe.app --token-file PATH [--device-uid usb:VVVV:PPPP] [--root DIR]
      Exchange a bootstrap token for a room session (POST /api/room-recorder/enrol) and write room-session.json, then
      config.json. The token is read from a file (or `--token-file -` for stdin) and never from the command line, where
      any local user can read it from /proc. The first enrol on a machine names the capture device; a re-enrol keeps it.
      Run as the account that owns the state directory (room-recorder).
"""

func die(_ message: String, _ code: Int32 = 2) -> Never {
    FileHandle.standardError.write(Data(("room-bench: " + message + "\n").utf8))
    exit(code)
}

let arguments = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
    guard let i = arguments.firstIndex(of: name) else { return nil }
    guard i + 1 < arguments.count else { die("\(name) needs a value") }
    return arguments[i + 1]
}

func checkOptions(_ known: Set<String>) {
    var i = 1
    while i < arguments.count {
        guard known.contains(arguments[i]) else { die("unknown option \(arguments[i])\n\(usage)") }
        i += 2
    }
}

func readToken(_ path: String) -> String {
    let data: Data
    if path == "-" {
        data = FileHandle.standardInput.readDataToEndOfFile()
    } else {
        guard let read = FileManager.default.contents(atPath: path) else { die("cannot read --token-file \(path)") }
        data = read
    }
    let token = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !token.isEmpty, !token.contains(where: { $0.isNewline }) else { die("--token-file holds no single-line token") }
    return token
}

switch arguments.first {
case "enrol":
    checkOptions(["--origin", "--token-file", "--device-uid", "--root"])
    guard let rawOrigin = option("--origin"), let tokenPath = option("--token-file") else { die(usage) }
    let origin: URL
    do { origin = try RoomEnrolment.validate(origin: rawOrigin) } catch { die("\(error)") }
    let store = RoomStore(root: URL(fileURLWithPath: option("--root") ?? Pinned.stateRoot))
    let device: USBDeviceUID
    do {
        device = try RoomEnrolment.preflight(store: store, requestedDeviceUID: option("--device-uid"),
                                             devices: ALSADeviceEnumerator().usbCaptureDevices(),
                                             ffmpegIsExecutable: access(Pinned.ffmpegPath, X_OK) == 0)
    } catch { die("\(error)") }
    let token = readToken(tokenPath)
    do {
        let enrolled = try await RoomEnrolment.exchange(token: token, origin: origin, transport: URLSessionTransport())
        let config = try RoomEnrolment.persist(enrolled, origin: origin, deviceUID: device, store: store)
        print("enrolled: room \(enrolled.roomSlug) (\(enrolled.roomName)), install \(enrolled.installID), device \(config.deviceUID), origin \(origin.absoluteString)")
        print("session expires \(enrolled.session.expiresAt); there is no refresh — re-enrol before then")
    } catch {
        die("\(error)", 1)
    }
default:
    die(usage)
}
