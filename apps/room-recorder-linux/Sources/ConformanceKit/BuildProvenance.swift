import Foundation

/// V's ruling, 16 Sep: a count printed by a binary older than its sources is not evidence about those sources.
///
/// On 16 Sep the in-repo `conformance` was built at 09:48 and reported on a HEAD committed at 11:24. It reported
/// *correctly* — and that was the problem: we had to reason about whether we had got away with it. A rule that must be
/// remembered gets skipped at two in the morning, so the rule is mechanical here instead: `conformance run` prints its
/// own provenance on every run and REFUSES to print a count when any build input is newer than the binary.
///
/// The refusal is decided on mtimes alone. HEAD is printed because it is what a commit message quotes, but a repo we
/// cannot read never blocks a run — an unreadable `.git` says nothing about whether the binary is current.
public struct BuildProvenance: Sendable {
    public struct Input: Sendable {
        public var path: String      // relative to the package root
        public var modified: Date
    }

    public enum Verdict: Sendable {
        case fresh(margin: TimeInterval)
        case stale(Input, behind: TimeInterval)
        /// The source tree could not be located from the binary (e.g. it was copied elsewhere). Not a refusal:
        /// there is no evidence of staleness, only no evidence either way, and that is said out loud.
        case unlocatable(String)
    }

    public var binaryPath: String
    public var binaryBuilt: Date
    public var packageRoot: String?
    public var head: String
    public var newestInput: Input?
    public var verdict: Verdict

    public var refusesToPrintCount: Bool {
        if case .stale = verdict { return true }
        return false
    }
}

extension BuildProvenance {
    /// Build inputs are what the compiler reads: everything under `Sources/` plus the manifest. `spec/*.json` is
    /// deliberately NOT an input — it is data the binary loads at runtime, so a newer manifest is already reflected
    /// in the run and does not make the binary stale.
    static let inputRoots = ["Sources", "Package.swift"]

    public static func detect() -> BuildProvenance {
        let binary = resolvedBinaryPath()
        let built = (try? FileManager.default.attributesOfItem(atPath: binary)[.modificationDate] as? Date) ?? nil

        guard let root = packageRoot(from: binary) else {
            return BuildProvenance(
                binaryPath: binary, binaryBuilt: built ?? .distantPast, packageRoot: nil,
                head: "(no source tree found)", newestInput: nil,
                verdict: .unlocatable("no directory above the binary holds both Package.swift and Sources/"))
        }

        let builtAt = built ?? .distantPast
        guard let newest = newestInput(under: root) else {
            return BuildProvenance(
                binaryPath: binary, binaryBuilt: builtAt, packageRoot: root.path,
                head: gitHead(root: root), newestInput: nil,
                verdict: .unlocatable("no readable build input under \(root.path)"))
        }

        let delta = newest.modified.timeIntervalSince(builtAt)
        return BuildProvenance(
            binaryPath: binary, binaryBuilt: builtAt, packageRoot: root.path,
            head: gitHead(root: root), newestInput: newest,
            verdict: delta > 0 ? .stale(newest, behind: delta) : .fresh(margin: -delta))
    }

    private static func resolvedBinaryPath() -> String {
        // /proc/self/exe is the truth on Linux: argv[0] can be a bare name found on PATH, or a symlink.
        if let exe = try? FileManager.default.destinationOfSymbolicLink(atPath: "/proc/self/exe") { return exe }
        return URL(fileURLWithPath: CommandLine.arguments.first ?? "conformance").standardizedFileURL.path
    }

    /// Walk up from the binary looking for the package. The layout is ROOT/.build/release/conformance, but SwiftPM
    /// also writes ROOT/.build/<triple>/release/, so the depth is not fixed — search rather than count.
    private static func packageRoot(from binary: String) -> URL? {
        var dir = URL(fileURLWithPath: binary).standardizedFileURL.deletingLastPathComponent()
        for _ in 0..<8 {
            let manifest = dir.appendingPathComponent("Package.swift")
            let sources = dir.appendingPathComponent("Sources")
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: manifest.path),
               FileManager.default.fileExists(atPath: sources.path, isDirectory: &isDir), isDir.boolValue {
                return dir
            }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        return nil
    }

    private static func newestInput(under root: URL) -> Input? {
        var newest: Input?
        func consider(_ url: URL) {
            guard let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey]),
                  values.isRegularFile == true, let m = values.contentModificationDate else { return }
            if newest == nil || m > newest!.modified {
                let rel = url.standardizedFileURL.path.hasPrefix(root.path + "/")
                    ? String(url.standardizedFileURL.path.dropFirst(root.path.count + 1))
                    : url.lastPathComponent
                newest = Input(path: rel, modified: m)
            }
        }
        for name in inputRoots {
            let url = root.appendingPathComponent(name)
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else { continue }
            if isDir.boolValue {
                let keys: [URLResourceKey] = [.contentModificationDateKey, .isRegularFileKey]
                guard let walk = FileManager.default.enumerator(at: url, includingPropertiesForKeys: keys) else { continue }
                for case let child as URL in walk { consider(child) }
            } else {
                consider(url)
            }
        }
        return newest
    }

    /// Reads HEAD without running git: the build image need not have it, and a worktree's `.git` is a file, not a dir.
    private static func gitHead(root: URL) -> String {
        let dotGit = root.appendingPathComponent(".git")
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: dotGit.path, isDirectory: &isDir) else { return "(not a git tree)" }

        var gitDir = dotGit
        if !isDir.boolValue {
            // Worktree: ".git" holds "gitdir: /path/to/.git/worktrees/<name>".
            guard let text = try? String(contentsOf: dotGit, encoding: .utf8),
                  let line = text.split(separator: "\n").first(where: { $0.hasPrefix("gitdir:") }) else {
                return "(unreadable .git)"
            }
            let path = line.dropFirst("gitdir:".count).trimmingCharacters(in: .whitespaces)
            gitDir = path.hasPrefix("/") ? URL(fileURLWithPath: path)
                                         : root.appendingPathComponent(path).standardizedFileURL
        }

        guard let head = try? String(contentsOf: gitDir.appendingPathComponent("HEAD"), encoding: .utf8)
                                .trimmingCharacters(in: .whitespacesAndNewlines) else { return "(unreadable HEAD)" }
        guard head.hasPrefix("ref: ") else { return "\(String(head.prefix(7))) (detached)" }

        let ref = String(head.dropFirst("ref: ".count))
        let branch = ref.hasPrefix("refs/heads/") ? String(ref.dropFirst("refs/heads/".count)) : ref
        // A linked worktree keeps refs in the common dir, not its own gitdir.
        var searchDirs = [gitDir]
        if let common = try? String(contentsOf: gitDir.appendingPathComponent("commondir"), encoding: .utf8)
                                .trimmingCharacters(in: .whitespacesAndNewlines) {
            searchDirs.append(common.hasPrefix("/") ? URL(fileURLWithPath: common)
                                                    : gitDir.appendingPathComponent(common).standardizedFileURL)
        }
        for dir in searchDirs {
            if let sha = try? String(contentsOf: dir.appendingPathComponent(ref), encoding: .utf8)
                                .trimmingCharacters(in: .whitespacesAndNewlines), !sha.isEmpty {
                return "\(String(sha.prefix(7))) (\(branch))"
            }
            if let packed = try? String(contentsOf: dir.appendingPathComponent("packed-refs"), encoding: .utf8) {
                for line in packed.split(separator: "\n") where line.hasSuffix(" " + ref) {
                    return "\(String(line.prefix(7))) (\(branch))"
                }
            }
        }
        return "(unresolved \(branch))"
    }
}

extension BuildProvenance {
    /// The trailing `touch` is not decoration, and it is the difference between a refusal that clears and one that does
    /// not. SwiftPM relinks only when the *link* inputs change, so an edit that compiles to an identical object — a
    /// comment, whitespace, a reordering — recompiles without rewriting the binary. The source mtime advances, the
    /// binary's does not, and this check then reads STALE forever.
    ///
    /// Measured 16 Sep, boot 3: after `touch Sources/ConformanceKit/Suite.swift`, two successive builds both printed
    /// "Build complete!" and both left the binary at 11:58:51 while the source sat at 11:59:17. `.build/build.db`
    /// advanced to 12:00:29, so the build really had run — it just had nothing to link. Stamping the product on a
    /// successful build makes the recovery this message prescribes actually recover.
    ///
    /// It is `&&`, never `;`: a build that failed must not stamp anything. The mtime anchor stays the binary rather
    /// than `build.db`, because `build.db` advances on a *failed* build too — that would fail open, printing a count
    /// from a stale binary, which is the one outcome this whole mechanism exists to prevent.
    static let rebuildCommand =
        "docker run --rm -v \"$PWD\":/w -w /w eta-u1-build "
        + "bash -c 'swift build -c release --static-swift-stdlib && touch .build/release/conformance'"

    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss ZZZZZ"
        return f
    }()

    private static func duration(_ seconds: TimeInterval) -> String {
        let s = Int(seconds.rounded())
        if s < 60 { return "\(s) s" }
        if s < 3600 { return "\(s / 60) min \(s % 60) s" }
        return "\(s / 3600) h \((s % 3600) / 60) min"
    }

    public func render() -> String {
        var lines = [
            "build provenance: \(binaryPath)",
            "  binary built:       \(Self.stamp.string(from: binaryBuilt))",
            "  HEAD:               \(head)",
        ]
        if let n = newestInput {
            lines.append("  newest build input: \(n.path)  \(Self.stamp.string(from: n.modified))")
        } else {
            lines.append("  newest build input: (none found)")
        }
        switch verdict {
        case .fresh(let margin):
            lines.append("  FRESH: the binary is newer than every build input, by \(Self.duration(margin)).")
        case .stale(let input, let behind):
            lines.append("  STALE: \(input.path) is \(Self.duration(behind)) NEWER than the binary.")
            lines.append("  This binary did not compile that file. Any count it printed would describe a tree that no")
            lines.append("  longer exists, so no count is printed. Rebuild, then re-run:")
            lines.append("    " + Self.rebuildCommand)
        case .unlocatable(let why):
            lines.append("  UNVERIFIED: \(why).")
            lines.append("  No evidence of staleness and none of freshness. Do not quote this run's count in a commit.")
        }
        return lines.joined(separator: "\n")
    }
}
