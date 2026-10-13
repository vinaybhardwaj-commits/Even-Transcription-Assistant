import Foundation
@testable import KioskHealthCore

// Round-3: --check-config (installer validation without plutil) and F20 (live console owner).

private func cfgJSON(_ patch: (inout [String: Any]) -> Void = { _ in }) -> Data {
    var d: [String: Any] = [
        "machine": "m", "room_id": NSNull(), "install_id": NSNull(), "sink_url": "https://x.example/api",
        "token": "SECRET-TOKEN-ZZZ", "post": false, "baseline": ["sleep": 0],
        "actions": ["darkwake_watchdog": true, "audio_ladder": false, "reboot_rung": false] as [String: Any],
        "console_user": NSNull(),
    ]
    patch(&d)
    return (try? JSONSerialization.data(withJSONObject: d)) ?? Data()
}

func runR3Tests() {
    test("R3 ConfigCheck: a good config passes; every bad shape gives a one-line reason without values") {
        check(ConfigCheck.check(cfgJSON()) == nil)
        check(ConfigCheck.check(Data("{ nope".utf8)) == "not valid JSON")
        check(ConfigCheck.check(Data("[1]".utf8)) == "top level is not a JSON object")
        check(ConfigCheck.check(Data("{\"b\":1}".utf8))?.hasPrefix("required key missing") == true)
        check(ConfigCheck.check(cfgJSON { $0["ladder_window"] = "00:00-23:59" })?.contains("ladder_window is not a setting") == true)
        check(ConfigCheck.check(cfgJSON { $0["post"] = "yes" }) == "post must be true or false")
        check(ConfigCheck.check(cfgJSON { $0["post"] = 1 }) == "post must be true or false", "a number is not a boolean")
        check(ConfigCheck.check(cfgJSON { $0["machine"] = "" }) == "machine must be a non-empty string")
        check(ConfigCheck.check(cfgJSON { $0["sink_url"] = "ftp://x" }) == "sink_url must be an http(s) URL")
        check(ConfigCheck.check(cfgJSON { $0["token"] = 5 }) == "token must be a string or null")
        check(ConfigCheck.check(cfgJSON { $0["baseline"] = [1] }) == "baseline must be an object")
        check(ConfigCheck.check(cfgJSON { $0["actions"] = ["reboot_rung": true, "audio_ladder": false] as [String: Any] }) == "actions.reboot_rung requires actions.audio_ladder")
        check(ConfigCheck.check(cfgJSON { $0["actions"] = ["audio_ladder": "on"] as [String: Any] }) == "actions.audio_ladder must be true or false")
        check(ConfigCheck.check(cfgJSON { $0["token"] = 5; $0["extra"] = "SECRET-TOKEN-ZZZ" }).map { !$0.contains("SECRET") } == true)
        check(ConfigCheck.check(cfgJSON { $0["something_new"] = 1 }) == nil, "unknown keys other than ladder_window are tolerated")
    }

}
