-- Bind completion to current-attempt image bytes and the delivered group URL.
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
  IF p_unlimited AND NOT EXISTS(SELECT 1 FROM pf_subscription WHERE account_id=p_account AND status IN ('active','past_due','canceled') AND paid_through>now())
     AND NOT EXISTS(SELECT 1 FROM pf_customer WHERE account_id=p_account AND baseline_tier='Unlimited') THEN RAISE EXCEPTION 'ENTITLEMENT_INVALID'; END IF;
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
CREATE OR REPLACE FUNCTION pf_finish_credit(p_account text,p_job uuid,p_attempt integer,p_success boolean)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE r pf_credit_reservation; j pf_job; valid_assets integer;
BEGIN
  IF p_success IS NULL THEN RAISE EXCEPTION 'RESULT_INVALID'; END IF;
  PERFORM 1 FROM pf_customer WHERE account_id=p_account FOR UPDATE;
  SELECT * INTO j FROM pf_job WHERE job_id=p_job AND account_id=p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOB_NOT_FOUND'; END IF;
  SELECT * INTO r FROM pf_credit_reservation WHERE job_id=p_job AND account_id=p_account;
  IF NOT FOUND OR r.attempt<>p_attempt THEN RAISE EXCEPTION 'ATTEMPT_CONFLICT'; END IF;
  IF r.state='consumed' AND p_success OR r.state='released' AND NOT p_success THEN RETURN false; END IF;
  IF r.state<>'reserved' THEN RAISE EXCEPTION 'CREDIT_STATE_CONFLICT'; END IF;
  IF p_success THEN
    SELECT count(*) INTO valid_assets FROM pf_asset WHERE job_id=p_job AND kind='generated'
      AND attempt=p_attempt AND accessible_verified_at IS NOT NULL AND qa_status='PASS'
      AND mime_type IN ('image/jpeg','image/png','image/webp') AND byte_size>0
      AND url=j.output_url||'nth/'||ordinal||'/';
    IF j.expected_images IS NULL OR valid_assets<>j.expected_images OR j.qa_status<>'PASS'
       OR j.stored_images<>j.expected_images OR j.output_url='' THEN RAISE EXCEPTION 'DELIVERY_NOT_VERIFIED'; END IF;
    UPDATE pf_credit_reservation SET state='consumed',updated_at=now() WHERE job_id=p_job;
    INSERT INTO pf_credit_ledger(entry_key,account_id,job_id,attempt,kind,amount,reason)
      VALUES('consume:'||p_job||':'||p_attempt,p_account,p_job,p_attempt,'consume',0,'Verified completed delivery');
    UPDATE pf_job SET status='COMPLETED',completed_at=now(),updated_at=now(),next_retry_at=NULL WHERE job_id=p_job;
    UPDATE pf_job_attempt SET state='COMPLETED',qa_status='PASS',finished_at=now() WHERE job_id=p_job AND attempt=p_attempt;
  ELSE
    UPDATE pf_credit_reservation SET state='released',updated_at=now() WHERE job_id=p_job;
    INSERT INTO pf_credit_ledger(entry_key,account_id,job_id,attempt,kind,amount,reason)
      VALUES('release:'||p_job||':'||p_attempt,p_account,p_job,p_attempt,'release',r.units,'Failed attempt; credit released');
    UPDATE pf_job SET status=CASE WHEN status='RETRY_REQUIRED' THEN status ELSE 'FAILED' END,updated_at=now() WHERE job_id=p_job;
    UPDATE pf_job_attempt SET state=CASE WHEN j.status='RETRY_REQUIRED' THEN j.status ELSE 'FAILED' END,
      error_stage=j.error_stage,error_code=j.error_code,error_details=j.error_details,retry_at=j.next_retry_at,finished_at=now()
      WHERE job_id=p_job AND attempt=p_attempt;
  END IF;
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION pf_reserve_credit(text,uuid,integer,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION pf_finish_credit(text,uuid,integer,boolean) FROM PUBLIC;
INSERT INTO pf_schema_migration(version) VALUES('004-completion-asset-binding') ON CONFLICT DO NOTHING;
COMMIT;
