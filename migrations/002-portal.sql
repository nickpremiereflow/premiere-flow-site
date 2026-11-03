-- Portal ownership and payment delivery ledger. Existing Sheets data remains authoritative for engine jobs.
BEGIN;
CREATE TABLE IF NOT EXISTS pf_customer (
  account_id text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES pf_user(id),
  stripe_customer_id text UNIQUE,
  baseline_total integer NOT NULL DEFAULT 0 CHECK (baseline_total >= 0),
  baseline_tier text NOT NULL,
  projection_fingerprint text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pf_job (
  job_id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES pf_customer(account_id),
  fingerprint text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pf_job_account_idx ON pf_job(account_id);
CREATE TABLE IF NOT EXISTS pf_stripe_event (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  resource_id text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processed','ignored')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE TABLE IF NOT EXISTS pf_purchase (
  session_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES pf_customer(account_id),
  price_id text NOT NULL,
  credits integer NOT NULL CHECK (credits >= 0),
  stripe_customer_id text NOT NULL,
  payment_intent_id text,
  subscription_id text,
  refunded boolean NOT NULL DEFAULT false,
  paid_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pf_purchase_account_idx ON pf_purchase(account_id);
CREATE TABLE IF NOT EXISTS pf_subscription (
  subscription_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES pf_customer(account_id),
  price_id text NOT NULL,
  status text NOT NULL,
  paid_through timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pf_command (
  command_id text PRIMARY KEY,
  kind text NOT NULL,
  account_id text REFERENCES pf_customer(account_id),
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done')),
  attempt_count integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  retry_at timestamptz NOT NULL DEFAULT now(),
  result jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS pf_command_pending_idx ON pf_command(state, retry_at);
CREATE TABLE IF NOT EXISTS pf_make_ticket (
  token_hash text PRIMARY KEY,
  audience text NOT NULL,
  command_key text UNIQUE,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','completed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pf_make_ticket_expiry_idx ON pf_make_ticket(expires_at);
CREATE TABLE IF NOT EXISTS pf_request_limit (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL
);
COMMIT;
