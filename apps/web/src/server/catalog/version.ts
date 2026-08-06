/**
 * version และ lock กลางของ catalog
 *
 * Master writer ทุกตัวต้องถือ FOR UPDATE ที่ catalog_state:master จน commit
 * ส่วนการส่งผลนับถือ FOR SHARE จึงไม่มีช่วงที่ตรวจ version ผ่านแล้ว master
 * เปลี่ยนแทรกก่อนบันทึกผลได้
 */
import { eq, sql } from 'drizzle-orm';

import { catalogState, countSessions } from '@cycle-count/db';

import { db } from '@/lib/db';

export const MASTER_CATALOG_KEY = 'master';

export type CatalogTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function catalogVersion(
  masterVersion: string,
  sessionVersion: string,
  mode: 'blind' | 'recount',
): string {
  return `${masterVersion}.${sessionVersion}.${mode}`;
}

/** ทำ master write และหมุน version เป็น transaction เดียวกัน */
export function withMasterCatalogWrite<T>(
  write: (tx: CatalogTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT key FROM cycle_count.catalog_state
      WHERE key = ${MASTER_CATALOG_KEY}
      FOR UPDATE
    `);

    const result = await write(tx);

    await tx
      .update(catalogState)
      .set({ version: sql`gen_random_uuid()`, updatedAt: new Date() })
      .where(eq(catalogState.key, MASTER_CATALOG_KEY));

    return result;
  });
}

/**
 * ทำ write ที่กระทบ catalog เฉพาะรอบ เช่น expected_stock
 * ล็อก master ก่อน session เสมอให้ตรงกับลำดับใน count-lines และกัน deadlock
 */
export function withSessionCatalogWrite<T>(
  sessionId: string,
  write: (tx: CatalogTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT key FROM cycle_count.catalog_state
      WHERE key = ${MASTER_CATALOG_KEY}
      FOR SHARE
    `);
    await tx.execute(sql`
      SELECT id FROM cycle_count.count_sessions
      WHERE id = ${sessionId}::uuid
      FOR UPDATE
    `);

    const result = await write(tx);

    await tx
      .update(countSessions)
      .set({ catalogVersion: sql`gen_random_uuid()` })
      .where(eq(countSessions.id, sessionId));

    return result;
  });
}
