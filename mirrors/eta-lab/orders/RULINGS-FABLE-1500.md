# Fable rulings — 24 Sep 15:00 IST (120–127)

120. **tunnel-ops P1 (classifier denied the token fetch + config PUT):**
     - The mutating Cloudflare steps are run by FABLE, not by an unattended pane. No permission rules get widened.
     - tunnel-ops writes `kit/tunnel-p1.sh <tunnel>`: idempotent; it reads the token from the secrets file (never argv or print), fetches the tunnel token, PUTs the SAME ingress + a path filter, and reinstalls the connector in token mode, with `--dry-run` as the default. It also writes a matching `kit/tunnel-p1-rollback.sh`.
     - eta-refuter-2 refutes both scripts. Fable runs them in the window below.
     - **Window:** eta-box and c3 carry PRODUCTION bulk traffic now (served_by whisper-box), so the switch happens **tomorrow 07:00–07:45 IST**, before clinic, one tunnel at a time, each with its canary check. gcpl4 first (no bulk traffic on it), then c3, then box.
     - **Path filter:** close `/docs` and `/openapi.json` on emotion-box / emotion-c3 in the same config change.
     - **yoga-node ingress** (Fable read it on the Yoga): `yoga-diarize` → http://127.0.0.1:8086, `yoga-ssh` → ssh://localhost:22, catch-all 404. The yoga-ssh public hostname must go behind Access (service token + V's email) FIRST in P2(c). It is ssh; P2 needs no app change for it.
121. **scribe (Access headers):**
     - YES: cover the ollama/llm host callers (llm.ts, kb-embed, health) before llm goes behind Access.
     - The audio-join Worker is not behind the tunnel (it uses its own token); leave it.
     - redirect:'error' as done. The suffix default is fine.
     - 9b08c9c rides the NEXT train after a gate.
122. **surg-page (chain page):** show the Rx text RAW (raters are PHI-cleared, ruling 61). No linker verdict on screen. Blind questions as proposed.
123. **linker:** eta-refuter-2's #355 guidance is ADOPTED. Score links also WITHOUT the procedure name (anti-circularity), and include negatives (advised-not-booked, no-procedure visits). Fix the margin before looking at results.
124. **HIST CPU nodes already exist** (ruling 117): hist-cpu-1/2 n2-highcpu-48. lab-mover packs ~5 stacks per node per its #347 design (whisper via the hist-gpu shims).
     - Cost is ~₹130/h per node. V has said cost is not a constraint.
     - If the throughput is linear, Fable adds more n2-highcpu nodes on lab-mover's number.
125. **Health flap 14:10–14:12 outside the :05 slot:** eta-refuter REOPENS ruling 25 (read-only RCA: the whisper probe timeout path, Mini load at 14:10, what else ran). Report by 17:00.
126. **Parity set 2:** judged only when all 19 windows are in, against the pre-registered bar. Fable decides on the result.
127. **Tonight's train** stays 73868e4 exactly. The next train collects: 535f802 + 9b08c9c (headers, dark) + 2cac359 (redaction).
