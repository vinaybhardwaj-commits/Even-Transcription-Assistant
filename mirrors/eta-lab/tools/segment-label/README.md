# Segment Label page (ruling 337c: the 200-row label sample)

Blind label page for split-speaker's frozen 200-segment sample (`PREREG-337c` + addendum 1). One transcript line per screen with the
language the system *claims* for it (no engine, flag, score or reason), five labels: **readable / romanised_readable / garbled /
wrong_language / unsure**. Raters are V and Sandhya (no model reader on real text). Owner surg-page builds; **Fable publishes and seeds**.

* `page.html`: single-file artifact, capabilities `db` + `user` (scopes `["profile"]`). Rules: `rows` read `view`, write `admin`;
  `labels` read `interact`, write `interact`. Labels go to `labels/<rater id>` = `{rater, schema:1, t:{<rowId>:{a, note?, ts}}}`.
* Row doc: `{id:"L001", n, lang, dur_s, text}`; the page whitelists exactly these fields (a mock full of engine/flag/score/window fields proves none reach the DOM). Order = the sheet's own shuffle (`n`).
* Keys 1 to 5 label, N/P move, optional "move on after I label". Owner Results tab: counts per rater and agreement between raters (precision/recall are computed off the page).
* `build_seed.py --sheet ~/eta-data/readability/r1/sample200_sheet_v2.tsv --out <dir>` then `check_seed.py <dir> --expect 200`. `key.json` (0600) maps `L###` to the sheet's id column (window#segment); it never enters a doc. Box only, never git.
* `./browser-check.sh [outdir]`: real Chromium, 375 px touch and 1280 px, light + dark. `MOCK_DIR=<docs> python3 make-harness.py out.html` wraps any docs.
* Labels are read back with ArtifactData on the collection `labels` (one doc per rater); join `L###` to the private key to score flagged vs unflagged.
