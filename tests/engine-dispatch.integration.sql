-- Preview database only. No Make call. Every fixture and credit movement rolls back.
BEGIN;
DO $$
DECLARE a text:='PF-ACCEPTANCE-A-20261103'; b text:='PF-ACCEPTANCE-B-20261103';
  id uuid:='c0000000-0000-4000-8000-000000000008'; uid text; uid_b text; email text;
  p jsonb; retry jsonb; result jsonb; balance_before integer; zero_id uuid:='c0000000-0000-4000-8000-000000000009';
BEGIN
 SELECT c.user_id,u.email INTO uid,email FROM pf_customer c JOIN pf_user u ON u.id=c.user_id WHERE c.account_id=a;
 SELECT user_id INTO uid_b FROM pf_customer WHERE account_id=b;
 IF uid IS NULL OR uid_b IS NULL THEN RAISE EXCEPTION 'Controlled accounts missing'; END IF;
 SELECT available INTO balance_before FROM pf_credit_balance WHERE account_id=a;
 p:=jsonb_build_object('action','submit','accountId',a,'email',email,'jobId',id::text,'expectedAttempt','',
   'vehicleName','Temporary durable-dispatch acceptance','assetSource','Upload','showroomColor','White (default)',
   'logoPlacement','No Logo','thumbnail','','uploadcareUrl','https://5zzyp2gsg2.ucarecd.net/c0000000-0000-4000-8000-000000000008~1/','sendEmail','true');
 -- No balance means no durable job/attempt/dispatch is left behind.
 INSERT INTO pf_credit_ledger(entry_key,account_id,kind,amount,reason) VALUES('dispatch-zero-balance-fixture',a,'adjustment',-balance_before,'Temporary rollback-only acceptance');
 BEGIN
   PERFORM pf_enqueue_engine(a,uid,zero_id,repeat('f',64),p||jsonb_build_object('jobId',zero_id::text));
   RAISE EXCEPTION 'Zero-credit request accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'NO_CREDITS' THEN RAISE; END IF; END;
 IF EXISTS(SELECT 1 FROM pf_job WHERE job_id=zero_id) OR EXISTS(SELECT 1 FROM pf_engine_dispatch WHERE job_id=zero_id) THEN RAISE EXCEPTION 'Failed intake left a partial job'; END IF;
 DELETE FROM pf_credit_ledger WHERE entry_key='dispatch-zero-balance-fixture';
 result:=pf_enqueue_engine(a,uid,id,repeat('a',64),p);
 IF (result->>'created') IS DISTINCT FROM 'true' OR (result->>'attempt') IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'First submission not accepted'; END IF;
 IF (pf_enqueue_engine(a,uid,id,repeat('a',64),p)->>'created') IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Duplicate submission accepted twice'; END IF;
 IF (SELECT count(*) FROM pf_engine_dispatch WHERE job_id=id)<>1 OR (SELECT available FROM pf_credit_balance WHERE account_id=a)<>balance_before-1 THEN RAISE EXCEPTION 'Submission did not reserve exactly once'; END IF;
 BEGIN
   PERFORM pf_enqueue_engine(a,uid_b,id,repeat('a',64),p);
   RAISE EXCEPTION 'Foreign user accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'ACCOUNT_UNAVAILABLE' THEN RAISE; END IF; END;
 BEGIN
   PERFORM pf_enqueue_engine(b,uid_b,id,repeat('b',64),p||jsonb_build_object('accountId',b,'email',(SELECT u.email FROM pf_user u WHERE u.id=uid_b)));
   RAISE EXCEPTION 'Foreign account accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'JOB_CONFLICT' THEN RAISE; END IF; END;
 BEGIN
   PERFORM pf_enqueue_engine(a,uid,id,repeat('c',64),p||'{"vehicleName":"Changed request"}'::jsonb);
   RAISE EXCEPTION 'Changed duplicate accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'JOB_CONFLICT' THEN RAISE; END IF; END;

 -- Simulate a lost acknowledgement: two independently issued delivery tickets.
 INSERT INTO pf_make_ticket(token_hash,audience,payload,expires_at) VALUES
   (repeat('1',64),'engine',p,now()+interval '15 minutes'),
   (repeat('2',64),'engine',p,now()+interval '15 minutes'),
   (repeat('3',64),'engine',p,now()-interval '1 second');
 IF pf_claim_engine(repeat('3',64),p) IS NOT NULL THEN RAISE EXCEPTION 'Expired ticket accepted'; END IF;
 IF pf_claim_engine(repeat('1',64),p||'{"sendEmail":"false"}'::jsonb) IS NOT NULL THEN RAISE EXCEPTION 'Changed ticket payload accepted'; END IF;
 result:=pf_claim_engine(repeat('1',64),p);
 IF (result->>'authorized') IS DISTINCT FROM 'true' OR (result->>'attempt') IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'First valid ticket did not claim'; END IF;
 IF pf_claim_engine(repeat('1',64),p) IS NOT NULL OR pf_claim_engine(repeat('2',64),p) IS NOT NULL THEN RAISE EXCEPTION 'Duplicate engine execution authorized'; END IF;
 IF (SELECT available FROM pf_credit_balance WHERE account_id=a)<>balance_before-1 THEN RAISE EXCEPTION 'Claim changed balance'; END IF;

 -- Controlled failure releases the existing reservation; retry keeps the same job.
 UPDATE pf_job SET status='RETRY_REQUIRED',error_stage='Synthetic test',error_code='TEST_FAILURE',next_retry_at=now()+interval '1 minute' WHERE job_id=id;
 PERFORM pf_finish_credit(a,id,1,false);
 IF (SELECT available FROM pf_credit_balance WHERE account_id=a)<>balance_before THEN RAISE EXCEPTION 'Failure did not release credit'; END IF;
 retry:=p||jsonb_build_object('action','retry','expectedAttempt','1','vehicleName','','assetSource','','showroomColor','','logoPlacement','','thumbnail','','uploadcareUrl','');
 BEGIN
   PERFORM pf_enqueue_engine(a,uid,id,repeat('d',64),retry);
   RAISE EXCEPTION 'Provider retry time ignored';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'JOB_NOT_RETRYABLE' THEN RAISE; END IF; END;
 UPDATE pf_job SET next_retry_at=now()-interval '1 second' WHERE job_id=id;
 result:=pf_enqueue_engine(a,uid,id,repeat('d',64),retry);
 IF (result->>'attempt') IS DISTINCT FROM '2' OR (result->>'created') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Same-job retry missing'; END IF;
 IF (pf_enqueue_engine(a,uid,id,repeat('d',64),retry)->>'created') IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Duplicate retry charged'; END IF;
 IF (SELECT count(*) FROM pf_job WHERE job_id=id)<>1 OR (SELECT count(*) FROM pf_engine_dispatch WHERE job_id=id)<>2 THEN RAISE EXCEPTION 'Retry identity changed'; END IF;
 IF (SELECT available FROM pf_credit_balance WHERE account_id=a)<>balance_before-1 THEN RAISE EXCEPTION 'Retry charged twice'; END IF;
 IF (SELECT source_url FROM pf_job WHERE job_id=id)<>p->>'uploadcareUrl' THEN RAISE EXCEPTION 'Retry replaced source'; END IF;
 IF pf_claim_engine(repeat('2',64),p) IS NOT NULL THEN RAISE EXCEPTION 'Stale attempt entered new run'; END IF;
 INSERT INTO pf_make_ticket(token_hash,audience,payload,expires_at) VALUES(repeat('4',64),'engine',retry,now()+interval '15 minutes');
 IF (pf_claim_engine(repeat('4',64),retry)->>'attempt') IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'Retry claim missing'; END IF;
 UPDATE pf_job SET error_stage='Synthetic retry',error_code='TEST_FAILURE' WHERE job_id=id;
 PERFORM pf_finish_credit(a,id,2,false);
 IF (SELECT available FROM pf_credit_balance WHERE account_id=a)<>balance_before THEN RAISE EXCEPTION 'Second failure lost credit'; END IF;
END $$;
SELECT 'PASS: atomic intake; one job/credit; account isolation; duplicate/expired/altered/stale claims blocked; bounded same-job retry; failure credits restored' AS dispatch_acceptance;
ROLLBACK;
SELECT account_id,available,reserved,consumed,
 (SELECT count(*) FROM pf_job WHERE job_id='c0000000-0000-4000-8000-000000000008') AS fixture_rows_remaining
FROM pf_credit_balance WHERE account_id IN ('PF-ACCEPTANCE-A-20261103','PF-ACCEPTANCE-B-20261103','PF-TEST-999') ORDER BY account_id;
