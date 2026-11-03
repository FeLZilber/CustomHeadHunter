-- Jobs the owner marked "not relevant", with why. Kept apart from source lifecycle and from
-- saved/applied: a dismissal is the owner's judgement, so it survives expiry and reopening.
-- The reasons are the training signal for exclusions and for human-reviewed evaluation labels.

CREATE TABLE dismissed_jobs (
  profile_id       bigint NOT NULL REFERENCES profiles (id),
  canonical_job_id bigint NOT NULL REFERENCES canonical_jobs (id),
  reason           text NOT NULL CHECK (reason IN ('wrong_role', 'wrong_seniority', 'wrong_location', 'wrong_company', 'other')),
  dismissed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, canonical_job_id)
);
