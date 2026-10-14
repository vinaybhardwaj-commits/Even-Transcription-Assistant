# RULINGS 23 Sep 15:40 — speed-up on the E2E box (Fable). V: "speed things up as much as possible now that we have the cloud computer".
Box: `ssh e2e-lab` (user eta, sudo, Ubuntu 22.04, T4 16 GB, 12 vCPU, 45 GB RAM, 800 GB free). Live view: herdr space eta-lab-t4.
1. CI: as soon as one full ETA suite is green on the box, the box becomes the DEFAULT CI host and the Yoga the fallback. herdr-kit flips the default, updates orders/YOGA-CI-USAGE.md and tells every pane in one line.
2. Data: patient audio and derived clips MAY be copied to the box (Even-controlled, India, key-only access). Keep it under /home/eta/eta-data/<study>/ with the same 14-day-after-.closed cleanup (herdr-kit adds a systemd timer). DB credentials still stay off the box unless an order says otherwise.
3. Phase C of E2E-LAB-BOX.md moves from herdr-kit to diar-lab: diar-lab builds /home/eta/lab/venv itself, stops its Yoga runner, and runs phase 1 (all arms) on the GPU, then phase 2 (training on pyannote.ai teacher labels). GPU etiquette: one heavy GPU job at a time; take `flock /home/eta/gpu.lock` for anything over a few minutes.
4. indic-mt moves IndicTrans2 to the box GPU (/home/eta/indic/, own venv, port 8087 bound to localhost; reach it via ssh -L if needed), then finishes the bake-off's remaining turns there. Resume from the 20 done; do not redo them.
5. Each pane owns only its own directory on the box. No pane edits another pane's files. The Mini stays production-only; the Yoga is freed for drains.

6. (16:12) NO Docker on the Mini. Fable quit Docker Desktop (4 GB VM, zero containers) with Mini swap at 0.9 GB free. Any test harness that needs Docker/Postgres runs on the E2E box (docker available there via sudo apt if needed) or the Yoga.
