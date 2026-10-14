# Transcript Readability page (ruling 337f)

Private rating page for the success metric of ruling 337: 20 random consult excerpts, each rated by V and Sandhya on
**Readable? / Useful? / Wrong language? / Garbled?** (3 answers each). If any line in an excerpt has an English translation
(`en`), a fifth question, **English right?**, appears for that excerpt only. The score Fable reports = the share of ratings
in each best answer, on the owner's Results tab (all excerpts, mostly-Indic excerpts, mostly-English/other excerpts).

Owner surg-page builds; **Fable publishes and seeds** (never the builder). Files here carry no patient text: the mock excerpts are invented.

## Artifact
* `page.html`: single-file artifact, capabilities `db` + `user` (scopes `["profile"]`).
* db rules: `excerpts` read `view`, write `admin`; `ratings` read `interact`, write `interact` (as the other rater pages; the two raters could read each other's ratings through devtools, which is fine here because the metric is not a blind label).
  Ratings are written to `ratings/<rater id>` = `{rater, schema:1, t:{<excerptId>:{readable, useful, wrong_lang, garbled, en_ok?, note?, ts}}}`.
* Excerpt doc: `{id:"R01", lines:[{t:"HH:MM:SS", lang:"kn", text:"…", en?:"…"}]}`. The page keeps only those fields; room, window,
  run, engine, producer never reach the page (a mock with such fields proves it in the browser check).
* Order is a fixed hash scramble of the id. No audio (not in the ruling); an optional clip could be added later.
* Lines look like the consult reader: `[HH:MM:SS] (lang) text`, English directly under every non-English line, or "No English for this line yet."

## Seed (box only, never git)
```
python3 build_seed.py --vault ~/eta-data/lab-vault/staged --out ~/eta-data/readability-rate/seed1 \
    --dates 2026-09-22..2026-09-24 --n 20 --seed 337 [--min-indic K]
python3 check_seed.py ~/eta-data/readability-rate/seed1 --expect 20
```
Reads the newest `index/view-*.jsonl` (from `--vault`) and resolves each row's `key` against `--roots` in order (default `~/eta-data/hist-mining`,
`~/eta-data/hist`, `~/eta-data/lab-vault/staged`, the same as the viewer); on 25 Sep all 786 text windows of 22 to 24 Sep resolve. Refused segments are dropped;
each pick is a random run of consecutive segments (about 40 to 150 words, at most 14 lines). `key.json` (0600) maps `R01..` to the window and
records language (`dominant`, `indic` = most of the text is Indic, `any_indic`), `has_en` and `t_relative` (bench clips have no absolute start, so their times count from the start of the recording).
`seed_docs.json` = `{"excerpts":[…]}`: one doc per element, doc id = `id`. `text_en` is copied when a segment has it; translations held in `annotations/` are not merged yet.

Best to build the seed after 337b has stored `text_en` for 22 to 24 Sep, so the raters judge what they will really see; `has_en` in the key says
which excerpts carried English.

## Check
`./browser-check.sh [outdir]` (real Chromium at 375 px touch and 1280 px, light + dark; setup as in `../surgery-review/browser-check.sh`).
`MOCK_DIR=<dir of doc json> python3 make-harness.py out.html` builds the same harness around any excerpts, e.g. the real seed.
