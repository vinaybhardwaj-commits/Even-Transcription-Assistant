# Mini herdr cleanup (Fable, 24 Sep 12:15 IST). V asked what the idle Mini workspaces are.

Fact (Fable, 12:10): the Mini runs exactly 3 live Claude processes: eta-refuter, herdr-kit, minibot. Every other Mini workspace is a husk. Its session was /exit'ed this morning when the sessions moved to the box (or they are older duplicates). The work continues in the box panes of the same name.

## Owner: herdr-kit. Do it now; it is read-safe except the closes and kills below.
1. **CLOSE these Mini workspaces:** fleet, lx, scribe, scribe3, split-speaker, yoga-drain, minibot-2, refuter-gate, eta-assistant, indic-mt, diar-lab, lab-mover.
   - First check each pane has no live claude or other foreground job (process-info). If one does, skip it and report.
   - Do NOT resume the backgrounded ids shown there (dd7d5507 indic-mt, 10de3cf5 diar-lab). Confirm they are not running and leave them.
2. **KEEP:** the ETA-Refuter workspace (rename it `eta-refuter` to match), herdr-kit, minibot.
   - The minibot workspace showed a folder-trust prompt in one pane. Close that stray pane only if it is not the live minibot pane (wT:p1).
3. **Orphan shells:** 10 old Claude Bash shells (zsh -c snapshot…) are 20 h–3 d old (pids 12155 32344 32346 33003 36100 48710 69952 76880 95763 99637).
   - For each, list its child processes. Kill the ones that are stale watchers, sleep loops or dead tunnels.
   - KEEP anything serving a port that production or a twin uses. Report each pid and its decision.
4. **air workspace:**
   - air-diarize (pyannote on the Air's M2, :8086, localhost only): grep the env/bus/orders for any user of it. If none, stop it (it takes the Air's CPU/RAM while V works on it).
   - The air-lab pane idle at a shell: close it.
5. Report one table: workspace or pid → action → reason. Post it on the bus.
