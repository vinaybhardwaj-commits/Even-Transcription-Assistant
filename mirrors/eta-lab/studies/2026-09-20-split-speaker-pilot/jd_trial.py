#!/usr/bin/env python3
"""J-D -- clinician self-identification prompt trial, through the even-jev MCP server itself
(order: ~/dev/_fable/orders/JEV-JC-JD-TRIALS.md).

Same isolation as ja_trial.py: state is built and piped straight into ~/dev/even-jev-mcp/run.sh over
JSON-RPC, the jev-decisions skill's pattern. Transcript text -- and the candidate clinicians' names,
which the task needs Jev to read against the transcript -- never enter the agent's context, any log,
the report or the ledger; only window ids, a same-day-stable anonymous letter per clinician, agreement
counts, usage and latency come out. V has cleared transcript text to the vendor (ETA-JEV-PROGRAMME's
own header); clinician names are the same category of data this trial exists to test recognition of.

GROUND TRUTH, AS FOUND (not as assumed going in):
  - room_day.doctor_id is NULL on all 136 room_day rows -- unusable.
  - visit.clinician_id is set on 2 of 28 visit rows -- unusable at this scale.
  - bench_session.label exists on 15 of 422 sessions, 14 distinct values -- too sparse for a real
    "session label" ground truth.
  - room_turn_speaker (the E-3 voice match) is the one real signal: window_id, clinician_id, role,
    match_confidence. Coverage POST-CUT (>=22 Sep 15:32 IST) is 1 window, 1 clinician, one room_day --
    unusable. This trial therefore uses PRE-cut room_days (the three already vetted for E-4:
    rd_djmbtzph, rd_7g2ytyta; rd_au3vmzsm has voice-match rows but 0 with a non-null clinician_id,
    dropped) and reports that deviation plainly, per the order's own standard for J-C.
"""
import json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import q

RUN = os.path.expanduser('~/dev/even-jev-mcp/run.sh')
OUT = '/Users/vinaybhardwaj/dev/scratch/jd-trial-results.json'
PROMPT_VERSION = 'jev-selfid-v1'
ROOM_DAYS = ['rd_djmbtzph', 'rd_7g2ytyta']  # from room_turn_speaker's own coverage scan; see header
MAX_WINDOWS_PER_DAY = 20

QUESTIONS = {
    'd1_named': {'type': 'noul',
        'instructions': 'The state holds the machine transcript of one window of room audio from a clinical consultation. Decide whether any speaker in it states their own name or their own professional role (for example, introducing themselves by name, or saying they are the doctor, nurse or attendant seeing the patient).',
        'criteria': {
            'true': 'A speaker says who they themselves are, by name or by role, at some point in the window.',
            'false': 'Nobody in the window states their own name or role. Referring to someone ELSE by name or role does not count.'}},
    'd2_which': {'type': 'choice',
        'instructions': 'The state holds the transcript of a room window and a list of clinicians who are the CANDIDATES for who is in that room. If a clinician in the transcript states their own name or role, say which candidate it is. If no self-identification is present, or the person self-identifying is not one of the candidates, say so.',
        'criteria': None,  # filled per-window: one entry per candidate letter, plus not_self_identified / other_not_listed
    },
}

def frames(state, questions):
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "jd-trial", "version": "1"}}}
    ready = {"jsonrpc": "2.0", "method": "notifications/initialized"}
    call = {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": "jev_ask", "arguments": {"state": state, "questions": questions}}}
    return "\n".join(json.dumps(x) for x in (init, ready, call)) + "\n"

def ask(state, questions):
    t0 = time.time()
    p = subprocess.run([RUN], input=frames(state, questions), capture_output=True, text=True, timeout=180)
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

# ---- candidates per room_day: the distinct clinicians the E-3 matcher saw there, letter-coded ----
cand_rows = q.q("""
  select room_day_id, clinician_id, full_name, count(*) n
    from room_turn_speaker rts join clinician c on c.id = rts.clinician_id
   where rts.room_day_id = any($1) and rts.clinician_id is not null and coalesce(rts.role,'') <> 'patient'
   group by room_day_id, clinician_id, full_name order by room_day_id, n desc
""", [ROOM_DAYS])['rows']
by_day = {}
for r in cand_rows:
    by_day.setdefault(r['room_day_id'], []).append(r)
letters = 'ABCDEFGH'
candidates = {}       # room_day_id -> [{'letter','clinician_id','full_name'}]
name_to_letter = {}   # (room_day_id, clinician_id) -> letter
for rd, rows in by_day.items():
    seen = {}
    for r in rows:
        cid = r['clinician_id']
        if cid not in seen: seen[cid] = r['full_name']
    candidates[rd] = [{'letter': letters[i], 'clinician_id': cid, 'full_name': nm} for i, (cid, nm) in enumerate(seen.items())]
    for c in candidates[rd]: name_to_letter[(rd, c['clinician_id'])] = c['letter']

# ---- windows: English (or source) transcript, plus the E-3-matched clinician (highest overlap_ms) ----
win_rows = q.q("""
  select w.id window_id, w.room_day_id, coalesce(nullif(t.transcript_english,''), t.transcript_original) txt
    from bench_window w join transcription_run t on t.subject_type='bench_window' and t.subject_id=w.id
   where w.room_day_id = any($1) and coalesce(nullif(t.transcript_english,''), t.transcript_original, '') <> ''
   order by w.id
""", [ROOM_DAYS])['rows']

match_rows = q.q("""
  select window_id, clinician_id, sum(overlap_ms) tot
    from room_turn_speaker where room_day_id = any($1) and clinician_id is not null and coalesce(role,'') <> 'patient'
   group by window_id, clinician_id
""", [ROOM_DAYS])['rows']
best_match = {}  # window_id -> clinician_id (highest total overlap)
by_window = {}
for r in match_rows:
    by_window.setdefault(r['window_id'], []).append(r)
for wid, rows in by_window.items():
    best_match[wid] = max(rows, key=lambda r: r['tot'])['clinician_id']

# even split across the two room_days, capped
per_day = {}
for r in win_rows:
    per_day.setdefault(r['room_day_id'], []).append(r)
selected = []
for rd, rows in per_day.items():
    selected.extend(rows[:MAX_WINDOWS_PER_DAY])

out = []
for i, r in enumerate(selected, 1):
    rd, wid, txt = r['room_day_id'], r['window_id'], r['txt']
    cands = candidates.get(rd, [])
    if not cands:
        continue
    d2_criteria = {c['letter']: f"The speaker who self-identifies is candidate {c['letter']}." for c in cands}
    d2_criteria['not_self_identified'] = "No speaker in the transcript states their own name or role."
    d2_criteria['other_not_listed'] = "A speaker does self-identify, but as someone who is not one of the listed candidates."
    questions = dict(QUESTIONS)
    questions['d2_which'] = {**QUESTIONS['d2_which'], 'criteria': d2_criteria}
    candidate_block = [{'letter': c['letter'], 'name': c['full_name']} for c in cands]
    state = {"window": "W1", "candidates": candidate_block, "transcript": txt}
    ans, ms = ask(state, questions)
    if 'answers' not in ans:
        print("%2d %-30s ERROR %s" % (i, wid, str(ans)[:120])); continue
    a = ans['answers']
    named_p = a['d1_named']['noul']
    which = a['d2_which']['choice']
    which_probs = a['d2_which'].get('probabilities')
    e3_letter = name_to_letter.get((rd, best_match.get(wid)))
    out.append({'window_id': wid, 'room_day_id': rd, 'n_candidates': len(cands),
                'named_p': named_p, 'which': which, 'which_probs': which_probs,
                'e3_letter': e3_letter, 'input_tokens': ans['usage']['input_tokens'], 'latency_ms': ms})
    print("%2d %-30s named=%.2f which=%-18s e3=%s" % (i, wid, named_p, which, e3_letter or '-'), flush=True)

fd = os.open(OUT, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump({'prompt_version': PROMPT_VERSION, 'room_days': ROOM_DAYS,
               'n_candidates_by_day': {rd: len(candidates.get(rd, [])) for rd in ROOM_DAYS},
               'rows': out}, f, indent=1)

n = len(out)
named = [r for r in out if r['named_p'] > 0.5]
yes_which = [r for r in named if r['which'] not in ('not_self_identified',)]
correct_vs_e3 = [r for r in yes_which if r['e3_letter'] is not None and r['which'] == r['e3_letter']]
comparable_vs_e3 = [r for r in yes_which if r['e3_letter'] is not None]
tok = sum(r['input_tokens'] for r in out)
print("\nwindows scored %d | self-identified (named_p>0.5) %d (%.0f%%) | of those, named a specific candidate %d"
      % (n, len(named), 100.0 * len(named) / n if n else 0, len(yes_which)))
print("precision vs E-3 voice match, where both exist: %d/%d = %.0f%%"
      % (len(correct_vs_e3), len(comparable_vs_e3), 100.0 * len(correct_vs_e3) / len(comparable_vs_e3) if comparable_vs_e3 else 0))
print("input tokens %d | cost $%.5f | median latency %d ms"
      % (tok, tok * 42e-9, sorted(r['latency_ms'] for r in out)[n // 2] if n else 0))
