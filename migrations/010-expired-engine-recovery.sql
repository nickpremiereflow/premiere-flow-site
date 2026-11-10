-- Server-only recovery. No scheduling, submissions or generation is enabled here.
BEGIN;
ALTER TABLE pf_engine_dispatch DROP CONSTRAINT pf_engine_dispatch_state_check;
ALTER TABLE pf_engine_dispatch ADD CONSTRAINT pf_engine_dispatch_state_check
  CHECK(state IN ('pending','claimed','completed','failed','expired'));
ALTER TABLE pf_engine_dispatch DROP CONSTRAINT pf_engine_dispatch_check;
ALTER TABLE pf_engine_dispatch ADD CONSTRAINT pf_engine_dispatch_check CHECK(
  (state='pending' AND claimed_ticket_hash IS NULL AND claimed_at IS NULL)
  OR (state IN ('claimed','completed','failed') AND claimed_ticket_hash IS NOT NULL AND claimed_at IS NOT NULL)
  OR (state='expired' AND (claimed_ticket_hash IS NULL)=(claimed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS pf_engine_dispatch_claimed_idx ON pf_engine_dispatch(claimed_at) WHERE state='claimed';

-- A missing acknowledgement is never permission to generate again. Close only
-- the expired attempt, return its reservation, and require an explicit retry.
CREATE OR REPLACE FUNCTION pf_expire_engine(p_account text,p_job uuid,p_attempt integer)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE j pf_job; d pf_engine_dispatch; outcome text; code text; stage text; detail text;
BEGIN
 PERFORM 1 FROM pf_customer WHERE account_id=p_account FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO j FROM pf_job WHERE job_id=p_job AND account_id=p_account FOR UPDATE;
 IF NOT FOUND OR j.attempt_count<>p_attempt THEN RETURN false; END IF;
 SELECT * INTO d FROM pf_engine_dispatch WHERE job_id=p_job AND account_id=p_account AND attempt=p_attempt FOR UPDATE;
 IF NOT FOUND OR d.state NOT IN ('pending','claimed') OR d.result_fingerprint IS NOT NULL THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM pf_credit_reservation WHERE job_id=p_job AND account_id=p_account AND attempt=p_attempt AND state='reserved') THEN RETURN false; END IF;
 IF d.state='pending' THEN
   IF d.created_at>now()-interval '30 minutes' OR j.status NOT IN ('ACCEPTED','RETRYING') THEN RETURN false; END IF;
   stage:='Dispatch'; code:='ENGINE_DISPATCH_TIMEOUT';
   detail:='Processing did not start in time. Your listing credit has been released. Retry this same listing.';
 ELSE
   IF d.claimed_at>now()-interval '2 hours' OR j.status<>'PROCESSING' THEN RETURN false; END IF;
   stage:='Processing'; code:='ENGINE_RESULT_TIMEOUT';
   detail:='Processing did not return a verified result in time. Your listing credit has been released. Retry this same listing.';
 END IF;
 outcome:=CASE WHEN p_attempt<3 THEN 'RETRY_REQUIRED' ELSE 'FAILED' END;
 IF p_attempt=3 THEN detail:='The processing attempt timed out. Your listing credit has been released. Contact support for help.'; END IF;
 UPDATE pf_job SET status=outcome,qa_status=CASE WHEN d.state='claimed' THEN 'REVIEW' ELSE 'PENDING' END,
   error_stage=stage,error_code=code,error_details=detail,next_retry_at=NULL,updated_at=now() WHERE job_id=p_job;
 PERFORM pf_finish_credit(p_account,p_job,p_attempt,false);
 UPDATE pf_job_attempt SET qa_status=CASE WHEN d.state='claimed' THEN 'REVIEW' ELSE 'PENDING' END WHERE job_id=p_job AND attempt=p_attempt;
 -- Expired attempts can neither be claimed nor submit a late completion result.
 UPDATE pf_engine_dispatch SET state='expired',result=jsonb_build_object('status',outcome,'errorCode',code),updated_at=now()
   WHERE job_id=p_job AND attempt=p_attempt;
 INSERT INTO pf_audit_event(event_key,account_id,job_id,action,details)
   VALUES('engine.expired:'||p_job||':'||p_attempt,p_account,p_job,'job.timeout',jsonb_build_object('attempt',p_attempt,'status',outcome,'errorCode',code));
 INSERT INTO pf_command(command_id,kind,account_id,payload)
   VALUES('job-result:'||p_job||':'||p_attempt,'job_notification',p_account,jsonb_build_object('jobId',p_job,'attempt',p_attempt,'status',outcome)) ON CONFLICT DO NOTHING;
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION pf_expire_engine(text,uuid,integer) FROM PUBLIC;
INSERT INTO pf_schema_migration(version) VALUES('010-expired-engine-recovery') ON CONFLICT DO NOTHING;
COMMIT;
