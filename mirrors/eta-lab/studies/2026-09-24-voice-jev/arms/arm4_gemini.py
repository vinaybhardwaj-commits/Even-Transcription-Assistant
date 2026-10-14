"""Arm 4: Gemini on Vertex listens. L1 on the turn clip (turn +/- 5 s context, the turn marked by a beep at each end), L2 on the whole window clip.
Input jsonl (NO truth): {turn_id?, window_id, audio_path, turn_start_s?, turn_end_s?, window_start_s?, window_end_s?}  (times in seconds within audio_path)
  - a record with turn_start_s/turn_end_s gets L1 (needs turn_id); every distinct window_id gets L2 once.
Output jsonl: {kind:"l1"|"l2", turn_id?, window_id, answer|speakers, model, usage, latency_s, audio_s, prompt_sha, ts, freeze_sha12}
Usage: arm4_gemini.py --in clips.jsonl --out out/arm4.jsonl [--model gemini-3.8-flash] [--tasks l1,l2] [--clip-dir DIR] [--workers 4] [--backend vertex|mock]
If Vertex refuses (403/404) the error lands in the output; do not work around it.
"""
import argparse, base64, concurrent.futures as cf, hashlib, json, os, re, shutil, subprocess, sys, time
import common as C

PROMPT_FILE = os.path.join(C.HERE, "ARM4_PROMPT.txt")
CONTEXT_S = 5.0


def prompt_parts():
    """Parse ARM4_PROMPT.txt; assert L1/L2 are verbatim from the frozen text."""
    txt = open(PROMPT_FILE).read()
    sec = {m.group(1): m.group(2).strip() for m in re.finditer(r"^--- ([A-Z0-9 ()a-z]+?) ---\n(.*?)(?=^--- |\Z)", txt, re.M | re.S)}
    frozen, _ = C.freeze_text()
    for k in ("L1", "L2"):
        if sec[k] not in frozen: raise SystemExit(f"{k} in ARM4_PROMPT.txt is not verbatim from the freeze")
    return sec, C.sha256_bytes(txt.encode())


def ffmpeg_exe():
    for cand in (shutil.which("ffmpeg"),):
        if cand: return cand
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def cut_turn_clip(src, ts, te, out, context=CONTEXT_S):
    """[ts-context, ts) + beep + [ts, te) + beep + [te, te+context), 16 kHz mono wav. Returns clip seconds."""
    cs = max(0.0, ts - context); ce = te + context
    pre = ts > cs
    chain = ["[0:a]aresample=16000,aformat=channel_layouts=mono," + ("asplit=3[a0][a1][a2]" if pre else "asplit=2[a1][a2]")]
    chain.append("sine=frequency=880:duration=0.25:sample_rate=16000,volume=0.3,asplit=2[b1][b2]")
    order = []
    if pre: chain.append(f"[a0]atrim=start={cs}:end={ts},asetpts=N/SR/TB[p]"); order.append("[p]")
    order.append("[b1]")
    chain.append(f"[a1]atrim=start={ts}:end={te},asetpts=N/SR/TB[m]"); order.append("[m]"); order.append("[b2]")
    chain.append(f"[a2]atrim=start={te}:end={ce},asetpts=N/SR/TB[q]"); order.append("[q]")
    chain.append("".join(order) + f"concat=n={len(order)}:v=0:a=1[out]")
    _run_ffmpeg(["-i", src, "-filter_complex", ";".join(chain), "-map", "[out]", "-ac", "1", "-ar", "16000", out])
    return audio_seconds(out)


def cut_window_clip(src, ws, we, out):
    args = ["-i", src, "-af", "aresample=16000,aformat=channel_layouts=mono"]
    if ws is not None: args = ["-ss", str(ws)] + args
    if we is not None: args += ["-t", str((we - (ws or 0.0)))]
    _run_ffmpeg(args + ["-ac", "1", "-ar", "16000", out]); return audio_seconds(out)


def _run_ffmpeg(args):
    r = subprocess.run([ffmpeg_exe(), "-y", "-loglevel", "error"] + args, capture_output=True, text=True)
    if r.returncode: raise RuntimeError("ffmpeg failed: " + r.stderr[-300:])


def audio_seconds(p):
    r = subprocess.run([ffmpeg_exe(), "-i", p, "-f", "null", "-"], capture_output=True, text=True)
    m = re.findall(r"time=(\d+):(\d+):([\d.]+)", r.stderr)[-1]
    return round(int(m[0]) * 3600 + int(m[1]) * 60 + float(m[2]), 2)


SCHEMAS = {
    "l1": {"type": "OBJECT", "properties": {"answer": {"type": "STRING", "enum": ["marked_middle_speaker", "not_marked_middle_speaker", "cannot_tell"]}}, "required": ["answer"]},
    "l2": {"type": "OBJECT", "properties": {"speakers": {"type": "INTEGER"}}, "required": ["speakers"]},
}


def ask_gemini(model, kind, wav, sec, backend):
    if backend == "mock":
        h = int(hashlib.sha256(open(wav, "rb").read()).hexdigest(), 16)
        return {"answer": ["marked_middle_speaker", "not_marked_middle_speaker", "cannot_tell"][h % 3]} if kind == "l1" else {"speakers": 1 + h % 5}, {"promptTokenCount": 100}
    pre = sec["L1 PREAMBLE (turn clip)"] if kind == "l1" else sec["L2 PREAMBLE (window clip)"]
    body = {"systemInstruction": {"parts": [{"text": sec["SYSTEM"]}]},
            "contents": [{"role": "user", "parts": [{"text": pre}, {"inlineData": {"mimeType": "audio/wav", "data": base64.b64encode(open(wav, "rb").read()).decode()}},
                                                    {"text": sec[kind.upper()]}]}],
            "generationConfig": {"temperature": 0, "responseMimeType": "application/json", "responseSchema": SCHEMAS[kind]}}
    r = C.vertex_generate(model, body)
    cand = r["candidates"][0]
    return json.loads(cand["content"]["parts"][-1]["text"]), r.get("usageMetadata", {})


def job(kind, rec, a, sec, psha):
    base = {"kind": kind, "window_id": rec["window_id"], "model": a.model, "prompt_sha": psha, **C.stamp()}
    if kind == "l1": base["turn_id"] = rec["turn_id"]
    t0 = time.time()
    try:
        name = f"{rec['turn_id']}.l1.wav" if kind == "l1" else f"{rec['window_id']}.l2.wav"
        wav = os.path.join(a.clip_dir, name.replace("/", "_"))
        if kind == "l1": audio_s = cut_turn_clip(rec["audio_path"], rec["turn_start_s"], rec["turn_end_s"], wav)
        else: audio_s = cut_window_clip(rec["audio_path"], rec.get("window_start_s"), rec.get("window_end_s"), wav)
        ans, usage = ask_gemini(a.model, kind, wav, sec, a.backend)
        return {**base, **ans, "usage": usage, "audio_s": audio_s, "latency_s": round(time.time() - t0, 3), "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    except Exception as e:
        return {**base, "error": str(e)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="gemini-3.8-flash"); ap.add_argument("--tasks", default="l1,l2")
    ap.add_argument("--clip-dir", default=os.path.join(C.HERE, "clips")); ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--backend", choices=["vertex", "mock"], default="vertex")
    ap.add_argument("--select", choices=["all", "doubtful", "doubtful+sample"], default="doubtful+sample",
                    help="L1 turns (needs --arm1): DOUBTFUL plus the seeded 40-turn confident sample (default). L2 still runs on every window given.")
    ap.add_argument("--arm1", help="out/arm1.jsonl"); ap.add_argument("--turn-ids", help="file, one turn_id per line: restrict L1 further")
    a = ap.parse_args(); C.freeze_text(); sec, psha = prompt_parts()
    rows = C.read_jsonl(a.inp); C.blind_check(a.inp, rows); os.makedirs(a.clip_dir, exist_ok=True)
    tasks = set(a.tasks.split(","))
    jobs = []
    if "l1" in tasks:
        if a.select != "all" and not a.arm1: raise SystemExit("--select needs --arm1")
        keep = C.select_turns(C.read_jsonl(a.arm1), a.select, open(a.turn_ids).read().split() if a.turn_ids else None) if a.select != "all" else None
        jobs += [("l1", r) for r in rows if r.get("turn_start_s") is not None and (keep is None or r["turn_id"] in keep)]
    if "l2" in tasks:
        seen = {}
        for r in rows: seen.setdefault(r["window_id"], r)
        jobs += [("l2", r) for r in seen.values()]
    key = lambda j: (j[0], j[1].get("turn_id") if j[0] == "l1" else j[1]["window_id"])
    done = set()
    if os.path.exists(a.out):
        done = {(r["kind"], r.get("turn_id") if r["kind"] == "l1" else r["window_id"]) for r in C.read_jsonl(a.out) if "error" not in r}
    todo = [j for j in jobs if key(j) not in done]
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    n_err, t0 = 0, time.time()
    with cf.ThreadPoolExecutor(a.workers) as ex:
        for out in ex.map(lambda j: job(j[0], j[1], a, sec, psha), todo):
            C.append_jsonl(a.out, out); n_err += "error" in out
    print(f"arm4: {len(todo)} run, {len(done)} resumed, {n_err} errors, {time.time() - t0:.1f}s wall")
    return 1 if n_err else 0


if __name__ == "__main__":
    sys.exit(main())
