#!/usr/bin/env python3
"""deid_eval.py — measure deid.py on INVENTED labelled sentences (no real text). Run with the de-id venv:
   ~/eta-data/deid/venv/bin/python deid_eval.py [--no-model]
Reports, per identifier type and per script: how many planted identifiers survive in the output (MISSED), how many roster doctors are wrongly
removed, how many non-roster 'doctors' are removed (by design: the rule errs toward removal), and how many CLEAN sentences get any tag.
"""
import json, os, sys
from collections import defaultdict
import deid

R = json.load(open(deid.DOCTORS))["names"]
D = [n for n in R if len(n.split()) >= 2][:6]
D1, D2, D3 = D[0], D[1], D[2]
first = lambda n: n.split()[0]
last = lambda n: n.split()[-1]

# (script, text, [(planted string, type)], [roster doctor mentions that must survive])
CASES = [
    ("en", "My name is Ramesh Kulkarni and I have had this knee pain for two years.", [("Ramesh Kulkarni", "name")], []),
    ("en", "The patient is Mrs Lakshmi Devi, she is 45 years old and diabetic.", [("Lakshmi Devi", "name")], []),
    ("en", "Please ask Mohammed Irfan, the attender, to wait outside.", [("Mohammed Irfan", "name")], []),
    ("en", "This is his son Vikram Nair speaking, he cannot hear well on the phone.", [("Vikram Nair", "name")], []),
    ("en", "Call me back on +91 98450 12345 once the report is ready.", [("98450 12345", "phone")], []),
    ("en", "My mobile number is 9845012345, please note it down.", [("9845012345", "phone")], []),
    ("en", "You can reach us at 98450-12345 after five.", [("98450-12345", "phone")], []),
    ("en", "The number is nine eight four five zero one two three four five.", [("nine eight four five zero one two three four five", "phone")], []),
    ("en", "Write it down: nine eight four five zero one two three four five, that is my brother's phone.", [("nine eight four five zero one two three four five", "phone")], []),
    ("hi-lat", "Mera number hai nau aath char paanch shunya ek do teen char paanch, isko note kar lijiye.", [("nau aath char paanch shunya ek do teen char paanch", "phone")], []),
    ("kn-lat", "Nanna phone number ombattu entu naalku aidu sonne ondu eradu mooru naalku aidu, bareeri.", [("ombattu entu naalku aidu sonne ondu eradu mooru naalku aidu", "phone")], []),
    ("hi-dev", "मेरा फोन नंबर ९८४५०१२३४५ है, इसे लिख लीजिए।", [("९८४५०१२३४५", "phone")], []),
    ("kn-kan", "ನನ್ನ ಫೋನ್ ನಂಬರ್ ೯೮೪೫೦೧೨೩೪೫ ಬರೆದುಕೊಳ್ಳಿ.", [("೯೮೪೫೦೧೨೩೪೫", "phone")], []),
    ("en", "Her Aadhaar number is 1234 5678 9012 and it is linked to the account.", [("1234 5678 9012", "id")], []),
    ("en", "PAN card number is ABCDE1234F, please enter it in the form.", [("ABCDE1234F", "id")], []),
    ("en", "Her UHID is ABCD-123456, can you pull up the file?", [("ABCD-123456", "id")], []),
    ("en", "The registration number KXHB-98765 is on the card.", [("KXHB-98765", "id")], []),
    ("en", "MRN 4471829 is on the wristband.", [("4471829", "id")], []),
    ("en", "I live at 22, 3rd Cross, Jayanagar, Bangalore 560011 near the temple.", [("22, 3rd Cross, Jayanagar", "address")], []),
    ("en", "He was born on 14/03/1952 in Mysore.", [("14/03/1952", "dob")], []),
    ("en", "Date of birth 03-11-1948, please confirm.", [("03-11-1948", "dob")], []),
    ("en", "Her birthday, 9th November.", [("9th November", "dob")], []),          # partial date of birth (found in LINK3 b3); no year, so the old shapes missed it
    ("en", "His birthday is on 14 March, please note.", [("14 March", "dob")], []),
    ("en", "She was born in October, I think.", [("October", "dob")], []),
    ("en", "Her birthday. 12th March. Hello, what is the date? Please tell me a little more about it, thank you. 12th March. Okay. 12th March.", [("12th March", "dob")], []),  # repeats far from the cue
    ("en", "Date of birth 12 March, and D.O.B. 14 June too.", [("12 March", "dob"), ("14 June", "dob")], []),
    ("en", "She is 93 years old and lives alone.", [("93 years old", "age")], []),
    ("en", "You can mail the report to ramesh.kulkarni@example.com when ready.", [("ramesh.kulkarni@example.com", "email")], []),
    ("en", "yes ramesh kumar is my father and he stays with us.", [("ramesh kumar", "name")], []),
    ("en", "She is aged 94 and lives alone.", [("aged 94", "age")], []),
    ("en", "He is ninety four years old and diabetic.", [("ninety four", "age")], []),
    ("en", "Mail it to ramesh dot kulkarni at gmail dot com when ready.", [("ramesh dot kulkarni at gmail dot com", "email")], []),
    ("hi-lat", "Meri patni ka naam Sunita Sharma hai, unko dard hai.", [("Sunita Sharma", "name")], []),
    ("hi-lat", "Mareez ka naam Anil Kumar Verma hai, umar 92 saal.", [("Anil Kumar Verma", "name"), ("92 saal", "age")], []),
    ("kn-lat", "Ee rogi hesaru Lakshmi Devi, avara phone 98450 12345.", [("Lakshmi Devi", "name"), ("98450 12345", "phone")], []),
    ("kn-lat", "Nanna hesaru Basavaraj Patil, nanage moola vyadhi ide.", [("Basavaraj Patil", "name")], []),
    ("hi-dev", "मरीज का नाम सुनीता शर्मा है।", [("सुनीता शर्मा", "name")], []),
    ("hi-dev", "मेरा नाम रमेश कुलकर्णी है और मुझे घुटने में दर्द है।", [("रमेश कुलकर्णी", "name")], []),
    ("kn-kan", "ನನ್ನ ಹೆಸರು ಬಸವರಾಜ ಪಾಟೀಲ್, ನನಗೆ ಮೊಣಕಾಲು ನೋವು ಇದೆ.", [("ಬಸವರಾಜ ಪಾಟೀಲ್", "name")], []),
    ("en", f"I would like Dr {last(D1)} to review this.", [], [last(D1)]),
    ("en", f"Dr {D1} will see you next, please wait.", [], [D1]),
    ("en", f"Doctor {last(D2)} advised a knee replacement last time.", [], [last(D2)]),
    ("en", f"Ask {D3} about the scan, the patient is Ramesh Kulkarni.", [("Ramesh Kulkarni", "name")], [D3]),
    ("en", f"Dr {first(D1)} said the patient Sunita Rao should come back in a month.", [("Sunita Rao", "name")], [first(D1)]),
    ("en", "Dr Zzyzx Qwertyuiop will operate on Thursday.", [], []),  # non-roster: removed by design (errs toward removal)
    ("en", "The mother, Kavitha Reddy, will give consent for the procedure.", [("Kavitha Reddy", "name")], []),
    ("en", "Patient name Suresh Babu, phone 9988776655, UHID ABCD-654321.", [("Suresh Babu", "name"), ("9988776655", "phone"), ("ABCD-654321", "id")], []),
]
CLEAN = [
    "We will do a knee replacement next month and the cost is about four lakh rupees.",
    "Take one tablet twice a day after food for five days and come back in two weeks.",
    "The scan shows a hernia that has been getting bigger, so I would advise repair.",
    "Her age is 45 and her blood pressure is one twenty over eighty.",
    "Okay doctor, I will think about it and talk to my family.",
    "The operation takes about one hour and you stay in hospital for one night.",
    "मुझे घुटने में दर्द है और सीढ़ियां चढ़ने में तकलीफ होती है।",
    "Nanage moola vyadhi ide, operation madabeku anta doctor helidru.",
    # over-removal patterns seen on the real pilot (fleet audit, 24 Sep); wording invented
    "Yes sir, I will come on Monday.",
    "Are my son and daughter allowed to stay with me?",
    "Who's going to do the surgery?",
    "Vitamin E. should also be continued for a month.",
    "We see many Maharashtrian and Bengali patients here, and some Marathi speakers too.",
    "The surgery is planned for the 11th of August if that suits you.",
    "You can share it to my mail.",
    "Come on 9th November for the surgery, and again on 14 August for the review.",   # dates with no birth cue stay
    "Come and see me with the hearing test and the CT scan.",   # capitalised only as the sentence start; tagged as a person before
]


FIRSTS = ["Ramesh", "Suresh", "Anil", "Sunita", "Lakshmi", "Mohammed", "Vikram", "Kavitha", "Rajesh", "Priya", "Amit", "Deepa", "Sanjay", "Meena", "Arun",
          "Geeta", "Manoj", "Pooja", "Vijay", "Anita", "Rahul", "Sneha", "Kiran", "Asha", "Ravi", "Nisha", "Ajay", "Rekha", "Sunil", "Usha"]
LASTS = ["Kumar", "Sharma", "Reddy", "Nair", "Patil", "Singh", "Rao", "Devi", "Verma", "Gupta", "Iyer", "Shetty", "Joshi", "Kulkarni", "Naik", "Babu",
         "Khan", "Das", "Mehta", "Pillai"]


def roster_checks():
    """Refuter-2 categories on INVENTED patient names, against the real roster (dynamic; no roster name is written into this file)."""
    R = deid.load_roster()
    sig = lambda n: [t for t in n if len(t) >= 2]   # roster names carry initials ("... R S"); doctors are spoken without them
    exact = {(sig(n)[0], sig(n)[-1]) for n in R.names if len(sig(n)) >= 2}
    cexact = {(sig(n)[0], sig(n)[-1]) for n in R.canon_names if len(sig(n)) >= 2}
    coll = merged = 0
    for f in FIRSTS:
        for l in LASTS:
            if R.is_doctor(f"{f} {l}", False):
                if (f.lower(), l.lower()) in exact: coll += 1      # the patient's name IS a roster doctor's name (inherent)
                else: merged += 1                                   # kept only because a spelling was merged (must be 0: canon needs a Dr prefix)
    print(f"roster ({len(R.names)} names), {len(FIRSTS) * len(LASTS)} invented first x surname patients, no honorific: kept as exact roster-name collisions {coll}; kept via spelling merge {merged}")
    drk = sum(1 for f in FIRSTS for l in LASTS if R.is_doctor(f"{f} {l}", True) and (deid.canon(f), deid.canon(l)) not in cexact)
    print(f"  behind 'Dr' (canonical spellings allowed), kept beyond exact-name collisions: {drk}")
    near = tot = 0
    for name in R.names:
        if len(name) >= 2 and len(name[-1]) >= 5:
            sur = name[-1]; mut = sur[:2] + ("x" if sur[2] != "x" else "q") + sur[3:]   # one letter off the doctor's surname
            tot += 1; near += R.is_doctor(f"{name[0]} {mut}", False)
    print(f"one-letter-off patients kept as doctors: {near}/{tot}")
    ext = sum(1 for name in R.names if len(name) >= 2 and R.is_doctor(" ".join(name) + " verma", False))
    print(f"roster name + extra token kept as doctor: {ext}/{len(R.names)}")


def failclosed_checks(d):
    om = deid.Deid(use_model=False)  # default nonlatin="omit"
    r1, _ = om.redact("मेरा नाम सुनीता वर्मा है।"); r2, _ = om.redact("ನನ್ನ ಹೆಸರು ರಮೇಶ್ ಗೌಡ")
    print("default fail-closed on Indic script (both fields must become the marker):", r1 == deid.NONLATIN_MARKER and r2 == deid.NONLATIN_MARKER)
    own = D1.split(); d.own_doctor = deid._norm_tokens(D1)
    keep = f"But {own[-1]}, the scan is fine."
    firstonly = f"Tell {own[0]} that the report is ready."
    out_keep, out_first = d.redact(keep)[0], d.redact(firstonly)[0]
    print("own doctor bare surname kept:", own[-1] in out_keep, "| own doctor bare FIRST name removed:", own[0] not in out_first)
    d.own_doctor = []


def main():
    d = deid.Deid(use_model="--no-model" not in sys.argv, nonlatin="keep")
    miss, tot = defaultdict(int), defaultdict(int)
    miss_s, tot_s = defaultdict(int), defaultdict(int)
    doc_removed, doc_total = 0, 0
    failures = []
    for script, text, plants, docs in CASES:
        out, _ = d.redact(text)
        for s, typ in plants:
            tot[typ] += 1; tot_s[script] += 1
            if s in out:
                miss[typ] += 1; miss_s[script] += 1; failures.append((script, typ, text[:0] + s))
        for name in docs:
            doc_total += 1
            if name not in out:
                doc_removed += 1; failures.append((script, "DOCTOR_REMOVED", name))
    nonroster_removed = "Zzyzx" not in d.redact("Dr Zzyzx Qwertyuiop will operate on Thursday.")[0]
    clean_tagged = sum(1 for t in CLEAN if d.redact(t)[1])
    print("MODEL:", "on" if d.use_model else "OFF (regex only)")
    print("planted identifiers:", sum(tot.values()), "| MISSED:", sum(miss.values()), f"| recall {(1 - sum(miss.values()) / sum(tot.values())):.0%}")
    print("by type:   ", {t: f"{tot[t] - miss[t]}/{tot[t]}" for t in sorted(tot)})
    print("by script: ", {t: f"{tot_s[t] - miss_s[t]}/{tot_s[t]}" for t in sorted(tot_s)})
    print(f"roster doctors kept: {doc_total - doc_removed}/{doc_total} (wrongly removed: {doc_removed}) | non-roster doctor removed (by design): {nonroster_removed}")
    print(f"clean sentences with a tag (false positives): {clean_tagged}/{len(CLEAN)}")
    for f in failures:
        print("  FAIL", f)
    roster_checks()
    failclosed_checks(d)


if __name__ == "__main__":
    main()
