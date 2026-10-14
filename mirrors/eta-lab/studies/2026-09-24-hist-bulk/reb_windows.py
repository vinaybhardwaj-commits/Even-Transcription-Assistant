#!/usr/bin/env python3
"""reb_windows.py — W43/[BACKFILL PRIORITY] (Fable, 28 Sep ~17:00): materialize the REAL room windows for
26 + 27 Sep as durable audio files for REB consumers (split, acoustics), 26 Sep first, then 27 Sep.

The daily STT path cuts window audio into a temp dir and deletes it after the router job; REB needs the
actual windows. This cuts EVERY tier-C window of the two days from the same local chunk stores with the
same pinned recipe (cut_window.py import, 48 kHz mono libopus 32k), but keeps the file: write-once under
hist-bulk's own namespace ~/eta-data/hist/windows-reb/<ist_date>/<room>/<window_id>.webm (0600, dirs 0700)
plus manifest.jsonl (provenance, source r2_keys, sha256). Audio only — the transcripts are already in
hist/runs (native, translate=false; English is REB's translate layer, Fable 14:22).

No GPU work: pure local ffmpeg cuts (nice). Does NOT touch today_loop (c3+box STT) or the tone shards.

Usage: reb_windows.py --day 2026-09-26 [--shard N/K] [--dry-run]
"""
import argparse, glob, hashlib, json, os, subprocess, sys, tempfile, time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-hist-mining/harness"))
import cut_window  # pinned harness piece (imported, never edited)

HD = os.path.expanduser("~/eta-data/hist")
OUT = f"{HD}/windows-reb"
AUDIO_FLAT = os.path.expanduser("~/eta-data/hist-mining/audio")
TAPE_GLOB = os.path.expanduser("~/eta-data/tapes/room_*/*/*.webm")
IST = timezone(timedelta(hours=5, minutes=30))

def log(msg):
    print(f"{datetime.now(IST).isoformat(timespec='seconds')} {msg}", flush=True)

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()

def build_file_index(chunk_rows):
    files = {}
    for c in chunk_rows:
        name = "bench__" + c["r2_key"][len("bench/"):].replace("/", "__")
        p = os.path.join(AUDIO_FLAT, name)
        if os.path.exists(p): files[c["id"]] = p
    for p in glob.glob(TAPE_GLOB):
        base = os.path.basename(p)
        if "_bc_" in base:
            cid = base.split("_bc_")[-1][:-len(".webm")]
            if cid not in files: files[cid] = p
    return files

def load_plan(a):
    """Window plan for the date: tierC (the daily plan file, 24 Sep onward) or tierAB (the Aug/Sep tier-A +
    tier-B union, 4 Aug-24 Sep; deduped, the SAME windows the STT tiers processed)."""
    if a.plan == "tierC":
        plan = json.load(open(f"{HD}/windows_tierC.json"))
    else:
        plan = []
        seen = set()
        for t in ("A", "B"):
            for w in json.load(open(f"{HD}/windows_tier{t}.json")):
                if w["win_id"] not in seen:
                    seen.add(w["win_id"]); plan.append(w)
    return [w for w in plan if w.get("day") == a.day]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", required=True, help="IST day, e.g. 2026-09-26")
    ap.add_argument("--plan", default="tierC", choices=["tierC", "tierAB"])
    ap.add_argument("--shard", default="0/1")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    n, k = (int(x) for x in a.shard.split("/"))
    wins = load_plan(a)
    # lab rule (plain id = UTC): windows whose plan id carries the IST date but a UTC clock that falls on
    # the PRIOR UTC day (the 00:00-05:29 IST misnaming class, refuter-3 7893/7939) are re-keyed here to
    # their TRUE UTC start so the file name never contradicts the clock.
    fixed = {}
    for w in wins:
        wid = w["win_id"]
        try:
            utc = datetime.fromisoformat(w["start"])
            w["_ist"] = utc.astimezone(timezone(timedelta(hours=5, minutes=30))).date().isoformat()
        except Exception:
            continue
        ist = utc.astimezone(timezone(timedelta(hours=5, minutes=30)))
        if wid.startswith("c-"):
            # c- ids are IST: the 00:00 IST slot is named with the PREVIOUS IST day when the plan keyed
            # it by the UTC date (r3 8078: exactly 2 such windows, the midnight 00:00 c- slot). Re-key to
            # the TRUE IST date.
            iddate = wid.split("_")[1] if wid.split("_")[1] != "room" else wid.split("_")[0]
            iddate = wid.replace("c-", "").split("_")[0]
            if iddate != ist.date().isoformat():
                hhmm = ist.strftime("%H%M")
                new_id = f"c-{ist.date().isoformat()}_{w['room_id']}_{hhmm}"
                fixed[wid] = new_id
                w["win_id"] = new_id
            continue
        iddate = wid.split("_")[0]
        if iddate != utc.date().isoformat():
            hhmm = utc.strftime("%H%M")
            new_id = f"{utc.date().isoformat()}_{w['room_id']}_{hhmm}"
            fixed[wid] = new_id
            w["win_id"] = new_id
    if fixed:
        print(f"re-keyed {len(fixed)} misnamed plan ids to true-UTC form (lab rule)")
    # (a) r3 8093: after re-keying, a plan can contain 2 entries with the SAME id (midnight-boundary
    # double-cuts). Keep the entry with the HIGHEST covered_fraction (the real audio), refuse on a tie
    # (can't decide), log every dropped entry - never let the order of wins decide which recording gets
    # the id.
    from collections import Counter
    idc = Counter(w["win_id"] for w in wins)
    # coverage source: the existing manifest for this day (an earlier pass may have cut one of them)
    man_cov = {}
    for f in glob.glob(f"{OUT}/manifest-*.jsonl"):
        for l in open(f):
            try:
                r = json.loads(l)
                key = (r["room"], r["start"], (r.get("cut") or {}).get("n_chunks"))
                man_cov[key] = (r.get("cut") or {}).get("covered_fraction") or 0
            except Exception:
                pass
    dropped = []
    for dup_id, cnt in idc.items():
        if cnt < 2: continue
        same = [w for w in wins if w["win_id"] == dup_id]
        covs = [(x, man_cov.get((x["room_id"], x["start"], len(x.get("chunk_ids", []))), 0)) for x in same]
        best_cov = max(c for _, c in covs)
        winners = [x for x, c in covs if c == best_cov]
        if len(winners) > 1:
            raise SystemExit(f"COLLISION tie on {dup_id}: {len(winners)} entries with equal coverage - refusing; resolve the plan first")
        keep = winners[0]
        for x in same:
            if x is keep: continue
            dropped.append((dup_id, x["start"]))
            log(f"COLLISION {dup_id}: kept start {keep['start']}, dropped start {x['start']}")
        wins = [w for w in wins if not (w["win_id"] == dup_id and w is not keep)]
    if dropped:
        print(f"deduped {len(dropped)} midnight-boundary duplicate plan entries (highest coverage kept)")
    todo = [w for i, w in enumerate(wins) if i % k == n]
    log(f"{a.day}: {len(todo)} windows of {len(wins)} (shard {a.shard})")
    chunks = json.load(open(f"{HD}/tone/bench_chunks.json"))
    bc = {c["id"]: c for c in chunks}
    file_index = build_file_index(chunks)
    prov = {
        "producer": "hist-bulk", "order": "W43 + [BACKFILL PRIORITY] (28 Sep 2026)",
        "recipe": "cut_window.py (pinned 0fb0eed981de2a48) over full_audio plan/assemble: 48 kHz mono, libopus 32k, webm — same recipe as the tier-C STT windows",
        "source": ["~/eta-data/hist-mining/audio (bench chunks)", "~/eta-data/tapes (twin pull)"],
        "days": [a.day], "created_at": datetime.now(IST).isoformat(timespec="seconds"),
        "notes": ["window AUDIO only; transcripts live in ~/eta-data/hist/runs/<run_id>/... (transcript_native, translate=false)",
                  "patient audio: files 0600, dirs 0700, box-local"],
    }
    manifest_path = f"{OUT}/manifest-{a.day}.jsonl"
    os.makedirs(OUT, mode=0o700, exist_ok=True)
    t0 = time.time(); n_done = n_skip = n_fail = 0
    for w in todo:
        wid = w["win_id"]; room = w["room_id"]
        # (b) r3 8093: the out dir must be the window's OWN IST date, not a.day (a re-keyed window can
        # belong to a different IST day than the date being processed).
        try:
            w_ist = datetime.fromisoformat(w["start"]).astimezone(IST).date().isoformat()
        except Exception:
            w_ist = a.day
        room_dir = f"{OUT}/{w_ist}/{room}"; os.makedirs(room_dir, mode=0o700, exist_ok=True)
        out_path = f"{room_dir}/{wid}.webm"
        rec_path = f"{room_dir}/{wid}.json"
        if os.path.exists(out_path) or os.path.exists(rec_path): n_skip += 1; continue
        claim = f"{OUT}/.claims/{wid}.json"
        try:
            fd = os.open(claim, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "w") as h: json.dump({"ts": datetime.now(IST).isoformat(), "shard": a.shard}, h)
        except FileExistsError:
            n_skip += 1; continue
        try:
            if a.dry_run:
                os.unlink(claim); n_skip += 1; continue
            sess = [bc[i] for i in w.get("chunk_ids", []) if i in bc]   # the tier-C plan carries the exact bc_ chunk ids per window
            files = {c["id"]: file_index[c["id"]] for c in sess if c["id"] in file_index}
            have = [c for c in sess if c["id"] in files]
            start = datetime.fromisoformat(w["start"].replace("+00:00", "+00:00"))
            end = datetime.fromisoformat(w["end"])
            recent = end > datetime.now(timezone.utc) - timedelta(hours=3)   # tape pull lags: retry recent windows instead of writing a permanent no-audio record
            if not have:
                if recent:
                    os.unlink(claim); n_skip += 1; log(f"audio not local yet, retry later {wid}"); time.sleep(2); continue
                rec = {"win_id": wid, "state": "no_audio_local", "room": room, "source_keys": [c["r2_key"] for c in sess]}
                (open(rec_path, "x")).write(json.dumps(rec)); os.chmod(rec_path, 0o600)
                n_done += 1; log(f"no-audio {wid}"); continue
            with tempfile.TemporaryDirectory(dir=OUT) as td:
                tmp = f"{td}/{wid}.webm"
                rep = cut_window.cut(have, start, end, tmp, files)
                if not rep.get("duration_s"):
                    rec = {"win_id": wid, "state": "no_audio_after_cut", "cut": rep, "room": room}
                    (open(rec_path, "x")).write(json.dumps(rec)); os.chmod(rec_path, 0o600)
                    n_done += 1; log(f"empty {wid}"); continue
                if os.path.exists(out_path):
                    raise RuntimeError(f"collision guard: {out_path} already exists (a DIFFERENT recording may hold this id; r3 8087) - refusing to overwrite")
                os.replace(tmp, out_path); os.chmod(out_path, 0o600)
                mrec = {"win_id": wid, "room": room, "ist_date": (w.get("_ist") or a.day), "start": w["start"], "end": w["end"],
                        "audio": out_path, "sha256": sha256_file(out_path), "cut": rep, "provenance": prov}
                with open(manifest_path, "a") as mh:
                    mh.write(json.dumps(mrec, ensure_ascii=False) + "\n")
                os.chmod(manifest_path, 0o600)
            n_done += 1
            rate = n_done / max(time.time() - t0, 1) * 60
            log(f"cut {wid} cov={rep.get('covered_fraction')} ({rate:.1f}/min)")
        except Exception as ex:
            n_fail += 1; log(f"FAIL {wid}: {str(ex)[:200]}")
            try: os.unlink(claim)
            except OSError: pass
            time.sleep(3)
    log(f"shard {a.shard} {a.day} finished: done={n_done} skipped={n_skip} failed={n_fail}")

if __name__ == "__main__":
    main()
