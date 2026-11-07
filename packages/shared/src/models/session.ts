import { Paise } from './money.js';

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
}

export const FREE_CAPITAL_PRESETS_INR: number[] = [100000];

export const PREMIUM_CAPITAL_PRESETS_INR: number[] = [
  100000,
  1000000,
  2000000,
  3000000,
  4000000,
  5000000,
  6000000,
  7000000,
  8000000,
  9000000,
  10000000,
];

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

