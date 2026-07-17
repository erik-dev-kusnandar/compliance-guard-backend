-- Compliance Guard Database Schema

-- Drop existing tables if they exist
DROP TABLE IF EXISTS scraping_queue CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TYPE IF EXISTS queue_status CASCADE;

-- Create custom ENUM type for queue status
CREATE TYPE queue_status AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- Create users table
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'Analyst',
    status TEXT DEFAULT 'Active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create scraping_queue table
CREATE TABLE scraping_queue (
    id SERIAL PRIMARY KEY,
    search_query TEXT NOT NULL,
    target_url TEXT UNIQUE NOT NULL,
    status queue_status DEFAULT 'PENDING',
    retry_count INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    locked_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    screenshot_path TEXT
);

-- Create partial index on created_at WHERE status = 'PENDING'
CREATE INDEX idx_scraping_queue_pending ON scraping_queue (created_at)
    WHERE status = 'PENDING';
