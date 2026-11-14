-- Complimentary Owner-Admin Grants and Entitlement Audit Trail
CREATE TABLE IF NOT EXISTS complimentary_grants (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_email VARCHAR(255) NOT NULL,
  source VARCHAR(64) NOT NULL DEFAULT 'OWNER_ADMIN_GRANT',
  reason TEXT NOT NULL,
  granted_by VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, REVOKED, EXPIRED
  granted_at BIGINT NOT NULL,
  expires_at BIGINT,
  revoked_at BIGINT,
  revoked_reason TEXT,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_complimentary_grants_user_status
  ON complimentary_grants(user_id, status);

CREATE TABLE IF NOT EXISTS entitlement_audit_log (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  action VARCHAR(64) NOT NULL, -- GRANT_CREATED, GRANT_REVOKED, GRANT_EXPIRED, PLAY_VERIFIED, PLAY_EXPIRED, BUG_REMEDIATION_DOWNGRADE, UNAUTHORIZED_PRO_HEALED
  previous_tier VARCHAR(16) NOT NULL,
  new_tier VARCHAR(16) NOT NULL,
  source VARCHAR(64) NOT NULL,
  reason TEXT NOT NULL,
  actor VARCHAR(128) NOT NULL,
  metadata_json TEXT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entitlement_audit_log_user
  ON entitlement_audit_log(user_id, created_at DESC);

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS verification_source VARCHAR(64) NOT NULL DEFAULT 'GOOGLE_PLAY_VERIFIED';
