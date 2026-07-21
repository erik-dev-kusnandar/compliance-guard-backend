-- Compliance Guard Database Schema (safe — idempotent, no DROP)

-- Create custom ENUM type for queue status
DO $$ BEGIN
  CREATE TYPE queue_status AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'Analyst' CHECK (role IN ('Admin', 'Analyst', 'Viewer')),
    status TEXT DEFAULT 'Active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create scraping_queue table
CREATE TABLE IF NOT EXISTS scraping_queue (
    id SERIAL PRIMARY KEY,
    search_query TEXT NOT NULL,
    target_url TEXT UNIQUE NOT NULL,
    status queue_status DEFAULT 'PENDING',
    method TEXT DEFAULT 'API',
    retry_count INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    locked_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    screenshot_path TEXT
);

-- Create partial index on created_at WHERE status = 'PENDING'
CREATE INDEX IF NOT EXISTS idx_scraping_queue_pending ON scraping_queue (created_at)
    WHERE status = 'PENDING';

-- Create system settings table
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Default settings
INSERT INTO system_settings (key, value)
VALUES ('self_registration', 'true')
ON CONFLICT (key) DO NOTHING;

INSERT INTO system_settings (key, value)
VALUES ('evidence_retention_days', '90')
ON CONFLICT (key) DO NOTHING;

-- Create audit_log table
CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_email TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    metadata JSONB DEFAULT '{}',
    ip_address TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for filtering by user and date range
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action);

-- Add sha256_hash column to scraping_queue (idempotent)
DO $$ BEGIN
  ALTER TABLE scraping_queue ADD COLUMN sha256_hash TEXT;
EXCEPTION
  WHEN duplicate_column THEN null;
END $$;

-- Create evidence_tags table
CREATE TABLE IF NOT EXISTS evidence_tags (
    id SERIAL PRIMARY KEY,
    evidence_id INTEGER NOT NULL REFERENCES scraping_queue(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(evidence_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_evidence_tags_evidence ON evidence_tags (evidence_id);

-- Create scheduled_tasks table
CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    keyword TEXT NOT NULL,
    pages INTEGER DEFAULT 1,
    method TEXT DEFAULT 'API' CHECK (method IN ('API', 'MIMIC', 'HYBRID')),
    headless BOOLEAN DEFAULT false,
    proxy TEXT,
    cron_expression TEXT NOT NULL,
    tab_delay_min INTEGER DEFAULT 1,
    tab_delay_max INTEGER DEFAULT 3,
    enabled BOOLEAN DEFAULT true,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    last_run_at TIMESTAMP WITH TIME ZONE,
    next_run_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks (enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks (next_run_at) WHERE enabled = true;

-- Create scheduled_task_history table
CREATE TABLE IF NOT EXISTS scheduled_task_history (
    id SERIAL PRIMARY KEY,
    scheduled_task_id INTEGER NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
    tasks_created INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_scheduled_history_task ON scheduled_task_history (scheduled_task_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_history_started ON scheduled_task_history (started_at);
