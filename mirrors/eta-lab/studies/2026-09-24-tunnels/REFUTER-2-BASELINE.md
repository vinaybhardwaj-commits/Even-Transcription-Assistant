# TUNNEL-HARDENING P1: pre-switch baseline, eta-refuter-2 (24 Sep, ~15:25 IST)

This is independent of tunnel-ops' INVENTORY.md. No tokens, no account id, no IPs.

## Correction to my own check #1 (bus #342)
Comparing a public health body byte-for-byte with the origin **cannot detect wrong-machine routing**. Identical twins return identical bodies: whisper `/healthz` hashes the same on box, c3 and gcp-l4. And volatile fields (emotion `/health`) make equality fail even on the correct machine.

Machine identity instead comes from two checks:
1. **Connector check:** the API connections for each tunnel. Exactly one connector, from the expected host. Read-only, token read from its file.
2. **Canary check:** a request with a unique query string (`?canary=<nonce>`) sent to the PUBLIC hostname must appear exactly once in the matching service's journal on the expected host.

## Baseline (all before P1)
| tunnel | connectors | canary lands on | path-filter check | catch-all |
|---|---|---|---|---|
| eta-box | 1, from the box; local config; cloudflared-twin.service (system) | box: eta-diarize-twin, eta-emotion-twin, whisper-shim-twin | diarize-box /docs and /openapi.json: public 404, origin 200 | / 404 on all 3 |
| eta-c3 | 1, from c3; local config | c3 (e2e-147-28): same three units | diarize-c3 /docs, /openapi.json and **/speech_regions**: public 404 (c3's filter has no speech_regions); origin /docs 200 | / 404 on all 3 |
| eta-gcpl4 | 1, from gcp-l4; local config; **user** unit cloudflared-twin.service | gcp-l4 (eta-lab-l4): user whisper-shim-twin | - | / 404 |

Health status codes: whisper-* `/healthz` 200 (`/health` 404); diarize-* and emotion-* `/health` 200.

## Pass criteria after each switch
- The API shows config_src=cloudflare and exactly one connector, from the same host.
- The canary lands on the same unit(s) on the same host.
- Status codes are identical.
- The path filters are unchanged. c3 must NOT gain /speech_regions just because the box has it.
- / still returns 404.
- The old config.yml and credentials are still on disk.

## Ruling 120 amendments (24 Sep 15:00)
- **emotion-box and emotion-c3 `/docs` and `/openapi.json`: 200 publicly today** (checked 15:50). P1 adds a path filter that closes them, so the expected result after P1 is **404**, not "unchanged".
- The switch runs tomorrow 07:00-07:45 IST, run by Fable via `kit/tunnel-p1.sh`, in order gcpl4, then c3, then box. I refute the script and its rollback before then. I retake the baseline at ~06:50 on the day, because bulk traffic may have moved.
