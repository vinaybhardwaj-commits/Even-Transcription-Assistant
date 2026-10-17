# ENCOUNTER-BRIEF v2 notes: refute fixes and rulings, closed

Companion to `docs/freescript/ENCOUNTER-BRIEF-SPEC-v2.md` (17 Oct 2026). v1 stays unchanged. The refute verdict was PASS-WITH-FIXES, and the lead ruled on OQ-1 to OQ-20.

## Closure table

| item | closed in v2 by | spec section |
|---|---|---|
| M1 no fail-open | In live brief mode every failure runs `no_order` (all prompts) or skips the consult; it never falls back to `current`. Shadow is unchanged | §9.2, §8.2 item 2 |
| M2 no medicine leaks | Every medicine becomes a `pick_drug` prompt via R1 `_to_pick_drug`; Stage W drops units naming an unlisted drug and how-to-take units with doses; R2 runs after the doctor's-words text is written; FRX-B1 rejects medicine rows; §11.2 rescoped to prompts | §8.5, §7.2, §8.2, §8.4, §11.2 |
| M3 non-treating voices | Clef votes null for every label but its doctor_slot; two 3/3 doctors give prompts unless arm (c) names one; relay check runs on doctor-voted labels | §5.6, §6.3, §6.5 |
| M4 third label | Arm (c) on a third label means no span orders; arm (c) on one of two 3/3 doctors means only that label orders | §6.3 table |
| M5 OQ-3 mapping | A mapping that is not clean leaves voters 2 and 3 absent, so 3/3 cannot fire, arm (c) is off and the consult is all prompts | §5.6, §9.2 |
| M6 gates | 0a reports the counts under the old and both-margins definitions plus a labelled false-doctor-attribution rate; 1a depends on 0b; no live run before the 1c verdict and fable's gate (live lock) | §12, §9.1, header |
| S1 all-prompt share | 0a reports the share for each §9.2 condition | §12 0a, §9.2 |
| S2 two arm (c) doctors | Removed: the next-label margin admits at most one label; `label_split` deleted | §5.6, §6.3, §6.6 |
| S3 input_mode in artifact | `generator.version` suffix `+input.<mode>`; FRX-B1 fails a run with it missing or mismatched | §8.2 item 6 |
| S4 attender overlap under 30% | A per-number speaker check; a number from a speaker who cannot order is dropped and raised as `dose_unstated` | §6.4 |
| S5 tests | All 9 requested tests added as unit tests, plus fixtures 13-18 | §10.1, §10.2 |
| OQ-1 | Phase 0a ports the pdqi9 code as `role_votes.v1`, with the Jev question id in the metadata | §5.6, §12 |
| OQ-2 | Default accepted | §5.2 |
| OQ-3 | Bundle `diar_nemotron` is the backbone; 0a proves the mapping to app `spkN` | §5.6 |
| OQ-4 | Both margins of at least 0.05: next label, and runner-up centroid | §5.6 |
| OQ-5 | Unknown, no order, `doctor_conflict` logged | §6.3, §6.6 |
| OQ-6 | Defaults in shadow; the labelled set is P-SYN plus 20 hand-checked real consults | §12, §10.2 |
| OQ-7, OQ-8, OQ-9 | Defaults accepted | §8.2, §5.5, §4.7 |
| OQ-10 | 10/700 in shadow only; live stays 5/300 until the PDQI-9 arm run | §8.4, §11.2 |
| OQ-11 | Weights in shadow only | §7.3, §8.4 |
| OQ-12 | Announce to fable before any runner move; new consults only (`--brief-from`) | §8.1, §9.1 |
| OQ-13 | Confirmed: no fallback; all prompts | §9.2 |
| OQ-14, OQ-15 | Defaults accepted | §11.2 |
| OQ-16 | Today's FRX-N1 rule; the policy belongs to fable | §12, §14 |
| OQ-17 | Brief-side detection only; a relay supports an order and never creates one | §6.5 |
| OQ-18 | Amended by M3/M4 | §6.3 table |
| OQ-19 | Arm (c) is off without enrolment or `doctor_uid` | §5.6 |
| OQ-20 | `parts` is off | §5.8 |

## Consequences the lead should see

- **C1 - Rule A can now only decide "doctor".** Clef's null vote (M3) means 3/3 never labels a patient, attender or staff speaker. Non-doctor roles are display-only from the role layer. No order path depends on them, so safety is unaffected.
- **C2 - Brief mode posts no medicines at all.** This follows from M2 plus §8.5, and is stricter than the v1 gate. The useful signal moves to prompt recall and to the share of prompts with a doctor-attributed decision quote (§11.2).
- **C3 - Drug-naming counselling is withheld from posted text.** Under M2, R2 withholds any posted line that names a moved drug. Every medicine is moved in brief mode, so how-to-take and counselling lines that name a drug drop out of the posted Advice and Plan. Instruction recall is therefore reported twice: on the posted note, and on the note plus the prompt details (§11.2). This may hold back the counselling gain that A2 is meant to show.
- **C4 - R1/R2 is a hard dependency.** `r1_floors.py` is on `cloudpane/cloud-frx-r2-build/r2` at `fd65cdc6`, not on `origin/main`. Phase 1a cannot merge until it lands, and live mode refuses to start without it (§8.5).
- **C5 - The cost of M1 and M5 is unknown until 0a reports it (S1).** On 16 Oct, 15 of 60 consults had no attributable doctor speech. Mapping failures and missing layers add to that share.

## Unverified items added in v2

- **U12:** whether Saaras word-level times reach the bundle. Without them, the S4 check falls back to segment overlap.
- **U13:** R1/R2 lands on main as cited.
- **U14:** no consumer parses `generator.version` as strict semver.

The other UNVERIFIED items are carried over from v1, §15.
