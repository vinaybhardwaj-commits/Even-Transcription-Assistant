# P-SYN script generator (PDQI-9 spec v7 A2.1), text side only

Deterministic generator for the 252 synthetic scripted consults. Everything is
synthetic: invented speakers with plainly fictional names, template consults,
no real consult content, no audio, no TTS, no vendor calls.

```
python -m eval.pdqi9.psyn build --out DIR [--seed N]   # scripts, truth sheets, twins, manifest
python -m eval.pdqi9.psyn validate DIR                 # schemas, hashes, counts, traps, decoys, names
python -m eval.pdqi9.psyn schemas                      # rewrite schemas/*.schema.json
python -m unittest discover -s eval/pdqi9/psyn/tests -t .
```

Requires Python 3.10+ and `jsonschema` (validation only).

- `config.json`: content seed (default for `--seed`) and the prereg `split_seed`. The split
  depends only on `split_seed`, so a new content seed never moves a script between dev and test.
- Output: `dev/<id>/` and `test/<id>/` each hold `script.json`, `truth.json`, `twin.json`
  (S-N also `twin_defect.json`, the scored artefact). `test/README.md` is the do-not-touch guard.
  `enrolment/pseudo_doctors.json` holds the 32 pseudo-doctor enrolment sets.
- `strata/`: one module per stratum; `truth.py` holds the expected-label rules (A4.1, A4.1a.8,
  A4.1c, A4.2); `twin.py` builds the ideal note and the S-N defects.
