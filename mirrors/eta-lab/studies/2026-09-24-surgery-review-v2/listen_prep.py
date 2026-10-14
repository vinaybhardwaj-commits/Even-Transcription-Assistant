#!/usr/bin/env python3
"""listen_prep.py <dir:id> ... — ruling 101: a 20-second listening check at EACH boundary of every item. An agent cannot hear audio, so this builds the closest honest thing: for each edge
(encounter start / end) the 20 s of AUDIO around it (10 s before, 10 s after) is transcribed by the box Whisper twin, and set beside the stored transcript of the same 20 s (each turn tagged in / outside).
Output ~/eta-data/surgery-review-v3/listen/<id>.json (0600; RAW text, box-local, never shared): {id, edges:[{edge, t_s, whisper_20s, doc_turns:[{phase, start_s, text}], word_overlap}]}.
The verdicts the reviewing agent writes contain NO text."""
import json, os, sys
import audio_check as ac

V3 = ac.V3


def prep(spec):
    d, q = spec.split(":"); st = json.load(open(f"{V3}/{d}/staging/{q}.json")); mp3 = f"{V3}/{d}/audio/{q}/full.mp3"; lo = st["span"]["start_ms"]
    edges = []
    for name, ms in (("start", st["encounter"]["start_ms"]), ("end", st["encounter"]["end_ms"])):
        t = (ms - lo) / 1000.0; a = max(0.0, t - 10.0)
        w = ac.whisper(mp3, a, 20)
        turns = [{"phase": x.get("phase", "in"), "start_s": round(x["start_s"], 1), "text": x["orig"]} for x in st["turns"] if x["start_s"] < a + 20 and x["end_s"] > a]
        ov, n = ac.score(w, [{"orig": x["text"], "start_s": x["start_s"], "end_s": x["start_s"] + 1} for x in turns], -1, 10 ** 6)
        edges.append({"edge": name, "t_s": round(t, 1), "window_s": [round(a, 1), round(a + 20, 1)], "whisper_20s": w, "doc_turns": turns, "word_overlap": ov, "ref_words": n})
    os.makedirs(f"{V3}/listen", mode=0o700, exist_ok=True)
    p = f"{V3}/listen/{q}.json"; json.dump({"id": q, "dir": d, "edges": edges}, open(p, "w"), ensure_ascii=False, indent=1); os.chmod(p, 0o600)
    return q, [(e["edge"], e["word_overlap"], e["ref_words"], len(e["doc_turns"])) for e in edges]


if __name__ == "__main__":
    for s in sys.argv[1:]:
        print(*prep(s))
