-- Isolated Preview only. All fixture writes are rolled back.
BEGIN;
INSERT INTO pf_job(job_id,account_id,fingerprint,payload,vehicle_name,expected_images)
VALUES('c0000000-0000-4000-8000-000000000006','PF-ACCEPTANCE-A-20261103','ordinal-regression-fixture','{}','Temporary ordinal acceptance fixture',1);
DO $$ BEGIN
 IF NOT pf_reserve_credit('PF-ACCEPTANCE-A-20261103','c0000000-0000-4000-8000-000000000006',1,false) THEN RAISE EXCEPTION 'Reservation missing'; END IF;
 IF pf_reserve_credit('PF-ACCEPTANCE-A-20261103','c0000000-0000-4000-8000-000000000006',1,false) THEN RAISE EXCEPTION 'Duplicate reservation charged'; END IF;
END $$;
UPDATE pf_job SET qa_status='PASS',stored_images=1,output_url='https://ucarecdn.com/c0000000-0000-4000-8000-000000000006~1/' WHERE job_id='c0000000-0000-4000-8000-000000000006';
INSERT INTO pf_asset(asset_id,job_id,kind,attempt,ordinal,url,mime_type,byte_size,accessible_verified_at,qa_status)
VALUES('ordinal-regression-fixture','c0000000-0000-4000-8000-000000000006','generated',1,1,'https://ucarecdn.com/c0000000-0000-4000-8000-000000000006~1/nth/1/','image/jpeg',100,now(),'PASS');
DO $$ BEGIN
 BEGIN
  PERFORM pf_finish_credit('PF-ACCEPTANCE-A-20261103','c0000000-0000-4000-8000-000000000006',1,true);
  RAISE EXCEPTION 'Missing first image was accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'DELIVERY_NOT_VERIFIED' THEN RAISE; END IF;
 END;
 IF (SELECT state FROM pf_credit_reservation WHERE job_id='c0000000-0000-4000-8000-000000000006') <> 'reserved' THEN RAISE EXCEPTION 'Incomplete package consumed credit'; END IF;
 IF (SELECT status FROM pf_job WHERE job_id='c0000000-0000-4000-8000-000000000006') = 'COMPLETED' THEN RAISE EXCEPTION 'Incomplete package completed'; END IF;
END $$;
UPDATE pf_asset SET ordinal=0,url='https://ucarecdn.com/c0000000-0000-4000-8000-000000000006~1/nth/0/' WHERE asset_id='ordinal-regression-fixture';
DO $$ BEGIN
 IF NOT pf_finish_credit('PF-ACCEPTANCE-A-20261103','c0000000-0000-4000-8000-000000000006',1,true) THEN RAISE EXCEPTION 'Valid package did not complete'; END IF;
 IF pf_finish_credit('PF-ACCEPTANCE-A-20261103','c0000000-0000-4000-8000-000000000006',1,true) THEN RAISE EXCEPTION 'Duplicate completion changed credit'; END IF;
 IF (SELECT available FROM pf_credit_balance WHERE account_id='PF-ACCEPTANCE-A-20261103') <> 2 THEN RAISE EXCEPTION 'Expected one consumed credit'; END IF;
 IF (SELECT count(*) FROM pf_credit_ledger WHERE job_id='c0000000-0000-4000-8000-000000000006' AND kind='consume') <> 1 THEN RAISE EXCEPTION 'Expected exactly one consumption event'; END IF;
END $$;
SELECT 'PASS: missing index rejected; valid index completes; duplicate reserve/complete no-op' AS image_sequence_acceptance;
ROLLBACK;
SELECT account_id,available,reserved,consumed,(SELECT count(*) FROM pf_job WHERE job_id='c0000000-0000-4000-8000-000000000006') AS fixture_rows_remaining FROM pf_credit_balance WHERE account_id IN ('PF-ACCEPTANCE-A-20261103','PF-ACCEPTANCE-B-20261103','PF-TEST-999') ORDER BY account_id;
