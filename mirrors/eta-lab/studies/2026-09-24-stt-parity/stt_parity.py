#!/usr/bin/env python3
"""
STT-STACK-PARITY order 1 (Fable 24 Sep 11:50): score the box twins (router + eta-indic + SraVaani + whisper shim)
against STORED production outputs. The Mini and the Yoga are never called.

Stored side: transcription_run rows (engine='route', mode='batch') for archived 900 s room windows: transcript_original,
detected_language, metrics_json (route_outcome, language_timeline.spans with lang/engine/start_s/end_s/chars, segment_count,
assembled_collapse). Audio: metrics_json.clip_r2_key from R2 through the READ-ONLY key on this box (never printed).
Twin side: POST /route/job on the twin router with the production request shape (translate=false, candidates default, window_s=180)
and the audio served from a loopback http server.

Output: numbers only. No transcript text is printed or written to the results file. The local input files (data/g*.json) hold
patient text and stay under ~/vad/work/stt-parity/ (0600, never in git); audio is deleted after each window.
"""
import argparse, collections, json, os, re, sys, threading, time, unicodedata, http.server, socketserver, functools
import requests
from rapidfuzz import fuzz
from rapidfuzz.distance import Levenshtein
import boto3

WORK = os.path.expanduser("~/vad/work/stt-parity")
ROUTER = os.environ.get("TWIN_ROUTER", "http://127.0.0.1:8083")
PORT = 18899
INDIC_RE = re.compile(r"[ऀ-෿]")


def norm(t):
    t = unicodedata.normalize("NFKC", t or "").lower()
    t = re.sub(r"[^\w\s]", " ", t, flags=re.UNICODE)
    return re.sub(r"\s+", " ", t).strip()


def r2():
    L = [l.strip() for l in open(os.path.expanduser("~/.claude/secrets/r2_audio_read")) if l.strip()]
    return boto3.client("s3", aws_access_key_id=L[0], aws_secret_access_key=L[1], endpoint_url=L[2], region_name="auto")


def ngram_ratio(t, n=3):
    w = norm(t).split()
    if len(w) < n + 1:
        return None
    g = [tuple(w[i:i + n]) for i in range(len(w) - n + 1)]
    return round(len(set(g)) / len(g), 4)


def spans_of(tl):
    return [s for s in (tl or {}).get("spans", []) if isinstance(s, dict)]


def span_match(stored, twin):
    """Fraction of stored-span seconds whose overlapping twin segment has the same engine / same lang."""
    tot = eng = lng = 0.0
    for s in stored:
        a, b = s["start_s"], s["end_s"]
        d = max(0.0, b - a)
        if d <= 0:
            continue
        best = None; bo = 0.0
        for t in twin:
            o = min(b, t.get("end_s", 0)) - max(a, t.get("start_s", 0))
            if o > bo:
                bo, best = o, t
        tot += d
        if best and bo >= 0.5 * d:
            eng += d * (best.get("engine") == s.get("engine"))
            lng += d * (best.get("lang") == s.get("lang"))
    return (eng / tot if tot else None, lng / tot if tot else None, tot)


def run_job(audio_url):
    t0 = time.time()
    r = requests.post(ROUTER + "/route/job", json={"audio_url": audio_url, "candidates": "en,kn,hi,ta,te,ml,mr,bn", "translate": False, "window_s": 180}, timeout=30)
    jid = r.json().get("job_id")
    if not jid:
        return {"ok": False, "error": "no_job_id: " + r.text[:120]}, time.time() - t0
    while True:
        time.sleep(5)
        j = requests.get(f"{ROUTER}/route/job/{jid}", timeout=30).json()
        if j.get("state") in ("done", "failed") or j.get("ok") is False and j.get("error"):
            return j, time.time() - t0
        if time.time() - t0 > 1800:
            return {"ok": False, "error": "timeout_1800s"}, time.time() - t0


def main():
    global WORK
    ap = argparse.ArgumentParser()
    ap.add_argument("--groups", default="g1,g2,g3,g4")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--repeat-ids", default="", help="comma list of ids to run TWICE (twin-vs-twin determinism)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--clips-dir", default="", help="use pre-fetched clips <id>.webm from here instead of R2 (no key needed on this host)")
    ap.add_argument("--shard", default="", help="i/n: run only rows with index %% n == i")
    ap.add_argument("--work", default=WORK)
    ap.add_argument("--runs", type=int, default=0, help="run every selected window this many times (twin-vs-twin spread)")
    ap.add_argument("--only", default="", help="comma list of id suffixes (last 6 chars) to run")
    a = ap.parse_args()
    WORK = a.work
    rows, seen = [], set()
    for g in a.groups.split(","):
        for r in json.load(open(f"{WORK}/data/{g}.json")):
            if r["id"] in seen:
                continue
            seen.add(r["id"]); r["group"] = r["g"]; rows.append(r)
    if a.only:
        keep = set(a.only.split(","))
        rows = [r for r in rows if r["id"][-6:] in keep]
    if a.limit:
        rows = rows[:a.limit]
    if a.shard:
        si, sn = map(int, a.shard.split("/"))
        rows = [r for i, r in enumerate(rows) if i % sn == si]
    os.makedirs(f"{WORK}/audio", exist_ok=True)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=f"{WORK}/audio")
    handler.log_message = lambda *x, **k: None
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), handler); srv.allow_reuse_address = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    s3 = None if a.clips_dir else r2(); repeat = set(filter(None, a.repeat_ids.split(",")))
    out = {"router": ROUTER, "windows": []}
    for r in rows:
        mj = r["mj"]; key = mj["clip_r2_key"]; fn = re.sub(r"\W", "_", r["id"]) + ".webm"; path = f"{WORK}/audio/{fn}"
        try:
            if a.clips_dir:
                src = os.path.join(a.clips_dir, fn)
                if not os.path.exists(path):
                    os.symlink(os.path.abspath(src), path)
            else:
                s3.download_file("eta-audio", key, path)
        except Exception as e:
            out["windows"].append({"id": r["id"], "group": r["group"], "error": "r2_download: " + type(e).__name__}); continue
        import hashlib
        shas = {x["id"]: x["audio_sha256"] for x in json.load(open(f"{WORK}/data/sha.json"))} if os.path.exists(f"{WORK}/data/sha.json") else {}
        h = hashlib.sha256(open(path, "rb").read()).hexdigest()
        if shas.get(r["id"]) and shas[r["id"]] != h:
            out["windows"].append({"id": r["id"], "group": r["group"], "error": "audio_sha_mismatch"}); continue
        runs = a.runs if a.runs else (2 if r["id"] in repeat else 1)
        for k in range(runs):
            j, wall = run_job(f"http://127.0.0.1:{PORT}/{fn}")
            row = {"id": r["id"], "group": r["group"], "run": k + 1, "wall_s": round(wall, 1), "audio_s": mj.get("audio_seconds")}
            if j.get("state") != "done":
                row["error"] = (j.get("error") or j.get("state") or "?")[:140]; out["windows"].append(row); continue
            os.makedirs(f"{WORK}/raw", exist_ok=True)
            # never overwrite a scored run's raw output (eta-refuter-2 #418.3): key by attempt, O_EXCL
            att = 1
            while True:
                rp = f"{WORK}/raw/{fn}.a{att}.run{k+1}.json"
                try:
                    fd = os.open(rp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); break
                except FileExistsError:
                    att += 1
            with open(fd, "w") as fh:
                json.dump(j, fh)
            row_raw = os.path.basename(rp)
            twin_txt = j.get("transcript_native") or ""
            st_txt = r["txt"] or ""
            n1, n2 = norm(st_txt), norm(twin_txt)
            segs = j.get("segments") or []
            row.update({
                "stored_chars": len(st_txt), "twin_chars": len(twin_txt),
                "char_sim": round(Levenshtein.normalized_similarity(n1, n2), 4) if (n1 or n2) else 1.0,
                "token_sort": round(fuzz.token_sort_ratio(n1, n2) / 100, 4) if (n1 or n2) else 1.0,
                "audio_sha_match": bool(shas.get(r["id"])), "ngram_stored": ngram_ratio(st_txt), "ngram_twin": ngram_ratio(twin_txt),
                "stored_indic_share": round(len(INDIC_RE.findall(st_txt)) / max(1, len(st_txt)), 3),
                "twin_indic_share": round(len(INDIC_RE.findall(twin_txt)) / max(1, len(twin_txt)), 3),
                "lang_stored": r["dl"], "lang_twin": j.get("dominant_language"), "lang_same": (r["dl"] or "").lower()[:2] == (j.get("dominant_language") or "").lower()[:2],
                "status_stored": mj.get("route_outcome", {}).get("status"), "status_twin": j.get("status"),
                "n_eng_seg_stored": mj.get("route_outcome", {}).get("n_engine_segments"),
                "segs_stored": mj.get("segment_count"), "segs_twin": len(segs),
                "refused_twin": sum(1 for s in segs if isinstance(s, dict) and s.get("refused")),
                "repaired_twin": sum(1 for s in segs if isinstance(s, dict) and s.get("repair_applied")),
                "engine_mix_stored": (mj.get("language_timeline") or {}).get("engine_mix"),
                "engine_mix_twin": dict(collections.Counter(s.get("engine") for s in segs if isinstance(s, dict) and s.get("text"))),
            })
            em, lm, tot = span_match(spans_of(mj.get("language_timeline")), [s for s in segs if isinstance(s, dict)])
            row.update({"span_engine_agree": None if em is None else round(em, 3), "span_lang_agree": None if lm is None else round(lm, 3), "stored_span_s": round(tot, 1)})
            out["windows"].append(row)
            print(f"{r['group']} {r['id'][-6:]} run{k+1} wall={wall:.0f}s sim={row['char_sim']} lang {row['lang_stored']}->{row['lang_twin']} engines {row['engine_mix_stored']}->{row['engine_mix_twin']} span_eng={row['span_engine_agree']} refused={row['refused_twin']}", flush=True)
            json.dump(out, open(a.out, "w"), indent=1)
        try:
            os.remove(path)
        except OSError:
            pass
    json.dump(out, open(a.out, "w"), indent=1)
    print("DONE")


if __name__ == "__main__":
    main()
