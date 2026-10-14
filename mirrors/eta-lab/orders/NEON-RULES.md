# Neon access — standing rules (22 Sep 2026)

- API key: ~/.claude/secrets/neon_api_key (0600). Read it from the file only (e.g. `Authorization: Bearer $(cat …)` inside a script); never print it, never put it in argv of a logged command, never commit it.
- Skills installed: `neon`, `neon-postgres` (user scope). Use them.
- ETA project: eta-app-db = floral-butterfly-54959636 (org-solitary-scene-13666321, aws-ap-southeast-1). Production branch: br-still-fog-aondvfod `main`.
- **Never** write to, reset, or restore the `main` branch. Production migrations remain Fable's call.
- Test branches: create from `main`, name `test/<pane>-<purpose>` (e.g. `test/fleet-retention`), use the branch's own connection string for migrations/tests, and **delete the branch when done** (report its id at creation and deletion). Max 2 live test branches per pane.
- Other projects in the org (mednotegen-db, even-appraise-db, etc.) are out of scope.
