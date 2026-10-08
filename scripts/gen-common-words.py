#!/usr/bin/env python3
"""scripts/gen-common-words.py — S8A5-R3: regenerate data/common-english-words.json, the fixed list of the 8,000 most frequent plain English words (lib/drug-match.ts G60).

  pip install wordfreq==3.1.1 && python3 scripts/gen-common-words.py

Keeps lowercase a-z words of 3+ letters in wordfreq's English frequency order, drops common first names, surnames and slang (the list must carry no names), takes the first 8,000.
The committed file is the output of this script; the repository holds no word-frequency data beyond it."""
import json
import re

from wordfreq import top_n_list

NAMES = set("""james john robert michael william david richard joseph thomas charles chris daniel matthew anthony mark donald steven paul andrew joshua kenneth kevin brian george timothy ronald edward
jason jeffrey ryan jacob gary nicholas eric jonathan stephen larry justin scott brandon benjamin samuel gregory frank alexander raymond patrick jack dennis jerry tyler aaron jose adam nathan henry
douglas zachary peter kyle walter ethan jeremy harold keith christian roger noah gerald carl terry sean austin arthur lawrence jesse dylan bryan joe jordan billy bruce albert willie gabriel logan alan
juan wayne roy ralph randy eugene vincent russell elijah louis bobby philip johnny mary patricia jennifer linda elizabeth barbara susan jessica sarah karen nancy lisa betty margaret sandra ashley
kimberly emily donna michelle carol amanda dorothy melissa deborah stephanie rebecca sharon laura cynthia kathleen amy shirley angela helen anna brenda pamela nicole emma samantha katherine
christine debra rachel catherine carolyn janet ruth maria heather diane virginia julie joyce victoria olivia kelly christina lauren joan evelyn judith megan cheryl andrea hannah jacqueline martha
gloria teresa sara madison frances kathryn janice jean abigail alice julia judy sophia grace denise amber doris marilyn danielle beverly isabella theresa diana natalie brittany charlotte marie kayla
alexis lori obama trump biden hillary clinton bush kim kanye taylor swift smith johnson williams brown jones miller davis wilson anderson moore martin jackson thompson white harris clark lewis
robinson walker young allen king wright baker adams nelson hill campbell mitchell roberts carter phillips evans turner torres parker collins edwards stewart morris murphy cook rogers morgan cooper
peterson reed bailey bell howard ward cox richardson wood watson brooks bennett gray hughes price sanders myers long ross foster""".split())
SLANG = set("wtf lol omg lmao rofl fuck fucking shit damn bitch ass porn sex nude fuk crap bullshit asshole dick pussy cock cum anal naked boobs".split())

plain = [w for w in top_n_list("en", 12000) if re.fullmatch(r"[a-z]{3,}", w)]
words = [w for w in plain if w not in NAMES and w not in SLANG][:8000]
doc = {"source": "wordfreq 3.1.1 top English list, lowercase letters only, >= 3 letters, first names / surnames / slang removed", "count": len(words),
       "note": "Plain English words only, no names; used to recognise an ordinary word that must not be proposed as a drug name on a weak cue (lib/drug-match.ts).", "words": words}
with open("data/common-english-words.json", "w") as f:
    json.dump(doc, f, separators=(",", ":"))
print(len(words), "words")
