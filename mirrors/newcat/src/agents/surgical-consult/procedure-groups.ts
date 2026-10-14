// Ported from the CASE expression in P0-3-GROUPED-SQL.md. First match wins.
// I1b/I1c rulings: short tokens are word-bounded (the SQL's bare `thr` matched inside "arthroscopy"), and
// joint_replacement stays ahead of the knee-arthroscopy group so "knee replacement with meniscectomy" is a replacement.
// The SQL runs on lower(trim(name)); procedureGroup does the same.
export const LIST_A = ['anorectal', 'joint_replacement', 'urology_endoscopic', 'hernia_repair', 'circumcision'] as const
export const LIST_B = [
  'B_cholecystectomy',
  'B_knee_arthroscopy_acl_meniscus',
  'B_spine',
  'B_hysterectomy',
  'B_tonsil_grommet',
  'B_varicose_veins',
  'B_carpal_tunnel',
] as const
export const EXCLUDED_GROUPS = ['x_chemotherapy', 'x_obstetric'] as const
export const OTHER_GROUPS = ['nasal_sinus', 'ear', 'lump_excision', 'appendicectomy'] as const

export type Group =
  | (typeof LIST_A)[number]
  | (typeof LIST_B)[number]
  | (typeof EXCLUDED_GROUPS)[number]
  | (typeof OTHER_GROUPS)[number]

const RULES: [RegExp, Group][] = [
  [/chemo/, 'x_chemotherapy'],
  [/(\blscs\b|normal delivery|vaginal delivery|caesar|cesar)/, 'x_obstetric'],
  [/circumcis/, 'circumcision'],
  [/(fissure|sphincterotomy|fistul|haemorrhoid|hemorrhoid|piles|pilonidal|perineal abscess)/, 'anorectal'],
  [/(hernia|hernio)/, 'hernia_repair'],
  [/(cholecyst|\bchole\b)/, 'B_cholecystectomy'],
  [/(knee replacement|\btkr\b|\btka\b|\btha\b|hip replacement|\bthr\b|hemiarthroplasty|arthroplasty)/, 'joint_replacement'],
  [/(\bacl(r)?\b|menisc|arthroscop)/, 'B_knee_arthroscopy_acl_meniscus'],
  [/(fusion|tlif|plif|laminectomy|discectomy|\bdisc\b|spine|spinal)/, 'B_spine'],
  [/hysterectomy/, 'B_hysterectomy'],
  [/(tonsil|adenoid|grommet|myringotomy)/, 'B_tonsil_grommet'],
  [/varicose/, 'B_varicose_veins'],
  [/carpal/, 'B_carpal_tunnel'],
  [/(septoplasty|turbinoplasty|\bfess\b|sinus surgery)/, 'nasal_sinus'],
  [/(tympanoplasty|mastoid)/, 'ear'],
  [/(stent removal|dj stent|cystoscopy|\brirs\b|\bursl?\b|\bturp\b|\bturbt\b|\bpcnl\b|lithotripsy)/, 'urology_endoscopic'],
  [/(lipoma|cyst excision|wide local excision|sebaceous)/, 'lump_excision'],
  [/append/, 'appendicectomy'],
]

export function procedureGroup(text: string | null | undefined): Group | 'other' {
  const p = (text ?? '').trim().toLowerCase()
  for (const [re, group] of RULES) if (re.test(p)) return group
  return 'other'
}
