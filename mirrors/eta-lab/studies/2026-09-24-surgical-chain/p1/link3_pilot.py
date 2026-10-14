"""link3_pilot.py: the ruling-191 MECHANICS PILOT for link 3 on the items whose shortlisted rooms all have production text (v7.4/v7.5: a pipeline
exercise, NOT a result). Stages: build (stage raw text on the box), deid (local GPU de-identification), score (gate, then Jev, then the pre-registered rules).
Everything with patient text lives in ~/eta-data/surgical-chain/p1/pilot/ (0700); stdout carries item ids, counts and scores only. The class key is never read.

  python3 link3_pilot.py build | deid | score
"""
import collections, json, os, re, subprocess, sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SR2 = os.path.join(HERE, "..", "..", "2026-09-24-surgery-review-v2")
sys.path.insert(0, HERE); sys.path.insert(0, SR2)
BOX = os.path.expanduser("~/eta-data/surgical-chain/p1/"); PILOT = BOX + "pilot/"; HM = os.path.expanduser("~/eta-data/hist-mining/")
ETA_REPO = os.path.expanduser("~/dev/Even-Transcription-Assistant"); NEON = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")
IDRE = re.compile(r"^[A-Za-z0-9_\-]+$")
PAD = timedelta(minutes=10)                       # pre-registered window: consult +/- 10 min (ruling 191)
FLOOR, MARGIN = 0.50, 0.15                        # v1 section 5
GATE_CHANGE = datetime(2026, 9, 24, 4, 39, tzinfo=timezone(timedelta(hours=5, minutes=30)))


def iso(x):
    x = re.sub(r"Z$", "+00:00", x.strip())
    return datetime.fromisoformat(re.sub(r"\s*([+-]\d{2})(:?)(\d{2})$", r"\1:\3", x.replace(" ", "T", 1)))


def neon(sql):
    r = subprocess.run(["node", NEON, sql], cwd=ETA_REPO, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise SystemExit("neon-select failed (message withheld)")
    return json.loads(r.stdout)


def ident(v):
    if not IDRE.match(str(v)):
        raise SystemExit("unexpected id characters")
    return str(v)


def covered_items():
    ps = json.load(open(HM + "link3_prod_span.json")); sl = json.load(open(HM + "link3_shortlist.json"))
    return sorted(i for i in ps if sl[i]["shortlist"] and all(s in set(ps[i]["shortlisted_with_prod_turns"]) for s in sl[i]["shortlist"])), sl


def stage_build():
    import mb, link3_judge as lj
    os.makedirs(PILOT + "raw", mode=0o700, exist_ok=True); os.chmod(PILOT, 0o700)
    items, sl = covered_items()
    blind = {b["item"]: b for b in json.load(open(BOX + "link3_inputs_blind.json"))}
    key = json.load(open(BOX + "link3_key.json"))                     # only ["rx"] is used; the class fields are never read or printed
    manifest = {}
    for it in items:
        b = blind[it]; doc_uid = ident(b["doctor_uid"]); own_rx = ident(key[it]["rx"]); day = b["day"][:10]
        t0 = (iso(b["start"]) - PAD).astimezone(timezone.utc).isoformat(); t1 = (iso(b["end"]) + PAD).astimezone(timezone.utc).isoformat()
        name = mb.query(f"SELECT metadata->>'DOCTOR_NAME' FROM queue_token_steps WHERE station='CONSULTATION' AND routing->>'DOCTOR_UID'='{doc_uid}' AND _create_time >= '2026-08-01' LIMIT 1")[1]
        doctor = name[0][0] if name and name[0][0] else ""
        rooms = []
        for k, room in enumerate(sl[it]["shortlist"]):
            rd = neon(f"SELECT id FROM room_day WHERE room_id='{ident(room)}' AND ist_date='{day}'")
            rows = neon(f"""SELECT cu.at AS at, cu.payload->>'text' AS text, cu.payload->>'language' AS lang, (cu.payload->>'start_ms')::bigint AS s FROM cue cu
                WHERE cu.type='stt_turn' AND cu.room_day_id='{ident(rd[0]['id'])}' AND cu.at BETWEEN '{t0}' AND '{t1}' AND coalesce(cu.payload->>'text','') <> '' ORDER BY cu.at, s""") if rd else []
            turns = [{"i": i, "at": r["at"], "orig": r["text"].strip(), "en": r["text"].strip() if (r["lang"] or "").lower() in ("english", "en") else None, "lang": (r["lang"] or "").lower()} for i, r in enumerate(rows)]
            rid = f"{it}_r{k}"
            json.dump({"id": rid, "doctor": doctor, "turns": turns}, open(PILOT + f"raw/{rid}.json", "w"), ensure_ascii=False)
            rooms.append(dict(id=rid, turns=len(turns), chars=sum(len(t["orig"]) for t in turns), non_english=sum(t["en"] is None for t in turns)))
        def rx_doc(uid, tag):
            g = mb.query(f"""SELECT general_practitioner_prescription__presenting_complaints FROM "individuals-prescriptions" WHERE uid='{ident(uid)}'""")[1]
            comp = json.loads(g[0][0]) if g and isinstance(g[0][0], str) else (g[0][0] if g else [])
            cols = ["generic_name", "brand_name", "strength", "dosage", "frequency", "duration"]
            m = mb.query(f"""SELECT {', '.join(cols)} FROM "individuals-prescriptions__medications" WHERE _parent_id='{ident(uid)}'""")[1]
            meds = [dict(zip(cols, r)) for r in m]
            text = lj.rx_link_text(comp, meds)
            json.dump({"id": tag, "doctor": doctor, "turns": [{"i": 0, "orig": text, "en": text}]}, open(PILOT + f"raw/{tag}.json", "w"), ensure_ascii=False)
        rx_doc(own_rx, f"{it}_rxown")
        dec = mb.query(f"""SELECT uid FROM "individuals-prescriptions" WHERE doctor_uid='{doc_uid}' AND type_of_prescription LIKE 'HOSPITAL%'
            AND ("timestamp" AT TIME ZONE 'Asia/Kolkata')::date = '{day}' AND uid <> '{own_rx}' ORDER BY "timestamp" LIMIT 25""")[1]
        for n, (u,) in enumerate(dec):
            rx_doc(u, f"{it}_rxd{n:02d}")
        manifest[it] = dict(start=b["start"], end=b["end"], day=day, rooms=rooms, decoys=len(dec), pipeline="production", after_gate_change=iso(b["start"]) >= GATE_CHANGE)
        print(it, "rooms", [(r["id"], r["turns"], r["chars"], "non-English turns", r["non_english"]) for r in rooms], "| decoy Rx", len(dec))
    json.dump(manifest, open(PILOT + "manifest.json", "w")); os.chmod(PILOT + "manifest.json", 0o600)


def stage_deid():
    os.makedirs(PILOT + "deid", mode=0o700, exist_ok=True)
    ids = sorted(f[:-5] for f in os.listdir(PILOT + "raw") if f.endswith(".json"))
    py = os.path.expanduser("~/eta-data/deid/venv-gpu/bin/python")
    cmd = ["flock", os.path.expanduser("~/gpu.lock"), py, os.path.join(SR2, "deid_gpu.py"), PILOT + "raw", PILOT + "deid"] + ids
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=3000, env={**os.environ, "PYTHONUTF8": "1"})   # deid.py writes UTF-8; an ASCII locale crashed the first run
    lines = [l for l in r.stdout.splitlines() if l.startswith("{")]
    counts = {}
    for i, l in zip(ids, lines):
        try:
            counts[i] = json.loads(l)
        except Exception:
            pass
    json.dump(counts, open(PILOT + "redaction_counts.json", "w")); os.chmod(PILOT + "redaction_counts.json", 0o600)
    bad = []
    for i in ids:                                    # every output must parse and keep its turn count, or the stage fails
        try:
            if len(json.load(open(PILOT + f"deid/{i}.json"))["turns"]) != len(json.load(open(PILOT + f"raw/{i}.json"))["turns"]): bad.append(i)
        except Exception:
            bad.append(i)
    print("de-identified", len(counts), "of", len(ids), "files; rc", r.returncode, "| outputs missing, unparsable or with a different turn count:", len(bad))
    if bad or r.returncode:
        raise SystemExit("de-identification incomplete: nothing will be scored")
    tot = collections.Counter()
    for c in counts.values():
        for k, v in c.get("redactions", {}).items(): tot[k.split("/")[0]] += v
    print("redaction counts by tag (all files):", dict(tot))


def stage_score():
    import link3_judge as lj
    from finalize import residual_identifiers
    man = json.load(open(PILOT + "manifest.json")); red = json.load(open(PILOT + "redaction_counts.json"))
    out = {}
    def load(rid):
        return json.load(open(PILOT + f"deid/{rid}.json"))
    def gate(doc):
        turns = [{"i": t["i"], "en": t.get("en") or "", "orig": t.get("orig") or ""} for t in doc["turns"]]
        return residual_identifiers(turns)
    def text(doc, lo=None, hi=None):
        return "\n".join(f"[{t['i']}] {t.get('en') or ''}" for t in doc["turns"]
                         if (t.get("en") or "").strip() and (lo is None or lo <= iso(t["at"]) <= hi))
    for it, m in sorted(man.items()):
        rec = dict(pipeline="production", after_gate_change=m["after_gate_change"], calls=0)
        rooms = [r["id"] for r in m["rooms"]]
        problems = [r["id"] for r in m["rooms"] if r["turns"] == 0 or r["non_english"]]
        docs, blocked = {}, []
        for rid in rooms + [f"{it}_rxown"] + [f"{it}_rxd{n:02d}" for n in range(m["decoys"])]:
            d = load(rid)
            if gate(d): blocked.append(rid)
            docs[rid] = d
        rec["redactions_rooms"] = {r: sum(red.get(r, {}).get("redactions", {}).values()) for r in rooms}
        rec["redactions_rx_own"] = sum(red.get(f"{it}_rxown", {}).get("redactions", {}).values())
        if problems or blocked:
            rec["verdict"] = "INCOMPLETE"; rec["why"] = dict(no_or_non_english_text=problems, gate_blocked=blocked); out[it] = rec; print(it, "INCOMPLETE", rec["why"]); continue
        rx_own = text(docs[f"{it}_rxown"])
        room_scores = {r: lj.score(text(docs[r]), rx_own, None, lj.LINK_QUESTION_V2) for r in rooms}; rec["calls"] += len(rooms)
        ranked = sorted(room_scores.items(), key=lambda kv: -kv[1]); best_room, best = ranked[0]
        room_margin = (best - ranked[1][1]) if len(ranked) > 1 else None
        lo, hi = iso(m["start"]) - timedelta(minutes=2), iso(m["end"]) + timedelta(minutes=2)
        local = text(docs[best_room], lo, hi)
        if not local.strip():
            rec["verdict"] = "INCOMPLETE"; rec["why"] = "no turns inside the consult +/- 2 min in the best room"; out[it] = rec; print(it, "INCOMPLETE (empty localized text)"); continue
        own_local = lj.score(local, rx_own, None, lj.LINK_QUESTION_V2); rec["calls"] += 1
        dec_scores = [lj.score(local, text(docs[f"{it}_rxd{n:02d}"]), None, lj.LINK_QUESTION_V2) for n in range(m["decoys"])]; rec["calls"] += len(dec_scores)
        rx_margin = (own_local - max(dec_scores)) if dec_scores else None
        rec["own_local"] = round(own_local, 3)
        rec.update(room_scores={r: round(s, 3) for r, s in room_scores.items()}, best_room=best_room, best=round(best, 3), room_margin=None if room_margin is None else round(room_margin, 3),
                   n_decoys=len(dec_scores), best_decoy=round(max(dec_scores), 3) if dec_scores else None, rx_margin=None if rx_margin is None else round(rx_margin, 3))
        if best < FLOOR: v = "REJECT_BELOW_FLOOR"
        else:
            fails = [n for n, mg in (("room", room_margin), ("rx", rx_margin)) if mg is not None and mg < MARGIN]
            v = "ACCEPTED" if not fails else "AMBIGUOUS_TIE(" + "+".join(fails) + ")"
            if room_margin is None and rx_margin is None: v = "SINGLE"
            elif (room_margin is None or rx_margin is None) and not fails: v += "(single on " + ("room" if room_margin is None else "rx") + ")"
        rec["verdict"] = v; out[it] = rec
        print(it, v, "| rooms", rec["room_scores"], "| best decoy", rec["best_decoy"], "of", rec["n_decoys"], "| margins room/rx", rec["room_margin"], rec["rx_margin"], "| calls", rec["calls"])
    json.dump(out, open(PILOT + "pilot_results.json", "w"), indent=1); os.chmod(PILOT + "pilot_results.json", 0o600)


if __name__ == "__main__":
    {"build": stage_build, "deid": stage_deid, "score": stage_score}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: sys.exit(__doc__))()
