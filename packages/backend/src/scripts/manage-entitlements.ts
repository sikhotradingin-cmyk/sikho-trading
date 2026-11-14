import dotenv from 'dotenv';
import path from 'node:path';
import { initializeDatabase } from '../db/database.js';
import { BillingService } from '../monetization/billing-service.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), 'packages/backend/.env') });

async function main() {
  const args = process.argv.slice(2);
  const command = (args[0] || 'list').toLowerCase();

  const db = await initializeDatabase(process.env.DATABASE_URL);
  const billing = new BillingService(db);

  try {
    if (command === 'grant') {
      const email = args[1];
      const reason = args[2] || 'Owner-approved complimentary test access';
      const daysStr = args[3];
      const expiresAt = daysStr ? Date.now() + Number(daysStr) * 86400000 : null;

      if (!email) {
        console.error('Usage: npx tsx src/scripts/manage-entitlements.ts grant <verified-email> [reason] [durationDays]');
        process.exit(1);
      }

      const res = await billing.grantComplimentaryPro({
        email,
        reason,
        grantedBy: process.env.USER || process.env.USERNAME || 'CLI_OWNER_ADMIN',
        expiresAt,
      });

      if (!res.success) {
        console.error(`[Grant Rejected] ${res.code}: ${res.error}`);
        process.exit(1);
      }

      console.log('[Grant Created]', JSON.stringify(res, null, 2));
    } else if (command === 'revoke') {
      const emailOrUserId = args[1];
      const reason = args[2] || 'Revoked via owner admin CLI';

      if (!emailOrUserId) {
        console.error('Usage: npx tsx src/scripts/manage-entitlements.ts revoke <email-or-userId> [reason]');
        process.exit(1);
      }

      const isEmail = emailOrUserId.includes('@');
      const res = await billing.revokeComplimentaryPro({
        email: isEmail ? emailOrUserId : undefined,
        userId: !isEmail ? emailOrUserId : undefined,
        reason,
        revokedBy: process.env.USER || process.env.USERNAME || 'CLI_OWNER_ADMIN',
      });

      if (!res.success) {
        console.error(`[Revoke Failed] ${res.code}: ${res.error}`);
        process.exit(1);
      }

      console.log('[Grant Revoked]', JSON.stringify(res, null, 2));
    } else {
      const grants = await billing.listComplimentaryGrants();
      console.log(`[Complimentary Grants (${grants.length})]`, JSON.stringify(grants, null, 2));
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
