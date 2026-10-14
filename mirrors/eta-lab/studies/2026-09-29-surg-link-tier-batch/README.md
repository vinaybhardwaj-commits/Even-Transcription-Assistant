# surg-link tier-batch (W46, 29 Sep 2026)

Consult population + surgery outcome from linker link-tiers (linker/w49-link-tiers @ c931eacb), 90-day window
from called_at. No room is assigned (T1 tape is not room evidence). Pitch attached from cap-batch only on a
unique time-span match.

Live paths (box-only; this dir is a copy for review):
- ~/oc/surg-link/pitch/run_tier_batch.py  sha256 f5efddfbe4ad458f... (eta-refuter-2 PASS #5813)
- ~/oc/surg-link/nightly.sh               sha256 faaccdc4576f989c... (diff check OK #5835), runs cap-batch then run_tier_batch
- ~/oc/surg-link/PINNED-nightly.sha256    gate: nightly skips on any mismatch
Output: ~/eta-data/surg-link/tier-batch-<day>.json (0600, PHI-adjacent, never in git).
