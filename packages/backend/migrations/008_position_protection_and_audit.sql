-- Migration 008: Post-Execution Position Protection Versioning, Idempotency & Audit Trail

ALTER TABLE positions ADD COLUMN IF NOT EXISTS protection_version INT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS position_protection_requests (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL REFERENCES virtual_accounts(id),
  position_id VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  payload_signature TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  CONSTRAINT uq_protection_account_idempotency UNIQUE (account_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_protection_requests_account
  ON position_protection_requests(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS position_protection_audit (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL REFERENCES virtual_accounts(id),
  position_id VARCHAR(64) NOT NULL,
  global_instrument_id VARCHAR(128) NOT NULL,
  previous_sl NUMERIC(12, 2),
  new_sl NUMERIC(12, 2),
  previous_tp NUMERIC(12, 2),
  new_tp NUMERIC(12, 2),
  quantity INT NOT NULL,
  entry_price NUMERIC(12, 2) NOT NULL,
  reference_ltp NUMERIC(12, 2) NOT NULL,
  protection_version INT NOT NULL,
  source VARCHAR(32) NOT NULL,
  idempotency_key VARCHAR(128),
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_protection_audit_position
  ON position_protection_audit(account_id, position_id, created_at DESC);
