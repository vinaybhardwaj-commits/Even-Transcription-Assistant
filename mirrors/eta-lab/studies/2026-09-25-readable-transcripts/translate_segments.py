"""READABLE TRANSCRIPTS 337b (PREREG-337b.md + A1 + A2 + A3): English for every kn/hi/ta/ml/bn/gu/te/mr segment of the indexed windows, on the link-3 route (OpenRouter google/gemini-3.8-flash, ZDR).

Doctor-only path: NO de-identification, nothing to Jev. Output = lab-viewer's annotation files under ~/eta-data/lab-vault/staged/annotations/translation/ (0600, write-once, one NEW file per flush and room-day);
this script never pushes to the vault and never writes a run record, the index or a native text. The key is read only inside link3_translate.get_key() and never printed, logged or stored.
Logs carry counts, statuses and reasons, never text.

    python3 translate_segments.py select            # counts only
    python3 translate_segments.py preflight         # one invented line; binds this script's, the route script's and the pre-registrations' commits
    python3 translate_segments.py run [--max-windows N]
    python3 translate_segments.py report            # counts by date from the annotation files
    python3 translate_segments.py selftest
"""
import collections
import glob
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "2026-09-24-surgical-chain", "p1"))
import link3_translate as L                                            # the reviewed route: prompt, get_key, transport, one_batch, translate_item (line isolation)

HOME = os.path.expanduser("~/eta-data/")
INDEX_DIR = HOME + "lab-vault/staged/index/"                            # A2.1: the viewer's live index, the newest view-*.jsonl, read afresh at every run
ROOTS = (HOME + "hist-mining/", HOME + "hist/", HOME + "lab-vault/staged/")     # A2.1: first that exists
ANN = HOME + "lab-vault/staged/annotations/translation/"
OPS = HOME + "translate-337b/"                                          # box-only operational files: preflight and the call log (no text)
PREREGS = ("PREREG-337b.md", "PREREG-337b-A1.md", "PREREG-337b-A2.md", "PREREG-337b-A3.md")
LANGS = ("kn", "hi", "ta", "ml", "bn", "gu", "te", "mr")              # T1: exactly the ruling's list; und and pa are counted, not sent
PREFLIGHT_LINE = "Good morning, please have a seat."                   # invented; no patient text
IST = timezone(timedelta(hours=5, minutes=30))
FLUSH_EVERY = 10
MAX_K = 400                                                             # A3.1: the vault Worker accepts at most 400 distinct k per annotation file
ERRS = ("isolated_line_failed", "route_mismatch", "http_failed", "malformed_twice", "retries_exhausted", "all_lines_failed")   # A1.1: the closed list of failure reasons


def read_json(path):
    with open(path) as f:
        return json.load(f)


def sha256_text(t):
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def mkdirs_private(path, base):
    """Create path and every missing level below base as 0700 (os.makedirs' mode applies to the leaf only)."""
    base = base.rstrip("/"); path = path.rstrip("/")
    os.makedirs(base, mode=0o700, exist_ok=True); os.chmod(base, 0o700)
    cur = base
    for part in os.path.relpath(path, base).split("/"):
        if part in ("", "."):
            continue
        cur = cur + "/" + part
        if not os.path.isdir(cur):
            os.mkdir(cur, 0o700)
        os.chmod(cur, 0o700)


def resolve(key, roots=ROOTS):
    for r in roots:
        if os.path.exists(r + key):
            return r + key
    return None


def segments_of(doc):
    return doc["payload"]["segments"] if isinstance(doc.get("payload"), dict) and "segments" in doc["payload"] else doc.get("segments")


def wkey(key):
    """lab-viewer's k: the window key without the leading runs/ and the trailing .json."""
    if not (key.startswith("runs/") and key.endswith(".json")):
        raise ValueError("window key must look like runs/<...>.json")
    return key[len("runs/"):-len(".json")]


def latest_index(index_dir=INDEX_DIR):
    fs = sorted(glob.glob(index_dir + "view-*.jsonl"), key=os.path.basename)
    if not fs:
        raise SystemExit("refused: no view-*.jsonl index found")
    return fs[-1]


def k_parts(k):
    """(room, date) from k = <run_id>/<room>/<date>/<window>: the Worker files an annotation by these."""
    parts = k.split("/")
    if len(parts) < 4:
        raise ValueError("k must be <run_id>/<room>/<date>/<window>")
    return parts[-3], parts[-2]


def select(index=None, roots=ROOTS):
    """(jobs, stats, lang counts). A job is one window with a room id and at least one in-scope segment, newest date first (22-24 Sep, then backwards), by start within a date."""
    index = index or latest_index()
    with open(index) as f:
        rows = [json.loads(l) for l in f if l.strip()]
    stats = collections.Counter(); lang = collections.Counter(); jobs = []
    stats["windows"] = len(rows)
    for w in rows:
        p = resolve(w["key"], roots)
        if p is None:
            stats["unresolved"] += 1; continue
        with open(p, "rb") as f:
            raw = f.read()
        segs = segments_of(json.loads(raw))
        if not segs:
            stats["no_segments"] += 1; continue
        todo = []
        for i, s in enumerate(segs):
            lang[s.get("lang")] += 1
            if s.get("lang") in LANGS and isinstance(s.get("text"), str) and s["text"].strip():
                todo.append((i, s["lang"], s["text"]))
        if not todo:
            stats["no_scope_segments"] += 1; continue
        if not w.get("room_id"):
            stats["no_room_id"] += 1; stats["no_room_id_segments"] += len(todo); continue
        k = wkey(w["key"]); room_k, date_k = k_parts(k)
        if (room_k, date_k) != (w["room_id"], w["ist_date"]):
            stats["k_mismatch"] += 1                                                     # A3.1: k decides the file path
        stats["in_scope_segments"] += len(todo); stats["in_scope_windows"] += 1
        jobs.append(dict(key=w["key"], k=k, room=room_k, date=date_k, start=w.get("start") or "", rec_sha=hashlib.sha256(raw).hexdigest(), todo=todo))
    jobs.sort(key=lambda j: j["start"])
    jobs.sort(key=lambda j: j["date"], reverse=True)
    return jobs, dict(stats), dict(lang)


# ---- the annotation files are the state (A1.2) ----
def ann_files(ann=ANN):
    return sorted(glob.glob(ann + "*/*/*-linker.json"), key=os.path.basename)          # file-name order: the last item per (k, i) wins


def last_items(ann=ANN):
    last = {}
    for p in sorted(ann_files(ann), key=lambda p: os.path.basename(p)):
        for it in read_json(p)["items"]:
            last[(it["k"], it["i"])] = it
    return last


def remaining(job, last):
    """The job's in-scope segments that are not done: no last item with en and the same src_sha256."""
    out = []
    for i, lg, t in job["todo"]:
        it = last.get((job["k"], i))
        if it and "en" in it and "err" not in it and it["src_sha256"] == sha256_text(t):
            continue
        out.append((i, lg, t))
    return out


def status_to_err(status):
    s = status or ""
    if s.startswith("MT_ROUTE_MISMATCH"): return "route_mismatch"
    if "malformed reply twice" in s: return "malformed_twice"
    if "retries exhausted" in s: return "retries_exhausted"
    if "every line isolated-failed" in s: return "all_lines_failed"
    return "http_failed"


def translate_window(job, todo, send, log, stats=None):
    """Items for the given not-done segments of one window. Raises L.ItemFail when the window fails."""
    rows = [dict(item=job["key"], room="", i=i, lang=lg, at="", src=t) for i, lg, t in todo]
    res, provs, models = L.translate_item(rows, send, log, isolate=True, stats=stats)
    src = {i: t for i, _lg, t in todo}
    items = []
    for r in res:
        it = dict(k=job["k"], i=r["i"], src_sha256=sha256_text(src[r["i"]]), q=r["q"])
        if r["q"] == "mt_failed":
            it["err"] = "isolated_line_failed"
        else:
            it["en"] = r["en"]
        items.append(it)
    return items, provs, models


def failure_items(job, todo, status):
    return [dict(k=job["k"], i=i, src_sha256=sha256_text(t), q="mt_failed", err=status_to_err(status)) for i, _lg, t in todo]


def write_file(path, obj, base):
    mkdirs_private(os.path.dirname(path), base)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)          # write-once: never overwrite
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.chmod(path, 0o600)


def flush(pending, ann, script, prompt_sha, now, index_name=None):
    """pending: {(room, date, provider, model): dict(items=[...], sources={k: run-record sha256})}; room and date come from k (A3.1); provider and model are None for a group of failure items.
    One NEW file per group and per 400 distinct k; the minute in the name is bumped until it is free."""
    written = 0
    for (room, date, provider, model), g in sorted(pending.items(), key=lambda kv: tuple(str(x) for x in kv[0])):
        if not g["items"]:
            continue
        ks = list(g["sources"])
        for n in range(0, len(ks), MAX_K):
            sub = set(ks[n:n + MAX_K])
            t = now
            while True:
                path = f"{ann}{room}/{date}/{t.astimezone(IST).strftime('%Y%m%d%H%M')}-linker.json"
                if not os.path.exists(path):
                    break
                t += timedelta(minutes=1)
            body = dict(schema="eta-lab-annotation/1", kind="translation",
                        provenance=dict(producer="linker", model=model, provider=provider, zdr=True, created_at=now.astimezone(IST).isoformat(), prompt_sha256=prompt_sha,
                                        script_commit=script, index_file=index_name),
                        sources={k: g["sources"][k] for k in ks[n:n + MAX_K]}, items=[it for it in g["items"] if it["k"] in sub])
            write_file(path, body, ann); written += 1
    pending.clear()
    return written


def run(jobs, send, script, ann=ANN, ops=OPS, max_windows=None, now=None, flush_every=FLUSH_EVERY, index_name=None):
    """Translate every job's not-done segments. Returns counts. A failed window is written as failure items (closed reason, no text) and retried by the next run."""
    mkdirs_private(ops, ops)
    log = lambda rec: L.write_private(ops + "calls.jsonl", rec, jsonl=True)
    last = last_items(ann)
    c = collections.Counter(); pending = {}; since = 0
    clock = now if callable(now) else (lambda: now or datetime.now(timezone.utc))
    for job in jobs:
        todo = remaining(job, last)
        if not todo:
            c["skipped_done"] += 1; continue
        if max_windows is not None and c["attempted"] >= max_windows:
            c["left_for_later"] += 1; continue
        c["attempted"] += 1
        st = {}
        try:
            items, provs, models = translate_window(job, todo, send, log, st)
        except L.ItemFail as e:
            c["failed"] += 1; items, provs, models = failure_items(job, todo, e.status), [], []
        else:
            c["done"] += 1; c["isolated_failed_lines"] += st.get("isolated_failed_lines", 0)
        for it in items:
            c["seg_" + it["q"]] += 1
        g = pending.setdefault((job["room"], job["date"], provs[0] if provs else None, models[0] if models else None), dict(items=[], sources={}))    # translate_item guarantees one provider and model per window
        g["items"] += items; g["sources"][job["k"]] = job["rec_sha"]
        since += 1
        if since >= flush_every:
            c["files"] += flush(pending, ann, script, L.prompt_sha256(), clock(), index_name); since = 0
    c["files"] += flush(pending, ann, script, L.prompt_sha256(), clock(), index_name)
    return dict(c)


def report(jobs, ann=ANN):
    """Counts only, from the annotation files: per date, segments translated by q, failed, and not done."""
    last = last_items(ann); by = collections.defaultdict(collections.Counter)
    for job in jobs:
        d = by[job["date"]]
        todo = remaining(job, last)
        d["segments_in_scope"] += len(job["todo"]); d["segments_not_done"] += len(todo)
        d["windows_todo" if todo else "windows_done"] += 1
        for i, _lg, _t in job["todo"]:
            it = last.get((job["k"], i))
            if it: d["items_" + it["q"]] += 1
    return {k: dict(v) for k, v in sorted(by.items(), reverse=True)}


# ---- provenance and preflight (review first, then run) ----
def provenance():
    p = dict(script_sha=L.committed_sha(os.path.abspath(__file__), cwd=HERE), route_sha=L.committed_sha(L.__file__, cwd=os.path.dirname(L.__file__)))
    for n, name in enumerate(PREREGS):
        p["prereg_sha" + ("" if n == 0 else str(n))] = L.committed_sha(os.path.join(HERE, name), cwd=HERE)
    return p


def cmd_preflight(send=None, ops=OPS, prov=None):
    prov = prov or provenance()
    mkdirs_private(ops, ops)
    send = send or L.http_transport(L.get_key())
    log = lambda rec: L.write_private(ops + "calls.jsonl", dict(rec, preflight=True), jsonl=True)
    try:
        _res, provider, model = L.one_batch([PREFLIGHT_LINE], send, log)
    except L.ItemFail as e:
        L.write_private(ops + "preflight.json", dict(ok=False, status=e.status, **prov))
        raise SystemExit(f"preflight failed: {e.status}")
    L.write_private(ops + "preflight.json", dict(ok=True, model_returned=model, provider_returned=provider, model_requested=L.MODEL, prompt_sha256=L.prompt_sha256(), **prov,
                                                 at=datetime.now(timezone.utc).isoformat()))
    print("preflight ok: returned model", model, "| provider", provider)


def require_preflight(ops, prov):
    try:
        pf = read_json(ops + "preflight.json")
    except (OSError, ValueError):
        raise SystemExit("refused: no preflight (run `preflight` first)")
    if not pf.get("ok") or any(pf.get(k) != v for k, v in prov.items()) or pf.get("model_returned") != L.MODEL:
        raise SystemExit("refused: the preflight did not pass for these commits")


def cmd_run(max_windows=None, send=None, ann=ANN, ops=OPS, index=None, roots=ROOTS, prov=None):
    prov = prov or provenance()
    require_preflight(ops, prov)
    index = index or latest_index()
    jobs, stats, _lang = select(index, roots)
    send = send or L.http_transport(L.get_key())
    counts = run(jobs, send, prov["script_sha"], ann, ops, max_windows, index_name=os.path.basename(index))
    print(json.dumps(dict(select=stats, run=counts)))


def main(argv=None):
    a = list(sys.argv[1:] if argv is None else argv)
    cmd = a[0] if a else ""
    if cmd == "select":
        _jobs, stats, lang = select(); print(json.dumps(dict(stats=stats, segments_by_language=lang)))
    elif cmd == "preflight":
        cmd_preflight()
    elif cmd == "run":
        mw = int(a[a.index("--max-windows") + 1]) if "--max-windows" in a else None
        cmd_run(mw)
    elif cmd == "report":
        jobs, _s, _l = select(); print(json.dumps(report(jobs)))
    elif cmd == "selftest":
        r = subprocess.run([sys.executable, os.path.join(HERE, "tests", "test_translate_segments.py")]); sys.exit(r.returncode)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
