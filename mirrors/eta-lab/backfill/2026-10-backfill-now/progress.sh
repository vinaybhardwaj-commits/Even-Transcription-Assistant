#!/bin/bash
# Read-only progress line for the room-audio backfill (fleetboard JOBS strip).
# Counts unique windows in hist/state.jsonl since START (latest state per window wins).
# backfill-lead 7 Oct 15:00: c3 output counts only from the time in C3_OK_SINCE (written when router-fix C3-READY lands);
# until then every :c3* window is degraded (BF-CHECK-1: s1 no ffmpeg, no whisper on 8091) and is shown as redo, not done.
START="2026-10-07T13:57"
TOTAL=1008
F="$HOME/eta-data/hist/state.jsonl"
L=""; pgrep -f "run_[r]eal.sh --loop" >/dev/null && L="box"; pgrep -f "run_[c]3.sh --loop" >/dev/null && L="${L:+$L + }c3"; pgrep -f "run_[c]4.sh --loop" >/dev/null && L="${L:+$L + }c4"; if [ -n "$L" ]; then S=running; else S=stopped; L=none; fi
C3OK=$(cat /home/eta/oc/backfill-now/C3_OK_SINCE 2>/dev/null || echo 9999)
python3 - "$F" "$START" "$TOTAL" "$S" "$L" "$C3OK" <<'PY'
import json, sys
f, start, total, st, lanes, c3ok = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5], sys.argv[6].strip()
last = {}
try:
    with open(f) as fh:
        for ln in fh:
            try:
                r = json.loads(ln)
            except Exception:
                continue
            if r.get("t", "") >= start and r.get("win"):
                stt = r.get("state", "")
                if str(r.get("router") or "").startswith(":c3") and r.get("t", "") < c3ok:
                    stt = "redo"
                # 7 Oct 20:10 (ORDERS-C4-LANE-1): :c4* windows are healthy from the start (c4 was cloned from the repaired c3 stack, C4-PASS #9311): never "redo"
                last[r["win"]] = stt
except Exception as e:
    print("%s · cannot read state: %s" % (st, e)); sys.exit(0)
done = sum(1 for s in last.values() if s in ("done", "no_audio"))
failed = sum(1 for s in last.values() if s == "failed")
# 15:26 backfill-lead: remaining = tier C windows whose latest state (all time) is not done/no_audio; includes the c3 redo and blind-refused windows
allst = {}
try:
    for ln in open(f):
        try: r = json.loads(ln)
        except Exception: continue
        if r.get("win"): allst[r["win"]] = r
    wins = json.load(open(f.rsplit("/", 1)[0] + "/windows_tierC.json"))
    left = [w["win_id"] for w in wins if (allst.get(w["win_id"]) or {}).get("state") not in ("done", "no_audio")]
    redo = sum(1 for x in left if (allst.get(x) or {}).get("state") == "requeue" or str((allst.get(x) or {}).get("router") or "").startswith(":c3"))
    print("%s · %s done since %s · %s to go (%s c3 redo) · %d failed · lanes: %s" % (
        st, format(done, ","), start[-5:], format(len(left), ","), format(redo, ","), failed, lanes))
except Exception as e:
    print("%s · %s done since %s · %d failed · lanes: %s (remaining unknown: %s)" % (st, format(done, ","), start[-5:], failed, lanes, e))
PY
