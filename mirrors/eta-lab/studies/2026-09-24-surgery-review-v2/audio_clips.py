#!/usr/bin/env python3
"""audio_clips.py — evidence-turn audio clips for the v2 pilot (Fable 10:05 correction; audio v2.1 items in orders/SURGERY-REVIEW-V2.md).

Rules (Fable, verified in lib/mcp/tools/bench.ts): a window inside ONE 5-minute chunk returns a presigned link and works during clinic; a window that
SPANS chunks needs the single-flight join and is refused while a room records. So: for each EVIDENCE turn only, clip [turn start - 3 s, turn end + 3 s],
at most 15 s; if it straddles a chunk boundary make two single-chunk pieces. NEVER force a join during clinic. Clips go to
~/eta-data/surgery-review-v2/audio/<consult>/<turn i>.mp3 (or <i>_1.mp3, <i>_2.mp3), 32 kbps mono; each turn gets turn.audio = [relative paths].
Whole chunks are downloaded to audio-tmp/ ONLY to cut from and are deleted immediately after. Nothing here is committed. Prints ids and counts only.

  plan  <id>                        the windows and which chunk each needs, from a chunk grid anchored on one tool response
  cut   <id> <chunk.webm> <chunk_started_at_iso> <chunk_idx>   cut every not-yet-made clip that falls inside that chunk, then delete the chunk file
  apply <id>                        write turn.audio into consults/<id>.json from the clips on disk
  --selftest                        offline
"""
import json, math, os, subprocess, sys
from datetime import datetime, timedelta, timezone

OUT = os.path.expanduser("~/eta-data/surgery-review-v2")
IST = timezone(timedelta(hours=5, minutes=30))
PAD, MAXLEN, CHUNK_S = 3.0, 15.0, 300.0


def parse(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def clip_window(turn):
    """[start, end] in UTC for a turn: at-3 .. at+dur+3, capped to 15 s total (the cap keeps the START, where the words begin)."""
    at = parse(turn["at"])
    dur = max(float(turn["end_s"]) - float(turn["start_s"]), 1.0)
    s, e = at - timedelta(seconds=PAD), at + timedelta(seconds=dur + PAD)
    if (e - s).total_seconds() > MAXLEN:
        e = s + timedelta(seconds=MAXLEN)
    return s, e


def split_on_chunks(s, e, anchor_start, anchor_idx):
    """Split [s,e] at 5-minute chunk boundaries of the grid anchored on one known chunk. Returns [(chunk_idx, s, e)]."""
    out, cur = [], s
    while cur < e:
        k = anchor_idx + math.floor((cur - anchor_start).total_seconds() / CHUNK_S)
        bound = anchor_start + timedelta(seconds=(k - anchor_idx + 1) * CHUNK_S)
        nxt = min(e, bound)
        out.append((k, cur, nxt))
        cur = nxt
    return out


def evidence_turns(doc):
    return sorted({i for q in doc["jev"].values() for i in q["evidence"]})


def pieces_for(doc, anchor_start, anchor_idx):
    by = {t["i"]: t for t in doc["turns"]}
    res = {}
    for i in evidence_turns(doc):
        s, e = clip_window(by[i])
        res[i] = split_on_chunks(s, e, anchor_start, anchor_idx)
    return res


def clip_names(i, n_pieces):
    return [f"{i}.mp3"] if n_pieces == 1 else [f"{i}_{k + 1}.mp3" for k in range(n_pieces)]


def cut(pid, chunk_file, chunk_started_at, chunk_idx):
    doc = json.load(open(f"{OUT}/consults/{pid}.json"))
    cs = parse(chunk_started_at)
    made = 0
    os.makedirs(f"{OUT}/audio/{pid}", exist_ok=True); os.chmod(f"{OUT}/audio/{pid}", 0o700)
    for i, pcs in pieces_for(doc, cs, chunk_idx).items():
        names = clip_names(i, len(pcs))
        for name, (k, s, e) in zip(names, pcs):
            dest = f"{OUT}/audio/{pid}/{name}"
            if k != chunk_idx or os.path.exists(dest):
                continue
            off = (s - cs).total_seconds()
            r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{off:.2f}", "-t", f"{(e - s).total_seconds():.2f}", "-i", chunk_file, "-ac", "1", "-ar", "22050",
                                "-c:a", "libmp3lame", "-b:a", "32k", dest], capture_output=True)
            if r.returncode == 0:
                os.chmod(dest, 0o600); made += 1
    os.remove(chunk_file)  # whole patient chunk: cut from it, then it is gone
    print(pid, "chunk", chunk_idx, "clips cut:", made)


def apply(pid):
    p = f"{OUT}/consults/{pid}.json"
    doc = json.load(open(p))
    d = f"{OUT}/audio/{pid}"
    have = set(os.listdir(d)) if os.path.isdir(d) else set()
    n = 0
    for t in doc["turns"]:
        names = sorted(x for x in have if x == f"{t['i']}.mp3" or (x.startswith(f"{t['i']}_") and x.endswith(".mp3")))
        if names:
            t["audio"] = [f"audio/{pid}/{x}" for x in names]; n += 1
    missing = [i for i in evidence_turns(doc) if not any(f"audio/{pid}/{x}" in (t.get("audio") or []) for t in doc["turns"] if t["i"] == i for x in have)]
    json.dump(doc, open(p, "w"), ensure_ascii=False, indent=1); os.chmod(p, 0o600)
    print(pid, "turns with audio:", n, "| evidence turns still without a clip:", len(missing), missing[:20])


def datauri(pid):
    """consults-datauri/<id>.json: the same file with every turn.audio path replaced by a data:audio/mpeg;base64 URI (needs no page change and no
    assets capability; the cost is file size). Round-trips every clip against the bytes on disk before writing."""
    import base64
    doc = json.load(open(f"{OUT}/consults/{pid}.json"))
    n = 0
    for t in doc["turns"]:
        uris = []
        for rel in t.get("audio") or []:
            raw = open(f"{OUT}/{rel}", "rb").read()
            uri = "data:audio/mpeg;base64," + base64.b64encode(raw).decode()
            assert base64.b64decode(uri.split(",", 1)[1]) == raw, "round trip failed"
            uris.append(uri); n += 1
        if uris:
            t["audio"] = uris
    os.makedirs(f"{OUT}/consults-datauri", exist_ok=True); os.chmod(f"{OUT}/consults-datauri", 0o700)
    p = f"{OUT}/consults-datauri/{pid}.json"
    json.dump(doc, open(p, "w"), ensure_ascii=False); os.chmod(p, 0o600)
    print(pid, "clips inlined:", n, "| file KB:", round(os.path.getsize(p) / 1024), "| main file KB:", round(os.path.getsize(f"{OUT}/consults/{pid}.json") / 1024))


def plan(pid, anchor_start_iso, anchor_idx):
    doc = json.load(open(f"{OUT}/consults/{pid}.json"))
    cs = parse(anchor_start_iso)
    chunks = {}
    for i, pcs in pieces_for(doc, cs, anchor_idx).items():
        for k, s, e in pcs:
            chunks.setdefault(k, []).append(i)
    print(pid, "evidence turns", len(evidence_turns(doc)), "| chunks needed:", {k: len(v) for k, v in sorted(chunks.items())})
    for k in sorted(chunks):
        t0 = cs + timedelta(seconds=(k - anchor_idx) * CHUNK_S)
        first = min(chunks[k])
        print(f"  chunk {k}: starts {t0.astimezone(IST).strftime('%H:%M:%S')} IST | request window inside it for turn {first}")


def selftest():
    a = parse("2026-09-23T05:31:13.173Z")
    t = {"i": 1, "at": "2026-09-23T05:33:04.000Z", "start_s": 10.0, "end_s": 16.0}
    s, e = clip_window(t)
    assert (e - s).total_seconds() == 12.0, "6 s turn + 3 s either side"
    long = {"i": 2, "at": "2026-09-23T05:33:04.000Z", "start_s": 0.0, "end_s": 60.0}
    s2, e2 = clip_window(long)
    assert (e2 - s2).total_seconds() == MAXLEN and s2 == parse("2026-09-23T05:33:01.000Z"), "capped at 15 s, keeping the start"
    p = split_on_chunks(s, e, a, 38)
    assert len(p) == 1 and p[0][0] == 38
    edge = {"i": 3, "at": "2026-09-23T05:36:10.000Z", "start_s": 0.0, "end_s": 4.0}  # chunk 38 ends 05:36:13.173
    ps = split_on_chunks(*clip_window(edge), a, 38)
    assert [x[0] for x in ps] == [38, 39] and ps[0][2] == ps[1][1] == parse("2026-09-23T05:36:13.173Z"), ps
    assert all((x[2] - x[1]).total_seconds() > 0 for x in ps), "no empty piece"
    assert clip_names(4, 1) == ["4.mp3"] and clip_names(4, 2) == ["4_1.mp3", "4_2.mp3"]
    back = {"i": 5, "at": "2026-09-23T05:31:14.000Z", "start_s": 0.0, "end_s": 2.0}  # pad reaches before chunk 38 starts
    pb = split_on_chunks(*clip_window(back), a, 38)
    assert [x[0] for x in pb] == [37, 38], pb
    print("selftest OK: 3 s padding, 15 s cap keeps the start, boundary straddle -> two single-chunk pieces (both directions), names")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        c = sys.argv[1]
        if c == "plan":
            plan(sys.argv[2], sys.argv[3], int(sys.argv[4]))
        elif c == "cut":
            cut(sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]))
        elif c == "apply":
            apply(sys.argv[2])
        elif c == "datauri":
            datauri(sys.argv[2])
