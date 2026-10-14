**Closure**
Proofs **11 and 12 are formally closed** at `72960baa`.

Accepted evidence:

- Proof 11 validates all six attempt outcomes across all three manifest locations.
- Real OpenAI SDK timeouts classify as `timeout`.
- All four executable success-attempt sites are AST-proven.
- Proof 12 executes all six batch outcomes and proves the applied precedence.
- Command 6 now proves both generator determinism and committed-map currency.
- The complete gate passed at clean commit G.
- No production, test, generated-map, migration, or registry content changed during G/E.

Stage 0a is now:

```text
Hard proofs closed     2 / 20
Judge proofs closed    0 / 4
```

**Disclosures 6.1 And 6.2**
Accepted. No repair commit or rerun is required.

- The missing shell quotes are a transcript-rendering defect. The registry output proves the generator ran.
- Exit zero from the `A && B` chain proves both commands returned zero.
- Final clean status and unchanged registry blob independently confirm currency.

For pass 2, preserve the exact quoted command in evidence:

```bash
bash -c 'npm run reasoning:registry && git diff --exit-code data/reasoning-registry/prompts.generated.json'
```

Then capture this allowed auxiliary check separately:

```bash
git diff --exit-code data/reasoning-registry/prompts.generated.json
```

This does not add a numbered gate entry.

**Build Guard Ruling**
The existing armed refusal/keyed-success pair is sufficient. Choose option 1.

Do not add a third build now or in pass 2.

The explicit commands hold `VERCEL=1` and `VERCEL_ENV=production` constant and vary only the key. That proves the key clause carries the refusal. The disarmed condition is already covered by the test suite and source parity guard.

**Additional Debt**
Record, but do not fix in pass 2:

- `scripts/reasoning-registry-gen.mjs` also labels JavaScript string length as bytes.
- The architecture generator has the same label defect.
- The 11.5b "two structural properties" comment is inaccurate.

The exact four-file pass 2 contract takes precedence. The 11.5b comment moves to a separately authorized comment-only cleanup after the five proof passes.

**Pass 2 Release**
Pass 2 is released.

Scope:

```text
Proofs 2, 16, 17, 18, 70
Judge proofs J1, J2, J3, J4
```

Exactly two commits:

1. One test implementation commit.
2. One evidence-and-report commit.

Exactly four implementation files:

- `lib/__tests__/judge-server-stub.ts`
- `lib/__tests__/explicit-judge-equivalence.test.ts`
- `lib/__tests__/rerank-pass-2.test.ts`
- `lib/__tests__/explicit-judge-retrieve.test.ts`

No production source may change.

The kickoff must:

- Reproduce the recorder's 1 MiB/413 contract.
- Preserve the precise J1 method/path/body claim.
- Start loopback services before dynamic imports.
- Forbid external sockets.
- Protect every production file against diff.
- Use scratchpad-only mutation testing.
- Run the complete nine-command gate and two build modes.
- Report the observed test count rather than requiring `3178`, because pass 2 adds tests.
- Capture gate output outside the repository at the implementation commit.
- Commit evidence and report separately.
- Require review before pass 3.

Current branch is clean and synchronized at `72960baa`.
