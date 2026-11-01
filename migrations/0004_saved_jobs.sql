-- The owner's saved jobs. Kept apart from source lifecycle: a saved job can expire.

CREATE TABLE saved_jobs (
  profile_id       bigint NOT NULL REFERENCES profiles (id),
  canonical_job_id bigint NOT NULL REFERENCES canonical_jobs (id),
  saved_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, canonical_job_id)
);
