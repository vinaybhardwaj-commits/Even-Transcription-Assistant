"""Plainly fictional names for synthetic speakers, plus a real-name denylist.

Invented names are built from whimsical syllables so that no output can read
as a real person. DENYLIST holds common real clinician-style given names and
surnames; tests assert no generated text or roster name hits it.
"""

FIRST_A = ["Quor", "Zeph", "Brix", "Thal", "Vorn", "Glim", "Orb", "Plum", "Wix", "Yarr", "Fizz", "Nim"]
FIRST_B = ["ilda", "ovan", "arex", "iquo", "umbra", "ette", "azoo", "ingle", "oriel", "ux"]
SUR_A = ["Thistle", "Fenn", "Gromble", "Quill", "Wobble", "Bramble", "Snorkel", "Tumble", "Pickle", "Marzipan",
         "Kettle", "Moss", "Zinc", "Clover", "Puddle", "Velvet"]
SUR_B = ["whisk", "quark", "thorn", "brook", "bottom", "wick", "gale", "nook", "fiddle", "sprocket", "mire", "plinth"]

DENYLIST = sorted({
    # surnames common among clinicians in India and elsewhere
    "sharma", "verma", "gupta", "patel", "shah", "rao", "reddy", "nair", "menon", "iyer", "iyengar",
    "kumar", "singh", "bose", "mukherjee", "banerjee", "chatterjee", "joshi", "kulkarni", "desai",
    "mehta", "agarwal", "aggarwal", "khan", "ahmed", "hegde", "shetty", "gowda", "naidu", "pillai",
    "krishnan", "srinivasan", "bhat", "kamath", "prabhu", "murthy", "prasad", "mishra", "pandey",
    "tiwari", "yadav", "chauhan", "malhotra", "kapoor", "khanna", "arora", "bhardwaj", "chopra",
    "saxena", "sinha", "jain", "thomas", "george", "fernandes", "dsouza", "smith", "jones", "brown",
    "williams", "taylor", "johnson", "wilson", "patil", "naik", "acharya", "subramanian", "venkatesh",
    # given names
    "vinay", "priya", "anil", "sunil", "rahul", "amit", "neha", "pooja", "suresh", "ramesh",
    "lakshmi", "anjali", "deepa", "kavitha", "arjun", "rohit", "sanjay", "vijay", "meera", "divya",
    "ananya", "aditya", "karthik", "manoj", "rajesh", "sneha", "swati", "nisha", "kiran", "ashok",
    "john", "david", "michael", "sarah", "mary", "james", "robert", "jennifer", "elizabeth", "emma",
})


def make_name(rng, used):
    """Return a fresh invented 'First Surname' not in `used` (mutated)."""
    for _ in range(10000):
        first = rng.choice(FIRST_A) + rng.choice(FIRST_B)
        sur = rng.choice(SUR_A) + rng.choice(SUR_B)
        name = f"{first} {sur}"
        if name not in used and not any(t.lower() in DENYLIST for t in name.split()):
            used.add(name)
            return name
    raise RuntimeError("name space exhausted")
