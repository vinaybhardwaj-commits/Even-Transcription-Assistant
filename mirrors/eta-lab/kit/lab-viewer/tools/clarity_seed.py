#!/usr/bin/env python3
"""CLARITY page data (Fable 07:50 order): build / load the per-clip data behind /clarity in the private eta-lab-ratings bucket.

  clarity_seed.py build      --out ~/eta-data/clarity-build                 # verifies every input sha, encodes the 200 clips to opus/webm, writes clarity/clips.json
  clarity_seed.py load       --dir ~/eta-data/clarity-build                 # puts clarity/clips.json + clarity/audio/Lnnn.webm; refuses to replace an existing object
  clarity_seed.py load-fixed --file <router-fix clarity_fixed.json>         # clarity/fixed.json (the FIXED ROUTER column); replaces the old one, keeping it under clarity/fixed-history/
  clarity_seed.py build-scorecard --s1 <router-fix file> --s2 <cap file> --s3 <linker file> --out <dir>   # W33.5: validates the shapes in lab-viewer/SCORECARD-SHAPES.md, writes <dir>/clarity/scorecard.json (any of the three may be omitted = "pending")
  clarity_seed.py load-scorecard --file <dir>/clarity/scorecard.json        # clarity/scorecard.json; replaces the old one, keeping it under clarity/scorecard-history/

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


def put_replacing(key, f, history):
    """put key from file; an existing object is first copied to <history>/<epoch>.json (never lost)"""
    if exists(key):
        old = wr("get", f"{BUCKET}/{key}", "--pipe").stdout
        with tempfile.NamedTemporaryFile(suffix=".json") as t:
            t.write(old); t.flush()
            put(f"{history}/{int(time.time())}.json", t.name, "application/json")
    put(key, f, "application/json")


LANGS = {"en", "hi", "kn", "ta", "te", "ml", "hi-en", "kn-en", "mr", "bn", "gu", "pa", "or", "und", "mixed", "none", "all"}
CONDS = {"clean", "fan10", "babble5", "all"}


def _num(v, lo, hi, where):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not lo <= v <= hi:
        sys.exit(f"scorecard: {where}: number outside {lo}..{hi}")


def _check_side(d, keys, where):
    if not isinstance(d, dict):
        sys.exit(f"scorecard: {where}: old/new must be objects")
    for k in keys:
        if d.get(k) is not None:
            _num(d[k], 0, 100, f"{where}.{k}")


def check_score(name, d):
    if not isinstance(d, dict) or d.get("schema") != 1 or not isinstance(d.get("rows"), list) or not d["rows"] or len(d["rows"]) > 200:
        sys.exit(f"scorecard {name}: needs schema 1 and 1..200 rows")
    if not re.fullmatch(r"[0-9a-f]{12,64}", str(d.get("prereg_sha256", ""))):
        sys.exit(f"scorecard {name}: prereg_sha256 (the pre-registration sha, hex) is required: results must be pre-registered before the run")
    for i, r in enumerate(d["rows"]):
        w = f"{name}.rows[{i}]"
        if name == "s1":
            if r.get("lang") not in LANGS or r.get("cond") not in CONDS: sys.exit(f"scorecard: {w}: bad lang/cond")
            keys = ("wer", "cer", "hit")
        elif name == "s2":
            if not (r.get("scope") in ("overall", "drugs") or r.get("scope") in LANGS): sys.exit(f"scorecard: {w}: bad scope")
            keys = ("captured_pct", "lo", "hi")
        else:
            if r.get("lang") not in LANGS: sys.exit(f"scorecard: {w}: bad lang")
            keys = ("wrong_pct",)
        _check_side(r.get("old"), keys, w + ".old"); _check_side(r.get("new"), keys, w + ".new")
        if r.get("n") is not None: _num(r["n"], 0, 1e6, w + ".n")
    if name == "s3":
        j = d.get("judge")
        if not isinstance(j, dict) or not isinstance(j.get("accuracy"), dict):
            sys.exit("scorecard s3: judge {model, validated_on, accuracy:{overall, per_lang}, usable} is required (the judge must be proven on the SELFTEST audio first)")
        per = j["accuracy"].get("per_lang") or {}
        _num(j["accuracy"].get("overall"), 0, 100, "s3.judge.accuracy.overall")
        for k, v in per.items():
            _num(v, 0, 100, f"s3.judge.accuracy.per_lang.{k}")
        langs = {r["lang"] for r in d["rows"] if r["lang"] != "all"}
        derived = j["accuracy"]["overall"] >= 95 and all(k in per and per[k] >= 90 for k in langs) and all(v >= 90 for v in per.values())
        if j.get("usable") is True and not derived:   # W33 gate: a `true` flag may not contradict its own numbers (a stricter `false`, e.g. min n per label, is the evaluator's call and is honoured)
            sys.exit(f"scorecard s3: judge.usable=true but the accuracy numbers do not pass the gate (needs >=95 overall and >=90 in every language in the rows)")


def build_scorecard(s1, s2, s3, out):
    os.umask(0o077)
    doc = {"schema": 1, "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "source_sha256": {}}
    for name, f in (("s1", s1), ("s2", s2), ("s3", s3)):
        if f:
            d = json.loads(Path(f).read_text())
            check_score(name, d)
            doc[name] = d
            doc["source_sha256"][name] = sha(f)
    if not any(k in doc for k in ("s1", "s2", "s3")):
        sys.exit("give at least one of --s1 --s2 --s3")
    base = Path(out); base.mkdir(parents=True, exist_ok=True); base.chmod(0o700)
    d = base / "clarity"; d.mkdir(exist_ok=True); d.chmod(0o700)
    (d / "scorecard.json").write_text(json.dumps(doc, ensure_ascii=False)); private_file(d / "scorecard.json")
    print("scorecard.json built with " + ", ".join(k for k in ("s1", "s2", "s3") if k in doc))


def load_scorecard(f):
    d = json.loads(Path(f).read_text())
    for name in ("s1", "s2", "s3"):
        if name in d: check_score(name, d[name])
    put_replacing("clarity/scorecard.json", f, "clarity/scorecard-history")
    print("put clarity/scorecard.json")


def load_fixed(f):
    d = json.loads(Path(f).read_text())
    rows = d.get("rows")
    if d.get("schema") != 1 or not isinstance(rows, dict) or not rows:
        sys.exit("fixed file: schema must be 1 with a non-empty rows object")
    for k, v in rows.items():
        if not ID.match(k) or not isinstance(v, dict) or not re.match(r"^[a-z]{2,8}$", str(v.get("tag", ""))):
            sys.exit(f"fixed file: bad row {k!r}")
    put_replacing("clarity/fixed.json", f, "clarity/fixed-history")
    print(f"put clarity/fixed.json ({len(rows)} rows)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build").add_argument("--out", required=True)
    l = sub.add_parser("load"); l.add_argument("--dir", required=True); l.add_argument("--resume", action="store_true")
    sub.add_parser("load-fixed").add_argument("--file", required=True)
    bs = sub.add_parser("build-scorecard"); [bs.add_argument(x) for x in ("--s1", "--s2", "--s3")]; bs.add_argument("--out", required=True)
    sub.add_parser("load-scorecard").add_argument("--file", required=True)
    a = ap.parse_args()
    {"build": lambda: build(a.out), "load": lambda: load(a.dir, a.resume), "load-fixed": lambda: load_fixed(a.file), "build-scorecard": lambda: build_scorecard(a.s1, a.s2, a.s3, a.out), "load-scorecard": lambda: load_scorecard(a.file)}[a.cmd]()
