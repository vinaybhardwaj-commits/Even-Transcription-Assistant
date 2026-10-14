#!/usr/bin/env python3
"""W45.2 synthetic emotion validation suite. See DESIGN.md for the pre-registered pass bar.

Reuses kit/diag-rig's tts.py (ElevenLabs backend, sha256-cached, shared 60k-char ledger) and
clinical.py's approved invented clinical lines. Adds two things diag-rig doesn't have: emotion-
delivery control (eleven_v3 audio tags, forced for ALL six languages via DIAGRIG_EL_V3_LANGS so
the control mechanism isn't a second confound alongside language) and a wavlm scoring client
(POST to the box emotion replica's single-clip /inference/wavlm, no auth needed for that path).

The "room-acoustic version" is a SOFTWARE PROXY, not the physical SELFTEST rig (no room commands
are used or permitted from here): a parallel-comb reverb tail matched to a room's measured
RT60 (blind estimate, studies/2026-09-27-room-acoustics), plus a diag-rig noise bed mixed at that
room's measured median SNR. It approximates smearing/noise, not a real impulse response.

Usage:
  python3 emotion_suite.py generate --tts fake --cache /tmp/smoke-cache --out /tmp/smoke-stimuli
  python3 emotion_suite.py score --stimuli DIR --url http://127.0.0.1:8086/inference/wavlm --out results.json
  python3 emotion_suite.py report --stimuli DIR --results results.json
"""
import argparse
import json
import math
import os
import random
import sys
import time
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
DIAGRIG = os.path.normpath(os.path.join(HERE, "..", "..", "kit", "diag-rig"))
sys.path.insert(0, DIAGRIG)
import clinical  # noqa: E402
import tts       # noqa: E402
import wavio      # noqa: E402

LANGS = ("en", "hi", "kn", "ta", "te", "ml")
EMOTIONS = ("neutral", "calm", "anxious", "angry", "sad", "happy")
# Bracketed v3 audio tags (verified against ElevenLabs' own prompting docs, 27 Sep 2026); neutral = no tag (baseline delivery).
TAG = {"neutral": "", "calm": "[calmly] ", "anxious": "[nervous] ", "angry": "[angry] ", "sad": "[sad] ", "happy": "[happy] "}
# Requested delivery -> acceptable wavlm output label(s). The model (Aniemore/wavlm-emotion-v1-crosslingual) has 7 labels:
# anger, disgust, enthusiasm, fear, happiness, neutral, sadness. It has no "calm" concept, so calm's only honest target is
# neutral (this suite can only ask whether calm delivery avoids the OTHER emotion labels, not whether calm reads as distinct
# from neutral - pre-registered as a known ceiling, not something to quietly redefine after seeing results). "happy" accepts
# either happiness or enthusiasm since both are plausible readings of a clinical reassurance line's cheerful delivery.
ACCEPT = {
    "neutral": {"neutral"},
    "calm": {"neutral"},
    "anxious": {"fear"},
    "angry": {"anger"},
    "sad": {"sadness"},
    "happy": {"happiness", "enthusiasm"},
}
ALL_MODEL_LABELS = ("anger", "disgust", "enthusiasm", "fear", "happiness", "neutral", "sadness")
CASE0_DX = "diabetes"
CASE0_DAYS = 10
SPEAKER = "S1"


def clinical_lines():
    """-> {lang: {"doctor": text, "patient": text}}. Same two fixed (two-sentence) lines per language across all 6
    emotions. Two sentences, not one: a single short frame line (~1.1-1.4 s of speech measured on the real clips)
    fell under the box emotion service's min_speech_s=1.5 s gate and came back insufficient_speech on every clip -
    found by running the suite for real, not assumed. Concatenating two consecutive, role-consistent frame lines
    (doctor: diagnosis + investigation; patient: complaint + the confirm line) clears the gate with margin."""
    out = {}
    for lang in LANGS:
        f = clinical.FRAMES[lang]
        doctor = f["dx"].format(dx=CASE0_DX) + " " + f["inv"].format(inv="HbA1c test")
        patient = f["pt"].format(days=CASE0_DAYS) + " " + f["confirm"].format(d1="Metformin", q1="500 mg")
        out[lang] = {"doctor": doctor, "patient": patient}
    return out


# ------------------------------------------------------------------------------------------------ generate
def generate(backend, cache_dir, out_dir, seed=1234):
    os.environ["DIAGRIG_EL_V3_LANGS"] = ",".join(LANGS)   # force eleven_v3 for ALL langs: one control mechanism, not two
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    t = tts.Tts(backend, cache_dir, seed=seed)
    lines = clinical_lines()
    manifest = []
    for lang in LANGS:
        for role, base_text in lines[lang].items():
            for emo in EMOTIONS:
                text = TAG[emo] + base_text
                x, meta = t.clip(lang, SPEAKER, text)
                fname = "%s_%s_%s.wav" % (lang, role, emo)
                path = os.path.join(out_dir, fname)
                sha = wavio.write_wav(path, wavio.fade(x))
                os.chmod(path, 0o600)
                manifest.append(dict(lang=lang, role=role, emotion=emo, file=fname, wav_sha256=sha, chars=len(text),
                                      **{k: v for k, v in meta.items() if k not in ("audio_sha256", "lang")}))
    man_path = os.path.join(out_dir, "manifest.json")
    with open(man_path, "w") as f:
        json.dump(dict(suite="tone-emotion-validate", backend=backend, seed=seed, items=manifest), f, indent=1)
    os.chmod(man_path, 0o600)
    return manifest


# ------------------------------------------------------------------------------------------------ room-acoustic proxy
def schroeder_reverb(x, rt60_s, sr=16000, delays_ms=(29.7, 37.1, 41.1, 43.7), wet=0.35):
    """Parallel feedback combs, gain per comb set so each decays 60 dB over rt60_s. A documented PROXY for a measured
    room impulse response, not one - see module docstring. O(len(x)) per comb, fine in pure Python for a few seconds."""
    wet_sum = [0.0] * len(x)
    for dms in delays_ms:
        d = max(1, int(sr * dms / 1000))
        g = 10 ** (-3.0 * d / (rt60_s * sr))
        buf = [0.0] * d
        for n, v in enumerate(x):
            i = n % d
            y = v + g * buf[i]
            wet_sum[n] += y
            buf[i] = y
    k = 1.0 / len(delays_ms)
    return [(1 - wet) * d + wet * (w * k) for d, w in zip(x, wet_sum)]


def load_room_profiles(path="/home/eta/eta-data/acoustics/room-profiles-2026-09-27.json"):
    with open(path) as f:
        d = json.load(f)
    return {p["room"]: p for p in d["profiles"]}


def room_variant(x, profile, seed=1234):
    rt60 = profile["rt60_blind"]["median_s"]
    snr = profile["snr_db"]["median"]
    y = schroeder_reverb(x, rt60)
    noise = wavio.bed("fan", len(y) / 16000.0, seed=seed)
    return wavio.mix_at_snr(y, noise, snr)


def generate_room_variants(manifest, stim_dir, out_dir, rooms):
    """rooms: list of (room_name, profile) pairs to apply. Reads clean wavs already in stim_dir; writes new files, extends manifest."""
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    extra = []
    for item in manifest:
        x, sr = wavio.read_wav(os.path.join(stim_dir, item["file"]))
        for room_name, profile in rooms:
            y = room_variant(x, profile)
            fname = "room-%s_%s" % (room_name.lower().replace(" ", ""), item["file"])
            path = os.path.join(out_dir, fname)
            sha = wavio.write_wav(path, y)
            os.chmod(path, 0o600)
            extra.append(dict(item, file=fname, wav_sha256=sha, room=room_name,
                               room_rt60_s=profile["rt60_blind"]["median_s"], room_snr_db=profile["snr_db"]["median"]))
    return extra


# ------------------------------------------------------------------------------------------------ score
def _multipart(files):
    b = uuid.uuid4().hex
    body = b""
    for k, (fn, data, ct) in files.items():
        body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\nContent-Type: %s\r\n\r\n" % (b, k, fn, ct)).encode() + data + b"\r\n"
    body += ("--%s--\r\n" % b).encode()
    return body, "multipart/form-data; boundary=" + b


def score_clip(url, wav_path, timeout=30):
    with open(wav_path, "rb") as f:
        raw = f.read()
    body, ct = _multipart({"file": (os.path.basename(wav_path), raw, "audio/wav")})
    req = urllib.request.Request(url, data=body, headers={"Content-Type": ct}, method="POST")
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw_resp = resp.read()
    return json.loads(raw_resp), time.time() - t0


def score_all(stim_dir, manifest, url, sleep_s=0.05):
    results = []
    for item in manifest:
        path = os.path.join(stim_dir, item["file"])
        try:
            body, latency_s = score_clip(url, path)
        except Exception as e:  # noqa: BLE001 - a failed call is a scored miss, not a crash (diag-rig convention)
            results.append(dict(file=item["file"], ok=False, error=repr(e)))
            continue
        results.append(dict(file=item["file"], ok=bool(body.get("ok")), unscorable=bool(body.get("unscorable")),
                             skip_reason=body.get("skip_reason"), labels=body.get("labels", {}),
                             top=body.get("top", []), latency_s=round(latency_s, 3)))
        time.sleep(sleep_s)   # LOW priority per Fable 13:20: this is small, but stay polite to the shared queue
    return results


# ------------------------------------------------------------------------------------------------ report (pre-registered pass bar)
def build_report(manifest, results):
    by_file = {r["file"]: r for r in results}
    cells = {}   # (lang, emotion, condition) -> list of per-item verdicts
    confusion = {}  # lang -> {requested: {top_label: n}}
    for item in manifest:
        r = by_file.get(item["file"])
        cond = "room" if "room" in item else "clean"
        key = (item["lang"], item["emotion"], cond)
        cells.setdefault(key, []).append(r)
        confusion.setdefault(item["lang"], {}).setdefault(item["emotion"], {})
        if r and r.get("ok") and not r.get("unscorable") and r.get("top"):
            top_label = r["top"][0]["label"]
            confusion[item["lang"]][item["emotion"]][top_label] = confusion[item["lang"]][item["emotion"]].get(top_label, 0) + 1
        else:
            reason = "unscorable:%s" % (r.get("skip_reason") if r else "no_result")
            confusion[item["lang"]][item["emotion"]][reason] = confusion[item["lang"]][item["emotion"]].get(reason, 0) + 1

    verdicts = {}
    for (lang, emo, cond), rs in cells.items():
        n = len(rs)
        scorable = [r for r in rs if r and r.get("ok") and not r.get("unscorable") and r.get("top")]
        unscorable_share = 1 - (len(scorable) / n if n else 0)
        accept = ACCEPT[emo]
        hits = sum(1 for r in scorable if r["top"][0]["label"] in accept)
        mean_accept = mean_other = None
        if scorable:
            mean_accept = sum(max(r["labels"].get(l, 0.0) for l in accept) for r in scorable) / len(scorable)
            others = [l for l in ALL_MODEL_LABELS if l not in accept]
            mean_other = max(sum(r["labels"].get(l, 0.0) for r in scorable) / len(scorable) for l in others) if others else 0.0
        reliable = (unscorable_share <= 0.5 and n and hits >= max(1, math.ceil(0.5 * n) + 1) and
                    mean_accept is not None and mean_accept >= (mean_other or 0))
        verdicts[f"{lang}/{emo}/{cond}"] = dict(n=n, scorable=len(scorable), hits=hits, unscorable_share=round(unscorable_share, 2),
                                                 mean_accept_score=round(mean_accept, 3) if mean_accept is not None else None,
                                                 mean_best_other_score=round(mean_other, 3) if mean_other is not None else None,
                                                 reliable=bool(reliable))
    return dict(verdicts=verdicts, confusion=confusion)


def report_md(rep):
    lines = ["| lang/emotion/condition | n | scorable | hits | unscorable_share | mean_accept | mean_best_other | reliable |",
             "|---|---:|---:|---:|---:|---:|---:|---|"]
    for k in sorted(rep["verdicts"]):
        v = rep["verdicts"][k]
        lines.append("| %s | %d | %d | %d | %.2f | %s | %s | %s |" % (
            k, v["n"], v["scorable"], v["hits"], v["unscorable_share"], v["mean_accept_score"], v["mean_best_other_score"],
            "YES" if v["reliable"] else "no"))
    return "\n".join(lines)


# ------------------------------------------------------------------------------------------------ CLI
def main(argv=None):
    p = argparse.ArgumentParser(prog="emotion_suite")
    sub = p.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("generate")
    g.add_argument("--tts", default="fake", choices=["fake", "elevenlabs"])
    g.add_argument("--cache", required=True)
    g.add_argument("--out", required=True)

    rm = sub.add_parser("room")
    rm.add_argument("--stimuli", required=True)
    rm.add_argument("--out", required=True)
    rm.add_argument("--rooms", default="OPD 1", help="comma-separated room names from the profile file")
    rm.add_argument("--profiles", default="/home/eta/eta-data/acoustics/room-profiles-2026-09-27.json")

    sc = sub.add_parser("score")
    sc.add_argument("--stimuli", required=True)
    sc.add_argument("--url", default="http://127.0.0.1:8086/inference/wavlm")
    sc.add_argument("--out", required=True)
    sc.add_argument("--sleep", type=float, default=0.05)

    rp = sub.add_parser("report")
    rp.add_argument("--stimuli", required=True)
    rp.add_argument("--results", required=True)
    rp.add_argument("--json")

    a = p.parse_args(argv)

    if a.cmd == "generate":
        manifest = generate(a.tts, a.cache, a.out)
        print(json.dumps(dict(n=len(manifest), chars=sum(i["chars"] for i in manifest))))
    elif a.cmd == "room":
        with open(os.path.join(a.stimuli, "manifest.json")) as f:
            manifest = json.load(f)["items"]
        profiles = load_room_profiles(a.profiles)
        rooms = [(name, profiles[name]) for name in a.rooms.split(",")]
        extra = generate_room_variants(manifest, a.stimuli, a.out, rooms)
        man_path = os.path.join(a.out, "manifest.json")
        with open(man_path, "w") as f:
            json.dump(dict(suite="tone-emotion-validate-room", items=extra), f, indent=1)
        os.chmod(man_path, 0o600)
        print(json.dumps(dict(n=len(extra))))
    elif a.cmd == "score":
        with open(os.path.join(a.stimuli, "manifest.json")) as f:
            manifest = json.load(f)["items"]
        results = score_all(a.stimuli, manifest, a.url, sleep_s=a.sleep)
        with open(a.out, "w") as f:
            json.dump(results, f, indent=1)
        os.chmod(a.out, 0o600)
        n_ok = sum(1 for r in results if r.get("ok"))
        print(json.dumps(dict(n=len(results), ok=n_ok)))
    elif a.cmd == "report":
        with open(os.path.join(a.stimuli, "manifest.json")) as f:
            manifest = json.load(f)["items"]
        with open(a.results) as f:
            results = json.load(f)
        rep = build_report(manifest, results)
        if a.json:
            with open(a.json, "w") as f:
                json.dump(rep, f, indent=1)
            os.chmod(a.json, 0o600)
        print(report_md(rep))


if __name__ == "__main__":
    main()
