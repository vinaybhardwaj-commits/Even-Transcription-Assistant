# Compare Transcripts page (A/B), prepared for indic-mt's 106-row sheet

STATUS: files only. **Parked until conductor/Fable approve a third set (`ba106`) on the rating host** (r349/r359 name two sets). Nothing is loaded or served from here.

Blind side-by-side page: the same speech transcribed two ways (A and B) with the claimed language, and five answers: **A is better / B is better /
about the same / neither is readable / unsure** (+ optional note). Raters V and Sandhya. It is the segment-label page (`../segment-label`) with two text blocks, so
it runs through lab-viewer's db/user shim and CSP rules (no fonts, no inline style attributes, esc() on every value).

* `page.html`: reads collection `rows` through a whitelist (id, n, lang, text_A, text_B); answers go to `labels/<rater id>` = `{t:{<id>:{a, note?, ts}}}`, `a` in
  `a_better|b_better|same|neither_readable|unsure`. No engine, model, version, key, flag, score or timing can reach the screen (proved in the browser check with a mock full of them).
* `build_seed.py --rows <rows.json> --out <dir> [--expect 106]`: indic-mt sends `{"rows":[{id:"P001", n, lang, text_A, text_B}]}` (opaque P### ids, no key); it refuses any extra field, empty text, A == B, duplicates. The A-is-old/B-is-new mapping stays in indic-mt's key; keep A/B order shuffled as built.
* `./browser-check.sh [outdir]`: real Chromium at 375 px touch + 1280 px, light + dark, mock API, 4/4 PASS. `MOCK_DIR=<docs> python3 make-harness.py out.html` wraps other rows.
* Audio is out (no clip route); if a play button is wanted later it needs a new audio route and a decision on serving stored clips.
