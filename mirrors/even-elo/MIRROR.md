# Mirror: even-elo

- Source repo: even-elo (working repo; this folder is a read-only copy)
- Source branch: main
- Source sha: cebc7ee967e6d7ed16df6672ad160e37f96abd26
- Mirrored at: 2026-10-13 23:56Z
- Files mirrored: 415 (before this MIRROR.md)
- Bytes mirrored: 3025482
- Excluded by policy (not listed per file): 3 files
  - policy-env-file: 1
  - policy-file-type: 1
  - policy-nested-gitignore: 1

Scrub-withheld files: 4 (see WITHHELD.md).

## Withheld by identity guard (14 Oct 2026)
Test files that hard-code a person (name, Dr title, doctor slug or email). Path and rule only.

- src/lib/__tests__/audit-findings-routes.test.ts (email, identity-field)
- src/lib/__tests__/audit-findings.test.ts (dr-title, email, identity-field)
- src/lib/__tests__/audit-ruling.test.ts (email, identity-field)
- src/lib/__tests__/cdmss-doctor-mapping.test.ts (dr-title, identity-field)
- src/lib/__tests__/doctor-card.test.ts (dr-title, identity-field)
- src/lib/__tests__/document-audits.test.ts (dr-title)
- src/lib/__tests__/feedback-home.test.ts (dr-title)
- src/lib/__tests__/findings-pdf.test.ts (dr-title, identity-field)
- src/lib/__tests__/helpers/fixtures.ts (email)
- src/lib/__tests__/mapping-review.test.ts (dr-title, email, identity-field)
- src/lib/__tests__/portal-flags.test.ts (dr-title, identity-field)
- src/lib/__tests__/response-sync.test.ts (dr-title, identity-field)
- src/lib/__tests__/ruling-retry.test.ts (email)
- src/lib/capture/__tests__/ocr.test.ts (identity-field)
