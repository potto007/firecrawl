CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Checkpoint tuning: spread I/O to reduce stalls during heavy WAL activity
-- These settings help prevent prefetch queries from returning 0 jobs during checkpoints

-- Checkpoint settings: reduce frequency and spread I/O
ALTER SYSTEM SET checkpoint_completion_target = 0.9;  -- Spread checkpoint I/O over 90% of interval
ALTER SYSTEM SET checkpoint_timeout = '15min';         -- Longer intervals between time-based checkpoints
ALTER SYSTEM SET max_wal_size = '16GB';                -- Much larger WAL before forced checkpoint (was 4GB)
ALTER SYSTEM SET min_wal_size = '4GB';                 -- Keep WAL pre-allocated to avoid allocation stalls

-- Aggressive background writer: pre-flush dirty pages to reduce checkpoint burst
ALTER SYSTEM SET bgwriter_lru_maxpages = 1000;         -- Flush up to 1000 pages per round (was 500)
ALTER SYSTEM SET bgwriter_lru_multiplier = 4.0;        -- More aggressive dirty page estimation
ALTER SYSTEM SET bgwriter_delay = '50ms';              -- Run twice as often (was 100ms)
ALTER SYSTEM SET bgwriter_flush_after = '512kB';       -- Force OS flush after 512kB written

-- I/O concurrency for SSD/cloud storage (hyperdisk)
ALTER SYSTEM SET effective_io_concurrency = 200;       -- Parallel I/O operations for prefetch
ALTER SYSTEM SET maintenance_io_concurrency = 100;     -- I/O concurrency for maintenance ops

-- WAL settings for better write performance
ALTER SYSTEM SET wal_buffers = '64MB';                 -- Larger WAL buffer (default is too small)
ALTER SYSTEM SET wal_writer_delay = '10ms';            -- Flush WAL more frequently to avoid bursts
ALTER SYSTEM SET wal_writer_flush_after = '1MB';       -- Flush after 1MB of WAL

-- Reduce fsync overhead
ALTER SYSTEM SET commit_delay = 10;                    -- Microseconds to wait for group commit
ALTER SYSTEM SET commit_siblings = 5;                  -- Min concurrent transactions for commit_delay

SELECT pg_reload_conf();

-- PostgREST roles for self-hosted Supabase compatibility
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'postgres';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

GRANT service_role TO authenticator;

-- ---------------------------------------------------------------------------
-- Browser sessions tables (used by interact / persistent profiles)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.browser_sessions (
  id uuid NOT NULL,
  team_id text NOT NULL,
  scrape_id uuid,
  browser_id text NOT NULL,
  workspace_id text NOT NULL DEFAULT '',
  context_id text NOT NULL DEFAULT '',
  cdp_url text NOT NULL,
  cdp_path text NOT NULL DEFAULT '',
  cdp_interactive_path text NOT NULL DEFAULT '',
  stream_web_view boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active',
  ttl_total integer NOT NULL DEFAULT 600000,
  ttl_without_activity integer,
  credits_used numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT browser_sessions_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS browser_sessions_team_id_idx ON public.browser_sessions (team_id);
CREATE INDEX IF NOT EXISTS browser_sessions_scrape_id_idx ON public.browser_sessions (scrape_id);
CREATE INDEX IF NOT EXISTS browser_sessions_browser_id_idx ON public.browser_sessions (browser_id);
CREATE INDEX IF NOT EXISTS browser_sessions_status_idx ON public.browser_sessions (status);

CREATE TABLE IF NOT EXISTS public.browser_session_activities (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  team_id text NOT NULL,
  session_id uuid NOT NULL REFERENCES public.browser_sessions(id),
  source text NOT NULL,
  language text NOT NULL DEFAULT 'node',
  timeout integer NOT NULL DEFAULT 30,
  exit_code integer,
  killed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT browser_session_activities_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS browser_session_activities_session_id_idx ON public.browser_session_activities (session_id);

-- ---------------------------------------------------------------------------
-- Requests / scrapes tables (used by logging and interact replay)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.requests (
  id uuid NOT NULL,
  kind text NOT NULL,
  api_version text,
  team_id text NOT NULL,
  origin text,
  integration text,
  target_hint text,
  dr_clean_by timestamptz,
  api_key_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT requests_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS requests_team_id_idx ON public.requests (team_id);

CREATE TABLE IF NOT EXISTS public.scrapes (
  id uuid NOT NULL,
  request_id uuid,
  url text,
  is_successful boolean NOT NULL DEFAULT false,
  error text,
  time_taken numeric,
  team_id text NOT NULL,
  options jsonb,
  cost_tracking jsonb,
  pdf_num_pages integer,
  credits_cost numeric DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scrapes_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS scrapes_team_id_idx ON public.scrapes (team_id);
CREATE INDEX IF NOT EXISTS scrapes_request_id_idx ON public.scrapes (request_id);

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE ON SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;

CREATE SCHEMA IF NOT EXISTS nuq;

DO $$ BEGIN
  CREATE TYPE nuq.job_status AS ENUM ('queued', 'active', 'completed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE nuq.group_status AS ENUM ('active', 'completed', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS nuq.queue_scrape (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  status nuq.job_status NOT NULL DEFAULT 'queued'::nuq.job_status,
  data jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  priority int NOT NULL DEFAULT 0,
  lock uuid,
  locked_at timestamp with time zone,
  stalls integer,
  finished_at timestamp with time zone,
  listen_channel_id text, -- for listenable jobs over rabbitmq
  returnvalue jsonb, -- only for selfhost
  failedreason text, -- only for selfhost
  owner_id uuid,
  group_id uuid,
  CONSTRAINT queue_scrape_pkey PRIMARY KEY (id)
);

ALTER TABLE nuq.queue_scrape
SET (autovacuum_vacuum_scale_factor = 0.01,
     autovacuum_analyze_scale_factor = 0.01,
     autovacuum_vacuum_cost_limit = 10000,
     autovacuum_vacuum_cost_delay = 0);

CREATE INDEX IF NOT EXISTS queue_scrape_active_locked_at_idx ON nuq.queue_scrape USING btree (locked_at) WHERE (status = 'active'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_queued_optimal_2_idx ON nuq.queue_scrape (priority ASC, created_at ASC, id) WHERE (status = 'queued'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_failed_created_at_idx ON nuq.queue_scrape USING btree (created_at) WHERE (status = 'failed'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_completed_created_at_idx ON nuq.queue_scrape USING btree (created_at) WHERE (status = 'completed'::nuq.job_status);

-- Indexes for crawl-status.ts queries
-- For getGroupAnyJob: query by group_id, owner_id, and data->>'mode' = 'single_urls'
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_group_owner_mode_idx ON nuq.queue_scrape (group_id, owner_id) WHERE ((data->>'mode') = 'single_urls');

-- For getGroupNumericStats: query by group_id and data->>'mode', grouped by status
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_group_mode_status_idx ON nuq.queue_scrape (group_id, status) WHERE ((data->>'mode') = 'single_urls');

-- For getCrawlJobsForListing: query by group_id, status='completed', data->>'mode', ordered by finished_at, created_at
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_group_completed_listing_idx ON nuq.queue_scrape (group_id, finished_at ASC, created_at ASC) WHERE (status = 'completed'::nuq.job_status AND (data->>'mode') = 'single_urls');

-- For group finish cron
CREATE INDEX IF NOT EXISTS idx_queue_scrape_group_status ON nuq.queue_scrape (group_id, status) WHERE status IN ('active', 'queued');

CREATE TABLE IF NOT EXISTS nuq.queue_scrape_backlog (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  data jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  priority int NOT NULL DEFAULT 0,
  listen_channel_id text, -- for listenable jobs over rabbitmq
  owner_id uuid,
  group_id uuid,
  times_out_at timestamptz,
  CONSTRAINT queue_scrape_backlog_pkey PRIMARY KEY (id)
);

-- For getBackloggedJobIDsOfOwner: query backlog by owner_id
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_backlog_owner_id_idx ON nuq.queue_scrape_backlog (owner_id);

-- For getGroupNumericStats backlog query: query by group_id and data->>'mode' on backlog table
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_backlog_group_mode_idx ON nuq.queue_scrape_backlog (group_id) WHERE ((data->>'mode') = 'single_urls');

SELECT cron.schedule('nuq_queue_scrape_clean_completed', '*/5 * * * *', $$
  DELETE FROM nuq.queue_scrape WHERE nuq.queue_scrape.status = 'completed'::nuq.job_status AND nuq.queue_scrape.created_at < now() - interval '1 hour' AND group_id IS NULL;
$$);

SELECT cron.schedule('nuq_queue_scrape_clean_failed', '*/5 * * * *', $$
  DELETE FROM nuq.queue_scrape WHERE nuq.queue_scrape.status = 'failed'::nuq.job_status AND nuq.queue_scrape.created_at < now() - interval '6 hours' AND group_id IS NULL;
$$);

SELECT cron.schedule('nuq_queue_scrape_lock_reaper', '15 seconds', $$
  UPDATE nuq.queue_scrape SET status = 'queued'::nuq.job_status, lock = null, locked_at = null, stalls = COALESCE(stalls, 0) + 1 WHERE nuq.queue_scrape.locked_at <= now() - interval '1 minute' AND nuq.queue_scrape.status = 'active'::nuq.job_status AND COALESCE(nuq.queue_scrape.stalls, 0) < 9;
  WITH stallfail AS (UPDATE nuq.queue_scrape SET status = 'failed'::nuq.job_status, lock = null, locked_at = null, stalls = COALESCE(stalls, 0) + 1 WHERE nuq.queue_scrape.locked_at <= now() - interval '1 minute' AND nuq.queue_scrape.status = 'active'::nuq.job_status AND COALESCE(nuq.queue_scrape.stalls, 0) >= 9 RETURNING id)
  SELECT pg_notify('nuq.queue_scrape', (id::text || '|' || 'failed'::text)) FROM stallfail;
$$);

SELECT cron.schedule('nuq_queue_scrape_backlog_reaper', '* * * * *', $$
  DELETE FROM nuq.queue_scrape_backlog
  WHERE nuq.queue_scrape_backlog.times_out_at < now();
$$);

SELECT cron.schedule('nuq_queue_scrape_reindex', '0 9 * * *', $$
  REINDEX TABLE CONCURRENTLY nuq.queue_scrape;
$$);

CREATE TABLE IF NOT EXISTS nuq.queue_crawl_finished (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  status nuq.job_status NOT NULL DEFAULT 'queued'::nuq.job_status,
  data jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  priority int NOT NULL DEFAULT 0,
  lock uuid,
  locked_at timestamp with time zone,
  stalls integer,
  finished_at timestamp with time zone,
  listen_channel_id text, -- for listenable jobs over rabbitmq
  returnvalue jsonb, -- only for selfhost
  failedreason text, -- only for selfhost
  owner_id uuid,
  group_id uuid,
  CONSTRAINT queue_crawl_finished_pkey PRIMARY KEY (id)
);

ALTER TABLE nuq.queue_crawl_finished
SET (autovacuum_vacuum_scale_factor = 0.01,
     autovacuum_analyze_scale_factor = 0.01,
     autovacuum_vacuum_cost_limit = 10000,
     autovacuum_vacuum_cost_delay = 0);

CREATE INDEX IF NOT EXISTS queue_crawl_finished_active_locked_at_idx ON nuq.queue_crawl_finished USING btree (locked_at) WHERE (status = 'active'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_crawl_finished_queued_optimal_2_idx ON nuq.queue_crawl_finished (priority ASC, created_at ASC, id) WHERE (status = 'queued'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_crawl_finished_failed_created_at_idx ON nuq.queue_crawl_finished USING btree (created_at) WHERE (status = 'failed'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_crawl_finished_completed_created_at_idx ON nuq.queue_crawl_finished USING btree (created_at) WHERE (status = 'completed'::nuq.job_status);

SELECT cron.schedule('nuq_queue_crawl_finished_clean_completed', '*/5 * * * *', $$
  DELETE FROM nuq.queue_crawl_finished WHERE nuq.queue_crawl_finished.status = 'completed'::nuq.job_status AND nuq.queue_crawl_finished.created_at < now() - interval '1 hour' AND group_id IS NULL;
$$);

SELECT cron.schedule('nuq_queue_crawl_finished_clean_failed', '*/5 * * * *', $$
  DELETE FROM nuq.queue_crawl_finished WHERE nuq.queue_crawl_finished.status = 'failed'::nuq.job_status AND nuq.queue_crawl_finished.created_at < now() - interval '6 hours' AND group_id IS NULL;
$$);

SELECT cron.schedule('nuq_queue_crawl_finished_lock_reaper', '15 seconds', $$
  UPDATE nuq.queue_crawl_finished SET status = 'queued'::nuq.job_status, lock = null, locked_at = null, stalls = COALESCE(stalls, 0) + 1 WHERE nuq.queue_crawl_finished.locked_at <= now() - interval '1 minute' AND nuq.queue_crawl_finished.status = 'active'::nuq.job_status AND COALESCE(nuq.queue_crawl_finished.stalls, 0) < 9;
  WITH stallfail AS (UPDATE nuq.queue_crawl_finished SET status = 'failed'::nuq.job_status, lock = null, locked_at = null, stalls = COALESCE(stalls, 0) + 1 WHERE nuq.queue_crawl_finished.locked_at <= now() - interval '1 minute' AND nuq.queue_crawl_finished.status = 'active'::nuq.job_status AND COALESCE(nuq.queue_crawl_finished.stalls, 0) >= 9 RETURNING id)
  SELECT pg_notify('nuq.queue_crawl_finished', (id::text || '|' || 'failed'::text)) FROM stallfail;
$$);

SELECT cron.schedule('nuq_queue_crawl_finished_reindex', '0 9 * * *', $$
  REINDEX TABLE CONCURRENTLY nuq.queue_crawl_finished;
$$);

CREATE TABLE IF NOT EXISTS nuq.group_crawl (
  id uuid NOT NULL,
  status nuq.group_status NOT NULL DEFAULT 'active'::nuq.group_status,
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_id uuid NOT NULL,
  ttl int8 NOT NULL DEFAULT 86400000,
  expires_at timestamptz,
  CONSTRAINT group_crawl_pkey PRIMARY KEY (id)
);

-- Index for group finish cron to find active groups
CREATE INDEX IF NOT EXISTS idx_group_crawl_status ON nuq.group_crawl (status) WHERE status = 'active'::nuq.group_status;

-- Index for backlog group_id lookups
CREATE INDEX IF NOT EXISTS idx_queue_scrape_backlog_group_id ON nuq.queue_scrape_backlog (group_id);

SELECT cron.schedule('nuq_group_crawl_finished', '15 seconds', $$
  WITH finished_groups AS (
    UPDATE nuq.group_crawl
    SET status = 'completed'::nuq.group_status,
        expires_at = now() + MAKE_INTERVAL(secs => nuq.group_crawl.ttl / 1000)
    WHERE status = 'active'::nuq.group_status
      AND NOT EXISTS (
        SELECT 1 FROM nuq.queue_scrape
        WHERE nuq.queue_scrape.status IN ('active', 'queued')
          AND nuq.queue_scrape.group_id = nuq.group_crawl.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM nuq.queue_scrape_backlog
        WHERE nuq.queue_scrape_backlog.group_id = nuq.group_crawl.id
      )
    RETURNING id, owner_id
  )
  INSERT INTO nuq.queue_crawl_finished (data, owner_id, group_id)
  SELECT '{}'::jsonb, finished_groups.owner_id, finished_groups.id
  FROM finished_groups;
$$);

SELECT cron.schedule('nuq_group_crawl_clean', '*/5 * * * *', $$
  WITH cleaned_groups AS (
    DELETE FROM nuq.group_crawl
    WHERE nuq.group_crawl.status = 'completed'::nuq.group_status
      AND nuq.group_crawl.expires_at < now()
    RETURNING *
  ), cleaned_jobs_queue_scrape AS (
    DELETE FROM nuq.queue_scrape
    WHERE nuq.queue_scrape.group_id IN (SELECT id FROM cleaned_groups)
  ), cleaned_jobs_queue_scrape_backlog AS (
    DELETE FROM nuq.queue_scrape_backlog
    WHERE nuq.queue_scrape_backlog.group_id IN (SELECT id FROM cleaned_groups)
  ), cleaned_jobs_crawl_finished AS (
    DELETE FROM nuq.queue_crawl_finished
    WHERE nuq.queue_crawl_finished.group_id IN (SELECT id FROM cleaned_groups)
  )
  SELECT 1;
$$);
