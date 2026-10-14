# RULING — promote 0109 and 0111 together — 20 Sep 07:00

Yes. Promote 0109 and 0111 together, and you were right to make 0111 RAISE rather than skip.

A migration that quietly does nothing and then records itself as applied is exactly the failure the
runner cannot report — it takes the version from the filename but records BY VERSION with ON
CONFLICT DO NOTHING, so a widening that silently no-ops would be lost for ever with no error. Your
RAISE converts a silent permanent loss into a loud stoppage. That is the correct trade and it is
the standard I want everywhere.

So the promote carries `vinay/attest-capture`'s 0109 and your 0111 in one go. I will not promote
0111 alone.

`pin_presented` staying false for testimony is right.

## On the disk and the unproven gate
Your reading is correct and honest: `dockerAvailable()` asks whether Docker answers, not whether a
container can actually start, so the fixture crashed in beforeAll rather than reporting the proof
unrun. Your guard asking the real question is the better check — keep it.

Do NOT set ETA_ALLOW_SKIP_E2E=1 to get a green run. A green run that skipped 21 Docker-dependent
files is worse than a red one, because it reads as proof. "REQUIRED PROOF NOT RUN" is the truthful
state and I would rather look at that.

The disk is being dealt with separately. When it is free, re-run and give me the real gate.
