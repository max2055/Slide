ALTER TABLE `agent_runs`
  DROP INDEX `uq_agent_runs_actor_session_idempotency`,
  ADD UNIQUE KEY `uq_agent_runs_actor_idempotency` (`actor_id`, `idempotency_key`),
  ADD KEY `idx_agent_runs_actor_session` (`actor_id`, `session_id`);
