import { describe, expect, it } from 'vitest'
import { LIST_A, LIST_B, procedureGroup } from '../../../src/agents/surgical-consult/procedure-groups.js'

const cases: [string, string[]][] = [
  ['x_chemotherapy', ['Chemotherapy cycle 3', 'day care chemo']],
  ['x_obstetric', ['LSCS', 'Normal delivery']],
  ['circumcision', ['Circumcision', 'stapler circumcision']],
  ['anorectal', ['Fissure sphincterotomy', 'Haemorrhoidectomy', 'Pilonidal sinus excision', 'perineal abscess drainage']],
  ['hernia_repair', ['Inguinal hernia repair', 'Umbilical Hernia mesh']],
  ['B_cholecystectomy', ['Lap cholecystectomy', 'Cholecystectomy']],
  ['joint_replacement', ['Right Knee Replacement', 'TKR', 'Hip replacement', 'Hemiarthroplasty', 'TKA', 'Total knee arthroplasty']],
  ['B_knee_arthroscopy_acl_meniscus', ['ACL reconstruction', 'ACLR', 'meniscectomy', 'Partial meniscus repair']],
  ['B_spine', ['TLIF L4-5', 'Lumbar discectomy', 'Spinal fusion']],
  ['B_hysterectomy', ['Laparoscopic hysterectomy', 'TAH hysterectomy']],
  ['B_tonsil_grommet', ['Tonsillectomy', 'Grommet insertion', 'Adenoidectomy']],
  ['B_varicose_veins', ['Varicose vein ablation', 'varicose stripping']],
  ['B_carpal_tunnel', ['Carpal tunnel release', 'carpal decompression']],
  ['nasal_sinus', ['Septoplasty', 'FESS', 'sinus surgery']],
  ['ear', ['Tympanoplasty', 'Mastoidectomy']],
  ['urology_endoscopic', ['DJ stent removal', 'Cystoscopy', 'RIRS', 'TURP', 'PCNL', 'URSL', 'TURBT']],
  ['lump_excision', ['Lipoma excision', 'Sebaceous cyst removal', 'Wide local excision']],
  ['appendicectomy', ['Appendicectomy', 'Lap appendectomy']],
]

describe('procedureGroup', () => {
  for (const [group, names] of cases) {
    it(`maps ${group}`, () => {
      for (const name of names) expect(procedureGroup(name), name).toBe(group)
    })
  }

  it('falls through to other', () => {
    for (const name of ['', '   ', 'Cataract surgery', 'Thyroidectomy', 'laser eye']) {
      expect(procedureGroup(name), name).toBe('other')
    }
    expect(procedureGroup(null)).toBe('other')
    expect(procedureGroup(undefined)).toBe('other')
  })

  it('respects CASE order: first match wins', () => {
    expect(procedureGroup('chemo port for hernia')).toBe('x_chemotherapy')
    expect(procedureGroup('circumcision and hernia')).toBe('circumcision')
    expect(procedureGroup('fistula with hernia')).toBe('anorectal')
    expect(procedureGroup('arthroscopic knee replacement')).toBe('joint_replacement')
  })

  it('does not send arthroscopy or thrombectomy to joint_replacement', () => {
    expect(procedureGroup('Knee arthroscopy')).toBe('B_knee_arthroscopy_acl_meniscus')
    expect(procedureGroup('Arthroscopic ACL repair')).toBe('B_knee_arthroscopy_acl_meniscus')
    expect(procedureGroup('Thrombectomy')).toBe('other')
  })

  it('sends true joint replacements to joint_replacement', () => {
    for (const name of ['tkr', 'THR left', 'total hip replacement', 'hemiarthroplasty']) {
      expect(procedureGroup(name), name).toBe('joint_replacement')
    }
  })

  it('word-bounds the short tokens', () => {
    expect(procedureGroup('bursa excision')).toBe('other')
    expect(procedureGroup('lumbar disc')).toBe('B_spine')
    expect(procedureGroup('discoid meniscus')).toBe('B_knee_arthroscopy_acl_meniscus')
    expect(procedureGroup('urs')).toBe('urology_endoscopic')
    expect(procedureGroup('Facial fesst')).toBe('other')
    expect(procedureGroup('ursa')).toBe('other')
  })

  it('maps the I1c vocabulary additions', () => {
    expect(procedureGroup('Hernioplasty')).toBe('hernia_repair')
    expect(procedureGroup('Lap chole')).toBe('B_cholecystectomy')
    expect(procedureGroup('chole')).toBe('B_cholecystectomy')
    expect(procedureGroup('Circumcision')).toBe('circumcision')
    expect(procedureGroup('Total knee replacement with meniscectomy')).toBe('joint_replacement')
    expect(procedureGroup('Arthroscopic ACL repair')).toBe('B_knee_arthroscopy_acl_meniscus')
  })

  it('does not over-match circum/delivery/chole', () => {
    expect(procedureGroup('Circumflex artery stent')).toBe('other')
    expect(procedureGroup('Delivery of foreign body')).toBe('other')
    expect(procedureGroup('Normal delivery')).toBe('x_obstetric')
    expect(procedureGroup('Vaginal delivery')).toBe('x_obstetric')
    expect(procedureGroup('Cholera treatment')).toBe('other')
  })

  it('trims and ignores case', () => {
    expect(procedureGroup('  HERNIA  ')).toBe('hernia_repair')
  })

  it('exports list A and list B', () => {
    expect([...LIST_A]).toEqual(['anorectal', 'joint_replacement', 'urology_endoscopic', 'hernia_repair', 'circumcision'])
    expect(LIST_B).toHaveLength(7)
    expect(LIST_B.every((g) => g.startsWith('B_'))).toBe(true)
  })
})
