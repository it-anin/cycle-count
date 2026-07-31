import { getDb } from '@cycle-count/db';

/** Drizzle client สำหรับใช้ใน Route Handlers / Server Actions */
export const db = getDb();
