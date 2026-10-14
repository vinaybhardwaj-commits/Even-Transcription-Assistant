"""link3_coverage.py: the ruling-200 (A) COVERAGE PASS on the below-floor items. DIAGNOSTIC ONLY: the floor and the question (LINK_QUESTION_V2, P1-PREREG-v7.6) stay frozen and
nothing here is scored as a link-3 result. For each below-floor item: widen the window to the consult +/- 60 min and to EVERY room with text (production text and HIST outputs kept
apart, never mixed inside a room), de-identify and gate, slide 10-minute sub-windows (step 5) and record the best own-prescription score, its room, source and its offset
from the Rx time. Text lives in ~/eta-data/surgical-chain/p1/cov/ (0700); stdout carries item ids, numbers and pseudonymous room labels only; the class key is never read.

  python3 link3_coverage.py build | deid | score
"""
import collections, glob, json, os, shutil, sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "..", "..", "2026-09-24-surgery-review-v2"))
import link3_pilot as P
import link3_run as R
COV = P.BOX + "cov/"; SPAN = timedelta(minutes=60); SUB, STEP = timedelta(minutes=10), timedelta(minutes=5)
MIN_TURNS, MIN_CHARS = 3, 60


def items():
    res = json.load(open(R.RUN + "run_results.json"))
    return sorted(it for it, v in res.items() if v["verdict"] == "REJECT_BELOW_FLOOR")


def all_hist_windows():
    """Every finished HIST output (any run, any root) as (room_id, start, end, path)."""
    out = []
    files = []
    for root in R.ROOTS:
        files += glob.glob(os.path.join(root, "out", "*", "*.json")) + glob.glob(os.path.join(root, "runs", "**", "*.json"), recursive=True)
    for f in files:
        try:
            j = json.load(open(f))
        except Exception:
            continue
        cut = (j.get("cut") or {}) if isinstance(j, dict) else {}
        if isinstance(j, dict) and j.get("ok") is True and j.get("state", "done") == "done" and not j.get("error") and not (isinstance(cut, dict) and cut.get("chunks_dropped")) \
                and j.get("start") and j.get("end") and (j.get("segments") or j.get("turns")):
            out.append((j.get("room_id"), P.iso(j["start"]), P.iso(j["end"]), f))
    return out


def stage_build():
    import mb
    os.makedirs(COV + "raw", mode=0o700, exist_ok=True); os.makedirs(COV + "deid", mode=0o700, exist_ok=True); os.chmod(COV, 0o700)
    blind = {b["item"]: b for b in json.load(open(P.BOX + "link3_inputs_blind.json"))}
    key = json.load(open(P.BOX + "link3_key.json"))                  # only ["rx"] is used; the class fields are never read
    hw = all_hist_windows(); man = {}
    for it in items():
        b = blind[it]; s, e = P.iso(b["start"]), P.iso(b["end"]); lo, hi = s - SPAN, e + SPAN; day = b["day"][:10]
        rx_ts = P.iso(str(mb.query(f"""SELECT "timestamp" FROM "individuals-prescriptions" WHERE uid='{P.ident(key[it]["rx"])}'""")[1][0][0]))
        doc = json.load(open(R.RUN + f"raw/{it}_rxown.json"))["doctor"]
        docs, k = {}, 0
        rows = P.neon(f"""SELECT r.id AS room, cu.at AS at, cu.payload->>'text' AS text, cu.payload->>'language' AS lang FROM cue cu JOIN room_day rd ON rd.id = cu.room_day_id JOIN room r ON r.id = rd.room_id
            WHERE cu.type='stt_turn' AND rd.ist_date='{day}' AND cu.at BETWEEN '{lo.astimezone(timezone.utc).isoformat()}' AND '{hi.astimezone(timezone.utc).isoformat()}' AND coalesce(cu.payload->>'text','')<>'' ORDER BY cu.at""")
        byroom = collections.defaultdict(list)
        for r in rows: byroom[r["room"]].append(r)
        for room, rs in sorted(byroom.items()):
            k += 1; did = f"{it}_prod_r{k}"
            docs[did] = dict(source="production", turns=[{"i": i, "at": r["at"], "orig": r["text"].strip(), "en": r["text"].strip() if (r["lang"] or "").lower() in ("english", "en") else None} for i, r in enumerate(rs)])
        seen = set()
        for room, ws, we, path in sorted(hw, key=lambda z: (str(z[0]), z[1])):
            if ws < hi and we > lo:
                seen.add(room)
        for room in sorted(seen, key=str):
            k += 1; did = f"{it}_hist_r{k}"; turns, dedupe = [], set()
            for r_, ws, we, path in sorted((z for z in hw if z[0] == room and z[1] < hi and z[2] > lo), key=lambda z: z[1]):
                for t in R.hist_turns(path):
                    ta = P.iso(t["at"])
                    if lo <= ta <= hi and (t["at"], t["orig"]) not in dedupe:
                        dedupe.add((t["at"], t["orig"])); turns.append(t)
            turns.sort(key=lambda t: t["at"]); [t.__setitem__("i", i) for i, t in enumerate(turns)]
            docs[did] = dict(source="hist", turns=turns)
        for did, d in docs.items():
            json.dump({"id": did, "doctor": doc, "turns": d["turns"]}, open(COV + f"raw/{did}.json", "w"), ensure_ascii=False)
        shutil.copy(R.RUN + f"deid/{it}_rxown.json", COV + f"deid/{it}_rxown.json")      # the own prescription text was de-identified in the main run
        man[it] = dict(start=b["start"], end=b["end"], rx_ts=str(rx_ts), lo=str(lo), hi=str(hi), docs={d: dict(source=v["source"], turns=len(v["turns"])) for d, v in docs.items()})
        print(it, "day", day, "| production rooms", sum(1 for v in docs.values() if v["source"] == "production"), "| HIST rooms", sum(1 for v in docs.values() if v["source"] == "hist"),
              "| turns", {s_: sum(len(v["turns"]) for v in docs.values() if v["source"] == s_) for s_ in ("production", "hist")})
    json.dump(man, open(COV + "manifest.json", "w")); os.chmod(COV + "manifest.json", 0o600)


def stage_deid():
    P.PILOT = COV
    ids = sorted(f[:-5] for f in os.listdir(COV + "raw") if f.endswith(".json"))
    P_ids = ids
    import subprocess
    py = os.path.expanduser("~/eta-data/deid/venv-gpu/bin/python")
    r = subprocess.run(["flock", os.path.expanduser("~/gpu.lock"), py, os.path.join(P.SR2, "deid_gpu.py"), COV + "raw", COV + "deid"] + P_ids, capture_output=True, text=True, timeout=3000, env={**os.environ, "PYTHONUTF8": "1"})
    bad = [i for i in P_ids if not os.path.exists(COV + f"deid/{i}.json")]
    print("de-identified", len(P_ids) - len(bad), "of", len(P_ids), "files; rc", r.returncode, "| missing:", len(bad))
    if bad or r.returncode: raise SystemExit("de-identification incomplete: nothing will be scored")


def stage_score():
    import link3_judge as lj
    from finalize import residual_identifiers
    man = json.load(open(COV + "manifest.json")); base = json.load(open(R.RUN + "run_results.json"))
    out = {}
    for it, m in sorted(man.items()):
        rx_own = "\n".join(t.get("en") or "" for t in json.load(open(COV + f"deid/{it}_rxown.json"))["turns"])
        rx_ts = P.iso(m["rx_ts"]); lo, hi = P.iso(m["lo"]), P.iso(m["hi"])
        best = dict(score=-1); calls = 0; per_doc = {}; blocked = 0
        for did, dm in m["docs"].items():
            d = json.load(open(COV + f"deid/{did}.json")); tu = [t for t in d["turns"] if (t.get("en") or "").strip()]
            if residual_identifiers([{"i": t["i"], "en": t["en"], "orig": t.get("orig") or ""} for t in tu]):
                blocked += 1; continue
            times = [P.iso(t["at"]) for t in tu]; sc = []
            t0 = lo
            while t0 + SUB <= hi:
                seg = [t for t, ta in zip(tu, times) if t0 <= ta < t0 + SUB]
                txt = "\n".join(f"[{t['i']}] {t['en']}" for t in seg)
                if len(seg) >= MIN_TURNS and len(txt) >= MIN_CHARS:
                    v = lj.score(txt, rx_own, None, lj.LINK_QUESTION_V2); calls += 1
                    off = ((t0 + SUB / 2) - rx_ts).total_seconds() / 60
                    sc.append((v, off)); best = max(best, dict(score=v, offset_min=round(off, 1), doc=did, source=dm["source"]), key=lambda z: z["score"])
                t0 += STEP
            per_doc[did] = dict(source=dm["source"], turns=dm["turns"], sub_windows_scored=len(sc), best=round(max((x[0] for x in sc), default=-1), 3))
        out[it] = dict(best=best, calls=calls, docs=per_doc, gate_blocked_docs=blocked, main_run_best_in_pre_registered_window=base[it].get("best"),
                       rooms_with_text=len(m["docs"]), hist_rooms=sum(1 for v in m["docs"].values() if v["source"] == "hist"), production_rooms=sum(1 for v in m["docs"].values() if v["source"] == "production"))
        b = best
        print(f"{it}: best {round(b['score'],2) if b['score']>=0 else None} | offset from Rx time (min) {b.get('offset_min')} | source {b.get('source')} | rooms with text {out[it]['rooms_with_text']} "
              f"({out[it]['production_rooms']} production, {out[it]['hist_rooms']} HIST) | calls {calls} | pre-registered-window best {out[it]['main_run_best_in_pre_registered_window']}")
    json.dump(out, open(COV + "coverage_results.json", "w"), indent=1); os.chmod(COV + "coverage_results.json", 0o600)


if __name__ == "__main__":
    {"build": stage_build, "deid": stage_deid, "score": stage_score}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: sys.exit(__doc__))()
