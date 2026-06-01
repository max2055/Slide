-- Migration 003: Add target_database to approval_requests (Phase 89 Gap Closure - D-01)
-- Adds a target database/schema column so that auto-exec DDL runs against the
-- intended database instead of the default connection database.

ALTER TABLE approval_requests
ADD COLUMN target_database VARCHAR(128) DEFAULT NULL COMMENT 'Target database/schema for SQL execution (Phase 89 D-01)';
