-- Defense in depth: only non-executable HOLD decisions may enter this audit table.
-- Application validation alone cannot protect against other database writers.
ALTER TABLE "VisibilityRecoveryReview"
  ADD CONSTRAINT "VisibilityRecoveryReview_decision_hold_check"
  CHECK ("decision" = 'hold'),
  ADD CONSTRAINT "VisibilityRecoveryReview_required_fields_check"
  CHECK (
    length(btrim("operationId")) > 0
    AND length(btrim("workspaceId")) > 0
    AND length(btrim("reviewerId")) > 0
    AND length(btrim("reason")) > 0
  ),
  ADD CONSTRAINT "VisibilityRecoveryReview_evidence_array_check"
  CHECK (jsonb_typeof("evidence") = 'array' AND jsonb_array_length("evidence") > 0);
