import Foundation
import IOKit
import IOKit.pwr_mgt

/// IORegisterForSystemPower wrapper. The IOKit message constants are macros that Swift does not import,
/// so the values from <IOKit/IOMessage.h> are spelled out here (iokit_common_msg(m) = 0xE0000000 | m).
enum PowerMsg {
    static let canSystemSleep: UInt32 = 0xE000_0270
    static let systemWillSleep: UInt32 = 0xE000_0280
    static let systemWillNotSleep: UInt32 = 0xE000_0290
    static let systemHasPoweredOn: UInt32 = 0xE000_0300
    static let systemWillPowerOn: UInt32 = 0xE000_0320

    static func name(_ m: UInt32) -> String? {
        switch m {
        case canSystemSleep: return "can_system_sleep"
        case systemWillSleep: return "will_sleep"
        case systemWillNotSleep: return "will_not_sleep"
        case systemHasPoweredOn: return "has_powered_on"
        case systemWillPowerOn: return "will_power_on"
        default: return nil
        }
    }

    /// Map an IOKit message to the event kind it produces (nil = acknowledge only).
    static func eventKind(_ m: UInt32) -> String? {
        switch m {
        case systemWillSleep: return "power.sleep"
        case systemWillNotSleep: return "power.sleep_refused"
        case systemHasPoweredOn: return "power.wake"
        default: return nil
        }
    }
}

private func powerCallback(_ refcon: UnsafeMutableRawPointer?, _ service: io_service_t,
                           _ messageType: UInt32, _ messageArgument: UnsafeMutableRawPointer?) {
    guard let refcon = refcon else { return }
    Unmanaged<PowerNotifier>.fromOpaque(refcon).takeUnretainedValue().handle(messageType, messageArgument)
}

final class PowerNotifier {
    /// Called synchronously inside the IOKit callback (before the sleep acknowledgement), so keep it fast.
    var onMessage: ((UInt32) -> Void)?
    private var rootPort: io_connect_t = 0
    private var notifyPort: IONotificationPortRef?
    private var notifier: io_object_t = 0
    private let queue = DispatchQueue(label: "kh.power-notifier")

    /// Returns false if registration failed (the pmset-log parser still covers sleep/wake).
    @discardableResult
    func start() -> Bool {
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        rootPort = IORegisterForSystemPower(refcon, &notifyPort, powerCallback, &notifier)
        guard rootPort != 0, let port = notifyPort else { return false }
        IONotificationPortSetDispatchQueue(port, queue)
        return true
    }

    func handle(_ message: UInt32, _ argument: UnsafeMutableRawPointer?) {
        onMessage?(message)
        // We never veto or delay sleep: acknowledge immediately.
        if message == PowerMsg.canSystemSleep || message == PowerMsg.systemWillSleep {
            IOAllowPowerChange(rootPort, Int(bitPattern: argument))
        }
    }
}
