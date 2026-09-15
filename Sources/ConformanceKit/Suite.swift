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

public struct SuiteReport {
    public var rows: [CaseRow] = []
    public var loadErrors: [String] = []
    public var coverageProblems: [String] = []

    public var holds: Bool { loadErrors.isEmpty && coverageProblems.isEmpty && rows.allSatisfy(\.holds) }

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
        let held = rows.filter(\.holds).count
        out.append("")
        out.append("\(held)/\(rows.count) rows hold; \(loadErrors.count) load errors; \(coverageProblems.count) coverage problems")
        out.append(holds ? "SUITE HOLDS" : "SUITE DOES NOT HOLD")
        return out.joined(separator: "\n")
    }
}

public enum Suite {
    /// Cases that must each pass on at least one good fixture.
    public static let mustPass: [CaseID] = [.C1, .C2, .C3, .C4, .C5, .C6, .C7, .C8, .C9, .C10]
    /// Cases that must each fail on at least one negative control.
    public static let mustHaveNegative: [CaseID] = [.C1, .C2, .C3, .C4, .C5, .C6, .C7, .C8, .C9]

    public static func run(root: URL, only: Set<CaseID>? = nil, resampler: (any Resampler)? = LinkedResampler.current) -> SuiteReport {
        var report = SuiteReport()
        var fixtures: [Fixture] = []
        do {
            for dir in try FixtureLoader.discover(root: root) {
                do { fixtures.append(try FixtureLoader.load(dir, root: root)) } catch { report.loadErrors.append("\(error)") }
            }
        } catch {
            report.loadErrors.append("cannot read fixtures root \(root.path): \(error)")
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
        return report
    }
}
