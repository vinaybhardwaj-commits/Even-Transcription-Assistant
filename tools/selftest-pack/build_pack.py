#!/usr/bin/env python3
"""Build stimulus pack `selftest-room-v3` for Room Recorder's self_test (see validate_pack.py for what the app's loader requires).

  build_pack.py --out DIR [--phrases phrases.json] [--dry-run] [--ledger-dir DIR]

Files (16 kHz mono s16 WAV, the format AVAudioPlayer is handed): tone-1k (1 kHz), sweep (100 Hz -> 7.8 kHz log; 8 kHz is the Nyquist of 16 kHz),
canary-1 and 8 phrases (bulbul:v3 through the Even gateway, then ffmpeg). IDEMPOTENT: a TTS file that exists with the sha recorded in `.tts-cache.json`
for the same (text, lang, speaker, model, pace) is reused and NO paid call is made. One sarvam.call.v1 line per paid call is appended to
<ledger-dir>/<ist_date>.jsonl (upload to R2 eta-lab-results sarvam/ledger/scribe-mcp/ by APPENDING to that day's object, never overwriting; the lane file beside it is lanes/sarvam-scribe-mcp.json). --dry-run uses a fake TTS (no network, no key, no ledger in the real folder).
ENV for a real run: SARVAM_SA_KEY_PATH SARVAM_GW_AUDIENCE SARVAM_GW_ROLE_ARN SARVAM_GW_BASE_URL SARVAM_GW_REGION; ffmpeg on PATH. Nothing is printed from them.
"""
import argparse
import datetime
import hashlib
import io
import json
import math
import os
import shutil
import socket
import struct
import subprocess
import sys
import time
import uuid
import wave

import validate_pack as V

PACK_NAME = "selftest-room-v3"
RATE = V.RATE
CALLER = "scribe-mcp"  # ledger/lane caller per usage contract v1.1 (this pack is a scribe-mcp synthetic voice test)
# Only these answers prove the gateway did NOT generate (or bill) audio, so only they are retried: 429 throttled, 503 unavailable. A timeout, a network error or any
# other 5xx may have been billed: never retried blindly (a rerun pays only for what is missing).
RETRY_STATUSES = (429, 503)
HERE = os.path.dirname(os.path.abspath(__file__))
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))


# ---- signals ---------------------------------------------------------------------------------------------------------------------------------
def to_wav(samples) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", max(-32768, min(32767, int(round(s * 32767))))) for s in samples))
    return buf.getvalue()


def _fade(i, n, ramp):
    return min(1.0, i / ramp, (n - 1 - i) / ramp)


def tone_samples(freq=1000.0, seconds=2.0, amp=0.5):
    n = int(RATE * seconds)
    return [amp * _fade(i, n, RATE * 0.05) * math.sin(2 * math.pi * freq * i / RATE) for i in range(n)]


def sweep_samples(f0=100.0, f1=7800.0, seconds=4.0, amp=0.5):
    """Logarithmic sweep: phase = 2*pi*f0*T/ln(k) * (k^(t/T) - 1), k = f1/f0."""
    n = int(RATE * seconds)
    k = f1 / f0
    return [amp * _fade(i, n, RATE * 0.05) * math.sin(2 * math.pi * f0 * seconds / math.log(k) * (k ** (i / RATE / seconds) - 1)) for i in range(n)]


# ---- conversion ------------------------------------------------------------------------------------------------------------------------------
def convert_ffmpeg(src: bytes) -> bytes:
    p = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(RATE), "-sample_fmt", "s16", "-map_metadata", "-1",
                        "-fflags", "+bitexact", "-flags:a", "+bitexact", "-f", "wav", "pipe:1"], input=src, capture_output=True)
    if p.returncode != 0 or not p.stdout:
        raise RuntimeError("ffmpeg_failed")
    return p.stdout


def convert_python(src: bytes) -> bytes:
    """Dry-run fallback only (no ffmpeg on the dev box): mono mix + linear resample of a PCM s16 WAV. A real run always uses ffmpeg."""
    with wave.open(io.BytesIO(src)) as w:
        ch, rate, width, raw = w.getnchannels(), w.getframerate(), w.getsampwidth(), w.readframes(w.getnframes())
    if width != 2:
        raise RuntimeError("fallback_needs_s16")
    vals = struct.unpack("<%dh" % (len(raw) // 2), raw)
    mono = [sum(vals[i:i + ch]) / ch / 32768 for i in range(0, len(vals) - ch + 1, ch)]
    n = int(len(mono) * RATE / rate)
    out = []
    for i in range(n):
        x = i * rate / RATE
        j = int(x)
        a = mono[j]
        b = mono[j + 1] if j + 1 < len(mono) else a
        out.append(a + (b - a) * (x - j))
    return to_wav(out)


def convert(src: bytes, dry_run: bool) -> bytes:
    if shutil.which("ffmpeg"):
        return convert_ffmpeg(src)
    if dry_run:
        return convert_python(src)
    raise RuntimeError("ffmpeg_not_found")


# ---- fake TTS (dry run) -------------------------------------------------------------------------------------------------------------------------
def fake_tts(text, lang, speaker, model="bulbul:v3", pace=1.0):
    """Deterministic, no network: ~0.07 s per character of a two-tone signal seeded by the text, 24 kHz mono s16 (what the gateway returns)."""
    seed = int(hashlib.sha256(f"{text}|{lang}|{speaker}".encode()).hexdigest()[:8], 16)
    f1, f2 = 200 + seed % 300, 600 + (seed >> 8) % 400
    n = int(24000 * min(9.0, max(1.0, 0.07 * len(text))))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"".join(struct.pack("<h", int(8000 * (math.sin(2 * math.pi * f1 * i / 24000) + math.sin(2 * math.pi * f2 * i / 24000)))) for i in range(n)))
    return buf.getvalue(), "dryrun-" + hashlib.sha256(text.encode()).hexdigest()[:12], 200


# ---- ledger ----------------------------------------------------------------------------------------------------------------------------------
def iso(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def ledger_line(job_id, stim_id, text, rid, started, finished, status, http_status, dry_run):
    """sarvam.call.v1 (SARVAM-USAGE-CONTRACT-v1): a TTS call is task "tts", audio_s 0 (input seconds), chars = text length, scope "synthetic". No text in the line."""
    return {"caller": CALLER, "machine": os.environ.get("SELFTEST_MACHINE") or socket.gethostname(), "job_id": job_id, "request_id": rid,
            "route": "gateway", "mode": "sync", "task": "tts", "model": "bulbul:v3", "audio_s": 0, "chars": len(text), "started_at": iso(started),
            "finished_at": iso(finished), "status": status, "http_status": http_status, "throttled": http_status == 429, "scope": "synthetic",
            "ref": f"{PACK_NAME}:{stim_id}", **({"dry_run": True} if dry_run else {})}


def atomic_write(path, data: bytes):
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def write_lane(ledger_dir, now=None):
    """sarvam.lane.v1 for the caller, from THIS ledger dir's lines (G32). Written beside the ledger: <ledger-dir>/lanes/sarvam-<caller>.json. Nothing is active at the end of a run."""
    lines = []
    for f in sorted(os.listdir(ledger_dir)) if os.path.isdir(ledger_dir) else []:
        if f.endswith(".jsonl"):
            lines += [json.loads(l) for l in open(os.path.join(ledger_dir, f), encoding="utf-8") if l.strip()]
    day = datetime.datetime.now(IST).strftime("%Y-%m-%d")
    tl = [l for l in lines if l["finished_at"] and iso_to_ist_day(l["finished_at"]) == day]
    agg = lambda ls: {"jobs": len(ls), "audio_min": round(sum(l["audio_s"] for l in ls if l["status"] == "ok") / 60, 3)}  # noqa: E731
    lane = {"caller": CALLER, "machine": os.environ.get("SELFTEST_MACHINE") or socket.gethostname(), "updated_at": iso(time.time()), "active": [],
            "today": {**agg(tl), "failed": sum(1 for l in tl if l["status"] == "failed"), "throttled": sum(1 for l in tl if l["throttled"])}, "all_time": agg(lines)}
    os.makedirs(os.path.join(ledger_dir, "lanes"), exist_ok=True)
    atomic_write(os.path.join(ledger_dir, "lanes", f"sarvam-{CALLER}.json"), (json.dumps(lane, indent=1, sort_keys=True) + "\n").encode())
    return lane


def iso_to_ist_day(ts):
    return datetime.datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=datetime.timezone.utc).astimezone(IST).strftime("%Y-%m-%d")


def append_ledger(ledger_dir, line):
    os.makedirs(ledger_dir, exist_ok=True)
    day = datetime.datetime.now(IST).strftime("%Y-%m-%d")
    with open(os.path.join(ledger_dir, f"{day}.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(line, ensure_ascii=False, sort_keys=True) + "\n")


# ---- build -----------------------------------------------------------------------------------------------------------------------------------
def sha(b):
    return hashlib.sha256(b).hexdigest()


def wav_seconds(b):
    w = V.read_wav(b)
    return round(w[3] / RATE, 3)


def load_phrases(path):
    cfg = json.load(open(path, encoding="utf-8"))
    items = [dict(cfg["canary"], kind="canary")] + [dict(p, kind="phrase") for p in cfg["phrases"]]
    ids = [i["id"] for i in items]
    if len(set(ids)) != len(ids):
        raise SystemExit("phrases: duplicate id")
    for i in items:
        if i["voice"] not in cfg["speakers"] or not i["text"].strip():
            raise SystemExit(f"phrases: {i['id']} bad voice or empty text")
    return cfg, items


def build(out, phrases_path, dry_run=False, ledger_dir=None, tts=None, sleep=time.sleep, retries=3):
    cfg, items = load_phrases(phrases_path)
    pack_name = cfg.get("pack_name", PACK_NAME)
    os.makedirs(out, exist_ok=True)
    prev = None
    if os.path.exists(os.path.join(out, "pack.json")):
        try:
            prev = json.load(open(os.path.join(out, "pack.json"), encoding="utf-8"))
        except Exception:
            raise SystemExit("--out holds an unreadable pack.json; use an empty folder")
        if not isinstance(prev, dict) or prev.get("pack_name") != pack_name:  # G33: never touch another pack's folder
            raise SystemExit(f"--out already holds a different pack ({prev.get('pack_name') if isinstance(prev, dict) else '?'}); use an empty folder")
    ledger_dir = ledger_dir or os.path.join(out, "ledger-dryrun" if dry_run else "ledger")
    tts = tts or (fake_tts if dry_run else None)
    if tts is None:
        from selftest_gw import GatewayTTS, missing_env
        miss = missing_env()
        if miss:
            raise SystemExit("missing env: " + ", ".join(miss))
        if not shutil.which("ffmpeg"):
            raise SystemExit("ffmpeg not found on PATH")
        tts = GatewayTTS()
    cache_path = os.path.join(out, ".tts-cache.json")
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    raw_dir = os.path.join(out, ".raw")
    run_id = "st-" + uuid.uuid4().hex[:10]
    files, stimuli, paid = {}, [], 0
    files["tone-1k.wav"] = to_wav(tone_samples())
    files["sweep.wav"] = to_wav(sweep_samples())
    for name in ("tone-1k.wav", "sweep.wav"):
        atomic_write(os.path.join(out, name), files[name])
    stimuli.append({"id": "tone-1k", "kind": "tone", "file": "tone-1k.wav"})
    stimuli.append({"id": "sweep", "kind": "sweep", "file": "sweep.wav"})
    for it in items:
        speaker = cfg["speakers"][it["voice"]]
        key = sha(json.dumps([it["text"], it["lang"], speaker, cfg["model"], cfg["pace"]], ensure_ascii=False).encode())
        name = it["id"] + ".wav"
        path = os.path.join(out, name)
        raw_path = os.path.join(raw_dir, f"{it['id']}.{key[:16]}.wav")
        have = open(path, "rb").read() if os.path.exists(path) else None
        if have is not None and cache.get(key) == sha(have) and V.read_wav(have):
            files[name] = have  # same text/lang/speaker/model/pace, file intact: no paid call
        elif os.path.exists(raw_path):
            # G29: the paid audio was saved raw but never converted (ffmpeg failed, or the run died): convert it, pay nothing
            files[name] = convert(open(raw_path, "rb").read(), dry_run)
            atomic_write(path, files[name])
            cache[key] = sha(files[name])
            atomic_write(cache_path, json.dumps(cache, indent=1, sort_keys=True).encode())
        else:
            for attempt in range(retries + 1):
                started = time.time()
                job = f"{run_id}:{it['id']}:a{attempt + 1}"  # G31: one ledger line per request, each with its own job id
                try:
                    raw, rid, status = tts(it["text"], it["lang"], speaker, cfg["model"], cfg["pace"])
                except Exception as e:  # GatewayError
                    status = getattr(e, "status", None)
                    append_ledger(ledger_dir, ledger_line(job, it["id"], it["text"], None, started, time.time(), "failed", status, dry_run))
                    paid += 1
                    if status in RETRY_STATUSES and attempt < retries:
                        sleep(2 ** attempt)
                        continue
                    raise SystemExit(f"tts failed for {it['id']}: {getattr(e, 'code', type(e).__name__)} {status or ''}".strip()
                                     + (" (a timeout/network error may have been billed: NOT retried; rerun to pay only for missing phrases)" if status is None else ""))
                paid += 1
                append_ledger(ledger_dir, ledger_line(job, it["id"], it["text"], rid, started, time.time(), "ok", status, dry_run))
                # G29: the paid audio is on disk BEFORE anything else can fail (conversion, the next phrase, the 90 s check)
                os.makedirs(raw_dir, exist_ok=True)
                atomic_write(raw_path, raw)
                files[name] = convert(raw, dry_run)
                atomic_write(path, files[name])
                cache[key] = sha(files[name])
                atomic_write(cache_path, json.dumps(cache, indent=1, sort_keys=True).encode())
                break
        stimuli.append({"id": it["id"], "kind": it["kind"], "file": name, "lang": it["lang"], "truth": it["text"]})
    for s in stimuli:
        b = files[s["file"]]
        s["sha256"], s["duration_s"] = sha(b), wav_seconds(b)
    total = sum(s["duration_s"] for s in stimuli)
    if total > V.MAX_TOTAL_S:
        write_lane(ledger_dir)
        raise SystemExit(f"pack is {total:.1f} s, over the {V.MAX_TOTAL_S:.0f} s limit; shorten the phrases (the audio is saved: a rerun with shorter text pays only for the changed phrases)")
    if prev:  # a stale wav from an older phrase set of THIS pack would ship unpinned; files of any other origin are never deleted (the validator flags them)
        for e in prev.get("stimuli", []):
            f = e.get("file") if isinstance(e, dict) else None
            if isinstance(f, str) and f.endswith(".wav") and f not in files and os.path.exists(os.path.join(out, f)):
                os.remove(os.path.join(out, f))
    manifest = {"pack_version": 1, "pack_name": pack_name, "format": "wav pcm_s16le mono 16000", "stimuli": stimuli}
    atomic_write(os.path.join(out, "pack.json"), (json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8"))
    write_lane(ledger_dir)
    errs, _ = V.validate(out)
    if errs:
        raise SystemExit("built pack fails validation: " + "; ".join(errs))
    return {"out": out, "stimuli": len(stimuli), "total_s": round(total, 2), "paid_calls": paid, "pack_sha256": V.pack_sha256(out), "ledger_dir": ledger_dir}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--phrases", default=os.path.join(HERE, "phrases.json"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--ledger-dir")
    a = ap.parse_args(argv)
    r = build(a.out, a.phrases, a.dry_run, a.ledger_dir)
    print(json.dumps(r, indent=1))
    print("remember: build-bundle.sh pins pack.json's sha256 (SELFTEST_PACK_SHA256); set it to pack_sha256 above.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
