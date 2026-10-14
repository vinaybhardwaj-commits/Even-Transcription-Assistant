"""DIAG-RIG scorer: joins truth.json (the ONLY reference) with injector results into one nightly report.
Metrics: word hit rate / WER / CER per language, canary hit, language-ID accuracy, speaker-count error + DER, silence detection
(reference detector time-to-detect + false alarms; STT text inside silence), noise robustness deltas per SNR. Reports carry ids,
counts and metrics only: NO transcript text. Production path is scored; offline models appear only as `shadow` engine columns."""
import itertools
import json
import os
import re
import sys
import time
import unicodedata

import wavio

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mic-selftest"))
from mic_selftest import fuzzy_canary   # noqa: E402  (canary matcher reused verbatim; phonetic skeleton + transliteration)

LANG_NAMES = {"english": "en", "hindi": "hi", "kannada": "kn", "telugu": "te", "tamil": "ta"}


def lang_iso(v):
    """whisper verbose_json returns full names ('kannada'), the router ISO codes; both -> 2-letter code."""
    v = (v or "").strip().lower()
    return LANG_NAMES.get(v, v[:2])


_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)


def norm(t):
    t = unicodedata.normalize("NFKC", t or "").lower()
    t = _PUNCT.sub(" ", t.replace("_", " "))
    return re.sub(r"\s+", " ", t).strip()


def _edit(a, b):
    """Levenshtein distance over sequences."""
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def _lcs(a, b):
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b, 1):
            cur.append(prev[j - 1] + 1 if x == y else max(prev[j], cur[j - 1]))
        prev = cur
    return prev[-1]


def text_scores(ref, hyp):
    r, h = norm(ref).split(), norm(hyp).split()
    if not r:
        return None
    e = _edit(r, h)
    rc, hc = norm(ref).replace(" ", ""), norm(hyp).replace(" ", "")
    return dict(wer=round(e / len(r), 4), hit_rate=round(_lcs(r, h) / len(r), 4), cer=round(_edit(rc, hc) / max(1, len(rc)), 4), ref_words=len(r))


# ------------------------------------------------------------------ diarization
def der(ref_turns, hyp_segs, dur_s, frame=0.01, collar=0.25):
    """Frame DER with optimal speaker mapping; frames within `collar` of a reference boundary are ignored. ref_turns: [(spk,a,b)], hyp: [(spk,a,b)]."""
    n = int(dur_s / frame) + 1
    ref = [None] * n
    for s, a, b in ref_turns:
        for i in range(int(a / frame), min(n, int(b / frame))):
            ref[i] = s
    hyp = [set() for _ in range(n)]
    for s, a, b in hyp_segs:
        if a is None or b is None:
            continue
        for i in range(int(a / frame), min(n, int(b / frame))):
            hyp[i].add(s)
    skip = [False] * n
    for _s, a, b in ref_turns:
        for t in (a, b):
            for i in range(max(0, int((t - collar) / frame)), min(n, int((t + collar) / frame) + 1)):
                skip[i] = True
    rs = sorted({s for s, _, _ in ref_turns})
    hs = sorted({s for s, _, _ in hyp_segs})
    best = None
    pad = hs + [None] * max(0, len(rs) - len(hs))
    for perm in itertools.permutations(pad, len(rs)):
        m = {h: r for r, h in zip(rs, perm) if h is not None}
        miss = fa = conf = sp = 0
        for i in range(n):
            if skip[i]:
                continue
            hy = {m.get(h) for h in hyp[i]}   # unmapped hyp speakers -> None (always wrong)
            if ref[i] is not None:
                sp += 1
                if not hyp[i]:
                    miss += 1
                elif ref[i] not in hy:
                    conf += 1
            elif hyp[i]:
                fa += 1
        if best is None or miss + fa + conf < best[0]:
            best = (miss + fa + conf, miss, fa, conf, sp)
    if not best or best[4] == 0:
        return None
    e, miss, fa, conf, sp = best
    return dict(der=round(e / sp, 4), miss=round(miss / sp, 4), false_alarm=round(fa / sp, 4), confusion=round(conf / sp, 4))


# ------------------------------------------------------------------ silence
def detect_silence(x, sr=wavio.SR, frame=0.1, dead_rms=10 ** (-70 / 20), min_s=2.0):
    """Reference dead-input detector: runs of >= min_s seconds with frame RMS <= dead_rms. -> [(start_s, end_s, detected_at_s)]"""
    n = int(sr * frame)
    flags = [wavio.rms(x[i:i + n]) <= dead_rms for i in range(0, len(x) - n + 1, n)]
    runs, i = [], 0
    while i < len(flags):
        if flags[i]:
            j = i
            while j < len(flags) and flags[j]:
                j += 1
            if (j - i) * frame >= min_s:
                runs.append((i * frame, j * frame, i * frame + min_s))
            i = j
        else:
            i += 1
    return runs


def score_silence(truth, wav_path, result):
    """Two separate things. `rig_selfcheck` runs the reference dead-input detector on the rig's OWN wav: it proves the stimulus and detector
    agree and says NOTHING about the target. `target` looks only at what the target returned inside the silence intervals."""
    x, _ = wavio.read_wav(wav_path)
    runs = detect_silence(x)
    chk = dict(events=0, detected=0, ttd_s=[], false_alarms=0)
    zero = [e for e in truth["events"] if e["type"] == "silence_zero"]
    sil = [e for e in truth["events"] if e["type"].startswith("silence")]
    for e in zero:
        chk["events"] += 1
        a = e["start_ms"] / 1000
        hit = [r for r in runs if abs(r[0] - a) <= 0.3]
        if hit:
            chk["detected"] += 1
            chk["ttd_s"].append(round(hit[0][2] - a, 2))
    for r in runs:
        if not any(e["start_ms"] / 1000 - 0.3 <= r[0] <= e["end_ms"] / 1000 for e in sil):
            chk["false_alarms"] += 1
    eng = (result or {}).get("engines", {})
    tgt = dict(stt="not_run", stt_text_in_silence=None, diarizer="not_run", diarizer_speech_in_silence=None)

    def inside(t):
        return t is not None and any(e["start_ms"] / 1000 <= t < e["end_ms"] / 1000 for e in sil)
    st = eng.get("stt")
    if st is not None:
        tgt["stt"] = "ok" if st.get("ok") else "failed"
        if st.get("ok"):
            tgt["stt_text_in_silence"] = sum(1 for s in st.get("segments", []) if norm(s.get("text")) and inside(s.get("start_s")))
    dz = eng.get("diarizer")
    if dz is not None:
        tgt["diarizer"] = "ok" if dz.get("ok") else "failed"
        if dz.get("ok"):
            tgt["diarizer_speech_in_silence"] = sum(1 for s in dz.get("speaker_segments", []) if inside(s.get("start_s")))
    return dict(rig_selfcheck=chk, target=tgt)


# ------------------------------------------------------------------ per stimulus + report
def truth_text(truth):
    return " ".join(e["text"] for e in truth["events"] if e["type"] in ("turn", "canary"))


def score_stimulus(truth, result, wav_path=None):
    r = dict(stimulus_id=truth["stimulus_id"], kind=truth["kind"])
    if truth["kind"] in ("dialogue", "noisy_dialogue", "canary"):
        langs = sorted({e["lang"] for e in truth["events"] if "lang" in e})
        r["lang"] = langs[0] if len(langs) == 1 else "+".join(langs)
    eng = (result or {}).get("engines", {})
    stt, dz = eng.get("stt"), eng.get("diarizer")
    if truth["kind"] in ("dialogue", "noisy_dialogue", "canary"):
        if stt is None:
            r["stt"] = "not_run"
        elif not stt.get("ok"):
            r["stt"] = "failed"
        else:
            r["stt"] = "ok"
            r["text"] = text_scores(truth_text(truth), stt.get("text", ""))
            base = (r["lang"] or "").split("+")[0].split("-")[0]
            if stt.get("language"):
                r["lang_id_ok"] = lang_iso(stt["language"]) == base
            if truth["kind"] == "canary":
                hit, ratio = fuzzy_canary(stt.get("text", ""))
                r["canary_hit"], r["canary_ratio"] = bool(hit), ratio
        sh = eng.get("shadow_sravaani")            # shadow column: NOT the production path
        if sh is not None:
            r["shadow_sravaani"] = "ok" if sh.get("ok") else "failed"
            if sh.get("ok"):
                r["shadow_text"] = text_scores(truth_text(truth), sh.get("text", ""))
        turns = [e for e in truth["events"] if e["type"] == "turn"]
        if turns and dz is not None:
            if not dz.get("ok"):
                r["diarizer"] = "failed"
            else:
                segs = [(s["speaker"], s["start_s"], s["end_s"]) for s in dz["speaker_segments"]]
                ref = [(e["speaker"], e["start_ms"] / 1000, e["end_ms"] / 1000) for e in turns]
                r["diarizer"] = "ok"
                r["speakers_true"], r["speakers_hyp"] = len({t[0] for t in ref}), len({s[0] for s in segs})
                r["speaker_count_err"] = r["speakers_hyp"] - r["speakers_true"]
                r["der"] = der(ref, segs, truth["duration_s"])
    if truth["kind"] == "silence" and wav_path:
        r["silence"] = score_silence(truth, wav_path, result)
    for k in ("bed", "snr_db", "base"):
        if k in truth:
            r[k] = truth[k]
    return r


def _mean(v):
    v = [x for x in v if x is not None]
    return round(sum(v) / len(v), 4) if v else None


def _bucket():
    return dict(shadow_hit=[], shadow_failed=0, shadow_attempted=0, n_attempted=0, n_ok=0, n_failed=0, n_no_result=0, wer=[], hit=[], cer=[], lang_id=[], der=[], count_err=[],
                diar_attempted=0, diar_failed=0)


def build_report(suite_dir, results_dir, machine, target_sha=None):
    man = wavio.jload(os.path.join(suite_dir, "suite.json"))
    rows = []
    for it in man["items"]:
        sid = it["stimulus_id"]
        truth = wavio.jload(os.path.join(suite_dir, sid + ".truth.json"))
        rp = os.path.join(results_dir, sid + ".result.json")
        res = wavio.jload(rp) if os.path.exists(rp) else None
        row = score_stimulus(truth, res, os.path.join(suite_dir, sid + ".wav"))
        if res is None and row["kind"] in ("dialogue", "noisy_dialogue", "canary"):
            row["stt"] = "no_result"
        rows.append(row)
    buckets = {}
    for r in rows:
        if r["kind"] not in ("dialogue", "canary") or "lang" not in r:
            continue
        b = buckets.setdefault("canary" if r["kind"] == "canary" else r["lang"], _bucket())
        b["n_attempted"] += 1
        st = r.get("stt")
        if st == "ok":
            b["n_ok"] += 1
            if r.get("text"):
                b["wer"].append(r["text"]["wer"]); b["hit"].append(r["text"]["hit_rate"]); b["cer"].append(r["text"]["cer"])
            if "lang_id_ok" in r:
                b["lang_id"].append(1.0 if r["lang_id_ok"] else 0.0)
        elif st == "failed":
            b["n_failed"] += 1
        elif st == "no_result":
            b["n_no_result"] += 1
        if r.get("shadow_sravaani") == "ok" and r.get("shadow_text"):
            b["shadow_hit"].append(r["shadow_text"]["hit_rate"])
        elif r.get("shadow_sravaani") == "failed":
            b["shadow_failed"] += 1
        if r.get("shadow_sravaani") is not None:
            b["shadow_attempted"] += 1
        if r["kind"] == "dialogue" and r.get("diarizer") is not None:
            b["diar_attempted"] += 1
            if r["diarizer"] == "failed":
                b["diar_failed"] += 1
            elif r.get("der"):
                b["der"].append(r["der"]["der"]); b["count_err"].append(abs(r["speaker_count_err"]))

    def stats(b):
        nat = b["n_attempted"]
        return dict(n_attempted=nat, n_ok=b["n_ok"], n_failed=b["n_failed"], n_no_result=b["n_no_result"],
                    wer=_mean(b["wer"]), hit_rate=_mean(b["hit"]), cer=_mean(b["cer"]), lang_id_acc=_mean(b["lang_id"]),
                    hit_rate_incl_failures=round(sum(b["hit"]) / nat, 4) if nat else None,     # failed/no-result stimuli count as 0
                    shadow_sravaani_hit_rate=_mean(b["shadow_hit"]), shadow_sravaani_failed=b["shadow_failed"], shadow_sravaani_attempted=b["shadow_attempted"],
                    diarizer_attempted=b["diar_attempted"], diarizer_failed=b["diar_failed"],
                    der=_mean(b["der"]), abs_speaker_count_err=_mean(b["count_err"]))
    languages = {k: stats(v) for k, v in sorted(buckets.items()) if k != "canary"}
    cb = buckets.get("canary") or _bucket()
    canary_rows = [r for r in rows if r["kind"] == "canary"]
    canary = dict(n=len(canary_rows), hits=sum(1 for r in canary_rows if r.get("canary_hit")),
                  failed=sum(1 for r in canary_rows if r.get("stt") in ("failed", "no_result")))   # a failed canary is a MISS
    sil = [r["silence"] for r in rows if "silence" in r]
    silence = dict(
        rig_selfcheck=dict(events=sum(s["rig_selfcheck"]["events"] for s in sil), detected=sum(s["rig_selfcheck"]["detected"] for s in sil),
                           false_alarms=sum(s["rig_selfcheck"]["false_alarms"] for s in sil), ttd_s=[t for s in sil for t in s["rig_selfcheck"]["ttd_s"]],
                           note="reference detector on the rig's own wav: NOT a target metric"),
        target=dict(stt=sorted({s["target"]["stt"] for s in sil}), diarizer=sorted({s["target"]["diarizer"] for s in sil}),
                    stt_text_in_silence=sum(s["target"]["stt_text_in_silence"] or 0 for s in sil),
                    diarizer_speech_in_silence=sum(s["target"]["diarizer_speech_in_silence"] or 0 for s in sil)))
    clean = {r["stimulus_id"]: r for r in rows if r.get("kind") == "dialogue"}
    robust = {}
    for r in rows:
        if r.get("kind") == "noisy_dialogue" and r.get("stt") in ("failed", "no_result") and r.get("base") in clean:
            robust["%s@%s/%+d" % (r["base"], r["bed"], r["snr_db"])] = dict(failed=r["stt"], d_hit_rate=None, d_der=None)   # visible, not dropped
        elif r.get("kind") == "noisy_dialogue" and r.get("text") and clean.get(r["base"], {}).get("text"):
            robust["%s@%s/%+d" % (r["base"], r["bed"], r["snr_db"])] = dict(
                d_hit_rate=round(r["text"]["hit_rate"] - clean[r["base"]]["text"]["hit_rate"], 4),
                d_der=None if not (r.get("der") and clean[r["base"]].get("der")) else round(r["der"]["der"] - clean[r["base"]]["der"]["der"], 4))
    scored = [r for r in rows if r["kind"] in ("dialogue", "noisy_dialogue", "canary")]
    diar_rows = [r for r in rows if r.get("diarizer") is not None]
    health = dict(stt_attempted=len(scored), stt_ok=sum(1 for r in scored if r.get("stt") == "ok"),
                  stt_failed=sum(1 for r in scored if r.get("stt") == "failed"), stt_no_result=sum(1 for r in scored if r.get("stt") == "no_result"),
                  stt_not_run=sum(1 for r in scored if r.get("stt") == "not_run"),
                  diarizer_attempted=len(diar_rows), diarizer_failed=sum(1 for r in diar_rows if r["diarizer"] == "failed"))
    return dict(
        report="diag-rig", machine=machine, ts_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), suite=man["suite"],
        suite_manifest_sha256=wavio.sha256_file(os.path.join(suite_dir, "suite.json")),
        phraseset_sha=man["phraseset_sha"], rig_git=man.get("rig_git"), target_sha=target_sha, tts_mode=man.get("tts_mode"),
        synthetic_fallback_voices=man.get("tts_mode") == "fake",
        health=health, languages=languages, canary=canary, silence=silence, robustness=robust, stimuli=rows)


def report_md(rep):
    h = rep["health"]
    L = ["DIAG-RIG %s %s (%s) rig %s target %s" % (rep["suite"], rep["ts_utc"], rep["machine"], rep["rig_git"], rep["target_sha"])]
    bad = h["stt_failed"] + h["stt_no_result"] + h["diarizer_failed"]
    L.append("HEALTH stt ok %d/%d (failed %d, no_result %d, not_run %d); diarizer failed %d/%d%s" % (
        h["stt_ok"], h["stt_attempted"], h["stt_failed"], h["stt_no_result"], h["stt_not_run"], h["diarizer_failed"], h["diarizer_attempted"],
        "   !! TARGET FAILURES: metrics below cover only the calls that answered" if bad else ""))
    if rep["synthetic_fallback_voices"]:
        L.append("!! synthetic fallback voices (not speech): text metrics are meaningless in this run")
    for k, v in rep["languages"].items():
        L.append("%-6s ok %d/%d hit=%s (incl failures %s) wer=%s cer=%s langid=%s der=%s cnt_err=%s | shadow SraVaani ok %d/%d hit=%s" % (
            k, v["n_ok"], v["n_attempted"], v["hit_rate"], v["hit_rate_incl_failures"], v["wer"], v["cer"], v["lang_id_acc"], v["der"], v["abs_speaker_count_err"], v["shadow_sravaani_attempted"] - v["shadow_sravaani_failed"], v["shadow_sravaani_attempted"], v["shadow_sravaani_hit_rate"]))
    c = rep["canary"]
    L.append("canary hits %d/%d (failed calls %d count as misses)" % (c["hits"], c["n"], c["failed"]))
    sc, st = rep["silence"]["rig_selfcheck"], rep["silence"]["target"]
    L.append("silence TARGET: stt %s text_in_silence %d, diarizer %s speech_in_silence %d | rig self-check (not the target): detected %d/%d false_alarms %d" % (
        ",".join(st["stt"]), st["stt_text_in_silence"], ",".join(st["diarizer"]), st["diarizer_speech_in_silence"], sc["detected"], sc["events"], sc["false_alarms"]))
    if rep["robustness"]:
        L.append("robustness d_hit_rate: " + ", ".join("%s %s" % (k, "FAILED" if v.get("failed") else "%+.2f" % v["d_hit_rate"]) for k, v in rep["robustness"].items()))
    return "\n".join(L)
