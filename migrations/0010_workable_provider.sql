-- Workable joins the providers a job source or requested source may use.
-- The list is the full superset ('greenhouse', 'lever', 'ashby', 'workable', 'jsonld') so this migration
-- and the parallel one adding 'jsonld' can be merged in either order and end with the same constraint.

ALTER TABLE job_sources DROP CONSTRAINT job_sources_provider_check;
ALTER TABLE job_sources ADD CONSTRAINT job_sources_provider_check CHECK (provider IN ('greenhouse', 'lever', 'ashby', 'workable', 'jsonld'));

ALTER TABLE requested_sources DROP CONSTRAINT requested_sources_provider_check;
ALTER TABLE requested_sources ADD CONSTRAINT requested_sources_provider_check CHECK (provider IN ('greenhouse', 'lever', 'ashby', 'workable', 'jsonld'));
