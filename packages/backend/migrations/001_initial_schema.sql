-- Migration 001: Initial Schema for Indian Securities Paper Trading
-- All monetary values stored as integer PAISE (1 INR = 100 PAISE) to prevent floating-point drift.

CREATE TABLE IF NOT EXISTS virtual_accounts (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL, -- Multiple accounts per user allowed (No unique constraint)
    name VARCHAR(100) NOT NULL DEFAULT 'Primary Practice Account',
    tier VARCHAR(10) NOT NULL DEFAULT 'FREE', -- 'FREE' or 'PRO'
    starting_balance_paise BIGINT NOT NULL DEFAULT 10000000, -- ₹100,000.00
    cash_balance_paise BIGINT NOT NULL DEFAULT 10000000,
    locked_margin_paise BIGINT NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    is_default BOOLEAN NOT NULL DEFAULT TRUE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_virtual_accounts_user ON virtual_accounts(user_id);

CREATE TABLE IF NOT EXISTS account_ledger_entries (
    id VARCHAR(64) PRIMARY KEY,
    account_id VARCHAR(64) NOT NULL REFERENCES virtual_accounts(id),
    entry_type VARCHAR(32) NOT NULL, -- 'INITIAL_GRANT', 'RESET', 'TRADE_PNL', 'SIMULATED_CHARGES', 'CAPITAL_ADJUSTMENT'
    amount_paise BIGINT NOT NULL,
    balance_after_paise BIGINT NOT NULL,
    reference_id VARCHAR(64),
    note TEXT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_account ON account_ledger_entries(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS instruments (
    global_id VARCHAR(128) PRIMARY KEY, -- e.g. 'NFO:NIFTY26OCTFUT:999001'
    provider VARCHAR(32) NOT NULL,
    exchange VARCHAR(10) NOT NULL,
    token VARCHAR(32) NOT NULL,
    symbol VARCHAR(64) NOT NULL,
    name VARCHAR(128) NOT NULL,
    instrument_type VARCHAR(20) NOT NULL,
    is_tradable BOOLEAN NOT NULL,
    lot_size INT NOT NULL,
    tick_size NUMERIC(6, 2) NOT NULL,
    expiry DATE,
    strike_price NUMERIC(12, 2),
    underlying VARCHAR(32),
    is_simulated_fixture BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_instruments_symbol ON instruments(symbol);
CREATE INDEX IF NOT EXISTS idx_instruments_exchange ON instruments(exchange);

CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(64) PRIMARY KEY,
    account_id VARCHAR(64) NOT NULL REFERENCES virtual_accounts(id),
    global_instrument_id VARCHAR(128) NOT NULL REFERENCES instruments(global_id),
    side VARCHAR(4) NOT NULL, -- 'BUY', 'SELL'
    order_type VARCHAR(16) NOT NULL, -- 'MARKET', 'LIMIT', 'STOP_MARKET', 'TARGET'
    quantity INT NOT NULL,
    requested_price NUMERIC(12, 2),
    trigger_price NUMERIC(12, 2),
    executed_price NUMERIC(12, 2),
    status VARCHAR(20) NOT NULL, -- 'PENDING', 'TRIGGERED', 'EXECUTED', 'CANCELLED', 'REJECTED'
    idempotency_key VARCHAR(64) NOT NULL,
    rejection_reason TEXT,
    oco_companion_order_id VARCHAR(64),
    position_id VARCHAR(64),
    estimated_charges_paise BIGINT NOT NULL DEFAULT 0,
    executed_at BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    CONSTRAINT uq_account_idempotency UNIQUE(account_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_orders_account ON orders(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS positions (
    id VARCHAR(64) PRIMARY KEY,
    account_id VARCHAR(64) NOT NULL REFERENCES virtual_accounts(id),
    global_instrument_id VARCHAR(128) NOT NULL REFERENCES instruments(global_id),
    quantity INT NOT NULL, -- Positive for Long, Negative for Short, 0 for Closed
    average_entry_price NUMERIC(12, 2) NOT NULL,
    realized_pnl_paise BIGINT NOT NULL DEFAULT 0,
    stop_loss_price NUMERIC(12, 2),
    target_price NUMERIC(12, 2),
    stop_order_id VARCHAR(64),
    target_order_id VARCHAR(64),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    CONSTRAINT uq_account_instrument UNIQUE(account_id, global_instrument_id)
);

CREATE INDEX IF NOT EXISTS idx_positions_account ON positions(account_id);
