"""Synthetic fixture (no PHI): 24 windows x 6 turns. Writes fixture/ with blinded inputs (cards.jsonl, clips.jsonl, arm1_in.jsonl) and SEPARATE scorer-only files (truth_turns.jsonl, human-counts.json).
Audio = generated tones (two 'voices' as different pitches) so the clip cutter is exercised; the live Gemini probe uses a real TTS clip instead.
Usage: make_fixture.py [outdir]"""
import json, math, os, random, struct, sys, wave

def tone_wav(path, segs, sr=16000):
    """segs = [(seconds, hz)] -> mono 16-bit wav."""
    w = wave.open(path, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    for secs, hz in segs:
        w.writeframes(b"".join(struct.pack("<h", int(6000 * math.sin(2 * math.pi * hz * i / sr))) for i in range(int(secs * sr))))
    w.close()

def main(out="fixture"):
    rnd = random.Random(7); os.makedirs(out, exist_ok=True)
    cards, clips, arm1, truth, wins, human = [], [], [], [], [], {}
    for w in range(24):
        wid = f"fxw{w:02d}"; t = 0.0; segs = []
        n_true = rnd.choice([2, 3, 4])
        for k in range(6):
            tid = f"{wid}-t{k}"; dur = round(rnd.uniform(2.0, 5.0), 1)
            is_doc = rnd.random() < 0.5
            doubtful = rnd.random() < 0.5
            label_ok = rnd.random() < (0.55 if doubtful else 0.95)          # production is right ~55% on doubtful, ~95% on confident
            label = "doctor" if (is_doc == label_ok) else "patient"
            margin = round(rnd.uniform(0.0, 0.09), 3) if doubtful else round(rnd.uniform(0.12, 0.5), 3)
            lab = "doctor" if is_doc else rnd.choice(["patient", "companion", "staff"]); x = rnd.random()   # two raters: mostly agree, sometimes 'cannot tell', rarely disagree
            truth.append({"turn_id": tid, "labels": {"V": lab, "Sandhya": "cannot tell" if x < 0.08 else ("patient" if (x < 0.12 and is_doc) else lab)}})
            arm1.append({"turn_id": tid, "window_id": wid, "role": "clinician" if label == "doctor" else rnd.choice(["", "patient", None]), "margin": margin, "speaker_basis": "voice_match",
                         "nemotron_n": n_true if rnd.random() < 0.8 else n_true + 1, "pyannote_n": n_true, "doctor_name": "Dr Test"})
            card = (f"Turn: {t:.1f}-{t + dur:.1f} s ({dur} s) in a synthetic consultation.\nVoice match: best candidate Dr Test {margin + 0.5:.2f}; runner-up speaker cluster 2 0.50; margin {margin}.\n"
                    f"Transcript (guarded):\n[previous turn, speaker A] \"synthetic previous line {k}\"\n[THIS TURN] \"synthetic line {k} for {tid}\"\n[next turn, speaker B] \"synthetic next line\"\n\n"
                    "Q1 (choice): Who is most likely speaking in THIS TURN?\n")
            cards.append({"turn_id": tid, "window_id": wid, "doctor_name": "Dr Test", "card_text": card,
                          "raw_text": f"embedding {[round(rnd.uniform(-1, 1), 4) for _ in range(8)]}\ncentroid Dr Test {[round(rnd.uniform(-1, 1), 4) for _ in range(8)]}\n\nQ1 (choice): Who is most likely speaking in THIS TURN?\n"})
            clips.append({"turn_id": tid, "window_id": wid, "audio_path": os.path.abspath(f"{out}/{wid}.wav"), "turn_start_s": round(t, 1), "turn_end_s": round(t + dur, 1),
                          "window_start_s": 0.0, "window_end_s": None})
            segs.append((dur, 180 if is_doc else 260)); t += dur
        tone_wav(f"{out}/{wid}.wav", segs)
        wins.append({"window_id": wid, "duration_s": round(t, 1)})
        human[wid] = {"V": n_true, "Sandhya": n_true if rnd.random() < 0.7 else n_true + 1}
    for name, rows in (("cards", cards), ("clips", clips), ("arm1_in", arm1), ("truth_turns", truth), ("windows", wins)):
        with open(f"{out}/{name}.jsonl", "w") as f:
            for r in rows: f.write(json.dumps(r) + "\n")
    json.dump(human, open(f"{out}/human-counts.json", "w"), indent=1)
    conf = sorted(a["turn_id"] for a in arm1 if a["margin"] >= 0.10)          # stand-in for the page's 40 confident items (ruling 169)
    open(f"{out}/page_confident.txt", "w").write("\n".join(rnd.sample(conf, min(40, len(conf)))) + "\n")
    print(f"fixture: {len(cards)} turns, {len(wins)} windows in {out}/")

if __name__ == "__main__":
    main(*sys.argv[1:2])
