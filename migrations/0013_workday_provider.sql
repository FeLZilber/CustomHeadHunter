-- Workday joins the providers a job source or requested source may use. Its provider_key is the career
-- site's https address, which the plain-text column already holds.

ALTER TABLE job_sources DROP CONSTRAINT job_sources_provider_check;
ALTER TABLE job_sources ADD CONSTRAINT job_sources_provider_check
  CHECK (provider IN ('greenhouse', 'lever', 'ashby', 'workable', 'jsonld', 'workday'));

ALTER TABLE requested_sources DROP CONSTRAINT requested_sources_provider_check;
ALTER TABLE requested_sources ADD CONSTRAINT requested_sources_provider_check
  CHECK (provider IN ('greenhouse', 'lever', 'ashby', 'workable', 'jsonld', 'workday'));
