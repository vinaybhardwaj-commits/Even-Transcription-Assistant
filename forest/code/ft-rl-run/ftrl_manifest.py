"""ft-rl-run: manifest.tsv + 3 duration-balanced shards for the RL-3 audio (RUNO-AUDIO step 1).

Usage: ~/.venv-forest/bin/python -I ftrl_manifest.py SELECTION AUDIO_DIR OUT_DIR
Columns: key_id (our obj_id), episode_id, patient_key (uhid_h = md5(individual uid) = RD-0 patient_key), duration (s, ffprobe; call-log value if ffprobe fails),
path, then call_key_l (Runo call_id, tr 0-9a-f a-p), call_ts (IST recording time from the key), ts_is_call_day (1 = call_ts falls on the
call-log call_date; 0 = call_ts is the recording/upload time, not the call time; the window always uses
call_date), day_from_rx, in_t7, call_date, ext, answered. All files 0600.
SARVAM SPEND GUARD (RUNO-AUDIO.md G1-G5): the selection is already G1/G2 (D-split model episodes, call day 0..13
after the Rx, before the surgery date). G3: answered = ffprobe duration >= 20 s; only answered rows go to the
shards. The G5 count line (N_calls, N_episodes, total_minutes after G1-G3) is printed for newcat-orch.
Counts only on stdout.
"""
import gzip
import json
import os
import re
import subprocess
import sys

COLS = ["key_id", "episode_id", "patient_key", "duration", "path", "call_key_l", "day_from_rx", "in_t7", "call_date", "call_ts",
        "ts_is_call_day",
        "ext", "answered",
        "after_consult", "in_shard"]
MIN_ANSWERED_S = 20.0
# Transcription window for the shards = every Sarvam minute (forest-lead ruling 19 Oct 19:50,
# within V's guard): days 0..13 after the Rx, day 0 only after the consult time, before surgery.
SHARD_D = (0, 13)


def probe(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                              "-of", "default=nw=1:nk=1", path], capture_output=True, text=True, timeout=60)
        return float(out.stdout.strip())
    except (ValueError, subprocess.TimeoutExpired, OSError):
        return None


def write_tsv(path, rows):
    """Atomic: same-dir temp file at 0600, then rename (supervisors watch the shard files)."""
    tmp = "%s.tmp-%d" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("\t".join(COLS) + "\n")
        for r in rows:
            f.write("\t".join(str(r[c]) for c in COLS) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def main(selection, audio_dir, out_dir, exclude=None):
    """exclude: optional file of key_ids to keep out of the shards (one per line, or a TSV with a
    key_id column), e.g. ft-rl-stt-c's G2-VIOLATIONS.tsv (forest-lead ruling 19 Oct 20:22)."""
    excl = set()
    if exclude:
        for ln in open(exclude):
            f = ln.rstrip("\n").split("\t")
            k = f[1] if len(f) > 1 else f[0]
            if k and k != "key_id":
                excl.add(k)
    sel = [json.loads(ln) for ln in gzip.open(selection, "rt") if ln.strip()]
    rows, missing, probe_fail = [], 0, 0
    for s in sel:
        p = os.path.join(audio_dir, s["obj_id"])
        if not os.path.exists(p):
            missing += 1
            continue
        d = probe(p)
        if d is None:
            probe_fail += 1          # G3 is "ffprobe after the fetch": an unprobeable file is not answered
            d = 0.0
        assert re.fullmatch(r"[0-9a-f]{32}", s["patient_key"]) and re.fullmatch(r"\d{4}-\d\d-\d\d", s["call_date"]), \
            "row without a valid patient_key/call_date (rl_stt fails closed on these)"
        rows.append({"key_id": s["obj_id"], "episode_id": s["episode_id"], "patient_key": s["patient_key"],
                     "duration": round(d, 2),
                     "path": p, "call_key_l": s["call_key_l"], "day_from_rx": s["day_from_rx"],
                     "in_t7": int(s["in_t7"]), "call_date": s["call_date"], "call_ts": s.get("call_ts", ""),
                     "ts_is_call_day": int(s.get("call_ts", "")[:10] == s["call_date"]), "ext": s["ext"],
                     "answered": int(d >= MIN_ANSWERED_S),
                     "after_consult": {True: 1, False: 0, None: ""}[s.get("after_consult")]})
    rows.sort(key=lambda r: r["key_id"])
    # Greedy longest-first into the lightest shard: balanced audio hours per STT lane.
    shards = {"a": [], "b": [], "c": []}
    load = {k: 0.0 for k in shards}
    def inw(r, w):
        # Day 0 needs a verified after-consult time: the key's recording time must fall on the
        # call-log call_date (forest-lead ruling 19 Oct 20:20; 9 rows dropped by this).
        d = int(r["day_from_rx"])
        return (r["key_id"] not in excl and w[0] <= d <= w[1]
                and (d > 0 or (r["after_consult"] == 1 and r["ts_is_call_day"] == 1)))
    for r in sorted((r for r in rows if r["answered"] and inw(r, SHARD_D)), key=lambda r: (-r["duration"], r["key_id"])):
        k = min(load, key=lambda x: (load[x], x))
        shards[k].append(r)
        load[k] += r["duration"]
        r["in_shard"] = k
    for r in rows:
        r.setdefault("in_shard", "")      # "" = fetched but NOT in the transcription set (never send to STT)
    write_tsv(os.path.join(out_dir, "manifest.tsv"), rows)
    for k, rs in shards.items():
        write_tsv(os.path.join(out_dir, "shard_%s.tsv" % k), sorted(rs, key=lambda r: r["key_id"]))
    for name, w in (("shards", SHARD_D),):
        ans = [r for r in rows if r["answered"] and inw(r, w)]
        t7 = [r for r in ans if r["in_t7"]]
        print("G5[%s days %d..%d] N_calls=%d N_episodes=%d total_minutes=%.1f | T7 subset N_calls=%d N_episodes=%d minutes=%.1f"
              % (name, w[0], w[1], len(ans), len({r["episode_id"] for r in ans}), sum(r["duration"] for r in ans) / 60,
                 len(t7), len({r["episode_id"] for r in t7}), sum(r["duration"] for r in t7) / 60))
    ans = [r for r in rows if r["answered"]]
    print(json.dumps({"excluded_by_list": sum(1 for r in rows if r["key_id"] in excl),
                      "selected": len(sel), "in_manifest": len(rows), "missing_audio": missing,
                      "ffprobe_failed": probe_fail, "under_20s": len(rows) - len(ans),
                      "hours": round(sum(load.values()) / 3600, 2),
                      "shards": {k: {"n": len(v), "hours": round(load[k] / 3600, 2)} for k, v in shards.items()}},
                     sort_keys=True))


if __name__ == "__main__":
    main(*sys.argv[1:5])
