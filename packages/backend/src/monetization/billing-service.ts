import { UserTier, SUBSCRIPTION_PLANS, SubscriptionPlan } from '@trading/shared';
import { IDatabase } from '../db/database.js';
import { randomUUID } from 'node:crypto';

/**
 * Result of a *real* Google Play Developer API verification.
 * `verified: true` may only be produced after the Android Publisher API confirms the token,
 * the package name, the product identity and the entitlement window.
 */
export interface PlayVerificationResult {
  verified: boolean;
  code?: string;
  error?: string;
  packageName?: string;
  productId?: string;
  expiryTimeMillis?: number;
  isAutoRenewing?: boolean;
  verificationSource: 'GOOGLE_PLAY_VERIFIED';
}

export interface PlayVerificationParams {
  packageName: string;
  productId: string;
  purchaseToken: string;
  isSubscription: boolean;
}

export type PlayPurchaseVerifier = (params: PlayVerificationParams) => Promise<PlayVerificationResult>;

/** Play Console product identity. Only this package's purchases are ever honoured. */
export const DEFAULT_GOOGLE_PLAY_PACKAGE_NAME = 'com.indianpapertrading';

const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

function normaliseServiceAccountKey(raw: string): any {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  // Allow base64-encoded JSON (common in hosted env var UIs).
  return JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8'));
}

/**
 * Builds a verifier backed by the live Google Play Developer API.
 * Fails closed: any transport/auth/parse problem surfaces as `verified: false`.
 */
export function createGooglePlayVerifier(serviceAccountKey: string): PlayPurchaseVerifier {
  return async ({ packageName, productId, purchaseToken, isSubscription }) => {
    const fail = (code: string, error: string): PlayVerificationResult => ({
      verified: false,
      code,
      error,
      verificationSource: 'GOOGLE_PLAY_VERIFIED',
    });

    let accessToken: string;
    try {
      // Imported lazily so unit tests can run without the dependency initialising crypto state.
      const { JWT } = await import('google-auth-library');
      const credentials = normaliseServiceAccountKey(serviceAccountKey);
      const client = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: [ANDROID_PUBLISHER_SCOPE],
      });
      const authorised = await client.authorize();
      accessToken = String(authorised?.access_token || '');
      if (!accessToken) return fail('ERR_PLAY_AUTH', 'Google service account did not return an access token.');
    } catch (err: any) {
      return fail(
        'ERR_PLAY_AUTH',
        `Google Play Developer API authentication failed: ${err?.message || 'unknown error'}`
      );
    }

    const base = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
    const encodedPkg = encodeURIComponent(packageName);
    const encodedToken = encodeURIComponent(purchaseToken);

    try {
      if (isSubscription) {
        const url = `${base}/${encodedPkg}/purchases/subscriptionsv2/tokens/${encodedToken}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (res.status === 404 || res.status === 400 || res.status === 410) {
          return fail('ERR_PLAY_TOKEN_INVALID', `Google Play rejected the purchase token (HTTP ${res.status}).`);
        }
        if (!res.ok) {
          return fail('ERR_PLAY_API', `Google Play Developer API returned HTTP ${res.status}.`);
        }
        const body: any = await res.json();
        const state = String(body?.subscriptionState || '');
        const activeStates = new Set([
          'SUBSCRIPTION_STATE_ACTIVE',
          'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
        ]);
        if (!activeStates.has(state)) {
          return fail('ERR_PLAY_SUBSCRIPTION_INACTIVE', `Subscription state is ${state || 'UNKNOWN'}.`);
        }
        const lineItems: any[] = Array.isArray(body?.lineItems) ? body.lineItems : [];
        const matching = lineItems.find((li) => li?.productId === productId);
        if (!matching) {
          return fail(
            'ERR_PLAY_PRODUCT_MISMATCH',
            `Purchase token is not for product '${productId}'.`
          );
        }
        const expiryMs = Date.parse(String(matching?.expiryTime || ''));
        if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) {
          return fail('ERR_PLAY_EXPIRED', 'Verified subscription has already expired.');
        }
        return {
          verified: true,
          packageName,
          productId,
          expiryTimeMillis: expiryMs,
          isAutoRenewing: true,
          verificationSource: 'GOOGLE_PLAY_VERIFIED',
        };
      }

      const url = `${base}/${encodedPkg}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodedToken}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.status === 404 || res.status === 400 || res.status === 410) {
        return fail('ERR_PLAY_TOKEN_INVALID', `Google Play rejected the purchase token (HTTP ${res.status}).`);
      }
      if (!res.ok) {
        return fail('ERR_PLAY_API', `Google Play Developer API returned HTTP ${res.status}.`);
      }
      const body: any = await res.json();
      if (Number(body?.purchaseState) !== 0) {
        return fail('ERR_PLAY_PURCHASE_STATE', `Purchase state is ${body?.purchaseState} (not purchased).`);
      }
      if (body?.productId && body.productId !== productId) {
        return fail('ERR_PLAY_PRODUCT_MISMATCH', `Purchase belongs to product '${body.productId}'.`);
      }
      return {
        verified: true,
        packageName,
        productId,
        expiryTimeMillis: undefined,
        isAutoRenewing: false,
        verificationSource: 'GOOGLE_PLAY_VERIFIED',
      };
    } catch (err: any) {
      return fail('ERR_PLAY_API', `Google Play Developer API request failed: ${err?.message || 'unknown'}`);
    }
  };
}

export type SubscriptionStatus =
  | 'ACTIVE'
  | 'PENDING'
  | 'GRACE_PERIOD'
  | 'CANCELED'
  | 'EXPIRED';

export type EntitlementSource =
  | 'PLAY_PURCHASE'
  | 'COMPLIMENTARY_GRANT'
  | 'DEV_SYNTHETIC'
  | 'NONE';

export interface ResolvedEntitlement {
  tier: UserTier;
  status: SubscriptionStatus;
  entitlementSource: EntitlementSource;
  statusLabel: string;
  isComplimentary: boolean;
  planId?: string;
  grantId?: string;
  reason?: string;
  grantedBy?: string;
  expiresAt?: number | null;
  isAutoRenewing?: boolean;
}

export interface ComplimentaryGrantRecord {
  id: string;
  userId: string;
  verifiedEmail: string;
  source: string;
  reason: string;
  grantedBy: string;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
  updatedAt: number;
}

export interface SubscriptionRecord {
  userId: string;
  tier: UserTier;
  status: SubscriptionStatus;
  productId: string;
  purchaseToken: string;
  expiryTimeMillis: number;
  isAutoRenewing: boolean;
  verifiedAt: number;
  deliveryStatus: 'VERIFIED' | 'NOT_VERIFIED';
}

export class BillingService {
  private isTestMode: boolean = false;
  private playVerifier: PlayPurchaseVerifier | null;

  constructor(
    private db: IDatabase,
    private googleServiceAccountKey?: string,
    playVerifier?: PlayPurchaseVerifier
  ) {
    if (!this.googleServiceAccountKey && process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      this.googleServiceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    }
    this.playVerifier = playVerifier || null;
  }

  public getPlayPackageName(): string {
    return (process.env.GOOGLE_PLAY_PACKAGE_NAME || DEFAULT_GOOGLE_PLAY_PACKAGE_NAME).trim();
  }

  private getPlayVerifier(): PlayPurchaseVerifier | null {
    if (this.playVerifier) return this.playVerifier;
    if (!this.googleServiceAccountKey) return null;
    this.playVerifier = createGooglePlayVerifier(this.googleServiceAccountKey);
    return this.playVerifier;
  }

  public enableTestMode(enabled: boolean = true) {
    this.isTestMode = enabled;
  }

  public isGooglePlayConfigured(): boolean {
    return Boolean(this.googleServiceAccountKey && this.googleServiceAccountKey.trim().length > 0);
  }

  public getPlans(): SubscriptionPlan[] {
    return SUBSCRIPTION_PLANS;
  }

  private async logAudit(params: {
    userId: string;
    action: string;
    previousTier: UserTier;
    newTier: UserTier;
    source: string;
    reason: string;
    actor: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO entitlement_audit_log
         (id, user_id, action, previous_tier, new_tier, source, reason, actor, metadata_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          `audit_${randomUUID()}`,
          params.userId,
          params.action,
          params.previousTier,
          params.newTier,
          params.source,
          params.reason,
          params.actor,
          params.metadata ? JSON.stringify(params.metadata) : null,
          Date.now(),
        ]
      );
    } catch {
      // Non-fatal if audit table is not yet initialized in minimal mock
    }
  }

  /**
   * Central authoritative entitlement resolver.
   * Premium ('PRO') is granted ONLY when:
   * 1. An active, non-expired verified Google Play subscription exists in `subscriptions`, OR
   * 2. An active, non-expired owner-admin complimentary grant exists in `complimentary_grants`
   *    bound to both the user's immutable `users.id` and verified `users.email`.
   *
   * Any real user in `users` whose `virtual_accounts.tier` is `'PRO'` without a valid backing
   * subscription or complimentary grant is immediately healed to `'FREE'` (fail-closed).
   */
  public async resolveEntitlement(userId: string): Promise<ResolvedEntitlement> {
    if (!userId) {
      return {
        tier: 'FREE',
        status: 'EXPIRED',
        entitlementSource: 'NONE',
        statusLabel: 'Sikho Trading Free Tier',
        isComplimentary: false,
        expiresAt: null,
        isAutoRenewing: false,
      };
    }

    const now = Date.now();

    // 1. Check active subscriptions in `subscriptions`
    const subRes = await this.db.query(
      'SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY expires_at DESC',
      [userId]
    );

    let latestExpiredSub: any = null;

    for (const sub of subRes.rows) {
      const expiresAt = Number(sub.expires_at);
      if (sub.status === 'ACTIVE') {
        if (expiresAt <= now) {
          await this.db.query(
            "UPDATE subscriptions SET status = 'EXPIRED', updated_at = $1 WHERE id = $2",
            [now, sub.id]
          );
          await this.logAudit({
            userId,
            action: 'PLAY_EXPIRED',
            previousTier: 'PRO',
            newTier: 'FREE',
            source: sub.verification_source || 'GOOGLE_PLAY_VERIFIED',
            reason: `Subscription ${sub.id} (${sub.plan_id}) expired at ${expiresAt}`,
            actor: 'SYSTEM_EXPIRY_CHECK',
          });
          if (!latestExpiredSub) latestExpiredSub = { ...sub, status: 'EXPIRED' };
          continue;
        }

        const verificationSource = sub.verification_source || 'GOOGLE_PLAY_VERIFIED';
        const isAllowedSource =
          (verificationSource === 'GOOGLE_PLAY_VERIFIED' && (this.isGooglePlayConfigured() || this.isTestMode)) ||
          (verificationSource === 'TEST_HARNESS' && this.isTestMode);

        if (isAllowedSource) {
          await this.db.query(
            "UPDATE virtual_accounts SET tier = 'PRO', subscription_expires_at = $1, updated_at = $2 WHERE user_id = $3 AND (tier != 'PRO' OR subscription_expires_at IS DISTINCT FROM $1)",
            [expiresAt, now, userId]
          ).catch(() => {});

          return {
            tier: 'PRO',
            status: 'ACTIVE',
            entitlementSource: 'PLAY_PURCHASE',
            statusLabel: 'Sikho Trading Premium Active',
            isComplimentary: false,
            planId: sub.plan_id,
            expiresAt,
            isAutoRenewing: Boolean(sub.is_auto_renewing),
          };
        }
      } else if (!latestExpiredSub) {
        latestExpiredSub = sub;
      }
    }

    // 2. Check active owner-admin complimentary grants in `complimentary_grants`
    try {
      const grantRes = await this.db.query(
        'SELECT * FROM complimentary_grants WHERE user_id = $1 ORDER BY granted_at DESC',
        [userId]
      );

      for (const grant of grantRes.rows) {
        if (grant.status !== 'ACTIVE') continue;

        const expiresAt = grant.expires_at ? Number(grant.expires_at) : null;
        if (expiresAt !== null && expiresAt <= now) {
          await this.db.query(
            "UPDATE complimentary_grants SET status = 'EXPIRED', updated_at = $1 WHERE id = $2",
            [now, grant.id]
          );
          await this.logAudit({
            userId,
            action: 'GRANT_EXPIRED',
            previousTier: 'PRO',
            newTier: 'FREE',
            source: grant.source || 'OWNER_ADMIN_GRANT',
            reason: `Complimentary grant ${grant.id} expired at ${expiresAt}`,
            actor: 'SYSTEM_EXPIRY_CHECK',
          });
          continue;
        }

        // Verify immutable userId + verified email match in `users`
        const userRes = await this.db.query(
          'SELECT id, email FROM users WHERE id = $1 LIMIT 1',
          [userId]
        );
        if (
          userRes.rows.length > 0 &&
          (userRes.rows[0].email || '').trim().toLowerCase() ===
            (grant.verified_email || '').trim().toLowerCase()
        ) {
          await this.db.query(
            "UPDATE virtual_accounts SET tier = 'PRO', subscription_expires_at = $1, updated_at = $2 WHERE user_id = $3 AND tier != 'PRO'",
            [expiresAt, now, userId]
          ).catch(() => {});

          return {
            tier: 'PRO',
            status: 'ACTIVE',
            entitlementSource: 'COMPLIMENTARY_GRANT',
            statusLabel: 'Premium — complimentary test access',
            isComplimentary: true,
            grantId: grant.id,
            reason: grant.reason,
            grantedBy: grant.granted_by,
            expiresAt,
            isAutoRenewing: false,
          };
        }
      }
    } catch {
      // Fail closed if table query fails
    }

    // 3. Check virtual_accounts for non-production synthetic dev-login test accounts ONLY,
    // or heal unauthorized PRO state for real registered users.
    const accRes = await this.db.query(
      'SELECT tier, subscription_expires_at FROM virtual_accounts WHERE user_id = $1 LIMIT 1',
      [userId]
    );
    if (accRes.rows.length > 0) {
      const accRow = accRes.rows[0];
      const accTier = (accRow.tier as UserTier) || 'FREE';
      const accExpiresAt = accRow.subscription_expires_at ? Number(accRow.subscription_expires_at) : null;

      if (accTier === 'PRO') {
        // Check if this userId belongs to a real registered user in `users`
        const realUserRes = await this.db.query('SELECT id, email FROM users WHERE id = $1 LIMIT 1', [userId]);
        const isRealUser = realUserRes.rows.length > 0;

        if (!isRealUser && process.env.NODE_ENV !== 'production') {
          // Synthetic dev-login account used in automated test suites
          if (accExpiresAt !== null && accExpiresAt <= now) {
            await this.db.query(
              "UPDATE virtual_accounts SET tier = 'FREE', updated_at = $1 WHERE user_id = $2",
              [now, userId]
            );
            await this.db.query(
              "UPDATE subscriptions SET status = 'EXPIRED', updated_at = $1 WHERE user_id = $2 AND status = 'ACTIVE'",
              [now, userId]
            );
          } else {
            return {
              tier: 'PRO',
              status: 'ACTIVE',
              entitlementSource: 'DEV_SYNTHETIC',
              statusLabel: 'Sikho Trading Premium (Dev Test)',
              isComplimentary: false,
              expiresAt: accExpiresAt,
              isAutoRenewing: false,
            };
          }
        } else {
          // Real user in `users` (or production environment) with `tier = 'PRO'` but NO active verified purchase or grant!
          // Fail closed and self-heal the database record to 'FREE'.
          await this.db.query(
            "UPDATE virtual_accounts SET tier = 'FREE', subscription_expires_at = NULL, updated_at = $1 WHERE user_id = $2",
            [now, userId]
          );
          await this.logAudit({
            userId,
            action: 'UNAUTHORIZED_PRO_HEALED',
            previousTier: 'PRO',
            newTier: 'FREE',
            source: 'ENTITLEMENT_RESOLVER',
            reason: 'Account had PRO tier in virtual_accounts without an active verified purchase or owner complimentary grant.',
            actor: 'SYSTEM_GUARD',
          });
        }
      }
    }

    return {
      tier: 'FREE',
      status: 'EXPIRED',
      entitlementSource: 'NONE',
      statusLabel: 'Sikho Trading Free Tier',
      isComplimentary: false,
      planId: latestExpiredSub?.plan_id,
      expiresAt: latestExpiredSub ? Number(latestExpiredSub.expires_at) : null,
      isAutoRenewing: false,
    };
  }

  public async getAccountTier(userId: string): Promise<UserTier> {
    const resolved = await this.resolveEntitlement(userId);
    return resolved.tier;
  }

  public async getSubscriptionStatus(userId: string): Promise<{
    tier: UserTier;
    status: SubscriptionStatus;
    entitlementSource: EntitlementSource;
    statusLabel: string;
    isComplimentary: boolean;
    planId?: string;
    grantId?: string;
    reason?: string;
    expiresAt?: number | null;
    isAutoRenewing?: boolean;
    plans: SubscriptionPlan[];
    isPlayConfigured: boolean;
  }> {
    const resolved = await this.resolveEntitlement(userId);
    return {
      tier: resolved.tier,
      status: resolved.status,
      entitlementSource: resolved.entitlementSource,
      statusLabel: resolved.statusLabel,
      isComplimentary: resolved.isComplimentary,
      planId: resolved.planId,
      grantId: resolved.grantId,
      reason: resolved.reason,
      expiresAt: resolved.expiresAt ?? null,
      isAutoRenewing: resolved.isAutoRenewing ?? false,
      plans: SUBSCRIPTION_PLANS,
      isPlayConfigured: this.isGooglePlayConfigured(),
    };
  }

  /**
   * Narrowly scoped owner-admin grant for complimentary test access.
   * Requires an existing verified account in `users` matching both immutable `userId` (if supplied)
   * and exact `email`. Pre-granting to unregistered emails is rejected so no unverified registration
   * can ever claim a pending grant.
   */
  public async grantComplimentaryPro(params: {
    userId?: string;
    email: string;
    reason: string;
    grantedBy: string;
    expiresAt?: number | null;
  }): Promise<{
    success: boolean;
    code?: string;
    error?: string;
    grant?: ComplimentaryGrantRecord;
    entitlement?: ResolvedEntitlement;
  }> {
    const cleanEmail = (params.email || '').trim().toLowerCase();
    const reason = (params.reason || '').trim();
    const grantedBy = (params.grantedBy || '').trim() || 'OWNER_ADMIN';

    if (!cleanEmail || !cleanEmail.includes('@')) {
      return {
        success: false,
        code: 'ERR_INVALID_EMAIL',
        error: 'A valid verified account email is required to grant complimentary access.',
      };
    }
    if (!reason) {
      return {
        success: false,
        code: 'ERR_REASON_REQUIRED',
        error: 'A grant reason is required for the entitlement audit log.',
      };
    }

    let userRow: { id: string; email: string; name: string };
    if (params.userId) {
      const res = await this.db.query<{ id: string; email: string; name: string }>(
        'SELECT id, email, name FROM users WHERE id = $1 LIMIT 1',
        [params.userId.trim()]
      );
      if (res.rows.length === 0) {
        return {
          success: false,
          code: 'ERR_USER_NOT_FOUND',
          error: `No registered user found with userId '${params.userId}'. Complimentary grants cannot be created for non-existent accounts.`,
        };
      }
      if ((res.rows[0].email || '').trim().toLowerCase() !== cleanEmail) {
        return {
          success: false,
          code: 'ERR_USER_IDENTITY_MISMATCH',
          error: `Email '${cleanEmail}' does not match immutable userId '${params.userId}'.`,
        };
      }
      userRow = res.rows[0];
    } else {
      const res = await this.db.query<{ id: string; email: string; name: string }>(
        'SELECT id, email, name FROM users WHERE LOWER(email) = $1 LIMIT 1',
        [cleanEmail]
      );
      if (res.rows.length === 0) {
        return {
          success: false,
          code: 'ERR_USER_NOT_FOUND',
          error: `No registered account exists for '${cleanEmail}'. The user must register first so the grant binds to their immutable userId.`,
        };
      }
      userRow = res.rows[0];
    }

    const now = Date.now();
    const expiresAt = params.expiresAt ? Number(params.expiresAt) : null;
    if (expiresAt !== null && expiresAt <= now) {
      return {
        success: false,
        code: 'ERR_INVALID_EXPIRY',
        error: 'Grant expiration timestamp must be in the future.',
      };
    }

    const prevTier = await this.getAccountTier(userRow.id);

    // Supersede any prior active grant for this userId
    await this.db.query(
      "UPDATE complimentary_grants SET status = 'REVOKED', revoked_at = $1, revoked_reason = 'Superseded by new grant', updated_at = $1 WHERE user_id = $2 AND status = 'ACTIVE'",
      [now, userRow.id]
    );

    const grantId = `grant_${randomUUID()}`;
    await this.db.query(
      `INSERT INTO complimentary_grants
       (id, user_id, verified_email, source, reason, granted_by, status, granted_at, expires_at, revoked_at, revoked_reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, NULL, NULL, $9)`,
      [
        grantId,
        userRow.id,
        cleanEmail,
        'OWNER_ADMIN_GRANT',
        reason,
        grantedBy,
        now,
        expiresAt,
        now,
      ]
    );

    await this.db.query(
      "UPDATE virtual_accounts SET tier = 'PRO', subscription_expires_at = $1, updated_at = $2 WHERE user_id = $3",
      [expiresAt, now, userRow.id]
    );

    await this.logAudit({
      userId: userRow.id,
      action: 'GRANT_CREATED',
      previousTier: prevTier,
      newTier: 'PRO',
      source: 'OWNER_ADMIN_GRANT',
      reason,
      actor: grantedBy,
      metadata: { grantId, email: cleanEmail, expiresAt },
    });

    const entitlement = await this.resolveEntitlement(userRow.id);
    return {
      success: true,
      grant: {
        id: grantId,
        userId: userRow.id,
        verifiedEmail: cleanEmail,
        source: 'OWNER_ADMIN_GRANT',
        reason,
        grantedBy,
        status: 'ACTIVE',
        grantedAt: now,
        expiresAt,
        revokedAt: null,
        revokedReason: null,
        updatedAt: now,
      },
      entitlement,
    };
  }

  public async revokeComplimentaryPro(params: {
    userId?: string;
    email?: string;
    reason: string;
    revokedBy: string;
  }): Promise<{
    success: boolean;
    code?: string;
    error?: string;
    userId?: string;
    revokedCount: number;
    entitlement?: ResolvedEntitlement;
  }> {
    const reason = (params.reason || '').trim() || 'Revoked by administrator';
    const revokedBy = (params.revokedBy || '').trim() || 'OWNER_ADMIN';

    let targetUserId = params.userId?.trim();
    if (!targetUserId && params.email) {
      const cleanEmail = params.email.trim().toLowerCase();
      const userRes = await this.db.query(
        'SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1',
        [cleanEmail]
      );
      if (userRes.rows.length > 0) {
        targetUserId = userRes.rows[0].id;
      }
    }

    if (!targetUserId) {
      return {
        success: false,
        code: 'ERR_USER_NOT_FOUND',
        error: 'Target user account could not be found by userId or email.',
        revokedCount: 0,
      };
    }

    const now = Date.now();
    const activeGrants = await this.db.query(
      "SELECT id FROM complimentary_grants WHERE user_id = $1 AND status = 'ACTIVE'",
      [targetUserId]
    );

    await this.db.query(
      "UPDATE complimentary_grants SET status = 'REVOKED', revoked_at = $1, revoked_reason = $2, updated_at = $1 WHERE user_id = $3 AND status = 'ACTIVE'",
      [now, reason, targetUserId]
    );

    await this.db.query(
      "UPDATE virtual_accounts SET tier = 'FREE', subscription_expires_at = NULL, updated_at = $1 WHERE user_id = $2",
      [now, targetUserId]
    );

    await this.logAudit({
      userId: targetUserId,
      action: 'GRANT_REVOKED',
      previousTier: 'PRO',
      newTier: 'FREE',
      source: 'OWNER_ADMIN_REVOKE',
      reason,
      actor: revokedBy,
      metadata: { revokedGrantIds: activeGrants.rows.map((r: any) => r.id) },
    });

    const entitlement = await this.resolveEntitlement(targetUserId);
    return {
      success: true,
      userId: targetUserId,
      revokedCount: activeGrants.rows.length,
      entitlement,
    };
  }

  public async listComplimentaryGrants(): Promise<ComplimentaryGrantRecord[]> {
    const res = await this.db.query(
      'SELECT * FROM complimentary_grants ORDER BY granted_at DESC'
    );
    return res.rows.map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      verifiedEmail: r.verified_email,
      source: r.source,
      reason: r.reason,
      grantedBy: r.granted_by,
      status: r.status,
      grantedAt: Number(r.granted_at),
      expiresAt: r.expires_at ? Number(r.expires_at) : null,
      revokedAt: r.revoked_at ? Number(r.revoked_at) : null,
      revokedReason: r.revoked_reason || null,
      updatedAt: Number(r.updated_at),
    }));
  }

  /**
   * Server-authoritative verification of Google Play Billing purchase.
   * Day: ₹10 (prepaid, 1 day)
   * Month: ₹100 (1 month, recurring)
   * Year: ₹800 (1 year, recurring)
   *
   * Enforces fail-closed authorization:
   * - If Google Play credentials or Play Console products are missing -> rejects with CONFIGURATION_REQUIRED
   * - Prevents purchase token replay across accounts
   * - Authoritatively verifies package name and product identity
   */
  public async verifyPurchaseToken(
    userId: string,
    productId: string,
    purchaseToken: string
  ): Promise<{
    success: boolean;
    tier: UserTier;
    status: SubscriptionStatus;
    code?: string;
    expiresAt?: number;
    error?: string;
  }> {
    const plan = SUBSCRIPTION_PLANS.find((p) => p.id === productId);
    if (!plan) {
      return {
        success: false,
        tier: 'FREE',
        status: 'EXPIRED',
        code: 'ERR_INVALID_PLAN',
        error: `Invalid plan ID: ${productId}. Available plans: ${SUBSCRIPTION_PLANS.map((p) => p.id).join(', ')}`,
      };
    }

    if (!purchaseToken || purchaseToken.trim().length === 0) {
      return {
        success: false,
        tier: 'FREE',
        status: 'EXPIRED',
        code: 'ERR_EMPTY_TOKEN',
        error: 'Purchase token cannot be empty.',
      };
    }

    // 1. Replay Attack Prevention: check if token already redeemed by a different account
    const existingTokenRes = await this.db.query(
      'SELECT user_id, status, expires_at, plan_id, is_auto_renewing FROM subscriptions WHERE purchase_token = $1 LIMIT 1',
      [purchaseToken.trim()]
    );
    if (existingTokenRes.rows.length > 0) {
      const existing = existingTokenRes.rows[0];
      if (existing.user_id !== userId) {
        return {
          success: false,
          tier: 'FREE',
          status: 'EXPIRED',
          code: 'ERR_TOKEN_REPLAY',
          error: 'This purchase token has already been associated with another user account.',
        };
      }
      // Same-owner restore: return the already-verified entitlement without creating a duplicate row.
      if (String(existing.status) === 'ACTIVE' && Number(existing.expires_at) > Date.now()) {
        return {
          success: true,
          tier: 'PRO',
          status: 'ACTIVE',
          expiresAt: Number(existing.expires_at),
        };
      }
      return {
        success: false,
        tier: 'FREE',
        status: 'EXPIRED',
        code: 'ERR_TOKEN_ALREADY_REDEEMED',
        error: 'This purchase token has already been redeemed and is no longer active.',
      };
    }

    // 2. Google Play Developer API Authorization Check (Fail-closed)
    const isConfigured = this.isGooglePlayConfigured();
    if (!isConfigured && !this.isTestMode) {
      return {
        success: false,
        tier: 'FREE',
        status: 'EXPIRED',
        code: 'CONFIGURATION_REQUIRED',
        error: 'Google Play Developer API service account credentials or Play Console products are not configured in environment. In-app purchases cannot be verified.',
      };
    }

    const packageName = this.getPlayPackageName();
    let verificationSource: 'GOOGLE_PLAY_VERIFIED' | 'TEST_HARNESS' = 'TEST_HARNESS';
    let verifiedExpiryMs: number | undefined;
    let verifiedAutoRenewing = !plan.isPrepaid;

    if (isConfigured) {
      // A client-supplied purchase token is NEVER trusted on its own. Only a live Android
      // Publisher API response may mint a GOOGLE_PLAY_VERIFIED entitlement.
      const verifier = this.getPlayVerifier();
      if (!verifier) {
        return {
          success: false,
          tier: 'FREE',
          status: 'EXPIRED',
          code: 'CONFIGURATION_REQUIRED',
          error: 'Google Play verification is configured but no verifier is available.',
        };
      }
      let verification: PlayVerificationResult;
      try {
        verification = await verifier({
          packageName,
          productId: plan.playProductId || plan.id,
          purchaseToken: purchaseToken.trim(),
          isSubscription: !plan.isPrepaid,
        });
      } catch (err: any) {
        // Transport/credential outage: fail closed, never grant from an unverified token.
        return {
          success: false,
          tier: 'FREE',
          status: 'EXPIRED',
          code: 'ERR_PLAY_VERIFICATION_UNAVAILABLE',
          error: `Google Play verification is temporarily unavailable: ${err?.message || 'unknown error'}`,
        };
      }
      if (!verification.verified) {
        return {
          success: false,
          tier: 'FREE',
          status: 'EXPIRED',
          code: verification.code || 'ERR_PLAY_VERIFICATION_FAILED',
          error: verification.error || 'Google Play purchase verification failed.',
        };
      }
      if (verification.packageName && verification.packageName !== packageName) {
        return {
          success: false,
          tier: 'FREE',
          status: 'EXPIRED',
          code: 'ERR_PLAY_PACKAGE_MISMATCH',
          error: 'Verified purchase belongs to a different application package.',
        };
      }
      if (verification.productId && verification.productId !== (plan.playProductId || plan.id)) {
        return {
          success: false,
          tier: 'FREE',
          status: 'EXPIRED',
          code: 'ERR_PLAY_PRODUCT_MISMATCH',
          error: 'Verified purchase belongs to a different product.',
        };
      }
      verificationSource = 'GOOGLE_PLAY_VERIFIED';
      verifiedExpiryMs = verification.expiryTimeMillis;
      verifiedAutoRenewing = Boolean(verification.isAutoRenewing);
    }

    // Expiration: use the provider's authoritative window when supplied, otherwise the plan duration.
    const now = Date.now();
    const durationMs = plan.durationDays * 24 * 60 * 60 * 1000;
    const expiresAt =
      verifiedExpiryMs !== undefined && Number.isFinite(verifiedExpiryMs)
        ? Number(verifiedExpiryMs)
        : now + durationMs;
    if (expiresAt <= now) {
      return {
        success: false,
        tier: 'FREE',
        status: 'EXPIRED',
        code: 'ERR_PLAY_EXPIRED',
        error: 'Verified purchase entitlement has already expired.',
      };
    }

    const subId = randomUUID();
    await this.db.query(
      `INSERT INTO subscriptions
       (id, user_id, plan_id, status, purchase_token, expires_at, is_auto_renewing, amount_inr, verification_source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        subId,
        userId,
        plan.id,
        'ACTIVE',
        purchaseToken.trim(),
        expiresAt,
        verifiedAutoRenewing,
        plan.priceRupees,
        verificationSource,
        now,
        now,
      ]
    );

    await this.db.query(
      `UPDATE virtual_accounts 
       SET tier = 'PRO', subscription_expires_at = $1, updated_at = $2 
       WHERE user_id = $3`,
      [expiresAt, now, userId]
    );

    await this.logAudit({
      userId,
      action: 'PLAY_VERIFIED',
      previousTier: 'FREE',
      newTier: 'PRO',
      source: verificationSource,
      reason: `Verified plan ${plan.id} until ${expiresAt}`,
      actor: userId,
      metadata: { subId, planId: plan.id, expiresAt },
    });

    return {
      success: true,
      tier: 'PRO',
      status: 'ACTIVE',
      expiresAt,
    };
  }
}
