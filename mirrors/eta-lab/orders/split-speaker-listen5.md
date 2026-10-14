# split-speaker — serve 5 disagreement windows for V's ear (Fable, 22 Sep 18:50 IST)

The bake-off (~/dev/_fable/scratch/bake3/summary.md and results.json) disagreed most on these windows (IST):
1. bw_yce79u6r_1789999200000 (21 Sep 19:30–19:45): lowest frame agreement
2. bw_d4t5tvg9_1789986600000 (21 Sep 16:00–16:15): largest speaker-count spread
3. bw_maaacrdh_1790058600000 (22 Sep 12:00–12:15): local says 1 speaker, pyannote.ai says 9
4. bw_zyjykmwa_1790057700000 (22 Sep 11:45–12:00): WhisperAI hallucination
5. bw_m6nq7upz_1790057700000 (22 Sep 11:45–12:00)

DO: on your :8797 player, serve each window's audio with BOTH diarization tracks drawn as coloured speaker lanes (local vs pyannote.ai, segments from results.json), so V can click and hear who's right. Add a simple per-window form: "which is closer: local / pyannote / both wrong", and "how many people actually speak". Save the answers to ~/dev/_fable/scratch/bake3/v-listen.json.

Then give me the URL (tailnet address). Also stop your stale Yoga :8086 watcher shell; IndicTrans2 is blocked on the HF gate.

REPORT: at most 4 lines.
