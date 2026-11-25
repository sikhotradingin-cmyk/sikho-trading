-- Migration 010: 30-Day Trade Retention Checkpoints and Bounded Purge Indexes

CREATE TABLE IF NOT EXISTS account_history_checkpoints (
  account_id VARCHAR(64) PRIMARY KEY REFERENCES virtual_accounts(id) ON DELETE CASCADE,
  purged_trades_count INT NOT NULL DEFAULT 0,
  purged_gross_paise BIGINT NOT NULL DEFAULT 0,
  purged_charges_paise BIGINT NOT NULL DEFAULT 0,
  purged_net_paise BIGINT NOT NULL DEFAULT 0,
  purged_wins_count INT NOT NULL DEFAULT 0,
  purged_losses_count INT NOT NULL DEFAULT 0,
  purged_breakeven_count INT NOT NULL DEFAULT 0,
  purged_unknown_count INT NOT NULL DEFAULT 0,
  last_cutoff_timestamp BIGINT NOT NULL DEFAULT 0,
  last_purged_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_closures_retention ON trade_closures(account_id, exited_at);
CREATE INDEX IF NOT EXISTS idx_orders_retention ON orders(account_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_protection_audit_retention ON position_protection_audit(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_protection_requests_retention ON position_protection_requests(account_id, created_at);
