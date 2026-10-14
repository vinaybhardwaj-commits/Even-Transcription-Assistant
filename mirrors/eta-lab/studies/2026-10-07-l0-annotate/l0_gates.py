#!/usr/bin/env python3
"""L0 Gate 3 scorer on E6 (lid-debug; L0-PREREG.md lid-debug/l0-annotate, r2 9d23655d + A1..A1.5 @ 7a0fb620). Aggregates only:
prints counts and rates, never a segment's text.

Inputs: --suite = E6 suite dir (suite.json + 768 *.truth.json); --p / --l0 = result dirs, one <window id>.result.json per window
(the shared-engine harness record: engines.stt = the router reply; a bare reply with top-level "segments" is also accepted).
Unit (§3 Gate 3): a segment in L0's output with engine "whisper", lang "en", and n >= 4 tokens, tokens = [a-z']+ of the lowercased
text with >= 2 letters (the §2 rule's own tokenisation). Flag = romanised_indic_suspect is True.
Truth mode from the window id (clin_<mode>_<k>[__<condition>]). POSITIVE = hi kn ta te ml; NEGATIVE = en; hi-en / kn-en REPORTED only.
Gates: (a) flagged NEG / NEG <= 2% AND Wilson 95% upper <= 5%, NEG >= 50 else NOT EVALUABLE; (b) flagged POS / all flagged (mono)
>= 0.95 with >= 30 flagged else NOT EVALUABLE; (c) suspect_lang == truth mode among flagged POS >= 0.80; (d) every window:
L0's reply minus the two keys == P's reply, canonical JSON (sorted keys). DECLARED: the harness wrapper's timing field latency_s is
not part of the router reply and is excluded from (d); nothing else is. Any gate NOT EVALUABLE = FAIL.
"""
import argparse, collections, glob, hashlib, json, math, os, re, sys

E6_SUITE, E6_N = "d61bd0f7e9076ee5", 768
MODES = ("en", "hi", "kn", "ta", "te", "ml", "hi-en", "kn-en")
POS, NEG = {"hi", "kn", "ta", "te", "ml"}, {"en"}
KEYS = ("romanised_indic_suspect", "suspect_lang")
WID = re.compile(r"^(?:[a-z0-9]+_)?clin_(en|hi|kn|ta|te|ml|hi-en|kn-en)_\d+(?:__[a-z0-9_]+)?$")
TOK = re.compile(r"[a-z']+")


def sha16(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()[:16]


def reply(path):
    d = json.load(open(path))
    if "segments" in d:
        return d
    return (d.get("engines") or {}).get("stt") or {}


def strip(r):
    r = {k: v for k, v in r.items() if k != "latency_s"}
    r["segments"] = [{k: v for k, v in s.items() if k not in KEYS} for s in r.get("segments") or []]
    return json.dumps(r, sort_keys=True, ensure_ascii=False)


def n_tokens(text):
    return sum(1 for t in TOK.findall((text or "").lower()) if sum(c.isalpha() for c in t) >= 2)


def wilson_upper(k, n, z=1.959964):
    if n == 0:
        return float("nan")
    p = k / n
    return (p + z * z / (2 * n) + z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--suite", required=True); ap.add_argument("--p", required=True); ap.add_argument("--l0", required=True)
    a = ap.parse_args()
    assert sha16(os.path.join(a.suite, "suite.json")) == E6_SUITE, "suite.json sha16 != " + E6_SUITE
    wids = sorted(os.path.basename(f)[:-len(".truth.json")] for f in glob.glob(os.path.join(a.suite, "*.truth.json")))
    assert len(wids) == E6_N, "truth count %d != %d" % (len(wids), E6_N)
    for d in (a.p, a.l0):
        got = sorted(os.path.basename(f)[:-len(".result.json")] for f in glob.glob(os.path.join(d, "*.result.json")))
        assert got == wids, "%s: result ids != truth ids (%d results)" % (d, len(got))
    ids = hashlib.sha256("\n".join(wids).encode()).hexdigest()[:16]
    print("L0 Gate 3 on E6: suite %s, %d windows, ids sha %s; both arms complete" % (E6_SUITE, E6_N, ids))

    S = collections.defaultdict(collections.Counter)        # per mode: units, flags, windows, flagged windows, lang ok
    ident_bad, p_flags, offunit_flags = 0, 0, 0
    for w in wids:
        m = WID.match(w)
        assert m, "window id not parseable: " + w
        mode = m.group(1)
        rp, rl = reply(os.path.join(a.p, w + ".result.json")), reply(os.path.join(a.l0, w + ".result.json"))
        ident_bad += strip(rp) != strip(rl)
        p_flags += sum(1 for s in rp.get("segments") or [] if any(k in s for k in KEYS))
        S[mode]["win"] += 1
        wflag = False
        for s in rl.get("segments") or []:
            flag = s.get("romanised_indic_suspect") is True
            unit = s.get("engine") == "whisper" and s.get("lang") == "en" and n_tokens(s.get("text")) >= 4
            if flag and not unit:
                offunit_flags += 1
            if not unit:
                continue
            S[mode]["unit"] += 1
            if flag:
                S[mode]["flag"] += 1; wflag = True
                S[mode]["lang_ok"] += s.get("suspect_lang") == mode
        S[mode]["unit_win"] += any(s.get("engine") == "whisper" and s.get("lang") == "en" and n_tokens(s.get("text")) >= 4
                                   for s in rl.get("segments") or [])
        S[mode]["flag_win"] += wflag

    print("\nper mode: windows | units (Whisper-path segs, n>=4) | flagged | flag rate | windows with a unit | flagged windows | "
          "window flag rate | suspect_lang == mode")
    for mode in MODES:
        c = S[mode]
        r = lambda k, n: ("%.1f%%" % (100.0 * c[k] / c[n])) if c[n] else "n/a"
        tag = "NEG" if mode in NEG else ("POS" if mode in POS else "REPORT")
        print("  %-5s %-6s win %3d | units %3d | flagged %3d | %6s | unit-win %3d | flag-win %3d | %6s | lang_ok %d/%d"
              % (mode, tag, c["win"], c["unit"], c["flag"], r("flag", "unit"), c["unit_win"], c["flag_win"],
                 r("flag_win", "unit_win"), c["lang_ok"], c["flag"]))

    neg_n = sum(S[m]["unit"] for m in NEG); neg_k = sum(S[m]["flag"] for m in NEG)
    pos_k = sum(S[m]["flag"] for m in POS); flagged = pos_k + neg_k
    lang_ok = sum(S[m]["lang_ok"] for m in POS)
    wu = wilson_upper(neg_k, neg_n)
    res = {}
    if neg_n < 50:
        res["a"] = "NOT EVALUABLE (negatives %d < 50) = FAIL" % neg_n
    else:
        ok = neg_k / neg_n <= 0.02 and wu <= 0.05
        res["a"] = "%s: false flags %d/%d = %.2f%% (bar <= 2%%), Wilson95 upper %.2f%% (bar <= 5%%)" % (
            "PASS" if ok else "FAIL", neg_k, neg_n, 100.0 * neg_k / neg_n, 100.0 * wu)
    if flagged < 30:
        res["b"] = "NOT EVALUABLE (mono flags %d < 30) = FAIL" % flagged
    else:
        res["b"] = "%s: precision %d/%d = %.3f (bar >= 0.95)" % ("PASS" if pos_k / flagged >= 0.95 else "FAIL", pos_k, flagged, pos_k / flagged)
    if pos_k == 0:
        res["c"] = "NOT EVALUABLE (0 flagged positives) = FAIL"
    else:
        res["c"] = "%s: suspect_lang accuracy %d/%d = %.3f (bar >= 0.80)" % ("PASS" if lang_ok / pos_k >= 0.80 else "FAIL", lang_ok, pos_k, lang_ok / pos_k)
    res["d"] = "%s: windows whose L0 reply minus the two keys != P's reply: %d of %d" % ("PASS" if ident_bad == 0 else "FAIL", ident_bad, E6_N)
    print("\nchecks: P segments carrying an L0 key = %d (must be 0); L0 flags on non-unit segments = %d (reported)" % (p_flags, offunit_flags))
    assert p_flags == 0, "P carries L0 keys: wrong arm"
    print("\nGATES (segment-level, as pre-registered; per-window rates above, N1):")
    for g in "abcd":
        print("  (%s) %s" % (g, res[g]))
    allpass = all(v.startswith("PASS") for v in res.values())
    print("\nL0 GATE 3: %s" % ("PASS" if allpass else "FAIL"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
