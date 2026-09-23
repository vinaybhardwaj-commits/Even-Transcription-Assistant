# ETA — Jev U6 clinical-or-not routing. REFUTER VERDICT. 23 Sep 2026

`vinay/jev-u6-route` **@ `0d5e529`** (builder fleet), one commit on production `d519d7b`. Order `JEV-U6-ROUTE`, PLAN-v3 §A. Worktree `/tmp/refute-u6`, HEAD asserted, clean after every run. **Gate run by me**, not quoted from the builder.

## PASS-WITH-FIXES — one unpinned check, already fixed better on another branch

### The gate, mine

`~/dev/_fable/yoga-test.sh /tmp/refute-u6 --build` on the **E2E box** (now the default CI host), unpiped per §G, run `20260923T131030Z-0d5e529-58901`:

```
RESULT ok      rc=0      Test Files 193 passed (193)      Tests 4302 passed | 1 skipped (4303)
typecheck · typecheck:tests · vitest · build   —   swift SKIPPED (Linux runner; apps/room-recorder untouched)
peak host memory 9873 MiB      13:10:33Z → 13:44:54Z
```

**One gap in my own gate, stated rather than implied:** the E2E runner's steps are typecheck, typecheck:tests, vitest and build. It does **not** run `npm run check:silent`, which the repo's own gate requires (9 findings pre-existing and accepted). fleet reported it green on their run; I did not reproduce that line and do not claim it.

### Mutations — 4 applied, 3 killed, 1 survived

| | result |
|---|---|
| **U1** the flag gate removed, so the DB read happens with the flag off | **killed, 3** |
| **U2** flag inverted (runs when OFF) | **killed, 8** |
| **U3** `parseFlag` replaced by a truthy `process.env[FLAG]` | **killed, 2** |
| **U4** the `U6_OPTIONS.includes(...)` vocabulary check removed | **survives** |

`parseFlag` is checked at `:47`, **before** the `sql` read at `:51` — flag off is genuinely zero Jev calls and zero DB reads. U3 dying is the sixth sighting today of the only-the-truthy-half class, and the second consecutive branch on which it was already closed before I looked.

### The J-A question, which is what I came for

§A asks for garbled text to be **marked, never judged "invented"**, and §1.1 forbids asking Jev whether text came from silence. The vocabulary is built against that trap rather than around it:

- The option is `garbled_or_no_real_speech`, described as text *"dominated by filler sounds, fragments, or repeated meaningless syllables with no coherent information content, **suggesting** noise rather than a real conversation."* That is a claim about the text's coherence, hedged, and it stops short of asserting invention.
- `cannot_tell` sits beside it as an honest fallback, and the heuristic *"does not guess 'clinical' by default."*
- **Nothing consumes the label.** No non-bench reader acts on `garbled_or_no_real_speech`; the tool says so itself — *"Nothing excluded from notes yet — read + classify + log only."*

**Counts-only holds by construction, not by discipline.** `ClinicalRouteOutcome` is `{ ran, windowsTotal, windowsAsked, byCategory }` — a boolean, two numbers and a `Record<U6Option, number>` — and the handler returns `{ ok: true, ...outcome }`. No text can appear in the result because the type admits none.

### The bench is honest, and its caveat travels with its number

The 50-window bench is synthetic, and fleet says so in the file header without being asked: no live DB or `ETA_JEV_ENABLED`, so fixtures run through the **real** `askJev()` path with `ETA_JEV_MOCK` seeded per item, and *"the 'Jev answer' for each fixture is therefore SCRIPTED to the label the fixture was written to represent."* So the run scores **the heuristic against authored intent**, and says nothing about Jev.

That disclosure would be worth little if it stayed in the source. It does not: the report is emitted with `use: "U6 clinical-or-not routing (SCRIPTED bench, see file header)"` and the counts labelled `heuristic / proxy "expected"`, so **the caveat cannot be separated from the number it qualifies**. That is the same discipline as `centroids_offered` and `speech_probes` elsewhere today — the claim carries what is needed to check it.

One narrower point, no action: the garbled fixtures are documented as *"matching looksGarbled's own logic"*, so for that class the agreement is partly circular — the heuristic is scored against items authored to match it. It is disclosed, and the number is already labelled a proxy, so it misleads nobody who reads the header.

### FINDING — the vocabulary check is unpinned, and the better fix is on another branch

**U4 survives**: deleting `(U6_OPTIONS as readonly string[]).includes(kind.answer.choice)` at `:68` leaves 38/38 green. An out-of-vocabulary `choice` would then be counted, adding an arbitrary model-supplied string as a key in `byCategory`.

The check is **present and correct**; it is untested. What makes it worth a line is where it sits: this is the same property fleet fixed **centrally in `ask.ts`** on `vinay/note-safety-shadow` (my FINDING 2, closed at `d232232`) — rejecting an off-vocabulary choice *before the row is built*. That branch is unmerged and this one bases off production `d519d7b`, so the central guard is not here. Two implementations of one rule on two branches; the better one is on the other.

**When both merge**, `ask.ts` validates upstream and this local check becomes redundant defence-in-depth — harmless, but someone should notice rather than discover it. One test pins it meanwhile.

## Verdict: PASS-WITH-FIXES
Gate green on my own run. The flag discipline, the counts-only type and the bench's self-labelling are all better than they needed to be, and the J-A trap is handled by vocabulary design rather than by a downstream guard. The single survivor is one test, and its real interest is cross-branch rather than local.
