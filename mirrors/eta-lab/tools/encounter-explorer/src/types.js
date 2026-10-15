// Normalised shapes shared by the UI and every adapter. JSDoc only; no runtime code.

/** @typedef {"stt"|"diar"|"freescript"|"validator"|"rubrics"|"jev"|"cdmss"|"rx"} StageId */
/** @typedef {"done"|"failed"|"pending"|"missing"|"na"} StageState  na = this data source cannot tell */
/** @typedef {{ok:true, data:any, storedAt:number|null}|{ok:false, code:string, message:string, retryable:boolean}} Result */

/**
 * @typedef {Object} ListQuery
 * @property {string} from  YYYY-MM-DD, clamped to MIN_DATE
 * @property {string} to    YYYY-MM-DD
 * @property {string|null} [room]
 * @property {string|null} [specialty]
 * @property {boolean} [hasRx]
 */

/** @typedef {{state:StageState, reason:string|null}} StageInfo */
/** @typedef {{r2_key:string|null, status:string|null, engine?:string|null}} LayerRef */

/**
 * One consult, in the field names of the encounter catalog row (C1, catalog_version 1) so adapter-catalog is a near pass-through.
 * Fields the live tools cannot supply are null. t_open/t_close are UTC epoch ms. Extras beyond the catalog row: specialty, headline, lengthSec.
 * @typedef {Object} ConsultSummary
 * @property {string} consult_uid
 * @property {string} ist_date                IST YYYY-MM-DD
 * @property {string|null} doctor_uid         null when the source has no doctor; group with docKey()
 * @property {string|null} room_id
 * @property {number|null} t_open
 * @property {number|null} t_close
 * @property {"cutter"|"caa"|null} source
 * @property {{r2_key:string|null, r2_status:string|null, signature_sha256:string|null, audio_sha256:string|null, bytes:number|null, minutes:number|null}|null} clip
 * @property {{stt:LayerRef|null, translate:LayerRef|null, diar_sarvam:LayerRef|null, diar_nemotron:LayerRef|null, role:LayerRef|null, parts:LayerRef|null}|null} layers
 * @property {{artifact_id:string|null, state:string|null}|null} freescript
 * @property {Object<string,StageInfo>} stages   drives the chips; unknown stage = "na"
 * @property {string|null} first_gap             "stage:reason"
 * @property {{earned_min:number|null, spent_min:number|null}|null} allowance
 * @property {{prescription_uid:string|null, presc_state:string|null}|null} prescription
 * @property {string|null} doctor_name
 * @property {string|null} patient_name
 * @property {string|null} individual_uid
 * @property {string|null} prescription_uid
 * @property {boolean|null} has_prescription   null = no joined identity row yet: unknown, never "no Rx"
 * @property {string[]} [layers_present]        search rows, mapped onto panel names (stt/translate/role -> transcript)
 * @property {number|null} catalog_version
 * @property {string|null} generated_at
 * @property {string|null} specialty
 * @property {{label:string,value:string}[]} headline
 * @property {number|null} lengthSec
 */

/**
 * @typedef {Object} DayCell
 * @property {string} doctorId
 * @property {string|null} doctorName
 * @property {string|null} specialty
 * @property {string} date
 * @property {number} consults
 * @property {number} completeness     0..1, share of known stage chips that are done
 * @property {boolean} hasRx
 */

/**
 * @typedef {Object} DaysResult
 * @property {DayCell[]} cells
 * @property {{doctorId:string,doctorName:string|null,specialty:string|null}[]} doctors
 * @property {string[]} dates
 * @property {string[]} rooms
 * @property {string[]} specialties
 * @property {boolean} truncated       a source hit its row cap
 */

/**
 * @typedef {Object} TranscriptLine
 * @property {string} id
 * @property {number} t0   seconds from consult start
 * @property {number} t1
 * @property {string|null} speaker
 * @property {string|null} role        doctor | patient | attender | other
 * @property {string|null} lang
 * @property {string|null} text        native
 * @property {string|null} textEn
 */

/** @typedef {{step:string, at:string|null, model:string|null, version:string|null, outcome:string|null, reason:string|null}} LedgerRow */
/** @typedef {{id:string, version:string|null, status:string|null, score:Object|null, findings:any[]}} RubricResult */
/** @typedef {{question:string, answer:string|null, probability:number|null, probabilityKind?:"calibrated"|"raw"|null, mock?:boolean, createdAt?:string|null, raw:Object}} JevDecision */
/** @typedef {{severity:string|null, finding:string, detail:string|null}} CdmssFinding */

/**
 * @typedef {Object} FreescriptNote
 * @property {string|null} noteText
 * @property {{ok:boolean|null, errors:string[]}} validator
 * @property {{kind:string|null,detail:string|null,prompt:string|null}[]} completionRequired
 * @property {string|null} model
 * @property {string|null} version
 */

/**
 * @typedef {Object} Prescription
 * @property {string|null} prescriptionUid
 * @property {string|null} individualUid
 * @property {string|null} prescState
 * @property {boolean|null} hasPrescription
 * @property {boolean} [linkFromTool]    the link is the tool's pulse_url, not built here
 * @property {string|null} signedText   always null from the catalog (it copies no prescription content); only the mockup has one
 * @property {boolean} [audioSynthetic]  true when the page generates a stand-in tone track (mockup only)
 * @property {string|null} link         built by pulse.js, null unless both ids exist
 */

/**
 * @typedef {ConsultSummary & {
 *   transcript:TranscriptLine[]|null,
 *   ledger:LedgerRow[],
 *   note:FreescriptNote|null,
 *   pdqi:RubricResult|null,
 *   rubrics:RubricResult[],
 *   jev:JevDecision[]|null,
 *   cdmss:CdmssFinding[]|null,
 *   rx:Prescription|null,
 *   layerStatus?:Object<string,{status:"ok"|"absent"|"not_available"|"error", source:string|null, code:string|null}>,
 *   transcriptMeta?:{span:{t0:number,t1:number}|null, degraded:string[], nClamped:number|null, manifestT0Ms:number|null, durationS:number|null}|null,
 *   partsClamped?:number|null,
 *   identityDegraded?:boolean
 * }} ConsultDetail
 */

/** @typedef {{text:string, updated_by:string|null, updated_at:string|null}} Note */

export const STAGES = ["stt", "diar", "freescript", "validator", "rubrics", "jev", "cdmss", "rx"];
export const MIN_DATE = "2026-09-09";
