-- Additive, account-scoped history. Never backfill fictional entry/exit details.
CREATE TABLE IF NOT EXISTS execution_history (
  order_id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL REFERENCES virtual_accounts(id),
  instrument_id VARCHAR(128) NOT NULL,
  session_id VARCHAR(64),
  executed_at BIGINT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_history_account_time ON execution_history(account_id, executed_at DESC, order_id);
CREATE TABLE IF NOT EXISTS trade_closures (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL REFERENCES virtual_accounts(id),
  instrument_id VARCHAR(128) NOT NULL,
  session_id VARCHAR(64),
  exited_at BIGINT NOT NULL,
  gross_paise BIGINT NOT NULL,
  charges_paise BIGINT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trade_closures_account_time ON trade_closures(account_id, exited_at DESC, id);
CREATE TABLE IF NOT EXISTS position_history_basis (
  id VARCHAR(256) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL REFERENCES virtual_accounts(id),
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_reference ON account_ledger_entries(account_id, reference_id, entry_type);
CREATE TABLE IF NOT EXISTS order_execution_context (
  order_id VARCHAR(64) PRIMARY KEY REFERENCES orders(id),
  payload_json TEXT NOT NULL
);
