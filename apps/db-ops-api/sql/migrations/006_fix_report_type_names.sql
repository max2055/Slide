-- ============================================
-- Migration 006: Fix report type naming inconsistency
-- Phase 103 — RPT-03: Unify slow-query -> slow_query
-- ============================================
-- Purpose: The ReportType type previously allowed 'slow-query' (hyphen)
-- but the schema ENUM and routing code always used 'slow_query' (underscore).
-- This migration updates any rows that may have the hyphenated value.
-- Idempotent: no-op if no matching rows exist.
-- ============================================

START TRANSACTION;

UPDATE reports SET type = 'slow_query' WHERE type = 'slow-query';

COMMIT;
