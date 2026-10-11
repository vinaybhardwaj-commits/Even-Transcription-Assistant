import Foundation
@testable import KioskHealthCore

// Round-11: build identity in every heartbeat: build = {git_sha, lc_uuid, pkg_version}.

func runR11Tests() {
    test("R11 build identity: lc_uuid is the running image's own LC_UUID (matches dwarfdump on this very binary)") {
        let u = BuildIdentity.lcUUID
        check(RX("^[0-9a-f]{32}$").matches(u), "32 lowercase hex, no dashes: \(u)")
        let r = ProcessRunner(allowed: Tool.all.union(["/usr/bin/dwarfdump"])).run("/usr/bin/dwarfdump", ["--uuid", selfExecutablePath()], timeout: 20)
        if r.ok, let line = r.stdout.split(separator: "\n").first {
            let parts = line.split(separator: " ")
            let expect = parts.count > 1 ? parts[1].replacingOccurrences(of: "-", with: "").lowercased() : ""
            checkEq(u, expect, "same UUID dwarfdump reads from the binary file")
        } else {
            check(false, "dwarfdump unavailable, cannot cross-check: \(r.failureNote)")
        }
    }

    test("R11 build identity: payload shape is exactly {git_sha, lc_uuid, pkg_version}, stamped values") {
        let p = BuildIdentity.payload()
        checkEq(Set(p.keys), ["git_sha", "lc_uuid", "pkg_version"])
        check(RX("^([0-9a-f]{7}(-dirty)?|unknown(-dirty)?)$").matches(p["git_sha"] as? String ?? ""), "git_sha: \(p["git_sha"] ?? "")")
        checkEq(p["pkg_version"] as? String, BuildInfo.pkgVersion)
        checkEq(p["lc_uuid"] as? String, BuildIdentity.lcUUID)
        checkEq(BuildInfo.pkgVersion, kVersion, "the stamped package version agrees with the in-source version")
    }

    test("R11 heartbeat: every heartbeat payload carries build; version and the other keys are unchanged") {
        let (ctx, _, _) = makeCtx()
        let hb = HeartbeatCollector(ctx: ctx)
        for ev in [hb.build(), hb.build(started: true), hb.poll().events[0]] {
            let b = ev.payload["build"] as? [String: Any]
            checkEq(Set((b ?? [:]).keys), ["git_sha", "lc_uuid", "pkg_version"])
            checkEq(b?["lc_uuid"] as? String, BuildIdentity.lcUUID)
            checkEq(ev.payload["version"] as? String, kVersion)
            for k in ["uptime_s", "daemon_uptime_s", "spool_depth", "spool_dropped", "last_post_ok", "last_post", "post_enabled"] {
                check(ev.payload[k] != nil, "\(k) still present")
            }
        }
        check(J.string(hb.build().payload).utf8.count < SinkGuard.maxPayloadBytes)
    }

    test("R11 the heartbeat survives the sink guards untouched (build is plain strings, depth 2)") {
        let (ctx, _, _) = makeCtx()
        let g = SinkGuard.guardPayload(HeartbeatCollector(ctx: ctx).build().payload, kind: "heartbeat")
        check(g["_truncated"] == nil)
        checkEq((g["build"] as? [String: Any])?["lc_uuid"] as? String, BuildIdentity.lcUUID)
    }
}
