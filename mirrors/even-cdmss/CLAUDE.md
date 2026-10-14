## Git discipline (Build Orchestrator standing rules)

1. Commit ONLY files the active kickoff names. Stage by exact filename, never
   `git add -A`, never a bare directory. If your work needed a file outside the
   contract, flag it in your report and stage it only if the kickoff's deviation
   rule covers it.
1a. Carve-out for gate-forced edits: you may stage a file outside the kickoff's
    list ONLY when all four hold: (i) the gate itself fails without it, (ii) the
    failure is caused directly by a file the kickoff does name, (iii) the edit
    is mechanical — a regenerated artifact, a count/pin, a comment — never
    logic, and (iv) your report names the file, quotes this rule, and shows the
    diff is minimal. Anything beyond mechanical still stops under rule 6.
2. No commit without the full gate green: tests, typecheck for your files,
   production build, architecture:check where it applies.
3. Never push unless the order in front of you says push. Push only the branch
   the order names. Never touch main unless the order says main. Never merge,
   rebase onto, or delete refs without an explicit order. Never force-push.
4. Never commit documents from the working tree that your kickoff did not
   create. Programme papers (CDMSS-*.md handoff docs) stay OUT of this public
   repo — one has already carried a production member identifier, and this repo
   has had PHI history rewritten once.
5. Leave untracked files you did not create exactly as they are.
6. If an order conflicts with these rules, or rests on a premise the tree
   contradicts, STOP and report instead of improvising. A kickoff can override
   a rule only by quoting it and saying so explicitly.
7. Every report lists: files changed (from git show --stat), and one line
   confirming nothing outside the contract moved.
