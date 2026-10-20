# ft-whoconverts: plain-English names for model inputs (column -> label). Unknown columns fall back to a cleaned column name.
import re

BASE = {
    'specialty': 'Specialty', 'doctor_id': 'Doctor (in-fold conversion rate)', 'proc_class': 'Procedure group', 'n_procs': 'Number of procedures advised',
    'month_idx': 'Month of advice (trend)', 'n_prior_flagged': 'Earlier surgery advice flagged', 'age_y': 'Age', 'sex': 'Sex',
    'n_prior_rx': 'Earlier Even prescriptions (Pulse count)', 'n_icd': 'Diagnosis codes on this Rx', 'icd_missing': 'No diagnosis code on this Rx',
    'n_inv': 'Investigations ordered', 'inv_missing': 'No investigations ordered', 'doctor_gender': 'Doctor gender',
    'ch_digest': 'Diagnosis: digestive', 'ch_musc': 'Diagnosis: musculoskeletal', 'ch_gu': 'Diagnosis: genito-urinary', 'ch_skin': 'Diagnosis: skin',
    'ch_symptom': 'Diagnosis: symptom code', 'ch_resp': 'Diagnosis: respiratory', 'ch_injury': 'Diagnosis: injury', 'ch_factors': 'Diagnosis: health-status factor',
    'ch_neoplasm': 'Diagnosis: neoplasm', 'ch_endo': 'Diagnosis: endocrine', 'ch_ear': 'Diagnosis: ear', 'ch_infect': 'Diagnosis: infection',
    'ch_circ': 'Diagnosis: circulatory', 'payer_prior': 'Payer before the advice', 'days_since_prior_appt': 'Days since previous appointment',
    'ft8_has_prior_rx': 'History: earlier Even Rx', 'ft8_n_prior_rx_all': 'History: earlier Rx, all time', 'ft8_n_prior_rx_12m': 'History: earlier Rx, 12 months',
    'ft8_n_doctors_12m': 'History: doctors seen, 12 months', 'ft8_days_since_first_rx': 'History: days since first Even Rx',
    'ft8_n_ip_events_pre': 'History: earlier IP admissions', 'ft8_n_meds_latest_prior_rx': 'History: meds on latest prior Rx', 'ft8_has_meds': 'History: any meds on prior Rx',
    'ft8_has_icd': 'History: any ICD history', 'ft8_n_icd_codes': 'History: number of ICD codes', 'ft8_charlson_n': 'History: Charlson conditions',
    'ft8_charlson_score': 'History: Charlson score', 'ft8_dm': 'History: diabetes', 'ft8_htn': 'History: hypertension', 'ft8_ckd': 'History: kidney disease',
    'ft8_cad': 'History: heart disease', 'ft8_obesity': 'History: obesity', 'ft8_n_comorb_names': 'History: named comorbidities',
    'ft8_has_bp': 'History: BP on file', 'ft8_sbp': 'History: systolic BP', 'ft8_dbp': 'History: diastolic BP', 'ft8_bp_age_d': 'History: age of BP reading',
    'n_calls': 'Calls before T', 'n_connected': 'Connected calls before T', 'n_recorded': 'Recorded calls before T', 'talk_s': 'Total talk time before T',
    'max_call_s': 'Longest call before T', 'first_call_day': 'Day of first call', 'n_summaries': 'Runo summaries before T', 'no_summary': 'No Runo summary',
    'l8_opus': 'Opus score of call text', 'has_l8': 'Has call text for Opus', 'c_l8_opus': 'Opus score of consult text', 'c_has_l8': 'Has consult text for Opus',
    'roles_ok': 'Call speaker roles resolved', 'has_stt_tags': 'Has STT call tags', 'stt_n_tagged': 'STT-tagged calls', 'n_bolna_calls': 'Bolna calls', 'bolna_has': 'Has Bolna call',
}
LABS = {'hba1c': 'HbA1c', 'hb': 'Hb', 'creat': 'creatinine', 'egfr': 'eGFR', 'tsh': 'TSH'}
ENG = {'nemo': 'turn-taking', 'ody': 'voice emotion (Odyssey)', 'e2v': 'voice emotion (emotion2vec)', 'clef': 'voice affect (Clef)'}
WHO = {'patient': 'patient', 'counsellor': 'counsellor', 'doctor': 'doctor', 'all': 'everyone', 'doc': 'doctor', 'pat': 'patient'}


def plain(c):
    if c in BASE: return BASE[c]
    m = re.fullmatch(r'ft8_(has_)?(hba1c|hb|creat|egfr|tsh)(_age_d|_n_pre)?', c)
    if m:
        lab = LABS[m.group(2)]
        if m.group(1): return f'History: {lab} on file'
        return f'History: {lab} ' + {None: 'value', '_age_d': 'age of result', '_n_pre': 'number of results'}[m.group(3)]
    m = re.fullmatch(r'(stt_|bolna_)?(obj|intent)_(.+)', c)
    if m:
        src = {None: 'Runo summary', 'stt_': 'call STT', 'bolna_': 'Bolna'}[m.group(1)]
        return f'{src}: ' + ('objection ' if m.group(2) == 'obj' else 'intent ') + m.group(3).replace('_', ' ')
    m = re.fullmatch(r'(stt_|bolna_)?(next_step_any|next_visit|price_quoted)', c)
    if m:
        src = {None: 'Runo summary', 'stt_': 'call STT', 'bolna_': 'Bolna'}[m.group(1)]
        return f'{src}: ' + {'next_step_any': 'any next step', 'next_visit': 'visit scheduled', 'price_quoted': 'price quoted'}[m.group(2)]
    con = c.startswith('c_'); b = c[2:] if con else c
    where = 'consult' if con else 'calls'
    m = re.fullmatch(r'has_(nemo|ody|e2v|clef)', b)
    if m: return f'Has {where} {ENG[m.group(1)]}'
    m = re.fullmatch(r'(nemo|ody|e2v|clef)_(.+)', b)
    if m:
        rest = m.group(2); who = ''
        for k, v in WHO.items():
            if rest.startswith(k + '_'): who, rest = v, rest[len(k) + 1:]; break
        if m.group(1) == 'nemo':
            rest = rest.replace('_per_min', ' per minute').replace('consult_min', 'consult length (min)').replace('speech_min', 'speech (min)')
            rest = rest.replace('n_speakers_nemo', 'speakers detected').replace('_s', ' (s)') if rest.endswith('_s') else rest.replace('n_speakers_nemo', 'speakers detected')
        else:
            rest = re.sub(r'_mean$', ' (mean)', rest); rest = re.sub(r'_std$', ' (spread)', rest); rest = re.sub(r'_min$', ' (lowest)', rest)
            rest = re.sub(r'(^|_)n$', r'\1segments', rest); rest = rest.replace('n_win', 'windows').replace('_ev', '').replace('valence_gap_patient_minus_counsellor', 'valence gap patient - counsellor')
        rest = rest.replace('_', ' ')
        return f'{where.capitalize()} {ENG[m.group(1)]}: ' + (f'{who} ' if who else '') + rest
    return c.replace('_', ' ')
