ALTER TABLE ai_analysis
  ADD COLUMN analysis_envelope JSON DEFAULT NULL COMMENT 'Versioned structured analysis result',
  ADD COLUMN envelope_backfill_status ENUM('pending','parsed','legacy','failed') NOT NULL DEFAULT 'pending' COMMENT 'Envelope migration state';

CREATE INDEX idx_ai_analysis_envelope_status ON ai_analysis (envelope_backfill_status);
