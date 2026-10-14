# E-7 PQM-truth prep — findings (2026-09-23)

No patient identifiers, no transcript text below. Doctor names originally in this file were replaced with room-based labels before this study was committed to eta-lab (private repo, but doctor identity follows the same rule as patient identity: counts/ids/timings only). The raw query outputs that do carry doctor names (`pqm-consults.csv`, `e7-truth.csv`, `voiceprint-attribution.json`, `build_truth.py`) live at `/Volumes/Air Drive/eta-data/2026-09-23-e7-pqm-truth/` instead.

## 1. Blocked: Metabase db 13 and the Pulse monorepo are not reachable from this session

Checked, in order:
- `ToolSearch` for a Metabase MCP tool, multiple queries ("metabase query database", "queue_token kx chartserver PQM hospital mirror sql"). No Metabase-named tool exists in this session's roster. The closest tools (`mcp__claude_ai_CDMSS_Lab__audit_query`, `mcp__claude_ai_Governance__sql_query`) reach different databases (the CDMSS audit Neon DB and the governance DB) — neither is db 13. `audit_query`'s own description says db13 fields are reached by "the Metabase MCP", which is not attached here.
- Filesystem search across `~/dev` (all repos now readable per the 23-Sep `additionalDirectories` rule) and the rest of `~` for `get_display_board.go` and for the string `opdRoomByDoctor`: no match anywhere. The Pulse monorepo (`next-web/chart/chartserver`) is not checked out on this Mac.
- No Metabase API credential file on this Mac: `~/.claude/secrets/` holds `neon_api_key`, `openrouter_api_key`, `overnight_translate_mcp_token`, `pyannote_api_key`, `scribe_mcp_token` — no Metabase token. `~/dev/eta-lab/secrets/` holds only a `.vercel` directory. The only `.rtf` connection string on the Mac is `Neon Database Connection String.rtf` (the ETA app DB, not db 13).

Consequence: I could not run the `queue_token_steps` query in the order, could not locate `opdRoomByDoctor`, and could not inspect `queue_tokens-queue_token_events` (Metabase table 8176) — columns or STEP_CALLED/STEP_COMPLETED history. This whole line needs either (a) a Metabase MCP attached to this session, (b) the Pulse monorepo cloned here, or (c) someone with that access (Orchestrator/V) running the query in `E7-PQM-TRUTH.md` and the table-8176 schema query and handing back the result. Per the standing rule, this is flagged rather than guessed at — no SQL result or schema below is fabricated.

## 2. Scribe-side clustering is currently broken (separate, real finding)

`scribe_rooms(view=clusters)` — the tool meant to return "one room-day's speaker clusters" — returns empty for every room-day checked, with an explicit reason:

> `"clustering_not_running","detail":"no writer populates speaker_cluster: the room diarize pass that did was deleted in C2, and clustering is rebuilt on the diarize_window job only once SPEAKER_MATCH_THRESHOLD is set from calibration data"`

(confirmed on `room_qyzghzaf` / 2026-09-22 / `rd_au3vmzsm`). This is not an E-7-specific gap — it means the cluster-level room-day speaker view is unavailable platform-wide right now. The per-window path (`scribe_voice(view=window_speakers, room_day_id=...)`) still works and was used instead (see `voiceprint-attribution.json`).

## 3. What voiceprint-only mapping can and cannot do here

Scoring rule 4 of the order says: only score room-days where the room->doctor mapping is *confirmed by voiceprint count*; list the rest as unmapped. Without the display-board config, voiceprint attribution alone can still tell us which enrolled clinician's voice dominates a given room-day (see `voiceprint-attribution.json`), but it cannot *confirm against intent* — there is no independent "who was scheduled in this room" signal to check it against. Treat every room-day below as **voice-inferred only, not display-board-confirmed**, until the display-board side is unblocked.

See `voiceprint-attribution.json` for the per-room-day turn counts and attribution rates gathered via `scribe_voice(view=window_speakers)` across the 4 dates.

## 4. Voiceprint-attribution results (44 room x date pairs, 11 rooms x 4 dates)

33 pairs had a session ("ok"); 11 had none. Of the 33, only **11 had any voiceprint attribution at all** (attribution_rate > 0) — the other 22 active room-days produced turns but matched no enrolled clinician.

Clean, repeatable single-clinician mapping (same clinician dominant across every day checked):
- **Cardiology OPD -> the Cardiology OPD clinician** (21/22/23 Sep, attribution_rate 0.15-0.36, 100% of attributed turns theirs every day)
- **OPD 3 -> the OPD 3 clinician** (21/22/23 Sep, 100% of attributed turns theirs every day)
- **OPD 5 -> the OPD 5/6 clinician** (21 and 23 Sep; 21 Sep also carries 7 turns for a second, minority clinician)
- **OPD 6 -> the OPD 5/6 clinician** (22 Sep only day with any attribution; 20/21/23 Sep all zero)
- **ORB3 -> the OPD 3 clinician** (21/22 Sep, but only 10 and 25 attributed turns — low-confidence, and the same clinician as OPD 3 raises a bleed/overflow-mic question worth checking before trusting it)

**Zero attribution on every active day** (500 turns, 2-10 distinct speaker indices, matched clinician none): OPD 7, OPD 1, OPD 4, Dietary Room, Third Floor Consultation, and OPD 6 on 3 of its 4 active days. Given the clean matches above prove the matching path works when the room's doctor is enrolled, the more likely explanation is that these rooms' doctors are simply **not among the 7 enrolled voiceprints** — not a matching failure. Unverified: would need the display-board config to check which doctor is actually assigned to each of these rooms and cross-check against the enrollment list.

Per scoring rule 4: only Cardiology OPD, OPD 3, and OPD 5 (and OPD 6 on 22 Sep only) should be scored as voiceprint-confirmed; every other room-day here is unmapped by this method alone.
