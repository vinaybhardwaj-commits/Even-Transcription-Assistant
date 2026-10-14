import re, pathlib
p = pathlib.Path("/Users/vinaybhardwaj/dev/Even-Transcription-Assistant/docs/handoff/ETA-FINDINGS-LEDGER.md")
s = p.read_text()
orig = s
before = s.count("\n")
# 1. amend rules: append-only via >>, and supersede marker at point of claim
old_rule3 = "3. **Never edit or delete another pane's line.** If you disprove it, append a new line that says\n   `SUPERSEDES <date> <pane>` and why. The history is the point."
new_rule3 = ("3. **Never edit or delete another pane's line.** If you disprove it, append a new line that says\n"
 "   `SUPERSEDES <date> <pane>` and why. The history is the point. **Also** add ` ⚠ SUPERSEDED — see <pane> <date>`\n"
 "   to the END of the old line, changing none of its text — so a reader who stops at the claim sees the correction.\n"
 "7. **Write by appending only: `cat >> file <<EOF`.** Never read-modify-write the whole file — several panes\n"
 "   write here, and a read-modify-write from two panes at once silently deletes the other's lines.")
assert old_rule3 in s, "rule3 not found"
s = s.replace(old_rule3, new_rule3)
# 2. mark Fable's own seed line that lx superseded (0.908)
s = s.replace("near-field prints at **0.535**, below the 0.65 room threshold.",
              "near-field prints at **0.535**, below the 0.65 room threshold. ⚠ SUPERSEDED — see lx 2026-09-21", 1)
s = s.replace("audio. Enrolment is irreversible as built.",
              "audio. Enrolment is irreversible as built. ⚠ SUPERSEDED — see lx 2026-09-21", 1)
# 3. attribution error in Fable's seed: 0108 line was not ETA-Refuter's finding
s = s.replace("- 2026-09-20 ETA-Refuter — Migration 0108 `voice_print_generation` is live",
              "- 2026-09-20 scribe — Migration 0108 `voice_print_generation` is live", 1)
s = s.rstrip("\n") + ("\n- 2026-09-21 Fable — Attribution corrected: the 0108 `voice_print_generation` line was seeded under "
 "ETA-Refuter in error; ETA-Refuter only confirmed 0108 was applied and had not read its columns. The column-level finding is scribe's.\n")
if p.read_text() != orig:
    raise SystemExit("ABORT: another pane wrote meanwhile - retry")
lines_before = {l for l in orig.splitlines() if l.startswith("- 20")}
lines_after = {l.split(" ⚠ SUPERSEDED")[0].replace("- 2026-09-20 scribe — Migration 0108","- 2026-09-20 ETA-Refuter — Migration 0108") for l in s.splitlines() if l.startswith("- 20")}
missing = lines_before - lines_after
if missing:
    raise SystemExit(f"ABORT: would lose {len(missing)} lines")
p.write_text(s)
print("lines", before, "->", s.count("\n"))
print("markers:", s.count("⚠ SUPERSEDED"))
