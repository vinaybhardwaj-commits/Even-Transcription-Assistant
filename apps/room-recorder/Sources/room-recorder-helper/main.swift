import Foundation
import HelperCore
import KioskHealthCore

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

// 0.1.35: the helper verifies and runs signed commands for itself, keeps the power baseline, and watches the app.
let tools = ProcessSystemTools()
let environment = SystemEnvironment(tools: tools)
let watchdog = AppWatchdog(env: environment, tools: tools, log: log)
let monitor = HelperMonitor(
  env: environment, tools: tools, watchdog: watchdog, safeMode: safeMode,
  heartbeatPath: support.appendingPathComponent(HelperPaths.heartbeatFile).path, log: log)

// 0.1.36 (#47): the kiosk-health collectors run here, spooling to a root-only directory; the app, which holds the device
// credential, takes the batches over XPC and posts them. Safe mode keeps to diagnostics, so no engine then.
var kiosk: KioskHealthEngine?
if !safeMode {
  do {
    kiosk = try KioskHealthEngine(stateDir: KioskHealthHost.stateDirectory, logPath: KioskHealthHost.logPath, files: HelperUserFiles())
  } catch {
    log("kiosk-health engine not started: \(error)")
  }
}

// 0.1.36 (#44, #48): the Chrome policy for the Pulse Presence extension, and the retirement of the standalone guard.
let chrome = ChromePolicyReconciler(tools: tools, env: environment, emit: KioskHealthHost.event(kiosk), log: log)
let retirement = LegacyRetirement(tools: tools, policyActive: { chrome.isActive() }, log: log)
monitor.extraStatus = { ["chrome_policy": chrome.statusWord, "kiosk_spool": String(kiosk?.spoolDepth ?? -1)] }

let runner = HelperCommandRunner(
  env: environment, tools: tools, watchdog: watchdog, chrome: chrome, retirement: retirement,
  statePath: support.appendingPathComponent(HelperPaths.fleetStateFile).path, safeMode: safeMode, log: log)
let service = HelperService(safeMode: safeMode, runner: runner, statusDetail: { monitor.statusDetail() }, kiosk: kiosk)
let delegate = HelperListenerDelegate(service: service)
let listener = NSXPCListener(machServiceName: HelperIdentity.machServiceName)
listener.delegate = delegate
listener.resume()

// Power baseline now, then every 15 minutes; the watchdog and the heartbeat every 30 s. Safe mode (three
// unstable launches in a row) keeps the diagnostics and the XPC answers but touches neither power nor the app.
if !safeMode {
  DispatchQueue.global().async { monitor.enforcePower() }
  let powerTimer = DispatchSource.makeTimerSource(queue: .global())
  powerTimer.schedule(deadline: .now() + HelperMonitor.powerInterval, repeating: HelperMonitor.powerInterval)
  powerTimer.setEventHandler { monitor.enforcePower() }
  powerTimer.resume()
  let watchdogTimer = DispatchSource.makeTimerSource(queue: .global())
  watchdogTimer.schedule(deadline: .now() + 30, repeating: 30)
  watchdogTimer.setEventHandler { monitor.tick() }
  watchdogTimer.resume()
  // The Chrome policy: first pass after 5 s, then every 10 s inside the boot window and every minute after.
  func policyPass() {
    chrome.check()
    chrome.relaunchIfDue()
    DispatchQueue.global().asyncAfter(deadline: .now() + chrome.nextDelay()) { policyPass() }
  }
  DispatchQueue.global().asyncAfter(deadline: .now() + 5) { policyPass() }
  kiosk?.start()
  // Held for the life of the process.
  _ = [powerTimer, watchdogTimer] as [Any]
}

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
  kiosk?.stop()
  channel.stop()
  ledger.recordStable()
  ledger.save(to: ledgerURL)
  exit(0)
}
termSource.resume()

RunLoop.main.run()
