# Mirror: newcat

- Source repo: newcat (working repo; this folder is a read-only copy)
- Source branch: main
- Source sha: f6f5e7a6066ec08ed4a40b5c063f7b1acd7abde6
- Mirrored at: 2026-10-13 23:56Z
- Files mirrored: 267 (before this MIRROR.md)
- Bytes mirrored: 1532787
- Excluded by policy (not listed per file): 2 files
  - policy-env-example-ignored-by-eta-root: 1
  - policy-nested-gitignore: 1

Scrub-withheld files: 14 (see WITHHELD.md).

## Withheld by identity guard (14 Oct 2026)
Test files that hard-code a person (name, Dr title, doctor slug or email). Path and rule only.

- test/agents/surgical-consult/governance/governance.test.ts (identity-field)
- test/agents/surgical-consult/offline/input.test.ts (dr-title, identity-field)
- test/platform/agent/f74-fix.test.ts (dr-title)
- test/platform/agent/f74-ids.test.ts (dr-title)
- test/platform/cdmss/__snapshots__/db13.test.ts.snap (doctor-slug)
- test/platform/cdmss/read-models.test.ts (doctor-slug)
- test/platform/http/run-wall.test.ts (identity-field)
- test/platform/ubus/ubus.test.ts (email)
