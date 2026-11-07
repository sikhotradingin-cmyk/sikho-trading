-- Migration 004: Practice Sessions, Immutable Lifetime Performance Tracking & Google Play Subscriptions

CREATE TABLE IF NOT EXISTS practice_sessions (
    id VARCHAR(64) PRIMARY KEY,
    account_id VARCHAR(64) NOT NULL REFERENCES virtual_accounts(id),
    user_id VARCHAR(64) NOT NULL,
    starting_capital_paise BIGINT NOT NULL,
    final_cash_paise BIGINT,
    realized_pnl_paise BIGINT NOT NULL DEFAULT 0,
    total_charges_paise BIGINT NOT NULL DEFAULT 0,
    trades_count INT NOT NULL DEFAULT 0,
    win_trades_count INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    started_at BIGINT NOT NULL,
    ended_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON practice_sessions(account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON practice_sessions(user_id, is_active);

CREATE TABLE IF NOT EXISTS subscriptions (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    plan_id VARCHAR(32) NOT NULL,
    status VARCHAR(20) NOT NULL,
    purchase_token VARCHAR(256),
    order_id VARCHAR(128),
    expires_at BIGINT NOT NULL,
    is_auto_renewing BOOLEAN NOT NULL DEFAULT FALSE,
    amount_inr NUMERIC(10, 2) NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, status);

ALTER TABLE virtual_accounts ADD COLUMN IF NOT EXISTS subscription_expires_at BIGINT;
ALTER TABLE virtual_accounts ADD COLUMN IF NOT EXISTS active_session_id VARCHAR(64);
