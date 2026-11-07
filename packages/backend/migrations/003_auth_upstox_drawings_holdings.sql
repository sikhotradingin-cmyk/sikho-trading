-- Migration 003: Real User Authentication, Provider Instrument Mappings, Per-User Drawings & Delivery Holdings

CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    email VARCHAR(160) NOT NULL,
    name VARCHAR(120) NOT NULL,
    password_hash VARCHAR(256),
    google_sub VARCHAR(128) UNIQUE,
    avatar_url TEXT,
    pin_hash VARCHAR(256),
    biometric_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    recovery_code_hash VARCHAR(256),
    recovery_expires_at BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_instrument_mappings (
    canonical_id VARCHAR(128) PRIMARY KEY,
    exchange VARCHAR(10) NOT NULL,
    exchange_token VARCHAR(32) NOT NULL,
    upstox_key VARCHAR(128),
    smartapi_global_id VARCHAR(128),
    symbol VARCHAR(64) NOT NULL,
    underlying VARCHAR(32),
    instrument_type VARCHAR(20) NOT NULL,
    expiry_iso VARCHAR(16),
    strike_price NUMERIC(12, 2),
    option_type VARCHAR(4),
    lot_size INT NOT NULL DEFAULT 1,
    tick_size NUMERIC(6, 2) NOT NULL DEFAULT 0.05,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pim_exchange_token ON provider_instrument_mappings(exchange, exchange_token);
CREATE INDEX IF NOT EXISTS idx_pim_upstox_key ON provider_instrument_mappings(upstox_key);

CREATE TABLE IF NOT EXISTS chart_drawings (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    instrument_id VARCHAR(128) NOT NULL,
    drawings_json TEXT NOT NULL DEFAULT '[]',
    updated_at BIGINT NOT NULL,
    CONSTRAINT uq_user_instrument_drawings UNIQUE(user_id, instrument_id)
);

CREATE INDEX IF NOT EXISTS idx_chart_drawings_user ON chart_drawings(user_id, instrument_id);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS product_type VARCHAR(16) NOT NULL DEFAULT 'INTRADAY';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS product_type VARCHAR(16) NOT NULL DEFAULT 'INTRADAY';
ALTER TABLE virtual_accounts ADD COLUMN IF NOT EXISTS baseline_reset_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS option_type VARCHAR(4);
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS upstox_instrument_key VARCHAR(128);
