-- Additive R2 metadata. No historical URL, credit, job or Uploadcare row changes.
-- This migration alone does not enable R2 uploads, jobs, or public bucket access.
BEGIN;
CREATE TABLE IF NOT EXISTS pf_media_budget (
  namespace text PRIMARY KEY CHECK(namespace IN ('preview','production')),
  allocated_bytes bigint NOT NULL DEFAULT 0 CHECK(allocated_bytes>=0),
  limit_bytes bigint NOT NULL DEFAULT 4000000000 CHECK(limit_bytes BETWEEN 1 AND 4000000000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(allocated_bytes<=limit_bytes)
);
-- At most 4 GB in each environment: 8 GB total, below the R2 account free tier.
-- Allocations include pending/abandoned uploads. Never release a reservation
-- merely because an upload expired; the stored object may still exist.
INSERT INTO pf_media_budget(namespace) VALUES('preview'),('production') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS pf_media_group (
  group_id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES pf_customer(account_id),
  namespace text NOT NULL REFERENCES pf_media_budget(namespace),
  kind text NOT NULL CHECK(kind IN ('source','generated','logo')),
  expected_files integer NOT NULL CHECK(expected_files BETWEEN 1 AND 10),
  canonical_url text NOT NULL UNIQUE,
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','sealed')),
  job_id uuid,
  attempt integer CHECK(attempt BETWEEN 1 AND 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  sealed_at timestamptz,
  UNIQUE(group_id,account_id),
  UNIQUE(job_id,attempt,kind),
  FOREIGN KEY(job_id,account_id) REFERENCES pf_job(job_id,account_id),
  CHECK((state='sealed')=(sealed_at IS NOT NULL)),
  CHECK(kind<>'logo' OR expected_files=1),
  CHECK(kind<>'generated' OR (job_id IS NOT NULL AND attempt IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS pf_media_group_owner ON pf_media_group(account_id,created_at DESC);

CREATE TABLE IF NOT EXISTS pf_media_object (
  object_id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  account_id text NOT NULL,
  role text NOT NULL CHECK(role IN ('source','source_preview','generated','logo')),
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 9),
  object_key text NOT NULL UNIQUE CHECK(object_key ~ '^v1/(preview|production)/[0-9a-f-]{36}$'),
  original_name text NOT NULL DEFAULT '',
  declared_mime text NOT NULL CHECK(declared_mime IN ('image/jpeg','image/png','image/webp','image/heic','image/heif')),
  allocated_bytes bigint NOT NULL CHECK(allocated_bytes BETWEEN 1 AND 30000000),
  state text NOT NULL DEFAULT 'allocated' CHECK(state IN ('allocated','verified')),
  byte_size bigint,
  sha256 text,
  etag text,
  upload_expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(group_id,account_id) REFERENCES pf_media_group(group_id,account_id),
  UNIQUE(group_id,role,ordinal),
  CHECK((state='verified' AND verified_at IS NOT NULL AND byte_size IS NOT NULL AND byte_size=allocated_bytes AND sha256 IS NOT NULL AND sha256 ~ '^[0-9a-f]{64}$' AND etag IS NOT NULL AND length(etag)>0)
     OR (state='allocated' AND verified_at IS NULL AND byte_size IS NULL AND sha256 IS NULL AND etag IS NULL))
);
CREATE INDEX IF NOT EXISTS pf_media_object_group ON pf_media_object(group_id,ordinal);
REVOKE ALL ON pf_media_budget,pf_media_group,pf_media_object FROM PUBLIC;
INSERT INTO pf_schema_migration(version) VALUES('011-private-media-storage') ON CONFLICT DO NOTHING;
COMMIT;
