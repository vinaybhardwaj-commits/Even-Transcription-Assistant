const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['anaemia', 'anemia'],
  ['paediatric', 'pediatric'],
  ['paediatrician', 'pediatrician'],
  ['oedema', 'edema'],
  ['haemorrhage', 'hemorrhage'],
  ['haemoglobin', 'hemoglobin'],
  ['oesophagus', 'esophagus'],
  ['oestrogen', 'estrogen'],
  ['diarrhoea', 'diarrhea'],
  ['labour', 'labor'],
  ['tumour', 'tumor'],
  ['defence', 'defense'],
  ['licence', 'license'],
  ['colour', 'color'],
  ['favour', 'favor'],
  ['behaviour', 'behavior'],
  ['centre', 'center'],
  ['litre', 'liter'],
  ['metre', 'meter'],
  ['foetal', 'fetal'],
  ['gynaecology', 'gynecology'],
  ['orthopaedic', 'orthopedic'],
]

const ALT = new Map<string, string>()
for (const [left, right] of PAIRS) {
  ALT.set(left, right)
  ALT.set(right, left)
}

export function spellingAlts(term: string): string[] {
  const alt = ALT.get(term)
  return alt ? [alt] : []
}

/** Append the other spelling so a tsvector built from this text matches either form. */
export function expandSpellings(text: string): string {
  const found = new Set<string>()
  const tokens = text.toLowerCase().match(/[a-z]+/g) ?? []
  for (const token of tokens) {
    const alt = ALT.get(token)
    if (alt) found.add(alt)
  }
  if (found.size === 0) return text
  return `${text}\n${[...found].join(' ')}`
}
