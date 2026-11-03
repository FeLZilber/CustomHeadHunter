-- Company boards the owner asked the pipeline to follow, by pasting a job or careers link on /search.
-- The worker probes each request and adds the board as a source only when it holds Israeli jobs.

CREATE TABLE requested_sources (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider      text NOT NULL CHECK (provider IN ('greenhouse', 'lever', 'ashby')),
  provider_key  text NOT NULL,
  company_name  text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'added', 'rejected')),
  detail        text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  UNIQUE (provider, provider_key)
);

-- Catalog sources follow the catalog file; requested ones must survive a seed that does not list them.
ALTER TABLE job_sources ADD COLUMN origin text NOT NULL DEFAULT 'catalog' CHECK (origin IN ('catalog', 'requested'));
