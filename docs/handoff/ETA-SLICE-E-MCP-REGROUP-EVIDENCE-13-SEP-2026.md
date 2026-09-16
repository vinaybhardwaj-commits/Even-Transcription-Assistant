# ETA Slice E — MCP regroup: curl evidence (13 Sep 2026)

Branch vinay/tier2-e, worktree ../Even-Transcription-Assistant-slice-e, base 6b2347e. No database in this sandbox, so reads answer degraded; the point of each pair is that the grouped call and the old name return the same body and the same HTTP status. Tokens were throwaway SCRIBE_MCP_TOKENS entries (one read-only, one write-only) for a local `next start` of the built branch. No token appears below.

## 1. Live door, tools/list (the fixture source)

```
banner version: 6b2347e
tools/list: HTTP 200, 51 tools
sha256 of fixtures/mcp/live-tools-list-6b2347e.json: 70349500214b6dce429fa23b71ac4bd43c44325a0cec898b1517bf42b0447c79
```

## 2. Local door at ea533c2, tools/list

```
count: 33
names: scribe_health scribe_system scribe_rooms scribe_get_state scribe_list_cues scribe_post_cue scribe_pin_visit scribe_room_command scribe_sessions scribe_session_tape scribe_mark_consult scribe_extract_audio scribe_transcribe_range scribe_ops_log scribe_scratch scribe_list_stt_engines scribe_stt_health scribe_stt_routing scribe_list_stt_runs scribe_get_stt_run scribe_route_tripwires scribe_voice_health scribe_list_voiceprints scribe_list_voice_samples scribe_get_clusters scribe_list_encounters scribe_encounter scribe_list_traces scribe_set_visit_clinician scribe_fuse_report scribe_job_submit scribe_job_status scribe_job_cancel
```

First paragraph of the two reused names' descriptions, as served:

```
scribe_health: SAME TOOL, MORE ASPECTS. scribe_health called with no `aspect` (or aspect=all) is exactly the scribe_health this door has always published: same arguments, same behaviour, same response. 2 aspects were added, each running what was a separate tool (whose name still works): llm → scribe_llm_health; kb → scribe_kb_probe.
scribe_room_command: SAME TOOL, MORE KINDS. scribe_room_command called with kind check_update_now | report_diag | restart_engine is exactly the scribe_room_command this door has always published: same arguments, same behaviour, same response. 6 kinds were added, each running what was a separate tool (whose name still works): start_day → scribe_start_recording; pause_day → scribe_pause_recording; resume_day → scribe_resume_recording; end_day → scribe_stop_recording; close_orphaned_session → scribe_close_orphaned_session; set_audio_input → scribe_set_audio_input.
```

## 3. Local door at 3c5db97, tools/call — grouped vs old name, and scope refusals

Columns: tool, arguments, HTTP status, JSON-RPC error or structuredContent (truncated at 230 chars).

```
## READ token — grouped vs old name
scribe_rooms                 {"view":"list"}                                            HTTP 200  {"isError":false,"content":{"rooms":[],"degraded":true,"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2)."}}
scribe_list_rooms            {}                                                         HTTP 200  {"isError":false,"content":{"rooms":[],"degraded":true,"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2)."}}
scribe_rooms                 {"view":"fleet"}                                           HTTP 200  {"isError":false,"content":{"now":"2026-09-13T01:19:30.142Z","releases":{"stable":null,"test":null},"rooms":[],"degraded":["rooms_unavailable:APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","installs
scribe_fleet                 {}                                                         HTTP 200  {"isError":false,"content":{"now":"2026-09-13T01:19:30.172Z","releases":{"stable":null,"test":null},"rooms":[],"degraded":["rooms_unavailable:APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","installs
scribe_rooms                 {"view":"day_report","room":"opd-x"}                       HTTP 200  {"isError":false,"content":{"sessions":[],"degraded":true,"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2)."}}
scribe_day_report            {"room":"opd-x"}                                           HTTP 200  {"isError":false,"content":{"sessions":[],"degraded":true,"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2)."}}
scribe_system                {"view":"stores"}                                          HTTP 200  {"isError":false,"content":{"ist_date":"2026-09-13","bench":{"sessions":null,"sessions_by_status":null,"chunks_by_upload_state":null,"consult_marks":null},"encounters":{"total":null,"today_ist":null},"stt":{"engines_enabled":null}
scribe_store_stats           {}                                                         HTTP 200  {"isError":false,"content":{"ist_date":"2026-09-13","bench":{"sessions":null,"sessions_by_status":null,"chunks_by_upload_state":null,"consult_marks":null},"encounters":{"total":null,"today_ist":null},"stt":{"engines_enabled":null}
scribe_sessions              {"view":"list","limit":5}                                  HTTP 200  {"isError":false,"content":{"sessions":[],"degraded":true,"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2)."}}
scribe_list_sessions         {"limit":5}                                                HTTP 200  {"isError":false,"content":{"sessions":[],"degraded":true,"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2)."}}
scribe_sessions              {"view":"replay","session_id":"bs_x"}                      HTTP 200  {"isError":false,"content":{"cues":[],"error":"session_not_found"}}
scribe_replay_session        {"session_id":"bs_x"}                                      HTTP 200  {"isError":false,"content":{"cues":[],"error":"session_not_found"}}
scribe_session_tape          {"view":"session","session_id":"bs_x"}                     HTTP 200  {"isError":false,"content":{"session":null,"chunks":[],"marks":[],"error":"session_not_found"}}
scribe_get_session           {"session_id":"bs_x"}                                      HTTP 200  {"isError":false,"content":{"session":null,"chunks":[],"marks":[],"error":"session_not_found"}}
scribe_session_tape          {"view":"zip","session_id":"bs_x"}                         HTTP 200  {"isError":false,"content":{"mode":"zip","error":"session_not_found"}}
scribe_get_recording         {"session_id":"bs_x","mode":"zip"}                         HTTP 200  {"isError":false,"content":{"mode":"zip","error":"session_not_found"}}
scribe_encounter             {"encounter_id":"enc_x"}                                   HTTP 200  {"isError":false,"content":{"encounter":null,"degraded":true,"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2)."}}
scribe_get_encounter         {"encounter_id":"enc_x"}                                   HTTP 200  {"isError":false,"content":{"encounter":null,"degraded":true,"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2)."}}
scribe_encounter             {"trace_id":"tr_x"}                                        HTTP 200  {"isError":false,"content":{"trace":null,"error":"bad_trace_id"}}
scribe_get_trace             {"trace_id":"tr_x"}                                        HTTP 200  {"isError":false,"content":{"trace":null,"error":"bad_trace_id"}}
scribe_encounter             {"encounter_id":"enc_x","trace_id":"tr_x"}                 HTTP 200  {"isError":false,"content":{"ok":false,"error":"one_id_required","detail":"pass exactly one of encounter_id or trace_id"}}
scribe_ops_log               {"source":"commands","limit":3}                            HTTP 200  {"isError":false,"content":{"ok":false,"error":"bus_down","detail":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","commands":[]}}
scribe_list_commands         {"limit":3}                                                HTTP 200  {"isError":false,"content":{"ok":false,"error":"bus_down","detail":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","commands":[]}}
scribe_ops_log               {"source":"jobs","limit":3}                                HTTP 200  {"isError":false,"content":{"jobs":[],"degraded":true,"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2)."}}
scribe_job_list              {"limit":3}                                                HTTP 200  {"isError":false,"content":{"jobs":[],"degraded":true,"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2)."}}
scribe_ops_log               {"source":"audit","limit":3}                               HTTP 200  {"isError":false,"content":{"rows":[],"degraded":true,"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2)."}}
scribe_audit_recent          {"limit":3}                                                HTTP 200  {"isError":false,"content":{"rows":[],"degraded":true,"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2)."}}
scribe_ops_log               {"source":"everything"}                                    HTTP 200  {"isError":false,"content":{"ok":false,"error":"unknown_source","allowed":["commands","jobs","audit"]}}
## READ token — write tools and write groups must be refused
scribe_room_command          {"kind":"start_day","room":"opd-x"}                        HTTP 403  {"error":"scope_or_tool_unavailable","code":-32001,"data":{"tool":"scribe_room_command","slice":"S3"}}
scribe_start_recording       {"room":"opd-x"}                                           HTTP 403  {"error":"scope_or_tool_unavailable","code":-32001,"data":{"tool":"scribe_start_recording","slice":"S3"}}
scribe_scratch               {"action":"fuse","room_day_id":"rd_x","arm":"rules","dry_run":true} HTTP 403  {"error":"scope_or_tool_unavailable","code":-32001,"data":{"tool":"scribe_scratch","slice":"S3"}}
## WRITE token (no read scope)
scribe_rooms                 {"view":"list"}                                            HTTP 403  {"error":"scope_or_tool_unavailable","code":-32001,"data":{"tool":"scribe_rooms","slice":"S3"}}
scribe_room_command          {"kind":"reboot","room":"opd-x"}                           HTTP 200  {"isError":false,"content":{"ok":false,"error":"unknown_kind","allowed":["start_day","pause_day","resume_day","end_day","close_orphaned_session","set_audio_input","check_update_now","report_diag","restart_engine"]}}
scribe_room_command          {"kind":"close_orphaned_session","room":"opd-x"}           HTTP 200  {"isError":false,"content":{"error":"room_lookup_failed","detail":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","degraded":true}}
scribe_close_orphaned_session {"room":"opd-x"}                                           HTTP 200  {"isError":false,"content":{"error":"room_lookup_failed","detail":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","degraded":true}}
scribe_room_command          {"kind":"set_audio_input","room":"opd-x"}                  HTTP 200  {"isError":false,"content":{"ok":false,"error":"bad_args","detail":"name device_uid or input_volume"}}
scribe_set_audio_input       {"room":"opd-x"}                                           HTTP 200  {"isError":false,"content":{"ok":false,"error":"bad_args","detail":"name device_uid or input_volume"}}
```

## 4. Local door at 4edd2e9 (commit 1c): tools/list word counts, and all 51 names called by name

Each old name was called with `{}` and a throwaway token holding exactly its scope (read, write or invoke). HTTP status, `_meta.tool`, and the error/degraded fields of the answer (no database, so errors are expected).

```
## tools/list at the 1c tree
count: 33
scribe_health: 64 words
scribe_system: 45 words
scribe_rooms: 56 words
scribe_room_command: 134 words
scribe_sessions: 52 words
scribe_session_tape: 71 words
scribe_ops_log: 57 words
scribe_scratch: 57 words
scribe_encounter: 57 words

## every one of the 51 live names, called by name with {} and a token holding its scope
scribe_audit_recent              read   HTTP 200  meta.tool=scribe_audit_recent  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","
scribe_close_orphaned_session    write  HTTP 200  meta.tool=scribe_close_orphaned_session  {"error":"unknown_room","degraded":null}
scribe_day_report                read   HTTP 200  meta.tool=scribe_day_report  {"error":"unknown_room","degraded":null}
scribe_diff_room                 read   HTTP 200  meta.tool=scribe_diff_room  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","
scribe_extract_audio             invoke HTTP 200  meta.tool=scribe_extract_audio  {"error":"unknown_room","degraded":null}
scribe_fleet                     read   HTTP 200  meta.tool=scribe_fleet  {"error":null,"degraded":["rooms_unavailable:APP_DATABASE_URL not set. Configure in Vercel
scribe_fuse_report               read   HTTP 200  meta.tool=scribe_fuse_report  {"error":"room_day_id_required","degraded":null}
scribe_fuse_run                  write  HTTP 200  meta.tool=scribe_fuse_run  {"error":"room_day_id_required","degraded":null}
scribe_get_clusters              read   HTTP 200  meta.tool=scribe_get_clusters  {"error":"unknown_room","degraded":null}
scribe_get_encounter             read   HTTP 200  meta.tool=scribe_get_encounter  {"error":"bad_encounter_id","degraded":null}
scribe_get_recording             read   HTTP 200  meta.tool=scribe_get_recording  {"error":"bad_session_id","degraded":null}
scribe_get_session               read   HTTP 200  meta.tool=scribe_get_session  {"error":"bad_session_id","degraded":null}
scribe_get_state                 read   HTTP 200  meta.tool=scribe_get_state  {"error":"unknown_room","degraded":null}
scribe_get_stt_run               read   HTTP 200  meta.tool=scribe_get_stt_run  {"error":"subject_id_required","degraded":null}
scribe_get_trace                 read   HTTP 200  meta.tool=scribe_get_trace  {"error":"bad_trace_id","degraded":null}
scribe_health                    read   HTTP 200  meta.tool=scribe_health  {"error":null,"degraded":null}
scribe_job_cancel                write  HTTP 200  meta.tool=scribe_job_cancel  {"error":"job_id_required","degraded":null}
scribe_job_list                  read   HTTP 200  meta.tool=scribe_job_list  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","
scribe_job_status                read   HTTP 200  meta.tool=scribe_job_status  {"error":"job_id_required","degraded":null}
scribe_job_submit                invoke HTTP 200  meta.tool=scribe_job_submit  {"error":"unknown_kind","degraded":null}
scribe_kb_probe                  read   HTTP 200  meta.tool=scribe_kb_probe  {"error":"embed_failed: OLLAMA_BASE_URL not set","degraded":null}
scribe_list_commands             read   HTTP 200  meta.tool=scribe_list_commands  {"error":"bus_down","degraded":null}
scribe_list_cues                 read   HTTP 200  meta.tool=scribe_list_cues  {"error":"unknown_room","degraded":null}
scribe_list_encounters           read   HTTP 200  meta.tool=scribe_list_encounters  {"error":null,"degraded":null}
scribe_list_rooms                read   HTTP 200  meta.tool=scribe_list_rooms  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","
scribe_list_sessions             read   HTTP 200  meta.tool=scribe_list_sessions  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","
scribe_list_stt_engines          read   HTTP 200  meta.tool=scribe_list_stt_engines  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","
scribe_list_stt_runs             read   HTTP 200  meta.tool=scribe_list_stt_runs  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","
scribe_list_traces               read   HTTP 200  meta.tool=scribe_list_traces  {"error":null,"degraded":null}
scribe_list_voice_samples        read   HTTP 200  meta.tool=scribe_list_voice_samples  {"error":"clinician_id_required","degraded":null}
scribe_list_voiceprints          read   HTTP 200  meta.tool=scribe_list_voiceprints  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","
scribe_llm_health                read   HTTP 200  meta.tool=scribe_llm_health  {"error":null,"degraded":null}
scribe_mark_consult              write  HTTP 200  meta.tool=scribe_mark_consult  {"error":"unknown_room","degraded":null}
scribe_pause_recording           write  HTTP 200  meta.tool=scribe_pause_recording  {"error":"unknown_room","degraded":null}
scribe_pin_visit                 write  HTTP 200  meta.tool=scribe_pin_visit  {"error":"unknown_room","degraded":null}
scribe_post_cue                  write  HTTP 200  meta.tool=scribe_post_cue  {"error":"unknown_room","degraded":null}
scribe_replay_session            read   HTTP 200  meta.tool=scribe_replay_session  {"error":"bad_session_id","degraded":null}
scribe_replay_write              write  HTTP 200  meta.tool=scribe_replay_write  {"error":"bad_session_id","degraded":null}
scribe_resume_recording          write  HTTP 200  meta.tool=scribe_resume_recording  {"error":"unknown_room","degraded":null}
scribe_room_command              write  HTTP 200  meta.tool=scribe_room_command  {"error":"unknown_kind","degraded":null}
scribe_route_tripwires           read   HTTP 200  meta.tool=scribe_route_tripwires  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","
scribe_set_audio_input           write  HTTP 200  meta.tool=scribe_set_audio_input  {"error":"bad_args","degraded":null}
scribe_set_visit_clinician       write  HTTP 200  meta.tool=scribe_set_visit_clinician  {"error":"bad_visit_id","degraded":null}
scribe_start_recording           write  HTTP 200  meta.tool=scribe_start_recording  {"error":"unknown_room","degraded":null}
scribe_stop_recording            write  HTTP 200  meta.tool=scribe_stop_recording  {"error":"unknown_room","degraded":null}
scribe_store_stats               read   HTTP 200  meta.tool=scribe_store_stats  {"error":null,"degraded":true}
scribe_stt_health                read   HTTP 200  meta.tool=scribe_stt_health  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","
scribe_stt_routing               read   HTTP 200  meta.tool=scribe_stt_routing  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","
scribe_system_map                read   HTTP 200  meta.tool=scribe_system_map  {"error":null,"degraded":null}
scribe_transcribe_range          invoke HTTP 200  meta.tool=scribe_transcribe_range  {"error":"unknown_room","degraded":null}
scribe_voice_health              read   HTTP 200  meta.tool=scribe_voice_health  {"error":"DIARIZE_BASE_URL not set","degraded":null}

tally: 51 names called, 51 answered HTTP 200 with _meta.tool equal to the name called
```

## 5. Local door at d961d83 (commit 1d): scribe_ops_log removed by ruling

```
## tools/list
count: 35
scribe_ops_log listed: false
listed as themselves: scribe_list_commands, scribe_job_list, scribe_audit_recent
## tools/call
scribe_ops_log         HTTP 403  {"error":"scope_or_tool_unavailable","code":-32001}
scribe_list_commands   HTTP 200  {"meta_tool":"scribe_list_commands","error":"bus_down"}
scribe_job_list        HTTP 200  {"meta_tool":"scribe_job_list","error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2)."}
scribe_audit_recent    HTTP 200  {"meta_tool":"scribe_audit_recent","error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2)
```

## 6. Rebase onto 0f27b8c: C2's one-writer proof, run before any commit-2 code (at cadc00d)

```
npx vitest run tests/unit/c2-e2e-runner.test.ts tests/unit/room-diarize-job.test.ts --reporter=verbose   (ETA_ALLOW_SKIP_E2E unset, Docker 29.7.2 up)
 ✓ tests/unit/room-diarize-job.test.ts > the enqueue > it WRITES NOTHING — every table has its one writer on the job
 ✓ tests/unit/c2-e2e-runner.test.ts > REQUIRED PROOF — the diarize end-to-end suite > ran, or was skipped deliberately
 ✓ tests/unit/c2-e2e-runner.test.ts > C2 Ruling 2 — one writer per table, and the live reader is still fed > the CALIBRATION READER gets data through its own code path after a job runs 625ms
 ✓ tests/unit/c2-e2e-runner.test.ts > C2 Ruling 2 — one writer per table, and the live reader is still fed > ONE WRITER, BEHAVIOURALLY: break the job's write and nothing else writes those tables 1438ms
 ✓ tests/unit/c2-e2e-runner.test.ts > C2 Ruling 2 — one writer per table, and the live reader is still fed > ONE RUN: the route enqueues, the job's write is REJECTED by postgres, and nothing reads as success 1774ms
 ✓ tests/unit/c2-e2e-runner.test.ts > C2 Ruling 2 — one writer per table, and the live reader is still fed > a failed ENQUEUE returns a non-2xx — the route never looks like success when it could not queue 378ms
 Test Files  2 passed (2)
      Tests  57 passed (57)
```

## 7. Local door at fee5822 (commit 2): 27 listed, new variants through their groups, all 52 names by name

Throwaway read/write/invoke tokens, no database: degraded answers are expected; the point is which tool answered.

```
## tools/list at the commit-2 tree
count: 27
names: scribe_health scribe_system scribe_rooms scribe_get_state scribe_list_cues scribe_post_cue scribe_pin_visit scribe_room_command scribe_sessions scribe_session_tape scribe_mark_consult scribe_extract_audio scribe_transcribe_range scribe_list_commands scribe_scratch scribe_stt_runs scribe_voice scribe_list_encounters scribe
scribe_health: 70 words; selector enum: all,stt,voice,llm,kb
scribe_system: 63 words; selector enum: map,stores,stt_engines,stt_routing,stt_tripwires
scribe_rooms: 63 words; selector enum: list,now,fleet,day_report,clusters
scribe_stt_runs: 63 words; selector enum: (id-routed)
scribe_voice: 64 words; selector enum: prints,samples,window_speakers

## new variants, called through their group (read token)
scribe_health    {"aspect":"stt"}                             HTTP 200  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","degraded":true,"allo
scribe_health    {"aspect":"voice"}                           HTTP 200  {"error":"DIARIZE_BASE_URL not set","degraded":null,"allowed":null}
scribe_system    {"view":"stt_engines"}                       HTTP 200  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","degraded":true,"allo
scribe_system    {"view":"stt_routing"}                       HTTP 200  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","degraded":true,"allo
scribe_system    {"view":"stt_tripwires","days":7}            HTTP 200  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","degraded":true,"allo
scribe_rooms     {"view":"clusters","room":"opd-x"}           HTTP 200  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","degraded":true,"allo
scribe_stt_runs  {"limit":3}                                  HTTP 200  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","degraded":true,"allo
scribe_stt_runs  {"subject_id":"bw_x"}                        HTTP 200  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","degraded":true,"allo
scribe_voice     {"view":"prints"}                            HTTP 200  {"error":"APP_DATABASE_URL not set. Configure in Vercel env (see ETA-BUILD-PLAN.md §2).","degraded":true,"allo
scribe_voice     {"view":"samples"}                           HTTP 200  {"error":"clinician_id_required","degraded":null,"allowed":null}
scribe_voice     {"view":"window_speakers"}                   HTTP 200  {"error":"window_id or room_day_id is required","degraded":null,"allowed":null}
scribe_voice     {"view":"everything"}                        HTTP 200  {"error":"unknown_view","degraded":null,"allowed":["prints","samples","window_speakers"]}

## every published name (52), called by name with {} and a token holding exactly its scope
scribe_audit_recent              read   HTTP 200  meta.tool=scribe_audit_recent
scribe_close_orphaned_session    write  HTTP 200  meta.tool=scribe_close_orphaned_session
scribe_day_report                read   HTTP 200  meta.tool=scribe_day_report
scribe_diff_room                 read   HTTP 200  meta.tool=scribe_diff_room
scribe_extract_audio             invoke HTTP 200  meta.tool=scribe_extract_audio
scribe_fleet                     read   HTTP 200  meta.tool=scribe_fleet
scribe_fuse_report               read   HTTP 200  meta.tool=scribe_fuse_report
scribe_fuse_run                  write  HTTP 200  meta.tool=scribe_fuse_run
scribe_get_clusters              read   HTTP 200  meta.tool=scribe_get_clusters
scribe_get_encounter             read   HTTP 200  meta.tool=scribe_get_encounter
scribe_get_recording             read   HTTP 200  meta.tool=scribe_get_recording
scribe_get_session               read   HTTP 200  meta.tool=scribe_get_session
scribe_get_state                 read   HTTP 200  meta.tool=scribe_get_state
scribe_get_stt_run               read   HTTP 200  meta.tool=scribe_get_stt_run
scribe_get_trace                 read   HTTP 200  meta.tool=scribe_get_trace
scribe_health                    read   HTTP 200  meta.tool=scribe_health
scribe_job_cancel                write  HTTP 200  meta.tool=scribe_job_cancel
scribe_job_list                  read   HTTP 200  meta.tool=scribe_job_list
scribe_job_status                read   HTTP 200  meta.tool=scribe_job_status
scribe_job_submit                invoke HTTP 200  meta.tool=scribe_job_submit
scribe_kb_probe                  read   HTTP 200  meta.tool=scribe_kb_probe
scribe_list_commands             read   HTTP 200  meta.tool=scribe_list_commands
scribe_list_cues                 read   HTTP 200  meta.tool=scribe_list_cues
scribe_list_encounters           read   HTTP 200  meta.tool=scribe_list_encounters
scribe_list_rooms                read   HTTP 200  meta.tool=scribe_list_rooms
scribe_list_sessions             read   HTTP 200  meta.tool=scribe_list_sessions
scribe_list_stt_engines          read   HTTP 200  meta.tool=scribe_list_stt_engines
scribe_list_stt_runs             read   HTTP 200  meta.tool=scribe_list_stt_runs
scribe_list_traces               read   HTTP 200  meta.tool=scribe_list_traces
scribe_list_voice_samples        read   HTTP 200  meta.tool=scribe_list_voice_samples
scribe_list_voiceprints          read   HTTP 200  meta.tool=scribe_list_voiceprints
scribe_llm_health                read   HTTP 200  meta.tool=scribe_llm_health
scribe_mark_consult              write  HTTP 200  meta.tool=scribe_mark_consult
scribe_pause_recording           write  HTTP 200  meta.tool=scribe_pause_recording
scribe_pin_visit                 write  HTTP 200  meta.tool=scribe_pin_visit
scribe_post_cue                  write  HTTP 200  meta.tool=scribe_post_cue
scribe_replay_session            read   HTTP 200  meta.tool=scribe_replay_session
scribe_replay_write              write  HTTP 200  meta.tool=scribe_replay_write
scribe_resume_recording          write  HTTP 200  meta.tool=scribe_resume_recording
scribe_room_command              write  HTTP 200  meta.tool=scribe_room_command
scribe_route_tripwires           read   HTTP 200  meta.tool=scribe_route_tripwires
scribe_set_audio_input           write  HTTP 200  meta.tool=scribe_set_audio_input
scribe_set_visit_clinician       write  HTTP 200  meta.tool=scribe_set_visit_clinician
scribe_start_recording           write  HTTP 200  meta.tool=scribe_start_recording
scribe_stop_recording            write  HTTP 200  meta.tool=scribe_stop_recording
scribe_store_stats               read   HTTP 200  meta.tool=scribe_store_stats
scribe_stt_health                read   HTTP 200  meta.tool=scribe_stt_health
scribe_stt_routing               read   HTTP 200  meta.tool=scribe_stt_routing
scribe_system_map                read   HTTP 200  meta.tool=scribe_system_map
scribe_transcribe_range          invoke HTTP 200  meta.tool=scribe_transcribe_range
scribe_voice_health              read   HTTP 200  meta.tool=scribe_voice_health
scribe_window_speakers           read   HTTP 200  meta.tool=scribe_window_speakers

tally: 52 names called, 52 answered HTTP 200 with _meta.tool equal to the name called
```

## 8. Live door at 0f27b8c, tools/list (the commit-2 fixture source)

```
banner version: 0f27b8c
tools/list: HTTP 200, 52 tools; sha256 666255f82147975bb0aa3de2ec816be29a22a3781b993eef3794782052b6b145
names added since 6b2347e: scribe_window_speakers; names removed: none
compared with the registry at fee5822: 52 code, 52 live, 0 differences in description, schema or scope
```
