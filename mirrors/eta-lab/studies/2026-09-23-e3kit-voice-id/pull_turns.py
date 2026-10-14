#!/usr/bin/env python3
"""E-3 kit step 1 (weekA-2310, yoga-drain section). Pull the STORED Mini diarization for a bench
session: segment timings + speaker_idx only, NEVER text. Writes turns.json. Read-only; no DB write,
no voiceprint-store write.

Path: session_id -> scribe_sessions(view=replay) -> room_id/ist_date -> scribe_get_state ->
room_day_id -> scribe_voice(view=window_speakers, room_day_id=...) -> spans (speaker_idx, window_id,
start/end). window_id encodes its own start_ms (bw_<session>_<start_ms>_<mic>), so window clock
boundaries need no extra lookup.

SCOPE NOTE (found while building this, 22 Sep): SCRIBE_MCP_TOKEN as currently deployed is
READ-scope only — scribe_extract_audio (or any URL-minting call) answers 403 with it, because
minting a presigned audio link is an invoke-scope action. scribe3's idle note this round
("token rotation waits for Fable") is almost certainly this. So this script deliberately does NOT
try to resolve chunk audio refs itself — it pulls TIMINGS ONLY (which is read-scope and works).
embed_turns.py is where audio actually gets fetched, and it will hit the same 403 until the token
is rotated; that script reports the block plainly rather than guessing around it.

If window_speakers returns nothing (clustering not running for that room-day — the common case
right now, including bs_gkzmch9p), this is reported plainly, not papered over. It is NOT this
script's job to run diarize itself; that is a separate, heavier action outside this kit's
read-only scope.
"""
import json
import os
import re
import sys

import mcp_client

WORK_DEFAULT = os.path.expanduser("~/dev/_fable/e3kit/out")


def window_start_ms(window_id):
    m = re.search(r"_(\d{10,})_", window_id)
    return int(m.group(1)) if m else None


def parse_source_ref(source_ref):
    """source_ref is 'session_id|start_ms|end_ms|-' (absolute epoch ms, clock time). The span object's
    own start_ms/end_ms keys do not exist — this is the real timing field, found by inspecting a live
    response (not documented in the tool schema)."""
    parts = (source_ref or "").split("|")
    if len(parts) < 3:
        return None, None
    try:
        return int(parts[1]), int(parts[2])
    except ValueError:
        return None, None


def pull(session_id, out_dir=WORK_DEFAULT):
    os.makedirs(out_dir, exist_ok=True)
    sess = mcp_client.call("scribe_sessions", {"view": "replay", "session_id": session_id})
    room = sess.get("room") or {}
    room_id, ist_date = room.get("id"), sess.get("ist_date")
    if not room_id or not ist_date:
        raise SystemExit("could not resolve room/ist_date for %s: %s" % (session_id, sess))

    state = mcp_client.call("scribe_get_state", {"room_id": room_id, "ist_date": ist_date})
    room_day_id = (state.get("state") or {}).get("room_day_id")
    if not room_day_id:
        raise SystemExit("no room_day_id for %s on %s: %s" % (room_id, ist_date, state))

    spans_resp = mcp_client.call("scribe_voice", {"view": "window_speakers", "room_day_id": room_day_id, "limit": 500})
    spans = spans_resp.get("spans") or []
    summary = spans_resp.get("summary") or {}

    result = {
        "session_id": session_id, "room_id": room_id, "room_day_id": room_day_id, "ist_date": ist_date,
        "source": "scribe_voice(view=window_speakers)", "n_turns": len(spans), "store_summary": summary,
        "turns": [],
    }

    if not spans:
        result["note"] = "no stored diarization reachable — window_speakers returned 0 spans (clustering usually the reason; see scribe_get_state.clustering.reason)"
        result["clustering"] = (state.get("state") or {}).get("clustering")
        out = os.path.join(out_dir, "turns_%s.json" % session_id)
        json.dump(result, open(out, "w"), indent=1)
        print("no turns for %s — %s" % (session_id, result["note"]))
        print("wrote", out)
        return result

    windows = {}
    for s in spans:
        wid = s.get("window_id")
        if not wid:
            continue
        windows.setdefault(wid, []).append(s)

    for wid in windows:
        wstart = window_start_ms(wid)
        wend = wstart + 900_000 if wstart is not None else None
        for s in windows[wid]:
            start_ms, end_ms = parse_source_ref(s.get("source_ref"))
            result["turns"].append({
                "turn_id": "%s_%d" % (wid, len(result["turns"])),
                "window_id": wid, "speaker_idx": s.get("speaker_idx"),
                "start_ms": start_ms, "end_ms": end_ms,
                "duration_s": round((end_ms - start_ms) / 1000.0, 3) if start_ms is not None and end_ms is not None else None,
                "overlap_ms": s.get("overlap_ms"), "clinician_id": s.get("clinician_id"), "role": s.get("role"),
                "window_start_ms": wstart, "window_end_ms": wend,
            })

    out = os.path.join(out_dir, "turns_%s.json" % session_id)
    json.dump(result, open(out, "w"), indent=1)
    print("%d turns across %d windows for %s" % (len(result["turns"]), len(windows), session_id))
    print("wrote", out)
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: pull_turns.py <session_id> [out_dir]"); sys.exit(2)
    pull(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else WORK_DEFAULT)
