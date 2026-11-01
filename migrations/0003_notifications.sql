-- A row is one logical message. event_key carries the job, event type, lifecycle
-- cycle and revision, so a job reopened in a later cycle is a new event while a
-- replay of the same step is a conflict.
CREATE TABLE notifications (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id        bigint NOT NULL REFERENCES profiles (id),
  channel           text NOT NULL DEFAULT 'telegram' CHECK (channel IN ('telegram')),
  kind              text NOT NULL CHECK (kind IN ('alert', 'digest')),
  event_key         text NOT NULL,
  canonical_job_id  bigint REFERENCES canonical_jobs (id),
  job_event_id      bigint REFERENCES job_events (id),
  source_id         bigint REFERENCES job_sources (id),
  job_ids           bigint[] NOT NULL DEFAULT '{}',
  more_count        integer NOT NULL DEFAULT 0,
  score             integer,
  status            text NOT NULL DEFAULT 'pending' CHECK (
                      status IN ('pending', 'claimed', 'sent', 'retry', 'ambiguous', 'failed', 'suppressed')),
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  lease_owner       text,
  lease_until       timestamptz,
  -- Committed before the request. A claim that dies with this set may have been delivered.
  send_started_at   timestamptz,
  sent_at           timestamptz,
  message_id        bigint,
  sent_input_key    text,
  suppressed_reason text,
  last_error_kind   text,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, channel, event_key),
  CHECK ((kind = 'alert') = (canonical_job_id IS NOT NULL AND job_event_id IS NOT NULL)),
  CHECK (status <> 'sent' OR message_id IS NOT NULL),
  CHECK (status <> 'suppressed' OR suppressed_reason IS NOT NULL)
);

CREATE INDEX notifications_due_idx ON notifications (kind, next_attempt_at, score DESC)
  WHERE status IN ('pending', 'retry');
CREATE INDEX notifications_job_idx ON notifications (canonical_job_id, job_event_id);
CREATE INDEX notifications_claim_idx ON notifications (lease_until) WHERE status = 'claimed';

-- A new epoch starts when relevance is redefined. Older events stay out of
-- individual alerts, so a profile or model change cannot flood the channel.
CREATE TABLE notification_epochs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id  bigint NOT NULL REFERENCES profiles (id),
  epoch_key   text NOT NULL,
  reason      text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_epochs_profile_idx ON notification_epochs (profile_id, id DESC);

CREATE TABLE notify_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trigger     text NOT NULL,
  status      text NOT NULL DEFAULT 'running' CHECK (
                status IN ('running', 'succeeded', 'partial', 'failed', 'not_configured', 'dry_run')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  summary     jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX notify_runs_started_idx ON notify_runs (started_at DESC);
