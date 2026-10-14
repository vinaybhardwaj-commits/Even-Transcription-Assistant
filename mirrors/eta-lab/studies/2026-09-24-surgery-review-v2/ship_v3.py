#!/usr/bin/env python3
"""ship_v3.py — assemble the FINAL v3 set for Fable to seed: ~/eta-data/surgery-review-v3/ship/{consults/<id>.json, audio/<id>/...} with NEUTRAL ids (V3-01.. in a seeded shuffle, so an id says nothing about
source, bucket or placement), audio paths rewritten, and a PRIVATE key (ship-key.json, 0600, never shared) that maps each id back to the working id, token and room-day. Nothing is seeded here.
usage: ship_v3.py <dir:id> [<dir:id> ...]   e.g. final:Q06 final-trim:Q29     (dir is under ~/eta-data/surgery-review-v3)"""
import hashlib, json, os, random, shutil, subprocess, sys
from build_v3 import earlier, BEFORE_S, AFTER_S

V3 = os.path.expanduser("~/eta-data/surgery-review-v3"); SHIP = os.environ.get("SHIP_DIR", "ship"); OUT = f"{V3}/{SHIP}"
KEYFILE = f"{V3}/ship-key.json" if SHIP == "ship" else f"{V3}/{SHIP}-key.json"  # a second bundle (ship-v4) never overwrites the verified v3 key


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def cut_window(enc_s, enc_e, total, pad_b=BEFORE_S, pad_a=AFTER_S):
    """The audio the page plays: the encounter plus the visible grey context (2 min each side, ruling 143), clamped to the recording. Returns (t0, t1) on the turn clock."""
    return max(0.0, enc_s - pad_b), min(total, enc_e + pad_a)


def dur(p):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p], capture_output=True, text=True).stdout)


def cut_audio(mp3, t0, t1, mp4):
    """Cut [t0, t1] from the whole-consult mp3: replaces mp3 in place (mono 16 kHz 32 kbps) and writes the AAC-in-MP4 twin (32 kbps, padded to the mp3's exact duration, +faststart)."""
    tmp = mp3 + ".cut.mp3"
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t0:.3f}", "-t", f"{t1 - t0:.3f}", "-i", mp3, "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", tmp], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[:200]
    os.replace(tmp, mp3); d = dur(mp3)
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", mp3, "-vn", "-ac", "1", "-ar", "16000", "-af", f"apad=whole_dur={d:.3f}", "-t", f"{d:.3f}", "-c:a", "aac", "-b:a", "32k", "-movflags", "+faststart", mp4], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[:200]
    os.chmod(mp3, 0o600); os.chmod(mp4, 0o600)
    return d, dur(mp4)


def selftest():
    assert KEYFILE.endswith("ship-key.json") == (SHIP == "ship"), "only the default bundle writes the v3 key file"
    assert cut_window(500, 900, 2000) == (380, 1020), "encounter +- 2 min"
    assert cut_window(60, 900, 2000) == (0.0, 1020), "clamped at the start of the recording"
    assert cut_window(500, 1950, 2000) == (380, 2000), "clamped at the end"
    assert cut_window(500, 900, 2000, 0, 0) == (500, 900), "no padding"
    print("ship_v3 selftest OK: cut window = encounter +- 2 min, clamped to the recording")


def main(specs):
    shutil.rmtree(OUT, ignore_errors=True)
    for d in (OUT, f"{OUT}/consults", f"{OUT}/audio"):
        os.makedirs(d, mode=0o700, exist_ok=True)
    order = list(specs); random.Random(24092026).shuffle(order)
    key, files = {}, {}
    sel = {}
    for f in ("selected.json", "selected_cand.json", "selected_cand2.json", "selected_trim.json"):
        if os.path.exists(f"{V3}/{f}"):
            sel.update(json.load(open(f"{V3}/{f}")))
    for n, spec in enumerate(order, 1):
        d, q = spec.split(":"); nid = f"V3-{n:02d}"
        doc = json.load(open(f"{V3}/{d}/consults/{q}.json"))
        doc["id"] = nid
        for t in doc["turns"]:
            t["audio"] = [a.replace(f"audio/{q}/", f"audio/{nid}/") for a in t["audio"]]
        doc["audio_full"]["src"] = doc["audio_full"]["src"].replace(f"audio/{q}/", f"audio/{nid}/")
        mt = doc.pop("meta", {})  # working facts (recall, probe counts) stay out of the shipped file ...
        doc["jev_wording"] = {"version": mt["wording"], "sha256": mt["wording_sha256"]}  # ... but WHICH frozen wording produced the answers is recorded (eta-refuter-2 #563)
        os.makedirs(f"{OUT}/audio/{nid}", mode=0o700)
        wanted = {"full.mp3"} | {os.path.basename(a) for t in doc["turns"] for a in t["audio"]}  # ONLY files the doc references (clips of an earlier scoring must not ride along)
        for fn in sorted(wanted):
            shutil.copy(f"{V3}/{d}/audio/{q}/{fn}", f"{OUT}/audio/{nid}/{fn}"); os.chmod(f"{OUT}/audio/{nid}/{fn}", 0o600)
        enc = doc["encounter"]; total = dur(f"{OUT}/audio/{nid}/full.mp3"); t0, t1 = cut_window(enc["start_s"], enc["end_s"], total)
        os.makedirs(f"{OUT}/mp4", mode=0o700, exist_ok=True)
        d_mp3, d_mp4 = cut_audio(f"{OUT}/audio/{nid}/full.mp3", t0, t1, f"{OUT}/mp4/{nid}.mp4")
        assert abs(d_mp3 - (t1 - t0)) < 0.2 and abs(d_mp3 - d_mp4) <= 0.1, (nid, d_mp3, d_mp4, t1 - t0)
        doc["audio_full"] = {"src": doc["audio_full"]["src"], "t0_s": round(t0, 2), "duration_s": round(d_mp3, 1)}  # turn start_s is unchanged: t0_s says which turn second the clip's second 0 is
        for t in doc["turns"]:
            if "phase" in t:
                t.pop("earlier", None)
                if earlier(t, enc["start_s"], enc["end_s"]):
                    t["earlier"] = True
        p = f"{OUT}/consults/{nid}.json"; json.dump(doc, open(p, "w"), ensure_ascii=False, indent=1); os.chmod(p, 0o600)
        key[nid] = {"working_id": q, "dir": d, "token_uid": sel.get(q, {}).get("token_uid"), "room_day_id": sel.get(q, {}).get("room_day_id")}
        raw = open(p).read()
        assert not any(v and v in raw for v in (key[nid]["token_uid"], key[nid]["room_day_id"])), "a private id leaked into a shipped file"
        for t in doc["turns"]:
            for a in t["audio"]:
                assert os.path.exists(f"{OUT}/{a}"), a
        assert os.path.exists(f"{OUT}/{doc['audio_full']['src']}")
        on_disk = set(os.listdir(f"{OUT}/audio/{nid}")); assert on_disk == wanted, f"{nid}: files on disk differ from the doc's references: {sorted(on_disk ^ wanted)[:5]}"
        files[nid] = {"consult_sha256": sha(p), "full_audio_sha256": sha(f"{OUT}/{doc['audio_full']['src']}"), "mp4_sha256": sha(f"{OUT}/mp4/{nid}.mp4"), "jev_wording": doc["jev_wording"], "audio_t0_s": doc["audio_full"]["t0_s"], "audio_duration_s": doc["audio_full"]["duration_s"], "clips": sum(1 for t in doc["turns"] if t["audio"])}
    json.dump(key, open(KEYFILE, "w"), indent=1); os.chmod(KEYFILE, 0o600)
    json.dump(files, open(f"{OUT}/manifest.json", "w"), indent=1); os.chmod(f"{OUT}/manifest.json", 0o600)
    mb = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(OUT) for f in fs) / 1e6
    print("shipped", len(order), "consults ->", OUT, "|", round(mb, 1), "MB | ids", ", ".join(sorted(files)))


if __name__ == "__main__":
    selftest() if sys.argv[1:] == ["--selftest"] else main(sys.argv[1:])
