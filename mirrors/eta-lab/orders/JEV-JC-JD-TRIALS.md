# Jev trials J-D and J-C: encounter classification with Jev (Fable, 23 Sep 09:15)

Owner: scribe3. V's standing direction (21 Sep): use Jev for encounter classification and wherever else
it can help. J-A (hallucination detection) failed - Jev reads text volume as coherence - but that says
nothing about the tasks below, which are about MEANING in real speech, where a text judge should be
strong. Trials only: nothing wired, no flag, the jev-decisions skill's pattern (state piped to
~/dev/even-jev-mcp/run.sh; transcript text never enters your context, files, logs or the ledger).

## J-D first - clinician self-identification (feeds E-3 doctor ID directly)
Question per window: does a clinician state their own name or role, and which clinician from the
supplied candidate list? Candidates from visit/session labels only. Ground truth is cheap and needs no
V labels: agreement with the room's session label and with the E-3 voice match where both exist. Report
precision on the windows where Jev says yes, and how many windows carry a self-identification at all.

## J-C - consult boundaries (the encounter-classification ask)
Per 60 s probe (use E-1's probe grid), with the previous and next probe's text as context: is this
the START of a consultation, the END of one, INSIDE one, or NO consultation? Try at least three wordings
as in J-A (choice and score). Compare against the E-4 smoother's boundaries on the same day and report
where they agree and disagree, in counts. True accuracy waits on V's ground truth (asked; see E-7) -
say that plainly rather than treating the smoother as truth.

## Both
Windows from days with stored transcripts (post-cut preferred, 22 Sep 15:32 IST onward; today's clinic
day once drained). Report cost and latency as J-A did. Write results into
docs/handoff/ETA-JEV-PROGRAMME-22-SEP-2026.md under the J-C and J-D headings (append, dated 23 Sep).
REPORT: at most 8 lines. Stop for Fable.
