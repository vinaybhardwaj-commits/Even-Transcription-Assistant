# Pre-op Risk Agent — mockup v1.1 deltas

The V-approved `PREOP-RISK-AGENT-MOCKUP-v1-26-AUG-2026.html` remains the binding UI spec.
These five deltas were ratified in the B3+B4 kickoff (26 Aug 2026) on the evidence of the
B0–B2 build report, and B4 implements the mockup **plus** exactly these. Anything else is
still a deviation and still needs V.

Each delta is implemented in `lib/preop-surface-core.ts`, where it is unit tested, and
rendered by `components/care/PreopBoard.tsx` / `PreopCasePage.tsx`, which contain no
judgement of their own.

---

### 1 · A fifth provenance chip — `OPD · ICD-10`

The mockup's legend drew four chips: BOOKING, LAB · Eka, PAC and the pink EXTRACTED.
Amendment A1-2 adds **OPD**, for the structured ICD-10 codes on `individuals-prescriptions`.

It is styled like LAB — a coloured but not-pink chip — and it is **visually distinct from
EXTRACTED**, because pink is reserved for the model boundary and an ICD code has no model
anywhere near it. Its text label is always rendered; colour never carries the meaning
alone. It is **never hidden when the extraction flag is off**, for the same reason.

Implemented as `PROVENANCE_CHIPS` / `provenanceChip()`.

### 2 · Four PAC chip states, not two

Amendment A1-3: the booking workflow's `pac__status` and a bridged KareXpert report are
two different facts, and the mockup drew only the second. Measured 26 Aug: 8 of the 19
upcoming episodes read COMPLETED while 1 has a report, and that gap is mostly ≤1-day
scrape lag.

| State | Chip | Tone | When |
|---|---|---|---|
| `final` | `PAC ✓ final · <date>` | green | a bridged report exists and is final |
| `expected` | `PAC marked complete — report expected` | muted | `pac__status` COMPLETED, logged < 48 h, no report |
| `missing` | `PAC marked complete <N>d ago — no report on file` | **amber** | COMPLETED, logged > 48 h, no report |
| `none` | `PAC — none` | muted | anything else |

Only the first ever renders as a tick. The third is a data-quality signal, not a risk one.
Implemented as `pacChip()`; the 48-hour boundary is `PAC_REPORT_LAG_HOURS`.

### 3 · The identity fallback chain

Amendment A1-4. `individuals.display_name` is empty across this entire cohort, so the
board falls back to `first_name + last_name` (B2), then to the UHID with age/sex, and
finally to the episode key. **A card is never anonymous.** Implemented as `identityLine()`.

### 4 · One why-line shape

The mockup prints four why-lines in three hand-written shapes. No single deterministic
generator emits all three, so the module emits one — the most informative of them — for
every case: the present factors of the dominant instrument, each with its evidence in
parentheses, then the instrument and its count. Ratified in A1-5. Implemented as
`whyLine()` in `lib/preop-tier-core.ts`.

### 5 · The degraded-sources strip

New. When the last sweep's `degradedSources` is non-empty, a slim amber strip sits above
the tiles reading *"sources degraded at last sweep — coverage shown is a floor"*, naming
the sources that fell over.

This exists because of a defect the first production sweep found: the db13 fetchers caught
their own faults and returned empty lists, so a source that had timed out reported exactly
the same coverage number as a source that was genuinely empty. The board must never let a
reader mistake an outage for an absence. Implemented as `degradedStrip()`.

---

## Not deltas — mockup elements B4 implements as drawn

Needs-review band pinned above the tier bands · tier pills with a label and a glyph, never
colour alone · dense collapsed GREEN rows · dashed range chips **only** where the
unconfirmed upper bound crosses a severity boundary · the red situation line reserved for
operational danger · the PAC verdict banner quoting the anaesthetist verbatim · the
snapshot timeline with a capture reason per step and the live row marked current · the
correlated-lenses note as fixed layout rather than a tooltip · the narrative panel rendered
visibly OFF rather than hidden · the honesty footer · the empty-board copy with a
last-sweep stamp and zeroed tiles.

One addition inside the banner: when the anaesthetist's conclusion box holds **orders
rather than a fitness statement** — the common case on production — the banner still quotes
it verbatim and adds a caveat saying so, instead of presenting orders as a verdict.
