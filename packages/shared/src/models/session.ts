import { Paise } from './money.js';
import { UserTier } from './account.js';

export interface PracticeSession {
  id: string;
  userId: string;
  accountId: string;
  startingCapitalPaise: Paise;
  finalCashPaise?: Paise | null;
  realizedPnlPaise: Paise;
  totalChargesPaise: Paise;
  tradesCount: number;
  winTradesCount: number;
  isActive: boolean;
  startedAt: number;
  endedAt?: number | null;
}

export interface LifetimePerformance {
  lifetimeRealizedPnlPaise: Paise;
  lifetimeChargesPaise: Paise;
  lifetimeNetTradingPnlPaise: Paise;
  lifetimeTradesCount: number;
  lifetimeWinTradesCount: number;
  winRatePct: number;
  totalSessionsCount: number;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  priceRupees: number;
  pricePaise: Paise;
  currency: 'INR';
  durationDays: number;
  isPrepaid: boolean;
  renewalDescription: string;
  /**
   * Google Play Console product id when it differs from the internal plan id.
   * Server-side purchase verification resolves the product against this exact id.
   */
  playProductId?: string;
}

export const FREE_MIN_CAPITAL_INR = 100000;
export const FREE_MAX_CAPITAL_INR = 2000000; // ₹20 Lakhs agreed in client call
export const FREE_CAPITAL_PRESETS_INR: number[] = [
  100000,   // ₹1 Lakh
  200000,   // ₹2 Lakhs
  500000,   // ₹5 Lakhs
  1000000,  // ₹10 Lakhs
  2000000,  // ₹20 Lakhs
];

export const PREMIUM_MIN_CAPITAL_INR = 100000;
export const PREMIUM_MAX_CAPITAL_INR = 100000000; // ₹10 Crore agreed in client call
export const PREMIUM_CAPITAL_PRESETS_INR: number[] = [
  100000,     // ₹1 Lakh
  1000000,    // ₹10 Lakhs
  2500000,    // ₹25 Lakhs
  5000000,    // ₹50 Lakhs
  10000000,   // ₹1 Crore
  20000000,   // ₹2 Crores
  50000000,   // ₹5 Crores
  100000000,  // ₹10 Crores
];

export function validateResetCapitalAmount(amountINR: number, tier: UserTier = 'FREE'): { valid: boolean; error?: string } {
  if (!Number.isFinite(amountINR) || amountINR <= 0) {
    return { valid: false, error: 'Capital amount must be a positive number.' };
  }
  if (amountINR < FREE_MIN_CAPITAL_INR) {
    return { valid: false, error: 'Minimum starting capital is ₹1,00,000.' };
  }
  if (tier === 'FREE') {
    if (amountINR > FREE_MAX_CAPITAL_INR) {
      return {
        valid: false,
        error: 'Free tier capital reset is limited up to ₹20,00,000 (20 Lakhs). Upgrade to Premium for capital up to ₹10 Crore.',
      };
    }
  } else {
    if (amountINR > PREMIUM_MAX_CAPITAL_INR) {
      return {
        valid: false,
        error: 'Maximum permitted virtual capital is ₹10,00,00,000 (10 Crore).',
      };
    }
  }
  return { valid: true };
}

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    id: 'plan_day_10',
    name: 'Day Pass',
    priceRupees: 10,
    pricePaise: 1000n,
    currency: 'INR',
    durationDays: 1,
    isPrepaid: true,
    renewalDescription: '1 day full access (Prepaid, no auto-renewal)',
  },
  {
    id: 'plan_month_100',
    name: 'Monthly Pro',
    priceRupees: 100,
    pricePaise: 10000n,
    currency: 'INR',
    durationDays: 30,
    isPrepaid: false,
    renewalDescription: '₹100/month, auto-renews monthly unless canceled',
  },
  {
    id: 'plan_year_800',
    name: 'Annual Pro',
    priceRupees: 800,
    pricePaise: 80000n,
    currency: 'INR',
    durationDays: 365,
    isPrepaid: false,
    renewalDescription: '₹800/year, auto-renews yearly unless canceled',
  },
];

/**
 * Strict canonical matching for Free Tier allowed instruments:
 * Only NIFTY 50 and BANKNIFTY (NIFTY BANK) reference spot indices and their supported futures/options.
 * Strictly excludes FINNIFTY, MIDCPNIFTY, NIFTYIT, commodities, equities, and any other symbols.
 */
export function isFreeTierAllowedInstrument(inst: {
  symbol?: string;
  underlying?: string;
  exchange?: string;
  instrumentType?: string;
}): boolean {
  if (!inst) return false;
  if (inst.exchange === 'MCX') return false;

  const sym = (inst.symbol || '').trim().toUpperCase();
  const und = (inst.underlying || '').trim().toUpperCase();

  // Explicitly reject NIFTY variants that are NOT NIFTY 50 or BANKNIFTY
  if (
    sym.startsWith('FINNIFTY') ||
    sym.startsWith('MIDCPNIFTY') ||
    sym.startsWith('NIFTYIT') ||
    sym.startsWith('NIFTYNXT50') ||
    sym.startsWith('SENSEX') ||
    sym.startsWith('BANKEX') ||
    und === 'FINNIFTY' ||
    und === 'MIDCPNIFTY' ||
    und === 'NIFTYIT' ||
    und === 'NIFTYNXT50' ||
    und === 'SENSEX' ||
    und === 'BANKEX'
  ) {
    return false;
  }

  // Canonical NIFTY 50
  const isNifty50 =
    und === 'NIFTY' ||
    und === 'NIFTY 50' ||
    sym === 'NIFTY 50' ||
    sym === 'NIFTY' ||
    sym.startsWith('NIFTY ') ||
    (sym.startsWith('NIFTY') && /^[0-9]/.test(sym.slice(5)));

  // Canonical BANKNIFTY
  const isBankNifty =
    und === 'BANKNIFTY' ||
    und === 'NIFTY BANK' ||
    sym === 'NIFTY BANK' ||
    sym === 'BANKNIFTY' ||
    sym.startsWith('BANKNIFTY ') ||
    (sym.startsWith('BANKNIFTY') && /^[0-9]/.test(sym.slice(9)));

  if (!isNifty50 && !isBankNifty) {
    return false;
  }

  // Spot indices (for reference charts)
  if (inst.instrumentType === 'INDEX_SPOT') {
    return true;
  }

  // Derivatives on NIFTY or BANKNIFTY
  if (inst.instrumentType === 'FUTIDX' || inst.instrumentType === 'OPTIDX') {
    return true;
  }

  return false;
}

