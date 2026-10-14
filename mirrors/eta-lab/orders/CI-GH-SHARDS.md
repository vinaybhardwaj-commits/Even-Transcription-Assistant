# Order — sharded CI on GitHub Actions (23 Sep 19:40, Fable → lx, Builder)

## Why
Full gate = ~34 min on the box, one at a time. E2E account caps (96 GB RAM, 1 GPU) block more big machines until V talks to E2E sales. GitHub Actions has no such cap: split the suite across parallel runners.

## Build (branch vinay/ci-gh-shards off d519d7b, ETA repo, new worktree)
- `.github/workflows/gate.yml`: on `workflow_dispatch` (input: ref) and on push to `ci/**` branches only (never on every push). Jobs: `typecheck` (typecheck + typecheck:tests + check:silent) ∥ `test` matrix `shard: [1..8]` running `vitest run --shard=${{ matrix.shard }}/8` ∥ `build`. Same Node major as the box, npm cache on. Concurrency group per ref.
- No secrets required by tests — if any test needs one, list it and skip it in CI with a clear marker rather than adding secrets. No patient data in the repo or logs.
- `kit/gh-gate.sh <sha>` (eta-lab): pushes the SHA to `ci/<sha>` and waits on `gh run watch`, prints PASS/FAIL + wall time; exits non-zero on fail. Must be usable by builders and by ETA-Refuter.

## Verify
Run it on d519d7b: all shards green, report wall time vs ~34 min. Then run it on one deliberately broken commit (one failing assertion) on a throwaway ci/ branch → FAIL is reported. Delete the throwaway branch.

## Not allowed
No change to production branches, Vercel, env, or existing tests beyond what's needed to shard. Do not remove the box/Yoga runner — this is an additional path.

## Output (≤10 lines)
Workflow SHA, wall time, shard timings (slowest shard), cost note (runner minutes per gate), anything UNVERIFIED (e.g. token scopes for pushing workflows).
