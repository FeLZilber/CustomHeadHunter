-- jsonld joins the providers a job source or requested source may use (generic schema.org JobPosting reader).
--
-- The allowed list is the full superset ('greenhouse', 'lever', 'ashby', 'workable', 'jsonld') on purpose: a parallel
-- migration 0010 adds 'workable' with the same list, so the two apply in either order and end in the same state.
-- job_sources.provider_key is plain text with no format constraint, so it already holds a URL.

ALTER TABLE job_sources DROP CONSTRAINT job_sources_provider_check;
ALTER TABLE job_sources ADD CONSTRAINT job_sources_provider_check
  CHECK (provider IN ('greenhouse', 'lever', 'ashby', 'workable', 'jsonld'));

ALTER TABLE requested_sources DROP CONSTRAINT requested_sources_provider_check;
ALTER TABLE requested_sources ADD CONSTRAINT requested_sources_provider_check
  CHECK (provider IN ('greenhouse', 'lever', 'ashby', 'workable', 'jsonld'));
