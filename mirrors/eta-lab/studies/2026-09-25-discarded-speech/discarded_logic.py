"""discarded_logic.py: the PURE logic of the ruling-337d test: is real speech being discarded by the english_hallucination_guard? (eta-refuter #1897 design.) No audio, no text, no network.

QUESTION. In windows where the router's Silero heard nothing, whisper ran on FIXED windows and labelled every segment `en`; the guard refused it. If the room actually speaks an Indic language, whisper-English over faint
Indic speech is garbage that the guard rightly drops, but the SPEECH was real (discarded speech). The 213 refused segments of the 30 drawn windows (studies/2026-09-25-refused-speech/draw_frozen.json) are re-transcribed with the
Indic language FORCED, and a diarizer independently says whether a person spoke.

UNITS. Per window a MEASURED SPAN: refused windows = the union of the refused segments; INDIC POSITIVE controls (indic_controls_frozen.json, addendum 1) = the union of their qualifying native-script Indic segments (first 300 s);
ENGLISH accepted windows (the original 10, reported descriptively only) = the union of their accepted textual segments; noisy no-text controls (N1 8 + N2 6 windows of noisy_draw_frozen.json) = the first 300 s of the window. The span is cut into chunks of at most CHUNK_S (60 s), in time order, the last one may be shorter; a chunk under MIN_CHUNK_S (5 s) is dropped.
FORCED LANGUAGE. Per room: the Indic language label most often seen in that room's OTHER segments (readability features.jsonl, kn/hi/ta/ml/bn/gu/te/mr/pa/or), L1. If the room has fewer than 50 Indic segments the corpus-wide
top two (kn, hi) are used. If L1's share of the room's Indic segments is < 0.60, L2 (the second most frequent) is also tried. Tried languages: 1 or 2.
ARMS per chunk and language: A1 IndicConformer (box twin :8082, decoding ctc), A2 whisper large-v3-turbo forced language (box twin :8080, temperature 0, max_context 0), scored with readability.py as an Indic engine
(engine 'indicconformer', lang = the forced language); D the diarizer (box twin :8001 /diarize): DIARIZED SPEECH seconds in the chunk = the union of its transcript_segments.
BEST OUTPUT per chunk = the arm/language with the highest readability score (ties: more words). SUBSTANTIVE chunk: best n_words >= 5 AND best score >= 0.60 AND diarized speech >= 5.0 s.
WINDOW: substantive_frac = substantive chunk seconds / measured seconds; REAL (real speech discarded / present) iff substantive_frac >= 0.20.
CONTROLS separate iff the 10 INDIC POSITIVE windows (known Indic speech, mostly router fixed-window-fallback recoveries, own language forced; addendum 1 after eta-refuter #1929) are REAL in >= 7 of 10 AND the noisy
no-text windows are REAL in <= 1 of 14. The 10 English accepted windows are forced to Indic and reported descriptively (no pass/fail): they cannot validate the test. If the controls do not separate the 30-window counts must not be read.
DECISION on K = REAL windows among the 30 (only if controls separate): K >= 6 (20 %): real speech is being discarded MATERIALLY: propose a guard-side change with these numbers (retry a fixed-window English refusal with the room's Indic
language before discarding); 2 <= K <= 5: some discarded speech, bounded with the Clopper-Pearson interval, no proposal beyond a larger draw; K <= 1: no material discarding detected. Any guard change is Fable's.
Reported per window: measured seconds, chunks, diarized speech seconds, words and score of the best output, substantive seconds, REAL flag; the arms separately (A1 alone, A2 alone, text-only without the diarizer, diarizer-only).
The recovered TEXT is kept on the box (0600, not in git) for V/Sandhya; it is never printed or reported."""
import json, math, os

CHUNK_S, MIN_CHUNK_S = 60.0, 5.0
MIN_WORDS, MIN_SCORE, MIN_DIAR_S = 5, 0.60, 5.0
REAL_FRAC = 0.20
N_ACCEPT_REAL, N_NOISY_REAL_MAX = 7, 1
K_MATERIAL, K_SOME = 6, 2
NOISY_S = 300.0
MIN_ROOM_INDIC, TOP_SHARE = 50, 0.60
INDIC = ("kn", "hi", "ta", "ml", "bn", "gu", "te", "mr", "pa", "or")
CORPUS_TOP2 = ("kn", "hi")


def room_languages(counts):
    """counts: {lang: n} of the Indic labels seen in ONE room's other segments -> list of 1 or 2 forced languages, and the source string."""
    c = {k: v for k, v in counts.items() if k in INDIC}
    tot = sum(c.values())
    if tot < MIN_ROOM_INDIC:
        return list(CORPUS_TOP2), "corpus-top2"
    order = sorted(c, key=lambda k: (-c[k], k))
    if c[order[0]] / tot >= TOP_SHARE or len(order) == 1:
        return [order[0]], "room-top1"
    return [order[0], order[1]], "room-top2"


def chunks(span, chunk_s=CHUNK_S, min_s=MIN_CHUNK_S):
    """span: sorted disjoint [(a, b)] -> [(a, b)] pieces of at most chunk_s, in order; pieces under min_s dropped."""
    out = []
    for a, b in span:
        t = a
        while t < b - 1e-9:
            e = min(t + chunk_s, b)
            if e - t >= min_s:
                out.append((round(t, 3), round(e, 3)))
            t = e
    return out


def union_seconds(pairs):
    iv = sorted((a, b) for a, b in pairs if b > a)
    tot, cur = 0.0, None
    for a, b in iv:
        if cur is None:
            cur = [a, b]
        elif a <= cur[1]:
            cur[1] = max(cur[1], b)
        else:
            tot += cur[1] - cur[0]
            cur = [a, b]
    return tot + (cur[1] - cur[0] if cur else 0.0)


def best_output(cands):
    """cands: [{arm, lang, n_words, score}] -> the best by score, then words; None if empty."""
    return max(cands, key=lambda c: (c["score"], c["n_words"])) if cands else None


def substantive(best, diar_s):
    return bool(best and best["n_words"] >= MIN_WORDS and best["score"] >= MIN_SCORE and diar_s >= MIN_DIAR_S)


def window_summary(chunk_rows):
    """chunk_rows: [{len_s, best (or None), diar_s, cands}] -> per-window numbers and the REAL flag."""
    meas = sum(r["len_s"] for r in chunk_rows)
    sub = sum(r["len_s"] for r in chunk_rows if substantive(r["best"], r["diar_s"]))
    def arm_only(arm, need_diar):
        s = 0.0
        for r in chunk_rows:
            bs = [c for c in r["cands"] if c["arm"] == arm]
            b = best_output(bs)
            if b and b["n_words"] >= MIN_WORDS and b["score"] >= MIN_SCORE and (r["diar_s"] >= MIN_DIAR_S or not need_diar):
                s += r["len_s"]
        return s
    f = sub / meas if meas > 0 else 0.0
    return dict(measured_s=round(meas, 1), chunks=len(chunk_rows), diar_s=round(sum(r["diar_s"] for r in chunk_rows), 1), substantive_s=round(sub, 1),
                substantive_frac=round(f, 3), real=f >= REAL_FRAC, a1_only_frac=round(arm_only("indic", True) / meas, 3) if meas else 0.0,
                a2_only_frac=round(arm_only("whisper", True) / meas, 3) if meas else 0.0, text_only_frac=round(max(arm_only("indic", False), arm_only("whisper", False)) / meas, 3) if meas else 0.0,
                diar_only_frac=round(sum(r["len_s"] for r in chunk_rows if r["diar_s"] >= MIN_DIAR_S) / meas, 3) if meas else 0.0)


def clopper_pearson(k, n, alpha=0.05):
    """Exact two-sided interval via the beta distribution (bisection on the binomial tail; no scipy needed)."""
    def cdf(x, n, p):
        return sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(0, x + 1))
    def solve(f, lo, hi):
        for _ in range(60):
            m = (lo + hi) / 2
            lo, hi = (m, hi) if f(m) > 0 else (lo, m)
        return (lo + hi) / 2
    lo = 0.0 if k == 0 else solve(lambda p: -(1 - cdf(k - 1, n, p) - alpha / 2), 0.0, 1.0)
    hi = 1.0 if k == n else solve(lambda p: (cdf(k, n, p) - alpha / 2), 0.0, 1.0)
    return round(lo, 4), round(hi, 4)


def decide(real_main, n_main, real_accept, n_accept, real_noisy, n_noisy):
    sep = real_accept >= N_ACCEPT_REAL and real_noisy <= N_NOISY_REAL_MAX
    if not sep:
        return dict(controls_separate=False, verdict="NOT INTERPRETABLE: the controls do not separate")
    lo, hi = clopper_pearson(real_main, n_main)
    if real_main >= K_MATERIAL:
        v = "REAL SPEECH IS BEING DISCARDED MATERIALLY: propose a guard-side change with these numbers (Fable decides)"
    elif real_main >= K_SOME:
        v = "SOME discarded speech: bounded, no proposal beyond a larger draw"
    else:
        v = "no material discarding detected"
    return dict(controls_separate=True, k_real=real_main, n=n_main, clopper_pearson_95=[lo, hi], verdict=v)
