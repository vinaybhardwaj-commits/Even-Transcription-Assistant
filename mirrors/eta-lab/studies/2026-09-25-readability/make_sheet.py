"""make_sheet.py: the BLIND labelling sheet for the 200-segment sample (addendum 1 to PREREG-337c, after eta-refuter #1909/#1914). Replaces sample200_sheet.tsv (stratum-ordered, so a labeller could read flag status from position;
never labelled, kept as superseded).
  * rows SHUFFLED with a separate recorded seed (SHEET_SEED 20260936; partial Fisher-Yates over random.Random(seed).random()); the id -> stratum/flag key is written to a SEPARATE box-only file;
  * columns: n, id, lang (the CLAIMED language label), start_s, end_s, text, label. NO engine, flag, score or reason. (The text itself shows its script: that is unavoidable.)
  * label set: readable | romanised_readable | garbled | wrong_language | unsure.
      readable            a fluent speaker can follow it (native script or English)
      romanised_readable  Indic language written in Latin letters that a fluent reader can follow (reported separately: it decides the flag's precision on the Latin-script Indic-engine cells)
      garbled             the words do not make sense
      wrong_language      the text is in a language other than the one spoken (listen to the clip if needed)
      unsure
Output (box only, 0600, never overwritten): sample200_sheet_v2.tsv, sample200_key_v2.json."""
import json, os, random, sys

import score_all

SHEET_SEED = 20260936


def shuffle(rows, seed):
    rng = random.Random(seed)
    pool = list(rows)
    for j in range(len(pool)):
        k = j + int(rng.random() * (len(pool) - j))
        pool[j], pool[k] = pool[k], pool[j]
    return pool


if __name__ == "__main__":
    d = json.load(open(sys.argv[1]))                       # sample200_ids.json
    out_dir = sys.argv[2]
    rows = shuffle(d["rows"], SHEET_SEED)
    want = {r["id"] for r in rows}
    texts = {}
    for wid, (_p, rec) in score_all.latest_records().items():
        for i, s in enumerate(rec["segments"]):
            if f"{wid}#{i}" in want:
                texts[f"{wid}#{i}"] = " ".join((s.get("text") or "").split())
    lines = ["n\tid\tlang\tstart_s\tend_s\ttext\tlabel"]
    key = {}
    for n, r in enumerate(rows, 1):
        lines.append("\t".join([str(n), r["id"], str(r["lang"]), str(r["start_s"]), str(r["end_s"]), texts.get(r["id"], ""), ""]))
        key[str(n)] = dict(id=r["id"], cell=r["cell"], flagged=r["flagged"], engine=r["engine"])
    score_all.write_private(os.path.join(out_dir, "sample200_sheet_v2.tsv"), "\n".join(lines) + "\n")
    score_all.write_private(os.path.join(out_dir, "sample200_key_v2.json"), json.dumps(dict(sheet_seed=SHEET_SEED, key=key), indent=1) + "\n")
    print("rows", len(rows), "| first 20 rows flagged status pattern (should look random):", "".join("F" if r["flagged"] else "u" for r in rows[:40]))
