#!/usr/bin/env python3
"""J-C -- consult-boundary prompt trial, through the even-jev MCP server itself
(order: ~/dev/_fable/orders/JEV-JC-JD-TRIALS.md).

Same isolation as ja_trial.py/jd_trial.py: state piped straight into ~/dev/even-jev-mcp/run.sh over
JSON-RPC. Transcript text never enters the agent's context, any log, the report or the ledger; only
probe indices, phase labels, probabilities, usage and latency come out.

PROBE GRID: reuses E-1's grid AS ALREADY COMPUTED for this room_day by the split-speaker pilot's own
e4_eval.py (~/dev/_fable/scratch/e4-eval/e4-<room_day_id>.json, PROBE_SECONDS=180, HOP_SECONDS=60,
same constants as lib/encounter-clock/probe.ts) rather than regenerating it -- same probes, same
start_ms/end_ms/t as the smoother comparison target below, by construction.

COMPARISON TARGET: the SAME file's smoothed['180000'] (the 3-min merge gap) encounter list. A probe's
"true" phase per the smoother is derived here (first probe overlapping an encounter = start, last =
end, others inside = inside, no encounter = none) -- this is the E-4 SHAPE CHECK's own output, not
labelled ground truth. TRUE accuracy waits on V's ground truth (order Section "Both"; see E-7) -- said
plainly in the report, not papered over by treating the smoother as truth.

TEXT PER PROBE: approximated as the concatenation of every bench_window's transcript (English where
present) whose time range overlaps the probe's [start_ms, end_ms) -- not the driver's exact per-span
placement (splitWindowText), which needs the bundled TS driver and was not worth re-invoking for a
trial. Stated as a deviation.
"""
import json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import q

RUN = os.path.expanduser('~/dev/even-jev-mcp/run.sh')
OUT = '/Users/vinaybhardwaj/dev/scratch/jc-trial-results.json'
PROMPT_VERSION = 'jev-boundary-v1'
ROOM_DAY = 'rd_djmbtzph'
E4_FILE = '/Users/vinaybhardwaj/dev/_fable/scratch/e4-eval/e4-%s.json' % ROOM_DAY
MERGE_GAP = '180000'  # 3-minute merge gap, the middle of the three E-4 already computed
N_ENCOUNTERS_SAMPLED = 6

QUESTIONS = {
    'c1_phase': {'type': 'choice',
        'instructions': 'The state holds three consecutive 3-minute probes of transcript from one room, in order: the previous probe, THIS probe, and the next probe. Decide THIS probe\'s place in a clinical consultation.',
        'criteria': {
            'start': 'THIS probe is where a consultation begins: a new patient is greeted or called in, or the conversation visibly starts addressing a new patient\'s complaint, where the previous probe was not part of the same consultation.',
            'end': 'THIS probe is where a consultation is wrapping up or has just finished: instructions are given, the visit is closed out, or the room falls silent/moves on after this probe.',
            'inside': 'THIS probe is in the middle of an ongoing consultation that was already under way in the previous probe and continues into the next.',
            'none': 'THIS probe shows no consultation taking place at all -- an empty room, staff-only chatter, or nothing clinical happening.'}},
    'c2_established': {'type': 'score',
        'instructions': 'The state holds three consecutive 3-minute probes of transcript from one room, in order: the previous probe, THIS probe, and the next probe. Score how firmly THIS probe sits inside an ALREADY-ESTABLISHED, ongoing consultation, as opposed to a boundary (a consultation starting or ending) or no consultation at all.',
        'criteria': [
            'No consultation is happening in this probe at all.',
            'A consultation is only just starting in this probe, or has just ended -- a boundary, not the middle.',
            'A consultation is under way but this probe still reads close to its start or its end.',
            'This probe is solidly in the middle of a consultation that was already going in the previous probe and keeps going into the next.',
            'This probe is deep inside a long-running consultation with no sign of a boundary anywhere near it.']},
    'c3_boundary': {'type': 'choice',
        'instructions': 'The state holds three consecutive 3-minute probes of transcript from one room, in order: the previous probe, THIS probe, and the next probe. A "consultation" is one patient\'s visit with a clinician. Answer: relative to THIS probe, where is the nearest boundary between one consultation (or no consultation) and a different one?',
        'criteria': {
            'boundary_is_here': 'A consultation visibly begins OR ends somewhere inside THIS probe.',
            'boundary_was_before': 'THIS probe continues what the previous probe was already doing; the last boundary was earlier than this probe.',
            'boundary_is_after': 'THIS probe is still part of what will end or change in the NEXT probe, but nothing changes within this probe itself.',
            'no_boundary_nearby': 'THIS probe and its neighbours all show the same state (all mid-consultation, or all no-consultation) with no boundary in sight.'}},
}

def frames(state):
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "jc-trial", "version": "1"}}}
    ready = {"jsonrpc": "2.0", "method": "notifications/initialized"}
    call = {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": "jev_ask", "arguments": {"state": state, "questions": QUESTIONS}}}
    return "\n".join(json.dumps(x) for x in (init, ready, call)) + "\n"

def ask(state):
    t0 = time.time()
    p = subprocess.run([RUN], input=frames(state), capture_output=True, text=True, timeout=180)
    ms = int((time.time() - t0) * 1000)
    for line in p.stdout.splitlines():
        try: m = json.loads(line)
        except ValueError: continue
        if m.get("id") == 2:
            c = m.get("result", {}).get("content") or []
            for part in c:
                if part.get("type") == "text":
                    return json.loads(part["text"]), ms
            return m.get("result"), ms
    return {"error": (p.stderr or "")[-300:]}, ms

# ---- load the already-computed probe grid + smoother boundaries (no transcript text in this file) ----
e4 = json.load(open(E4_FILE))
probes = sorted(e4['verdicts'], key=lambda v: v['start_ms'])
encounters = sorted(e4['smoothed'][MERGE_GAP], key=lambda e: e['start_ms'])

def overlapping_idx(enc):
    return [i for i, p in enumerate(probes) if p['start_ms'] < enc['end_ms'] and p['end_ms'] > enc['start_ms']]

smoother_phase = ['none'] * len(probes)
for enc in encounters:
    idx = overlapping_idx(enc)
    for j, i in enumerate(idx):
        smoother_phase[i] = 'start' if j == 0 else ('end' if j == len(idx) - 1 else 'inside')
        if len(idx) == 1: smoother_phase[i] = 'start'  # a one-probe encounter: call it a start, not inside

# ---- sample: for N encounters, take their start probe, end probe, one inside probe; plus a 'none' gap probe per encounter ----
selected = []
for enc in encounters[:N_ENCOUNTERS_SAMPLED]:
    idx = overlapping_idx(enc)
    if not idx: continue
    picks = {idx[0]}
    if len(idx) > 1: picks.add(idx[-1])
    if len(idx) > 2: picks.add(idx[len(idx) // 2])
    selected.extend(sorted(picks))
    # a 'none' probe: the one right before this encounter starts, if it truly has no encounter
    before = idx[0] - 2
    if 0 <= before < len(probes) and smoother_phase[before] == 'none':
        selected.append(before)
selected = sorted(set(selected))

# ---- text per probe (approximated placement -- see header) ----
win = q.q("""
  select w.start_ms, w.end_ms, coalesce(nullif(t.transcript_english,''), t.transcript_original) txt
    from bench_window w join transcription_run t on t.subject_type='bench_window' and t.subject_id=w.id
   where w.room_day_id=$1 and coalesce(nullif(t.transcript_english,''), t.transcript_original, '') <> ''
   order by w.start_ms
""", [ROOM_DAY])['rows']

def text_for(p):
    parts = [w['txt'] for w in win if int(w['start_ms']) < p['end_ms'] and int(w['end_ms']) > p['start_ms']]
    return " ".join(parts).strip()

out = []
for n, i in enumerate(selected, 1):
    p = probes[i]
    prev_txt = text_for(probes[i - 1]) if i > 0 else ""
    this_txt = text_for(p)
    next_txt = text_for(probes[i + 1]) if i + 1 < len(probes) else ""
    if not this_txt and not prev_txt and not next_txt:
        continue  # nothing to judge -- not a meaningful trial case
    state = {"probe": "P", "previous_probe_text": prev_txt, "this_probe_text": this_txt, "next_probe_text": next_txt}
    ans, ms = ask(state)
    if 'answers' not in ans:
        print("%2d idx=%-4d smoother=%-8s ERROR %s" % (n, i, smoother_phase[i], str(ans)[:120])); continue
    a = ans['answers']
    c1 = a['c1_phase']['choice']; c1p = a['c1_phase'].get('probabilities')
    c2 = a['c2_established']['score']
    c3 = a['c3_boundary']['choice']
    out.append({'probe_index': i, 'smoother_phase': smoother_phase[i],
                'c1_phase': c1, 'c1_probs': c1p, 'c2_established': c2, 'c3_boundary': c3,
                'input_tokens': ans['usage']['input_tokens'], 'latency_ms': ms})
    print("%2d idx=%-4d smoother=%-8s c1=%-8s c2=%.1f c3=%s" % (n, i, smoother_phase[i], c1, c2, c3), flush=True)

fd = os.open(OUT, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump({'prompt_version': PROMPT_VERSION, 'room_day': ROOM_DAY, 'merge_gap_ms': MERGE_GAP,
               'questions': QUESTIONS, 'rows': out}, f, indent=1)

n = len(out)
# c1 (start/end/inside/none) vs smoother: exact match, and a coarser "is-a-boundary vs is-not" match
exact = sum(1 for r in out if r['c1_phase'] == r['smoother_phase'])
is_boundary = lambda s: s in ('start', 'end')
coarse = sum(1 for r in out if is_boundary(r['c1_phase']) == is_boundary(r['smoother_phase']))
# c3's boundary_is_here should line up with smoother start/end
c3_boundary_agree = sum(1 for r in out if (r['c3_boundary'] == 'boundary_is_here') == is_boundary(r['smoother_phase']))
tok = sum(r['input_tokens'] for r in out)
print("\nprobes scored %d | exact 4-way match vs smoother %d (%.0f%%) | boundary-vs-not match %d (%.0f%%) | c3 boundary agreement %d (%.0f%%)"
      % (n, exact, 100.0 * exact / n if n else 0, coarse, 100.0 * coarse / n if n else 0, c3_boundary_agree, 100.0 * c3_boundary_agree / n if n else 0))
print("input tokens %d | cost $%.5f | median latency %d ms"
      % (tok, tok * 42e-9, sorted(r['latency_ms'] for r in out)[n // 2] if n else 0))
