# ETA — note-safety shadow (Jev U4 + U8). REFUTER VERDICT. 23 Sep 2026

`vinay/note-safety-shadow` **@ `ca83445`** (builder fleet), one commit on `cf49a55`. Order: `orders/NOTE-SAFETY-SHADOW.md`. Own detached worktree `/tmp/refute-ns`, HEAD asserted, clean after every run. No flag enabled, no migration applied, no database touched, **no real note or transcript text used or printed anywhere in this review** — the one demonstration below uses invented text marked SYNTHETIC.

**6 mutations applied, 6 killed, 0 void**, plus one demonstration and one test-blindness proof. Baselines verified green pristine (14/14, 11/11).

## PASS-WITH-FIXES — Fable's three focus items are all met; a PHI path is open two modules away

### Fable's focus, item by item

| focus | state |
|---|---|
| flag off ⇒ **zero Jev calls** | ✅ **N2** (flag inverted) kills 9 tests |
| flag off ⇒ **zero DB reads** | ✅ `parseFlag` is checked at `:45`, **before** the `sql` read at `:47`; **N1** (gate removed) kills 2 |
| **note output unchanged** | ✅ the production diff is **4 lines**: one import and three `runNoteSafetyShadow(id);` calls, none of which touches `noteRes`, `note_json` or the response |
| **no text persisted** | ⚠️ no text *column* — but see FINDING 2 |

**N3 deserves naming.** Replacing `parseFlag(FLAG)` with `process.env[FLAG]` kills a test. That is the exact gap I filed against jev-core as J2b — only the truthy half of a flag convention pinned, failure direction *enabling by accident*. It did not recur here. Fifth sighting of that class today and the first time it was already closed before I looked.

The fire-and-forget wrapper is correct: `runNoteSafetyShadow` is `void`-returning and attaches `.catch()`, so an unhandled rejection cannot take down the request after the note has been persisted. Placement is right too — all three call sites are after a successful `note_json` write, and the one at `:1371` sits after the catch block that `return`s, so it cannot run on the failure path.

### FINDING 1 — note and transcript text can reach the logs, and the test that claims to prevent it does not

The order says plainly: **"Do NOT: … print note/transcript text."** The path is open.

```
lib/jev/types.ts:55      super(`jev http ${status}: ${body.slice(0, 200)}`);   ← the provider's body, in the message
lib/jev/note-safety-shadow.ts:92-98
                         console.warn("[jev] note-safety shadow failed",
                           JSON.stringify({ encounter_id, error: String(e?.message ?? e).slice(0, 200) }));
```

`JevHttpError` is constructed with the raw response body (`client.ts:113`, `:124`). This branch is the **first caller to put note sentences and transcript excerpts into a Jev state**, so a provider 400 whose body echoes the offending input — the ordinary shape of a validation error — puts that text into `e.message`, and the catch logs it.

**Demonstrated, with invented text.** Reproducing the exact composition (`JevHttpError` → the catch's `JSON.stringify`) with a synthetic sentence produces:

```
{"encounter_id":"enc_x","error":"jev http 400: {\"error\":\"invalid state\",
 \"offending_sentence\":\"Patient reports SYNTHETIC-chest-pain since SYNTHETIC-Tuesday, …\"}"}
```

**The guard is a title, not an assertion.** `jev-note-safety-shadow.test.ts:134` is named *"logs a warning (metadata only — encounter id and error string, **never note/transcript text**) when the async half fails"*. Its body asserts only that the payload **contains** the encounter id (`:144`) and the error string (`:145`). It never asserts that anything is **absent**, and it injects a benign `new Error("db unreachable")`. Changing that injected error to one carrying synthetic note text leaves the suite at **11/11 green**. The property is claimed in the name and untested in the body.

**Fix, and it belongs in `types.ts` rather than here** — one place, the way the pyannote.ai scrub was applied once where `detail` is built rather than at each log site: keep `body` as a field for debugging but stop composing it into `message`, or scrub it. Then a test that asserts the *absence* of a known sentinel in the captured log, which is the only form that can fail.

**Severity and timing.** The flag is off by default and `ETA_JEV_ENABLED` is unset, so nothing leaks today. But the entire purpose of this branch is the shadow week, i.e. turning the flag on over real clinical notes. This should be closed **before flag-on**, which may or may not mean before merge — Fable's call, not mine.

### FINDING 2 — "closed vocabulary" is asserted, not enforced (mechanism verified; not demonstrated end to end)

`scribe_jev_decisions`' own description states: *"`answer` is a structured, closed-vocabulary value (noul/choice/score) — never transcript or state text."* Nothing enforces it.

- `JevAnswer` permits `{ type: "choice"; choice: string }` and `{ type: "score"; … legend: Record<string,string> }` — free strings at the type level.
- **No validation of a returned `choice` against the question's own options exists in `client.ts` or `ask.ts`**, i.e. anywhere before the row is written. Callers validate afterwards (`choiceOf` in `shadow-v2.ts`), by which point `decision-store` has already persisted `answer`.
- `answer` is `jsonb`, so the order's "no text column written" is satisfied on its face while jsonb carries text perfectly well.

So a model returning an off-vocabulary `choice` — an echoed fragment, a refusal sentence — persists it to `jev_decision`. I have **verified the absence of validation; I have not demonstrated a model actually echoing**, and I am not counting it as demonstrated. The point stands regardless of likelihood: for a PHI store in shadow mode over clinical notes, "the model will stay in vocabulary" is precisely the assumption that should not be load-bearing. One `includes()` against the registry's options before recording closes it and makes the tool's description true.

### One root cause, and a disclosure about my own earlier review

Both findings are the same thing: **`lib/jev/` was designed when nothing sensitive flowed through it, and this branch is the first caller to send note and transcript text.** The error path and the answer path were each reasonable for metadata; neither was re-examined when the payload changed.

**I reviewed jev-core (`b1618b0`) and passed it without flagging either.** That was defensible at the time — no caller sent PHI, so an error message carrying a provider body was an operational detail. It is still a lesson I should carry: **a PASS on a component does not survive a new caller changing what flows through it**, and the reviewer who cleared the component is the one who should notice. fleet built this branch correctly against the contract they were given; the hazard is in the layer I cleared.

## Verdict: PASS-WITH-FIXES
Everything Fable asked me to focus on holds, and the flag discipline is the best I have seen today — the falsy half pinned without being asked. The two findings are inherited rather than introduced, they are one fix each, and neither is live while the flag is off. FINDING 1 should close before the shadow week begins, because that is the week when real notes start flowing through the path that logs them.

---

# ADDENDUM — how far FINDING 1 reaches, 23 Sep

FINDING 1 names a leak in `lib/jev/`, which every Jev caller inherits — and **E-6 fusion is already merged and deployed (`d519d7b`) and sends `{window_text}`, i.e. transcript text, through the same client.** So the obvious question is whether a deployed branch is exposed. I checked rather than assume, and the answer is **no**. Recording the negative result, because the scope of a finding matters as much as the finding.

**The persisted trace path is clean.** `finaliseError(reason)` writes `trace.finalise({ status: "errored", error_message: reason })` — persisted, not merely logged — and the belt-and-braces call at `client.ts:163` passes a raw `e.message`, which for a `JevHttpError` carries the provider body. It is **not reachable** with one: `finaliseError` short-circuits on a `finalised` flag, and the HTTP error path sets it first with a clean code —

```
lib/jev/client.ts:123-126
  const body = await res.text().catch(() => "");
  const err  = new JevHttpError(res.status, body);
  await finaliseError(`jev_http_${res.status}`);   ← clean CODE, and finalised = true
  throw err;                                        ← :163's finaliseError(e.message) is now a no-op
```

Every other finalisation (`:118`, `:125`, `:149`, `:158`) also uses a code, and `JevStateTooLargeError` carries a character count rather than the state. So what reaches the trace store is `jev_http_400`, never the body.

**E-6 does not log the message either.** `shadow-v2.ts:178` catches, rethrows only `JevDisabledError`, and otherwise increments `jevFailed++` — a counter, no message, no text. The deployed branch is clean and needs no action.

**So FINDING 1 is caller-side and currently singular**: it exists because `note-safety-shadow.ts:92-98` logs `e.message`, and that file is unmerged. The `lib/jev/` fix Fable assigned to fleet is still the right one — it removes the hazard for every future caller rather than for this one — but nothing deployed is exposed today, and nothing needs to be rolled back or hurried.
