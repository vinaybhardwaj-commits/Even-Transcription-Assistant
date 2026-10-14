#!/usr/bin/env python3
"""lang_check.py — hist-bulk: is 'english_dominant' real or a Latin-script artefact? Reads ~/eta-data/hist/out/*/*.json; prints counts/shares only (no text).
Compares router dominant_language, language_timeline span langs (seconds), Indic-script share, and the english_dominant tag."""
import glob, json, os, collections
rs = [json.load(open(f)) for f in glob.glob(os.path.expanduser("~/eta-data/hist/out/*/*.json"))]
def spans(r):   # real router output: language_timeline is a LIST of {start_s,end_s,lang,engine,chars}; harness selftest assumed {"spans": [...]}
    lt = r.get("language_timeline"); return [x for x in (lt if isinstance(lt, list) else (lt or {}).get("spans", [])) if isinstance(x, dict)]
ok = [r for r in rs if r.get("ok") and (r.get("transcript_native") or "").strip()]
print(f"records {len(rs)} | ok {sum(1 for r in rs if r.get('ok'))} | non-empty {len(ok)}")
print("dominant_language:", dict(collections.Counter(r.get("dominant_language") for r in ok)))
print("english_dominant:", collections.Counter(bool(r.get("english_dominant")) for r in ok))
sec = collections.Counter()
for r in ok:
    for s in spans(r): sec[s.get("lang")] += (s.get("end_s", 0) - s.get("start_s", 0))
tot = sum(sec.values()) or 1
print("timeline seconds by lang (share):", {k: round(v / tot, 3) for k, v in sec.most_common(8)}, "| windows with empty timeline:", sum(1 for r in ok if not spans(r)))
# disagreement: router says non-English dominant but the tag says English (Latin-script output for another language?)
dis = [r for r in ok if r.get("english_dominant") and r.get("dominant_language") not in ("en", "english")]
print("english_dominant tag but router dominant_language not en:", len(dis), collections.Counter(r.get("dominant_language") for r in dis))
b = collections.Counter(min(int((r.get("indic_script_share") or 0) * 10), 9) for r in ok); print("indic_script_share deciles:", dict(sorted(b.items())))
by = collections.defaultdict(lambda: [0, 0])
for r in ok: k = r.get("room_id"); by[k][0] += 1; by[k][1] += bool(r.get("english_dominant"))
print("per room (windows, english_dominant):", {k: tuple(v) for k, v in by.items()})
