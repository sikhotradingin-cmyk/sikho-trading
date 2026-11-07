import dotenv from 'dotenv';
import path from 'node:path';
import { createDatabase, runDatabaseMigrations } from './database.js';

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), 'packages/backend/.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || (!dbUrl.startsWith('postgres://') && !dbUrl.startsWith('postgresql://'))) {
    console.error('[Migration Runner] ERROR: DATABASE_URL is not set or does not start with postgres:// or postgresql://');
    console.error('Provide a valid managed PostgreSQL connection string: DATABASE_URL=postgres://user:pass@host:5432/dbname');
    process.exit(1);
  }

  console.log('[Migration Runner] Connecting to database...');
  const db = createDatabase(dbUrl);
  try {
    const applied = await runDatabaseMigrations(db);
    if (applied.length === 0) {
      console.log('[Migration Runner] All migrations already applied. Schema is up to date.');
    } else {
      console.log(`[Migration Runner] Successfully applied ${applied.length} migration(s): ${applied.join(', ')}`);
    }
  } catch (err: any) {
    console.error('[Migration Runner] Migration failed:', err.message);
    process.exit(1);
  } finally {
    await db.close();
  }
}

main();

