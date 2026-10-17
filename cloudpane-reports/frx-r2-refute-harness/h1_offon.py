"""Refuter harness 1: D1 OFF oracle (500 consults, seeds 1000-1499, no filtering) and ON measures vs base and R1b."""
import copy, json, re, sys, tempfile, collections
from pathlib import Path
import eta2fs_base.pipeline as B
import eta2fs_r1b.pipeline as R1B
import tools.eta2freescript.pipeline as P
from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.validate import check, printable_errors
from tools.eta2freescript.r1_floors import posted_hits
from test_r1_floors import gen_consult
from tools.eta2freescript.guard import numerals

VOL = ("artifact_id", "created_at")


def key(a):
    a = copy.deepcopy(a)
    for k in VOL:
        a.pop(k, None)
    for k in ("run_id", "code_sha256"):
        a.get("generator", {}).pop(k, None)
    return json.dumps(a, sort_keys=True)


def run(mod, seed, out, **kw):
    c, enc, llm = gen_consult(seed)
    f = FakeClient({"stageA": enc, "stageB": llm})
    lg = mod.run_consult(c, f, out, mod.Options(**kw))
    return lg, f.calls, c


def files(out, uid):
    d = Path(out) / uid
    return {n: (d / n).read_text() if (d / n).exists() else None for n in ("artifact.json", "artifact.v0.1.json", "artifact.rejected.json")}


def fkey(s):
    return None if s is None else key(json.loads(s))


tmp = Path(tempfile.mkdtemp())
SEEDS = range(1000, 1500)
off = collections.Counter()
on = collections.Counter()
first_diff = {}
for s in SEEDS:
    b, bc, c = run(B, s, tmp / "b", )
    o, oc, _ = run(P, s, tmp / "o", notes_only=False)
    checks = {
        "note": o["artifact"]["note_text"] == b["artifact"]["note_text"],
        "artifact": key(o["artifact"]) == key(b["artifact"]),
        "calls": oc == bc,
        "written": o["written"] == b["written"],
        "final_errors": o["final_errors"] == b["final_errors"],
        "log": {k: v for k, v in o.items() if not k.startswith("secs") and k != "artifact"} == {k: v for k, v in b.items() if not k.startswith("secs") and k != "artifact"},
        "files": {k: fkey(v) for k, v in files(tmp / "o", c.uid).items()} == {k: fkey(v) for k, v in files(tmp / "b", c.uid).items()},
    }
    for k, v in checks.items():
        off[k] += v
        if not v and k not in first_diff:
            first_diff[k] = s
    # ON: R1b and R2
    r1, _, _ = run(R1B, s, tmp / "r1b", notes_only=True)
    r2, r2c, _ = run(P, s, tmp / "r2", notes_only=True)
    bm = [m["name"] for m in b["artifact"]["gp_extraction"].get("medicines") or []]
    m1 = [m["name"] for m in r1["artifact"]["gp_extraction"].get("medicines") or []]
    m2 = [m["name"] for m in r2["artifact"]["gp_extraction"].get("medicines") or []]
    on["base_written"] += b["written"]; on["r1b_written"] += r1["written"]; on["r2_written"] += r2["written"]
    on["base_meds"] += len(bm); on["r1b_meds"] += len(m1); on["r2_meds"] += len(m2)
    on["base_meds_written"] += len(bm) * b["written"]; on["r1b_meds_written"] += len(m1) * r1["written"]; on["r2_meds_written"] += len(m2) * r2["written"]
    on["r2_vs_r1b_meds_differ"] += m1 != m2
    on["r2_vs_r1b_written_differ"] += r1["written"] != r2["written"]
    on["r2_vs_r1b_note_differ"] += r1["artifact"]["note_text"] != r2["artifact"]["note_text"]
    # doctor-confirmed: said by doctor (spk 0), named, duration on tape
    cons = [l for l in c.turns if l.role == "doctor" and l.text.startswith("Take ") and "this tablet" not in l.text]
    for t in cons:
        g = t.text.split()[1]
        # a doctor-confirmed drug that base posts: does R2 post it?
        if any(g in n for n in bm):
            on["confirmed_base"] += 1
            on["confirmed_r1b"] += any(g in n for n in m1)
            on["confirmed_r2"] += any(g in n for n in m2)
            on["confirmed_r2_written"] += any(g in n for n in m2) and r2["written"]
    errs = r2["final_errors"]
    for e in errs:
        on["r2_rej:" + re.sub(r"\d+", "N", e)[:70]] += 1
    for e in r1["final_errors"]:
        on["r1b_rej:" + re.sub(r"\d+", "N", e)[:70]] += 1
    # safety floors on R2 ON written artifacts
    if r2["written"]:
        a = r2["artifact"]
        on["r2_posted_hits"] += len(posted_hits(a["gp_extraction"]))
        on["r2_printable_errs"] += bool(printable_errors(a["note_text"], [x.get("prompt") or "" for x in a.get("completion_required") or []]))
        on["r2_check_errs"] += bool(check(a))
        on["r2_brackets_note"] += bool(re.search(r"[\[\]{}<>]|__|\bTBD\b|\bXX\b", a["note_text"]))
        lo, hi = a["clip_boundary"].get("t0") or a["clip_boundary"].get("clip_t0"), None
        for i, m in enumerate(a["gp_extraction"].get("medicines") or []):
            own = [p for p in a["provenance"] if p.get("json_pointer") == f"/medicines/{i}"]
            qs = numerals(" ".join((e.get("quote_en") or "") + " " + (e.get("quote") or "") for p in own for e in p["evidence"] if e.get("speaker") == "doctor"))
            if not own or not qs.strip():
                on["r2_med_no_doctor_tape"] += 1
            for f in ("strength", "frequency", "duration", "instructions"):
                for d in re.findall(r"\d+", str(m.get(f) or "")):
                    if d not in qs and d not in " ".join(e.get("quote_en") or "" for p in own for e in p["evidence"]):
                        on["r2_dose_digit_off_tape"] += 1
print("OFF 500:", dict(off), "first diffs:", first_diff)
for k in sorted(on):
    print(k, on[k])
