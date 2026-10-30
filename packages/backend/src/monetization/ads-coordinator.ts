import { UserTier } from '@trading/shared';
import { randomUUID } from 'node:crypto';

export interface AdOpportunity {
  isEligible: boolean;
  opportunityToken?: string;
  adUnitId?: string;
  reason?: string;
}

export class AdsCoordinator {
  // Test AdMob App Open Ad Unit ID (Official Google Test Ad Unit)
  public static readonly TEST_APP_OPEN_AD_UNIT = 'ca-app-pub-3940256099942544/9257395921';

  // In-memory / persistent ledger of impressions: userId -> lastImpressionTimestamp
  private userLastImpressions: Map<string, number> = new Map();
  // Active reserved opportunities awaiting impression confirmation: token -> { userId, expiresAt }
  private pendingOpportunities: Map<string, { userId: string; expiresAt: number }> = new Map();

  /**
   * Request an App Open Ad opportunity on app launch/resume.
   * Atomic reservation enforcing maximum 1 impression per rolling 24-hour window for Free tier.
   */
  public reserveAppOpenOpportunity(userId: string, tier: UserTier): AdOpportunity {
    // 1. Pro users are 100% ad-free
    if (tier === 'PRO') {
      return { isEligible: false, reason: 'PRO_SUBSCRIPTION_ACTIVE' };
    }

    const now = Date.now();
    const lastImpression = this.userLastImpressions.get(userId) || 0;
    const rolling24hMs = 24 * 60 * 60 * 1000;

    // 2. Frequency Cap: Max 1 impression per rolling 24h
    if (now - lastImpression < rolling24hMs) {
      const remainingHours = ((rolling24hMs - (now - lastImpression)) / 3600000).toFixed(1);
      return {
        isEligible: false,
        reason: `FREQUENCY_CAPPED: 24h rolling limit active (${remainingHours}h remaining).`,
      };
    }

    // 3. Check if an active unconfirmed opportunity is already outstanding
    for (const [token, opp] of this.pendingOpportunities.entries()) {
      if (opp.userId === userId && opp.expiresAt > now) {
        return { isEligible: false, reason: 'OPPORTUNITY_ALREADY_PENDING' };
      } else if (opp.expiresAt <= now) {
        this.pendingOpportunities.delete(token);
      }
    }

    // 4. Issue atomic opportunity reservation (valid for 60 seconds)
    const token = randomUUID();
    this.pendingOpportunities.set(token, {
      userId,
      expiresAt: now + 60000,
    });

    return {
      isEligible: true,
      opportunityToken: token,
      adUnitId: AdsCoordinator.TEST_APP_OPEN_AD_UNIT,
    };
  }

  /**
   * Confirm that the App Open ad was actually rendered on the device.
   * Records the definitive timestamp to lock the 24-hour window.
   */
  public confirmImpression(opportunityToken: string): boolean {
    const opp = this.pendingOpportunities.get(opportunityToken);
    if (!opp) return false; // Expired or invalid opportunity

    const now = Date.now();
    if (now > opp.expiresAt) {
      this.pendingOpportunities.delete(opportunityToken);
      return false; // Timed out
    }

    // Record definitive impression
    this.userLastImpressions.set(opp.userId, now);
    this.pendingOpportunities.delete(opportunityToken);
    return true;
  }
}

