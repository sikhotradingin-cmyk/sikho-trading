import { Paise } from './money.js';

export type LedgerEntryType =
  | 'INITIAL_GRANT'
  | 'RESET'
  | 'TRADE_PNL'
  | 'SIMULATED_CHARGES'
  | 'CAPITAL_ADJUSTMENT';

export interface LedgerEntry {
  id: string;
  accountId: string;
  entryType: LedgerEntryType;
  amountPaise: Paise;
  balanceAfterPaise: Paise;
  referenceId?: string; // Order or Position ID
  note: string;
  timestamp: number;
}
