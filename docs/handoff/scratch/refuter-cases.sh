t() { # label, sql
  out=$(timeout 30 docker exec -i refuter-pg psql -U postgres -d t -q -c "$2" 2>&1)
  if echo "$out" | grep -q "violates check constraint"; then
    echo "REJECTED  | $1 | $(echo "$out" | grep -o 'room_turn_speaker_[a-z_]*_ck' | head -1)"
  elif echo "$out" | grep -qi "error"; then
    echo "OTHER_ERR | $1 | $(echo "$out" | head -1)"
  else
    echo "ACCEPTED  | $1"
  fi
}
t "role=clinician + id + conf  (the legitimate match)" \
  "INSERT INTO room_turn_speaker(window_id,source_ref,speaker_idx,clinician_id,role,match_confidence) VALUES('w','a1',0,'doc_x','clinician',0.82);"
t "role=clinician, NO clinician_id       <-- MUST REJECT" \
  "INSERT INTO room_turn_speaker(window_id,source_ref,speaker_idx,clinician_id,role,match_confidence) VALUES('w','a2',0,NULL,'clinician',0.82);"
t "role=clinician, NO match_confidence   <-- MUST REJECT" \
  "INSERT INTO room_turn_speaker(window_id,source_ref,speaker_idx,clinician_id,role,match_confidence) VALUES('w','a3',0,'doc_x','clinician',NULL);"
t "role=clinician, neither id nor conf   <-- MUST REJECT" \
  "INSERT INTO room_turn_speaker(window_id,source_ref,speaker_idx,role) VALUES('w','a4',0,'clinician');"
t "role=unattributed, both null (normal)" \
  "INSERT INTO room_turn_speaker(window_id,source_ref,speaker_idx,role) VALUES('w','a5',0,'unattributed');"
t "role=NULL (the old Slice B writer)" \
  "INSERT INTO room_turn_speaker(window_id,source_ref,speaker_idx) VALUES('w','a6',0);"
t "role='doctor' (off-vocabulary)        <-- MUST REJECT" \
  "INSERT INTO room_turn_speaker(window_id,source_ref,speaker_idx,clinician_id,role,match_confidence) VALUES('w','a7',0,'doc_x','doctor',0.82);"
echo "--- the holes I am probing for ---"
t "role=unattributed BUT clinician_id SET (id without a claim)" \
  "INSERT INTO room_turn_speaker(window_id,source_ref,speaker_idx,clinician_id,role,match_confidence) VALUES('w','b1',0,'doc_x','unattributed',0.82);"
t "role=NULL BUT clinician_id SET (indexed, role-less identity)" \
  "INSERT INTO room_turn_speaker(window_id,source_ref,speaker_idx,clinician_id) VALUES('w','b2',0,'doc_x');"
t "role=clinician, confidence = -5 (nonsense cosine)" \
  "INSERT INTO room_turn_speaker(window_id,source_ref,speaker_idx,clinician_id,role,match_confidence) VALUES('w','b3',0,'doc_x','clinician',-5);"
t "role=clinician, confidence = 0.01 (far below any threshold)" \
  "INSERT INTO room_turn_speaker(window_id,source_ref,speaker_idx,clinician_id,role,match_confidence) VALUES('w','b4',0,'doc_x','clinician',0.01);"
t "role=clinician, clinician_id = '' (empty string, not null)" \
  "INSERT INTO room_turn_speaker(window_id,source_ref,speaker_idx,clinician_id,role,match_confidence) VALUES('w','b5',0,'','clinician',0.82);"
