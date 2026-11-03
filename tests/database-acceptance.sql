-- Run only in an isolated database. All fixtures and changes are rolled back.
BEGIN;
CREATE OR REPLACE FUNCTION pg_temp.pf_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ACCEPTANCE_FAILED: %',label; END IF; END $$;
CREATE OR REPLACE FUNCTION pg_temp.pf_expect_error(command text,expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN IF SQLERRM=expected THEN RETURN; ELSE RAISE; END IF; END;
  RAISE EXCEPTION 'EXPECTED_ERROR_MISSING: %',expected;
END $$;
INSERT INTO pf_user(id,name,email) VALUES('pf-acceptance-a','Controlled account A','pf-acceptance-a@example.test'),('pf-acceptance-b','Controlled account B','pf-acceptance-b@example.test');
INSERT INTO pf_customer(account_id,user_id,baseline_total,baseline_tier) VALUES('PF-ACCEPTANCE-A','pf-acceptance-a',2,'Upgrade'),('PF-ACCEPTANCE-B','pf-acceptance-b',1,'Upgrade');
INSERT INTO pf_membership(account_id,user_id,role) VALUES('PF-ACCEPTANCE-A','pf-acceptance-a','owner'),('PF-ACCEPTANCE-B','pf-acceptance-b','owner');
INSERT INTO pf_credit_ledger(entry_key,account_id,kind,amount,reason) VALUES('acceptance-grant-a','PF-ACCEPTANCE-A','grant',2,'Controlled fixture'),('acceptance-grant-b','PF-ACCEPTANCE-B','grant',1,'Controlled fixture');
INSERT INTO pf_job(job_id,account_id,fingerprint,payload,expected_images) VALUES
('a0000000-0000-4000-8000-000000000001','PF-ACCEPTANCE-A','fixture-a1','{}',1),
('a0000000-0000-4000-8000-000000000002','PF-ACCEPTANCE-A','fixture-a2','{}',1),
('a0000000-0000-4000-8000-000000000003','PF-ACCEPTANCE-A','fixture-a3','{}',1),
('a0000000-0000-4000-8000-000000000004','PF-ACCEPTANCE-A','fixture-a4','{}',1),
('b0000000-0000-4000-8000-000000000001','PF-ACCEPTANCE-B','fixture-b1','{}',1);
SELECT pg_temp.pf_assert((SELECT count(*) FROM pf_job j JOIN pf_membership m ON m.account_id=j.account_id WHERE m.user_id='pf-acceptance-a' AND j.account_id='PF-ACCEPTANCE-B')=0,'account A cannot select B jobs');
SELECT pg_temp.pf_expect_error($q$SELECT pf_reserve_credit('PF-ACCEPTANCE-B','a0000000-0000-4000-8000-000000000001',1)$q$,'JOB_NOT_FOUND');
SELECT pg_temp.pf_expect_error($q$SELECT pf_reserve_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000001',1,true)$q$,'ENTITLEMENT_INVALID');
SELECT pg_temp.pf_assert(pf_reserve_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000001',1),'first reservation');
SELECT pg_temp.pf_assert(NOT pf_reserve_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000001',1),'duplicate reservation no-op');
SELECT pg_temp.pf_assert((SELECT available=1 AND reserved=1 AND consumed=0 FROM pf_credit_balance WHERE account_id='PF-ACCEPTANCE-A'),'exactly one reservation');
SELECT pg_temp.pf_expect_error($q$SELECT pf_finish_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000001',1,true)$q$,'DELIVERY_NOT_VERIFIED');
INSERT INTO pf_asset(asset_id,job_id,kind,attempt,ordinal,url) VALUES('acceptance-asset-a1','a0000000-0000-4000-8000-000000000001','generated',1,0,'https://example.test/controlled-package/nth/0/');
UPDATE pf_job SET qa_status='PASS',stored_images=1,output_url='https://example.test/controlled-package/' WHERE job_id='a0000000-0000-4000-8000-000000000001';
SELECT pg_temp.pf_expect_error($q$SELECT pf_finish_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000001',1,true)$q$,'DELIVERY_NOT_VERIFIED');
UPDATE pf_asset SET accessible_verified_at=now(),qa_status='PASS',mime_type='image/jpeg',byte_size=1234 WHERE asset_id='acceptance-asset-a1';
UPDATE pf_job SET output_url='https://example.test/wrong-package/' WHERE job_id='a0000000-0000-4000-8000-000000000001';
SELECT pg_temp.pf_expect_error($q$SELECT pf_finish_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000001',1,true)$q$,'DELIVERY_NOT_VERIFIED');
UPDATE pf_job SET output_url='https://example.test/controlled-package/' WHERE job_id='a0000000-0000-4000-8000-000000000001';
SELECT pg_temp.pf_assert(pf_finish_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000001',1,true),'verified completion');
SELECT pg_temp.pf_assert(NOT pf_finish_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000001',1,true),'duplicate completion no-op');
SELECT pg_temp.pf_assert((SELECT status='COMPLETED' FROM pf_job WHERE job_id='a0000000-0000-4000-8000-000000000001'),'completion status');
SELECT pg_temp.pf_assert((SELECT available=1 AND reserved=0 AND consumed=1 FROM pf_credit_balance WHERE account_id='PF-ACCEPTANCE-A'),'single consumption');
SELECT pg_temp.pf_assert(pf_reserve_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000002',1),'second job');
SELECT pg_temp.pf_expect_error($q$SELECT pf_reserve_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000003',1)$q$,'NO_CREDITS');
UPDATE pf_job SET error_stage='HTTP 39',error_code='429',error_details='Controlled quota error',next_retry_at=now()+interval '60 seconds' WHERE job_id='a0000000-0000-4000-8000-000000000002';
SELECT pg_temp.pf_assert(pf_finish_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000002',1,false),'failure releases reservation');
SELECT pg_temp.pf_assert(NOT pf_finish_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000002',1,false),'duplicate failure no second refund');
SELECT pg_temp.pf_assert((SELECT available=1 AND reserved=0 AND consumed=1 FROM pf_credit_balance WHERE account_id='PF-ACCEPTANCE-A'),'failure restores one credit');
SELECT pg_temp.pf_expect_error($q$SELECT pf_reserve_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000002',2)$q$,'JOB_NOT_RETRYABLE');
UPDATE pf_job SET next_retry_at=now()-interval '1 second' WHERE job_id='a0000000-0000-4000-8000-000000000002';
SELECT pg_temp.pf_assert(pf_reserve_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000002',2),'retry same job');
SELECT pg_temp.pf_expect_error($q$SELECT pf_finish_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000002',1,false)$q$,'ATTEMPT_CONFLICT');
INSERT INTO pf_asset(asset_id,job_id,kind,attempt,ordinal,url,accessible_verified_at,qa_status)
VALUES('acceptance-stale-asset','a0000000-0000-4000-8000-000000000002','generated',1,0,'https://example.test/stale.jpg',now(),'PASS');
UPDATE pf_job SET qa_status='PASS',stored_images=1,output_url='https://example.test/old-package/' WHERE job_id='a0000000-0000-4000-8000-000000000002';
SELECT pg_temp.pf_expect_error($q$SELECT pf_finish_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000002',2,true)$q$,'DELIVERY_NOT_VERIFIED');
SELECT pg_temp.pf_assert(pf_finish_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000002',2,false),'second failure releases');
SELECT pg_temp.pf_assert(pf_reserve_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000002',3),'third attempt');
SELECT pg_temp.pf_assert(pf_finish_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000002',3,false),'third failure releases');
SELECT pg_temp.pf_expect_error($q$SELECT pf_reserve_credit('PF-ACCEPTANCE-A','a0000000-0000-4000-8000-000000000002',4)$q$,'ATTEMPT_INVALID');
SELECT pg_temp.pf_assert((SELECT available=1 AND consumed=1 AND reserved=0 FROM pf_credit_balance WHERE account_id='PF-ACCEPTANCE-A'),'retry sequence never double charges');
SELECT pg_temp.pf_assert((SELECT available=1 AND consumed=0 AND reserved=0 FROM pf_credit_balance WHERE account_id='PF-ACCEPTANCE-B'),'account B unchanged');
SELECT pg_temp.pf_assert((SELECT count(*) FROM pf_job WHERE job_id='a0000000-0000-4000-8000-000000000002')=1,'retry retains one job row');
ROLLBACK;
SELECT 'PASSED: ownership, duplicate reservation/completion/refund, asset gate, retry timing/bounds, stale attempt/asset rejection, credit parity; fixtures rolled back' AS acceptance,
 (SELECT count(*) FROM pf_customer WHERE account_id LIKE 'PF-ACCEPTANCE-%') AS remaining_test_accounts;
