import { Paise } from './money.js';

export type UserTier = 'FREE' | 'PRO';

export interface VirtualAccount {
  id: string;
  userId: string;
  name: string;
  tier: UserTier;
  startingBalancePaise: Paise;
  cashBalancePaise: Paise;
  lockedMarginPaise: Paise;
  availableBalancePaise: Paise;
  currency: 'INR';
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}
