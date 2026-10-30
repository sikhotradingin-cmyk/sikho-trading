-- Migration 002: Journal Notes, Strategy Tags & Multi-Watchlists

CREATE TABLE IF NOT EXISTS journal_entries (
    id VARCHAR(64) PRIMARY KEY,
    account_id VARCHAR(64) NOT NULL REFERENCES virtual_accounts(id),
    reference_id VARCHAR(64),
    strategy_tag VARCHAR(64),
    notes TEXT,
    screenshot_url TEXT,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_journal_account ON journal_entries(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS watchlists (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    name VARCHAR(100) NOT NULL,
    instruments_json TEXT NOT NULL DEFAULT '[]',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists(user_id);

