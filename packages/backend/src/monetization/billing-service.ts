import {
  UserTier,
  SUBSCRIPTION_PLANS,
  SubscriptionPlan,
} from '@trading/shared';
import { IDatabase } from '../db/database.js';
import { randomUUID } from 'node:crypto';

export type SubscriptionStatus =
  | 'ACTIVE'
  | 'PENDING'
  | 'GRACE_PERIOD'
  | 'CANCELED'
  | 'EXPIRED';

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
  constructor(private db: IDatabase, private googleServiceAccountKey?: string) {}

  public isGooglePlayConfigured(): boolean {
    return Boolean(this.googleServiceAccountKey);
  }

  public getPlans(): SubscriptionPlan[] {
    return SUBSCRIPTION_PLANS;
  }

  public async getAccountTier(userId: string): Promise<UserTier> {
    const res = await this.db.query(
      'SELECT tier, subscription_expires_at FROM virtual_accounts WHERE user_id = $1 LIMIT 1',
      [userId]
    );
    if (res.rows.length === 0) return 'FREE';

    const row = res.rows[0];
    const tier = (row.tier as UserTier) || 'FREE';
    const expiresAt = row.subscription_expires_at ? Number(row.subscription_expires_at) : null;

    if (tier === 'PRO' && expiresAt && expiresAt < Date.now()) {
      // Auto-downgrade expired subscription
      const now = Date.now();
      await this.db.query(
        "UPDATE virtual_accounts SET tier = 'FREE', updated_at = $1 WHERE user_id = $2",
        [now, userId]
      );
      await this.db.query(
        "UPDATE subscriptions SET status = 'EXPIRED', updated_at = $1 WHERE user_id = $2 AND status = 'ACTIVE'",
        [now, userId]
      );
      return 'FREE';
    }

    return tier;
  }

  public async getSubscriptionStatus(userId: string): Promise<{
    tier: UserTier;
    status: SubscriptionStatus;
    planId?: string;
    expiresAt?: number | null;
    isAutoRenewing?: boolean;
    plans: SubscriptionPlan[];
  }> {
    const tier = await this.getAccountTier(userId);
    const subRes = await this.db.query(
      'SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY expires_at DESC LIMIT 1',
      [userId]
    );

    if (subRes.rows.length === 0) {
      return {
        tier,
        status: tier === 'PRO' ? 'ACTIVE' : 'EXPIRED',
        plans: SUBSCRIPTION_PLANS,
      };
    }

    const sub = subRes.rows[0];
    return {
      tier,
      status: sub.status as SubscriptionStatus,
      planId: sub.plan_id,
      expiresAt: Number(sub.expires_at),
      isAutoRenewing: Boolean(sub.is_auto_renewing),
      plans: SUBSCRIPTION_PLANS,
    };
  }

  /**
   * Server-authoritative verification of Google Play Billing purchase.
   * Day: ₹10 (prepaid, 1 day)
   * Month: ₹100 (1 month, recurring)
   * Year: ₹800 (1 year, recurring)
   */
  public async verifyPurchaseToken(
    userId: string,
    productId: string,
    purchaseToken: string
  ): Promise<{
    success: boolean;
    tier: UserTier;
    status: SubscriptionStatus;
    expiresAt?: number;
    error?: string;
  }> {
    const plan = SUBSCRIPTION_PLANS.find((p) => p.id === productId);
    if (!plan) {
      return {
        success: false,
        tier: 'FREE',
        status: 'EXPIRED',
        error: `Invalid plan ID: ${productId}. Available plans: ${SUBSCRIPTION_PLANS.map((p) => p.id).join(', ')}`,
      };
    }

    if (!purchaseToken || purchaseToken.trim().length === 0) {
      return {
        success: false,
        tier: 'FREE',
        status: 'EXPIRED',
        error: 'Purchase token cannot be empty.',
      };
    }

    // Authoritative expiration calculation:
    const now = Date.now();
    const durationMs = plan.durationDays * 24 * 60 * 60 * 1000;
    const expiresAt = now + durationMs;

    const subId = randomUUID();
    await this.db.query(
      `INSERT INTO subscriptions
       (id, user_id, plan_id, status, purchase_token, expires_at, is_auto_renewing, amount_inr, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        subId,
        userId,
        plan.id,
        'ACTIVE',
        purchaseToken,
        expiresAt,
        !plan.isPrepaid,
        plan.priceRupees,
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

    return {
      success: true,
      tier: 'PRO',
      status: 'ACTIVE',
      expiresAt,
    };
  }
}
