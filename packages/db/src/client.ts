import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

export type Database = ReturnType<typeof createDb>;

/**
 * สร้าง Drizzle client จาก connection string.
 * ใน serverless (Vercel) ใช้ pooler URL (port 6543) และ prepare:false ให้เข้ากับ pgbouncer
 */
export function createDb(connectionString: string) {
  const client = postgres(connectionString, { prepare: false });
  return drizzle(client, { schema });
}

/** singleton สำหรับใช้ในฝั่ง server (อ่าน DATABASE_URL จาก env) */
let _db: Database | undefined;

export function getDb(): Database {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    _db = createDb(url);
  }
  return _db;
}
