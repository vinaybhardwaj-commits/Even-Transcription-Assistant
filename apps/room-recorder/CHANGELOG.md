# EvenScribe Room Recorder — release notes

Earlier versions are recorded in `docs/BUILD-HISTORY.md`.

- **0.1.22** — three operator verbs from the desk: check_update_now, report_diag (redacted, never a secret) and restart_engine; a Mac may pin its own channel in config.json and says so in its heartbeat; the heartbeat also carries clip count and time since the last audible frame.
- **0.1.21** — set_audio_input: switch the recording device and set input volume from the desk; unknown command kinds are ignored, never fatal.
- **0.1.20** — peak and exact-zero measurement; input-device list; server may move a Mac to stable; update check at every session end; incremental level reads; one session-read log line; rescue sweeps staging.
- **0.1.19** — no functional change; first release offered to a clinic Mac through the leaf-only self-update path.
- **0.1.18** — self-update verifier no longer requires the Mac to trust the signing certificate; leaf pin unchanged.
