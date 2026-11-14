import dotenv from 'dotenv';
import path from 'node:path';

// Load from standard locations (packages/backend/.env takes precedence for local backend config)
const isTestEnv =
  Boolean(process.env.NODE_TEST_CONTEXT) ||
  process.env.NODE_ENV === 'test' ||
  process.env.SIKHO_TEST_MODE === 'true';

if (!isTestEnv) {
  dotenv.config();
  dotenv.config({ path: path.resolve(process.cwd(), 'packages/backend/.env') });
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

export function isPlaceholderCredential(value?: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const upper = trimmed.toUpperCase();
  if (
    upper.startsWith('PASTE_') ||
    upper.startsWith('REPLACE_') ||
    upper.startsWith('ENTER_') ||
    upper.startsWith('YOUR_') ||
    upper.startsWith('<') ||
    upper.endsWith('>') ||
    upper.includes('API_KEY') ||
    upper.includes('CLIENT_CODE') ||
    upper.includes('TOTP_SECRET') ||
    upper.includes('CHANGEME') ||
    upper.includes('PLACEHOLDER')
  ) {
    return true;
  }
  return false;
}

export interface SmartApiEnvValidation {
  hasAnyCredential: boolean;
  isFullyValid: boolean;
  missingVars: string[];
  placeholderVars: string[];
}

export function validateSmartApiEnv(smartApi: {
  apiKey?: string;
  clientCode?: string;
  password?: string;
  totpSecret?: string;
}): SmartApiEnvValidation {
  const entries: Array<[string, string | undefined]> = [
    ['SMARTAPI_API_KEY', smartApi.apiKey],
    ['SMARTAPI_CLIENT_CODE', smartApi.clientCode],
    ['SMARTAPI_PASSWORD', smartApi.password],
    ['SMARTAPI_TOTP_SECRET', smartApi.totpSecret],
  ];

  const missingVars: string[] = [];
  const placeholderVars: string[] = [];
  let presentCount = 0;

  for (const [envName, rawVal] of entries) {
    const val = rawVal?.trim();
    if (!val) {
      missingVars.push(envName);
    } else {
      presentCount++;
      if (isPlaceholderCredential(val)) {
        placeholderVars.push(envName);
      }
    }
  }

  return {
    hasAnyCredential: presentCount > 0,
    isFullyValid: missingVars.length === 0 && placeholderVars.length === 0,
    missingVars,
    placeholderVars,
  };
}

export interface UpstoxEnvValidation {
  hasToken: boolean;
  isFullyValid: boolean;
  missingVars: string[];
  placeholderVars: string[];
}

export function validateUpstoxEnv(upstox: { analyticsToken?: string }): UpstoxEnvValidation {
  const val = upstox.analyticsToken?.trim();
  const missingVars: string[] = [];
  const placeholderVars: string[] = [];
  if (!val) {
    missingVars.push('UPSTOX_ANALYTICS_TOKEN');
  } else if (isPlaceholderCredential(val)) {
    placeholderVars.push('UPSTOX_ANALYTICS_TOKEN');
  }
  return {
    hasToken: Boolean(val),
    isFullyValid: missingVars.length === 0 && placeholderVars.length === 0,
    missingVars,
    placeholderVars,
  };
}

export interface AppConfig {
  port: number;
  host: string;
  jwtSecret: string;
  nodeEnv: string;
  enableDevAuth: boolean;
  providerMode?: 'UPSTOX' | 'SMARTAPI' | 'DEMO';
  googleClientId?: string;
  databaseUrl?: string;
  upstox: {
    analyticsToken?: string;
  };
  smartApi: {
    apiKey?: string;
    clientCode?: string;
    password?: string;
    totpSecret?: string;
    clientPublicIp?: string;
  };
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '4000', 10),
  host: process.env.HOST || '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET || 'development-insecure-secret-key-change-in-prod',
  nodeEnv: process.env.NODE_ENV || 'development',
  enableDevAuth: process.env.NODE_ENV !== 'production',
  providerMode:
    process.env.MARKET_DATA_PROVIDER === 'UPSTOX'
      ? 'UPSTOX'
      : process.env.MARKET_DATA_PROVIDER === 'SMARTAPI'
      ? 'SMARTAPI'
      : process.env.MARKET_DATA_PROVIDER === 'DEMO'
      ? 'DEMO'
      : undefined,
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  databaseUrl: isTestEnv ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL,
  upstox: {
    analyticsToken: process.env.UPSTOX_ANALYTICS_TOKEN,
  },
  smartApi: {
    apiKey: process.env.SMARTAPI_API_KEY,
    clientCode: process.env.SMARTAPI_CLIENT_CODE,
    password: process.env.SMARTAPI_PASSWORD,
    totpSecret: process.env.SMARTAPI_TOTP_SECRET,
    clientPublicIp: process.env.SMARTAPI_CLIENT_PUBLIC_IP || '45.115.52.180',
  },
};
