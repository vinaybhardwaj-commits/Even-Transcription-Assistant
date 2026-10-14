#!/usr/bin/env python3
"""fetch_turns.py — the full consult, called_at -> completed_at, as speaker-labelled turns (SURGERY-REVIEW-V2 items 2, 6).

Speaker label rule (settled in the order): 'Doctor' only from the diarize hybrid's voiceprint attribution (room_turn_speaker.role='clinician'),
propagated WITHIN one diarization window to the other turns of the same speaker_idx when that (window, speaker) group is
majority clinician-attributed. Everything else is 'Speaker A/B/...' by window-local speaker_idx (letters restart each window;
a window break is shown). Nothing is guessed. No 'patient' label exists in the data (only role 'clinician' or empty).
Writes ~/eta-data/surgery-review-v2/work/<id>.turns.json (0600). Prints counts only.
"""
import json, os, re, subprocess, sys
from collections import Counter, defaultdict

HELPER = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")
REPO = os.path.expanduser("~/dev/Even-Transcription-Assistant")
OUT = os.path.expanduser("~/eta-data/surgery-review-v2")
IDRE = re.compile(r"^[A-Za-z0-9_\-]+$")


def neon(sql):
    r = subprocess.run(["node", HELPER, sql], cwd=REPO, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise SystemExit(f"neon-select failed rc={r.returncode}")
    return json.loads(r.stdout)


def label_turns(rows):
    """rows: [{at, text, lang, window, speaker_idx, role}] in time order. Returns turns with 'speaker' and 'speaker_basis'."""
    grp = defaultdict(lambda: [0, 0])  # (window, speaker_idx) -> [turns, clinician_turns]
    for r in rows:
        if r["speaker_idx"] is None:
            continue
        g = grp[(r["window"], r["speaker_idx"])]
        g[0] += 1
        g[1] += 1 if r["role"] == "clinician" else 0
    out = []
    for r in rows:
        k = (r["window"], r["speaker_idx"])
        if r["role"] == "clinician":
            sp, basis = "Doctor", "voiceprint"
        elif r["speaker_idx"] is not None and grp[k][1] > 0 and grp[k][1] / grp[k][0] >= 0.5:
            sp, basis = "Doctor", "voiceprint_same_speaker_in_window"
        elif r["speaker_idx"] is None:
            sp, basis = "Unattributed", "none"
        else:
            sp, basis = f"Speaker {chr(65 + int(r['speaker_idx']) % 26)}", "diarization_only"
        out.append({**r, "speaker": sp, "speaker_basis": basis})
    return out


def fetch(c):
    for v in (c["room_day_id"],):
        if not IDRE.match(v):
            raise SystemExit("unexpected id characters")
    rows = neon(f"""SELECT cu.at, cu.payload->>'text' AS text, cu.payload->>'language' AS lang, cu.payload->>'window' AS window,
        (cu.payload->>'start_ms')::bigint AS start_ms, rts.speaker_idx, rts.role
        FROM cue cu LEFT JOIN room_turn_speaker rts ON rts.source_ref = cu.source_ref
        WHERE cu.type='stt_turn' AND cu.room_day_id='{c['room_day_id']}' AND cu.at BETWEEN '{c['called']}' AND '{c['done']}'
        ORDER BY cu.at, (cu.payload->>'start_ms')::bigint""")
    rows = [r for r in rows if (r["text"] or "").strip()]
    return label_turns([{"at": r["at"], "text": r["text"].strip(), "lang": (r["lang"] or "").lower(), "window": r["window"],
                         "speaker_idx": r["speaker_idx"], "role": r["role"]} for r in rows])


def main():
    sel = json.load(open(f"{OUT}/selection.json"))["pilot"]
    os.makedirs(f"{OUT}/work", exist_ok=True); os.chmod(f"{OUT}/work", 0o700)
    for c in sel:
        c = {**c, "called": c["called"], "done": c["done"]}
        turns = fetch(c)
        p = f"{OUT}/work/{c['id']}.turns.json"
        json.dump(turns, open(p, "w"), ensure_ascii=False); os.chmod(p, 0o600)
        print(c["id"], "turns", len(turns), "| chars", sum(len(t["text"]) for t in turns),
              "| langs", dict(Counter(t["lang"] or "?" for t in turns)),
              "| speakers", dict(Counter(t["speaker"] for t in turns)),
              "| basis", dict(Counter(t["speaker_basis"] for t in turns)), "| windows", len({t["window"] for t in turns}))


if __name__ == "__main__":
    main()
