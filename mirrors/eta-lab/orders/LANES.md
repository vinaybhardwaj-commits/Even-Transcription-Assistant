# LANES — how the whole fleet runs in parallel (Fable, 23 Sep 21:15 IST)

One lane = one outcome, one owner pane, fixed machines, a queue 2 deep. pane-watch hands the next queued order to a pane the moment it goes idle; Fable refills queues and makes the calls. Nobody waits on Fable for routine next steps: when your lane item finishes, take the next item in YOUR lane below without asking.

## Machines
| machine | what it is | window | lock |
|---|---|---|---|
| eta-lab-t4 (E2E Delhi) | T4 16 GB + 12 vCPU, all box panes, CI slot A | always | /home/eta/gpu.lock, /tmp/eta-ci.lock |
| gcp-l4 (Google Mumbai) | L4 24 GB + 8 vCPU | always | ~/gpu.lock |
| Mini | M4 Pro MPS, production | lab 20:00–10:00 | /tmp/mini-lab.lock |
| ehrc-audiometry | M4 MPS 16 GB | 20:30–07:30 | pidfile |
| orbox3 | 12-core CPU, no GPU | 20:15–06:45 | /tmp/eta-lab-night.lock |
| air (V's MacBook Air) | M2 8-core CPU, light batches only, AC power only — it is Fable's bridge | while on AC | pidfile |
| eta-ci-c3 (E2E Chennai), Yoga | CI slots C/B | always | CI picker |
| GitHub Actions | 8-shard CI | always | — |
Rules for each: orders/RULING-MINI-NIGHT-LAB.md. Pick the machine that is FREE now, not the one you used last.

## Lanes (owner → next items, in order)
**L1 Production & backlog** — Fable deploys; split-speaker watches (bus/BACKLOG-WATCH.md every 30 min, ANOMALY → hsend fable). yoga-drain: emotion backlog root cause → the fix as a branch (Builder) → Refuter → next deploy.
**L2 Deploy train** — scribe = integrator. Next train (24 Sep): VAD trim 411127c (flag off) + everything that passes review tonight. One full gate (GitHub shards + box), Fable pushes.
**L3 Encounters (E-6/E-7)** — lx: GitHub shards green (public-log check) → 24 Sep 21:00 full-day rescore (script ready) → E-6.2 proposals from the score.
**L4 Who is speaking** — diar-lab: phase-1 arms C/D (T4 + gcp-l4 in parallel) → phase-1 table → phase-2 durable pipeline (R2 bucket eta-train, manifests, run records) → first segmentation fine-tune on gcp-l4. split-speaker (after BACKLOG-WATCH setup): per-turn voiceprint harvest from tonight's hybrid output (E-3), with yoga-drain.
**L5 Dead air — TOP PRIORITY TONIGHT** — lab-mover owns orders/VAD-V3.md (3 hypotheses, every candidate VAD, 200-window stratified set with held-out split, V listening pack) across gcp-l4 + orbox3 + audiometry/Mini + air + box; herdr-kit exports the data; eta-refuter-2 reviews the method; report 07:00. Then split-speaker wires the winner (flag off) → eta-refuter.
**L6 Translation** — indic-mt: TranslateGemma 12B on gcp-l4 + 4B on ehrc-audiometry (+ Sarvam results) → table → native-check-20-v2.html for V (Fable opens it on the Air).
**L7 Emotion** — lab-mover (after L5): box/gcp replica parity done → backlog scoring plan via the production path; speaker-attributed tone design.
**L8 Surgery (H)** — fleet: H-1 U9 wording trial → H-2 audit completeness wording → 30-consult set for V.
**L9 Review** — eta-refuter = product code bound for production (L1–L8 branches), eta-refuter-2 = infra/lab (kit, CI, lab scripts). Verdict within 45 min of a push; say if longer.
**L10 Infra** — herdr-kit: kit/lab-run.sh (pick a free machine for a GPU/CPU batch by lock + window, run it there, stream progress to that machine's log), pane-watch hardening, CI picker incl. GitHub shards, box/gcp access for every lane.

## Standing rules
Box eta-lab checkout is shared: commit to main, own files only. Reports ≤ 12 lines to Fable via your report / bus/for-fable.jsonl. Patient text never in git, logs or reports. Idle is a bug: if your lane is blocked, say BLOCKED + what unblocks it, and take the next item.
