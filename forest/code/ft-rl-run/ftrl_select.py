"""ft-rl-run: choose the RL-3 fetch set from RL-2 matched calls (RUNO-AUDIO step 1).

Window (SARVAM SPEND GUARD G1/G2, newcat-deputy dispatch 19 Oct ~20:15): call day
d = call_date - rx_date with D_MIN <= d <= D_MAX (call date > Rx and <= Rx+14 d), call dated before
the surgery event, outcome-revealing calls (ft-calltext Haiku tags, outcome_revealed or
_unverified) dropped. in_t7 marks the landmark T=7 subset (d < 7). The fetch set is days 0..14
(union of the dispatch reading 1..14 and the landmark reading 0..13); the shards apply one. One object per call (call_key = id24): the original
(non -converted) file if present, else the converted one; largest size wins.

Day 0 (forest-lead ruling 19 Oct 19:50): only calls after the consult time count. The call time is
the key's key_ts (13-digit epoch ms recording timestamp) in IST vs labels consult_ist; the row
carries after_consult = True/False/None (None = no key_ts or no consult time), and call_ts = the
key_ts as IST 'YYYY-MM-DD HH:MM:SS' (rl_stt needs the time on day 0).

Usage: ~/.venv-forest/bin/python -I ftrl_select.py RL2_CALLS COHORT INDEX TAGS OUT_DIR LABELS
Writes OUT_DIR/selection.jsonl.gz (0600), OUT_DIR/keys.txt (0600, exact S3 keys, lab box only),
OUT_DIR/select-counts.json (counts only). Counts only on stdout.
"""
import datetime
import gzip
import json
import os
import sys

# Fetch window = union of the two accepted readings (fetch costs no Sarvam): days 0..14.
# The transcription window is applied in ftrl_manifest (shards), not here.
D_MIN, D_MAX, T_PRIMARY = 0, 14, 7
# Call ids travel letters-encoded (tr 0-9a-f a-p, rl_common.hex_to_letters; cond 6): the RL-2 output
# carries id24_l / call_uuid_l, and the selection/manifest carry call_key_l. Decode with `tr a-p 0-9a-f`.
_L = str.maketrans("".join(map(str, range(10))) + "abcdef", "abcdefghijklmnop")


def letters(s):
    return s.lower().translate(_L)


def _lines(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt") as f:
        for ln in f:
            if ln.strip():
                yield json.loads(ln)


def _write(path, data, gz=False):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.close(fd)
    os.chmod(path, 0o600)
    with (gzip.open(path, "wt") if gz else open(path, "w")) as f:
        f.write(data)
    os.chmod(path, 0o600)


def day(s):
    return datetime.date.fromisoformat(str(s)[:10])


IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))


def main(rl2, cohort_path, index_path, tags_path, out_dir, labels_path):
    import pandas as pd
    lab = pd.read_parquet(labels_path, columns=["episode_id", "split", "consult_ist"])
    lab = lab[lab.split == "D"]
    consult = {e: datetime.datetime.strptime(c, "%Y-%m-%d %H:%M").replace(tzinfo=IST)
               for e, c in zip(lab.episode_id, lab.consult_ist) if isinstance(c, str) and c}
    cohort = {}
    for r in json.load(open(cohort_path)):
        cohort[(r["uhid_h"], r["rx_date"])] = r
    leak = set()
    for t in _lines(tags_path):
        if t.get("outcome_revealed") is True or t.get("outcome_revealed_unverified") is True:
            leak.add(letters(t["call_id"]))
    c = {"rl2_rows": 0, "matched": 0, "post_decision": 0, "no_episode": 0, "before_rx": 0, "day0": 0,
         "after_window": 0, "on_or_after_event": 0, "outcome_revealed": 0, "kept_files": 0}
    best = {}
    for r in _lines(rl2):
        c["rl2_rows"] += 1
        if r["status"] != "matched":
            continue
        c["matched"] += 1
        if r["tag"] != "pre_decision":
            c["post_decision"] += 1
            continue
        ep = cohort.get((r["uhid_h"], r["rx_date"]))
        if ep is None:
            c["no_episode"] += 1
            continue
        d = (day(r["call_date"]) - day(r["rx_date"])).days
        if d < 0:
            c["before_rx"] += 1
            continue
        if d < D_MIN:
            c["day0"] += 1
            continue
        if d > D_MAX:
            c["after_window"] += 1
            continue
        if ep["decision_date"] and day(r["call_date"]) >= day(ep["decision_date"]):
            c["on_or_after_event"] += 1
            continue
        ck = r.get("id24_l") or r.get("call_uuid_l") or r["obj_id"]
        if ck in leak:
            c["outcome_revealed"] += 1
            continue
        c["kept_files"] += 1
        cand = {"obj_id": r["obj_id"], "episode_id": ep["rx_uid"], "patient_key": r["uhid_h"], "call_key_l": ck,
                "call_date": str(r["call_date"])[:10], "day_from_rx": d, "in_t7": d < T_PRIMARY,
                "in_t14": True, "duration_s": r.get("duration_s"), "size": r["size"]}
        best.setdefault(ck, []).append(cand)
    want = best
    objs = {o["obj_id"] for cs in want.values() for o in cs}
    meta = {}
    for row in _lines(index_path):
        if row["obj_id"] in objs:
            meta[row["obj_id"]] = (row["key"], bool(row["duplicate"]), row.get("key_ts"))
    sel = []
    multi_episode = 0
    for ck, cands in sorted(want.items()):
        if len({x["episode_id"] for x in cands}) > 1:
            multi_episode += 1                     # RL-2 tiebreak gives one Rx per call; guard anyway
        pick = sorted(cands, key=lambda x: (meta[x["obj_id"]][1], -x["size"], x["obj_id"]))[0]
        ac = None
        if pick["day_from_rx"] == 0:
            kts, ct = meta[pick["obj_id"]][2], consult.get(pick["episode_id"])
            if kts and ct:
                ac = datetime.datetime.fromtimestamp(kts / 1000.0, tz=IST) > ct
        kts = meta[pick["obj_id"]][2]
        cts = datetime.datetime.fromtimestamp(kts / 1000.0, tz=IST).strftime("%Y-%m-%d %H:%M:%S") if kts else ""
        sel.append(dict(pick, ext=meta[pick["obj_id"]][0].rsplit(".", 1)[-1], after_consult=ac, call_ts=cts))
    keys = sorted(meta[s["obj_id"]][0] for s in sel)
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    _write(os.path.join(out_dir, "selection.jsonl.gz"),
           "".join(json.dumps(s, sort_keys=True) + "\n" for s in sel), gz=True)
    _write(os.path.join(out_dir, "keys.txt"), "".join(k + "\n" for k in keys))
    c.update({"calls_selected": len(sel), "calls_t7": sum(s["in_t7"] for s in sel),
              "episodes_t14": len({s["episode_id"] for s in sel}),
              "episodes_t7": len({s["episode_id"] for s in sel if s["in_t7"]}),
              "keys": len(keys), "multi_episode_calls": multi_episode,
              "day0": {str(k): sum(1 for s in sel if s["day_from_rx"] == 0 and s["after_consult"] is k)
                       for k in (True, False, None)},
              "gb": round(sum(s["size"] for s in sel) / 1e9, 3),
              "measured_hours": round(sum(s["duration_s"] or 0 for s in sel) / 3600.0, 2),
              "calls_no_duration": sum(1 for s in sel if not s["duration_s"]),
              "by_ext": {e: sum(1 for s in sel if s["ext"] == e) for e in sorted({s["ext"] for s in sel})}})
    _write(os.path.join(out_dir, "select-counts.json"), json.dumps(c, indent=1, sort_keys=True) + "\n")
    print(json.dumps(c, sort_keys=True))


if __name__ == "__main__":
    main(*sys.argv[1:7])
