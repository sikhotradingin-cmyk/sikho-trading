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
    this.pool = new Pool({ connectionString });
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
  if (connectionString && connectionString.startsWith('postgres')) {
    return new RealPostgresDatabase(connectionString);
  }
  return new EmulatedPostgresDatabase();
}
