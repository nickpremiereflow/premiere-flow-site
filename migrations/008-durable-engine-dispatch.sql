-- Additive, server-only handoff. Does not enable submissions or alter Make.
BEGIN;
CREATE TABLE IF NOT EXISTS pf_engine_dispatch (
  job_id uuid NOT NULL, attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  account_id text NOT NULL, payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','completed','failed')),
  claimed_ticket_hash text UNIQUE, claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,attempt),
  FOREIGN KEY(job_id,attempt) REFERENCES pf_job_attempt(job_id,attempt),
  FOREIGN KEY(job_id,account_id) REFERENCES pf_job(job_id,account_id),
  CHECK((state='pending' AND claimed_ticket_hash IS NULL AND claimed_at IS NULL)
    OR (state<>'pending' AND claimed_ticket_hash IS NOT NULL AND claimed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS pf_engine_dispatch_pending_idx ON pf_engine_dispatch(created_at) WHERE state='pending';

-- Job, reservation, attempt, dispatch and audit either commit together or not at all.
-- p_user is derived from the authenticated session, never a browser account field.
CREATE OR REPLACE FUNCTION pf_enqueue_engine(p_account text,p_user text,p_job uuid,p_fingerprint text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c pf_customer; j pf_job; d pf_engine_dispatch; n integer; unlimited boolean;
        expected integer; source_count integer;
BEGIN
 SELECT * INTO c FROM pf_customer WHERE account_id=p_account AND user_id=p_user AND status='active' FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM pf_membership WHERE account_id=p_account AND user_id=p_user AND active AND role='owner') THEN RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE'; END IF;
 IF p_job IS NULL OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR (p_payload->>'jobId') IS DISTINCT FROM p_job::text OR (p_payload->>'accountId') IS DISTINCT FROM p_account
    OR (p_payload->>'email') IS DISTINCT FROM (SELECT email FROM pf_user WHERE id=p_user)
    OR COALESCE(p_payload->>'action','') NOT IN ('submit','retry') THEN RAISE EXCEPTION 'PAYLOAD_INVALID'; END IF;
 SELECT * INTO j FROM pf_job WHERE job_id=p_job FOR UPDATE;
 IF FOUND AND j.account_id<>p_account THEN RAISE EXCEPTION 'JOB_CONFLICT'; END IF;
 IF p_payload->>'action'='submit' THEN
   IF j.job_id IS NOT NULL THEN
     IF j.fingerprint<>p_fingerprint OR j.payload<>p_payload THEN RAISE EXCEPTION 'JOB_CONFLICT'; END IF;
     RETURN jsonb_build_object('jobId',p_job,'attempt',j.attempt_count,'status',j.status,'created',false);
   END IF;
   IF COALESCE(p_payload->>'uploadcareUrl','') !~ '^https://[a-z0-9.-]+/[0-9a-f-]{36}~([1-9]|10)/$'
      OR COALESCE(p_payload->>'vehicleName','')='' OR COALESCE(p_payload->>'expectedAttempt','')<>'' THEN RAISE EXCEPTION 'PAYLOAD_INVALID'; END IF;
   source_count:=substring(p_payload->>'uploadcareUrl' FROM '~([0-9]+)/$')::integer;
   INSERT INTO pf_job(job_id,account_id,fingerprint,payload,vehicle_name,showroom_color,logo_placement,logo_url,source_url,thumbnail_url,expected_images)
     VALUES(p_job,p_account,p_fingerprint,p_payload,p_payload->>'vehicleName',p_payload->>'showroomColor',p_payload->>'logoPlacement',
       CASE WHEN p_payload->>'logoPlacement'='No Logo' THEN '' ELSE c.logo_url END,p_payload->>'uploadcareUrl',COALESCE(p_payload->>'thumbnail',''),source_count);
   n:=1;
 ELSE
   IF j.job_id IS NULL THEN RAISE EXCEPTION 'JOB_NOT_FOUND'; END IF;
   IF COALESCE(p_payload->>'expectedAttempt','') !~ '^[1-2]$' THEN RAISE EXCEPTION 'ATTEMPT_INVALID'; END IF;
   expected:=(p_payload->>'expectedAttempt')::integer;
   n:=expected+1;
   -- A duplicate request for attempt N never starts attempt N+1.
   SELECT * INTO d FROM pf_engine_dispatch WHERE job_id=p_job AND attempt=n;
   IF FOUND THEN
     IF d.payload<>p_payload THEN RAISE EXCEPTION 'JOB_CONFLICT'; END IF;
     RETURN jsonb_build_object('jobId',p_job,'attempt',j.attempt_count,'status',j.status,'created',false);
   END IF;
   IF j.attempt_count<>expected THEN RAISE EXCEPTION 'ATTEMPT_CONFLICT'; END IF;
   -- Retry transports carry no new source, showroom, branding or email behavior.
   IF EXISTS(SELECT 1 FROM jsonb_each_text(p_payload) x WHERE x.key IN ('vehicleName','assetSource','showroomColor','logoPlacement','thumbnail','uploadcareUrl') AND x.value<>'') THEN RAISE EXCEPTION 'PAYLOAD_INVALID'; END IF;
 END IF;
 SELECT EXISTS(SELECT 1 FROM pf_subscription WHERE account_id=p_account AND status IN ('active','past_due','canceled') AND paid_through>now()) INTO unlimited;
 IF NOT pf_reserve_credit(p_account,p_job,n,unlimited) THEN RAISE EXCEPTION 'RESERVATION_CONFLICT'; END IF;
 INSERT INTO pf_engine_dispatch(job_id,attempt,account_id,payload) VALUES(p_job,n,p_account,p_payload);
 INSERT INTO pf_audit_event(event_key,account_id,actor_user_id,job_id,action,details)
   VALUES('engine.accept:'||p_job||':'||n,p_account,p_user,p_job,'job.accepted',jsonb_build_object('attempt',n,'source','authenticated_portal'));
 SELECT * INTO j FROM pf_job WHERE job_id=p_job;
 RETURN jsonb_build_object('jobId',p_job,'attempt',n,'status',j.status,'created',true);
END; $$;

-- Multiple HTTP deliveries may reach Make; only one may enter the expensive engine.
-- The winning ticket is also the identity for later attempt-bound callbacks.
CREATE OR REPLACE FUNCTION pf_claim_engine(p_ticket_hash text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t pf_make_ticket; j pf_job; d pf_engine_dispatch; r pf_credit_reservation; n integer;
BEGIN
 IF p_ticket_hash IS NULL OR p_ticket_hash !~ '^[0-9a-f]{64}$' OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 SELECT * INTO t FROM pf_make_ticket WHERE token_hash=p_ticket_hash AND audience='engine' AND state='pending' AND expires_at>now() AND payload=p_payload;
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- Match the lock order used by reservation/completion to avoid deadlocks.
 PERFORM 1 FROM pf_customer WHERE account_id=p_payload->>'accountId' AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO j FROM pf_job WHERE job_id::text=p_payload->>'jobId' AND account_id=p_payload->>'accountId' FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 n:=j.attempt_count;
 SELECT * INTO d FROM pf_engine_dispatch WHERE job_id=j.job_id AND attempt=n AND payload=p_payload FOR UPDATE;
 IF NOT FOUND OR d.state<>'pending' THEN RETURN NULL; END IF;
 SELECT * INTO r FROM pf_credit_reservation WHERE job_id=j.job_id AND account_id=j.account_id AND attempt=n;
 IF NOT FOUND OR r.state<>'reserved' OR j.status NOT IN ('ACCEPTED','RETRYING') THEN RETURN NULL; END IF;
 UPDATE pf_make_ticket SET state='claimed' WHERE token_hash=p_ticket_hash AND state='pending' AND expires_at>now() AND payload=p_payload;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE pf_engine_dispatch SET state='claimed',claimed_ticket_hash=p_ticket_hash,claimed_at=now(),updated_at=now() WHERE job_id=j.job_id AND attempt=n;
 UPDATE pf_job SET status='PROCESSING',updated_at=now() WHERE job_id=j.job_id;
 UPDATE pf_job_attempt SET state='PROCESSING',started_at=now() WHERE job_id=j.job_id AND attempt=n;
 INSERT INTO pf_audit_event(event_key,account_id,job_id,action,details)
   VALUES('engine.claim:'||j.job_id||':'||n,j.account_id,j.job_id,'job.processing',jsonb_build_object('attempt',n));
 RETURN jsonb_build_object('authorized',true,'jobId',j.job_id,'accountId',j.account_id,'attempt',n,'expectedImages',j.expected_images,
   'vehicleName',j.vehicle_name,'uploadcareUrl',j.source_url,'showroomColor',j.showroom_color,'logoPlacement',j.logo_placement,'logoUrl',j.logo_url);
END; $$;
REVOKE ALL ON FUNCTION pf_enqueue_engine(text,text,uuid,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pf_claim_engine(text,jsonb) FROM PUBLIC;
INSERT INTO pf_schema_migration(version) VALUES('008-durable-engine-dispatch') ON CONFLICT DO NOTHING;
COMMIT;
