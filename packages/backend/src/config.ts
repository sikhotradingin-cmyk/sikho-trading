import dotenv from 'dotenv';
import path from 'node:path';

// Attempt loading from multiple standard locations
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), 'packages/backend/.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export interface AppConfig {
  port: number;
  host: string;
  jwtSecret: string;
  nodeEnv: string;
  enableDevAuth: boolean;
  smartApi: {
    apiKey?: string;
    clientCode?: string;
    password?: string;
    totpSecret?: string;
  };
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '4000', 10),
  host: process.env.HOST || '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET || 'development-insecure-secret-key-change-in-prod',
  nodeEnv: process.env.NODE_ENV || 'development',
  enableDevAuth: process.env.NODE_ENV !== 'production',
  smartApi: {
    apiKey: process.env.SMARTAPI_API_KEY,
    clientCode: process.env.SMARTAPI_CLIENT_CODE,
    password: process.env.SMARTAPI_PASSWORD,
    totpSecret: process.env.SMARTAPI_TOTP_SECRET,
  },
};
