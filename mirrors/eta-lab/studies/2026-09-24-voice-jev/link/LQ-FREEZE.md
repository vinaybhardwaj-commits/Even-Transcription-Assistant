# LQ: the linkage question for Jev (ruling 183, Phase L). DRAFT for Fable's freeze.

Nothing in this file is run against Jev until Fable replies with the hash below. The hash is computed exactly like the
freeze and addenda (ruling 165 A), over the text between the markers:

    awk '/<!-- LQ-BEGIN -->/{f=1;next}/<!-- LQ-END -->/{f=0}f' studies/2026-09-24-voice-jev/link/LQ-FREEZE.md | shasum -a 256

<!-- LQ-BEGIN -->
LQ STATE TEMPLATE (plain text, fields in this order; one state per proposed link x consult batch; no doctor or patient name anywhere):

Room consultation recorded on <date>. One voice ("voice A") was picked out of this room's audio; below are ONLY voice A's transcript turns from <n_consults> consults, in time order, guarded text (English alongside Kannada/Hindi where available). Turns from every other voice are left out.
Voice A turns:
[consult 1, <mm:ss>] "<text>"
[consult 1, <mm:ss>] "<text>"
[consult 2, <mm:ss>] "<text>"
...
Items that a doctor prescribed or ordered for the patients in these consults (drug, dose, frequency, duration, tests):
- consult 1: <item>; <item>; ...
- consult 2: <item>; <item>; ...
...

LQ (yes/no): Do voice A's turns contain the doctor's instructions or the prescribed items listed above? Count a turn as doctor's instructions only if it tells a patient what to take, do, test or come back for, or if it names, doses or explains a listed item. A patient describing symptoms, or repeating a drug name they already take, is not the doctor's instructions.

LQ RULES:
1. Yes/no via Jev type "noul" with the calibrated confidence field, same call shape as Q2/Q3 of the frozen card (arms/common.py jev_call).
2. The state carries voice A's turns and the item list only: no room, no doctor name, no cluster scores, no Q1 answer, no PQM or Rx match counts.
3. Q1 of the frozen card (b961291ae64c) is asked separately on voice A's turns with the frozen wording, the doctor being the proposed doctor; it is not merged with LQ.
4. Turn limit per state: at most 12 turns per consult and 8 consults, each turn clipped to 300 characters, taken in time order from consults in the same room-day.
5. Item list: only items from prescriptions whose consult_uid joins to the matched consults; drug and test names as written, no patient identifiers.
6. CONTROL (runs with every real batch): the identical turn text paired with the item list of a DIFFERENT room-day's consults (same date, other doctor; seed 24092026). LQ must say "no" on these. The LQ result counts toward the Jev-doctor term of the tier only if the control for that same link is "no" (noul < 0.5); a link whose control also says "yes" gets LQ = void, reported.
7. Tier use: Jev term = Q1 doctor confidence >= 0.70 (Q1 on the voice A turns) AND LQ yes (noul >= 0.5) AND the same link's control said "no" (rule 6). LQ alone never lifts a link into a tier.
<!-- LQ-END -->
