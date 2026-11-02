-- Core catalog, listings, lifecycle and crawl records. Timestamps are UTC timestamptz.

CREATE TABLE companies (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  industry    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_sources (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id                bigint NOT NULL REFERENCES companies (id),
  provider                  text NOT NULL CHECK (provider IN ('greenhouse', 'lever')),
  provider_key              text NOT NULL,
  career_url                text NOT NULL,
  country_coverage          text[] NOT NULL,
  enabled                   boolean NOT NULL DEFAULT true,
  verified_at               timestamptz NOT NULL,
  verification_source_url   text NOT NULL,
  baseline_established_at   timestamptz,
  last_complete_snapshot_at timestamptz,
  last_listing_count        integer,
  checkpoint_etag           text,
  crawl_lease_owner         text,
  crawl_lease_until         timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_key)
);

CREATE TABLE canonical_jobs (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id         bigint NOT NULL REFERENCES companies (id),
  title              text NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  lifecycle_cycle    integer NOT NULL DEFAULT 1,
  revision           integer NOT NULL DEFAULT 1,
  content_hash       text NOT NULL,
  first_discovered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_verified_at   timestamptz,
  status_changed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX canonical_jobs_status_idx ON canonical_jobs (status, last_seen_at DESC);
CREATE INDEX canonical_jobs_company_idx ON canonical_jobs (company_id);

CREATE TABLE crawl_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trigger      text NOT NULL,
  mode         text NOT NULL,
  status       text NOT NULL DEFAULT 'running'
               CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  summary      jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX crawl_runs_started_idx ON crawl_runs (started_at DESC);

CREATE TABLE source_snapshots (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id         bigint NOT NULL REFERENCES crawl_runs (id),
  source_id      bigint NOT NULL REFERENCES job_sources (id),
  outcome        text NOT NULL DEFAULT 'running' CHECK (
                   outcome IN ('running', 'complete', 'partial', 'failed', 'blocked',
                               'not_modified', 'suspicious')),
  pages_fetched  integer NOT NULL DEFAULT 0,
  listings_seen  integer NOT NULL DEFAULT 0,
  listings_out_of_scope integer NOT NULL DEFAULT 0,
  listings_new   integer NOT NULL DEFAULT 0,
  listings_changed integer NOT NULL DEFAULT 0,
  listings_expired integer NOT NULL DEFAULT 0,
  http_status    integer,
  error          text,
  reconciled_at  timestamptz,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);

CREATE INDEX source_snapshots_source_idx ON source_snapshots (source_id, started_at DESC);
CREATE INDEX source_snapshots_run_idx ON source_snapshots (run_id);

CREATE TABLE source_listings (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id             bigint NOT NULL REFERENCES job_sources (id),
  provider_job_id       text NOT NULL,
  canonical_job_id      bigint NOT NULL REFERENCES canonical_jobs (id),
  requisition_id        text,
  title                 text NOT NULL,
  original_description  text NOT NULL,
  description_text      text NOT NULL,
  original_location     text,
  normalized_locations  jsonb NOT NULL DEFAULT '[]',
  work_arrangement      text,
  remote_scope          text,
  employment_type       text,
  seniority             text,
  technologies          jsonb NOT NULL DEFAULT '[]',
  experience            jsonb,
  salary                jsonb,
  application_url       text NOT NULL,
  canonical_url         text NOT NULL,
  published_at          timestamptz,
  provider_updated_at   timestamptz,
  content_hash          text NOT NULL,
  normalization_version text NOT NULL,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  missing_snapshots     integer NOT NULL DEFAULT 0,
  last_seen_snapshot_id bigint REFERENCES source_snapshots (id),
  first_discovered_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_verified_at      timestamptz,
  status_changed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, provider_job_id)
);

CREATE INDEX source_listings_canonical_idx ON source_listings (canonical_job_id);
CREATE INDEX source_listings_requisition_idx ON source_listings (requisition_id) WHERE requisition_id IS NOT NULL;
CREATE INDEX source_listings_canonical_url_idx ON source_listings (canonical_url);
CREATE INDEX source_listings_source_status_idx ON source_listings (source_id, status);

-- A monotonic log of meaningful state changes. The id orders events; cycle
-- separates repeated expire/reopen rounds, so a reopening is never mistaken for
-- an earlier one even when the content is identical.
CREATE TABLE job_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canonical_job_id   bigint NOT NULL REFERENCES canonical_jobs (id),
  source_listing_id  bigint REFERENCES source_listings (id),
  event_type         text NOT NULL CHECK (event_type IN ('discovered', 'changed', 'expired', 'reopened')),
  lifecycle_cycle    integer NOT NULL,
  revision           integer NOT NULL,
  significant        boolean NOT NULL DEFAULT false,
  during_baseline    boolean NOT NULL DEFAULT false,
  changed_fields     text[] NOT NULL DEFAULT '{}',
  content_hash       text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canonical_job_id, event_type, lifecycle_cycle, revision)
);

CREATE INDEX job_events_job_idx ON job_events (canonical_job_id, id DESC);
