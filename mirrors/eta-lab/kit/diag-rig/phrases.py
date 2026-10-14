"""DIAG-RIG canonical phrase set. INVENTED clinic-style lines only: no patient text, names or transcripts (S1 ruling a).
Sha-pinned: PHRASESET_SHA is the sha256 of the canonical JSON below; the generator writes it into every manifest.
The Kanglish (code-mixed Kannada/English) list needs V's one-time approval before the first nightly run (KANGLISH_APPROVED)."""
import hashlib
import json

CANARY = "supercalifragilisticexpialidocious"
KANGLISH_APPROVED = True    # V approved code-mixed speech (Fable 26 Sep 21:45); gate kept in generate.build_suite. Was: V flips this (the flag is NOT part of PHRASESET_SHA; the phrase list is) once he has read the list

PHRASES = {
    "en": [
        "Please take one tablet twice a day after food for five days.",
        "The blood pressure is one hundred and thirty over eighty.",
        "We will repeat the scan after two weeks and review the report.",
        "Metformin five hundred milligrams, one tablet at night.",
        "Do you have any pain when you walk or climb stairs?",
        "Come back on Monday morning for the dressing change.",
    ],
    "hi": [
        "यह दवा दिन में दो बार खाने के बाद लीजिए।",
        "आपका ब्लड प्रेशर एक सौ तीस बटा अस्सी है।",
        "दो हफ्ते बाद दोबारा स्कैन करवाइए।",
        "क्या चलने या सीढ़ियां चढ़ने में दर्द होता है?",
        "सोमवार सुबह पट्टी बदलवाने के लिए आइए।",
    ],
    "kn": [
        "ಈ ಮಾತ್ರೆಯನ್ನು ದಿನಕ್ಕೆ ಎರಡು ಬಾರಿ ಊಟದ ನಂತರ ತೆಗೆದುಕೊಳ್ಳಿ.",
        "ನಿಮ್ಮ ರಕ್ತದೊತ್ತಡ ನೂರ ಮೂವತ್ತು ಬೈ ಎಂಬತ್ತು ಇದೆ.",
        "ಎರಡು ವಾರಗಳ ನಂತರ ಮತ್ತೆ ಸ್ಕ್ಯಾನ್ ಮಾಡಿಸಿ.",
        "ನಡೆಯುವಾಗ ಅಥವಾ ಮೆಟ್ಟಿಲು ಹತ್ತುವಾಗ ನೋವಾಗುತ್ತದೆಯೇ?",
        "ಸೋಮವಾರ ಬೆಳಿಗ್ಗೆ ಬ್ಯಾಂಡೇಜ್ ಬದಲಾಯಿಸಲು ಬನ್ನಿ.",
    ],
    "te": [
        "ఈ మాత్రను రోజుకు రెండు సార్లు భోజనం తర్వాత వేసుకోండి.",
        "మీ రక్తపోటు నూట ముప్పై బై ఎనభై ఉంది.",
        "రెండు వారాల తర్వాత మళ్ళీ స్కాన్ చేయించుకోండి.",
        "నడిచేటప్పుడు లేదా మెట్లు ఎక్కేటప్పుడు నొప్పి వస్తుందా?",
        "సోమవారం ఉదయం కట్టు మార్చడానికి రండి.",
    ],
    "ta": [
        "இந்த மாத்திரையை தினமும் இரண்டு முறை உணவுக்குப் பிறகு சாப்பிடுங்கள்.",
        "உங்கள் இரத்த அழுத்தம் நூற்று முப்பது பை எண்பது இருக்கிறது.",
        "இரண்டு வாரங்களுக்குப் பிறகு மீண்டும் ஸ்கேன் எடுங்கள்.",
        "நடக்கும்போது அல்லது படிகளில் ஏறும்போது வலி இருக்கிறதா?",
        "திங்கள் காலை கட்டு மாற்ற வாருங்கள்.",
    ],
    # code-mixed: Hinglish = Hindi frame + English clinical words; Kanglish = Kannada frame + English clinical words
    "hi-en": [
        "आप ये tablet दिन में two times after food लीजिए।",
        "आपका BP one thirty by eighty है, sugar भी check करेंगे।",
        "Next week दोबारा X-ray करवाइए, फिर report दिखाइए।",
    ],
    "kn-en": [
        "ಈ tablet ಅನ್ನು ದಿನಕ್ಕೆ two times after food ತೆಗೆದುಕೊಳ್ಳಿ.",
        "ನಿಮ್ಮ BP one thirty by eighty ಇದೆ, sugar ಕೂಡ check ಮಾಡ್ತೀವಿ.",
        "Next week ಮತ್ತೆ X-ray ಮಾಡಿಸಿ, ಆಮೇಲೆ report ತೋರಿಸಿ.",
    ],
}

# scripted multi-speaker dialogues: (speaker, lang, phrase index into PHRASES[lang]); speakers are stable ids
DIALOGUES = {
    "dlg_en_2": [("S1", "en", 4), ("S2", "en", 3), ("S1", "en", 0), ("S2", "en", 5), ("S1", "en", 2)],
    "dlg_en_3": [("S1", "en", 4), ("S2", "en", 1), ("S3", "en", 3), ("S1", "en", 0), ("S3", "en", 5), ("S2", "en", 2)],
    "dlg_hi_2": [("S1", "hi", 3), ("S2", "hi", 4), ("S1", "hi", 0), ("S2", "hi", 1)],
    "dlg_kn_2": [("S1", "kn", 3), ("S2", "kn", 4), ("S1", "kn", 0), ("S2", "kn", 1)],
    "dlg_te_2": [("S1", "te", 3), ("S2", "te", 4), ("S1", "te", 0), ("S2", "te", 1)],
    "dlg_ta_2": [("S1", "ta", 3), ("S2", "ta", 4), ("S1", "ta", 0), ("S2", "ta", 1)],
    "dlg_hien_2": [("S1", "hi-en", 0), ("S2", "hi-en", 1), ("S1", "hi-en", 2)],
    "dlg_knen_2": [("S1", "kn-en", 0), ("S2", "kn-en", 1), ("S1", "kn-en", 2)],
}
# dialogue turns are placed (start, end) from the assembled timeline; the canary is its own stimulus (S1 rule b).


def canonical():
    return json.dumps({"canary": CANARY, "phrases": PHRASES, "dialogues": DIALOGUES}, sort_keys=True, ensure_ascii=False)


PHRASESET_SHA = hashlib.sha256(canonical().encode("utf-8")).hexdigest()


def phrase(lang, idx):
    return PHRASES[lang][idx]


def total_chars(langs=None):
    """Characters one full synthesis of the dialogues + canary costs (each clip synthesised once, then cached)."""
    seen = set()
    n = len(CANARY)
    for turns in DIALOGUES.values():
        for _spk, lang, i in turns:
            if (lang, i) not in seen:
                seen.add((lang, i))
                n += len(PHRASES[lang][i])
    return n
