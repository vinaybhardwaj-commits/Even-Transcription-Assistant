# CDMSS rerank telemetry: addendum v8, a narrow erratum

**14 August 2026.** Two corrections. Nothing else.

**SIGNED by V on 14 August 2026, sections 1 and 2 in full, without amendment. See section 3.**

## 0. Authority and scope

Continues addendum v7. Governs all work after `7435845788304ffbe82771429f8f4f7b306869ad` on
`exp/rerank-telemetry`.

**This addendum is deliberately narrow.** It corrects one factually wrong premise in v7 and records
one ruling that v7 did not cover. It reopens nothing else. Every settled decision in v1 through v7
stands.

**v7 is not edited.** Its bytes are preserved exactly as signed. Its SHA-256 is
`0e05f4b006fb90e9d9c31cd476577f8df06eb333265db60e1e70a760bdbf8682`. Any correction to v7's text
lives here instead, which is the rule v7 was signed under.

## 1. Correction. Addendum v7 section 11's force-add premise is wrong.

Section 11 of v7 states that this class of document "must be force-added or it is not part of the
record". That premise is false, and this thread supplied it.

The facts, verified against the branch:

```text
.gitignore:73      /*.md
.gitignore:74+     ! exception lines naming individual files
```

Addenda v1 through v6 are tracked because each has an `!` exception line. Nothing was force-added.
`git add -f` was forbidden by earlier passes and was not used.

**Ruling.** Addendum v7 becomes part of the record by adding one line to `.gitignore`:

```text
!/CDMSS-RERANK-TELEMETRY-ADDENDUM-v7-14-AUG-2026.md
```

The same applies to this document.

The commit that tracks v7 carries `Document-SHA256: 0e05f4b006fb90e9d9c31cd476577f8df06eb333265db60e1e70a760bdbf8682`
in its message. The document hash and the resulting commit SHA are both recorded in the build
report. Any later textual change to v7 becomes a further addendum. v7 is never silently edited.

Addenda v1 through v6 receive retrospective integrity digests in the build report: their current
SHA-256 values and their original commit identifiers, labelled as retrospective rather than
signature-time hashes. History is not rewritten.

## 2. Ruling. The judge arm's unproven `provenNotServed` claim.

Addendum v7 section 6 ruled that a generic Cohere failure without transport proof records
`unattributed` and never an inferred `not_served`. It ruled on Cohere only.

Pass 0 found the same defect shape on the judge arm and correctly declined to correct it by
extension. `lib/rerank.ts` around lines 408 to 421 synthesises `provenNotServed: true` for a generic
judge failure, where non-delivery is not proven.

**Ruling. The same rule governs both arms. A generic judge failure without transport proof records
`provenNotServed: false`, and its class is `unattributed`.**

Where transport proof exists, `not_served` stands and is unchanged, on either arm.

**This is corrected before the twenty hard proofs, not deferred to a later rollout.** The branch is
reached only when an injected `judgeFn` throws, because `rerankJudge` catches its own failures per
batch, so it is effectively test-only today. That is exactly why it must be fixed first: a test-only
path that fabricates a proof will poison the proofs written against it.

## 3. Acceptance

```text
Accepted by:                          V
Date:                                 14 August 2026
Sections accepted:                    1 and 2, in full
Sections amended, with the amendment:  none
```

Accepted in full and without amendment. Sections 1 and 2 are in force and govern all work after
`7435845`. Section 4 stands: this addendum reopens nothing else.

## 4. What this addendum does not do

It does not reopen the rollout, decision D4, the guardrails, the test reduction, the window-closure
wording, or any section of v7 other than the section 11 premise. It authorizes no deploy, no
migration, no canary, and no change to `RERANK_BACKEND`.
