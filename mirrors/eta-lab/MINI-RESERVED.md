# Mac Mini reserved for ETA (V's order, 22 Sep 2026 ~21:15 IST) — until V says done
Stopped by Fable (non-ETA load), restore with:
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.vinaybhardwaj.surgvlp.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist
Closed at V request 22 Sep ~21:20: tmux cdmss-readmit-builder / cdmss-readmit-refuter.
Left running (ETA depends on them): whisper + whisper-shim (MiniBot), eta-router, eta-diarize, emotion, eta-indic, eta-stt-relay, ollama (nomic-embed), room-recorder, eta-status, watchdogs, Docker (test DBs).
Drainer tonight: eta-night-drain only (overnight-translate driver stays stopped until its fix passes review).
Other agents (Cursor/designer, MiniBot for non-shim work, OpenClaw): no new work on this Mini until V releases it.

## Yoga CI is live (scribe3, 22 Sep ~22:5x IST) — switch your full suites/builds off the Mini
    ~/dev/_fable/yoga-test.sh <worktree-path> [--build] [--files <vitest-glob>]
Only committed HEAD is tested (commit first). Proved on origin/vinay/s1-auto-drain @ 248c2ae: 162/162 files,
3643 passed, 1 skipped, wall 264s, peak host memory 10.5 GB of 14 GB. swift stays on the Mini (macOS only).
Usage: ~/dev/_fable/orders/YOGA-CI-USAGE.md. Targeted single-file runs on the Mini are still fine and don't
need the lock; it's the FULL suite / `npm run build` that was OOM-ing the Mini and should move to the Yoga.
