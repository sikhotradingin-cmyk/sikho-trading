import { createHash, randomUUID } from 'node:crypto';
import { IDatabase } from '../db/database.js';

export interface AppVersionPolicy {
  latestVersionCode: number;
  minimumSupportedVersionCode: number;
  latestVersionName: string;
  updateMessage: string;
  releaseNotes: string;
  playStoreUrl: string;
  isActive: boolean;
  updatedAt: number;
}

export interface DeviceInstallation {
  id: string;
  deviceToken: string;
  userId?: string | null;
  platform: string;
  appVersionCode: number;
  createdAt: number;
  updatedAt: number;
}

export interface AnnouncementResult {
  success: boolean;
  announcementId?: string;
  dryRun: boolean;
  targetVersionCode: number;
  recipientCount: number;
  message: string;
  alreadySent?: boolean;
}

const DEFAULT_POLICY: AppVersionPolicy = {
  latestVersionCode: 37,
  minimumSupportedVersionCode: 35,
  latestVersionName: 'v1.0.1',
  updateMessage: 'A mandatory update is required to continue trading securely.',
  releaseNotes: '• Professional KLineChart v10 integration with decoupled adapter\n• Technical indicator library with custom session VWAP and ATR\n• Vector drawing workspace with measurement and risk/reward overlays\n• Draggable on-chart TP/SL protection lines with real-time P&L',
  playStoreUrl: 'https://play.google.com/store/apps/details?id=com.indianpapertrading',
  isActive: true,
  updatedAt: 1732665600000,
};

let cachedPolicy: AppVersionPolicy | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 15000; // 15-second in-memory cache to absorb traffic spikes

export async function getVersionPolicy(db: IDatabase, forceFresh = false): Promise<AppVersionPolicy> {
  const now = Date.now();
  if (!forceFresh && cachedPolicy && now < cacheExpiresAt) {
    return cachedPolicy;
  }

  try {
    const res = await db.query(
      `SELECT latest_version_code, minimum_supported_version_code, latest_version_name,
              update_message, release_notes, play_store_url, is_active, updated_at
       FROM app_version_policy
       WHERE id = 1`
    );

    if (res.rows && res.rows.length > 0) {
      const r = res.rows[0];
      cachedPolicy = {
        latestVersionCode: Number(r.latest_version_code),
        minimumSupportedVersionCode: Number(r.minimum_supported_version_code),
        latestVersionName: String(r.latest_version_name),
        updateMessage: String(r.update_message),
        releaseNotes: String(r.release_notes),
        playStoreUrl: String(r.play_store_url),
        isActive: Boolean(r.is_active),
        updatedAt: Number(r.updated_at),
      };
      cacheExpiresAt = now + CACHE_TTL_MS;
      return cachedPolicy;
    }
  } catch (err: any) {
    console.warn('[VersionPolicy] Failed to load policy from DB, using defaults:', err?.message);
  }

  return DEFAULT_POLICY;
}

export async function updateVersionPolicy(
  db: IDatabase,
  patch: Partial<AppVersionPolicy>
): Promise<AppVersionPolicy> {
  const current = await getVersionPolicy(db, true);
  const now = Date.now();

  const updated: AppVersionPolicy = {
    latestVersionCode: patch.latestVersionCode !== undefined ? Number(patch.latestVersionCode) : current.latestVersionCode,
    minimumSupportedVersionCode: patch.minimumSupportedVersionCode !== undefined ? Number(patch.minimumSupportedVersionCode) : current.minimumSupportedVersionCode,
    latestVersionName: patch.latestVersionName !== undefined ? String(patch.latestVersionName).trim() : current.latestVersionName,
    updateMessage: patch.updateMessage !== undefined ? String(patch.updateMessage).trim() : current.updateMessage,
    releaseNotes: patch.releaseNotes !== undefined ? String(patch.releaseNotes).trim() : current.releaseNotes,
    playStoreUrl: patch.playStoreUrl !== undefined ? String(patch.playStoreUrl).trim() : current.playStoreUrl,
    isActive: patch.isActive !== undefined ? Boolean(patch.isActive) : current.isActive,
    updatedAt: now,
  };

  await db.query(
    `INSERT INTO app_version_policy (
       id, latest_version_code, minimum_supported_version_code, latest_version_name,
       update_message, release_notes, play_store_url, is_active, created_at, updated_at
     ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       latest_version_code = EXCLUDED.latest_version_code,
       minimum_supported_version_code = EXCLUDED.minimum_supported_version_code,
       latest_version_name = EXCLUDED.latest_version_name,
       update_message = EXCLUDED.update_message,
       release_notes = EXCLUDED.release_notes,
       play_store_url = EXCLUDED.play_store_url,
       is_active = EXCLUDED.is_active,
       updated_at = EXCLUDED.updated_at`,
    [
      updated.latestVersionCode,
      updated.minimumSupportedVersionCode,
      updated.latestVersionName,
      updated.updateMessage,
      updated.releaseNotes,
      updated.playStoreUrl,
      updated.isActive,
      now,
      now,
    ]
  ).catch(async (_e: any) => {
    // Fallback for pg-mem or databases that prefer UPDATE
    await db.query(
      `UPDATE app_version_policy SET
         latest_version_code = $1, minimum_supported_version_code = $2, latest_version_name = $3,
         update_message = $4, release_notes = $5, play_store_url = $6, is_active = $7, updated_at = $8
       WHERE id = 1`,
      [
        updated.latestVersionCode,
        updated.minimumSupportedVersionCode,
        updated.latestVersionName,
        updated.updateMessage,
        updated.releaseNotes,
        updated.playStoreUrl,
        updated.isActive,
        now,
      ]
    );
  });

  cachedPolicy = updated;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return updated;
}

export async function registerDeviceInstallation(
  db: IDatabase,
  params: {
    token: string;
    userId?: string | null;
    platform?: string;
    appVersionCode?: number;
  }
): Promise<DeviceInstallation> {
  const token = String(params.token || '').trim();
  if (!token || token.length < 10) {
    throw new Error('Invalid device token');
  }

  const now = Date.now();
  const platform = (params.platform || 'android').toLowerCase();
  const versionCode = params.appVersionCode ? Number(params.appVersionCode) : 0;
  const userId = params.userId ? String(params.userId).trim() : null;

  const existingRes = await db.query(
    'SELECT id FROM device_installations WHERE device_token = $1',
    [token]
  );

  if (existingRes.rows && existingRes.rows.length > 0) {
    const existingId = existingRes.rows[0].id;
    await db.query(
      `UPDATE device_installations
       SET user_id = $1, platform = $2, app_version_code = $3, updated_at = $4
       WHERE id = $5`,
      [userId, platform, versionCode, now, existingId]
    );
    return {
      id: existingId,
      deviceToken: token,
      userId,
      platform,
      appVersionCode: versionCode,
      createdAt: now,
      updatedAt: now,
    };
  }

  const newId = randomUUID();
  await db.query(
    `INSERT INTO device_installations (id, device_token, user_id, platform, app_version_code, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [newId, token, userId, platform, versionCode, now, now]
  );

  return {
    id: newId,
    deviceToken: token,
    userId,
    platform,
    appVersionCode: versionCode,
    createdAt: now,
    updatedAt: now,
  };
}

export async function checkClientVersionSupported(
  db: IDatabase,
  rawHeader: string | undefined | null
): Promise<{ supported: boolean; policy: AppVersionPolicy }> {
  const policy = await getVersionPolicy(db);
  if (!policy.isActive) {
    return { supported: true, policy };
  }

  if (!rawHeader) {
    // If not supplied (e.g. web browser or dev curl), allow
    return { supported: true, policy };
  }

  const clientVersion = parseInt(String(rawHeader).trim(), 10);
  if (isNaN(clientVersion)) {
    return { supported: true, policy };
  }

  if (clientVersion < policy.minimumSupportedVersionCode) {
    return { supported: false, policy };
  }

  return { supported: true, policy };
}

export async function dispatchReleaseAnnouncement(
  db: IDatabase,
  params: {
    title?: string;
    message?: string;
    targetVersionCode?: number;
    dryRun?: boolean;
    testToken?: string;
  }
): Promise<AnnouncementResult> {
  const title = (params.title || 'Sikho Trading Update Available').trim();
  const message = (params.message || 'A new Sikho Trading update is available. Please update to continue.').trim();
  const targetVersionCode = params.targetVersionCode ? Number(params.targetVersionCode) : 37;
  const isDryRun = Boolean(params.dryRun);

  // Compute duplicate-detection hash: sha256(targetVersionCode + title + message)
  const hash = createHash('sha256')
    .update(`${targetVersionCode}:${title}:${message}`)
    .digest('hex');

  // Check if announcement already sent
  const existing = await db.query(
    'SELECT id, created_at FROM release_announcements WHERE announcement_hash = $1',
    [hash]
  );

  if (existing.rows && existing.rows.length > 0 && !isDryRun && !params.testToken) {
    return {
      success: true,
      announcementId: existing.rows[0].id,
      dryRun: false,
      targetVersionCode,
      recipientCount: 0,
      message: 'Announcement was already sent previously (duplicate prevented).',
      alreadySent: true,
    };
  }

  // Count targeted devices (devices with app_version_code < targetVersionCode)
  let countRes: any;
  if (params.testToken) {
    countRes = { rows: [{ count: 1 }] };
  } else {
    countRes = await db.query(
      'SELECT COUNT(*)::int as count FROM device_installations WHERE platform = $1 AND app_version_code < $2',
      ['android', targetVersionCode]
    );
  }
  const recipientCount = Number(countRes.rows?.[0]?.count || 0);

  const announcementId = randomUUID();
  if (!isDryRun) {
    await db.query(
      `INSERT INTO release_announcements (id, announcement_hash, target_version_code, title, message, recipient_count, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        announcementId,
        hash,
        targetVersionCode,
        title,
        message,
        recipientCount,
        'SENT',
        Date.now(),
      ]
    );
  }

  return {
    success: true,
    announcementId: isDryRun ? undefined : announcementId,
    dryRun: isDryRun,
    targetVersionCode,
    recipientCount,
    message,
    alreadySent: false,
  };
}
