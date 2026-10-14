"""link3_run.py: the MAIN-RUN scorer for link 3 (P1-PREREG v7.5-v7.8). ALL 37 items on research-pipeline (HIST) text, every shortlisted room, consult +/- 10 min;
production text on the 4 fully covered items is a separate secondary check (link3_pilot.py). Patient text lives only in ~/eta-data/surgical-chain/p1/run/ (0700);
stdout carries ids, counts and scores; the class key is never read.

  python3 link3_run.py provenance   verify the stack-versions file against the immutable published copy in git
  python3 link3_run.py status       how many of the 99 windows have a finished HIST output; how many items are complete
  python3 link3_run.py build        stage every item whose windows ALL finished (raw docs on the box)
  python3 link3_run.py deid         local GPU de-identification of the staged files
  python3 link3_run.py score        gate, then Jev, then the pre-registered rules and the v7.8 diagnostic columns
"""
import collections, glob, hashlib, json, os, re, subprocess, sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "..", "..", "2026-09-24-surgery-review-v2"))
import link3_pilot as P                                   # neon(), iso(), ident(), constants, the Rx-text and de-id mechanics proven in the pilot
BOX = P.BOX; RUN = BOX + "run/"; HIST = os.path.expanduser("~/eta-data/hist/")
PILOT_ITEMS = {"c001", "c008", "c015", "c027"}            # informed v7.7: excluded from accuracy claims (K2.4)
PAD, LOCAL, FLOOR, MARGIN = P.PAD, timedelta(minutes=2), P.FLOOR, P.MARGIN


def windows99():
    w = json.load(open(P.HM + "link3_hist_windows_99.json"))
    return w["windows"]


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def provenance():
    """Stack provenance for HIST text, trusted only if the file's sha256 equals the sha256 of the published immutable git copy (refuter #762/#775)."""
    p = HIST + "stack_versions.json"
    data = open(p, "rb").read(); sv = json.loads(data)
    sid = sv.get("stack_id"); disk_sha = sha256_bytes(data)
    rel = f"studies/2026-09-24-stt-parity/stack_versions.{sid}.json"
    r = subprocess.run(["git", "-C", HERE, "show", f"origin/main:{rel}"], capture_output=True)
    git_sha = sha256_bytes(r.stdout) if r.returncode == 0 else None
    return dict(stack_id=sid, disk_sha256=disk_sha, git_copy=rel, git_sha256=git_sha, verified=(git_sha is not None and git_sha == disk_sha),
                temperature_fallback="on", temperature_source="ruling 196 (HIST whisper temperature fallback active; non-deterministic; mining only)")


ROOTS = [HIST, os.path.expanduser("~/eta-data/hist-mining/")]


def published_shas():
    """{sha256: stack_id} of every published immutable stack_versions.<stack_id>.json on origin/main (the anchor is the git blob, not a value quoted on the bus)."""
    r = subprocess.run(["git", "-C", HERE, "ls-tree", "--full-tree", "--name-only", "origin/main", "studies/2026-09-24-stt-parity/"], capture_output=True, text=True)
    out = {}
    for path in r.stdout.split():
        m = re.search(r"stack_versions\.([0-9a-f]+)\.json$", path)
        if m:
            b = subprocess.run(["git", "-C", HERE, "show", f"origin/main:{path}"], capture_output=True)
            if b.returncode == 0:
                out[sha256_bytes(b.stdout)] = m.group(1)
    return out


def index_windows(roots=None):
    """window_id -> {path, run_id, attempt}: hist-bulk and hist-miner write link-3 windows to <root>/runs/<run_id>/<room_id>/<ist_date>/l3-cNNN-rK.json
    (failed or extra attempts as .attempt<N>.json; the same window can exist in two runs). Rule (v7.8 L1): the FIRST ok output per window, by file time; a
    final file is preferred to an attempt file only if it is not later than the first ok attempt; run_id is recorded."""
    idx = {}
    files = []
    for root in (roots or ROOTS):
        files += glob.glob(os.path.join(root, "runs", "**", "l3-*.json"), recursive=True)
    for f in sorted(files, key=os.path.getmtime):
        try:
            j = json.load(open(f))
        except Exception:
            continue
        wid = j.get("window_id") if isinstance(j, dict) else None
        cut = (j.get("cut") or {}) if isinstance(j, dict) else {}
        # completed-run status; a missing or failed run never counts, zero turns is decided only after this. v7.14: a record with an error, or with any chunk the harness dropped
        # (hist-miner #861: the cut_window bug), is a harness fault, NOT silence and NOT a finished partial transcript: it is not indexed until re-transcribed cleanly.
        ok = isinstance(j, dict) and j.get("ok") is True and j.get("state", "done") == "done" and not j.get("error") and not (isinstance(cut, dict) and cut.get("chunks_dropped"))
        if wid and ok and wid not in idx:
            parts = f.split(os.sep + "runs" + os.sep, 1)[1].split(os.sep)
            idx[wid] = {"path": f, "run_id": parts[0], "attempt": ".attempt" in os.path.basename(f)}
    return idx


def window_provenance(entry, roots=None):
    """Per-window provenance: the window file's own provenance block if present, else the run's start manifest. VERIFIED only if its stack_versions_sha256
    equals the sha256 of the published immutable git copy for its stack_id (never on stack_id alone)."""
    j = json.load(open(entry["path"])); pv = j.get("provenance") if isinstance(j.get("provenance"), dict) else None
    if not pv:
        for root in (roots or ROOTS):
            m = os.path.join(root, "manifests", entry["run_id"] + ".start.json")
            if os.path.exists(m):
                pv = (json.load(open(m)).get("provenance") or {}); break
    pv = pv or {}
    stack = pv.get("stack") if isinstance(pv.get("stack"), dict) else {}
    claimed = pv.get("stack_versions_sha256"); pub = published_shas(); sid = pub.get(claimed)      # verified by sha equality to a published copy; the id comes from that copy
    tf = pv.get("temperature_fallback") or ((stack.get("whisper") or {}).get("flags") or {}).get("temperature_fallback") or "on (ruling 196; field absent in this run's record)"
    return dict(run_id=entry["run_id"], stack_id=sid, claimed_sha256=claimed, verified=bool(claimed and claimed in pub), temperature_fallback=tf)


def hist_turns(path):
    """Turns with an absolute timestamp from one HIST window file (segment times are relative to the window start)."""
    j = json.load(open(path)); t0 = P.iso(j["start"])
    segs = j.get("segments") or j.get("turns") or []
    out = []
    for i, s in enumerate(segs):
        txt = (s.get("text") or "").strip()
        if not txt:
            continue
        lang = (s.get("lang") or "").lower()
        out.append({"i": len(out), "at": (t0 + timedelta(seconds=float(s.get("start_s") or 0))).isoformat(), "orig": txt,
                    "en": txt if lang in ("en", "english") else None, "lang": lang})
    return out


def stage_status():
    idx = index_windows(); W = windows99()
    done = [w for w in W if w["window_id"] in idx]
    by_item = collections.defaultdict(lambda: [0, 0])
    for w in W:
        by_item[w["item"]][1] += 1; by_item[w["item"]][0] += w["window_id"] in idx
    complete = sorted(i for i, (a, b) in by_item.items() if a == b)
    print(f"windows finished {len(done)} of {len(W)} | by group:", {g: sum(1 for w in done if w['priority_group'] == g) for g in sorted({w['priority_group'] for w in W})})
    print(f"items complete (every shortlisted room finished): {len(complete)} of {len(by_item)}")


def stage_build():
    import mb, link3_judge as lj
    os.makedirs(RUN + "raw", mode=0o700, exist_ok=True); os.chmod(RUN, 0o700)
    idx = index_windows(); W = windows99()
    items = collections.defaultdict(list)
    for w in W: items[w["item"]].append(w)
    blind = {b["item"]: b for b in json.load(open(BOX + "link3_inputs_blind.json"))}
    key = json.load(open(BOX + "link3_key.json"))                     # only ["rx"] is used; the class fields are never read or printed
    manifest = {}
    for it, ws in sorted(items.items()):
        if not all(w["window_id"] in idx for w in ws):
            continue                                                    # item-complete only: never score an item on some of its rooms
        b = blind[it]; doc_uid = P.ident(b["doctor_uid"]); own_rx = P.ident(key[it]["rx"]); day = b["day"][:10]
        s, e = P.iso(b["start"]), P.iso(b["end"])
        name = mb.query(f"SELECT metadata->>'DOCTOR_NAME' FROM queue_token_steps WHERE station='CONSULTATION' AND routing->>'DOCTOR_UID'='{doc_uid}' AND _create_time >= '2026-08-01' LIMIT 1")[1]
        doctor = name[0][0] if name and name[0][0] else ""
        rooms = []
        for w in sorted(ws, key=lambda z: z["rank"]):
            turns = hist_turns(idx[w["window_id"]]["path"]); rid = w["window_id"]; wp = window_provenance(idx[w["window_id"]])
            json.dump({"id": rid, "doctor": doctor, "turns": turns}, open(RUN + f"raw/{rid}.json", "w"), ensure_ascii=False)
            ne = sum(t["en"] is None for t in turns)
            rooms.append(dict(id=rid, turns=len(turns), chars=sum(len(t["orig"]) for t in turns), non_english=ne, non_english_share=round(ne / len(turns), 3) if turns else None,
                              path=os.path.basename(idx[w["window_id"]]["path"]), provenance=wp))
        def rx_doc(uid, tag):
            g = mb.query(f"""SELECT general_practitioner_prescription__presenting_complaints FROM "individuals-prescriptions" WHERE uid='{P.ident(uid)}'""")[1]
            comp = json.loads(g[0][0]) if g and isinstance(g[0][0], str) else (g[0][0] if g else [])
            cols = ["generic_name", "brand_name", "strength", "dosage", "frequency", "duration"]
            meds = [dict(zip(cols, r)) for r in mb.query(f"""SELECT {', '.join(cols)} FROM "individuals-prescriptions__medications" WHERE _parent_id='{P.ident(uid)}'""")[1]]
            text = lj.rx_link_text(comp, meds)
            json.dump({"id": tag, "doctor": doctor, "turns": [{"i": 0, "orig": text, "en": text}]}, open(RUN + f"raw/{tag}.json", "w"), ensure_ascii=False)
        rx_doc(own_rx, f"{it}_rxown")
        dec = mb.query(f"""SELECT uid, "timestamp" FROM "individuals-prescriptions" WHERE doctor_uid='{doc_uid}' AND type_of_prescription LIKE 'HOSPITAL%'
            AND ("timestamp" AT TIME ZONE 'Asia/Kolkata')::date = '{day}' AND uid <> '{own_rx}' ORDER BY "timestamp" LIMIT 25""")[1]
        for n, (u, _) in enumerate(dec):
            rx_doc(u, f"{it}_rxd{n:02d}")
        nb = sum(1 for _, ts in dec if s - PAD <= P.iso(ts) <= e + PAD)      # v7.8 L2.2: same-doctor visits starting inside the padded window
        ips = [r["provenance"] for r in rooms]
        item_prov = dict(verified=all(x["verified"] for x in ips), stack_ids=sorted({str(x["stack_id"]) for x in ips}), run_ids=sorted({x["run_id"] for x in ips}),
                         temperature_fallback=sorted({x["temperature_fallback"] for x in ips}))
        manifest[it] = dict(start=b["start"], end=b["end"], day=day, rooms=rooms, decoys=len(dec), source="hist", neighbours_in_padding=nb,
                            windows_finished_zero_turns=sum(1 for r in rooms if r["turns"] == 0), windows_never_run=0,
                            pilot_item=it in PILOT_ITEMS, provenance=item_prov, after_gate_change=s >= P.GATE_CHANGE)
        print(it, "staged; rooms", [(r["turns"], r["non_english"]) for r in rooms], "| decoy Rx", len(dec), "| neighbours in padding", nb)
    json.dump(manifest, open(RUN + "manifest.json", "w")); os.chmod(RUN + "manifest.json", 0o600)
    print("items staged:", len(manifest), "| items whose every window's provenance verified against the published git copy:", sum(m["provenance"]["verified"] for m in manifest.values()))


def stage_deid():
    P.PILOT = RUN
    P.stage_deid()


def stage_score():
    import link3_judge as lj
    from finalize import residual_identifiers
    man = json.load(open(RUN + "manifest.json")); red = json.load(open(RUN + "redaction_counts.json"))
    load = lambda rid: json.load(open(RUN + f"deid/{rid}.json"))
    # v7.9 M1.3: the gate runs on the English turns that will be sent; non-English turns are never sent and are excluded from it
    gate = lambda d: residual_identifiers([{"i": t["i"], "en": t.get("en") or "", "orig": t.get("orig") or ""} for t in d["turns"] if (t.get("en") or "").strip()])
    def text(doc, lo=None, hi=None):
        return "\n".join(f"[{t['i']}] {t.get('en') or ''}" for t in doc["turns"] if (t.get("en") or "").strip() and (lo is None or lo <= P.iso(t["at"]) <= hi))
    tags = lambda name: {k.split("/")[0]: v for k, v in red.get(name, {}).get("redactions", {}).items()}
    out = {}
    for it, m in sorted(man.items()):
        rec = dict(source="hist", pilot_item=m["pilot_item"], after_gate_change=m["after_gate_change"], neighbours_in_padding=m["neighbours_in_padding"],
                   stack_ids=m["provenance"]["stack_ids"], run_ids=m["provenance"]["run_ids"], provenance_verified=m["provenance"]["verified"], temperature_fallback=m["provenance"]["temperature_fallback"], calls=0)
        rooms = [r["id"] for r in m["rooms"]]
        if not m["provenance"]["verified"]:
            rec["verdict"] = "PROVENANCE_UNVERIFIED"; out[it] = rec; print(it, "PROVENANCE_UNVERIFIED (excluded, counted)"); continue
        problems = []                                                  # v7.10: a finished window with no speech is silence (score 0), not a missing transcript
        lang_limited = [r["id"] for r in m["rooms"] if r["turns"] and r["non_english_share"] > 0.5]
        silent = [r["id"] for r in m["rooms"] if r["turns"] == 0]
        rec["silent_rooms"] = silent
        rec["non_english_share"] = {r["id"]: r["non_english_share"] for r in m["rooms"]}
        docs, blocked = {}, []
        for rid in rooms + [f"{it}_rxown"] + [f"{it}_rxd{n:02d}" for n in range(m["decoys"])]:
            d = load(rid); docs[rid] = d
            if gate(d): blocked.append(rid)
        rec["redactions_transcript"] = {t: sum(tags(r).get(t, 0) for r in rooms) for t in ("PATIENT_NAME", "ADDRESS", "PHONE", "DOB", "ID", "AGE")}
        rec["redactions_prescription"] = tags(f"{it}_rxown")
        if problems or blocked:
            rec["verdict"] = "INCOMPLETE"; rec["why"] = dict(no_english_text=problems, gate_blocked=blocked); out[it] = rec; print(it, "INCOMPLETE", rec["why"]); continue
        no_english = [r["id"] for r in m["rooms"] if r["turns"] and r["non_english"] == r["turns"]]
        zero = set(silent) | set(no_english)                            # nothing English to send: the room scores 0, no empty text goes to Jev
        rec["rooms_without_english_text"] = no_english; rec["windows_finished_zero_turns"] = m.get("windows_finished_zero_turns", len(silent)); rec["windows_never_run"] = m.get("windows_never_run", 0)

        def chain():
            """The link-3 scoring chain on the English text. Returns (fields, verdict); verdict None = empty localized text (INCOMPLETE)."""
            f = dict(calls=0)
            rx_own = text(docs[f"{it}_rxown"])
            room_scores = {r: (0.0 if r in zero else lj.score(text(docs[r]), rx_own, None, lj.LINK_QUESTION_V2)) for r in rooms}; f["calls"] += len(rooms) - len(zero)
            ranked = sorted(room_scores.items(), key=lambda kv: -kv[1]); best_room, best = ranked[0]
            room_margin = (best - ranked[1][1]) if len(ranked) > 1 else None
            lo, hi = P.iso(m["start"]) - LOCAL, P.iso(m["end"]) + LOCAL
            local = text(docs[best_room], lo, hi)
            if not local.strip():
                return dict(f, room_scores={r: round(x, 3) for r, x in room_scores.items()}, best_room=best_room, best=round(best, 3)), None
            own_local = lj.score(local, rx_own, None, lj.LINK_QUESTION_V2); f["calls"] += 1
            dec_scores = [lj.score(local, text(docs[f"{it}_rxd{n:02d}"]), None, lj.LINK_QUESTION_V2) for n in range(m["decoys"])]; f["calls"] += len(dec_scores)
            rx_margin = (own_local - max(dec_scores)) if dec_scores else None
            brm = next(r for r in m["rooms"] if r["id"] == best_room)
            loc_turns = [t for t in docs[best_room]["turns"] if lo <= P.iso(t["at"]) <= hi]
            f["english_share_best_room"] = round(1 - brm["non_english_share"], 3) if brm["turns"] else None          # v7.11 O2
            f["english_share_local"] = round(sum(1 for t in loc_turns if (t.get("en") or "").strip()) / len(loc_turns), 3) if loc_turns else None
            f.update(room_scores={r: round(x, 3) for r, x in room_scores.items()}, best_room=best_room, best=round(best, 3), own_local=round(own_local, 3),
                     local_drop=round(best - own_local, 3), room_margin=None if room_margin is None else round(room_margin, 3), n_decoys=len(dec_scores),
                     best_decoy=round(max(dec_scores), 3) if dec_scores else None, rx_margin=None if rx_margin is None else round(rx_margin, 3))
            if best < FLOOR: v = "REJECT_BELOW_FLOOR"
            else:
                fails = [n for n, mg in (("room", room_margin), ("rx", rx_margin)) if mg is not None and mg < MARGIN]
                v = "ACCEPTED" if not fails else "AMBIGUOUS_TIE(" + "+".join(fails) + ")"
                if room_margin is None and rx_margin is None: v = "SINGLE"
                elif (room_margin is None or rx_margin is None) and not fails: v += "(single on " + ("room" if room_margin is None else "rx") + ")"
            return f, v

        f, v = chain()
        if lang_limited:
            # v7.12: the verdict stays LANGUAGE_LIMITED (withheld, the pre-registered rule); the English-only scores are STORED as a separate flagged stratum,
            # floor 0.50 and margin 0.15 unchanged, never pooled into a headline rate or a denominator.
            rec["verdict"] = "LANGUAGE_LIMITED"; rec["why"] = dict(rooms_over_half_non_english=lang_limited); rec["calls"] += f.pop("calls")
            rec["flagged"] = dict(f, would_be_verdict=v or "INCOMPLETE"); out[it] = rec
            print(it, "LANGUAGE_LIMITED (withheld; flagged English-only chain stored) | non-English shares", rec["non_english_share"]); continue
        if v is None:
            rec["verdict"] = "INCOMPLETE"; rec["why"] = "no turns inside the consult +/- 2 min in the best room"; rec["calls"] += f.pop("calls"); rec.update(f); out[it] = rec
            print(it, "INCOMPLETE (empty localized text)"); continue
        rec["calls"] += f.pop("calls"); rec.update(f); rec["verdict"] = v; out[it] = rec
        print(it, v, "| best", rec["best"], "local", rec["own_local"], "| margins room/rx", rec["room_margin"], rec["rx_margin"], "| neighbours in padding", m["neighbours_in_padding"], "| calls", rec["calls"])
    json.dump(out, open(RUN + "run_results.json", "w"), indent=1); os.chmod(RUN + "run_results.json", 0o600)


def selftest():
    """Synthetic tree (no patient data): path depth, attempt handling, first-ok rule, per-window provenance and the sha rule."""
    import tempfile, time
    global published_shas
    real = published_shas
    published_shas = lambda: {"PUB": "S1"}
    try:
        with tempfile.TemporaryDirectory() as d:
            def w(rel, obj, age):
                p = os.path.join(d, rel); os.makedirs(os.path.dirname(p), exist_ok=True); json.dump(obj, open(p, "w")); t = time.time() - age; os.utime(p, (t, t))
            seg = [{"start_s": 0, "end_s": 5, "lang": "en", "text": "x"}]
            w("runs/RUNA/room_x/2026-09-01/l3-c001-r0.attempt1.json", {"window_id": "l3-c001-r0", "ok": False, "start": "2026-09-01T10:00:00+05:30", "segments": []}, 300)
            w("runs/RUNA/room_x/2026-09-01/l3-c001-r0.json", {"window_id": "l3-c001-r0", "ok": True, "state": "done", "start": "2026-09-01T10:00:00+05:30", "segments": seg,
              "provenance": {"stack_versions_sha256": "PUB", "temperature_fallback": "on"}}, 200)
            w("runs/RUNB/room_x/2026-09-01/l3-c001-r0.json", {"window_id": "l3-c001-r0", "ok": True, "state": "done", "start": "2026-09-01T10:00:00+05:30", "segments": seg}, 100)
            w("runs/RUNA/room_y/2026-09-01/l3-c002-r0.json", {"window_id": "l3-c002-r0", "ok": True, "state": "done", "start": "2026-09-01T10:00:00+05:30", "segments": seg,
              "provenance": {"stack_versions_sha256": "WRONG"}}, 50)
            w("manifests/RUNC.start.json", {"provenance": {"stack_versions_sha256": "PUB"}}, 10)
            w("runs/RUNC/room_z/2026-09-01/l3-c003-r0.json", {"window_id": "l3-c003-r0", "ok": True, "state": "done", "start": "2026-09-01T10:00:00+05:30", "segments": seg}, 5)
            w("runs/RUND/room_w/2026-09-01/l3-c004-r0.json", {"window_id": "l3-c004-r0", "ok": True, "state": "done", "start": "2026-09-01T10:00:00+05:30", "segments": [], "cut": {"chunks_dropped": ["x"]}}, 40)
            w("runs/RUND/room_w/2026-09-01/l3-c005-r0.json", {"window_id": "l3-c005-r0", "ok": False, "state": "failed", "error": "no_audio_in_window", "start": "2026-09-01T10:00:00+05:30", "segments": []}, 30)
            idx = index_windows([d])
            assert set(idx) == {"l3-c001-r0", "l3-c002-r0", "l3-c003-r0"}, ("a window with dropped chunks, or a failed run, must never be indexed", idx.keys())
            assert idx["l3-c001-r0"]["run_id"] == "RUNA" and not idx["l3-c001-r0"]["attempt"], "the failed attempt is skipped; the first ok output (RUNA) wins over the later RUNB"
            pv = lambda k: window_provenance(idx[k], [d])
            assert pv("l3-c001-r0")["verified"] and pv("l3-c001-r0")["temperature_fallback"] == "on" and pv("l3-c001-r0")["stack_id"] == "S1"
            assert not pv("l3-c002-r0")["verified"], "a sha that does not equal the published copy is unverified"
            assert pv("l3-c003-r0")["verified"] and "ruling 196" in pv("l3-c003-r0")["temperature_fallback"], "provenance from the run's start manifest; a missing field is recorded as such"
            assert len(hist_turns(idx["l3-c001-r0"]["path"])) == 1
    finally:
        published_shas = real
    print("link3_run selftest ok (synthetic tree only)")


if __name__ == "__main__":
    {"selftest": selftest, "provenance": lambda: print(json.dumps(provenance(), indent=1)), "status": stage_status, "build": stage_build, "deid": stage_deid, "score": stage_score}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: sys.exit(__doc__))()
