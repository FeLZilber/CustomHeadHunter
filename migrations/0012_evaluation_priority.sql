-- The deterministic rank (title tier and fact fit) decides which eligible jobs reach the model queue.
ALTER TABLE job_evaluations ADD COLUMN priority integer NOT NULL DEFAULT 0;
