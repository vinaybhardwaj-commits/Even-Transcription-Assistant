import Foundation

public struct CaseRow {
    public let caseID: CaseID
    public let fixture: String
    public let role: FixtureRole?
    public let verdict: Verdict

    /// What this row must show for the suite to hold.
    public var expectation: String {
        switch role {
        case .good: return "PASS"
        case .negative: return "FAIL"
        case nil: return caseID == .C9 ? "PASS|SKIPPED" : "PASS"
        }
    }

    public var holds: Bool {
        switch (role, verdict) {
        case (.good, .pass), (.negative, .fail): return true
        case (nil, .pass), (nil, .skipped): return caseID == .C9
        default: return false
        }
    }
}

/// spec/required-fixtures.json: every fixture a COMPLETE suite root contains, whether or not it is present.
public struct RequiredFixtures: Codable, Sendable {
    public static let currentSchema = "eta.room-recorder.required-fixtures/1"
    public struct Entry: Codable, Sendable {
        public var id: String
        public var role: FixtureRole
        public var cases: [CaseID]
        /// "in-repo" or "out-of-repo-audio".
        public var source: String
        public var how: String
    }
    public var schema: String
    public var description: String
    public var fixtures: [Entry]

    /// A missing or unreadable manifest is a hard error, never a pass.
    public static func load(_ url: URL) throws -> RequiredFixtures {
        let data: Data
        do { data = try Data(contentsOf: url) } catch {
            throw FixtureLoadError(fixture: url.path, reason: "required-fixtures manifest missing or unreadable: \(error)")
        }
        let m = try JSONDecoder().decode(RequiredFixtures.self, from: data)
        guard m.schema == currentSchema else { throw FixtureLoadError(fixture: url.path, reason: "schema \(m.schema) is not \(currentSchema)") }
        return m
    }
}

/// spec/check-grounding.json: every named check, and what it rests on.
///   `mac-source`      — pins a Mac behaviour and carries a Swift file:line; refused without one.
///   `mac-measurement` — pins a Mac behaviour measured on the Mac, and carries that measurement.
///   `our-choice`      — a deliberate decision of ours, carrying the ruling that made it instead of a file:line. Not debt.
///   `ungrounded`      — claims to pin a Mac behaviour and has no citation. Debt: somebody has to go and read the source.
///   `ungrounded-blocked` — claims to pin a Mac behaviour that CANNOT be established by reading (it happens inside a closed
///                       component, or the evidence does not exist), carrying `blocked_by`: what would be needed instead.
///                       Reported separately from debt, so "cannot be grounded yet" is never read as "nobody bothered".
/// A check that runs without an entry counts as ungrounded.
public struct CheckGrounding: Codable, Sendable {
    public static let currentSchema = "eta.room-recorder.check-grounding/1"
    public static let kinds = ["mac-source", "mac-measurement", "our-choice", "ungrounded", "ungrounded-blocked"]
    public struct Entry: Codable, Sendable {
        public var id: String
        public var asserts: String
        public var grounding: String
        public var citation: String
        /// Required for `ungrounded-blocked`: why reading cannot settle it, and what would.
        public var blockedBy: String? = nil
        enum CodingKeys: String, CodingKey { case id, asserts, grounding, citation, blockedBy = "blocked_by" }
    }
    public var schema: String
    public var description: String
    public var checks: [Entry]

    /// A missing or unreadable manifest is a hard error. A mac-source entry must cite at least one Swift file:line.
    public static func load(_ url: URL) throws -> CheckGrounding {
        let data: Data
        do { data = try Data(contentsOf: url) } catch {
            throw FixtureLoadError(fixture: url.path, reason: "check-grounding manifest missing or unreadable: \(error)")
        }
        let m = try JSONDecoder().decode(CheckGrounding.self, from: data)
        guard m.schema == currentSchema else { throw FixtureLoadError(fixture: url.path, reason: "schema \(m.schema) is not \(currentSchema)") }
        for e in m.checks {
            guard kinds.contains(e.grounding) else { throw FixtureLoadError(fixture: url.path, reason: "\(e.id): grounding \(e.grounding) is not one of \(kinds)") }
            if e.grounding == "mac-source", e.citation.range(of: #"\.swift:[0-9]+"#, options: .regularExpression) == nil {
                throw FixtureLoadError(fixture: url.path, reason: "\(e.id) is mac-source but cites no Swift file:line")
            }
            if e.grounding == "our-choice", e.citation.isEmpty {
                throw FixtureLoadError(fixture: url.path, reason: "\(e.id) is our-choice but cites no ruling")
            }
            if e.grounding == "ungrounded-blocked", (e.blockedBy ?? "").isEmpty {
                throw FixtureLoadError(fixture: url.path, reason: "\(e.id) is ungrounded-blocked but states no blocked_by")
            }
        }
        guard Set(m.checks.map(\.id)).count == m.checks.count else { throw FixtureLoadError(fixture: url.path, reason: "duplicate check id") }
        return m
    }
}

public struct SuiteReport {
    public var rows: [CaseRow] = []
    public var loadErrors: [String] = []
    public var coverageProblems: [String] = []
    /// Required fixtures absent from this root; their rows were not run.
    public var missingRequired: [RequiredFixtures.Entry] = []
    public var only: Set<CaseID>? = nil
    public var grounding: CheckGrounding? = nil
    /// Named checks that made at least one assertion in this run.
    public var checksRan: [String: Int] = [:]

    public var holds: Bool { loadErrors.isEmpty && coverageProblems.isEmpty && rows.allSatisfy(\.holds) }
    public var complete: Bool { missingRequired.isEmpty }
    /// Rows the complete root would have run that this root did not.
    public var assertionsNotMade: [(CaseID, RequiredFixtures.Entry)] {
        missingRequired.flatMap { e in e.cases.filter { only?.contains($0) ?? true }.map { ($0, e) } }
    }

    public func render(verbose: Bool) -> String {
        var out: [String] = []
        func pad(_ s: String, _ n: Int) -> String { s.count >= n ? s + " " : s + String(repeating: " ", count: n - s.count) }
        out.append(pad("CASE", 5) + pad("FIXTURE", 38) + pad("ROLE", 9) + pad("RESULT", 8) + pad("MUST", 13) + "HOLDS")
        for r in rows {
            out.append(pad(r.caseID.rawValue, 5) + pad(r.fixture, 38) + pad(r.role?.rawValue ?? "-", 9)
                       + pad(r.verdict.label, 8) + pad(r.expectation, 13) + (r.holds ? "yes" : "NO"))
            let showDetail = verbose || !r.holds || r.role == .negative
            switch r.verdict {
            case .fail(let msgs) where showDetail:
                for m in msgs.prefix(verbose ? 50 : 3) { out.append("      · \(m)") }
                if !verbose, msgs.count > 3 { out.append("      · … \(msgs.count - 3) more") }
            case .skipped(let why), .error(let why):
                out.append("      · \(why)")
            default: break
            }
        }
        for e in loadErrors { out.append("LOAD ERROR  \(e)") }
        for p in coverageProblems { out.append("COVERAGE    \(p)") }
        let notMade = assertionsNotMade
        if !missingRequired.isEmpty {
            out.append("REDUCED ROOT: \(missingRequired.count) required fixture(s) absent; these rows did not run:")
            for (c, e) in notMade {
                out.append(pad("NOT RUN", 9) + pad(c.rawValue, 5) + pad(e.id, 38) + pad(e.role.rawValue, 9) + "(\(e.source): \(e.how))")
            }
        }
        let held = rows.filter(\.holds).count
        out.append("")
        if let g = grounding {
            let byID = Dictionary(uniqueKeysWithValues: g.checks.map { ($0.id, $0) })
            let ran = checksRan.keys.sorted()
            func kind(_ id: String) -> String { byID[id]?.grounding ?? "ungrounded" }
            let ungrounded = ran.filter { kind($0) == "ungrounded" }
            let blocked = ran.filter { kind($0) == "ungrounded-blocked" }
            let count = { (k: String) in ran.filter { kind($0) == k }.count }
            out.append("GROUNDING: \(ran.count) named checks made assertions — \(count("mac-source")) on Mac source, \(count("mac-measurement")) on a Mac measurement, \(count("our-choice")) our choice (ruled, not debt), \(ungrounded.count) UNGROUNDED (debt), \(blocked.count) BLOCKED (cannot be grounded by reading)")
            for id in ungrounded {
                out.append(pad("UNGROUNDED", 11) + pad(id, 40) + (byID[id].map { $0.citation } ?? "not in spec/check-grounding.json"))
            }
            for id in blocked {
                out.append(pad("BLOCKED", 11) + pad(id, 40) + (byID[id]?.blockedBy ?? ""))
            }
            let silent = g.checks.map(\.id).filter { checkID in
                checksRan[checkID] == nil && (only.map { $0.contains { checkID.hasPrefix($0.rawValue + ".") } } ?? true)
            }
            if !silent.isEmpty { out.append("listed checks that made no assertion on this root: \(silent.joined(separator: ", "))") }
        }
        out.append("\(held)/\(rows.count) rows hold; \(loadErrors.count) load errors; \(coverageProblems.count) coverage problems; \(notMade.count) assertions not made")
        if !holds { out.append("SUITE DOES NOT HOLD") }
        else if complete { out.append("SUITE HOLDS") }
        else { out.append("SUITE HOLDS (REDUCED): \(notMade.count) assertions not made, from \(missingRequired.map(\.id).joined(separator: ", "))") }
        return out.joined(separator: "\n")
    }
}

public enum Suite {
    /// Cases that must each pass on at least one good fixture.
    public static let mustPass: [CaseID] = [.C1, .C2, .C3, .C4, .C5, .C6, .C7, .C8, .C9, .C10]
    /// Cases that must each fail on at least one negative control.
    public static let mustHaveNegative: [CaseID] = [.C1, .C2, .C3, .C4, .C5, .C6, .C7, .C8, .C9]

    public static func run(root: URL, required: RequiredFixtures, grounding: CheckGrounding? = nil, only: Set<CaseID>? = nil,
                           resampler: (any Resampler)? = LinkedResampler.current) -> SuiteReport {
        var report = SuiteReport()
        report.only = only
        report.grounding = grounding
        CheckRegistry.reset()
        var fixtures: [Fixture] = []
        do {
            for dir in try FixtureLoader.discover(root: root) {
                do { fixtures.append(try FixtureLoader.load(dir, root: root)) } catch { report.loadErrors.append("\(error)") }
            }
        } catch {
            report.loadErrors.append("cannot read fixtures root \(root.path): \(error)")
            report.checksRan = CheckRegistry.snapshot
            return report
        }

        for id in CaseID.allCases where only?.contains(id) ?? true {
            if id == .C9 {
                for (fx, v) in C9Harness.run(fixtures: fixtures, resampler: resampler) {
                    let role = fixtures.first { $0.id == fx }?.manifest.role
                    report.rows.append(CaseRow(caseID: .C9, fixture: fx, role: role, verdict: v))
                }
                continue
            }
            for f in fixtures where f.manifest.cases.contains(id) {
                report.rows.append(CaseRow(caseID: id, fixture: f.id, role: f.manifest.role, verdict: Cases.run(id, f)))
            }
        }

        // The root against the specification's list: absent required fixtures make it REDUCED; present fixtures the
        // list does not know, or whose cases differ from it, are coverage problems (the list must stay complete).
        let discovered = Set(((try? FixtureLoader.discover(root: root)) ?? []).map {
            String($0.standardizedFileURL.path.dropFirst(root.standardizedFileURL.path.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        })
        report.missingRequired = required.fixtures.filter { !discovered.contains($0.id) }
        let requiredByID = Dictionary(uniqueKeysWithValues: required.fixtures.map { ($0.id, $0) })
        for f in fixtures {
            guard let e = requiredByID[f.id] else {
                report.coverageProblems.append("fixture \(f.id) is present but not listed in spec/required-fixtures.json")
                continue
            }
            if e.cases != f.manifest.cases || e.role != f.manifest.role {
                report.coverageProblems.append("fixture \(f.id) serves \(f.manifest.cases.map(\.rawValue)) as \(f.manifest.role.rawValue); required-fixtures.json says \(e.cases.map(\.rawValue)) as \(e.role.rawValue)")
            }
        }

        if only == nil {
            for id in mustPass where !report.rows.contains(where: { $0.caseID == id && $0.role == .good && $0.verdict == .pass }) {
                report.coverageProblems.append("\(id.rawValue) has no good fixture that passes")
            }
            for id in mustHaveNegative where !report.rows.contains(where: { $0.caseID == id && $0.role == .negative && $0.holds }) {
                report.coverageProblems.append("\(id.rawValue) has no negative control that fails")
            }
            // C9's blind spots stay closed only while these fixtures exist and pass.
            func c9Passes(_ where_: (ResamplerFixture) -> Bool) -> Bool {
                fixtures.contains { f in
                    f.manifest.role == .good && f.manifest.resampler.map(where_) == true
                        && report.rows.contains { $0.caseID == .C9 && $0.fixture == f.id && $0.verdict == .pass }
                }
            }
            if !c9Passes({ $0.tapsRole == "direction_probe" }) {
                report.coverageProblems.append("C9 has no passing direction-probe fixture: the convolution index direction is unpinned")
            }
            if !c9Passes({ $0.regionStarts?.isEmpty == false }) {
                report.coverageProblems.append("C9 has no passing fixture with region_starts: the reset at a discontinuity is unpinned")
            }
            // Every schema key, Double and String keys included, must be round-tripped by C2 on a good fixture.
            var seen = Set<String>()
            for f in fixtures where f.manifest.role == .good
                && report.rows.contains(where: { $0.caseID == .C2 && $0.fixture == f.id && $0.verdict == .pass }) {
                if let s = try? IndexLog.scan(f.idx) { for l in s.lines { seen.formUnion(l.fields.keys) } }
            }
            for k in IndexKey.all where !seen.contains(k) {
                report.coverageProblems.append("index key \(k) is not exercised by any good fixture that passes C2")
            }
        }
        report.checksRan = CheckRegistry.snapshot
        return report
    }
}
