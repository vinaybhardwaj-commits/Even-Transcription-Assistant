import sys, os, collections
from .report import tables
from .classify import iso, IST

days = ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']
feat = sys.argv[1]
allint, rows, wins, s2r = tables(feat, days)
r2s = {v: k for k, v in s2r.items()}
L = ["# REPORT audio-06 — room audio state: audio_gated sub-state, uncertain consult minutes", "",
     "Classifier `audio-state-6.0`, repo `~/oc/consult/audio/room-audio-state`. Output: `~/eta-data/consult/audio-state/<room>_<day>.jsonl` (0700/0600).",
     "No audio or text in this report. Minutes are IST-day minutes. `recorder_off` includes overnight (no chunk).", "",
     "## Per room-day, 2–6 Oct (minutes)", "",
     "| room | day | usable (audio_present) | uncertain (audio_gated) | muted | zero_all_day | recorder_off | sum | consults | consult min | usable | uncertain | lost muted | lost zero_all_day | lost off |",
     "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
tu = collections.Counter()
for (room, d), r in sorted(rows.items(), key=lambda x: (r2s[x[0][0]], x[0][1])):
    m = r['min']
    if not m and not r['n']:
        continue
    l = r['lost']
    tu['usable'] += r['usable']; tu['uncertain'] += r['uncertain']; tu['consult'] += r['consult_min']
    for k in l: tu[k] += l[k]
    L.append(f"| {r2s[room]} | {d[5:]} | " + " | ".join(str(round(m.get(k, 0))) for k in ['audio_present', 'audio_gated', 'muted', 'zero_all_day', 'recorder_off']) + f" | {round(sum(m.values()))}"
             + f" | {r['n']} | {round(r['consult_min'])} | {round(r['usable'])} | {round(r['uncertain'])} | " + " | ".join(str(round(l.get(k, 0))) for k in ['muted', 'zero_all_day', 'recorder_off']) + " |")
lost = sum(tu[k] for k in ['muted', 'zero_all_day', 'recorder_off'])
L += ["", f"**Totals (235 export windows, all qualities; open windows without t_close skipped):** consult minutes {round(tu['consult'])}; "
      f"on usable audio {round(tu['usable'])}; uncertain (audio_gated) {round(tu['uncertain'])}; lost {round(lost)} (muted {round(tu['muted'])}, zero_all_day {round(tu['zero_all_day'])}, "
      f"recorder_off/no chunk {round(tu['recorder_off'])}).", ""]
from .report import write_day_summary
from .run import OUT
write_day_summary(allint, rows, os.path.join(OUT, "day-summary.jsonl"))
open(sys.argv[2], 'w').write("\n".join(L))
print("\n".join(L[-3:]))
