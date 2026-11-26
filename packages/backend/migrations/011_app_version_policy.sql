-- Migration 011: App Version Policy, Device Installations, and Release Announcements

CREATE TABLE IF NOT EXISTS app_version_policy (
  id INT PRIMARY KEY DEFAULT 1,
  latest_version_code INT NOT NULL,
  minimum_supported_version_code INT NOT NULL,
  latest_version_name VARCHAR(32) NOT NULL,
  update_message TEXT NOT NULL,
  release_notes TEXT NOT NULL,
  play_store_url TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

-- Seed default initial policy for v1.0.1 (versionCode 36)
INSERT INTO app_version_policy (
  id, latest_version_code, minimum_supported_version_code, latest_version_name,
  update_message, release_notes, play_store_url, is_active, created_at, updated_at
) VALUES (
  1, 36, 35, 'v1.0.1',
  'A mandatory update is required to continue trading securely.',
  '• Improved chart header and fullscreen plot mode\n• Server-controlled security updates\n• Seamless in-app updates',
  'https://play.google.com/store/apps/details?id=com.indianpapertrading',
  TRUE, 1732665600000, 1732665600000
);

CREATE TABLE IF NOT EXISTS device_installations (
  id VARCHAR(64) PRIMARY KEY,
  device_token TEXT NOT NULL UNIQUE,
  user_id VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
  platform VARCHAR(32) NOT NULL DEFAULT 'android',
  app_version_code INT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_installations_platform ON device_installations(platform, app_version_code);

CREATE TABLE IF NOT EXISTS release_announcements (
  id VARCHAR(64) PRIMARY KEY,
  announcement_hash VARCHAR(64) NOT NULL UNIQUE,
  target_version_code INT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  recipient_count INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'SENT',
  created_at BIGINT NOT NULL
);
