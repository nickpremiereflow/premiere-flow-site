-- Storage-only adaptation of the accepted 008/009 functions. No ledger changes.
-- Additive manifests from 011 must exist first. Historical Uploadcare URLs remain valid.
BEGIN;
CREATE OR REPLACE FUNCTION pf_enqueue_engine(p_account text,p_user text,p_job uuid,p_fingerprint text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c pf_customer; j pf_job; d pf_engine_dispatch; n integer; unlimited boolean;
        expected integer; source_count integer; source_group pf_media_group;
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
   IF COALESCE(p_payload->>'vehicleName','')='' OR COALESCE(p_payload->>'expectedAttempt','')<>'' THEN RAISE EXCEPTION 'PAYLOAD_INVALID'; END IF;
   IF position('/api/media/groups/' in COALESCE(p_payload->>'uploadcareUrl',''))>0 THEN
     SELECT * INTO source_group FROM pf_media_group WHERE canonical_url=p_payload->>'uploadcareUrl'
       AND account_id=p_account AND kind='source' AND state='sealed' FOR UPDATE;
     IF NOT FOUND OR source_group.job_id IS NOT NULL THEN RAISE EXCEPTION 'PAYLOAD_INVALID'; END IF;
     source_count:=source_group.expected_files;
     IF (SELECT count(*) FROM pf_media_object WHERE group_id=source_group.group_id AND account_id=p_account
           AND role='source' AND state='verified' AND ordinal<source_count)<>source_count
        OR (SELECT count(*) FROM pf_media_object WHERE group_id=source_group.group_id AND account_id=p_account
           AND role='source_preview' AND declared_mime='image/jpeg' AND state='verified' AND ordinal<source_count)<>source_count
        OR NOT EXISTS(SELECT 1 FROM generate_series(0,source_count-1) i WHERE p_payload->>'thumbnail'=source_group.canonical_url||'nth/'||i||'/')
       THEN RAISE EXCEPTION 'PAYLOAD_INVALID'; END IF;
   ELSE
     IF COALESCE(p_payload->>'uploadcareUrl','') !~ '^https://5zzyp2gsg2[.]ucarecd[.]net/[0-9a-f-]{36}~([1-9]|10)/$'
       THEN RAISE EXCEPTION 'PAYLOAD_INVALID'; END IF;
     source_count:=substring(p_payload->>'uploadcareUrl' FROM '~([0-9]+)/$')::integer;
   END IF;
   INSERT INTO pf_job(job_id,account_id,fingerprint,payload,vehicle_name,showroom_color,logo_placement,logo_url,source_url,thumbnail_url,expected_images)
     VALUES(p_job,p_account,p_fingerprint,p_payload,p_payload->>'vehicleName',p_payload->>'showroomColor',p_payload->>'logoPlacement',
       CASE WHEN p_payload->>'logoPlacement'='No Logo' THEN '' ELSE c.logo_url END,p_payload->>'uploadcareUrl',COALESCE(p_payload->>'thumbnail',''),source_count);
   IF source_group.group_id IS NOT NULL THEN
     UPDATE pf_media_group SET job_id=p_job WHERE group_id=source_group.group_id;
   END IF;
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

CREATE OR REPLACE FUNCTION pf_apply_engine_result(p_hash text,p_result jsonb,p_fingerprint text,p_assets jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE d pf_engine_dispatch; j pf_job; a jsonb; n integer; target uuid; outcome text; output_group pf_media_group; storage_provider text;
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
     OR (SELECT count(DISTINCT value->>'ordinal') FROM jsonb_array_elements(p_assets))<>j.expected_images
   THEN RAISE EXCEPTION 'DELIVERY_NOT_VERIFIED'; END IF;
   IF position('/api/media/groups/' in COALESCE(p_result->>'outputUrl',''))>0 THEN
     SELECT * INTO output_group FROM pf_media_group WHERE canonical_url=p_result->>'outputUrl'
       AND account_id=d.account_id AND job_id=target AND attempt=n AND kind='generated' AND state='sealed' FOR UPDATE;
     IF NOT FOUND OR output_group.expected_files<>j.expected_images
        OR (SELECT count(*) FROM pf_media_object WHERE group_id=output_group.group_id AND role='generated'
             AND account_id=d.account_id AND state='verified' AND ordinal<j.expected_images)<>j.expected_images
       THEN RAISE EXCEPTION 'DELIVERY_NOT_VERIFIED'; END IF;
     storage_provider:='r2';
   ELSE
     IF COALESCE(p_result->>'outputUrl','') !~ ('^https://5zzyp2gsg2[.]ucarecd[.]net/[0-9a-f-]{36}~'||j.expected_images||'/$')
       THEN RAISE EXCEPTION 'DELIVERY_NOT_VERIFIED'; END IF;
     storage_provider:='uploadcare';
   END IF;
   -- Explicit path, ordinal, MIME and byte checks duplicate the completion gate.
   FOR a IN SELECT value FROM jsonb_array_elements(p_assets) LOOP
     IF COALESCE(a->>'ordinal','') !~ '^[0-9]$' OR (a->>'ordinal')::integer>=j.expected_images
        OR a->>'url' IS DISTINCT FROM ((p_result->>'outputUrl')||'nth/'||(a->>'ordinal')||'/')
        OR COALESCE(a->>'mimeType','') NOT IN ('image/jpeg','image/png','image/webp')
        OR COALESCE(a->>'byteSize','') !~ '^[0-9]{1,8}$' OR (a->>'byteSize')::integer NOT BETWEEN 1 AND 30000000
        OR COALESCE(a->>'sha256','') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'DELIVERY_NOT_VERIFIED'; END IF;
     IF storage_provider='r2' AND NOT EXISTS(SELECT 1 FROM pf_media_object WHERE group_id=output_group.group_id
          AND account_id=d.account_id AND role='generated' AND state='verified' AND ordinal=(a->>'ordinal')::integer
          AND declared_mime=a->>'mimeType' AND byte_size=(a->>'byteSize')::bigint AND sha256=a->>'sha256')
       THEN RAISE EXCEPTION 'DELIVERY_NOT_VERIFIED'; END IF;
     INSERT INTO pf_asset(asset_id,job_id,kind,provider,attempt,ordinal,url,mime_type,byte_size,accessible_verified_at,qa_status)
       VALUES('engine:'||target||':'||n||':'||(a->>'ordinal'),target,'generated',storage_provider,n,(a->>'ordinal')::integer,a->>'url',a->>'mimeType',(a->>'byteSize')::bigint,now(),'PASS');
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
REVOKE ALL ON FUNCTION pf_enqueue_engine(text,text,uuid,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pf_apply_engine_result(text,jsonb,text,jsonb) FROM PUBLIC;
INSERT INTO pf_schema_migration(version) VALUES('012-media-job-binding') ON CONFLICT DO NOTHING;
COMMIT;
