# SECURITY RULES for every OpenCode pane (Fable ruling 432, 26 Sep 2026)

On Claude Code, a permission classifier stopped some actions automatically. On OpenCode nothing stops you but these rules. They bind exactly as hard as before. Breaking one = immediate rollback of your pane.

1. NEVER create, edit or append to: authorized_keys, ssh config, known_hosts, sshd config, cron, launchd plists, systemd units, shell rc files, or anything under ~/.claude/secrets, ~/.ssh, *.env. These changes are made ONLY by a V-run script that a checker has passed (by sha), dry-run first.
2. NEVER copy, print, move, hash-to-bus or transmit a key, token, password or credential file, and never put one on a command line (argv). Scripts read their own key files.
3. NEVER create accounts, keys or tokens with any provider (Tailscale, HF, Cloudflare, GCP, E2E, Zen, OpenRouter, ElevenLabs). Only V does that.
4. NEVER change firewall rules, Tailscale ACLs, Cloudflare Access policies or tunnel config without a named Fable order AND a checker PASS.
5. Deletes: only files you created in this task, never data. Anything else needs Fable's order naming the exact path.
6. Production (EvenScribe deploys, Neon writes, room commands, Vercel env) only on an explicit Fable order that names it.
7. Patient data: allowed where your task needs it (V holds ZDR agreements). It never goes into git, the bus, a free model or a non-ZDR service. Before touching PHI, confirm that your model line shows a PAID Zen model. A free-model fallback means STOP.
8. If you are unsure whether an action falls under 1-7: do not do it; ask Fable on the bus.
9. Checkers (eta-refuter, eta-refuter-2, vj-refuter) now run on OpenCode (deepseek-v4-pro). Their PASS/FAIL rules are unchanged: they rerun tests themselves, never build what they check, and positive controls come first.
