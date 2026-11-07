import pg from 'pg';
import { newDb, IMemoryDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';

const { Pool } = pg;

export interface IDatabaseClient {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }>;
}

export interface IDatabase extends IDatabaseClient {
  transaction<T>(fn: (client: IDatabaseClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  isEmulated(): boolean;
}

export class RealPostgresDatabase implements IDatabase {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    const isSslDisabled = process.env.DATABASE_SSL === 'false';
    const poolConfig: pg.PoolConfig = {
      connectionString,
      max: parseInt(process.env.PG_POOL_MAX || '20', 10),
      idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10),
      connectionTimeoutMillis: parseInt(process.env.PG_CONNECT_TIMEOUT_MS || '10000', 10),
    };

    if (!isSslDisabled && !connectionString.includes('localhost') && !connectionString.includes('127.0.0.1')) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }

    this.pool = new Pool(poolConfig);

    this.pool.on('error', (err) => {
      console.error('[PostgreSQL Pool Error]', err.message);
    });
  }

  public async query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }> {
    const res = await this.pool.query(sql, params);
    return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
  }

  public async transaction<T>(fn: (client: IDatabaseClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public isEmulated(): boolean {
    return false;
  }
}

export function resolveMigrationsDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'migrations'),
    path.resolve(process.cwd(), 'packages/backend/migrations'),
    path.resolve(__dirname, '../../migrations'),
    path.resolve(__dirname, '../../../migrations'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return null;
}

export async function runDatabaseMigrations(db: IDatabase): Promise<string[]> {
  const dir = resolveMigrationsDir();
  if (!dir) {
    console.warn('[Database] Migrations directory not found.');
    return [];
  }

  // Ensure migration tracking table exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(128) PRIMARY KEY,
      applied_at BIGINT NOT NULL
    );
  `);

  const appliedRes = await db.query('SELECT version FROM schema_migrations');
  const appliedSet = new Set(appliedRes.rows.map((r: any) => r.version));

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const newlyApplied: string[] = [];

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await db.transaction(async (client) => {
      // Split by statement if needed or execute entire script
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
        [file, Date.now()]
      );
    });

    newlyApplied.push(file);
    console.log(`[Database Migration] Applied: ${file}`);
  }

  return newlyApplied;
}

export class EmulatedPostgresDatabase implements IDatabase {
  public readonly memDb: IMemoryDb;
  private adapter: any;

  constructor() {
    this.memDb = newDb();
    // Register custom pg functions if needed
    this.adapter = this.memDb.adapters.createPg();
    this.initSchema();
  }

  private initSchema(): void {
    const candidates = [
      path.resolve(process.cwd(), 'migrations'),
      path.resolve(process.cwd(), 'packages/backend/migrations'),
      path.resolve(__dirname, '../../migrations'),
    ];
    let dir: string | null = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        dir = c;
        break;
      }
    }
    if (dir) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        this.memDb.public.none(sql);
      }
    }
  }

  public async query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }> {
    const client = new this.adapter.Client();
    await client.connect();
    try {
      const res = await client.query(sql, params);
      return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
    } finally {
      await client.end();
    }
  }

  public async transaction<T>(fn: (client: IDatabaseClient) => Promise<T>): Promise<T> {
    const client = new this.adapter.Client();
    await client.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      await client.end();
    }
  }

  public async close(): Promise<void> {
    // Memory cleanup
  }

  public isEmulated(): boolean {
    return true;
  }
}

export function createDatabase(connectionString?: string): IDatabase {
  if (connectionString && (connectionString.startsWith('postgres://') || connectionString.startsWith('postgresql://'))) {
    return new RealPostgresDatabase(connectionString);
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[FATAL] Production database configuration error: DATABASE_URL is missing or invalid. Production must never fall back to in-memory pg-mem.'
    );
  }
  return new EmulatedPostgresDatabase();
}

export async function initializeDatabase(connectionString?: string): Promise<IDatabase> {
  const db = createDatabase(connectionString);
  if (!db.isEmulated()) {
    console.log('[Database] Connected to managed PostgreSQL. Verifying migrations...');
    const applied = await runDatabaseMigrations(db);
    if (applied.length > 0) {
      console.log(`[Database] Successfully applied ${applied.length} pending migration(s): ${applied.join(', ')}`);
    } else {
      console.log('[Database] Database schema is up to date.');
    }
  } else {
    console.log('[Database] Running in-memory emulated database (DATABASE_URL not set).');
  }
  return db;
}
