/**
 * scripts/jev-med-bench/formulary.ts — vocabulary for the medication-note bench (W27.7b / W30.3).
 *
 * VOCABULARY ONLY. Drug names, generics, strengths and forms are public product facts, not patient
 * data. The first block is the drugs seen in CAP-1's scored_items (sha 54dca57d, 26 distinct drug
 * terms) mapped to their generics; the rest pads the list to ~70 so the by-drug dev/test split has
 * enough distinct drugs. No consult text, no patient or doctor identity appears anywhere here.
 *
 * `lasa`: a look-alike / sound-alike partner (by generic key) used by the drug-swap perturbation.
 * `cls`: therapeutic class, used for the same-class drug swap.
 */
export type Drug = {
  key: string; // generic, lower-case, unique
  generic: string; // as a clinician would say it
  brands: string[]; // first is the primary brand
  form: "Tab" | "Cap" | "Syp" | "Inj" | "Cream" | "Gel" | "Powder";
  strengths: string[]; // "40 mg" etc.
  cls: string;
  lasa?: string; // key of a look-alike/sound-alike partner
  fromCap1?: boolean;
};

const d = (key: string, generic: string, brands: string[], form: Drug["form"], strengths: string[], cls: string, lasa?: string, fromCap1 = false): Drug =>
  ({ key, generic, brands, form, strengths, cls, lasa, fromCap1 });

export const FORMULARY: Drug[] = [
  // ---- seen in CAP-1 (brand -> generic) ----
  d("paracetamol", "paracetamol", ["Acton", "Dolo"], "Tab", ["500 mg", "650 mg", "1000 mg"], "analgesic"),
  d("diclofenac", "diclofenac", ["Powergesic Plus"], "Gel", ["1%", "2%"], "nsaid", "diclomol"),
  d("cholecalciferol", "cholecalciferol", ["D Rise", "D Chole"], "Cap", ["60000 IU", "1000 IU"], "vitamin"),
  d("pantoprazole", "pantoprazole", ["Pan"], "Tab", ["20 mg", "40 mg"], "ppi", "esomeprazole", true),
  d("ibuprofen", "ibuprofen", ["Brufen"], "Tab", ["200 mg", "400 mg", "600 mg"], "nsaid", "ibuprofen-para", true),
  d("ibuprofen-para", "ibuprofen plus paracetamol", ["Combiflam"], "Tab", ["400 mg/325 mg"], "nsaid", "ibuprofen", true),
  d("folic-acid", "folic acid", ["Folvite"], "Tab", ["5 mg"], "vitamin", "folinic-acid", true),
  d("telmisartan-hctz", "telmisartan plus hydrochlorothiazide", ["Telma H"], "Tab", ["40 mg/12.5 mg", "80 mg/12.5 mg"], "antihypertensive", "telmisartan", true),
  d("esomeprazole", "esomeprazole", ["Nexpro"], "Tab", ["20 mg", "40 mg"], "ppi", "pantoprazole", true),
  d("etoricoxib-thiocolchicoside", "etoricoxib plus thiocolchicoside", ["Nucoxia MR"], "Tab", ["60 mg/4 mg"], "nsaid", undefined, true),
  d("serratiopeptidase", "serratiopeptidase plus diclofenac", ["Chymoral Forte DS"], "Tab", ["100 mg/50 mg"], "nsaid", undefined, true),
  d("piperacillin-tazobactam", "piperacillin plus tazobactam", ["Tazact"], "Inj", ["4.5 g"], "antibiotic", undefined, true),
  d("povidone-iodine", "povidone iodine", ["Betadine"], "Syp", ["2%"], "antiseptic", undefined, true),
  d("mefenamic-dicyclomine", "mefenamic acid plus dicyclomine", ["Mef Spas"], "Tab", ["250 mg/10 mg"], "antispasmodic", undefined, true),
  d("metoprolol-succ", "metoprolol succinate", ["Starpress XL"], "Tab", ["25 mg", "50 mg"], "beta blocker", "metformin", true),
  d("fusidic-acid", "fusidic acid", ["Fudic"], "Cream", ["2%"], "topical antibiotic", undefined, true),
  d("isabgol", "ispaghula husk", ["Softovac SF"], "Powder", ["100 g"], "laxative", undefined, true),
  d("calcium-d3", "calcium plus vitamin D3", ["Shelcal XT"], "Tab", ["500 mg/250 IU"], "supplement", undefined, true),
  d("coq10-mag", "magnesium plus coenzyme Q10 plus riboflavin", ["Magrium"], "Tab", ["150 mg/30 mg"], "supplement", undefined, true),
  d("semaglutide", "semaglutide", ["Obeda Pro"], "Inj", ["0.25 mg", "0.5 mg"], "antidiabetic", undefined, true),
  d("azithromycin", "azithromycin", ["Azee"], "Tab", ["250 mg", "500 mg"], "antibiotic", "azathioprine"),
  // ---- padding, common OPD drugs ----
  d("amoxicillin-clav", "amoxicillin plus clavulanic acid", ["Augmentin", "Clavam"], "Tab", ["375 mg", "625 mg"], "antibiotic", "amoxicillin"),
  d("amoxicillin", "amoxicillin", ["Novamox", "Mox"], "Cap", ["250 mg", "500 mg"], "antibiotic", "amoxicillin-clav"),
  d("cefixime", "cefixime", ["Taxim-O", "Zifi"], "Tab", ["100 mg", "200 mg"], "antibiotic", "cefuroxime"),
  d("cefuroxime", "cefuroxime", ["Zocef", "Ceftum"], "Tab", ["250 mg", "500 mg"], "antibiotic", "cefixime"),
  d("ciprofloxacin", "ciprofloxacin", ["Ciplox", "Cifran"], "Tab", ["250 mg", "500 mg"], "antibiotic", "clarithromycin"),
  d("levofloxacin", "levofloxacin", ["Levoflox", "Tavanic"], "Tab", ["250 mg", "500 mg", "750 mg"], "antibiotic"),
  d("doxycycline", "doxycycline", ["Doxy 1", "Microdox"], "Cap", ["100 mg"], "antibiotic"),
  d("metronidazole", "metronidazole", ["Flagyl", "Metrogyl"], "Tab", ["200 mg", "400 mg"], "antibiotic", "metformin"),
  d("metformin", "metformin", ["Glycomet", "Glyciphage"], "Tab", ["500 mg", "850 mg", "1000 mg"], "antidiabetic", "metronidazole"),
  d("glimepiride", "glimepiride", ["Amaryl", "Glimestar"], "Tab", ["1 mg", "2 mg", "3 mg"], "antidiabetic", "glipizide"),
  d("glipizide", "glipizide", ["Glynase", "Minidiab"], "Tab", ["2.5 mg", "5 mg"], "antidiabetic", "glimepiride"),
  d("sitagliptin", "sitagliptin", ["Januvia", "Istavel"], "Tab", ["50 mg", "100 mg"], "antidiabetic", "saxagliptin"),
  d("atorvastatin", "atorvastatin", ["Atorva", "Lipitor"], "Tab", ["10 mg", "20 mg", "40 mg"], "statin", "rosuvastatin"),
  d("rosuvastatin", "rosuvastatin", ["Rosuvas", "Crestor"], "Tab", ["5 mg", "10 mg", "20 mg"], "statin", "atorvastatin"),
  d("amlodipine", "amlodipine", ["Amlong", "Norvasc"], "Tab", ["2.5 mg", "5 mg", "10 mg"], "antihypertensive", "amiodarone"),
  d("telmisartan", "telmisartan", ["Telma", "Micardis"], "Tab", ["20 mg", "40 mg", "80 mg"], "antihypertensive", "telmisartan-hctz"),
  d("losartan", "losartan", ["Losar", "Cozaar"], "Tab", ["25 mg", "50 mg"], "antihypertensive", "valsartan"),
  d("valsartan", "valsartan", ["Diovan", "Valzaar"], "Tab", ["40 mg", "80 mg", "160 mg"], "antihypertensive", "losartan"),
  d("atenolol", "atenolol", ["Aten", "Tenormin"], "Tab", ["25 mg", "50 mg", "100 mg"], "beta blocker", "atorvastatin"),
  d("metoprolol", "metoprolol tartrate", ["Metolar", "Lopressor"], "Tab", ["25 mg", "50 mg"], "beta blocker", "metformin"),
  d("furosemide", "furosemide", ["Lasix", "Frusemide"], "Tab", ["20 mg", "40 mg"], "diuretic", "torsemide"),
  d("torsemide", "torsemide", ["Dytor", "Torsinex"], "Tab", ["10 mg", "20 mg"], "diuretic", "furosemide"),
  d("clopidogrel", "clopidogrel", ["Plavix", "Clopilet"], "Tab", ["75 mg"], "antiplatelet"),
  d("aspirin", "aspirin", ["Ecosprin", "Disprin"], "Tab", ["75 mg", "150 mg", "325 mg"], "antiplatelet"),
  d("warfarin", "warfarin", ["Warf", "Coumadin"], "Tab", ["1 mg", "2 mg", "5 mg"], "anticoagulant"),
  d("levothyroxine", "levothyroxine", ["Thyronorm", "Eltroxin"], "Tab", ["25 mcg", "50 mcg", "100 mcg"], "thyroid"),
  d("omeprazole", "omeprazole", ["Omez", "Prilosec"], "Cap", ["20 mg", "40 mg"], "ppi", "esomeprazole"),
  d("rabeprazole", "rabeprazole", ["Razo", "Rabicip"], "Tab", ["10 mg", "20 mg"], "ppi"),
  d("domperidone", "domperidone", ["Domstal", "Motilium"], "Tab", ["10 mg"], "antiemetic", "domperidone-pan"),
  d("ondansetron", "ondansetron", ["Emeset", "Zofran"], "Tab", ["4 mg", "8 mg"], "antiemetic"),
  d("cetirizine", "cetirizine", ["Okacet", "Zyrtec"], "Tab", ["5 mg", "10 mg"], "antihistamine", "levocetirizine"),
  d("levocetirizine", "levocetirizine", ["Xyzal", "Levocet"], "Tab", ["2.5 mg", "5 mg"], "antihistamine", "cetirizine"),
  d("montelukast", "montelukast", ["Montair", "Singulair"], "Tab", ["4 mg", "5 mg", "10 mg"], "antiasthma"),
  d("salbutamol", "salbutamol", ["Asthalin", "Ventolin"], "Tab", ["2 mg", "4 mg"], "antiasthma"),
  d("prednisolone", "prednisolone", ["Wysolone", "Omnacortil"], "Tab", ["5 mg", "10 mg", "20 mg"], "steroid", "prednisone"),
  d("prednisone", "prednisone", ["Deltasone", "Predni"], "Tab", ["5 mg", "10 mg", "20 mg"], "steroid", "prednisolone"),
  d("dexamethasone", "dexamethasone", ["Dexona", "Decadron"], "Tab", ["0.5 mg", "4 mg"], "steroid"),
  d("gabapentin", "gabapentin", ["Gabapin", "Neurontin"], "Cap", ["100 mg", "300 mg", "400 mg"], "neuropathic", "pregabalin"),
  d("pregabalin", "pregabalin", ["Pregalin", "Lyrica"], "Cap", ["50 mg", "75 mg", "150 mg"], "neuropathic", "gabapentin"),
  d("amitriptyline", "amitriptyline", ["Tryptomer", "Elavil"], "Tab", ["10 mg", "25 mg"], "antidepressant", "nortriptyline"),
  d("escitalopram", "escitalopram", ["Nexito", "Lexapro"], "Tab", ["5 mg", "10 mg", "20 mg"], "antidepressant", "citalopram"),
  d("clonazepam", "clonazepam", ["Rivotril", "Clonotril"], "Tab", ["0.25 mg", "0.5 mg", "1 mg"], "benzodiazepine", "clobazam"),
  d("clobazam", "clobazam", ["Frisium", "Clobazam"], "Tab", ["5 mg", "10 mg"], "benzodiazepine", "clonazepam"),
  d("tramadol", "tramadol", ["Ultracet", "Contramal"], "Tab", ["50 mg", "100 mg"], "opioid", "tapentadol"),
  d("tapentadol", "tapentadol", ["Tapal", "Nucynta"], "Tab", ["50 mg", "100 mg"], "opioid", "tramadol"),
  d("ranitidine", "ranitidine", ["Zinetac", "Rantac"], "Tab", ["150 mg", "300 mg"], "antacid"),
  d("ferrous-sulphate", "ferrous sulphate", ["Orofer", "Fefol"], "Tab", ["100 mg", "200 mg"], "supplement", "ferrous-ascorbate"),
  d("ferrous-ascorbate", "ferrous ascorbate", ["Ferradol", "Tonoferron"], "Tab", ["100 mg"], "supplement", "ferrous-sulphate"),
  d("vitamin-b12", "methylcobalamin", ["Mecobal", "Nurokind"], "Tab", ["500 mcg", "1500 mcg"], "vitamin"),
  d("ivermectin", "ivermectin", ["Ivecop", "Stromectol"], "Tab", ["6 mg", "12 mg"], "antiparasitic"),
  d("albendazole", "albendazole", ["Zentel", "Albenza"], "Tab", ["400 mg"], "antiparasitic"),
  d("fluconazole", "fluconazole", ["Forcan", "Zocon"], "Tab", ["50 mg", "150 mg", "200 mg"], "antifungal"),
  d("terbinafine", "terbinafine", ["Terbicip", "Lamisil"], "Tab", ["250 mg"], "antifungal"),
  d("acyclovir", "acyclovir", ["Zovirax", "Herpex"], "Tab", ["200 mg", "400 mg", "800 mg"], "antiviral", "valacyclovir"),
  d("valacyclovir", "valacyclovir", ["Valtrex", "Valcivir"], "Tab", ["500 mg", "1000 mg"], "antiviral", "acyclovir"),
  d("tamsulosin", "tamsulosin", ["Urimax", "Flomax"], "Cap", ["0.2 mg", "0.4 mg"], "urological", "tadalafil"),
  d("tadalafil", "tadalafil", ["Tadacip", "Cialis"], "Tab", ["5 mg", "10 mg", "20 mg"], "urological", "tamsulosin"),
];

/** Keys the drug-swap perturbation references but that are not in the formulary are ignored, so a
 * lasa partner may be absent (e.g. azathioprine, saxagliptin). Same-class and random swaps cover it. */
export const FORMULARY_BY_KEY: Record<string, Drug> = Object.fromEntries(FORMULARY.map((x) => [x.key, x]));
