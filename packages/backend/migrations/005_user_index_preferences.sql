-- Migration 005: User Selected Benchmark Indices Preferences
CREATE TABLE IF NOT EXISTS user_index_preferences (
    user_id VARCHAR(64) PRIMARY KEY,
    selected_indices_json TEXT NOT NULL DEFAULT '["NSE:NIFTY 50:99926000","NSE:BANKNIFTY:99926009","BSE:SENSEX:99919000"]',
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_index_preferences_user ON user_index_preferences(user_id);

