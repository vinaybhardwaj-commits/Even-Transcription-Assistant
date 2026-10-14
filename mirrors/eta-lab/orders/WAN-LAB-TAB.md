# What Are Next — "Lab" tab over the eta-lab repo (owner: wan-lab) — V approved 23 Sep 2026

Goal: What Are Next (next.evenos.app) becomes the ONE screen V opens. It reads the private `vinaybhardwaj-commits/eta-lab` repo live from GitHub and shows it; nothing is copied into Neon except small link rows.

Start only after lab-mover reports eta-lab created and pushed (Fable tells you).

Repo: `vinaybhardwaj-commits/What-Are-Next` (main auto-deploys to Vercel project `what-are-next`, prj_saLnb3ds2Y7AyCwy3lj7UHurtg4F). Clone to ~/dev/What-Are-Next (not iCloud). Stack: Next.js 14.2 App Router, Neon + Drizzle (build-time migrator scripts/migrate.mjs), passcode auth via middleware, MCP at /api/mcp. Read its CLAUDE.md/README first. NOTE: the WAN repo is PUBLIC — never commit tokens, lab content or sample data into it.

Build:
1. Server-only GitHub reader (`src/lib/lab/github.ts`): fine-grained token in env `LAB_GITHUB_TOKEN` (read-only contents on eta-lab only — Fable creates it and sets the env; code must fail closed with a clear "not connected" state when unset). Use the GitHub contents/trees API; cache 60 s; never send the token to the client.
2. `/lab` page (sidebar + mobile nav entry "Lab"): list of studies from `studies/*/README.md` (title, status open/closed, date, owner) newest first; a study page rendering README, REPORT.md and any .md results (markdown), and listing other files with a link to GitHub. Orders list (`orders/`), the findings ledger (`ledger/ETA-FINDINGS-LEDGER.md`, newest entries first, searchable), and pane messages (`bus/`, latest first) as three more tabs.
3. Link from tasks: a task/initiative/action can carry a lab path (reuse the existing ProjectLinks with a new type `lab`, or a small `lab_links` table via a Drizzle migration — builder's choice, additive only). On a task page, a `lab` link opens the in-app study view, not GitHub.
4. MCP: add tools `lab_list_studies`, `lab_get_file(path)` and `link_lab(node_type, node_id, path)` to src/lib/mcp/registry.ts so Fable can attach study paths to tasks from Cowork.
5. Keep the design system (refined technical dark, JetBrains Mono eyebrows, one blue accent), responsive, works on iPhone.

Verify: typecheck, build, unit tests for the reader (fake GitHub responses, token absent -> not-connected state, token never in client bundle: grep .next output). Deploy by pushing main only after Fable's review; Fable verifies live via a Sonnet browser agent.

Do not: store lab file contents in Neon, expose eta-lab publicly, touch other WAN features, or change auth.

Report in 8 lines, end with WAITING ON Fable.
