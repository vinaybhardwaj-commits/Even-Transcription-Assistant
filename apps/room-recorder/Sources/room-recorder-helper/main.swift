import Foundation
import HelperCore

// The root helper (TS-H2 #39). Runs from the launchd plist inside the app bundle. This slice
// answers `hello` and `helperStatus` over XPC and does nothing else.

let support = URL(fileURLWithPath: HelperIdentity.supportDirectory, isDirectory: true)
let killFile = support.appendingPathComponent(HelperIdentity.killFileName)
let ledgerURL = support.appendingPathComponent(HelperIdentity.ledgerFileName)

func log(_ line: String) {
  FileHandle.standardError.write(Data("room-recorder-helper: \(line)\n".utf8))
}

// The operator's off switch. The helper stays alive (KeepAlive would respawn an exit) but opens
// no listener and runs nothing.
if FileManager.default.fileExists(atPath: killFile.path) {
  log("kill file present; idle")
  while true { sleep(3600) }
}

var ledger = LaunchLedger.load(from: ledgerURL)
let safeMode = ledger.recordLaunch()
ledger.save(to: ledgerURL)
if safeMode { log("safe mode: \(LaunchLedger.safeModeThreshold) unstable launches in a row") }

let service = HelperService(safeMode: safeMode)
let delegate = HelperListenerDelegate(service: service)
let listener = NSXPCListener(machServiceName: HelperIdentity.machServiceName)
listener.delegate = delegate
listener.resume()

// #40 plugs the outbound long-poll in here.
let channel: HelperControlChannel = NullControlChannel()
channel.start()

// A minute of life counts as a stable launch.
let stableTimer = DispatchSource.makeTimerSource(queue: .main)
stableTimer.schedule(deadline: .now() + 60)
stableTimer.setEventHandler {
  ledger.recordStable()
  ledger.save(to: ledgerURL)
}
stableTimer.resume()

signal(SIGTERM, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler {
  channel.stop()
  ledger.recordStable()
  ledger.save(to: ledgerURL)
  exit(0)
}
termSource.resume()

RunLoop.main.run()
