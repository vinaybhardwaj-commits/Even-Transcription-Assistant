# Jev v3 wording: FROZEN (fleet, 24 Sep 2026 ~11:27 IST) — ruling 62/63, eta-refuter-2's leakage gate

The wording of the two-stage scan and its detail questions is frozen BEFORE any scoring on the v3 pool. From this point it is not edited until the selection has been scored.
- File: `studies/2026-09-24-surgery-review-v2/v3.py`, git commit **ee5dcb3**, blob sha `fdf75a07c4257796293b17ef3c191d60d9625bf0`; the detail-question text it reuses is in `u9.py` (blob `e3f9b3c5575443c9d0148f1aa6c56d1665a31eb2`, wording u9-v2.2, R1/R2 defaults).
- NOTE: after the freeze v3.py gained ONLY the freeze check itself (canonical_hash / check_frozen and their test); no question text and no cut changed, which is exactly what the hash proves.
- Wording version `u9-v3.0`, recall cut `0.25`.
- **sha256 of the canonical question text** (version, cut, stage A, stage B, detail questions; sorted JSON, UTF-8): `a29f22245670f8c7d78367492272d67bee0634c74a5bc7aea3ea8b0314f09f65`.
- ENFORCED IN CODE: `scan_pool.py` recomputes that hash and REFUSES to run if it differs (`FROZEN_SHA256`). Changing any question, the cut or the version therefore needs a new freeze record first.
- Developed on V's 23 labels ONLY (18 v1 + 5 v2 = 18 distinct consults), a development check, never a score. Not tuned further after the dev check: the status stage did not separate look-alikes from proposals (P01, P05 in the review band) and it was left as it is on purpose.
- Truth for the dev check: P01 = mentioned, not proposed (V's answer, ruling 62); P05 = history; P03 = proposed now.
- Selection gate (ruling 63): items are disjoint from V's labelled consults by token_uid AND by time (no overlapping window in the same room-day); the share of real surgical conversations is judged independently by eta-refuter-2, blind to Jev's output.
