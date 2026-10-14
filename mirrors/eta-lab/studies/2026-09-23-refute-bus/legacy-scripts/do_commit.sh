#!/bin/bash
set -e
WT=/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt
cd "$WT"
git add lib/jobs/kinds/route-transcribe.ts lib/room-day/admin.ts lib/stt/adapters/route.ts lib/stt/room-drain.ts lib/stt/types.ts tests/unit/route-metrics-truth.test.ts tests/unit/vad-starvation-job-path.test.ts
git status --short
git commit -m "$(cat <<'COMMITEOF'
Six VAD-starvation defects: outcome is read from segmentation, never beside it

F1 (route.ts): toSttResult was reading `outcome` off the RAW router reply's
top level via a cast past RouterResult's declared shape -- a key the reply
never carries (router_server.py: outcome lives only inside `segmentation`,
never as its sibling). Every stored route_outcome's `outcome` was therefore
always null, collapsing two of the three outcomes. Fixed the read with a
real type guard (isRouterSegmentation) instead of the cast, and typed
`segmentation`/`outcome` properly on the routerOutcome carrier in types.ts.

F2 (route-transcribe.ts): `silent_window` used `outcome.known` (true
whenever ANY status/count was present) to gate a three-way read that only a
genuine `outcome` value can answer. Combined with F1, this made
`silent_window` always false. Narrowed the gate to require the outcome
value itself; when only a coarser signal is known, it now falls back to the
pre-merge rule (chars === 0) instead of silently reading as "not silent".

F3 (tests): jobReply() and the metrics-truth fixtures put `outcome` beside
`segmentation` -- the inverse of the real body -- making the outcome
assertions self-confirming against the F1 bug. Rewrote every fixture to
nest `outcome` inside `segmentation` (status stays top-level), and added
two regression tests that fail if either the F1 or F2 fix is reverted.

F4 (tests): the "reading it cold" tape test imported assembleTape and
routerOutcome fixtures, then `void`-ed the import and asserted against a
hand-inlined copy of admin.ts's own ternary. Rewired it to call the real
assembleTape with real AssembleTapeInput rows, so the 17 changed lines in
admin.ts are actually exercised.

F5 (admin.ts): windows_total/windows_skipped were read off the stored
outcome and then dropped before reaching the tape. Surfacing partial
starvation is the point of this slice, so both now ride on
window.transcript alongside engines/engines_detail, covered by the F4 test.

F7 (room-drain.ts): the metrics-write gate had grown an `|| asr.routerOutcome`
that is truthy on every successful route reply, so a route run with no real
timeline started writing an empty `language_timeline` block. Reverted to
gating on the timeline itself; the outcome still rides along whenever one
is written.

F6 is left untouched per spec (latent only).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PdUpQZUtoniiquFdLfiVtP
COMMITEOF
)"
git log --oneline -1
git status --short
