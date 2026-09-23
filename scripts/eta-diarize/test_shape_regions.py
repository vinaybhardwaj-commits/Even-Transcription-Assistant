"""Offline test of _shape_regions — the pure half of /speech_regions. No torch, no Silero."""
import json, sys
src = open(sys.argv[1]).read()
fn_src = src[src.index("def _vad_intervals"):src.index("def _speech_regions_blocking")]
ns = {}; exec(fn_src, ns); shape = ns["_shape_regions"]; guard = ns["_apply_level_guard"]; final = ns["_final_regions"]
SR = 16000; fails = []
def check(n, c):
    print(("  ok   " if c else "  FAIL ") + n)
    if not c: fails.append(n)

# pad 0.4 s = 6400 samples, merge gap 1.5 s = 24000, min 0.5 s = 8000
P, G, M = 0.4, 1.5, 0.5
total = 60 * SR

r = shape([(160000, 224000)], total, SR, P, G, M)
check("pad applied both sides", r == [{"start_sample": 153600, "end_sample": 230400, "trim_start_sample": 0}])

r = shape([(0, 16000)], total, SR, P, G, M)
check("pad clamped at clip start", r[0]["start_sample"] == 0)
r = shape([(total - 16000, total)], total, SR, P, G, M)
check("pad clamped at clip end", r[0]["end_sample"] == total)

# two spans 1.0 s apart after padding (gap 1.0 s < 1.5 s) -> merged
r = shape([(100000, 120000), (148800, 170000)], total, SR, P, G, M)
check("spans closer than merge gap become one region", len(r) == 1 and r[0]["start_sample"] == 93600 and r[0]["end_sample"] == 176400)

# a gap of EXACTLY merge_gap after padding is NOT merged: the order says "< 1.5 s".
# (100000,120000) pads to end 126400. A second span starting 156800 pads to start 150400:
# gap = 150400 - 126400 = 24000 samples = exactly 1.5 s -> two regions.
r = shape([(100000, 120000), (156800, 170000)], total, SR, P, G, M)
check("a gap of exactly merge_gap_s is NOT merged (strict <)", len(r) == 2)
r = shape([(100000, 120000), (156799, 170000)], total, SR, P, G, M)
check("one sample under merge_gap_s IS merged", len(r) == 1)

# two spans far apart -> two regions, trim offset = first length
r = shape([(100000, 120000), (400000, 420000)], total, SR, P, G, M)
L0 = r[0]["end_sample"] - r[0]["start_sample"]
check("far spans stay separate", len(r) == 2)
check("trim offsets are the running sum of lengths", r[0]["trim_start_sample"] == 0 and r[1]["trim_start_sample"] == L0)

# (Not DIARIZE_TIMEOUT_MS_DEFAULT's value: diarize-dispatch B3 allows that number in exactly one place,
#  and it greps Python comments too — so this line does not spell it either.)
# a tiny isolated blip: 0.1 s span + 0.8 s padding = 0.9 s >= 0.5 -> KEPT (min applies after pad)
r = shape([(290000, 291600)], total, SR, P, G, M)
check("min is applied AFTER padding", len(r) == 1)
# with pad 0 a 0.1 s blip is dropped
r = shape([(290000, 291600)], total, SR, 0.0, G, M)
check("a region shorter than min is dropped", r == [])

check("no spans -> no regions", shape([], total, SR, P, G, M) == [])
check("unsorted input is handled", shape([(400000, 420000), (100000, 120000)], total, SR, P, G, M) == shape([(100000, 120000), (400000, 420000)], total, SR, P, G, M))
check("empty/reversed spans are ignored", shape([(5, 5), (9, 3)], total, SR, P, G, M) == [])

# overlapping after padding collapses
r = shape([(100000, 110000), (111000, 120000)], total, SR, P, G, M)
check("overlap after padding merges", len(r) == 1)

# emit a realistic multi-region map for the cross-language check
many = [(i * 48000 + 1000, i * 48000 + 9000) for i in range(40)]
r = shape(many, total * 2, SR, P, 0.2, M)
json.dump({"regions": r, "sample_rate": SR, "total_samples": total * 2}, open(sys.argv[2], "w"))
print(f"  --   wrote {len(r)} regions for the TS contract check")

# ── RULING (b): a VAD-silent span is cut ONLY where the level log also showed no activity ──
# Clip of 100 000 samples. VAD found speech at 20 000-30 000 and 60 000-70 000.
T = 100000
VAD = [[20000, 30000], [60000, 70000]]
# The level log confirmed quiet ONLY over 0-50 000. So:
#   cut   = 0-20 000 and 30 000-50 000   (VAD-silent AND level-quiet)
#   kept  = 20 000-30 000 (speech) and 50 000-100 000 (the level log did not confirm quiet there,
#           including 70 000-100 000 where VAD was silent -> disagreement keeps it)
k = guard(VAD, [[0, 50000]], T)
check("cut only where VAD-silent AND level-quiet", k == [[20000, 30000], [50000, 100000]])

check("NO level corroboration -> nothing is cut, whole clip kept", guard(VAD, [], T) == [[0, T]])

# level-quiet everywhere: only VAD speech survives (the most a cut can ever do)
check("level quiet everywhere -> exactly the VAD speech is kept", guard(VAD, [[0, T]], T) == VAD)

# VAD speech INSIDE a level-quiet span is still kept: the level log cannot overrule speech
check("VAD speech inside a quiet span is kept", guard([[40000, 45000]], [[0, T]], T) == [[40000, 45000]])

# the outlier shape: VAD sees almost nothing, level log sees sound (so confirms NO quiet) -> keep all
check("outlier: VAD misses speech, level log active -> nothing cut", guard([[1000, 2000]], [], T) == [[0, T]])

# allow_cut spans are clamped to the clip and tolerate overlap / disorder
check("allow_cut clamped and merged", guard([], [[90000, 150000], [-5, 1000], [500, 2000]], T) == [[2000, 90000]])
check("touching quiet spans behave as one", guard([], [[0, 10], [10, 20]], 100) == [[20, 100]])


# ── RULING (a): VAD-empty is never trimmed, whatever the level log says ──
check("VAD-empty -> no regions, even with the level log quiet everywhere", final([], [[0, T]], T) == [])
check("VAD-empty -> no regions with no level log either", final([], [], T) == [])
r = final(VAD, [[0, 50000]], T)
check("VAD non-empty -> the guarded regions, laid end to end",
      r == [{"start_sample": 20000, "end_sample": 30000, "trim_start_sample": 0},
            {"start_sample": 50000, "end_sample": 100000, "trim_start_sample": 10000}])

print("\nFAILURES:", fails or "none"); sys.exit(1 if fails else 0)
