-- ============================================
-- Database Migration: Add parent_id to chat_messages
-- ============================================
-- Purpose: Enable DAG-compatible DAG message structure
-- Date: 2026-04-15
-- ============================================

-- Add parent_id column to support message chain/DAG structure
-- This enables:
-- - Parent-child message relationships
-- - Message threading
-- - Future migration to Pi JSONL format compatibility

ALTER TABLE `chat_messages`
ADD COLUMN `parent_id` VARCHAR(100) DEFAULT NULL COMMENT 'Parent message ID for DAG/chained structure'
AFTER `message_id`;

-- Add index for efficient parent-child queries
CREATE INDEX `idx_session_parent` ON `chat_messages` (`session_id`, `parent_id`);

-- Add comment to document the purpose
ALTER TABLE `chat_messages`
COMMENT = 'Chat messages with DAG-compatible parent_id DAG support';

-- Note: Existing messages will have NULL parent_id (root messages)
-- New messages should set parent_id when replying to specific messages
