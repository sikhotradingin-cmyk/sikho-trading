import { UserTier } from '@trading/shared';

/** Feature promotion and verified ad-free billing are independent decisions. No stored tier changes. */
export function resolveAccessPolicy(tier: UserTier = 'FREE', authenticated = true) {
  const isTest=Boolean(process.env.NODE_TEST_CONTEXT)||process.env.NODE_ENV==='test'||process.env.SIKHO_TEST_MODE==='true';
  const configured = (process.env.SIKHO_ACCESS_MODE || (isTest ? 'STANDARD' : 'FREE_LAUNCH')).toUpperCase();
  const accessMode = configured === 'FREE_LAUNCH' ? 'FREE_LAUNCH' : 'STANDARD';
  return {
    accessMode,
    fullFeatureAccess: authenticated && (accessMode === 'FREE_LAUNCH' || tier === 'PRO'),
    launchFeatureAccess: accessMode === 'FREE_LAUNCH' ? 'ALL_SUPPORTED' : null,
    adsRequired: tier !== 'PRO',
    capitalTier: accessMode === 'FREE_LAUNCH' || tier === 'PRO' ? 'PRO' as const : 'FREE' as const,
    label: accessMode === 'FREE_LAUNCH' ? 'Free Launch — all features unlocked' : tier === 'PRO' ? 'Premium access' : 'Free plan',
    downloadMeasurement: 'NOT_CONFIGURED_OWNER_CONTROLLED',
    appOpenAdUnitId: process.env.SIKHO_APP_OPEN_AD_UNIT_ID || '',
  };
}
