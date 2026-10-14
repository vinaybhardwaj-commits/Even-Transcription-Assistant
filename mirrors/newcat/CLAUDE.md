# CLAUDE.md

Read `AGENTS.md` before touching `src/platform/**` or `src/agents/**`. The contract is `PLATFORM-SPEC.md` section 2.

## Git rules

- Work on a branch `platform/<slice>` (or the branch your kickoff names) and open a PR. Never commit to `main`, never push `main`: `main` auto-deploys to Vercel.
- Stage by exact filename. No `git add -A`. One commit, or a few, per slice.
- Gate before every commit: `npm ci && npm run typecheck && npm run lint && npm test`. No commit on a red gate.

## Rules that bite

- Edit only the files your kickoff names. Shared code (`src/decide/**`, `src/llm/**`, `src/config.ts`, `src/runtime.ts`, `package.json`, existing migrations) belongs to newcat-lead.
- `audit.note` behaviour does not change; its tests stay green and unedited.
- Synthetic fixtures only. No secrets, patient identifiers or transcript text in code, fixtures, logs, reports or bus posts.
- Every external-API or schema assumption is written down as INFERRED in the report.
