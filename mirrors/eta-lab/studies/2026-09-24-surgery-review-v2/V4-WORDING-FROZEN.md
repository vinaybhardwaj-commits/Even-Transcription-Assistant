# Jev v4 wording FROZEN (Fable ruling 148, 24 Sep 2026)

Frozen BEFORE any v4 scoring of the re-seed. `v4.py` refuses to score (check_frozen, SystemExit REFUSED) if any question text, the recall cut or the version differs from the frozen hash.

- Wording version: `u9-v4.0`
- Recall cut (stage a, gate on max(named, described)): 0.25
- canonical hash (sha256 of version, recall cut, A = named + described, B = status / raised_by / category, C_PROPOSED, C_DESCRIBED): `b2ebc86f5a74987172d8464529748920b26c4cf1ec9c737c44124dcc961ad960`
- v4.py blob: `874b897e128684ae14037f3c95137d3771cf22d4`; v3.py blob (B and C sets are imported from it): `69c42de0da333ace0560b72f0c6cc88f41406cce`; u9.py blob (firmness / patient_response / cost / second_opinion wording): `e3f9b3c5575443c9d0148f1aa6c56d1665a31eb2`
- Change from v3 (a29f22245670..., still frozen for the 12 rated consults): the single recall question (name AND description) is split into two independent noul questions, NAMED and DESCRIBED (trial: V4-NAMED-DESCRIBED-TRIAL.md; V3-02 = named 0.06 / described 0.97). Stage (b) and the detail questions are v3's, unchanged; they are shown when EITHER named or described is yes.
- Tests: `python3 v4.py` (selftest: changed question, changed cut refused; skip logic; gate on max), 7 freeze mutants killed.
- Verify: `python3 -c "import v4; v4.check_frozen(); print(v4.canonical_hash())"` must print the hash above.
