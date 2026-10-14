# eta-bus refuter rounds (refute-bus)

**Question:** does the eta-bus MCP (herdr-kit's messaging layer) hold up under refuter review — secrets scrubbing (false pos/neg), footers, ANSI handling, models, wake semantics?

**Owner:** ETA-Refuter / Builder (Mini)
**Date:** 2026-09-23
**Status:** closed per ruling — see `VERDICT.md` and `VERDICT-2.md` for the full round-by-round record. `r01`–`r06`, `r2/`, `copy/`, `ctlcopy/`, `live/` are the recon/setup/test scripts and working copies from the rounds.

Note: `copy/test/*.mjs` and `r2/p1.mjs` are the secret-detector's own test fixtures. They contain synthetic, clearly-fake token/password strings used to verify the scrubber catches them — the realistic-looking ones (`ghp_…`, `AIza…`, `xoxb-…`, a fake Neon connection string) were replaced with obviously-fake `EXAMPLE`/`NOT_REAL` placeholders before this repo's first commit, since the originals matched GitHub's push-protection token formats even though they were never real credentials.
