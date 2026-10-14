#!/usr/bin/env python3
"""337c(2) hallucination checks on the whisper re-run outputs (eta-refuter #2111 point 2). COUNTS ONLY are printed; no text.
 (a) recurrence: the same output string (lower-cased, stripped) appearing >= 3 times across the results, and in how many distinct windows/rooms;
 (b) voiced seconds per segment (webrtcvad mode 2, 30 ms frames, 16 kHz wav from the cutter) vs output characters: chars per VOICED second, and
     'text on near-silence' = < 1.0 voiced seconds but >= 10 characters;
 Also reports the empty rate and chars per audio second next to it, per forced language, and NEVER a before/after structural-score pair.
Writes r1/results/hall.json (per result id: voiced_s, cps_audio, cps_voiced, recur, near_silence_text) for the sheet builder."""
import collections, glob, json, os, statistics, wave
import webrtcvad
R1 = os.path.expanduser("~/eta-data/readable-rerun/r1/")
man = {}
for k in range(4):
    for l in open(R1 + f"s{k}/manifest.jsonl"):
        m = json.loads(l); man[m["id"]] = m; m["_dir"] = f"s{k}"
res = []
for f in glob.glob(R1 + "results/s*_whisper_large-v3.jsonl"):
    res += [json.loads(l) for l in open(f)]
vad = webrtcvad.Vad(2)
def voiced_s(path):
    w = wave.open(path); pcm = w.readframes(w.getnframes()); n = 480 * 2; v = 0
    for i in range(0, len(pcm) - n + 1, n):
        if vad.is_speech(pcm[i:i + n], 16000): v += 1
    return v * 0.03
cnt = collections.Counter(); wins = collections.defaultdict(set); rooms = collections.defaultdict(set)
for r in res:
    t = r["text"].strip().lower()
    if t:
        cnt[t] += 1; wins[t].add(man[r["id"]]["record"]); rooms[t].add(man[r["id"]]["record"].split("/")[2] if man[r["id"]]["record"].startswith("runs/") else man[r["id"]]["record"])
out = {}; per = collections.defaultdict(list)
for r in res:
    m = man[r["id"]]; t = r["text"].strip(); L = m["force_lang"] or "auto"
    v = voiced_s(R1 + m["_dir"] + "/" + r["id"] + ".wav"); c = len(t)
    d = {"voiced_s": round(v, 2), "cps_audio": round(c / max(1, m["dur_s"]), 2), "cps_voiced": round(c / max(0.5, v), 2), "recur": cnt[t.lower()] if t else 0,
         "recur_windows": len(wins[t.lower()]) if t else 0, "near_silence_text": bool(t and v < 1.0 and c >= 10), "empty": not t}
    out[r["id"]] = d; per[L].append(d)
json.dump(out, open(R1 + "results/hall.json", "w"))
print("results", len(res), "| strings seen >=3x:", sum(1 for c in cnt.values() if c >= 3), "covering", sum(c for c in cnt.values() if c >= 3), "segments; max repeat", max(cnt.values()) if cnt else 0,
      "| in >=3 distinct windows:", sum(1 for t, c in cnt.items() if c >= 3 and len(wins[t]) >= 3))
for L, v in sorted(per.items(), key=lambda x: -len(x[1])):
    ne = [x for x in v if not x["empty"]]; q = lambda a, p: round(sorted(a)[int(len(a) * p)], 1) if a else None
    print(L, "n", len(v), "empty", round(1 - len(ne) / len(v), 2), "| chars/audio-s med", q([x["cps_audio"] for x in ne], .5), "| voiced s med", q([x["voiced_s"] for x in v], .5),
          "| chars/voiced-s med", q([x["cps_voiced"] for x in ne], .5), "p90", q([x["cps_voiced"] for x in ne], .9),
          "| text on near-silence", sum(1 for x in v if x["near_silence_text"]), "| recurring>=3:", sum(1 for x in ne if x["recur"] >= 3))
