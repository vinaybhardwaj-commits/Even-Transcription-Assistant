# W-OBS v1: log production Whisper failures (pre-registration, lid-debug designer, 7 Oct 2026; herdr-lead CLARITY-6 item 4)
Status: DRAFT r2 for eta-refuter-2 (r2: refuter-2 #9083 B1 second call site; router-fix #9085 denominator; refuter-2 N1 post = code fault; router-fix forced-failure windows in the gate set). Builder router-fix. Nothing built. Deploy is a separate production act (§5).

## 0. Why
process_segment calls Whisper inside try/except with a bare `pass` (router_server.py a876b3bd l.1358-1367): a failed or timed-out call is
invisible; the segment silently routes Indic-only. The 27 Sep replay had 229/777 segments (29%) in that state (#9065/#9068); production's
rate cannot be read from any log (#9069/#9072). v1 makes each such failure visible as ONE stderr line, and adds an offline counter.

## 1. The change (router_server.py, base = production a876b3bd; logging only, routing and output untouched)
 TWO silent Whisper call sites are covered (refuter-2 #9083 B1): site "first" = process_segment's first call (l.1358-1367); site "en" =
 english_segment's forced-English re-call whisper_infer(seg_wav, language="en") (l.1406-1413), which runs for every English-kept segment
 whose first answer carries no language (all 192 R-EN-traced segments) and on failure silently keeps the first-call text. C1-C3 apply
 to both try blocks identically; the stage values are infer/post at both sites.
 C1 Before the try (inside the existing `if "en" in candidates:`), record t0 = time.monotonic().
 C2 Do NOT restructure the try. Add a local `stage` set to "infer" before whisper_infer and to "post" after it returns (the same try also
    wraps whisper_text / looks_real_english). Every existing statement, its order and the try's extent stay exactly as in a876b3bd, so on
    ANY exception the variables hold exactly what they hold today at that point (a "post" failure can leave w_text / w_lang / repaired
    already assigned, as today; eng_real then stays False) and routing continues as today.
 C3 In the except branch, write ONE line to stderr:
      [eta-router] whisper_failed ts=<UTC ISO-8601, seconds> site=<first|en> stage=<infer|post> exc=<ExceptionClassName> ms=<int elapsed since t0>
    No text, no audio path, no job/segment id, no exception message (the message could carry a URL or path). The existing stderr lines
    carry no timestamp, so ts is in the line itself (needed for per-hour counts).
 C4 Nothing else: no segment key, no reply key (CLARITY-6 item 4), so every reply and job file is byte-identical to production.

## 2. Counter script (offline, read-only; tools/whisper_fail_count.py)
Reads router.err (path given on the command line), selects lines matching the C3 pattern exactly, and prints per UTC hour (and per IST
clinic hour) the counts by stage and exception class, plus totals. Counts only; it never prints any other log line.
Counts are reported per site, and stage=post SEPARATELY from stage=infer: a post failure (whisper_text / looks_real_english raising) is
a router code fault, not a Whisper failure (refuter-2 #9083 N1); the rate below uses stage=infer only. DENOMINATOR (r2, R-WF #9082/#9085): the Mini whisper-shim err log has one timestamped line per COMPLETED
request ("POST /inference ... <status>"); the script optionally reads it (path on the command line) and reports, per hour,
failures / (failures + shim POST /inference count). Declared limits, printed in the script's header: (1) the shim counts requests it
finished, so a call the router abandoned on its own timeout is in BOTH numerator and denominator (rate slightly understated); (2) a call
that never reached the shim is only in the numerator; (3) the unit is Whisper CALLS (first + en re-call), not segments. (4) the shim also serves probes and bulk jobs (e.g. a
~2/h periodic caller and the 5 Oct 04-07h burst, refuter-2 #9088), which dilute the denominator; the script reports the rate per hour
beside the raw counts and flags hours with 0 router failures and > 0 shim requests as uninformative, not as 0%. Approximate;
no gate depends on it.

## 3. Gates
 G1 IDENTITY on the shared-engine harness (P = a876b3bd, W = W-OBS, ONE process, run_s2 wrap pattern), extended to cache FAILURES:
    a failed engine call is stored as a sentinel {"error_class": <name>} and the wrapper re-raises an exception of that class for every
    later identical call, so both routers see the same failure (refuter-2 #9073 point 1). Windows: the E1 diag-rig suite (15) + the same
    20 seeded E4 windows as L0 Gate 1. Reply JSON W == P canonically, byte for byte, on all 35; cache sha and entry count in the header.
    The real 35 windows will likely have 0 Whisper failures, so they cannot exercise the failing path (router-fix #9085). G1 therefore
    ALSO runs 4 forced-failure windows (one of the 35 replayed with a sentinel failure at first/en x infer/post) and requires W == P on
    them too; these 4 are part of the gate set, not optional.
 G2 FORCED FAILURE (unit/integration, via the sentinel): with Whisper forced to fail at stage infer (e.g. TimeoutError) and separately
    at stage post, AT EACH SITE (4 cases: first/en x infer/post), W's reply == P's reply for the same forced failure, and stderr contains exactly one C3 line per failed segment with
    the right stage and class and an integer ms, matching the regex; no other new stderr output.
 G3 NO LEAK: a test asserts the C3 line matches ^\[eta-router\] whisper_failed ts=\S+ site=(first|en) stage=(infer|post) exc=[A-Za-z_][A-Za-z0-9_.]* ms=\d+$
    exactly (so no text/path/message can appear).
 G4 COUNTER: on a synthetic router.err (C3 lines mixed with the other existing [eta-router] lines and junk), the script's per-hour
    counts equal a hand-built expectation; it prints no non-C3 line.
 G5 DIFF SCOPE: git diff a876b3bd..W touches only the two try/except blocks (l.1358-1367 and l.1406-1413; + an import if needed) and adds the script and
    tests; eta-refuter-2 reads the diff.

## 4. Review
eta-refuter-2 witnesses G1-G5 (reruns the tests and the identity run on a copy of the cache; a mutant that drops the stderr write at EITHER
site must fail G2, one that prints the exception message must fail G3).

## 5. Deploy (not part of this PASS; CLARITY-6 item 4)
A production router change on the Mini: router-fix runbook (exact target, file shas a876b3bd -> W, restart, health check incl. one forced
failure on a non-production port if possible, timed rollback to a876b3bd), eta-refuter-2 RUNBOOK PASS, herdr-lead GO, and a bus notice to
fable BEFORE acting; never 07:30-21:30 IST. After deploy, CLARITY's P becomes the new production sha.
