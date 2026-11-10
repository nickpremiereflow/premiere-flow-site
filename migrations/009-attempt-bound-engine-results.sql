-- Additive result authorization. Does not enable submissions or change Make.
BEGIN;
ALTER TABLE pf_engine_dispatch ADD COLUMN IF NOT EXISTS result_fingerprint text;
ALTER TABLE pf_engine_dispatch ADD COLUMN IF NOT EXISTS result jsonb;

CREATE OR REPLACE FUNCTION pf_engine_result_context(p_hash text,p_job uuid,p_attempt integer)
RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('expectedImages',j.expected_images,'status',j.status,'resultFingerprint',d.result_fingerprint)
 FROM pf_engine_dispatch d JOIN pf_job j ON j.job_id=d.job_id AND j.account_id=d.account_id
 WHERE d.claimed_ticket_hash=p_hash AND length(p_hash)=64 AND d.job_id=p_job AND d.attempt=p_attempt
   AND j.attempt_count=p_attempt AND d.state IN ('claimed','completed','failed')
   AND d.claimed_at>now()-interval '2 hours';
$$;

CREATE OR REPLACE FUNCTION pf_apply_engine_result(p_hash text,p_result jsonb,p_fingerprint text,p_assets jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE d pf_engine_dispatch; j pf_job; a jsonb; n integer; target uuid; outcome text;
BEGIN
 IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR jsonb_typeof(p_assets) IS DISTINCT FROM 'array'
    OR COALESCE(p_result->>'attempt','') !~ '^[1-3]$' OR COALESCE(p_result->>'status','') NOT IN ('COMPLETED','FAILED','RETRY_REQUIRED')
    OR COALESCE(p_result->>'jobId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN RAISE EXCEPTION 'RESULT_INVALID'; END IF;
 target:=(p_result->>'jobId')::uuid; n:=(p_result->>'attempt')::integer; outcome:=p_result->>'status';
 SELECT * INTO d FROM pf_engine_dispatch WHERE claimed_ticket_hash=p_hash AND job_id=target AND attempt=n;
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- Same account/job/dispatch lock order as intake and credit reservation.
 PERFORM 1 FROM pf_customer WHERE account_id=d.account_id FOR UPDATE;
 SELECT * INTO j FROM pf_job WHERE job_id=target AND account_id=d.account_id FOR UPDATE;
 SELECT * INTO d FROM pf_engine_dispatch WHERE job_id=target AND attempt=n AND claimed_ticket_hash=p_hash FOR UPDATE;
 IF j.attempt_count<>n OR d.claimed_at<=now()-interval '2 hours' THEN RETURN NULL; END IF;
 IF d.result_fingerprint IS NOT NULL THEN
   IF d.result_fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'RESULT_CONFLICT'; END IF;
   RETURN jsonb_build_object('received',true,'duplicate',true,'jobId',target,'status',j.status);
 END IF;
 IF d.state<>'claimed' OR j.status<>'PROCESSING' OR NOT EXISTS(SELECT 1 FROM pf_credit_reservation WHERE job_id=target AND account_id=d.account_id AND attempt=n AND state='reserved') THEN RETURN NULL; END IF;
 IF outcome='COMPLETED' THEN
   IF p_result->>'qaStatus' IS DISTINCT FROM 'PASS' OR j.expected_images IS NULL OR jsonb_array_length(p_assets)<>j.expected_images
     OR COALESCE(p_result->>'outputUrl','') !~ ('^https://5zzyp2gsg2[.]ucarecd[.]net/[0-9a-f-]{36}~'||j.expected_images||'/$')
     OR (SELECT count(DISTINCT value->>'ordinal') FROM jsonb_array_elements(p_assets))<>j.expected_images
   THEN RAISE EXCEPTION 'DELIVERY_NOT_VERIFIED'; END IF;
   -- Explicit path, ordinal, MIME and byte checks duplicate the completion gate.
   FOR a IN SELECT value FROM jsonb_array_elements(p_assets) LOOP
     IF COALESCE(a->>'ordinal','') !~ '^[0-9]$' OR (a->>'ordinal')::integer>=j.expected_images
        OR a->>'url' IS DISTINCT FROM ((p_result->>'outputUrl')||'nth/'||(a->>'ordinal')||'/')
        OR COALESCE(a->>'mimeType','') NOT IN ('image/jpeg','image/png','image/webp')
        OR COALESCE(a->>'byteSize','') !~ '^[0-9]{1,8}$' OR (a->>'byteSize')::integer NOT BETWEEN 1 AND 30000000
        OR COALESCE(a->>'sha256','') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'DELIVERY_NOT_VERIFIED'; END IF;
     INSERT INTO pf_asset(asset_id,job_id,kind,provider,attempt,ordinal,url,mime_type,byte_size,accessible_verified_at,qa_status)
       VALUES('engine:'||target||':'||n||':'||(a->>'ordinal'),target,'generated','uploadcare',n,(a->>'ordinal')::integer,a->>'url',a->>'mimeType',(a->>'byteSize')::bigint,now(),'PASS');
   END LOOP;
   UPDATE pf_job SET output_url=p_result->>'outputUrl',stored_images=j.expected_images,qa_status='PASS',qa_notes=COALESCE(p_result->>'qaNotes',''),error_stage=NULL,error_code=NULL,error_details=NULL WHERE job_id=target;
   PERFORM pf_finish_credit(d.account_id,target,n,true);
 ELSE
   IF jsonb_array_length(p_assets)<>0 OR COALESCE(p_result->>'outputUrl','')<>''
      OR COALESCE(p_result->>'qaStatus','') NOT IN ('PENDING','FAIL','REVIEW')
      OR COALESCE(p_result->>'errorStage','')='' OR COALESCE(p_result->>'errorCode','')='' THEN RAISE EXCEPTION 'RESULT_INVALID'; END IF;
   IF n=3 THEN outcome:='FAILED'; END IF;
   UPDATE pf_job SET status=outcome,qa_status=p_result->>'qaStatus',qa_notes=COALESCE(p_result->>'qaNotes',''),
     error_stage=p_result->>'errorStage',error_code=p_result->>'errorCode',error_details=COALESCE(p_result->>'errorDetails',''),
     next_retry_at=CASE WHEN outcome='RETRY_REQUIRED' THEN (p_result->>'nextRetryAt')::timestamptz ELSE NULL END,updated_at=now() WHERE job_id=target;
   PERFORM pf_finish_credit(d.account_id,target,n,false);
   UPDATE pf_job_attempt SET qa_status=p_result->>'qaStatus' WHERE job_id=target AND attempt=n;
 END IF;
 UPDATE pf_engine_dispatch SET state=CASE WHEN outcome='COMPLETED' THEN 'completed' ELSE 'failed' END,result_fingerprint=p_fingerprint,result=p_result,updated_at=now() WHERE job_id=target AND attempt=n;
 INSERT INTO pf_audit_event(event_key,account_id,job_id,action,details)
   VALUES('engine.result:'||target||':'||n,d.account_id,target,'job.'||lower(outcome),jsonb_build_object('attempt',n,'status',outcome));
 -- Notification delivery is separate from completion and cannot charge again.
 INSERT INTO pf_command(command_id,kind,account_id,payload)
   VALUES('job-result:'||target||':'||n,'job_notification',d.account_id,jsonb_build_object('jobId',target,'attempt',n,'status',outcome)) ON CONFLICT DO NOTHING;
 RETURN jsonb_build_object('received',true,'duplicate',false,'jobId',target,'status',outcome);
END; $$;
REVOKE ALL ON FUNCTION pf_engine_result_context(text,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION pf_apply_engine_result(text,jsonb,text,jsonb) FROM PUBLIC;
INSERT INTO pf_schema_migration(version) VALUES('009-attempt-bound-engine-results') ON CONFLICT DO NOTHING;
COMMIT;
