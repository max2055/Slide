-- Preserve intact formal gates from the dormant predecessor candidate.
-- A duplicate domain fails the unique constraint; never pick a winner or erase
-- requests/unknown reservations. Missing identity is not inferred or repaired.
UPDATE investigation_requests
SET execution_domain = JSON_UNQUOTE(JSON_EXTRACT(request_snapshot, '$.executionAllocation.domain'))
WHERE execution_domain IS NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(request_snapshot, '$.executionAllocation.domain')) LIKE 'task.max222.%';
