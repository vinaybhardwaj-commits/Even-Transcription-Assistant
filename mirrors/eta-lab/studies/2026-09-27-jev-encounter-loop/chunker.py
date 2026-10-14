"""chunker.py — turn-level STT -> ~60s text-bearing chunks (README §A). `build_chunks` is a pure function
(segmenter.py's own convention: inputs are plain data, no database, no audio) so it is fully offline-testable;
`fetch_turns`/`fetch_translations` are the only two functions that touch a real source, kept separate so
run_loop.py can be pointed at either real data or a synthetic fixture without changing the chunking logic.

Turn shape in: {start_ms, end_ms, orig, lang, speaker_idx, role}. role is room_turn_speaker.role
('clinician'/'patient'/'companion'/'staff'/...); bucketed to {clinician, other, unknown} per README §A.
"""
import json, os, subprocess, sys
import jev_loop_constants as K

ETA = os.path.expanduser("~/dev/Even-Transcription-Assistant")   # neon-select needs an ETA checkout's node_modules
NEON = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")


def neon(sql):
    r = subprocess.run(["node", NEON, sql], cwd=ETA, capture_output=True, text=True, timeout=600)
    if r.returncode:
        raise SystemExit(f"STAGE_FAIL neon-select rc={r.returncode}: {r.stderr[:200]}")
    return json.loads(r.stdout)


def fetch_turns(room_day_id):
    """cue(type='stt_turn') JOIN room_turn_speaker on source_ref, same join sets.py/vj's fetch_turns.py use.
    source_ref = <session>|<start_ms>|<end_ms>|- (absolute epoch ms)."""
    if not room_day_id.replace("_", "").isalnum():
        raise SystemExit("STAGE_FAIL bad room_day_id")
    rows = neon(f"""SELECT rts.source_ref, rts.speaker_idx, rts.role, cu.payload->>'text' AS orig,
                    cu.payload->>'language' AS lang FROM room_turn_speaker rts
                    JOIN cue cu ON cu.source_ref = rts.source_ref AND cu.type = 'stt_turn'
                    WHERE rts.room_day_id = '{room_day_id}'""")
    out = []
    for r in rows:
        parts = r["source_ref"].split("|")
        out.append({"start_ms": int(parts[1]), "end_ms": int(parts[2]), "orig": r.get("orig") or "",
                    "lang": r.get("lang"), "speaker_idx": r["speaker_idx"], "role": r.get("role"),
                    "source_ref": r["source_ref"]})
    out.sort(key=lambda t: t["start_ms"])
    return out


def fetch_translations(room_day_id, turns):
    """337b Gemini/Vertex English translation per turn (source_ref -> English text). NOT YET WIRED: no stable
    table/file was confirmed for this in the repo as of W44 (README §A open item 1) — refuses rather than
    guessing a source. Ask Fable/linker, then replace this body; do not invent a query."""
    raise SystemExit("STAGE_FAIL fetch_translations: 337b English-translation source not named yet for lx "
                      "(W44 README §A open item 1) — ask Fable, do not guess a table/file")


def _role_bucket(role):
    if role == "clinician":
        return "clinician"
    if role is None:
        return "unknown"
    return "other"


def build_chunks(turns, translations, room, date, rd_id, target_ms=None):
    """turns: fetch_turns() shape, sorted. translations: {source_ref: english_text or None}. Groups consecutive
    turns up to ~target_ms without ever splitting a turn (turns already sit at speaker/silence boundaries).
    Returns (chunks, prev_texts) — prev_texts[i] is chunks[i-1]['text'] ("" for the first chunk)."""
    target_ms = target_ms or K.CHUNK_TARGET_MS
    chunks, group = [], []

    def flush(next_turn_start):
        if not group:
            return
        t0, t1 = group[0]["start_ms"], group[-1]["end_ms"]
        origs, ens, missing = [], [], False
        speakers = {}
        for t in group:
            origs.append(t["orig"])
            en = translations.get(_source_ref(t))
            if en:
                ens.append(en)
            else:
                missing = True
            speakers[(t["speaker_idx"], _role_bucket(t["role"]))] = True
        prev_end = chunks[-1]["end_ms"] if chunks else None
        chunks.append({
            "room": room, "date": date, "rd_id": rd_id, "chunk_id": f"{rd_id}-c{len(chunks)}",
            "start_ms": t0, "end_ms": t1,
            "orig": " ".join(o for o in origs if o),
            "text": " ".join(ens),
            "translation_missing": missing or not ens,
            "speakers": [{"speaker_id": sid, "role": role} for (sid, role) in speakers],
            "silence_before_ms": (t0 - prev_end) if prev_end is not None else None,
            "silence_after_ms": (next_turn_start - t1) if next_turn_start is not None else None,
        })

    for i, t in enumerate(turns):
        group.append(t)
        dur = group[-1]["end_ms"] - group[0]["start_ms"]
        is_last = i == len(turns) - 1
        if dur >= target_ms or is_last:
            next_start = turns[i + 1]["start_ms"] if not is_last else None
            flush(next_start)
            group = []
    # silence_after_ms was computed one turn early for all but the flushed chunk's own next; backfill from the
    # chunk that follows (chunks are built in order, so chunk i's silence_after is chunk i+1's start minus its end).
    for i in range(len(chunks) - 1):
        chunks[i]["silence_after_ms"] = chunks[i + 1]["start_ms"] - chunks[i]["end_ms"]
    prev_texts = [""] + [c["text"] for c in chunks[:-1]]
    return chunks, prev_texts


def _source_ref(t):
    return t.get("source_ref") or f"?|{t['start_ms']}|{t['end_ms']}|-"
