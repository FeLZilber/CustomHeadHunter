-- Owner profile revisions, deterministic evaluations, and the bounded match queue.

CREATE TABLE profiles (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_key           text NOT NULL UNIQUE,
  current_revision_id bigint,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- matching_hash covers matching inputs only, so a notification change can create
-- a revision without invalidating any evaluation.
CREATE TABLE profile_revisions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id    bigint NOT NULL REFERENCES profiles (id),
  revision      integer NOT NULL,
  matching      jsonb NOT NULL,
  matching_hash text NOT NULL,
  preferences   jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, revision)
);

ALTER TABLE profiles
  ADD CONSTRAINT profiles_current_revision_fk FOREIGN KEY (current_revision_id) REFERENCES profile_revisions (id);

-- The current deterministic verdict per job. input_key names the model result
-- that would be current for this job; it is null when the filter rejected it.
CREATE TABLE job_evaluations (
  canonical_job_id    bigint PRIMARY KEY REFERENCES canonical_jobs (id),
  source_listing_id   bigint NOT NULL REFERENCES source_listings (id),
  profile_revision_id bigint NOT NULL REFERENCES profile_revisions (id),
  profile_hash        text NOT NULL,
  filter_version      text NOT NULL,
  config_hash         text NOT NULL,
  content_hash        text NOT NULL,
  decision            text NOT NULL CHECK (decision IN ('eligible', 'rejected')),
  reason_codes        text[] NOT NULL,
  input_key           text,
  evaluated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((decision = 'eligible') = (input_key IS NOT NULL))
);

CREATE INDEX job_evaluations_decision_idx ON job_evaluations (decision);

CREATE TABLE match_tasks (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canonical_job_id  bigint NOT NULL REFERENCES canonical_jobs (id),
  source_listing_id bigint NOT NULL REFERENCES source_listings (id),
  input_key         text NOT NULL,
  content_hash      text NOT NULL,
  profile_revision_id bigint NOT NULL REFERENCES profile_revisions (id),
  profile_hash      text NOT NULL,
  config_hash       text NOT NULL,
  priority          integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'claimed', 'succeeded', 'exhausted', 'superseded')),
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  lease_owner       text,
  lease_until       timestamptz,
  last_error_kind   text,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canonical_job_id, input_key)
);

-- A job has at most one unit of open work.
CREATE UNIQUE INDEX match_tasks_open_idx ON match_tasks (canonical_job_id) WHERE status IN ('pending', 'claimed');
CREATE INDEX match_tasks_claim_idx ON match_tasks (priority DESC, id DESC) WHERE status IN ('pending', 'claimed');

-- History is kept: a result is current only while job_evaluations points at its key.
CREATE TABLE match_results (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canonical_job_id        bigint NOT NULL REFERENCES canonical_jobs (id),
  task_id                 bigint NOT NULL REFERENCES match_tasks (id),
  input_key               text NOT NULL,
  content_hash            text NOT NULL,
  profile_revision_id     bigint NOT NULL REFERENCES profile_revisions (id),
  score                   integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  recommendation          text NOT NULL,
  response                jsonb NOT NULL,
  model_name              text NOT NULL,
  model_digest            text NOT NULL,
  prompt_version          text NOT NULL,
  response_schema_version text NOT NULL,
  rubric_version          text NOT NULL,
  inference_config        jsonb NOT NULL,
  duration_ms             integer NOT NULL,
  model_calls             integer NOT NULL,
  input_truncated         boolean NOT NULL,
  input_estimated_tokens  integer NOT NULL,
  input_original_chars    integer NOT NULL,
  validation_outcome      text NOT NULL CHECK (validation_outcome IN ('valid', 'valid_after_retry')),
  evidence_total          integer NOT NULL,
  evidence_literal        integer NOT NULL,
  evidence_unverified     jsonb NOT NULL DEFAULT '[]',
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canonical_job_id, input_key)
);

CREATE INDEX match_results_job_idx ON match_results (canonical_job_id, created_at DESC);

CREATE VIEW current_matches AS
SELECT r.*
  FROM job_evaluations e
  JOIN match_results r ON r.canonical_job_id = e.canonical_job_id AND r.input_key = e.input_key;

CREATE TABLE match_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trigger     text NOT NULL,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  summary     jsonb NOT NULL DEFAULT '{}'
);
