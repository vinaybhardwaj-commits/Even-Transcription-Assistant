import importlib
R = importlib.import_module("tools.eta2freescript.r1_floors")
D = """paracetamol ibuprofen diclofenac aceclofenac etoricoxib tramadol aspirin clopidogrel warfarin atorvastatin rosuvastatin amlodipine
telmisartan losartan metoprolol atenolol propranolol furosemide spironolactone metformin glimepiride gliclazide sitagliptin vildagliptin
insulin thyroxine levothyroxine carbimazole prednisolone methylprednisolone dexamethasone hydrocortisone amoxicillin azithromycin
cefixime cefuroxime cefpodoxime ciprofloxacin ofloxacin levofloxacin doxycycline nitrofurantoin metronidazole tinidazole fluconazole
itraconazole terbinafine clotrimazole albendazole ivermectin acyclovir valacyclovir oseltamivir cetirizine levocetirizine fexofenadine
montelukast salbutamol budesonide formoterol ipratropium pantoprazole omeprazole rabeprazole esomeprazole ranitidine famotidine
domperidone ondansetron metoclopramide lactulose bisacodyl loperamide racecadotril sucralfate ursodeoxycholic gabapentin pregabalin
amitriptyline sertraline escitalopram fluoxetine alprazolam clonazepam zolpidem melatonin betahistine cinnarizine hydroxyzine
chlorpheniramine penicillin mupirocin fusidic permethrin minoxidil isotretinoin tretinoin adapalene tamsulosin finasteride sildenafil
tadalafil mefenamic tranexamic progesterone dydrogesterone letrozole clomiphene methotrexate hydroxychloroquine colchicine febuxostat allopurinol""".split()
B = """dolo crocin calpol combiflam zerodol ultracet ecosprin clopilet storvas amlong telma losar met glycomet amaryl januvia galvus lantus
thyronorm eltroxin neomercazole wysolone medrol augmentin azee taxim zifi ciplox oflox levoflox doxy niftran flagyl fluka itaspor
zentel ivermectol cetzine levocet allegra montair asthalin budecort foracort pantocid pan omez razo nexpro rantac famocid domstal
emeset perinorm duphalac dulcolax eldoper sucral udiliv gabapin lyrica tryptomer serta nexito fludac restyl rivotril zolfresh
vertin stugeron atarax avil t-bact fucidin permite mintop isotroin retino deriva urimax finpecia meftal pause duphaston letroz""".split()
for tag, L in (("generics", D), ("brands", B)):
    miss = [w for w in L if not R.drug_mentions(f"continue {w} as advised", [])]
    print(f"{tag}: detected {len(L)-len(miss)}/{len(L)}; missed {miss}")
