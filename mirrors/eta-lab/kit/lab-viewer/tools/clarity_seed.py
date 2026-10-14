#!/usr/bin/env python3
"""CLARITY page data (Fable 07:50 order): build / load the per-clip data behind /clarity in the private eta-lab-ratings bucket.

  clarity_seed.py build      --out ~/eta-data/clarity-build                 # verifies every input sha, encodes the 200 clips to opus/webm, writes clarity/clips.json
  clarity_seed.py load       --dir ~/eta-data/clarity-build                 # puts clarity/clips.json + clarity/audio/Lnnn.webm; refuses to replace an existing object
  clarity_seed.py load-fixed --file <router-fix clarity_fixed.json>         # clarity/fixed.json (the FIXED ROUTER column); replaces the old one, keeping it under clarity/fixed-history/

Inputs (box): ~/eta-data/readability/label200-audio/ (split's wavs + MANIFEST.tsv, sha256 d3bd5a8e...), ~/eta-data/readability/r1/label-page-seed/seed_docs.json (router tag = row `lang`),
~/eta-data/eta-ci-c3-out/ (stt-bench Phase B: whisper.jsonl [forced English], sravaani.jsonl, indic-ctc.jsonl, whisper-lid.jsonl; PHASEB-MANIFEST.json pins their sha256).
The objects hold PHI (transcripts, clip audio): they go ONLY to eta-lab-ratings, which the viewer reads behind Cloudflare Access. Never prints text. Needs
CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID for load / load-fixed (never printed)."""
import argparse, hashlib, json, os, re, subprocess, sys, tempfile, time
from pathlib import Path

BUCKET = "eta-lab-ratings"
HOME = Path.home() / "eta-data"
AUDIO = HOME / "readability" / "label200-audio"
SEED = HOME / "readability" / "r1" / "label-page-seed" / "seed_docs.json"
PB = HOME / "eta-ci-c3-out"
AUDIO_MANIFEST_SHA = "d3bd5a8e2e4686980396ec56d1ed1b4c81e470261061ad25e0d1bac893ff4897"
ID = re.compile(r"^L\d{3}$")
CWD = Path(__file__).resolve().parents[1]


def private_file(p):
    """PHI on a box with a second account (eta-sftp): every file 0600 and every dir 0700, whatever the umask."""
    os.chmod(p, 0o600)


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def jl(p):
    return {r["id"]: r for r in (json.loads(l) for l in Path(p).read_text().splitlines() if l.strip())}


def build(out):
    if sha(AUDIO / "MANIFEST.tsv") != AUDIO_MANIFEST_SHA:
        sys.exit("audio MANIFEST.tsv sha256 does not match d3bd5a8e...: refusing")
    pm = json.loads((PB / "PHASEB-MANIFEST.json").read_text())["outputs"]
    for name in ("whisper", "sravaani", "indic-ctc", "whisper-lid"):
        want = pm[f"out/{name}.jsonl"]["sha256"]
        if sha(PB / f"{name}.jsonl") != want:
            sys.exit(f"{name}.jsonl sha256 does not match PHASEB-MANIFEST: refusing")
    seed = json.loads(SEED.read_text())
    seed = seed["rows"] if isinstance(seed, dict) else seed
    man = {l.split("\t")[0]: l.rstrip("\n").split("\t") for l in (AUDIO / "MANIFEST.tsv").read_text().splitlines()[1:] if l.strip()}
    wh, sv, ic, lid = jl(PB / "whisper.jsonl"), jl(PB / "sravaani.jsonl"), jl(PB / "indic-ctc.jsonl"), jl(PB / "whisper-lid.jsonl")
    os.umask(0o077)   # nothing this script writes is ever group/world readable
    base = Path(out)
    base.mkdir(parents=True, exist_ok=True); base.chmod(0o700)
    out = base / "clarity"
    (out / "audio").mkdir(parents=True, exist_ok=True); out.chmod(0o700); (out / "audio").chmod(0o700)

    def eng(r):
        if not r: return {"st": "missing", "t": ""}
        if r.get("skipped"): return {"st": "skipped", "why": str(r["skipped"])[:120], "t": ""}
        if not r.get("ok"): return {"st": "error", "t": ""}
        t = (r.get("text") or "").strip()
        return {"st": "text" if t else "empty", "t": t}

    rows = []
    for s in seed:
        i = s["id"]
        if not ID.match(i) or i not in man:
            sys.exit(f"{i}: not a clip id or not in the audio manifest")
        L = lid.get(i) or {}
        top3 = L.get("top3") or []
        pen = next((p for c, p in top3 if c == "en"), None)
        rows.append({"id": i, "n": s["n"], "tag": s["lang"], "dur_s": float(man[i][5]), "audio_sha256": man[i][4],
                     "lid": {"name": L.get("detected_language"), "code": top3[0][0] if top3 else None, "p": L.get("prob"), "p_en": pen} if L.get("ok") else None,
                     "whisper": eng(wh.get(i)), "sravaani": eng(sv.get(i)), "indic": eng(ic.get(i))})
        dst = out / "audio" / f"{i}.webm"
        r = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(AUDIO / f"{i}.wav"), "-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-f", "webm", str(dst)])
        if r.returncode: sys.exit(f"ffmpeg failed on {i}")
        private_file(dst)
    doc = {"schema": 1, "audio_manifest_sha256": AUDIO_MANIFEST_SHA, "phaseb_outputs": {k: v["sha256"] for k, v in pm.items() if k.split("/")[1].split(".")[0] in ("whisper", "sravaani", "indic-ctc", "whisper-lid")},
           "rows": sorted(rows, key=lambda r: r["id"])}
    (out / "clips.json").write_text(json.dumps(doc, ensure_ascii=False)); private_file(out / "clips.json")
    print(f"built {len(rows)} clips + audio; clips.json {(out / 'clips.json').stat().st_size} bytes; audio total {sum(p.stat().st_size for p in (out / 'audio').glob('*.webm'))} bytes")


def wr(*a, **kw):
    return subprocess.run(["npx", "wrangler", "r2", "object", *a, "--remote"], capture_output=True, cwd=CWD, **kw)


def put(key, path, ctype):
    r = wr("put", f"{BUCKET}/{key}", "--file", str(path), "--content-type", ctype, text=True)
    if r.returncode: sys.exit(f"FAILED put {key}")


def exists(key):
    r = wr("get", f"{BUCKET}/{key}", "--pipe")
    return r.returncode == 0 and bool(r.stdout)


def load(d, resume=False):
    root = Path(d) / "clarity"
    files = [root / "clips.json"] + sorted((root / "audio").glob("L???.webm"))
    if len(files) != 201:
        sys.exit("expected clips.json + 200 audio files")
    n = skipped = 0
    for p in files:
        key = "clarity/" + str(p.relative_to(root))
        if exists(key):
            if resume:
                skipped += 1
                continue
            sys.exit(f"{key} already exists: refusing to replace it (rerun with --resume after a partial failure to skip what is already there)")
        put(key, p, "application/json" if p.suffix == ".json" else "audio/webm")
        n += 1
    print(f"put {n} objects, skipped {skipped} already present")


def load_fixed(f):
    d = json.loads(Path(f).read_text())
    rows = d.get("rows")
    if d.get("schema") != 1 or not isinstance(rows, dict) or not rows:
        sys.exit("fixed file: schema must be 1 with a non-empty rows object")
    for k, v in rows.items():
        if not ID.match(k) or not isinstance(v, dict) or not re.match(r"^[a-z]{2,8}$", str(v.get("tag", ""))):
            sys.exit(f"fixed file: bad row {k!r}")
    if exists("clarity/fixed.json"):
        old = wr("get", f"{BUCKET}/clarity/fixed.json", "--pipe").stdout
        with tempfile.NamedTemporaryFile(suffix=".json") as t:
            t.write(old); t.flush()
            put(f"clarity/fixed-history/{int(time.time())}.json", t.name, "application/json")
    put("clarity/fixed.json", f, "application/json")
    print(f"put clarity/fixed.json ({len(rows)} rows)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build").add_argument("--out", required=True)
    l = sub.add_parser("load"); l.add_argument("--dir", required=True); l.add_argument("--resume", action="store_true")
    sub.add_parser("load-fixed").add_argument("--file", required=True)
    a = ap.parse_args()
    {"build": lambda: build(a.out), "load": lambda: load(a.dir, a.resume), "load-fixed": lambda: load_fixed(a.file)}[a.cmd]()
