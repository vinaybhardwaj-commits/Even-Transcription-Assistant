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
  ['acl_ligament', ['ACL reconstruction', 'ACLR', 'acl reconstruction with meniscal repair', 'PCL reconstruction', 'MPFL reconstruction', 'cruciate ligament repair']],
  ['B_knee_arthroscopy_degenerative', ['meniscectomy', 'Partial meniscus repair', 'arthroscopic partial meniscectomy', 'knee arthroscopy and debridement for OA', 'knee chondroplasty']],
  ['B_spine', ['TLIF L4-5', 'Lumbar discectomy', 'Spinal fusion']],
  ['B_hysterectomy', ['Laparoscopic hysterectomy', 'TAH hysterectomy']],
  ['B_tonsil_grommet', ['Tonsillectomy', 'Grommet insertion', 'Adenoidectomy']],
  ['B_varicose_veins', ['Varicose vein ablation', 'varicose stripping']],
  ['B_carpal_tunnel', ['Carpal tunnel release', 'carpal decompression']],
  ['nasal_sinus', ['Septoplasty', 'FESS', 'sinus surgery']],
  ['ear', ['Tympanoplasty', 'Mastoidectomy']],
  ['urology_endoscopic', ['DJ stent removal', 'Cystoscopy', 'RIRS', 'TURP', 'PCNL', 'URSL', 'TURBT', 'Ureteroscopy']],
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
    expect(procedureGroup('Knee arthroscopy')).toBe('B_knee_arthroscopy_degenerative')
    expect(procedureGroup('Arthroscopic ACL repair')).toBe('acl_ligament')
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
    expect(procedureGroup('discoid meniscus')).toBe('B_knee_arthroscopy_degenerative')
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
    expect(procedureGroup('Arthroscopic ACL repair')).toBe('acl_ligament')
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

  it('splits the knee groups (I4)', () => {
    expect(procedureGroup('arthroscopic partial meniscectomy')).toBe('B_knee_arthroscopy_degenerative')
    expect(procedureGroup('acl reconstruction with meniscal repair')).toBe('acl_ligament')
    expect(procedureGroup('knee arthroscopy and debridement for OA')).toBe('B_knee_arthroscopy_degenerative')
    expect(procedureGroup('arthroscopic knee replacement')).toBe('joint_replacement')
    expect(procedureGroup('URSL')).toBe('urology_endoscopic')
    expect(procedureGroup('ureteroscopy')).toBe('urology_endoscopic')
    expect(LIST_B).not.toContain('acl_ligament')
    expect(LIST_B).toContain('B_knee_arthroscopy_degenerative')
  })

  it('exports list A and list B', () => {
    expect([...LIST_A]).toEqual(['anorectal', 'joint_replacement', 'urology_endoscopic', 'hernia_repair', 'circumcision'])
    expect(LIST_B).toHaveLength(7)
    expect(LIST_B.every((g) => g.startsWith('B_'))).toBe(true)
  })

  it('I4b: knee groups are knee-specific', () => {
    const cases: [string, string][] = [
      ['wound debridement', 'other'],
      ['diabetic foot debridement', 'other'],
      ['burn debridement', 'other'],
      ['debridement of sacral pressure sore', 'other'],
      ['chondroplasty', 'other'],
      ['spinal debridement', 'B_spine'],
      ['debridement and fusion', 'B_spine'],
      ['cystoscopy debridement', 'urology_endoscopic'],
      ['knee debridement', 'B_knee_arthroscopy_degenerative'],
      ['shoulder arthroscopy', 'other'],
      ['hip arthroscopy', 'other'],
      ['arthroscopic rotator cuff repair', 'other'],
      ['Arthroscopic Bankart repair', 'other'],
      ['arthroscopic URS', 'urology_endoscopic'],
      ['ankle lateral ligament reconstruction', 'other'],
      ['thumb ligament reconstruction tendon interposition', 'other'],
      ['knee ligament reconstruction', 'acl_ligament'],
      ['arthroscopy', 'B_knee_arthroscopy_degenerative'],
      ['turpentine burn', 'other'],
      ['bilateral knees debridement', 'B_knee_arthroscopy_degenerative'],
      ['knees ligament reconstruction', 'acl_ligament'],
      ['TURP', 'urology_endoscopic'],
      ['TURBT', 'urology_endoscopic'],
    ]
    for (const [name, group] of cases) expect([name, procedureGroup(name)]).toEqual([name, group])
  })
})
