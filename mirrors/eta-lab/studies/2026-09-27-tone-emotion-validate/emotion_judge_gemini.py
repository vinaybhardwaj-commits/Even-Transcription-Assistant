#!/usr/bin/env python3
"""W45.2 second arm (Fable ruling on #4506, 27 Sep): wavlm is NOT valid for anxious/angry/sad (0/12 cells every
language, run 2). Next arm: Gemini 3.8 Flash LISTENING to the audio, judging per-turn emotion + distress, scored on
the SAME synthetic suite (emotion_suite.py run2: 144 clips, 72 clean + 72 room-acoustic proxy) and the SAME
pre-registered pass bar shape, before any real use. Synthetic-only here - no box-exit gate needed (see
turn_translate.py for the real-patient-audio version of this route).

Route reused verbatim from linker's W33.4a lang_judge.py (OpenRouter google/gemini-3.8-flash, mp3 input_audio,
provider zdr+deny+no-fallback, same retry/backoff, same route-mismatch check). Only the prompt and parsed fields
differ: an emotion label from the SAME six-way set the suite was generated with (no wavlm-style label crosswalk
needed - Gemini is asked for exactly our categories) plus a 0-3 distress rating, not a language ID.

No ElevenLabs spend here - reuses existing audio, per Fable 27 Sep ("keep the char budget for top-up only").

Usage: python3 emotion_judge_gemini.py run --manifest MANIFEST.jsonl --out RUN_DIR
  (MANIFEST.jsonl rows: {"id": file, "audio": path, "lang":.., "emotion":.., "room": bool})
       python3 emotion_judge_gemini.py report --judged RUN_DIR/judged.jsonl --json RUN_DIR/report.json
"""
import argparse
import base64
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

MODEL, URL = "google/gemini-3.8-flash", "https://openrouter.ai/api/v1/chat/completions"
PROVIDER = {"zdr": True, "data_collection": "deny", "allow_fallbacks": False}
EMOTIONS = ("neutral", "calm", "anxious", "angry", "sad", "happy")
MAX_S = 31.0
WAITS = (0, 4, 12, 30)
_sleep = time.sleep
PROMPT = ("Listen to this audio clip: a short line performed by an actor in a deliberate emotional style, spoken in "
          "a clinical/consultation context (the words themselves may be plain). Which ONE of these best describes "
          "the speaker's emotional DELIVERY (tone of voice, not the words)? neutral, calm, anxious, angry, sad, "
          "happy. Separately, rate how much distress the delivery conveys, 0 to 3 (0=none, 1=mild, 2=clear, "
          '3=acute). Reply with a JSON object {"emotion": X, "distress": N} and nothing else, where X is exactly '
          "one of the six words above and N is an integer 0-3.")
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
    try:
        got = json.loads(data["choices"][0]["message"]["content"])
        emo, distress = got["emotion"], got["distress"]
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    if emo not in EMOTIONS:
        return None
    try:
        distress = int(distress)
    except (TypeError, ValueError):
        return None
    if not (0 <= distress <= 3):
        return None
    return emo, distress


def judge_one(mp3_path, send):
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
            return dict(emotion=None, distress=None, status="route_mismatch", model=data.get("model"), provider=data.get("provider"))
        parsed = parse_reply(data)
        if parsed is None:
            bad += 1
            if bad >= 2:
                return dict(emotion=None, distress=None, status="bad_reply", model=data["model"], provider=data["provider"])
            continue
        emo, distress = parsed
        return dict(emotion=emo, distress=distress, status="ok", model=data["model"], provider=data["provider"])
    return dict(emotion=None, distress=None, status="http_%s" % last, model=None, provider=None)


def run_judged(items, out_dir, send, prep_dir):
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    os.chmod(out_dir, 0o700)
    jp = os.path.join(out_dir, "judged.jsonl")
    done = {json.loads(l)["id"] for l in open(jp)} if os.path.exists(jp) else set()
    with open(jp, "a") as f:
        os.chmod(jp, 0o600)
        for it in items:
            if it["id"] in done:
                continue
            mp3 = os.path.join(prep_dir, hashlib.sha1(it["id"].encode()).hexdigest()[:12] + ".mp3")
            to_mp3(it["audio"], mp3)
            res = judge_one(mp3, send)
            os.remove(mp3)
            row = dict(id=it["id"], lang=it.get("lang"), requested_emotion=it.get("emotion"), room=bool(it.get("room")),
                       prompt_sha256=PROMPT_SHA, **res)
            f.write(json.dumps(row) + "\n")
            f.flush()
    return [json.loads(l) for l in open(jp)]


def build_report(rows):
    """Same pass-bar SHAPE as emotion_suite.build_report (per lang/emotion/condition cell: reliable iff hits on a
    majority AND the requested-emotion vote share beats every other label's vote share). Gemini's output space IS
    our six labels - no crosswalk needed, unlike wavlm's 7-label model."""
    cells = {}
    confusion = {}
    for r in rows:
        cond = "room" if r.get("room") else "clean"
        key = (r["lang"], r["requested_emotion"], cond)
        cells.setdefault(key, []).append(r)
        confusion.setdefault(r["lang"], {}).setdefault(r["requested_emotion"], {})
        label = r["emotion"] if r["status"] == "ok" else "error:%s" % r["status"]
        confusion[r["lang"]][r["requested_emotion"]][label] = confusion[r["lang"]][r["requested_emotion"]].get(label, 0) + 1

    verdicts = {}
    distress_by_emotion = {}
    for (lang, emo, cond), rs in cells.items():
        n = len(rs)
        ok = [r for r in rs if r["status"] == "ok"]
        error_share = 1 - (len(ok) / n if n else 0)
        votes = {}
        for r in ok:
            votes[r["emotion"]] = votes.get(r["emotion"], 0) + 1
        hits = votes.get(emo, 0)
        share_req = hits / len(ok) if ok else 0.0
        share_best_other = max((v for k, v in votes.items() if k != emo), default=0) / len(ok) if ok else 0.0
        reliable = bool(ok) and error_share <= 0.5 and hits >= max(1, math.ceil(0.5 * n) + 1) and share_req >= share_best_other
        verdicts["%s/%s/%s" % (lang, emo, cond)] = dict(n=n, ok=len(ok), hits=hits, error_share=round(error_share, 2),
                                                          share_requested=round(share_req, 3), share_best_other=round(share_best_other, 3),
                                                          reliable=reliable)
        distress_by_emotion.setdefault(emo, []).extend(r["distress"] for r in ok if r["distress"] is not None)
    distress_summary = {emo: round(sum(v) / len(v), 2) if v else None for emo, v in sorted(distress_by_emotion.items())}
    return dict(model=MODEL, prompt_sha256=PROMPT_SHA, verdicts=verdicts, confusion=confusion, mean_distress_by_requested_emotion=distress_summary)


def report_md(rep):
    lines = ["| lang/emotion/condition | n | ok | hits | error_share | share_req | share_best_other | reliable |",
             "|---|---:|---:|---:|---:|---:|---:|---|"]
    for k in sorted(rep["verdicts"]):
        v = rep["verdicts"][k]
        lines.append("| %s | %d | %d | %d | %.2f | %.3f | %.3f | %s |" % (
            k, v["n"], v["ok"], v["hits"], v["error_share"], v["share_requested"], v["share_best_other"], "YES" if v["reliable"] else "no"))
    lines.append("")
    lines.append("mean distress (0-3) by requested emotion: " + json.dumps(rep["mean_distress_by_requested_emotion"]))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--manifest", required=True)
    r.add_argument("--out", required=True)
    rp = sub.add_parser("report")
    rp.add_argument("--judged", required=True)
    rp.add_argument("--json")
    a = ap.parse_args(argv)

    if a.cmd == "run":
        items = [json.loads(l) for l in open(a.manifest)]
        send = http_transport(get_key())
        with tempfile.TemporaryDirectory() as prep:
            rows = run_judged(items, a.out, send, prep)
        n_ok = sum(1 for r in rows if r["status"] == "ok")
        print(json.dumps(dict(n=len(rows), ok=n_ok)))
        return 0
    rows = [json.loads(l) for l in open(a.judged)]
    rep = build_report(rows)
    if a.json:
        with open(a.json, "w") as f:
            json.dump(rep, f, indent=1)
        os.chmod(a.json, 0o600)
    print(report_md(rep))
    return 0


if __name__ == "__main__":
    sys.exit(main())
