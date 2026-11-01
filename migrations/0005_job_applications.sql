-- Jobs the owner has applied for. Kept apart from source lifecycle: an applied job can expire,
-- and an expired or reopened posting never changes the fact that it was applied for.

CREATE TABLE job_applications (
  profile_id       bigint NOT NULL REFERENCES profiles (id),
  canonical_job_id bigint NOT NULL REFERENCES canonical_jobs (id),
  applied_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, canonical_job_id)
);
