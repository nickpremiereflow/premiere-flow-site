-- Isolated Preview only. Tests the existing A fixture; all changes roll back.
BEGIN;
CREATE OR REPLACE FUNCTION pg_temp.pf_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ACCEPTANCE_FAILED: %',label; END IF; END $$;
CREATE OR REPLACE FUNCTION pg_temp.pf_expect_error(command text,expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN IF SQLERRM=expected THEN RETURN; ELSE RAISE; END IF; END;
  RAISE EXCEPTION 'EXPECTED_ERROR_MISSING: %',expected;
END $$;
UPDATE pf_customer SET baseline_tier='Unlimited' WHERE account_id='PF-ACCEPTANCE-A-20261103';
INSERT INTO pf_job(job_id,account_id,fingerprint,payload,expected_images) VALUES('d0000000-0000-4000-8000-000000000007','PF-ACCEPTANCE-A-20261103','subscription-expiry-fixture','{}',1);
SELECT pg_temp.pf_expect_error($q$SELECT pf_reserve_credit('PF-ACCEPTANCE-A-20261103','d0000000-0000-4000-8000-000000000007',1,true)$q$,'ENTITLEMENT_INVALID');
SELECT pg_temp.pf_assert((SELECT available=3 AND reserved=0 FROM pf_credit_balance WHERE account_id='PF-ACCEPTANCE-A-20261103'),'legacy label grants no free usage');
INSERT INTO pf_subscription(subscription_id,account_id,price_id,status,paid_through) VALUES('sub_controlled_expiry_007','PF-ACCEPTANCE-A-20261103','price_1TJRzCLrMwiluTIfa5GgILej','active',now()+interval '5 minutes');
SELECT pg_temp.pf_assert(pf_reserve_credit('PF-ACCEPTANCE-A-20261103','d0000000-0000-4000-8000-000000000007',1,true),'verified paid period permits unlimited');
SELECT pg_temp.pf_assert((SELECT units=0 FROM pf_credit_reservation WHERE job_id='d0000000-0000-4000-8000-000000000007'),'paid unlimited leaves pack credits untouched');
SELECT pg_temp.pf_assert(pf_finish_credit('PF-ACCEPTANCE-A-20261103','d0000000-0000-4000-8000-000000000007',1,false),'release controlled attempt');
UPDATE pf_subscription SET paid_through=now()-interval '1 second' WHERE subscription_id='sub_controlled_expiry_007';
SELECT pg_temp.pf_expect_error($q$SELECT pf_reserve_credit('PF-ACCEPTANCE-A-20261103','d0000000-0000-4000-8000-000000000007',2,true)$q$,'ENTITLEMENT_INVALID');
SELECT pg_temp.pf_assert(pf_reserve_credit('PF-ACCEPTANCE-A-20261103','d0000000-0000-4000-8000-000000000007',2,false),'expired plan can use an existing paid pack credit');
SELECT pg_temp.pf_assert((SELECT available=2 AND reserved=1 FROM pf_credit_balance WHERE account_id='PF-ACCEPTANCE-A-20261103'),'pack reserve charges one credit');
SELECT pg_temp.pf_assert(pf_finish_credit('PF-ACCEPTANCE-A-20261103','d0000000-0000-4000-8000-000000000007',2,false),'failure returns the pack credit');
UPDATE pf_subscription SET status='canceled',paid_through=now()+interval '5 minutes' WHERE subscription_id='sub_controlled_expiry_007';
SELECT pg_temp.pf_assert(pf_reserve_credit('PF-ACCEPTANCE-A-20261103','d0000000-0000-4000-8000-000000000007',3,true),'canceled renewal retains already paid time');
SELECT pg_temp.pf_assert(pf_finish_credit('PF-ACCEPTANCE-A-20261103','d0000000-0000-4000-8000-000000000007',3,false),'release final controlled attempt');
SELECT pg_temp.pf_assert((SELECT available=3 AND reserved=0 AND consumed=0 FROM pf_credit_balance WHERE account_id='PF-ACCEPTANCE-A-20261103'),'no lasting credit change');
SELECT 'PASS: legacy label denied; paid period honored; expiry enforced; existing pack credits preserved' AS acceptance;
ROLLBACK;
SELECT account_id,available,reserved,consumed,(SELECT count(*) FROM pf_job WHERE job_id='d0000000-0000-4000-8000-000000000007') AS fixture_rows_remaining,(SELECT count(*) FROM pf_subscription WHERE subscription_id='sub_controlled_expiry_007') AS subscription_rows_remaining FROM pf_credit_balance WHERE account_id IN ('PF-ACCEPTANCE-A-20261103','PF-ACCEPTANCE-B-20261103','PF-TEST-999') ORDER BY account_id;
