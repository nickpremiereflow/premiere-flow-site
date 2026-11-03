-- Preserve historical Stripe customer aliases while keeping one canonical
-- customer for authenticated repeat Checkout. Conflicting history aborts.
BEGIN;
CREATE TABLE IF NOT EXISTS pf_billing_customer (
  stripe_customer_id text PRIMARY KEY CHECK(stripe_customer_id LIKE 'cus_%'),
  account_id text NOT NULL REFERENCES pf_customer(account_id),
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF EXISTS(SELECT stripe_customer_id FROM (
    SELECT stripe_customer_id,account_id FROM pf_customer WHERE stripe_customer_id IS NOT NULL
    UNION SELECT stripe_customer_id,account_id FROM pf_purchase
  ) x GROUP BY stripe_customer_id HAVING COUNT(DISTINCT account_id)>1)
  THEN RAISE EXCEPTION 'Conflicting historical Stripe ownership requires review'; END IF;
END $$;
INSERT INTO pf_billing_customer(stripe_customer_id,account_id)
SELECT stripe_customer_id,account_id FROM pf_customer WHERE stripe_customer_id IS NOT NULL
UNION SELECT stripe_customer_id,account_id FROM pf_purchase
ON CONFLICT(stripe_customer_id) DO NOTHING;
INSERT INTO pf_schema_migration(version) VALUES('005-billing-customer-ownership') ON CONFLICT DO NOTHING;
COMMIT;
