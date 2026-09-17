// U3: the server side of the room recorder — enrol, the Bench poll and command bus, pieces and upload.
// A separate process from `room-recorder record`, whose unit is PrivateNetwork=yes: this one talks to the network and
// only READS the tape (tape.idx, and byte ranges of tape.pcm through the piece pipeline).
import BenchCore
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Glibc)
import Glibc
#endif

let usage = """
usage:
  room-bench devices
      List the USB capture devices S5 can resolve (usb:VID:PID) and each one's capture volume. Read-only.
  room-bench enrol --origin https://www.evenscribe.app --token-file PATH [--device-uid usb:VVVV:PPPP] [--root DIR]
      Exchange a bootstrap token for a room session (POST /api/room-recorder/enrol) and write room-session.json, then
      config.json. The token is read from a file (or `--token-file -` for stdin) and never from the command line, where
      any local user can read it from /proc. The first enrol on a machine names the capture device; a re-enrol keeps it.
      Run as the account that owns the state directory (room-recorder).
  room-bench serve [--root DIR]
      Poll the Bench, run its commands, cut pieces from the tape and upload them. SIGTERM closes the pieces without ending
      the session. Exit 75 after an acknowledged restart_engine. Idles (does not exit) once retired or superseded.
  room-bench recut --piece <session_id>/<idx> --bytes <start>-<end> [--root DIR]
      Re-cut a piece the capped spool dropped, from tape.pcm, back into the spool. The piece must be in spool-drops.jsonl
      with exactly that byte range.
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
case "devices":
    // Read-only: what S5 can resolve now, and each device's capture volume reading. Writes nothing to any mixer.
    let enumerator = ALSADeviceEnumerator()
    let volume = ALSAVolumeControl(enumerator: enumerator)
    for device in enumerator.usbCaptureDevices() {
        let reading = volume.inputVolume(uid: device.uid)
        let level = reading.map { r in r.value.map { InstallPollFields.fourDecimals($0) } ?? "unreadable" } ?? "no control"
        print("\(device.uid)  \(device.alsaName)  \(device.name)  input_volume=\(level) settable=\(reading?.settable.description ?? "-")")
    }
case "enrol":
    #if BENCH_TEST_HOOKS
    checkOptions(["--origin", "--token-file", "--device-uid", "--root", "--test-abort-at"])
    let abortAt = option("--test-abort-at")
    /// TEST HOOKS ONLY: die exactly like the live abort did, at a named point.
    let hookAbort: @Sendable (String) -> Void = { point in
        if abortAt == point {
            FileHandle.standardError.write(Data("room-bench: TEST HOOK aborting at \(point)\n".utf8))
            abort()
        }
    }
    #else
    checkOptions(["--origin", "--token-file", "--device-uid", "--root"])
    let hookAbort: @Sendable (String) -> Void = { _ in }
    #endif
    guard let rawOrigin = option("--origin"), let tokenPath = option("--token-file") else { die(usage) }
    let origin: URL
    do { origin = try RoomEnrolment.validate(origin: rawOrigin) } catch { die("\(error)") }
    #if BENCH_TEST_HOOKS
    let store = RoomStore(root: URL(fileURLWithPath: option("--root") ?? Pinned.stateRoot), faultPoint: { point in hookAbort(point) })
    #else
    let store = RoomStore(root: URL(fileURLWithPath: option("--root") ?? Pinned.stateRoot))
    #endif
    // The HTTP client for this whole verb, created first and never released: see URLSessionTransport.
    let transport = URLSessionTransport()
    let device: USBDeviceUID
    do {
        try store.prepareRoot()
        if let recovered = try RoomEnrolment.completeInterruptedEnrolment(store: store) {
            FileHandle.standardError.write(Data("room-bench: \(recovered)\n".utf8))
        }
        device = try RoomEnrolment.preflight(store: store, requestedDeviceUID: option("--device-uid"),
                                             devices: ALSADeviceEnumerator().usbCaptureDevices(),
                                             ffmpegIsExecutable: access(Pinned.ffmpegPath, X_OK) == 0)
    } catch { die("\(error)") }
    let token = readToken(tokenPath)
    // From the server's success to the installed pair nothing is torn down, released or deferred: decode, then
    // RoomEnrolment.persist's two fsynced installs, then — and only then — anything else.
    let enrolled: RoomEnrolmentResponse
    do {
        enrolled = try await RoomEnrolment.exchange(token: token, origin: origin, transport: transport)
    } catch {
        die("\(error)", 1)
    }
    hookAbort("after-exchange")
    let config: RoomConfig
    do {
        config = try RoomEnrolment.persist(enrolled, origin: origin, deviceUID: device, store: store)
    } catch {
        die("ENROLLED ON THE SERVER BUT NOT SAVED HERE: install \(enrolled.installID) was issued and could not be written (\(error)). The token is spent; re-enrol with a fresh token, which retires that install.", 1)
    }
    print("enrolled: room \(enrolled.roomSlug) (\(enrolled.roomName)), install \(enrolled.installID), device \(config.deviceUID), origin \(origin.absoluteString)")
    print("session expires \(enrolled.session.expiresAt); there is no refresh — re-enrol before then")
    fflush(nil)
    hookAbort("at-client-release")
    _ = transport
    exit(0)
#if BENCH_TEST_HOOKS
case "http-check":
    // TEST HOOKS ONLY: the HTTP client's whole lifecycle, many times over — construct, request, release. With
    // --per-call-session each iteration makes and releases its own URLSession, the shape that aborted the live enrol.
    checkOptions(["--url", "--times", "--per-call-session"])
    guard let raw = option("--url"), let url = URL(string: raw) else { die("http-check --url URL [--times N]") }
    let times = option("--times").flatMap(Int.init) ?? 10
    let perCall = arguments.contains("--per-call-session")
    for i in 1...times {
        do {
            let status: Int
            if perCall {
                let session = URLSession(configuration: .ephemeral)
                let (_, response) = try await session.data(for: URLRequest(url: url))
                status = (response as? HTTPURLResponse)?.statusCode ?? -1
            } else {
                let transport = URLSessionTransport()
                status = try await transport.send(HTTPRequest(method: "GET", url: url)).status
            }
            print("iteration \(i): HTTP \(status), client released")
        } catch {
            print("iteration \(i): \(error)")
        }
    }
    print("http-check: \(times) lifecycles, no abort")
#endif
case "serve":
    #if BENCH_TEST_HOOKS
    checkOptions(["--root", "--test-synthetic-devices"])
    #else
    checkOptions(["--root"])
    #endif
    let log = RoomLog()
    let store = RoomStore(root: URL(fileURLWithPath: option("--root") ?? Pinned.stateRoot))
    do {
        try store.prepareRoot()
        if let recovered = try RoomEnrolment.completeInterruptedEnrolment(store: store) { log(recovered) }
    } catch { die("\(error)", 1) }
    // Startup errors are named and non-zero, never a silent degrade.
    guard access(Pinned.ffmpegPath, X_OK) == 0 else { die("ffmpeg is not an executable at the pinned path \(Pinned.ffmpegPath); pieces cannot be made. Install it (U4 apt dependency).", 1) }
    let config: RoomConfig
    let session: RoomSessionRecord
    do {
        guard let c = try store.loadConfig() else { die("not enrolled: no config.json in \(store.root.path); run room-bench enrol", 1) }
        guard let s = try store.loadSession() else { die("not enrolled: no room-session.json in \(store.root.path); run room-bench enrol", 1) }
        config = c
        session = s
    } catch { die("\(error)", 1) }
    guard let installID = config.installID else { die("config.json names no install_id; re-enrol", 1) }
    guard session.installID == installID else {
        die("room-session.json is for install \(session.installID) but config.json names \(installID); re-enrol to make them agree", 1)
    }
    let token = session.sessionToken
    let client = BenchClient(origin: config.origin, transport: URLSessionTransport(), sessionToken: { token })
    #if BENCH_TEST_HOOKS
    let enumerator: any CaptureDeviceEnumerating = option("--test-synthetic-devices").map { SyntheticDeviceEnumerator(path: $0) } ?? ALSADeviceEnumerator()
    let volume: any InputVolumeControlling = option("--test-synthetic-devices") != nil ? NoVolumeControl() : ALSAVolumeControl(enumerator: ALSADeviceEnumerator())
    #else
    let enumerator: any CaptureDeviceEnumerating = ALSADeviceEnumerator()
    let volume: any InputVolumeControlling = ALSAVolumeControl(enumerator: ALSADeviceEnumerator())
    #endif
    let sleeper = TaskSleeper()
    let spool: PieceSpool
    let encoder: PieceEncoder
    do {
        spool = try PieceSpool(root: store.spoolURL, dropLog: store.dropLogURL, log: log)
        encoder = try PieceEncoder(ffmpegPath: Pinned.ffmpegPath)
    } catch { die("\(error)", 1) }
    let lane = TapePieceLane(tapeDir: URL(fileURLWithPath: config.tapeDir), encoder: encoder, spool: spool, client: client,
                             store: store, log: log, sleeper: sleeper)
    let environment = RoomEngineEnvironment(
        client: client, store: store, lane: lane, devices: enumerator, volume: volume,
        captureSwitch: ConfigRepinSwitch(store: store, sleeper: sleeper), machineFacts: { LinuxFacts.read() },
        ffmpegVersion: { LinuxFacts.ffmpegVersion(path: Pinned.ffmpegPath) }, sleeper: sleeper, log: log)
    let engine = RoomEngine(config: config, installID: installID, environment: environment)
    log("serving room \(config.roomSlug) as install \(installID), device \(config.deviceUID), origin \(config.origin.absoluteString), tape \(config.tapeDir), spool cap \(PieceSpool.defaultCapBytes) bytes")
    let run = Task { await engine.run() }
    let stopRequested = DispatchSemaphore(value: 0)
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    var stops: [any DispatchSourceSignal] = []
    for number in [SIGTERM, SIGINT] {
        let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
        source.setEventHandler {
            log("signal \(number): closing pieces without ending the session")
            run.cancel()
            stopRequested.signal()
        }
        source.resume()
        stops.append(source)
    }
    switch await run.value {
    case .restart:
        exit(RoomEngine.restartExitCode)
    case .cancelled:
        exit(0)
    case .retired, .superseded:
        // Idle, not polling, and not exiting: an exit under Restart=always would come straight back. retired.json keeps
        // a retired install from polling even across a restart.
        log("idle: this install no longer polls")
        // Wait for a stop signal and honour it; an idle process must still stop when systemd asks.
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            DispatchQueue.global().async {
                stopRequested.wait()
                done.resume()
            }
        }
        exit(0)
    }
case "recut":
    checkOptions(["--piece", "--bytes", "--root"])
    guard let piece = option("--piece"), let bytes = option("--bytes") else { die(usage) }
    let store = RoomStore(root: URL(fileURLWithPath: option("--root") ?? Pinned.stateRoot))
    guard access(Pinned.ffmpegPath, X_OK) == 0 else { die("ffmpeg is not an executable at the pinned path \(Pinned.ffmpegPath)", 1) }
    do {
        guard let config = try store.loadConfig() else { die("not enrolled: no config.json", 1) }
        let spool = try PieceSpool(root: store.spoolURL, dropLog: store.dropLogURL, log: RoomLog())
        let manifest = try PieceRecut.recut(pieceID: piece, bytes: bytes, spool: spool, encoder: try PieceEncoder(ffmpegPath: Pinned.ffmpegPath),
                                            pcmPath: URL(fileURLWithPath: config.tapeDir).appendingPathComponent("tape.pcm").path)
        print("re-cut \(piece) into the spool as \(manifest.filename) (\(manifest.sizeBytes) bytes); the serving process uploads it")
    } catch { die("\(error)", 1) }
default:
    die(usage)
}
