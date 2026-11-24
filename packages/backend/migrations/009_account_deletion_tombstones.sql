-- Migration 009: Pseudonymous Account Deletion Tombstones for Immediate Session Revocation, Replay Defense & Audit
CREATE TABLE IF NOT EXISTS deleted_account_tombstones (
  user_id VARCHAR(64) PRIMARY KEY,
  email_sha256 VARCHAR(64) NOT NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'IN_APP_SELF_SERVICE',
  reason TEXT,
  deleted_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deleted_account_tombstones_time
  ON deleted_account_tombstones(deleted_at DESC);
