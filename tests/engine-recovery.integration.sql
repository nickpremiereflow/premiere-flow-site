-- Preview only: synthetic jobs, no provider calls, every change rolls back.
BEGIN;
DO $$
DECLARE a text:='PF-ACCEPTANCE-A-20261103'; b text:='PF-ACCEPTANCE-B-20261103';
 id uuid:='c0000000-0000-4000-8000-000000000011'; done_id uuid:='c0000000-0000-4000-8000-000000000012';
 uid text; email text; p jsonb; retry jsonb; result jsonb; before_balance integer;
 output text:='https://5zzyp2gsg2.ucarecd.net/c0000000-0000-4000-8000-000000000011~1/';
BEGIN
 SELECT c.user_id,u.email INTO uid,email FROM pf_customer c JOIN pf_user u ON u.id=c.user_id WHERE c.account_id=a;
 SELECT available INTO before_balance FROM pf_credit_balance WHERE account_id=a;
 IF uid IS NULL THEN RAISE EXCEPTION 'Controlled account missing'; END IF;
 p:=jsonb_build_object('action','submit','accountId',a,'email',email,'jobId',id::text,'expectedAttempt','','vehicleName','Temporary timeout acceptance',
  'assetSource','Upload','showroomColor','White (default)','logoPlacement','No Logo','thumbnail','','uploadcareUrl',output,'sendEmail','true');
 PERFORM pf_enqueue_engine(a,uid,id,repeat('a',64),p);
 INSERT INTO pf_make_ticket(token_hash,audience,payload,expires_at) VALUES(repeat('7',64),'engine',p,now()+interval '15 minutes');
 IF pf_expire_engine(a,id,1) THEN RAISE EXCEPTION 'Fresh pending attempt expired'; END IF;
 UPDATE pf_engine_dispatch SET created_at=now()-interval '31 minutes' WHERE job_id=id;
 IF pf_expire_engine(b,id,1) THEN RAISE EXCEPTION 'Wrong account recovered job'; END IF;
 IF NOT pf_expire_engine(a,id,1) THEN RAISE EXCEPTION 'Stuck pending job not recovered'; END IF;
 IF pf_expire_engine(a,id,1) THEN RAISE EXCEPTION 'Repeated recovery applied twice'; END IF;
 IF (SELECT available FROM pf_credit_balance WHERE account_id=a)<>before_balance
    OR (SELECT status FROM pf_job WHERE job_id=id)<>'RETRY_REQUIRED'
    OR (SELECT error_code FROM pf_job WHERE job_id=id)<>'ENGINE_DISPATCH_TIMEOUT'
    OR (SELECT state FROM pf_engine_dispatch WHERE job_id=id AND attempt=1)<>'expired'
 THEN RAISE EXCEPTION 'Dispatch timeout status or credit incorrect'; END IF;
 IF pf_claim_engine(repeat('7',64),p) IS NOT NULL THEN RAISE EXCEPTION 'Expired queue item entered engine'; END IF;
 IF (SELECT count(*) FROM pf_credit_ledger WHERE job_id=id AND kind='release')<>1
    OR (SELECT count(*) FROM pf_command WHERE command_id='job-result:'||id||':1')<>1
 THEN RAISE EXCEPTION 'Timeout release or notification duplicated'; END IF;

 retry:=p||jsonb_build_object('action','retry','expectedAttempt','1','vehicleName','','assetSource','','showroomColor','','logoPlacement','','thumbnail','','uploadcareUrl','');
 PERFORM pf_enqueue_engine(a,uid,id,repeat('b',64),retry);
 INSERT INTO pf_make_ticket(token_hash,audience,payload,expires_at) VALUES(repeat('8',64),'engine',retry,now()+interval '15 minutes');
 PERFORM pf_claim_engine(repeat('8',64),retry);
 IF pf_expire_engine(a,id,1) OR pf_expire_engine(a,id,2) THEN RAISE EXCEPTION 'Stale recovery expired new live attempt'; END IF;
 UPDATE pf_engine_dispatch SET claimed_at=now()-interval '121 minutes' WHERE job_id=id AND attempt=2;
 IF NOT pf_expire_engine(a,id,2) THEN RAISE EXCEPTION 'Stuck processing job not recovered'; END IF;
 IF (SELECT available FROM pf_credit_balance WHERE account_id=a)<>before_balance
    OR (SELECT error_code FROM pf_job WHERE job_id=id)<>'ENGINE_RESULT_TIMEOUT'
    OR (SELECT qa_status FROM pf_job_attempt WHERE job_id=id AND attempt=2)<>'REVIEW'
 THEN RAISE EXCEPTION 'Processing timeout metadata or credit incorrect'; END IF;
 result:=jsonb_build_object('jobId',id,'attempt',2,'status','FAILED','qaStatus','REVIEW','outputUrl','','errorStage','Test','errorCode','LATE_RESULT');
 IF pf_engine_result_context(repeat('8',64),id,2) IS NOT NULL
    OR pf_apply_engine_result(repeat('8',64),result,repeat('c',64),'[]') IS NOT NULL
 THEN RAISE EXCEPTION 'Late expired callback accepted'; END IF;

 retry:=retry||'{"expectedAttempt":"2"}'::jsonb;
 PERFORM pf_enqueue_engine(a,uid,id,repeat('c',64),retry);
 INSERT INTO pf_make_ticket(token_hash,audience,payload,expires_at) VALUES(repeat('9',64),'engine',retry,now()+interval '15 minutes');
 PERFORM pf_claim_engine(repeat('9',64),retry);
 UPDATE pf_engine_dispatch SET claimed_at=now()-interval '121 minutes' WHERE job_id=id AND attempt=3;
 IF NOT pf_expire_engine(a,id,3) THEN RAISE EXCEPTION 'Final timeout not recovered'; END IF;
 -- Read after the mutating call, in a separate statement/snapshot.
 IF (SELECT status FROM pf_job WHERE job_id=id)<>'FAILED' THEN RAISE EXCEPTION 'Final timeout not bounded'; END IF;
 BEGIN
   PERFORM pf_enqueue_engine(a,uid,id,repeat('d',64),retry||'{"expectedAttempt":"3"}'::jsonb);
   RAISE EXCEPTION 'Fourth attempt accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'ATTEMPT_INVALID' THEN RAISE; END IF; END;
 IF (SELECT count(*) FROM pf_job WHERE job_id=id)<>1 OR (SELECT count(*) FROM pf_credit_ledger WHERE job_id=id AND kind='release')<>3
    OR (SELECT available FROM pf_credit_balance WHERE account_id=a)<>before_balance THEN RAISE EXCEPTION 'Timeout retries duplicated job or lost credit'; END IF;

 -- A completion that wins before recovery must keep its delivery and charge.
 p:=p||jsonb_build_object('jobId',done_id::text);
 PERFORM pf_enqueue_engine(a,uid,done_id,repeat('d',64),p);
 INSERT INTO pf_make_ticket(token_hash,audience,payload,expires_at) VALUES(repeat('0',64),'engine',p,now()+interval '15 minutes');
 PERFORM pf_claim_engine(repeat('0',64),p);
 PERFORM pf_apply_engine_result(repeat('0',64),jsonb_build_object('jobId',done_id,'attempt',1,'status','COMPLETED','qaStatus','PASS','outputUrl',output),repeat('e',64),
   jsonb_build_array(jsonb_build_object('ordinal',0,'url',output||'nth/0/','mimeType','image/png','byteSize',10000,'sha256',repeat('e',64))));
 UPDATE pf_engine_dispatch SET claimed_at=now()-interval '3 hours',created_at=now()-interval '4 hours' WHERE job_id=done_id;
 IF pf_expire_engine(a,done_id,1) OR (SELECT status FROM pf_job WHERE job_id=done_id)<>'COMPLETED'
    OR (SELECT available FROM pf_credit_balance WHERE account_id=a)<>before_balance-1
    OR (SELECT count(*) FROM pf_credit_ledger WHERE job_id=done_id AND kind='consume')<>1
 THEN RAISE EXCEPTION 'Recovery damaged completed delivery'; END IF;
END $$;
SELECT 'PASS: queued and processing timeouts release once; late claims/results denied; active/completed jobs preserved; retries keep identity and stop after three attempts' AS recovery_acceptance;
ROLLBACK;
SELECT account_id,available,reserved,consumed FROM pf_credit_balance ORDER BY account_id;
