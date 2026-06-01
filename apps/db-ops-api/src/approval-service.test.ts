import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

// Mock pool as hoisted variable so factory functions can access it
const { mockPool } = vi.hoisted(() => ({
  mockPool: {
    execute: vi.fn(),
    query: vi.fn(),
  },
}));

vi.mock('./db-connection', () => ({
  dbConnection: {
    getPool: vi.fn(() => mockPool),
  },
}));

vi.mock('./sql-executor', () => ({
  sqlExecutor: {
    executeSql: vi.fn(),
  },
}));

vi.mock('./llm-service', () => ({
  llmService: {
    chat: vi.fn(),
  },
}));

import { approvalService } from './approval-service.js';
import { dbConnection } from './db-connection.js';
import { sqlExecutor } from './sql-executor.js';
import { llmService } from './llm-service.js';

describe('ApprovalService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('writeEvent', () => {
    it('Test 1: should insert into approval_events with correct parameterized values', async () => {
      await (approvalService as any).writeEvent(1, 'submitted', { key: 'val' }, 42);

      expect(mockPool.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO approval_events'),
        [1, 'submitted', JSON.stringify({ key: 'val' }), 42],
      );
    });
  });

  describe('getApprovalEvents', () => {
    it('Test 2: should return events ordered by created_at ASC with parsed event_data', async () => {
      const mockRows = [
        { id: 1, request_id: 1, event_type: 'submitted', event_data: null, created_at: '2024-01-01T00:00:00Z' },
        { id: 2, request_id: 1, event_type: 'approved', event_data: '{"key":"val"}', created_at: '2024-01-02T00:00:00Z' },
      ];
      mockPool.execute.mockResolvedValue([mockRows, null] as any);

      const result = await (approvalService as any).getApprovalEvents(1);

      expect(mockPool.execute).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY created_at ASC'),
        [1],
      );
      expect(result).toHaveLength(2);
      // event_data should be parsed from JSON string to object
      expect(typeof result[1].event_data).toBe('object');
      expect(result[1].event_data).toEqual({ key: 'val' });
    });
  });

  describe('reviewRequest - execute_after_approve', () => {
    it('Test 3: should skip sql execution when execute_after_approve is false, set status to approved only', async () => {
      mockPool.execute
        .mockResolvedValueOnce([[{ id: 1, instance_id: 1, sql_text: 'SELECT 1', status: 'pending' }]] as any)
        .mockResolvedValueOnce([{}, null] as any)   // UPDATE approved
        .mockResolvedValueOnce([{}, null] as any);  // writeEvent INSERT

      const result = await approvalService.reviewRequest(1, {
        action: 'approve',
        reviewed_by: 1,
        execute_after_approve: false,
      });

      expect(sqlExecutor.executeSql).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('Test 4: should execute sql when execute_after_approve is true (default)', async () => {
      mockPool.execute
        .mockResolvedValueOnce([[{ id: 1, instance_id: 1, sql_text: 'SELECT 1', status: 'pending' }]] as any)
        .mockResolvedValueOnce([{}, null] as any)   // UPDATE status + execution_result
        .mockResolvedValueOnce([{}, null] as any)   // writeEvent approved
        .mockResolvedValueOnce([{}, null] as any);  // writeEvent executed

      (sqlExecutor.executeSql as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, rowsAffected: 5, duration: 100 });

      const result = await approvalService.reviewRequest(1, {
        action: 'approve',
        reviewed_by: 1,
      });

      expect(sqlExecutor.executeSql).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe('reviewRequest - event writing', () => {
    it('Test 5: should write approved and executed events to approval_events after approve+execute', async () => {
      mockPool.execute
        .mockResolvedValueOnce([[{ id: 1, instance_id: 1, sql_text: 'SELECT 1', status: 'pending' }]] as any)
        .mockResolvedValueOnce([{}, null] as any)   // UPDATE status + execution_result
        .mockResolvedValueOnce([{}, null] as any)   // writeEvent approved
        .mockResolvedValueOnce([{}, null] as any);  // writeEvent executed

      (sqlExecutor.executeSql as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, rowsAffected: 5, duration: 100 });

      await approvalService.reviewRequest(1, {
        action: 'approve',
        reviewed_by: 1,
      });

      // Check writeEvent was called with 'approved'
      expect(mockPool.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO approval_events'),
        expect.arrayContaining([1, 'approved']),
      );
      // Check writeEvent was called with 'executed'
      expect(mockPool.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO approval_events'),
        expect.arrayContaining([1, 'executed']),
      );
    });

    it('Test 5b: should write rejected event to approval_events after reject, with review_notes', async () => {
      mockPool.execute
        .mockResolvedValueOnce([[{ id: 1, instance_id: 1, sql_text: 'SELECT 1', status: 'pending' }]] as any)
        .mockResolvedValueOnce([{}, null] as any)   // UPDATE rejected
        .mockResolvedValueOnce([{}, null] as any);  // writeEvent rejected

      await approvalService.reviewRequest(1, {
        action: 'reject',
        reviewed_by: 1,
        notes: 'Not safe',
      });

      // Check UPDATE sets review_notes
      expect(mockPool.execute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE approval_requests'),
        ['rejected', 1, 'Not safe', 1],
      );
      // Check writeEvent was called with 'rejected'
      expect(mockPool.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO approval_events'),
        expect.arrayContaining([1, 'rejected']),
      );
      // sqlExecutor should NOT be called for reject
      expect(sqlExecutor.executeSql).not.toHaveBeenCalled();
    });
  });

  describe('batchReview', () => {
    it('Test 6: should process all items sequentially and return per-item results', async () => {
      // First item (approve with execute) — 4 pool calls
      mockPool.execute
        .mockResolvedValueOnce([[{ id: 1, instance_id: 1, sql_text: 'SELECT 1', status: 'pending' }]] as any)
        .mockResolvedValueOnce([{}, null] as any)   // UPDATE status + execution_result
        .mockResolvedValueOnce([{}, null] as any)   // writeEvent approved
        .mockResolvedValueOnce([{}, null] as any);  // writeEvent executed

      (sqlExecutor.executeSql as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true, rowsAffected: 1, duration: 10 });

      // Second item (reject) — 3 pool calls
      mockPool.execute
        .mockResolvedValueOnce([[{ id: 2, instance_id: 1, sql_text: 'SELECT 2', status: 'pending' }]] as any)
        .mockResolvedValueOnce([{}, null] as any)   // UPDATE rejected
        .mockResolvedValueOnce([{}, null] as any);  // writeEvent rejected

      const results = await (approvalService as any).batchReview({
        items: [
          { id: 1, action: 'approve', execute_after_approve: true },
          { id: 2, action: 'reject', execute_after_approve: false },
        ],
        reviewed_by: 1,
        notes: 'Batch review',
      });

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });

    it('Test 7: one failure should not block subsequent items (try/catch isolation)', async () => {
      // First item: SELECT throws (DB error) — reviewRequest propagates the error
      mockPool.execute
        .mockRejectedValueOnce(new Error('DB connection lost'))
        // Second item: approve with execute_after_approve=false
        .mockResolvedValueOnce([[{ id: 2, instance_id: 1, sql_text: 'SELECT 2', status: 'pending' }]] as any)
        .mockResolvedValueOnce([{}, null] as any)   // UPDATE approved
        .mockResolvedValueOnce([{}, null] as any);  // writeEvent approved

      const results = await (approvalService as any).batchReview({
        items: [
          { id: 1, action: 'approve', execute_after_approve: true },
          { id: 2, action: 'approve', execute_after_approve: false },
        ],
        reviewed_by: 1,
        notes: 'Batch review',
      });

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toBeDefined();
      expect(results[1].success).toBe(true);
    });
  });

  describe('submitForApproval - event writing', () => {
    beforeEach(() => {
      // Mock crypto for deterministic hash
      vi.spyOn(crypto, 'createHash').mockReturnValue({
        update: vi.fn().mockReturnThis(),
        digest: vi.fn().mockReturnValue('mockedhash'),
      } as any);
    });

    it('Test 9: should write submitted event after INSERT INTO approval_requests when requestId is available', async () => {
      mockPool.execute
        .mockResolvedValueOnce([{ insertId: 5 }] as any)      // INSERT approval_requests
        .mockResolvedValueOnce([{}, null] as any);             // writeEvent submitted

      (llmService.chat as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await approvalService.submitForApproval({
        instance_id: 1,
        sql_text: 'DROP TABLE users',
        submitted_by: 1,
      });

      expect(mockPool.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO approval_events'),
        [5, 'submitted', '{}', 1],
      );
    });

    it('Test 10: should write ai_reviewed event when AI recommendation exists', async () => {
      mockPool.execute
        .mockResolvedValueOnce([{ insertId: 5 }] as any)      // INSERT approval_requests
        .mockResolvedValueOnce([{}, null] as any)             // writeEvent submitted
        .mockResolvedValueOnce([{}, null] as any);            // writeEvent ai_reviewed

      (llmService.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
        content: '{"risk_level":"critical","recommendation":"reject","reasoning":"Dangerous DROP"}',
      });

      await approvalService.submitForApproval({
        instance_id: 1,
        sql_text: 'DROP TABLE users',
        submitted_by: 1,
      });

      // Should have both 'submitted' and 'ai_reviewed' events
      expect(mockPool.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO approval_events'),
        expect.arrayContaining([5, 'ai_reviewed']),
      );
    });
  });
});
