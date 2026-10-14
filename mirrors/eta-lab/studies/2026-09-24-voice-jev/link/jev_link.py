#!/usr/bin/env python3
"""vj-link step 4 (box; the de-id model and the Jev key are here): Q1 (frozen card wording) and LQ (frozen, sha12 04545aae3478) on each proposed link's voice, plus the REQUIRED paired control.
 Refuses to run unless LQ-FREEZE.md hashes to the approved sha12 (ruling 189) and the arms' freeze.txt to b961291ae64c (arms/common.py).
 State (LQ-FREEZE.md template): voice A's turns only (<= 12 per consult, <= 8 consults, <= 300 chars, time order, offset in the consult), de-identified with surgery-review-v2/deid.py (V's rulings 42/43),
 plus the Rx items of those consults. CONTROL: identical turns + the item list of a DIFFERENT doctor of the same date (seeded, 24092026); LQ must say no (noul < 0.5) there or LQ is void for the link.
 Jev term (rule 7) = Q1 doctor confidence >= 0.70 AND LQ noul >= 0.5 AND control noul < 0.5.
Inputs (box): ~/eta-data/voice-linkage/pilot/{jev_in.json (from assemble.py: card_id, rd, doctor_uid, doctor_name, consults[{called_ms, completed_ms, turn_idx}]), turns-<rd>.json, rx-<date>.json}.
Out: ~/eta-data/voice-linkage/pilot/jev/<card_id>.json (numbers only, no text).   Usage: jev_link.py [--backend jev|mock] [--only CARD_ID]"""
import argparse, hashlib, json, os, random, subprocess, sys
ARMS = os.environ.get("ARMS_DIR", "/tmp/armsreuse")           # origin/main studies/2026-09-24-voice-jev/arms (freeze.txt, common.py, addenda)
LAB = os.path.expanduser("~/dev/eta-lab"); PD = os.path.expanduser("~/eta-data/voice-linkage/pilot"); HERE = os.path.dirname(os.path.abspath(__file__))
LQ_SHA12 = "04545aae3478"; SEED = 24092026
sys.path.insert(0, ARMS)
import common as C

ap = argparse.ArgumentParser(); ap.add_argument("--backend", choices=["jev", "mock"], default="jev"); ap.add_argument("--only"); ap.add_argument("--diag", action="store_true", help="ruling 203: build the states, print COUNTS ONLY, call nothing, write nothing"); ap.add_argument("--freeze-file", default=f"{HERE}/LQ-FREEZE.md")
a = ap.parse_args()
raw = open(a.freeze_file).read()


def awk_block(text):
    """Exactly the freeze command: awk '/<!-- LQ-BEGIN -->/{f=1;next}/<!-- LQ-END -->/{f=0}f'  (line by line; the marker lines themselves are not printed).
    NB the file's own header quotes that command, so its first line sets f=1 too: the frozen text therefore includes the blank line before the real BEGIN marker. That IS the approved hash."""
    out, f = [], False
    for line in text.splitlines(keepends=True):
        if "<!-- LQ-BEGIN -->" in line: f = True; continue
        if "<!-- LQ-END -->" in line: f = False
        if f: out.append(line)
    return "".join(out)


blk = awk_block(raw)
sha = hashlib.sha256(blk.encode()).hexdigest()
if not sha.startswith(LQ_SHA12): raise SystemExit(f"LQ block sha {sha[:12]} != approved {LQ_SHA12}: refusing to run")
C.stamp()
LQ_TEXT = blk.split("LQ (yes/no): ")[1].split("\n")[0].strip()
HEADER = ("Room consultation recorded on {date}. One voice (\"voice A\") was picked out of this room's audio; below are ONLY voice A's transcript turns from {n} consults, in time order, "
          "guarded text (English alongside Kannada/Hindi where available). Turns from every other voice are left out.\nVoice A turns:\n")
ITEMS_HEAD = "Items that a doctor prescribed or ordered for the patients in these consults (drug, dose, frequency, duration, tests):\n"
MAX_T, MAX_C, MAX_CH = 12, 8, 300


def deid(texts, doctor):
    inp, outp = f"{PD}/_deid_in.json", f"{PD}/_deid_out.json"
    json.dump({"turns": [{"id": str(i), "text": t, "doctor": doctor} for i, t in enumerate(texts)]}, open(inp, "w")); os.chmod(inp, 0o600)
    if os.path.exists(outp): os.remove(outp)
    r = subprocess.run([os.path.expanduser("~/eta-data/deid/venv/bin/python"), f"{LAB}/studies/2026-09-24-surgery-review-v2/deid.py", inp, outp], capture_output=True, text=True)
    os.remove(inp)
    if r.returncode: raise SystemExit("DEID FAILED (fail closed): " + r.stderr[-200:])
    m = {t["id"]: t["text"] for t in json.load(open(outp))["turns"]}; os.remove(outp)
    return [m[str(i)] for i in range(len(texts))]


def item_str(rx):
    parts = []
    for m in rx["meds"]:
        nm = " ".join(x for x in [m.get("brand_name"), f"({m['generic_name']})" if m.get("generic_name") else None] if x)
        parts.append(" ".join(str(x) for x in [nm, m.get("strength"), m.get("dosage"), m.get("frequency"), m.get("duration")] if x))
    parts += [t["name"] for t in rx["tests"] if t.get("name")]
    return "; ".join(p for p in parts if p)


def items_for(rxs, consults_start_end):
    lines = []
    for n, (a_ms, b_ms) in enumerate(consults_start_end, 1):
        mine = [r for r in rxs if a_ms - 120_000 <= r["start_ms"] <= b_ms + 120_000]
        s = "; ".join(x for x in (item_str(r) for r in mine) if x)
        lines.append(f"- consult {n}: {s if s else '(no drug or test recorded)'}")
    return ITEMS_HEAD + "\n".join(lines) + "\n"


def qs_lq(): return {"lq": {"type": "noul", "instructions": LQ_TEXT}}


def call(state, qs, backend):
    if backend == "mock":
        h = int(hashlib.sha256((state + json.dumps(qs)).encode()).hexdigest(), 16)
        return {"answers": {"q1": {"choice": C.Q1_KEYS[h % 5], "confidence": 0.5 + (h >> 8) % 50 / 100, "probabilities": {}}, "lq": {"noul": (h >> 16) % 100 / 100}}}
    return C.jev_call(state, qs)


os.makedirs(f"{PD}/jev", exist_ok=True)
jin = json.load(open(f"{PD}/jev_in.json"))
for L in jin:
    if a.only and L["card_id"] != a.only: continue
    rd = L["rd"]; T = json.load(open(f"{PD}/turns-{rd}.json")); date = T["room"]["date"]
    rx = [r for r in json.load(open(f"{PD}/rx-{date}.json")) if not r["is_draft"]]
    cons = sorted(L["consults"], key=lambda c: c["called_ms"])[:MAX_C]; texts, meta = [], []
    for ci, c in enumerate(cons, 1):
        for i in sorted(c["turn_idx"], key=lambda i: int(T["turns"][i]["s_ms"]))[:MAX_T]:
            t = T["turns"][i]
            if t.get("text"): texts.append(t["text"][:MAX_CH]); meta.append((ci, (int(t["s_ms"]) - c["called_ms"]) // 1000))
    if not texts: print(L["card_id"], "no turns"); continue
    safe = deid(texts, L["doctor_name"])
    body = HEADER.format(date=date, n=len(cons)) + "".join(f'[consult {ci}, {max(o, 0) // 60:02d}:{max(o, 0) % 60:02d}] "{s}"\n' for (ci, o), s in zip(meta, safe))
    windows = [(c["called_ms"], c["completed_ms"]) for c in cons]
    mine = [r for r in rx if r["doctor_uid"] == L["doctor_uid"]]
    others = sorted({r["doctor_uid"] for r in rx if r["doctor_uid"] != L["doctor_uid"]}); rng = random.Random(SEED + int(L["card_id"], 16))
    od = rng.choice([d for d in others if sum(1 for r in rx if r["doctor_uid"] == d and (r["meds"] or r["tests"])) >= 5] or others)
    orx = [r for r in rx if r["doctor_uid"] == od and (r["meds"] or r["tests"])]; rng.shuffle(orx)
    # control items: the other doctor's Rx of 8 random consults, laid out per consult of this card (same count and format)
    ctrl_lines = ITEMS_HEAD + "\n".join(f"- consult {n}: {item_str(orx[n - 1]) if n <= len(orx) and item_str(orx[n - 1]) else '(no drug or test recorded)'}" for n in range(1, len(cons) + 1)) + "\n"
    st_lq, st_ctrl = body + items_for(mine, windows), body + ctrl_lines
    if a.diag:
        import re
        tags = sum(len(re.findall(r"\[[A-Z_]+\]", x)) for x in safe); chg = sum(1 for o, n in zip(texts, safe) if o != n)
        own_lines = [l for l in items_for(mine, windows).splitlines() if l.startswith("- consult")]; ctl_lines = [l for l in ctrl_lines.splitlines() if l.startswith("- consult")]
        emp = lambda ls: sum(1 for l in ls if "(no drug or test recorded)" in l)
        ow = {w for l in own_lines for w in re.findall(r"[a-z]{5,}", l.lower())}; cw = {w for l in ctl_lines for w in re.findall(r"[a-z]{5,}", l.lower())}
        jf = f"{PD}/jev/{L['card_id']}.json"; j = json.load(open(jf)) if os.path.exists(jf) else {}
        print(json.dumps({"card": L["card_id"], "turns": len(texts), "turn_chars": sum(len(x) for x in texts), "consults": len(cons), "deid_tags": tags, "turns_changed_by_deid": chg,
                          "own_item_lines_empty": f"{emp(own_lines)}/{len(own_lines)}", "ctrl_item_lines_empty": f"{emp(ctl_lines)}/{len(ctl_lines)}", "own_item_words": len(ow), "ctrl_item_words": len(cw), "item_word_overlap_own_ctrl": len(ow & cw),
                          "state_chars_lq": len(st_lq), "state_chars_ctrl": len(st_ctrl), "lq": j.get("lq_noul"), "ctrl": j.get("control_noul"), "void": j.get("lq_void"), "q1": j.get("q1_choice")}))
        continue
    q1 = call(body + "\n(THIS TURN = voice A's turns above, taken together.)\n", C.questions(L["doctor_name"]), a.backend)["answers"]["q1"]
    lq = call(st_lq, qs_lq(), a.backend)["answers"]["lq"]["noul"]; ct = call(st_ctrl, qs_lq(), a.backend)["answers"]["lq"]["noul"]
    q1p = (q1.get("probabilities") or {}).get("doctor"); doc_conf = q1.get("confidence") if q1["choice"] == "doctor" else 0.0
    res = {"card_id": L["card_id"], "n_consults": len(cons), "n_turns": len(texts), "q1_choice": q1["choice"], "q1_confidence": q1.get("confidence"), "q1_p_doctor": q1p,
           "lq_noul": lq, "control_noul": ct, "lq_void": ct >= 0.5, "jev_term": bool(doc_conf is not None and doc_conf >= 0.70 and lq >= 0.5 and ct < 0.5),
           "backend": a.backend, "lq_sha12": LQ_SHA12, "freeze_sha12": C.FREEZE_SHA12, "state_chars": len(st_lq)}
    json.dump(res, open(f"{PD}/jev/{L['card_id']}.json", "w"), indent=1)
    print(L["card_id"], {k: res[k] for k in ("q1_choice", "q1_confidence", "lq_noul", "control_noul", "lq_void", "jev_term")})
