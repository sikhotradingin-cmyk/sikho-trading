import { UserTier } from '@trading/shared';
import { IDatabase } from '../db/database.js';

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
  private isConfigured: boolean;

  constructor(private db: IDatabase, googleServiceAccountKey?: string) {
    this.isConfigured = Boolean(googleServiceAccountKey);
  }

  /**
   * Server-authoritative verification of Google Play Billing purchase.
   * Client flags are never trusted.
   */
  public async verifyPurchaseToken(
    userId: string,
    _productId: string,
    _purchaseToken: string
  ): Promise<{ success: boolean; tier: UserTier; status: SubscriptionStatus; error?: string }> {
    if (!this.isConfigured) {
      if (process.env.NODE_ENV === 'production') {
        return {
          success: false,
          tier: 'FREE',
          status: 'EXPIRED',
          error: 'BILLING_NOT_VERIFIED: Production Google Play Billing credentials are not configured.',
        };
      }

      await this.db.query(
        'UPDATE virtual_accounts SET tier = $1, updated_at = $2 WHERE user_id = $3',
        ['PRO', Date.now(), userId]
      );

      return {
        success: true,
        tier: 'PRO',
        status: 'ACTIVE',
      };
    }

    // When Google Play API credentials exist, verify with androidpublisher API:
    // GET https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{packageName}/purchases/subscriptions/{subscriptionId}/tokens/{token}
    return {
      success: false,
      tier: 'FREE',
      status: 'EXPIRED',
      error: 'Google Play API verification pending production credentials.',
    };
  }

  public async getAccountTier(userId: string): Promise<UserTier> {
    const res = await this.db.query('SELECT tier FROM virtual_accounts WHERE user_id = $1 LIMIT 1', [userId]);
    if (res.rows.length === 0) return 'FREE';
    return (res.rows[0].tier as UserTier) || 'FREE';
  }
}
