# FUSER v3 — result (2026-10-01, lid-debug, designer). Pre-reg: FUSER-V3-PREREG.md (cbfece42 + A1/A1.1/A2/A2.1, final 02b51217)
VERDICT: FAIL, as pre-registered (§0 expected it). Safe, but below the recall bars. No re-run, no threshold change.

Run: frozen code router-fix/fuserv3 73adb29f (bundle b37a1e4a); run.jsonl sha256 737e78f01acbfd73 (2,640 windows + header);
gates printout sha16 a5725e6e108f9414, byte-identical from router-fix, eta-refuter-2 (#8765) and eta-refuter-3 (#8768). Aggregates only;
nobody read per-window output. Fresh set: cap, seed commitment 0453361fcac11be7, cases 995c31c6, suite 90e5710d, 2,640 windows
(110 cases x 8 modes x 3 conditions), TTS 98,524 chars (separate ledger; projected 98,040). Tracks 23,760 = 9 x 2,640 at the pinned
hashes (#8752). M4 wrapper check on the fresh P: 0 differences / 18,480.

| Gate | P | v3 | Bar | Result |
|---|---|---|---|---|
| G1 S1 ALL (l.101 def.) | 69.8 | 70.5 (+0.65) | >= P + 2.0, no language < P - 2.0 | FAIL (every language +0.1..+1.5) |
| G2 cap captured | 38.6 | 39.7 (+1.06) | >= P + 3.3 | FAIL (drug captured +1.77) |
| G3m P-hit, v3-miss | - | 0 | 0 | PASS (by construction, held) |
| G4 false added names | - | 1 / 170 = 0.59%, Wilson upper 3.26% | <= 2%, upper < 7%, n >= 50 | PASS (clusters 1/156, upper 3.54%) |

Pre-registered predictions vs outcome: G1 <= ~+1.1 (upper bound) -> +0.65; G2 ~+1.2 -> +1.06; ~180 entries -> 170.
Reported, not gated: A2 repeat-mention share 61/170 (any Whisper track >= 2 mentions in the window). The single false entry: kn-en,
SraVaani witness. 481 windows had >= 1 EMPTY Indic track (not missing; 0 windows without a usable Indic witness). Declared deviations:
room suite-fv3; REB_ROOT reb-fv3 (verified in effect, #8768); rig_git None (pinned extract).

Reading (designer): the two-engine-family rule makes auto-adding drug names SAFE but SMALL (~+1 point). The false-drug rates
v2-D 33.8% (clinical1), v2-E 4.35% (30 Sep fresh, 384 windows), v3 0.59% (this set, 2,640 windows) come from three DIFFERENT sets and
rules, so the drop is a strong indication, not a controlled within-set comparison (refuter-2 #8769; a like-for-like number would need the
single-family rule scored on this set, which is unregistered and not proposed). R1 held exactly: the output text IS P's text byte-for-byte
(asserted by the loader), so no dose could change and none was ever added. INTERPRETATION, not measured by any gate here (refuter-3 #8771): the gain is small because drugs production misses are mostly heard by
Whisper alone; the count it rests on is clinical1's, not this set's: of 83 drugs P missed, 66 were in a Whisper track and only 25 of those
also in an Indic engine (#8159), i.e. 41/66 Whisper-only. R2 by design does not trust a single family. Whether a
safe ~+1-point capture gain is worth shipping is V's question; it would need a NEW pre-registration with a safety-first bar, not a
re-reading of this run.
