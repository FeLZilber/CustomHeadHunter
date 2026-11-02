-- Ashby joins the providers a job source may use.

ALTER TABLE job_sources DROP CONSTRAINT job_sources_provider_check;
ALTER TABLE job_sources ADD CONSTRAINT job_sources_provider_check CHECK (provider IN ('greenhouse', 'lever', 'ashby'));
