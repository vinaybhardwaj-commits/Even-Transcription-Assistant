**Pass 2 Closed**
Pass 2 is administratively closed at:

```text
01c2375b4b40dc19bc2684ae2ecfa2b9664f5638
```

```text
Hard proofs closed    7 / 20
Judge proofs closed   4 / 4
```

No further repair, mutation run, gate, or evidence commit is required.

**Rulings**
- V's explicit approval of v22 digest `25af48ec…` is confirmed.
- The shared cleanup is correctly used by actual 5.2b and 5.2b-fail.
- Row 35 plus auxiliary A1/A2 provide sufficient combined discrimination. They need not be promoted to numbered rows.
- The `held.closed` fast path is accepted without another mutation.
- The cleanup-timeout branch preserving the original message rather than error-object identity is accepted as fail-loud behavior.
- The four-line truthful header expansion is retrospectively ratified.
- The date mismatch is accepted as disclosed.
- The governance-only ungated-tip exception applies to commit 12.
- The sixteen unbounded settlement waits remain non-blocking test-harness debt. Complete bounded-settlement hardening before the next mutation campaign that can deliberately leak recorder accounting.

**Push**
V is authorized to perform a normal, non-force fast-forward push of `exp/rerank-telemetry` through exactly `01c2375`.

Afterward verify:

```bash
git rev-parse origin/exp/rerank-telemetry
```

It must equal `01c2375b4b40dc19bc2684ae2ecfa2b9664f5638`.

Do not amend, squash, rebase, or force-push.

**Pass 3**
Pass 3 is released for its own prospective signed authorization and kickoff. No implementation begins until that authorization is in force.

Nothing here authorizes deployment, migration, Cohere activation, or the pass-1 retrospective sweep.
