-- Preview only, synthetic manifests, zero provider calls. Every write rolls back.
BEGIN;
DO $$
DECLARE a text:='PF-ACCEPTANCE-A-20261103'; b text:='PF-ACCEPTANCE-B-20261103';
 uid text; uidb text; email text; emailb text; before_balance integer; source uuid:='c0000000-0000-4000-8000-000000000021';
 job uuid:='c0000000-0000-4000-8000-000000000022'; output uuid:='c0000000-0000-4000-8000-000000000023';
 source_url text:='https://preview.example.test/api/media/groups/c0000000-0000-4000-8000-000000000021~1/';
 output_url text:='https://preview.example.test/api/media/groups/c0000000-0000-4000-8000-000000000023~1/';
 p jsonb; q jsonb; result jsonb; assets jsonb; completed jsonb;
BEGIN
 SELECT c.user_id,u.email INTO uid,email FROM pf_customer c JOIN pf_user u ON u.id=c.user_id WHERE c.account_id=a;
 SELECT c.user_id,u.email INTO uidb,emailb FROM pf_customer c JOIN pf_user u ON u.id=c.user_id WHERE c.account_id=b;
 SELECT available INTO before_balance FROM pf_credit_balance WHERE account_id=a;
 IF uid IS NULL OR uidb IS NULL OR before_balance<1 THEN RAISE EXCEPTION 'Controlled Preview accounts missing'; END IF;
 INSERT INTO pf_media_group(group_id,account_id,namespace,kind,expected_files,canonical_url,fingerprint,state,sealed_at)
  VALUES(source,a,'preview','source',1,source_url,repeat('1',64),'sealed',now());
 INSERT INTO pf_media_object(object_id,group_id,account_id,role,ordinal,object_key,declared_mime,allocated_bytes,state,byte_size,sha256,etag,upload_expires_at,verified_at)
  VALUES('d0000000-0000-4000-8000-000000000021',source,a,'source',0,'v1/preview/d0000000-0000-4000-8000-000000000021','image/jpeg',100,'verified',100,repeat('2',64),'"source"',now()+interval '5 minutes',now()),
        ('d0000000-0000-4000-8000-000000000022',source,a,'source_preview',0,'v1/preview/d0000000-0000-4000-8000-000000000022','image/jpeg',100,'verified',100,repeat('3',64),'"preview"',now()+interval '5 minutes',now());
 p:=jsonb_build_object('action','submit','accountId',a,'email',email,'jobId',job::text,'expectedAttempt','','vehicleName','R2 rollback-only acceptance',
  'assetSource','Upload','showroomColor','White (default)','logoPlacement','No Logo','thumbnail',source_url||'nth/0/','uploadcareUrl',source_url,'sendEmail','true');
 BEGIN
  PERFORM pf_enqueue_engine(b,uidb,job,repeat('1',64),p||jsonb_build_object('accountId',b,'email',emailb));
  RAISE EXCEPTION 'Foreign source accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'PAYLOAD_INVALID' THEN RAISE; END IF; END;
 result:=pf_enqueue_engine(a,uid,job,repeat('1',64),p);
 IF result->>'created' IS DISTINCT FROM 'true' OR (SELECT available FROM pf_credit_balance WHERE account_id=a)<>before_balance-1 THEN RAISE EXCEPTION 'Single reservation missing'; END IF;
 IF pf_enqueue_engine(a,uid,job,repeat('1',64),p)->>'created' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Duplicate submission was not idempotent'; END IF;
 BEGIN
  PERFORM pf_enqueue_engine(a,uid,'c0000000-0000-4000-8000-000000000024',repeat('4',64),p||jsonb_build_object('jobId','c0000000-0000-4000-8000-000000000024'));
  RAISE EXCEPTION 'Same source became a second job';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'PAYLOAD_INVALID' THEN RAISE; END IF; END;
 INSERT INTO pf_make_ticket(token_hash,audience,payload,expires_at) VALUES(repeat('7',64),'engine',p,now()+interval '15 minutes');
 PERFORM pf_claim_engine(repeat('7',64),p);
 INSERT INTO pf_media_group(group_id,account_id,namespace,kind,expected_files,canonical_url,fingerprint,job_id,attempt)
  VALUES(output,a,'preview','generated',1,output_url,repeat('5',64),job,1);
 INSERT INTO pf_media_object(object_id,group_id,account_id,role,ordinal,object_key,declared_mime,allocated_bytes,upload_expires_at)
  VALUES('d0000000-0000-4000-8000-000000000023',output,a,'generated',0,'v1/preview/d0000000-0000-4000-8000-000000000023','image/png',100,now()+interval '5 minutes');
 completed:=jsonb_build_object('jobId',job,'attempt',1,'status','COMPLETED','outputUrl',output_url,'qaStatus','PASS');
 assets:=jsonb_build_array(jsonb_build_object('ordinal',0,'url',output_url||'nth/0/','mimeType','image/png','byteSize',100,'sha256',repeat('6',64)));
 BEGIN
  PERFORM pf_apply_engine_result(repeat('7',64),completed,repeat('8',64),assets);
  RAISE EXCEPTION 'Unverified output completed';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'DELIVERY_NOT_VERIFIED' THEN RAISE; END IF; END;
 UPDATE pf_media_object SET state='verified',byte_size=100,sha256=repeat('6',64),etag='"output"',verified_at=now() WHERE group_id=output;
 UPDATE pf_media_group SET state='sealed',sealed_at=now() WHERE group_id=output;
 BEGIN
  PERFORM pf_apply_engine_result(repeat('7',64),completed,repeat('8',64),jsonb_set(assets,'{0,sha256}',to_jsonb(repeat('9',64))));
  RAISE EXCEPTION 'Mismatched stored bytes completed';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'DELIVERY_NOT_VERIFIED' THEN RAISE; END IF; END;
 result:=pf_apply_engine_result(repeat('7',64),completed,repeat('8',64),assets);
 IF result->>'status' IS DISTINCT FROM 'COMPLETED' OR (SELECT available FROM pf_credit_balance WHERE account_id=a)<>before_balance-1
  OR (SELECT provider FROM pf_asset WHERE job_id=job AND kind='generated')<>'r2'
  OR (SELECT count(*) FROM pf_credit_ledger WHERE job_id=job AND amount<0)<>1 THEN RAISE EXCEPTION 'Completion or credit mismatch'; END IF;
 IF pf_apply_engine_result(repeat('7',64),completed,repeat('8',64),assets)->>'duplicate' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Duplicate completion charged again'; END IF;
END $$;
ROLLBACK;
