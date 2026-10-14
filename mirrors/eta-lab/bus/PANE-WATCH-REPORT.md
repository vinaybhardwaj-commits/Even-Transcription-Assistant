# pane-watch — report (herdr-kit, 23 Sep 2026 ~19:05)

**Files:** `kit/pane-watch.py` (watcher, stdlib only), `kit/qpush.sh` (enqueue helper), `kit/fable-inbox.sh` (cursor-based inbox reader). Committed to `main` (`ef4a059`, pushed).

**Launchd:** `com.vinaybhardwaj.eta-pane-watch`, `~/Library/LaunchAgents/`, `KeepAlive`, logs to `bus/pane-watch.log`. Bootstrapped, confirmed one process running (pid 69155), polling every 10s on both the Mini's default session and `eta-lab-t4`.

**Stop hook:** removed from the Mini's `~/.claude/settings.json` (the tmux-based lookup was always "unknown" under herdr; pane-watch's own done-capture makes it redundant, not just fixable) — `model` field confirmed unchanged before/after. The box's `settings.json` had no hooks at all; nothing to remove there.

**Test evidence (scratch agent `pane-watch-test` on `eta-lab-t4`, deleted after):** seeded a working→done transition deterministically (racing real timing on a haiku agent was unreliable — completions can land inside one 10s poll window) — `13:30:09Z` transition detected + report captured, `13:30:15Z` queued order delivered (**6s**, target was 15s) — confirmed by reading the pane: the agent had genuinely received and was responding to the queued message. `--dry-run` verified separately: logged every intended write/send, touched nothing on disk, sent nothing.

**UNVERIFIED:** the `blocked`-transition path (log-only, never answer) — not exercised live; only the working→done path was tested end to end. Logic mirrors the tested path closely (same `process_transition` function, same append-only jsonl write), but flagging it as read-only-code-reviewed, not live-proven.

WAITING ON Fable.
