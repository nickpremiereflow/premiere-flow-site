-- A historical tier label cannot grant a lifetime recurring entitlement.
-- Existing customer/job/credit rows and retry asset resets are preserved.
BEGIN;
CREATE OR REPLACE FUNCTION pf_reserve_credit(p_account text,p_job uuid,p_attempt integer,p_unlimited boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE j pf_job; r pf_credit_reservation; available integer; units integer;
BEGIN
  PERFORM 1 FROM pf_customer WHERE account_id=p_account AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE'; END IF;
  SELECT * INTO j FROM pf_job WHERE job_id=p_job AND account_id=p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOB_NOT_FOUND'; END IF;
  IF p_attempt<1 OR p_attempt>3 OR p_attempt IS NULL THEN RAISE EXCEPTION 'ATTEMPT_INVALID'; END IF;
  SELECT * INTO r FROM pf_credit_reservation WHERE job_id=p_job;
  IF FOUND THEN
    IF r.attempt=p_attempt AND r.state IN ('reserved','consumed') THEN RETURN false; END IF;
    IF r.state<>'released' OR p_attempt<>r.attempt+1 THEN RAISE EXCEPTION 'RETRY_CONFLICT'; END IF;
  ELSIF p_attempt<>1 THEN RAISE EXCEPTION 'ATTEMPT_INVALID'; END IF;
  IF j.status='COMPLETED' OR j.next_retry_at>now() THEN RAISE EXCEPTION 'JOB_NOT_RETRYABLE'; END IF;
  IF p_attempt>1 AND j.status NOT IN ('FAILED','RETRY_REQUIRED') THEN RAISE EXCEPTION 'JOB_NOT_RETRYABLE'; END IF;
  -- Caller entitlement is checked against trusted DB state as well.
  IF p_unlimited AND NOT EXISTS(SELECT 1 FROM pf_subscription WHERE account_id=p_account AND status IN ('active','past_due','canceled') AND paid_through>now()) THEN RAISE EXCEPTION 'ENTITLEMENT_INVALID'; END IF;
  units:=CASE WHEN p_unlimited THEN 0 ELSE 1 END;
  SELECT b.available INTO available FROM pf_credit_balance b WHERE b.account_id=p_account;
  IF available<units THEN RAISE EXCEPTION 'NO_CREDITS'; END IF;
  INSERT INTO pf_credit_reservation(job_id,account_id,attempt,units,state) VALUES(p_job,p_account,p_attempt,units,'reserved')
    ON CONFLICT(job_id) DO UPDATE SET attempt=EXCLUDED.attempt,units=EXCLUDED.units,state='reserved',updated_at=now();
  INSERT INTO pf_credit_ledger(entry_key,account_id,job_id,attempt,kind,amount,reason)
    VALUES('reserve:'||p_job||':'||p_attempt,p_account,p_job,p_attempt,'reserve',-units,'Listing accepted');
  UPDATE pf_job SET attempt_count=p_attempt,status=CASE WHEN p_attempt=1 THEN 'ACCEPTED' ELSE 'RETRYING' END,
    error_stage=NULL,error_code=NULL,error_details=NULL,next_retry_at=NULL,qa_status='PENDING',qa_notes='',stored_images=0,output_url='',completed_at=NULL,updated_at=now() WHERE job_id=p_job;
  INSERT INTO pf_job_attempt(job_id,attempt,state,started_at) VALUES(p_job,p_attempt,'ACCEPTED',now());
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION pf_reserve_credit(text,uuid,integer,boolean) FROM PUBLIC;
INSERT INTO pf_schema_migration(version) VALUES('007-paid-unlimited-reservation') ON CONFLICT DO NOTHING;
COMMIT;
