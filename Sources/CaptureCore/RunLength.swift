// U2 A — an indefinite run. `--seconds` is OPTIONAL; absent means run until terminated.
//
// There is deliberately NO magic string. `--seconds forever` would put a non-numeric value inside a numeric option,
// which is a mistyping waiting to happen (`--seconds forevre` parses as… what?). An ABSENT option cannot be
// mistyped. `--seconds S` keeps its exact existing meaning, so every existing test, fixture generation and
// measurement is unchanged by this.
//
// The recorder stops on SIGINT/SIGTERM in both modes; the only difference is whether a frame count also stops it.
public enum RunLength: Sendable, Equatable {
    /// `--seconds S`: stop after this many captured INPUT frames. Counts captured audio, not wall time.
    case bounded(frames: Int64)
    /// `--seconds` absent: run until terminated. A room does not know in advance how long it is a room for.
    case indefinite

    /// `seconds == nil` is the indefinite run. A non-positive or unparseable `--seconds` is a usage error and is
    /// rejected by the caller, never silently turned into an indefinite run: "record forever" must be asked for by
    /// omitting the option, not arrived at by mistyping it.
    public init(seconds: Double?, rate: Int64) {
        guard let seconds else { self = .indefinite; return }
        self = .bounded(frames: Int64((seconds * Double(rate)).rounded()))
    }

    public var targetFrames: Int64? {
        if case .bounded(let f) = self { return f }
        return nil
    }

    /// The capture loop's continue condition, frame count only; the stop flag is the caller's business.
    public func shouldContinue(captured: Int64) -> Bool {
        guard case .bounded(let f) = self else { return true }
        return captured < f
    }

    /// How many frames to ask the device for next. Bounded runs must not overshoot their target on the last read;
    /// an indefinite run always asks for a full period.
    public func readSize(period: Int, captured: Int64) -> Int {
        guard case .bounded(let f) = self else { return period }
        return Int(min(Int64(period), f - captured))
    }

    /// What the journal says at startup. S6: lifecycle, never content.
    public var describedForJournal: String {
        switch self {
        case .indefinite: return "indefinite (until SIGINT/SIGTERM)"
        case .bounded(let f): return "\(f) input frames"
        }
    }
}
