-- Jobs the owner flagged as wrongly filtered out ("should have matched"). A flag is the owner's
-- judgement about the filter, kept apart from job lifecycle. It is the raw material for filter
-- fixes and for human-reviewed evaluation labels.

CREATE TABLE missed_jobs (
  profile_id       bigint NOT NULL REFERENCES profiles (id),
  canonical_job_id bigint NOT NULL REFERENCES canonical_jobs (id),
  flagged_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, canonical_job_id)
);
