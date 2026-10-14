# diar-lab

**Question:** diarization leak / guard investigation on the Yoga diarizer — root cause and fix for a leak, plus a guard against recurrence.

**Owner:** Builder (Mini) / diar-lab pane
**Date:** 2026-09-23
**Status:** open — see `diarize-leak-rca.md` (root cause), `diarize-leak-fix.diff` (candidate fix), `diarize-guard.sh.bak-0922` / `diarize-guard.plist.bak-0922` (pre-fix backups of the guard script/launchd job), `yoga-diarize.md` (Yoga-side notes), `spawn-diar.out` (spawn log). The order file is `orders/DIAR-LAB.md`.

---

## Phase 1: local diarizer vs pyannote.ai (separate piece of work, same pane/order file)

**Question:** can a free local diarizer get close to pyannote.ai precision-3? Same `orders/DIAR-LAB.md`, the arms-comparison section (not the leak RCA above). Compute moved Mini→Yoga→E2E GPU box (`e2e-lab`) per `orders/RULINGS-23-SEP-1540-E2E.md`.
**Status:** in progress — see `PHASE1-RESULTS.md` for the full table (Arm A done on both the 5-window and 20-window sets; Arm B fixed after two crashes, 20-window run in progress; Arm C/D not started).
