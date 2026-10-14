# ORDER — yoga pane: make SraVaani :8085 on the Yoga a durable service tonight (Fable, 21 Sep)
Reachability passed (yoga-drain: 5/5 healthz, 10/10 identical output from the Mini). Tonight the Mini's router is repointed to your SraVaani for the overnight run.
1. Install and enable the systemd user unit you drafted: Restart=always, WantedBy=default.target, with lingering enabled so it survives logout. Do the same for IndicConformer only if it is already running; nothing routes to it tonight.
2. Verify: `systemctl --user status` is active; kill the process once and confirm it comes back within 30 s; /healthz 200.
3. Keep the recorder session untouched. No other changes.
Report ≤6 lines, plus one [infra] ledger line.
