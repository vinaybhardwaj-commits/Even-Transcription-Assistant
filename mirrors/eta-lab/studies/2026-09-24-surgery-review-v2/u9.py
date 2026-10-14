"""u9.py — the U9 question set (workstream H) as wording v2.1, plus a raw TypeSafe client that never puts the state in argv or logs.

v2.1 = the v2 wording trialled 24 Sep on synthetic fixtures (studies/2026-09-23-h1-u9-wording/RESULTS-23-SEP.md) with V's FINAL rulings
applied (24 Sep, RULINGS-FABLE-0920 #35/#36): R1 = default (strongly_advised = the clinician pushes: repeats, warns about delay, or says do not
postpone; a single statement of opinion even with a timeframe is advised); R2 = default (a bare negation with no specific procedure is 'no';
discussed_not_recommended needs a NAMED procedure explained, offered as an option, or explicitly decided against).
Wire format = lib/jev/client.ts: POST https://api.typesafe.ai/v1/systemone, Bearer key, {model, state, questions}. Key file ~/.config/even-jev/key.
"""
import json, os, urllib.request

ENDPOINT = "https://api.typesafe.ai/v1/systemone"
PROMPT_VERSION = "u9-v2.2"
# W41 F2: every jev_decision row in production (5672/5672, 23-24 Sep) and the Arm D J4 bench
# (67/67 real rows, jev_window_signal, 22 Sep) came back model="jev-1.13.0" -- pin to what the
# wording (v2.1-v2.3) and the 18-real-label thresholds were actually tuned against, not the
# floating alias. response.model is still read back below and threaded through by callers, so a
# vendor-side change shows up in the data instead of being silently absorbed by the pin.
MODEL = "jev-1.13.0"

QUESTIONS_V21 = {
    "recommended": {"type": "choice", "instructions":
        "Based on this consultation, did the clinician recommend a surgical or interventional procedure to the patient? 'yes' = a specific procedure was proposed as something the patient should have. "
        "'discussed_not_recommended' = a specific NAMED procedure was explained, offered as an option, or explicitly decided against, but not put forward as the recommended course. "
        "'no' = no surgical or interventional procedure was discussed, INCLUDING a bare 'no surgery needed' with no specific procedure named.",
        "criteria": {"yes": "a procedure was recommended to the patient", "discussed_not_recommended": "a named procedure was explained/offered/decided against but not recommended",
                     "no": "no procedure discussed, or only a bare 'no surgery needed'"}},
    "firmness": {"type": "choice", "instructions":
        "How firmly did the clinician put the recommendation of a PROCEDURE (surgery or intervention)? If no procedure was recommended, answer not_applicable. A follow-up visit, review appointment or repeat test is NOT a procedure booking.",
        "criteria": {"suggested": "offered as one option among others, low pressure ('you could consider it')",
                     "advised": "clinician clearly states their professional opinion that the patient should have it, without pressing; saying a date CAN be fixed later is still advised",
                     "strongly_advised": "clinician pushes hard: repeats the point, warns about delay, or says do not postpone",
                     "scheduled": "a specific booking step for the procedure was actually made or committed to in this consult (a date set, OT booked, 'I will book it')",
                     "not_applicable": "no procedure was recommended in this consult"}},
    "patient_response": {"type": "choice", "instructions":
        "How did the patient respond to the recommendation, in this consult? Only meaningful if a procedure was recommended or discussed; otherwise answer not_stated.",
        "criteria": {"agreed": "patient accepted or agreed to proceed", "will_think": "patient asked for time, said they would consider it",
                     "declined": "patient said no or pushed back", "not_stated": "no procedure was recommended/discussed, or the patient's reaction was not captured"}},
    "urgency": {"type": "noul", "instructions":
        "Did the clinician state an urgency or timeframe for doing the PROCEDURE itself (e.g. 'soon', 'within a month', 'next week')? Follow-up visits, review appointments and medication timelines do not count. If no procedure was discussed, answer no."},
    "cost": {"type": "noul", "instructions":
        "Was the cost of the procedure discussed in this consult (an amount, a range, insurance, or an explicit mention that cost was NOT discussed yet)?"},
    "second_opinion": {"type": "noul", "instructions":
        "Did the clinician offer, or the patient ask about, getting a second opinion before proceeding?"},
    "procedure_named": {"type": "noul", "instructions":
        "Is a specific surgical or interventional procedure NAMED in this conversation (for example a particular operation, implant, scope or injection procedure), rather than only surgery being mentioned in general or described vaguely?"},
}


def ask(state, questions=None, timeout=60):
    key = open(os.path.expanduser("~/.config/even-jev/key")).read().strip()
    body = json.dumps({"model": MODEL, "state": state, "questions": questions or QUESTIONS}).encode()
    import time
    for attempt in range(1, 6):  # lib/jev/client.ts retries 429/529 with backoff and never 401/422; same rule here
        req = urllib.request.Request(ENDPOINT, data=body, method="POST", headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 529) and attempt < 5:
                time.sleep(2 ** attempt); continue
            raise SystemExit(f"typesafe http {e.code}")  # body withheld: it can echo the state
        except Exception as e:
            raise SystemExit(f"typesafe error {type(e).__name__}")


def answer_value(a):
    """choice -> (label, confidence); noul -> ('yes'/'no', max(p,1-p))."""
    if a["type"] == "choice":
        return a["choice"], a.get("confidence")
    p = a["noul"]
    return ("yes" if p >= 0.5 else "no"), max(p, 1 - p)


# ---- v2.2: changes made ONLY where V's 18 labels showed a systematic gap (tuned on those 18: re-check on the pilot, do not quote as held-out) ----
import copy
QUESTIONS = copy.deepcopy(QUESTIONS_V21)
QUESTIONS["discussed"] = {"type": "noul", "instructions":
    "Is any surgical or interventional procedure discussed in this conversation at all - a recommended procedure, an option, a past operation, a referral to a surgeon, or staff talking about a case? "
    "Answer no if surgery is not really being discussed (for example unrelated symptoms, or noise)."}
QUESTIONS["context"] = {"type": "choice", "instructions":
    "What kind of surgical discussion is this? Choose the best single fit for the conversation as a whole.",
    "criteria": {"recommendation_now": "the clinician is proposing or advising a procedure for THIS patient now, or discussing it as an option for them",
                 "history": "a past operation this patient already had is being discussed, with no new procedure proposed",
                 "referral": "the patient is being referred to a surgeon or another specialist for an opinion on surgery",
                 "staff_talk": "staff or doctors are talking about a case, a schedule or logistics, not counselling this patient",
                 "no_surgical_talk": "no real surgical discussion; unrelated topics, symptoms only, or noise"}}
QUESTIONS["proposed_by"] = {"type": "choice", "instructions":
    "Who brought up or proposed the procedure? If no procedure is discussed, answer not_applicable.",
    "criteria": {"clinician": "the doctor proposed or raised it", "patient": "the patient or an attender asked about or requested it",
                 "other_staff": "another staff member raised it", "unclear": "cannot tell from the text", "not_applicable": "no procedure is discussed"}}
QUESTIONS["patient_response"]["instructions"] = (
    "How did the patient respond to the recommendation of a procedure, in this consult? 'agreed' ONLY if the patient clearly accepts the procedure or says to go ahead; a bare 'okay', 'yes' or 'hmm' "
    "answering other statements is NOT agreement. If no procedure was recommended or discussed, or the patient's reaction to it is not in the text, answer not_stated.")


# ---- v2.3 (24 Sep, after V's pilot review, studies/2026-09-24-surgery-v2/V-PILOT-SCORE.md) -----------------------------------------------------
# V's rule for what counts as surgery talk (his P04 note): a surgical discussion has a NAMED procedure PLUS a description of what it involves or how it
# will affect the patient. V's finding on P01: Jev said "recommended now, by this doctor" at 0.98-0.99 for what V read as HISTORY, with no proposal made:
# confidence did not flag it. So: (1) discussed / context / proposed_by are re-worded around V's rule and around TENSE; (2) two new checks, `tense`
# (already done vs proposed) and `raised_by` (who brought it up), feed a consistency rule in finalize.py that lowers the confidence of a "now" answer
# the tense check contradicts, so it lands in the <0.90 "check" band. Tuned on V's five labelled pilot consults: re-check on the 20-consult set.
PROMPT_VERSION_V23 = "u9-v2.3"
QUESTIONS_V23 = copy.deepcopy(QUESTIONS)
QUESTIONS_V23["discussed"] = {"type": "noul", "instructions":
    "Is a surgical or interventional procedure actually DISCUSSED in this conversation? Answer yes only if a specific procedure is NAMED and the conversation also describes what it involves or how it "
    "affects the patient (what is done, how it goes, its result, recovery, risks, or what it means for this patient's condition). A bare mention of surgery, a passing reference to a past operation, "
    "or 'no surgery needed' with nothing more is NOT a discussion. Answer no if surgery is not really being discussed (unrelated symptoms, noise, or only a passing word)."}
QUESTIONS_V23["tense"] = {"type": "choice", "instructions":
    "Look at how the procedure is talked about. Is it something ALREADY DONE in the past (words like 'you had', 'was done', 'last time', 'earlier', 'after your operation'), something PROPOSED or PLANNED for the "
    "future (words like 'you need', 'we should do', 'I will book', 'next week'), or unclear? If no procedure is discussed answer not_applicable. Judge by the tense and the meaning, not by how much detail is given: "
    "a past operation discussed at length is still past.",
    "criteria": {"past_done": "the procedure was already carried out in the past and is being discussed as history",
                 "proposed_or_planned": "the procedure is being proposed, advised or planned for this patient as a future step",
                 "unclear": "cannot tell whether it is past or planned",
                 "not_applicable": "no procedure is discussed"}}
QUESTIONS_V23["raised_by"] = {"type": "choice", "instructions":
    "Who first BROUGHT UP the procedure in this conversation (as a topic), regardless of whether anyone proposes it? If no procedure is discussed answer not_applicable.",
    "criteria": {"this_doctor": "the doctor raised it", "patient_or_attender": "the patient or an attender raised it (for example describing their own past operation or asking about one)",
                 "another_person": "another staff member or doctor raised it", "unclear": "cannot tell who raised it", "not_applicable": "no procedure is discussed"}}
QUESTIONS_V23["context"] = {"type": "choice", "instructions":
    "What kind of surgical talk is this? Choose the best single fit for the conversation as a whole. 'recommendation_now' needs a procedure that is being PROPOSED or ADVISED for THIS patient as a future step "
    "(present or future tense). A procedure the patient already had, however much or little is said about it, is 'history'. This question is about the KIND of talk, not about how detailed it is: a passing mention "
    "of a past operation is still 'history'; 'no_surgical_talk' is only for a conversation in which no procedure is mentioned at all.",
    "criteria": {"recommendation_now": "a procedure is being proposed or advised for THIS patient as a future step",
                 "history": "a procedure or operation the patient ALREADY HAD (past tense) is mentioned or discussed, and no new procedure is proposed",
                 "referral": "the patient is being referred to a surgeon or another specialist for an opinion on surgery",
                 "staff_talk": "staff or doctors are talking about a case, a schedule or logistics, not counselling this patient",
                 "no_surgical_talk": "no surgical or interventional procedure is mentioned at all"}}
QUESTIONS_V23["proposed_by"] = {"type": "choice", "instructions":
    "Who PROPOSED the procedure as a plan for this patient (advised, suggested or arranged doing it)? Answer this_doctor only if the doctor puts forward a procedure to be done. If the procedure is only discussed as "
    "something already done in the past, or nobody proposes it, answer unclear. If no procedure is discussed answer not_applicable.",
    "criteria": {"clinician": "the doctor proposed a procedure to be done for this patient", "patient": "the patient or an attender asked for or proposed it",
                 "other_staff": "another staff member proposed it", "unclear": "no one proposes it, it is only history, or it cannot be told",
                 "not_applicable": "no procedure is discussed"}}
