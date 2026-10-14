#!/usr/bin/env python3
"""W45.3 per-turn English translation (tone), pending a real multi-engine per-window record (V's proposal, not built
yet). Reuses linker's W33.4a ZDR route VERBATIM (studies/2026-09-27-clarity-scorecard/lang_judge.py @8a6e513b): OpenRouter
google/gemini-3.8-flash, mp3 input_audio, provider {zdr: true, data_collection: deny, allow_fallbacks: false}, same key
lookup, same retry/backoff, same route-mismatch check (returned model/provider must match what was asked). Only the prompt
and the parsed field change: this asks for a transcription+translation, not a language label.

No de-identification (V ruling 27 Sep 12:55: Jev/TypeSafe and OpenRouter/Gemini are both ZDR for Even).

PATIENT AUDIO LEAVES THE BOX on `turns` with real clips - same gate lang_judge.py documents for its `window` command:
launched by Fable/V, not run unattended on new patient audio without that. `validate` (synthetic-only) has no such gate.

  validate  --clips DIR --out RUN_DIR      synthetic clips (DIR/*.json truth + .wav, e.g. emotion_suite.py's own
                                            stimuli) -> translated.jsonl + report.json (no patient audio touched)
  turns     --manifest M.jsonl --out RUN_DIR   real turns: M rows {id, audio, window_id, speaker_idx, role,
                                            start_ms, end_ms} (audio <= 31 s) -> translated.jsonl. Same box-exit gate
                                            as lang_judge.py window mode.
"""
import argparse
import base64
import glob
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

MODEL, URL = "google/gemini-3.8-flash", "https://openrouter.ai/api/v1/chat/completions"
PROVIDER = {"zdr": True, "data_collection": "deny", "allow_fallbacks": False}
MAX_S = 31.0
WAITS = (0, 4, 12, 30)
_sleep = time.sleep
PROMPT = ("Listen to this audio clip of one speaker's turn in a doctor-patient medical consultation. "
          "Transcribe what is said and translate it into English. "
          'Reply with a JSON object {"text_en": X, "source_language": Y} where X is the English translation '
          "(English text stays as-is) and Y is your best guess at the spoken language (en, hi, kn, ta, te, ml, "
          "or mixed/other). If there is no speech, reply {\"text_en\": \"\", \"source_language\": \"none\"}. "
          "Reply with the JSON object and nothing else.")
PROMPT_SHA = hashlib.sha256((MODEL + "\n" + PROMPT).encode()).hexdigest()


def get_key(env=None):
    env = os.environ if env is None else env
    k = env.get("OPENROUTER_API_KEY", "").strip()
    if not k:
        p = os.path.expanduser(env.get("OPENROUTER_KEY_FILE", "~/.claude/secrets/openrouter_api_key"))
        with open(p) as f:
            k = f.read().strip()
    if not k:
        raise SystemExit("no OpenRouter key supplied")
    return k


def to_mp3(src, dst):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-t", str(int(MAX_S)), "-i", src, "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", dst], check=True)


def duration_s(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


def request_body(mp3_b64):
    return {"model": MODEL, "temperature": 0, "provider": dict(PROVIDER), "response_format": {"type": "json_object"},
            "messages": [{"role": "user", "content": [{"type": "text", "text": PROMPT}, {"type": "input_audio", "input_audio": {"data": mp3_b64, "format": "mp3"}}]}]}


def http_transport(key):
    def send(body):
        req = urllib.request.Request(URL, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json", "Authorization": "Bearer " + key})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, None
        except Exception:
            return 0, None
    return send


def parse_reply(data):
    """-> (text_en, source_language) or None when the reply isn't the expected JSON shape."""
    try:
        got = json.loads(data["choices"][0]["message"]["content"])
        text_en, lang = got["text_en"], got.get("source_language")
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    return (text_en, lang) if isinstance(text_en, str) else None


def translate_one(mp3_path, send):
    """-> dict(text_en, source_language, status, model, provider). status='error' when no accepted reply (never guessed)."""
    body = request_body(base64.b64encode(open(mp3_path, "rb").read()).decode())
    bad = 0
    last = 0
    for w in WAITS:
        if w:
            _sleep(w)
        status, data = send(body)
        last = status
        if status in (429, 500, 502, 503, 504):
            continue
        if status != 200 or not isinstance(data, dict):
            bad += 1
            if bad >= 2:
                break
            continue
        if data.get("model") != MODEL or not isinstance(data.get("provider"), str) or not data["provider"].strip():
            return dict(text_en=None, source_language=None, status="route_mismatch", model=data.get("model"), provider=data.get("provider"))
        parsed = parse_reply(data)
        if parsed is None:
            bad += 1
            if bad >= 2:
                return dict(text_en=None, source_language=None, status="bad_reply", model=data["model"], provider=data["provider"])
            continue
        text_en, lang = parsed
        return dict(text_en=text_en, source_language=lang, status="ok", model=data["model"], provider=data["provider"])
    return dict(text_en=None, source_language=None, status="http_%s" % last, model=None, provider=None)


def run_translated(items, out_dir, send, prep_dir):
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    os.chmod(out_dir, 0o700)
    jp = os.path.join(out_dir, "translated.jsonl")
    done = {json.loads(l)["id"] for l in open(jp)} if os.path.exists(jp) else set()
    with open(jp, "a") as f:
        os.chmod(jp, 0o600)
        for it in items:
            if it["id"] in done:
                continue
            mp3 = os.path.join(prep_dir, hashlib.sha1(it["id"].encode()).hexdigest()[:12] + ".mp3")
            to_mp3(it["audio"], mp3)
            res = translate_one(mp3, send)
            os.remove(mp3)
            row = dict(id=it["id"], prompt_sha256=PROMPT_SHA, **res)
            for k in ("window_id", "speaker_idx", "role", "start_ms", "end_ms"):
                if k in it:
                    row[k] = it[k]
            f.write(json.dumps(row) + "\n")
            f.flush()
    return {json.loads(l)["id"]: json.loads(l) for l in open(jp)}


# ------------------------------------------------------------------------------------------------ validate (synthetic only)
def load_synthetic(clips_dir):
    """A manifest.json (emotion_suite.py's own shape: items with lang/role/emotion/file) OR loose *.wav + *.truth.json pairs."""
    man = os.path.join(clips_dir, "manifest.json")
    items = []
    if os.path.exists(man):
        for it in json.load(open(man))["items"]:
            items.append(dict(id=it["file"], audio=os.path.join(clips_dir, it["file"]), truth_text=it.get("text", "")))
        return items
    for tp in sorted(glob.glob(os.path.join(clips_dir, "*.truth.json"))):
        wav = tp[:-len(".truth.json")] + ".wav"
        if os.path.exists(wav):
            t = json.load(open(tp))
            items.append(dict(id=os.path.basename(wav)[:-4], audio=wav, truth_text=t.get("text", "")))
    return items


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate")
    v.add_argument("--clips", required=True)
    v.add_argument("--out", required=True)
    w = sub.add_parser("turns")
    w.add_argument("--manifest", required=True)
    w.add_argument("--out", required=True)
    a = ap.parse_args(argv)

    send = http_transport(get_key())
    with tempfile.TemporaryDirectory() as prep:
        if a.cmd == "validate":
            items = load_synthetic(a.clips)
            got = run_translated(items, a.out, send, prep)
            rows = [dict(id=i["id"], truth_text=i.get("truth_text", ""), text_en=got[i["id"]]["text_en"], status=got[i["id"]]["status"]) for i in items]
            n_ok = sum(1 for r in rows if r["status"] == "ok")
            rp = os.path.join(a.out, "report.json")
            with open(rp, "w") as f:
                json.dump(dict(model=MODEL, prompt_sha256=PROMPT_SHA, n=len(rows), ok=n_ok, rows=rows), f, indent=1)
            os.chmod(rp, 0o600)
            print(json.dumps(dict(n=len(rows), ok=n_ok)))
            return 0 if n_ok == len(rows) else 2
        items = []
        for r in map(json.loads, open(a.manifest)):
            if duration_s(r["audio"]) > MAX_S:
                raise SystemExit("refused: a turn is longer than %.0f s (%s)" % (MAX_S, r["id"]))
            items.append(r)
        got = run_translated(items, a.out, send, prep)
        n_ok = sum(1 for g in got.values() if g["status"] == "ok")
        print(json.dumps(dict(translated=len(got), ok=n_ok, prompt_sha256=PROMPT_SHA)))
        return 0


if __name__ == "__main__":
    sys.exit(main())
