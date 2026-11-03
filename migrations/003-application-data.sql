-- Additive application data foundation. Does not switch production reads/writes.
-- Credit balance = immutable grants/reservations/releases; consumption finalizes a reservation.
BEGIN;
CREATE TABLE IF NOT EXISTS pf_schema_migration(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS pf_plan (
  plan_id text PRIMARY KEY, name text NOT NULL, stripe_price_id text UNIQUE NOT NULL,
  currency text NOT NULL CHECK(currency='usd'), amount_cents integer NOT NULL CHECK(amount_cents>0),
  included_credits integer CHECK(included_credits>0), recurring boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pf_plan(plan_id,name,stripe_price_id,currency,amount_cents,included_credits,recurring) VALUES
('upgrade','Upgrade','price_1TJRzDLrMwiluTIf37Zcxhk9','usd',4900,1,false),
('branded','Branded','price_1TJRzDLrMwiluTIf2rqETvsJ','usd',6900,1,false),
('partner','Partner Pack','price_1TJRzCLrMwiluTIfO7XfmkwK','usd',34900,10,false),
('unlimited','Unlimited','price_1TJRzCLrMwiluTIfa5GgILej','usd',99900,NULL,true)
ON CONFLICT(plan_id) DO NOTHING;
ALTER TABLE pf_customer ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE pf_customer ADD COLUMN IF NOT EXISTS logo_url text NOT NULL DEFAULT '';
ALTER TABLE pf_customer ADD COLUMN IF NOT EXISTS showroom_notes text NOT NULL DEFAULT '';
ALTER TABLE pf_customer ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','closed'));
ALTER TABLE pf_customer ADD COLUMN IF NOT EXISTS joined_at timestamptz;
ALTER TABLE pf_customer ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS pf_membership (
  account_id text NOT NULL REFERENCES pf_customer(account_id), user_id text NOT NULL REFERENCES pf_user(id),
  role text NOT NULL CHECK(role IN ('owner','operator','viewer')), active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id,user_id)
);
INSERT INTO pf_membership(account_id,user_id,role) SELECT account_id,user_id,'owner' FROM pf_customer ON CONFLICT DO NOTHING;
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACCEPTED'
  CHECK(status IN ('ACCEPTED','PROCESSING','RETRYING','FAILED','RETRY_REQUIRED','COMPLETED'));
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS vehicle_name text NOT NULL DEFAULT '';
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS showroom_color text NOT NULL DEFAULT '';
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS logo_placement text NOT NULL DEFAULT 'No Logo';
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS logo_url text NOT NULL DEFAULT '';
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS source_url text NOT NULL DEFAULT '';
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS thumbnail_url text NOT NULL DEFAULT '';
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS output_url text NOT NULL DEFAULT '';
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3);
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS expected_images integer CHECK(expected_images BETWEEN 1 AND 10);
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS stored_images integer NOT NULL DEFAULT 0 CHECK(stored_images BETWEEN 0 AND 10);
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS qa_status text NOT NULL DEFAULT 'PENDING' CHECK(qa_status IN ('PENDING','PASS','FAIL','REVIEW'));
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS qa_notes text NOT NULL DEFAULT '';
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS error_stage text;
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS error_details text;
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE pf_job ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS pf_job_account_identity_idx ON pf_job(job_id,account_id);
CREATE INDEX IF NOT EXISTS pf_job_status_idx ON pf_job(status,updated_at);
CREATE TABLE IF NOT EXISTS pf_job_attempt (
  job_id uuid NOT NULL REFERENCES pf_job(job_id), attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  state text NOT NULL CHECK(state IN ('ACCEPTED','PROCESSING','FAILED','RETRY_REQUIRED','COMPLETED')),
  provider text, model text, provider_request_id text, error_stage text, error_code text, error_details text,
  qa_status text NOT NULL DEFAULT 'PENDING' CHECK(qa_status IN ('PENDING','PASS','FAIL','REVIEW')),
  started_at timestamptz, finished_at timestamptz, retry_at timestamptz, PRIMARY KEY(job_id,attempt)
);
CREATE TABLE IF NOT EXISTS pf_asset (
  asset_id text PRIMARY KEY, job_id uuid NOT NULL REFERENCES pf_job(job_id),
  kind text NOT NULL CHECK(kind IN ('source','generated','logo')), provider text NOT NULL DEFAULT 'uploadcare',
  provider_file_id text, attempt integer NOT NULL DEFAULT 1 CHECK(attempt BETWEEN 1 AND 3), ordinal integer NOT NULL DEFAULT 0 CHECK(ordinal>=0),
  url text NOT NULL CHECK(url LIKE 'https://%'), mime_type text, byte_size bigint CHECK(byte_size>0),
  accessible_verified_at timestamptz, qa_status text NOT NULL DEFAULT 'PENDING' CHECK(qa_status IN ('PENDING','PASS','FAIL','REVIEW')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(job_id,kind,attempt,ordinal)
);
CREATE TABLE IF NOT EXISTS pf_credit_ledger (
  entry_key text PRIMARY KEY, account_id text NOT NULL REFERENCES pf_customer(account_id),
  job_id uuid, attempt integer CHECK(attempt BETWEEN 1 AND 3),
  kind text NOT NULL CHECK(kind IN ('grant','reserve','release','consume','adjustment')),
  amount integer NOT NULL, source_id text, reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(job_id,account_id) REFERENCES pf_job(job_id,account_id),
  CHECK((kind='grant' AND amount>=0) OR (kind='reserve' AND amount IN (-1,0)) OR
    (kind='release' AND amount IN (0,1)) OR (kind='consume' AND amount=0) OR kind='adjustment')
);
CREATE INDEX IF NOT EXISTS pf_credit_ledger_account_idx ON pf_credit_ledger(account_id);
CREATE TABLE IF NOT EXISTS pf_credit_reservation (
  job_id uuid PRIMARY KEY, account_id text NOT NULL, attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  units integer NOT NULL CHECK(units IN (0,1)), state text NOT NULL CHECK(state IN ('reserved','released','consumed')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(job_id,account_id) REFERENCES pf_job(job_id,account_id)
);
CREATE OR REPLACE VIEW pf_credit_balance AS
SELECT c.account_id, COALESCE(SUM(l.amount),0)::integer AS available,
 COALESCE(SUM(l.amount) FILTER(WHERE l.kind='grant'),0)::integer AS granted,
 (SELECT COALESCE(SUM(r.units),0)::integer FROM pf_credit_reservation r WHERE r.account_id=c.account_id AND r.state='reserved') AS reserved,
 (SELECT COALESCE(SUM(r.units),0)::integer FROM pf_credit_reservation r WHERE r.account_id=c.account_id AND r.state='consumed') AS consumed
FROM pf_customer c LEFT JOIN pf_credit_ledger l ON l.account_id=c.account_id GROUP BY c.account_id;
CREATE TABLE IF NOT EXISTS pf_audit_event (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_key text UNIQUE,
  account_id text REFERENCES pf_customer(account_id), actor_user_id text REFERENCES pf_user(id),
  job_id uuid REFERENCES pf_job(job_id), action text NOT NULL, details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pf_audit_account_time_idx ON pf_audit_event(account_id,created_at DESC);
CREATE TABLE IF NOT EXISTS pf_support_request (
  request_id uuid PRIMARY KEY, account_id text NOT NULL REFERENCES pf_customer(account_id),
  user_id text NOT NULL REFERENCES pf_user(id), subject text NOT NULL, message text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','waiting','closed')),
  email_thread_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pf_mail_thread (
  provider_thread_id text PRIMARY KEY, mailbox text NOT NULL, account_id text REFERENCES pf_customer(account_id),
  subject text NOT NULL DEFAULT '', unread boolean NOT NULL DEFAULT false, snippet text NOT NULL DEFAULT '',
  last_message_at timestamptz, synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pf_migration_batch (
  batch_id text PRIMARY KEY, source_id text NOT NULL, backup_sha256 text NOT NULL,
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','imported','verified','cutover','rolled_back')),
  expected jsonb NOT NULL, actual jsonb, created_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz
);
CREATE TABLE IF NOT EXISTS pf_legacy_record (
  batch_id text NOT NULL REFERENCES pf_migration_batch(batch_id), source_sheet text NOT NULL,
  source_row integer NOT NULL CHECK(source_row>1), source_key text NOT NULL, content_sha256 text NOT NULL,
  data jsonb NOT NULL, PRIMARY KEY(batch_id,source_sheet,source_row)
);
-- A credit reservation is serialized per account and bound to one durable job/attempt.
-- These functions are server-only building blocks, not public API permissions.
CREATE OR REPLACE FUNCTION pf_reserve_credit(p_account text,p_job uuid,p_attempt integer,p_unlimited boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE j pf_job; r pf_credit_reservation; available integer; units integer;
BEGIN
  PERFORM 1 FROM pf_customer WHERE account_id=p_account AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE'; END IF;
  SELECT * INTO j FROM pf_job WHERE job_id=p_job AND account_id=p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOB_NOT_FOUND'; END IF;
  IF p_attempt<1 OR p_attempt>3 OR p_attempt IS NULL THEN RAISE EXCEPTION 'ATTEMPT_INVALID'; END IF;
  SELECT * INTO r FROM pf_credit_reservation WHERE job_id=p_job;
  IF FOUND THEN
    IF r.attempt=p_attempt AND r.state IN ('reserved','consumed') THEN RETURN false; END IF;
    IF r.state<>'released' OR p_attempt<>r.attempt+1 THEN RAISE EXCEPTION 'RETRY_CONFLICT'; END IF;
  ELSIF p_attempt<>1 THEN RAISE EXCEPTION 'ATTEMPT_INVALID'; END IF;
  IF j.status='COMPLETED' OR j.next_retry_at>now() THEN RAISE EXCEPTION 'JOB_NOT_RETRYABLE'; END IF;
  IF p_attempt>1 AND j.status NOT IN ('FAILED','RETRY_REQUIRED') THEN RAISE EXCEPTION 'JOB_NOT_RETRYABLE'; END IF;
  -- Caller entitlement is checked against trusted DB state as well.
  IF p_unlimited AND NOT EXISTS(SELECT 1 FROM pf_subscription WHERE account_id=p_account AND status IN ('active','past_due','canceled') AND paid_through>now())
     AND NOT EXISTS(SELECT 1 FROM pf_customer WHERE account_id=p_account AND baseline_tier='Unlimited') THEN RAISE EXCEPTION 'ENTITLEMENT_INVALID'; END IF;
  units:=CASE WHEN p_unlimited THEN 0 ELSE 1 END;
  SELECT b.available INTO available FROM pf_credit_balance b WHERE b.account_id=p_account;
  IF available<units THEN RAISE EXCEPTION 'NO_CREDITS'; END IF;
  INSERT INTO pf_credit_reservation(job_id,account_id,attempt,units,state) VALUES(p_job,p_account,p_attempt,units,'reserved')
    ON CONFLICT(job_id) DO UPDATE SET attempt=EXCLUDED.attempt,units=EXCLUDED.units,state='reserved',updated_at=now();
  INSERT INTO pf_credit_ledger(entry_key,account_id,job_id,attempt,kind,amount,reason)
    VALUES('reserve:'||p_job||':'||p_attempt,p_account,p_job,p_attempt,'reserve',-units,'Listing accepted');
  UPDATE pf_job SET attempt_count=p_attempt,status=CASE WHEN p_attempt=1 THEN 'ACCEPTED' ELSE 'RETRYING' END,
    error_stage=NULL,error_code=NULL,error_details=NULL,next_retry_at=NULL,updated_at=now() WHERE job_id=p_job;
  INSERT INTO pf_job_attempt(job_id,attempt,state,started_at) VALUES(p_job,p_attempt,'ACCEPTED',now());
  RETURN true;
END; $$;
CREATE OR REPLACE FUNCTION pf_finish_credit(p_account text,p_job uuid,p_attempt integer,p_success boolean)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE r pf_credit_reservation; j pf_job; valid_assets integer;
BEGIN
  IF p_success IS NULL THEN RAISE EXCEPTION 'RESULT_INVALID'; END IF;
  PERFORM 1 FROM pf_customer WHERE account_id=p_account FOR UPDATE;
  SELECT * INTO j FROM pf_job WHERE job_id=p_job AND account_id=p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOB_NOT_FOUND'; END IF;
  SELECT * INTO r FROM pf_credit_reservation WHERE job_id=p_job AND account_id=p_account;
  IF NOT FOUND OR r.attempt<>p_attempt THEN RAISE EXCEPTION 'ATTEMPT_CONFLICT'; END IF;
  IF r.state='consumed' AND p_success OR r.state='released' AND NOT p_success THEN RETURN false; END IF;
  IF r.state<>'reserved' THEN RAISE EXCEPTION 'CREDIT_STATE_CONFLICT'; END IF;
  IF p_success THEN
    SELECT count(*) INTO valid_assets FROM pf_asset WHERE job_id=p_job AND kind='generated'
      AND attempt=p_attempt AND accessible_verified_at IS NOT NULL AND qa_status='PASS';
    IF j.expected_images IS NULL OR valid_assets<>j.expected_images OR j.qa_status<>'PASS'
       OR j.stored_images<>j.expected_images OR j.output_url='' THEN RAISE EXCEPTION 'DELIVERY_NOT_VERIFIED'; END IF;
    UPDATE pf_credit_reservation SET state='consumed',updated_at=now() WHERE job_id=p_job;
    INSERT INTO pf_credit_ledger(entry_key,account_id,job_id,attempt,kind,amount,reason)
      VALUES('consume:'||p_job||':'||p_attempt,p_account,p_job,p_attempt,'consume',0,'Verified completed delivery');
    UPDATE pf_job SET status='COMPLETED',completed_at=now(),updated_at=now(),next_retry_at=NULL WHERE job_id=p_job;
    UPDATE pf_job_attempt SET state='COMPLETED',qa_status='PASS',finished_at=now() WHERE job_id=p_job AND attempt=p_attempt;
  ELSE
    UPDATE pf_credit_reservation SET state='released',updated_at=now() WHERE job_id=p_job;
    INSERT INTO pf_credit_ledger(entry_key,account_id,job_id,attempt,kind,amount,reason)
      VALUES('release:'||p_job||':'||p_attempt,p_account,p_job,p_attempt,'release',r.units,'Failed attempt; credit released');
    UPDATE pf_job SET status=CASE WHEN status='RETRY_REQUIRED' THEN status ELSE 'FAILED' END,updated_at=now() WHERE job_id=p_job;
    UPDATE pf_job_attempt SET state=CASE WHEN j.status='RETRY_REQUIRED' THEN j.status ELSE 'FAILED' END,
      error_stage=j.error_stage,error_code=j.error_code,error_details=j.error_details,retry_at=j.next_retry_at,finished_at=now()
      WHERE job_id=p_job AND attempt=p_attempt;
  END IF;
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION pf_reserve_credit(text,uuid,integer,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION pf_finish_credit(text,uuid,integer,boolean) FROM PUBLIC;
INSERT INTO pf_schema_migration(version) VALUES('003-application-data') ON CONFLICT DO NOTHING;
COMMIT;
