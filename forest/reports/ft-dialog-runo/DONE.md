# ft-dialog-runo DONE (20 Oct 2026 12:45 IST the lab box clock; lane ft-dialog-runo, Claude Opus 5.5 global.anthropic.claude-opus-5-5 on Bedrock). D split only. DESCRIPTIVE, post hoc.
- Report: DIALOG-RUNO.md (sha 1e11f71eaf60, revised after refute). Tables: TABLES.md (a50b9780436b), TABLES_commit.md (4dde18547ae4). Pre-registered: ACTS.md (acd832413443), PLAN.md (f1b8ab9d811e) (header times corrected; original shas fef6cbc223b2, d6dfb710f96a).
- Code (code/): prep 2594a8f34bbc, tag 8de1ec54a6e2, jev_check a548fc771030, agree c5b32e64627a, analyze 7fcce5934518, sens 503ba531577a, tables 8bd412d6db19,
  pick eaee2c096226, quotes 25e0d4f15f2b. Rebuild: prep -> tag run -> jev_check run -> agree -> analyze -> analyze --yes commit -> sens -> tables, tables _commit -> pick -> quotes.
- Work files (text / per-episode rows, 0600 in 0700 dir): ~/eta-data/forest/ft-dialog-runo/. Nothing committed, nothing written to Pulse, nothing deleted.
- Inputs read: ft-lexical items.jsonl + units.parquet + common.ADMIN (read-only), ft-labels-base labels, ft-forest model_frozen_rx_ale.json (L0 M0 OOF),
  ft-engines engine_calls_percall. split_guard (pinned list) 343/343 D. Never read: ft8/H, ft-h1shot/sealed. No Sarvam call made.
- Models: Haiku 5.5 global.anthropic.claude-haiku-5-5 (tagging + quote gloss); Jev jev-latest (served jev-1.13.0) via kit JevClient; patterns by Opus 5.5 (this lane).
- Spend: Haiku tagging 789 requests, 2.01M in / 0.69M out tokens (projected 1.82M in; cap 5M). Quote gloss 18 requests, 6.5k in / 7.0k out.
  Jev 768 requests, 3.05M in / 0.52M out. Jev agreement 3,828 turns: exact 74.6%, kappa 0.70.
- Result (corrected after ft-refute-descr): 4,318 counted tests in 5 BH families. Main-definition families: none at q < 0.10, best mined q 0.12. Commit-only tier 1 family: 2 flags, (i) pt_commit_rate q 7e-5 = selection artefact, (ii) doc_req_count, leg b post-yes role-ok, q 0.037 = a fair comparison (post-yes paperwork, likely reverse direction; q 0.11 in the pooled sensitivity family).
- Refute fixes applied: q count, P1 and P3 marked weak, quotes labelled paraphrase and the 3 non-source phrases replaced by gloss text, PLAN/ACTS header times corrected (PLAN written 71 s after tag start, before the outcome join). No new model calls.
- Refute: ft-refute-descr PASS-WITH-FIXES (ft-refute-descr-REPORT.md).
- Not refuted by a second agent (no -oref lane run).
