# Nemotron variants A and B: pre-launch refutation (ruling 94/103, checklist #288), eta-refuter-2

Launch A and B on whichever val manifest Fable rules on. See REFUTER-2-VAL-SPLIT.md: I recommend the production-histogram val.

## Variant A (71b2b2c, proof runs in 0acc6cf): PASS
- Freezes `encoder.*` (98,202,624 params). Everything else (1,027,923, about 1%) is trainable.
- The optimizer holds exactly 1,027,923 params, 0 of them encoder. The encoder state_dict sha256 is identical before and after in all 3 proof runs.
- The hash covers buffers too, so BatchNorm running-stat drift would show. `KeepEncoderEval` also stops it.
- The proof has two independent legs: if NeMo ignored the param-group override, `optimizer_only_head` would be false and the run would raise, even though a frozen encoder's hash would still match.
- **Repeatability:** runs 074359 and 075003 (same config, seed 42, 30 steps) give identical best and last weights (9e7484b04b).
- Inspection only for the freeze mechanics; I ran nothing on the GPU.

## Variant B (c1059a6): PASS for launch, one efficacy caveat
**Crop correctness, verified in NeMo's source on the box** (`audio_to_diar_label.py`, the same copy as the pinned git checkout):
- RTTM times are absolute: `extract_frame_info_from_rttm` and `get_frame_targets_from_rttm` clip to [offset, offset+duration] and subtract the offset.
- The pretrained `train_ds` has `subsegment_mode: True`, and the trainer does not override it. `_create_subsegment` plans chunks from frame targets over the crop's own [offset, offset+duration] and loads audio from offset + start. **No chunk reaches into the next crop's unlabelled audio.**
- Crop boundaries sit at silence midpoints in the merged speech of all speakers, and an assert blocks any turn crossing a boundary.
- Crops outside 2-8 speakers are dropped and counted.
- Cropping and oversampling apply to TRAIN only. The balance target is the production histogram, never the test set.

**Caveat C1 (efficacy, not correctness):**
- Balancing buckets each entry by its WHOLE-entry teacher speaker count.
- In training, every item is a random chunk of up to 105 s (`session_len_sec` 105), and speaker columns inactive in the chunk are removed. So a 180-s "6+" crop typically trains as a chunk with fewer speakers, and the delivered count mix can sit well below the target.
- **Ask:** log in `variant_B_info` the histogram of target columns (speakers present) over the first N training items. The run then shows whether B actually shifted what the model sees.
- A B run that does not beat base must not be read as "more high-count data does not help" until that histogram is known.
