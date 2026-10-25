-- Recovery review rows are append-only. PostgreSQL enforces this even
-- if an application caller accidentally attempts to edit or delete one.
CREATE FUNCTION "reject_visibility_recovery_review_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'VisibilityRecoveryReview is append-only';
END;
$$;

CREATE TRIGGER "VisibilityRecoveryReview_no_update"
BEFORE UPDATE ON "VisibilityRecoveryReview"
FOR EACH ROW EXECUTE FUNCTION "reject_visibility_recovery_review_mutation"();

CREATE TRIGGER "VisibilityRecoveryReview_no_delete"
BEFORE DELETE ON "VisibilityRecoveryReview"
FOR EACH ROW EXECUTE FUNCTION "reject_visibility_recovery_review_mutation"();
