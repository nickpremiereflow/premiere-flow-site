-- Preview only; synthetic metadata, no provider requests, every change rolls back.
BEGIN;
DO $$
DECLARE a text:='PF-ACCEPTANCE-A-20261103'; id uuid:='c0000000-0000-4000-8000-000000000010';
 uid text; email text; p jsonb; retry jsonb; failed jsonb; completed jsonb; assets jsonb;
 result jsonb; before_balance integer; output text:='https://5zzyp2gsg2.ucarecd.net/c0000000-0000-4000-8000-000000000010~2/';
BEGIN
 SELECT c.user_id,u.email INTO uid,email FROM pf_customer c JOIN pf_user u ON u.id=c.user_id WHERE c.account_id=a;
 SELECT available INTO before_balance FROM pf_credit_balance WHERE account_id=a;
 IF uid IS NULL THEN RAISE EXCEPTION 'Controlled account missing'; END IF;
 p:=jsonb_build_object('action','submit','accountId',a,'email',email,'jobId',id::text,'expectedAttempt','','vehicleName','Temporary result acceptance',
   'assetSource','Upload','showroomColor','White (default)','logoPlacement','No Logo','thumbnail','','uploadcareUrl',output,'sendEmail','true');
 PERFORM pf_enqueue_engine(a,uid,id,repeat('a',64),p);
 INSERT INTO pf_make_ticket(token_hash,audience,payload,expires_at) VALUES(repeat('5',64),'engine',p,now()+interval '15 minutes');
 IF pf_engine_result_context(repeat('5',64),id,1) IS NOT NULL THEN RAISE EXCEPTION 'Unclaimed ticket accepted'; END IF;
 PERFORM pf_claim_engine(repeat('5',64),p);
 failed:=jsonb_build_object('jobId',id,'attempt',1,'status','RETRY_REQUIRED','outputUrl','','qaStatus','FAIL','qaNotes','Controlled QA rejection',
   'errorStage','QA','errorCode','QUALITY_FAIL','errorDetails','Synthetic rollback-only failure','nextRetryAt',now()+interval '5 minutes');
 IF pf_apply_engine_result(repeat('6',64),failed,repeat('b',64),'[]') IS NOT NULL THEN RAISE EXCEPTION 'Foreign ticket accepted'; END IF;
 result:=pf_apply_engine_result(repeat('5',64),failed,repeat('b',64),'[]');
 IF result->>'status' IS DISTINCT FROM 'RETRY_REQUIRED' OR (SELECT available FROM pf_credit_balance WHERE account_id=a)<>before_balance THEN RAISE EXCEPTION 'Failure did not release reservation'; END IF;
 IF (SELECT qa_status FROM pf_job_attempt WHERE job_id=id AND attempt=1)<>'FAIL' THEN RAISE EXCEPTION 'QA rejection missing from attempt'; END IF;
 IF pf_apply_engine_result(repeat('5',64),failed,repeat('b',64),'[]')->>'duplicate' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Duplicate failure applied twice'; END IF;
 BEGIN
   PERFORM pf_apply_engine_result(repeat('5',64),failed||'{"errorCode":"CHANGED"}'::jsonb,repeat('c',64),'[]');
   RAISE EXCEPTION 'Conflicting result accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'RESULT_CONFLICT' THEN RAISE; END IF; END;
 retry:=p||jsonb_build_object('action','retry','expectedAttempt','1','vehicleName','','assetSource','','showroomColor','','logoPlacement','','thumbnail','','uploadcareUrl','');
 BEGIN
   PERFORM pf_enqueue_engine(a,uid,id,repeat('d',64),retry);
   RAISE EXCEPTION 'Retry timing ignored';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'JOB_NOT_RETRYABLE' THEN RAISE; END IF; END;
 UPDATE pf_job SET next_retry_at=now()-interval '1 second' WHERE job_id=id;
 PERFORM pf_enqueue_engine(a,uid,id,repeat('d',64),retry);
 IF pf_engine_result_context(repeat('5',64),id,1) IS NOT NULL OR pf_apply_engine_result(repeat('5',64),failed,repeat('b',64),'[]') IS NOT NULL THEN RAISE EXCEPTION 'Stale callback changed retry'; END IF;
 INSERT INTO pf_make_ticket(token_hash,audience,payload,expires_at) VALUES(repeat('6',64),'engine',retry,now()+interval '15 minutes');
 PERFORM pf_claim_engine(repeat('6',64),retry);
 UPDATE pf_engine_dispatch SET claimed_at=now()-interval '3 hours' WHERE job_id=id AND attempt=2;
 IF pf_engine_result_context(repeat('6',64),id,2) IS NOT NULL THEN RAISE EXCEPTION 'Expired result ticket accepted'; END IF;
 UPDATE pf_engine_dispatch SET claimed_at=now() WHERE job_id=id AND attempt=2;
 completed:=jsonb_build_object('jobId',id,'attempt',2,'status','COMPLETED','outputUrl',output,'qaStatus','PASS','qaNotes','Controlled PASS');
 assets:=jsonb_build_array(jsonb_build_object('ordinal',0,'url',output||'nth/0/','mimeType','image/png','byteSize',10000,'sha256',repeat('e',64)),
   jsonb_build_object('ordinal',1,'url',output||'nth/1/','mimeType','image/png','byteSize',12000,'sha256',repeat('f',64)));
 BEGIN
   PERFORM pf_apply_engine_result(repeat('6',64),completed,repeat('e',64),jsonb_build_array(assets->0));
   RAISE EXCEPTION 'Partial output accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'DELIVERY_NOT_VERIFIED' THEN RAISE; END IF; END;
 BEGIN
   PERFORM pf_apply_engine_result(repeat('6',64),completed,repeat('e',64),jsonb_build_array(assets->0,assets->0));
   RAISE EXCEPTION 'Duplicate ordinal accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'DELIVERY_NOT_VERIFIED' THEN RAISE; END IF; END;
 BEGIN
   PERFORM pf_apply_engine_result(repeat('6',64),completed||'{"qaStatus":"FAIL"}'::jsonb,repeat('e',64),assets);
   RAISE EXCEPTION 'Failed QA completed';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'DELIVERY_NOT_VERIFIED' THEN RAISE; END IF; END;
 IF (SELECT status FROM pf_job WHERE job_id=id)<>'PROCESSING' OR (SELECT count(*) FROM pf_asset WHERE job_id=id)<>0 THEN RAISE EXCEPTION 'Rejected completion left partial data'; END IF;
 result:=pf_apply_engine_result(repeat('6',64),completed,repeat('e',64),assets);
 IF result->>'status' IS DISTINCT FROM 'COMPLETED' OR (SELECT available FROM pf_credit_balance WHERE account_id=a)<>before_balance-1 THEN RAISE EXCEPTION 'Verified completion did not consume once'; END IF;
 IF pf_apply_engine_result(repeat('6',64),completed,repeat('e',64),assets)->>'duplicate' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Duplicate completion applied twice'; END IF;
 IF (SELECT count(*) FROM pf_credit_ledger WHERE job_id=id AND kind='consume')<>1 OR (SELECT count(*) FROM pf_asset WHERE job_id=id)<>2 THEN RAISE EXCEPTION 'Repeated result duplicated credit/assets'; END IF;
 IF (SELECT count(*) FROM pf_command WHERE command_id='job-result:'||id||':2')<>1 THEN RAISE EXCEPTION 'Completion notification not queued once'; END IF;
END $$;
SELECT 'PASS: claimed attempt only; stale/foreign/expired callbacks rejected; failed QA releases credit; provider timing respected; partial or duplicate images rejected; successful delivery and notification recorded once' AS result_acceptance;
ROLLBACK;
SELECT account_id,available,reserved,consumed FROM pf_credit_balance ORDER BY account_id;
